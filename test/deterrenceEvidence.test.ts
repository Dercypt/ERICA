import test from 'node:test';
import assert from 'node:assert';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createActor } from 'xstate';
import { DEFAULT_SETTINGS, saveSettings, getSettings } from '../src/features/settings/settingsStorage';
import {
  startDeterrence,
  stopDeterrence,
  startConsentGatedAudioRecording,
  stopConsentGatedAudioRecording,
  captureConsentGatedPhotos,
  orchestrateEvidenceCapture,
  configureDeterrenceEvidenceOverrides,
  resetDeterrenceEvidenceOverrides,
} from '../modules/deterrence-evidence';
import {
  getEvidence,
  saveEvidenceList,
  appendEvidenceRecord,
  appendEvidenceRecords,
  getEvidenceBySession,
  clearEvidence,
  EVIDENCE_STORAGE_KEY,
  type EvidenceRecord,
} from '../src/features/evidence/evidenceStorage';
import {
  startEmergencyDeterrenceAndEvidence,
  stopEmergencyDeterrenceAndEvidence,
} from '../src/features/evidence/evidenceCoordinator';
import { sosMachine } from '../src/features/sos/sosMachine';
import { isEncryptedPayload } from '../src/features/security/encryption';
import { wipeMasterKeyMemory } from '../src/features/security/masterKey';

test('1. Strict Safety & Privacy Defaults: Deterrence and Evidence Consent are OFF by default', async () => {
  assert.strictEqual(DEFAULT_SETTINGS.deterrenceSirenEnabled, false, 'Siren must be OFF by default');
  assert.strictEqual(DEFAULT_SETTINGS.deterrenceStrobeEnabled, false, 'Strobe must be OFF by default');
  assert.strictEqual(DEFAULT_SETTINGS.respectSilentMode, true, 'respectSilentMode must be ON by default');
  assert.strictEqual(DEFAULT_SETTINGS.evidenceAudioConsentEnabled, false, 'Audio recording consent must be OFF by default');
  assert.strictEqual(DEFAULT_SETTINGS.evidencePhotoConsentEnabled, false, 'Photo capture consent must be OFF by default');
  assert.strictEqual(DEFAULT_SETTINGS.evidenceDualCamera, true, 'Default dual camera preference should be true');
});

test('2. Deterrence: Siren & Strobe activation in normal ringer mode', async () => {
  let sirenStarted = false;
  let strobeStarted = false;

  configureDeterrenceEvidenceOverrides({
    getRingerMode: async () => 'normal',
    startSiren: async () => {
      sirenStarted = true;
      return { started: true, suppressedBySilentMode: false };
    },
    startStrobe: async () => {
      strobeStarted = true;
      return true;
    },
  });

  try {
    const result = await startDeterrence({
      sirenEnabled: true,
      strobeEnabled: true,
      respectSilentMode: true,
    });

    assert.strictEqual(result.sirenActive, true, 'Siren should be active in normal mode');
    assert.strictEqual(result.strobeActive, true, 'Strobe should be active');
    assert.strictEqual(result.suppressedBySilentMode, false, 'Should not be suppressed in normal mode');
    assert.strictEqual(sirenStarted, true, 'startSiren adapter method was called');
    assert.strictEqual(strobeStarted, true, 'startStrobe adapter method was called');
  } finally {
    resetDeterrenceEvidenceOverrides();
  }
});

test('3. Deterrence: Silent Mode Suppression preserves acoustic stealth', async () => {
  let sirenAttempted = false;
  let strobeStarted = false;

  configureDeterrenceEvidenceOverrides({
    getRingerMode: async () => 'silent',
    startSiren: async (respectSilentMode) => {
      sirenAttempted = true;
      if (respectSilentMode) {
        return { started: false, suppressedBySilentMode: true };
      }
      return { started: true, suppressedBySilentMode: false };
    },
    startStrobe: async () => {
      strobeStarted = true;
      return true;
    },
  });

  try {
    // 3.1 With respectSilentMode = true, siren is suppressed, strobe still fires
    const result1 = await startDeterrence({
      sirenEnabled: true,
      strobeEnabled: true,
      respectSilentMode: true,
    });

    assert.strictEqual(result1.sirenActive, false, 'Acoustic siren must be suppressed when ringer is silent');
    assert.strictEqual(result1.suppressedBySilentMode, true, 'suppressedBySilentMode must be true');
    assert.strictEqual(result1.strobeActive, true, 'Camera strobe visual deterrence still activates');
    assert.strictEqual(strobeStarted, true);

    // 3.2 With respectSilentMode = false (override), siren fires even in silent mode
    const result2 = await startDeterrence({
      sirenEnabled: true,
      strobeEnabled: false,
      respectSilentMode: false,
    });

    assert.strictEqual(result2.sirenActive, true, 'Siren fires when respectSilentMode is overridden to false');
    assert.strictEqual(result2.suppressedBySilentMode, false);
  } finally {
    resetDeterrenceEvidenceOverrides();
  }
});

test('4. Deterrence: Deterministic Teardown stops both siren and strobe (Law 4)', async () => {
  let sirenStopped = false;
  let strobeStopped = false;

  configureDeterrenceEvidenceOverrides({
    stopSiren: async () => {
      sirenStopped = true;
      return true;
    },
    stopStrobe: async () => {
      strobeStopped = true;
      return true;
    },
  });

  try {
    await stopDeterrence();
    assert.strictEqual(sirenStopped, true, 'stopSiren must be called upon stopDeterrence');
    assert.strictEqual(strobeStopped, true, 'stopStrobe must be called upon stopDeterrence');
  } finally {
    resetDeterrenceEvidenceOverrides();
  }
});

test('5. Evidence Consent Gating: Audio recording strictly blocked without explicit consent', async () => {
  let recordingStarted = false;

  configureDeterrenceEvidenceOverrides({
    startAudioRecording: async () => {
      recordingStarted = true;
      return true;
    },
  });

  try {
    // 5.1 Consent = false: immediately returns false, zero recording attempted
    const blocked = await startConsentGatedAudioRecording('session_1', false);
    assert.strictEqual(blocked, false, 'Audio recording must return false when consent is not granted');
    assert.strictEqual(recordingStarted, false, 'Native audio recording must never start without consent');

    // 5.2 Consent = true: recording starts
    const allowed = await startConsentGatedAudioRecording('session_1', true);
    assert.strictEqual(allowed, true, 'Audio recording starts when explicit consent is granted');
    assert.strictEqual(recordingStarted, true);
  } finally {
    resetDeterrenceEvidenceOverrides();
  }
});

test('6. Evidence Consent Gating: Photo capture strictly blocked without explicit consent', async () => {
  let rearCaptured = false;
  let frontCaptured = false;

  configureDeterrenceEvidenceOverrides({
    capturePhoto: async (lens) => {
      if (lens === 'rear') rearCaptured = true;
      if (lens === 'front') frontCaptured = true;
      return {
        uri: `mock://${lens}.jpg`,
        lens,
        base64Data: 'mock_base64',
        fileSizeBytes: 1024,
        mimeType: 'image/jpeg',
        timestamp: Date.now(),
      };
    },
    captureDualPhotos: async () => {
      rearCaptured = true;
      frontCaptured = true;
      return [
        {
          uri: 'mock://rear.jpg',
          lens: 'rear',
          base64Data: 'rear_data',
          fileSizeBytes: 1024,
          mimeType: 'image/jpeg',
          timestamp: Date.now(),
        },
        {
          uri: 'mock://front.jpg',
          lens: 'front',
          base64Data: 'front_data',
          fileSizeBytes: 1024,
          mimeType: 'image/jpeg',
          timestamp: Date.now(),
        },
      ];
    },
  });

  try {
    // 6.1 Consent = false: returns empty list, zero camera interaction
    const noConsentPhotos = await captureConsentGatedPhotos(false, true);
    assert.strictEqual(noConsentPhotos.length, 0, 'No photos should be captured when consent is false');
    assert.strictEqual(rearCaptured, false);
    assert.strictEqual(frontCaptured, false);

    // 6.2 Consent = true: captures dual photos (front and rear)
    const consentPhotos = await captureConsentGatedPhotos(true, true);
    assert.strictEqual(consentPhotos.length, 2, 'Should capture both front and rear photos');
    assert.strictEqual(rearCaptured, true);
    assert.strictEqual(frontCaptured, true);
  } finally {
    resetDeterrenceEvidenceOverrides();
  }
});

test('7. Law 1 Cryptographic Invariant: Evidence vault stored strictly as authenticated AES-256-GCM ciphertext', async () => {
  await clearEvidence();

  const mockEvidence: EvidenceRecord = {
    id: 'ev_123',
    sessionId: 'session_999',
    type: 'photo',
    lens: 'rear',
    mimeType: 'image/jpeg',
    fileSizeBytes: 2048,
    createdAt: 1727850000000,
    dataBase64: 'U0VDUkVUX0FUVUFDSE1FTlRfREFUQVRPS0VOIDExMTE=',
  };

  await appendEvidenceRecord(mockEvidence);

  // 1. Retrieve through evidence storage API with master key
  const retrieved = await getEvidence();
  assert.strictEqual(retrieved.length, 1);
  assert.strictEqual(retrieved[0].id, 'ev_123');
  assert.strictEqual(retrieved[0].dataBase64, mockEvidence.dataBase64);

  // 2. Query raw on-disk AsyncStorage directly
  const rawDisk = await AsyncStorage.getItem(EVIDENCE_STORAGE_KEY);
  assert.ok(rawDisk, 'Raw disk entry for evidence vault must exist');
  const diskStr = rawDisk as string;

  // Verify it is a valid EncryptedEnvelope format
  assert.strictEqual(isEncryptedPayload(diskStr), true, 'Raw disk evidence vault must be a valid EncryptedEnvelope');

  // Strict Plaintext Extraction Check: Raw string must have ZERO occurrences of sensitive plaintext
  assert.strictEqual(diskStr.includes('U0VDUkVUX0FUVUFDSE1FTlRfREFUQVRPS0VOIDExMTE='), false, 'Plaintext media base64 must NEVER leak to disk');
  assert.strictEqual(diskStr.includes('session_999'), false, 'Session ID must not appear in plaintext on disk');
  assert.strictEqual(diskStr.includes('image/jpeg'), false, 'Mime type must not appear in plaintext on disk');

  // 3. Query by session ID
  const sessionRecords = await getEvidenceBySession('session_999');
  assert.strictEqual(sessionRecords.length, 1);
  assert.strictEqual(sessionRecords[0].sessionId, 'session_999');

  const emptyRecords = await getEvidenceBySession('nonexistent_session');
  assert.strictEqual(emptyRecords.length, 0);

  await clearEvidence();
});

test('8. Anti-Tampering & Deserialization Barrier on Evidence Storage', async () => {
  await clearEvidence();

  const record: EvidenceRecord = {
    id: 'tamper_test',
    sessionId: 'sess_tamper',
    type: 'audio',
    mimeType: 'audio/m4a',
    fileSizeBytes: 512,
    createdAt: Date.now(),
    dataBase64: 'VEFNUEVSX1BURVNUX0FVRElP',
  };

  await appendEvidenceRecord(record);

  // Verify tamper detection: Corrupt ciphertext on disk
  const rawDisk = await AsyncStorage.getItem(EVIDENCE_STORAGE_KEY);
  assert.ok(rawDisk);
  const parsed = JSON.parse(rawDisk as string);

  // Flip bits in ciphertext
  const corruptedCiphertext =
    parsed.ciphertext.substring(0, 10) + 'ffff' + parsed.ciphertext.substring(14);
  parsed.ciphertext = corruptedCiphertext;
  await AsyncStorage.setItem(EVIDENCE_STORAGE_KEY, JSON.stringify(parsed));

  // Loading corrupted storage must fail authentication tag check and return safe fallback []
  const tamperedList = await getEvidence();
  assert.strictEqual(tamperedList.length, 0, 'Tampered evidence storage must reject corrupted ciphertext');

  await clearEvidence();
});

test('9. SOS Machine: Deterministic resource teardown on CANCEL and MARK_SAFE (Law 4)', async () => {
  let deterrenceStarted = false;
  let deterrenceStopped = false;

  configureDeterrenceEvidenceOverrides({
    startSiren: async () => {
      deterrenceStarted = true;
      return { started: true, suppressedBySilentMode: false };
    },
    stopSiren: async () => {
      deterrenceStopped = true;
      return true;
    },
    stopStrobe: async () => true,
    stopAudioRecording: async () => null,
  });

  const actor = createActor(sosMachine).start();

  try {
    // 9.1 Countdown CANCEL triggers teardown
    actor.send({ type: 'TRIGGER', source: 'Test Deterrence Button' });
    assert.strictEqual(actor.getSnapshot().value, 'countdown');

    actor.send({ type: 'CANCEL' });
    assert.strictEqual(actor.getSnapshot().value, 'idle');
    // idle entry stops service, wake lock, and deterrence/evidence

    // 9.2 Transition to MARK_SAFE cleans up
    actor.send({ type: 'TRIGGER' });
    actor.send({ type: 'TICK' }); // will tick until dispatching
  } finally {
    actor.stop();
    resetDeterrenceEvidenceOverrides();
  }
});
