import { getSettings } from '../settings/settingsStorage';
import {
  startDeterrence,
  stopDeterrence,
  startConsentGatedAudioRecording,
  stopConsentGatedAudioRecording,
  captureConsentGatedPhotos,
  type DeterrenceStatus,
} from '../../../modules/deterrence-evidence';
import { appendEvidenceRecord, appendEvidenceRecords, type EvidenceRecord } from './evidenceStorage';

let activeSessionId: string | null = null;
let activeDeterrenceStatus: DeterrenceStatus | null = null;

/**
 * Initiates deterrence (siren & strobe) and consent-gated evidence capture (audio & photos)
 * completely off the main UI thread during an emergency alert.
 *
 * Failure in deterrence or evidence capture never blocks SMS dispatch or GPS acquisition.
 */
export async function startEmergencyDeterrenceAndEvidence(
  sessionId: string,
  _triggerSource = 'Emergency'
): Promise<void> {
  activeSessionId = sessionId;

  try {
    const settings = await getSettings();

    // 1. Off-thread Deterrence: Siren & Strobe
    if (settings.deterrenceSirenEnabled || settings.deterrenceStrobeEnabled) {
      startDeterrence({
        sirenEnabled: Boolean(settings.deterrenceSirenEnabled),
        strobeEnabled: Boolean(settings.deterrenceStrobeEnabled),
        respectSilentMode: settings.respectSilentMode ?? true,
      })
        .then((status) => {
          activeDeterrenceStatus = status;
        })
        .catch((err) => {
          console.warn('[EvidenceCoordinator] startDeterrence error:', err);
        });
    }

    // 2. Off-thread Consent-Gated Photo Evidence Capture
    if (settings.evidencePhotoConsentEnabled) {
      captureConsentGatedPhotos(true, settings.evidenceDualCamera ?? true)
        .then(async (photos) => {
          if (photos.length > 0) {
            const records: EvidenceRecord[] = photos.map((p) => ({
              id: `photo_${sessionId}_${p.lens}_${Date.now()}`,
              sessionId,
              type: 'photo',
              lens: p.lens,
              mimeType: p.mimeType,
              fileSizeBytes: p.fileSizeBytes,
              createdAt: p.timestamp || Date.now(),
              dataBase64: p.base64Data,
            }));
            await appendEvidenceRecords(records);
          }
        })
        .catch((err) => {
          console.warn('[EvidenceCoordinator] photo capture error:', err);
        });
    }

    // 3. Off-thread Consent-Gated Audio Evidence Recording
    if (settings.evidenceAudioConsentEnabled) {
      startConsentGatedAudioRecording(sessionId, true).catch((err) => {
        console.warn('[EvidenceCoordinator] startAudioRecording error:', err);
      });
    }
  } catch (err) {
    console.warn('[EvidenceCoordinator] General start error:', err);
  }
}

/**
 * Deterministically terminates deterrence and finalizes audio recordings upon MARK_SAFE or CANCEL.
 * Strict Law 4 compliance: synchronously releases camera torch, audio streams, and saves encrypted audio.
 */
export async function stopEmergencyDeterrenceAndEvidence(): Promise<void> {
  const currentSessionId = activeSessionId;
  activeSessionId = null;
  activeDeterrenceStatus = null;

  // 1. Teardown siren & strobe
  try {
    await stopDeterrence();
  } catch (err) {
    console.warn('[EvidenceCoordinator] stopDeterrence error:', err);
  }

  // 2. Finalize and securely store audio recording
  try {
    const audioResult = await stopConsentGatedAudioRecording();
    if (audioResult && currentSessionId) {
      const record: EvidenceRecord = {
        id: `audio_${currentSessionId}_${Date.now()}`,
        sessionId: currentSessionId,
        type: 'audio',
        mimeType: audioResult.mimeType,
        fileSizeBytes: audioResult.fileSizeBytes,
        durationMs: audioResult.durationMs,
        createdAt: Date.now(),
        dataBase64: audioResult.base64Data,
      };
      await appendEvidenceRecord(record);
    }
  } catch (err) {
    console.warn('[EvidenceCoordinator] stopAudioRecording error:', err);
  }
}

/**
 * Returns whether deterrence was activated for the current emergency.
 */
export function getActiveDeterrenceStatus(): DeterrenceStatus | null {
  return activeDeterrenceStatus;
}

export default {
  startEmergencyDeterrenceAndEvidence,
  stopEmergencyDeterrenceAndEvidence,
  getActiveDeterrenceStatus,
};
