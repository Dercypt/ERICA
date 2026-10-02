import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { resetMockSecureStore } from './mockExpo.mjs';
import { DEFAULT_SETTINGS, saveSettings } from '../src/features/settings/settingsStorage';
import {
  configureDeterrenceEvidenceOverrides,
  resetDeterrenceEvidenceOverrides,
} from '../modules/deterrence-evidence';
import {
  startEmergencyDeterrenceAndEvidence,
  stopEmergencyDeterrenceAndEvidence,
} from '../src/features/evidence/evidenceCoordinator';
import {
  appendEvidenceRecord,
  clearEvidence,
  getEvidence,
  EVIDENCE_STORAGE_KEY,
} from '../src/features/evidence/evidenceStorage';
import { DecryptionFailedError } from '../src/features/contacts/contactsStorage';
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

test('evidence writes refuse to overwrite a vault they cannot decrypt', async () => {
  const foreign = await encryptString('[]', generateRandomBytes(32));
  await AsyncStorage.setItem(EVIDENCE_STORAGE_KEY, foreign);
  await assert.rejects(
    () =>
      appendEvidenceRecord({
        id: 'x',
        sessionId: 's',
        type: 'audio',
        mimeType: 'audio/m4a',
        fileSizeBytes: 1,
        createdAt: 1,
        dataBase64: 'AA==',
      }),
    DecryptionFailedError
  );
  assert.strictEqual(await AsyncStorage.getItem(EVIDENCE_STORAGE_KEY), foreign);
});

test('emergency foreground service can keep microphone and camera access while backgrounded', () => {
  const manifest = fs.readFileSync('modules/foreground-service/android/src/main/AndroidManifest.xml', 'utf8');
  assert.ok(manifest.includes('microphone'));
  assert.ok(manifest.includes('camera'));
  assert.ok(manifest.includes('FOREGROUND_SERVICE_MICROPHONE'));
  assert.ok(manifest.includes('FOREGROUND_SERVICE_CAMERA'));
});
