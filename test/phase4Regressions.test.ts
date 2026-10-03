import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { resetMockSecureStore } from './mockExpo.mjs';
import { DEFAULT_SETTINGS, saveSettings } from '../src/features/settings/settingsStorage';
import {
  configureDeterrenceEvidenceOverrides,
  resetDeterrenceEvidenceOverrides,
  startDeterrence,
} from '../modules/deterrence-evidence';
import {
  startEmergencyDeterrenceAndEvidence,
  stopEmergencyDeterrenceAndEvidence,
  setAudioSegmentMsForTesting,
} from '../src/features/evidence/evidenceCoordinator';
import {
  appendEvidenceRecord,
  appendEvidenceRecords,
  clearEvidence,
  getEvidence,
  getEvidenceSummaries,
  setCustomEvidenceDatabase,
  EVIDENCE_STORAGE_KEY,
  EVIDENCE_DB_NAME,
  EVIDENCE_CHUNK_CHARS,
  type EvidenceRecord,
} from '../src/features/evidence/evidenceStorage';
import { createTestDatabase, openDatabaseAsync } from './mockExpoSqlite.mjs';
import { encryptString, generateRandomBytes, wipeMasterKeyMemory } from '../src/features/security';

const AUDIO = {
  uri: 'file:///mock/a.m4a',
  durationMs: 1000,
  base64Data: 'QVVESU8=',
  fileSizeBytes: 5,
  mimeType: 'audio/m4a',
};

test.beforeEach(async () => {
  resetMockSecureStore();
  wipeMasterKeyMemory();
  resetDeterrenceEvidenceOverrides();
  setCustomEvidenceDatabase(null);
  await clearEvidence();
  await saveSettings({
    ...DEFAULT_SETTINGS,
    deterrenceSirenEnabled: true,
    evidenceAudioConsentEnabled: true,
    evidencePhotoConsentEnabled: false,
  });
});

test.afterEach?.(() => {
  resetDeterrenceEvidenceOverrides();
  setAudioSegmentMsForTesting(null);
});

test('stop waits for a start still in flight, so the microphone and siren are never orphaned', async () => {
  const order: string[] = [];
  let releaseStart: () => void = () => {};
  const startGate = new Promise<void>((r) => {
    releaseStart = r;
  });
  configureDeterrenceEvidenceOverrides({
    startSiren: async () => ({ started: true, suppressedBySilentMode: false }),
    stopSiren: async () => {
      order.push('stopSiren');
      return true;
    },
    startAudioRecording: async () => {
      await startGate; // native start is slow
      order.push('startAudio');
      return true;
    },
    stopAudioRecording: async () => {
      order.push('stopAudio');
      return AUDIO;
    },
  });

  const start = startEmergencyDeterrenceAndEvidence('sess_fast_safe');
  const stop = stopEmergencyDeterrenceAndEvidence(); // user taps "I'm safe" immediately
  await new Promise((r) => setTimeout(r, 20));
  assert.deepStrictEqual(order, [], 'teardown must not run before the start has finished');
  releaseStart();
  await Promise.all([start, stop]);
  assert.ok(order.indexOf('startAudio') < order.indexOf('stopAudio'));
});

test('overlapping stop calls share one teardown and keep the recording with its session', async () => {
  let stopAudioCalls = 0;
  configureDeterrenceEvidenceOverrides({
    startAudioRecording: async () => true,
    stopAudioRecording: async () => {
      stopAudioCalls++;
      return stopAudioCalls === 1 ? AUDIO : null;
    },
  });

  await startEmergencyDeterrenceAndEvidence('sess_dismiss');
  // DISMISS action and the idle entry both call stop in the same transition.
  await Promise.all([stopEmergencyDeterrenceAndEvidence(), stopEmergencyDeterrenceAndEvidence()]);

  assert.strictEqual(stopAudioCalls, 1, 'one teardown, not two racing ones');
  const evidence = await getEvidence();
  assert.strictEqual(evidence.length, 1);
  assert.strictEqual(evidence[0].sessionId, 'sess_dismiss', 'recording must not be discarded or misattributed');
});

const sample = (id: string, dataBase64 = 'AA=='): EvidenceRecord => ({
  id,
  sessionId: 's',
  type: 'audio',
  mimeType: 'audio/m4a',
  fileSizeBytes: 1,
  createdAt: 1,
  dataBase64,
});

test('an unreadable legacy vault is left in place, never overwritten, and new evidence still saves', async () => {
  const foreign = await encryptString('[]', generateRandomBytes(32));
  await AsyncStorage.setItem(EVIDENCE_STORAGE_KEY, foreign);
  setCustomEvidenceDatabase(createTestDatabase()); // fresh open re-runs the migration
  await appendEvidenceRecord(sample('new'));
  assert.strictEqual(await AsyncStorage.getItem(EVIDENCE_STORAGE_KEY), foreign);
  assert.deepStrictEqual((await getEvidence()).map((r) => r.id), ['new']);
});

test('a readable legacy vault is migrated into SQLite once and removed', async () => {
  const legacy = [sample('newer'), sample('older')];
  await AsyncStorage.setItem(EVIDENCE_STORAGE_KEY, await encryptString(JSON.stringify(legacy)));
  setCustomEvidenceDatabase(createTestDatabase());
  assert.deepStrictEqual((await getEvidence()).map((r) => r.id), ['newer', 'older']);
  assert.strictEqual(await AsyncStorage.getItem(EVIDENCE_STORAGE_KEY), null);
});

test('large recordings are chunked: no stored value grows with recording length', async () => {
  const big = 'A'.repeat(EVIDENCE_CHUNK_CHARS * 3 + 17); // ~770 KB of base64
  await appendEvidenceRecord(sample('long_audio', big));
  const db = await openDatabaseAsync(EVIDENCE_DB_NAME);
  const chunks = await db.getAllAsync<{ envelope: string }>('SELECT envelope FROM evidence_chunks;');
  assert.strictEqual(chunks.length, 4);
  const largest = Math.max(...chunks.map((c) => c.envelope.length));
  assert.ok(largest < 700 * 1024, 'each stored chunk stays far below the ~2 MB per-value read limit');
  assert.strictEqual((await getEvidence())[0].dataBase64, big, 'chunks reassemble exactly');
});

test('concurrent evidence writes (photos + audio segment) do not collide', async () => {
  await Promise.all([
    appendEvidenceRecords([sample('photo_rear'), sample('photo_front')]),
    appendEvidenceRecord(sample('audio_seg_1')),
  ]);
  assert.strictEqual((await getEvidenceSummaries()).length, 3);
});

test('long recordings are split into segments, each saved as its own record', async () => {
  let segment = 0;
  let recording = false;
  configureDeterrenceEvidenceOverrides({
    startAudioRecording: async () => {
      recording = true;
      return true;
    },
    stopAudioRecording: async () => {
      if (!recording) return null;
      recording = false;
      segment++;
      return { ...AUDIO, base64Data: `U0VH${segment}` };
    },
  });
  setAudioSegmentMsForTesting(30);

  await startEmergencyDeterrenceAndEvidence('sess_long');
  await new Promise((r) => setTimeout(r, 110)); // ~3 rotations
  await stopEmergencyDeterrenceAndEvidence();

  const audio = (await getEvidence()).filter((e) => e.type === 'audio');
  assert.ok(audio.length >= 3, `expected several segments, got ${audio.length}`);
  assert.ok(audio.every((e) => e.sessionId === 'sess_long'));
  assert.strictEqual(recording, false, 'microphone must be off after stop');
});

test('stop during a segment rotation never leaves the microphone recording', async () => {
  let recording = false;
  let releaseRotationStop: () => void = () => {};
  let stopCalls = 0;
  configureDeterrenceEvidenceOverrides({
    startAudioRecording: async () => {
      recording = true;
      return true;
    },
    stopAudioRecording: async () => {
      stopCalls++;
      if (stopCalls === 1) {
        await new Promise<void>((r) => {
          releaseRotationStop = r; // first (rotation) stop is slow
        });
      }
      const had = recording;
      recording = false;
      return had ? AUDIO : null;
    },
  });
  setAudioSegmentMsForTesting(20);

  await startEmergencyDeterrenceAndEvidence('sess_rotate');
  await new Promise((r) => setTimeout(r, 35)); // rotation in flight, blocked in stop
  const stop = stopEmergencyDeterrenceAndEvidence();
  releaseRotationStop();
  await stop;
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(recording, false, 'rotation must not restart the mic after stop was requested');
});

test('a siren failure does not stop the strobe from starting (and vice versa)', async () => {
  configureDeterrenceEvidenceOverrides({
    getRingerMode: async () => {
      throw new Error('AudioManager unavailable');
    },
    startSiren: async () => {
      throw new Error('AudioTrack init failed');
    },
    startStrobe: async () => true,
  });
  const status = await startDeterrence({ sirenEnabled: true, strobeEnabled: true, respectSilentMode: true });
  assert.strictEqual(status.strobeActive, true, 'strobe must still start');
  assert.strictEqual(status.sirenActive, false);

  configureDeterrenceEvidenceOverrides({
    getRingerMode: async () => 'normal',
    startSiren: async () => ({ started: true, suppressedBySilentMode: false }),
    startStrobe: async () => {
      throw new Error('torch busy');
    },
  });
  const status2 = await startDeterrence({ sirenEnabled: true, strobeEnabled: true, respectSilentMode: true });
  assert.strictEqual(status2.sirenActive, true, 'siren must still start');
  assert.strictEqual(status2.strobeActive, false);
});

test('emergency foreground service can keep microphone and camera access while backgrounded', () => {
  const manifest = fs.readFileSync('modules/foreground-service/android/src/main/AndroidManifest.xml', 'utf8');
  assert.ok(manifest.includes('microphone'));
  assert.ok(manifest.includes('camera'));
  assert.ok(manifest.includes('FOREGROUND_SERVICE_MICROPHONE'));
  assert.ok(manifest.includes('FOREGROUND_SERVICE_CAMERA'));
});
