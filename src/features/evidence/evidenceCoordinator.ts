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
// Start and stop overlap in practice: the SOS machine calls stop from several exits of one
// transition (e.g. DISMISS action + idle entry), and the user can tap "I'm safe" before the
// native start calls have returned. These keep teardown ordered after start and single-flight.
let pendingStart: Promise<void> | null = null;
let pendingStop: Promise<void> | null = null;
let stopRequested = false;

/**
 * Audio is recorded in segments of this length. One unbounded recording is read whole into
 * memory (native file, base64 string, encryption) when it stops, so a long emergency could
 * exhaust memory and lose everything; each segment is saved as its own evidence record.
 */
export const AUDIO_SEGMENT_MS = 2 * 60_000;
let audioSegmentMs = AUDIO_SEGMENT_MS;
let segmentTimer: ReturnType<typeof setInterval> | null = null;
let pendingRotation: Promise<void> | null = null;
let audioSegmentCounter = 0;

/** Test-only: shorten the audio segment length. */
export function setAudioSegmentMsForTesting(ms: number | null): void {
  audioSegmentMs = ms ?? AUDIO_SEGMENT_MS;
}

async function saveAudioSegment(
  audioResult: Awaited<ReturnType<typeof stopConsentGatedAudioRecording>>,
  sessionId: string | null
): Promise<void> {
  if (!audioResult) return;
  // Never discard a finished recording: the native side has already deleted its file.
  const id = sessionId ?? `unattributed_${Date.now()}`;
  // Saving an existing id replaces it, so ids must stay unique even within one millisecond.
  audioSegmentCounter += 1;
  const record: EvidenceRecord = {
    id: `audio_${id}_${Date.now()}_${audioSegmentCounter}`,
    sessionId: id,
    type: 'audio',
    mimeType: audioResult.mimeType,
    fileSizeBytes: audioResult.fileSizeBytes,
    durationMs: audioResult.durationMs,
    createdAt: Date.now(),
    dataBase64: audioResult.base64Data,
  };
  await appendEvidenceRecord(record);
}

function clearSegmentTimer(): void {
  if (segmentTimer) {
    clearInterval(segmentTimer);
    segmentTimer = null;
  }
}

/** Closes the current audio segment, saves it, and starts the next one. */
function rotateAudioSegment(sessionId: string): void {
  if (stopRequested || pendingRotation) return;
  const rotation = (async () => {
    try {
      await saveAudioSegment(await stopConsentGatedAudioRecording(), sessionId);
    } catch (err) {
      console.warn('[EvidenceCoordinator] audio segment save error:', err);
    }
    // Never restart the microphone once teardown has been requested.
    if (!stopRequested) {
      await startConsentGatedAudioRecording(sessionId, true).catch((err) => {
        console.warn('[EvidenceCoordinator] audio segment restart error:', err);
      });
    }
  })().finally(() => {
    if (pendingRotation === rotation) pendingRotation = null;
  });
  pendingRotation = rotation;
}

/**
 * Initiates deterrence (siren & strobe) and consent-gated evidence capture (audio & photos)
 * completely off the main UI thread during an emergency alert.
 *
 * Failure in deterrence or evidence capture never blocks SMS dispatch or GPS acquisition.
 */
export function startEmergencyDeterrenceAndEvidence(
  sessionId: string,
  _triggerSource = 'Emergency'
): Promise<void> {
  activeSessionId = sessionId;
  stopRequested = false;
  const start = runStart(sessionId).finally(() => {
    if (pendingStart === start) pendingStart = null;
  });
  pendingStart = start;
  return start;
}

async function runStart(sessionId: string): Promise<void> {
  const nativeStarts: Promise<unknown>[] = [];
  try {
    const settings = await getSettings();

    // 1. Off-thread Deterrence: Siren & Strobe
    if (settings.deterrenceSirenEnabled || settings.deterrenceStrobeEnabled) {
      nativeStarts.push(
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
          })
      );
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
      nativeStarts.push(
        startConsentGatedAudioRecording(sessionId, true)
          .then((started) => {
            if (started && !stopRequested) {
              clearSegmentTimer();
              segmentTimer = setInterval(() => rotateAudioSegment(sessionId), audioSegmentMs);
            }
          })
          .catch((err) => {
            console.warn('[EvidenceCoordinator] startAudioRecording error:', err);
          })
      );
    }
  } catch (err) {
    console.warn('[EvidenceCoordinator] General start error:', err);
  }
  // Photo capture (above) is deliberately not awaited: it can take seconds and only writes
  // records. Siren, strobe and the microphone are the resources stop must not race past.
  await Promise.all(nativeStarts);
}

/**
 * Deterministically terminates deterrence and finalizes audio recordings upon MARK_SAFE or CANCEL.
 * Strict Law 4 compliance: synchronously releases camera torch, audio streams, and saves encrypted audio.
 */
export function stopEmergencyDeterrenceAndEvidence(): Promise<void> {
  if (pendingStop) {
    return pendingStop;
  }
  stopRequested = true;
  clearSegmentTimer();
  const stop = runStop().finally(() => {
    if (pendingStop === stop) pendingStop = null;
  });
  pendingStop = stop;
  return stop;
}

async function runStop(): Promise<void> {
  // A stop that overtakes a start would leave the siren or microphone running with nothing
  // left to turn it off.
  if (pendingStart) {
    await pendingStart;
  }
  clearSegmentTimer(); // a start that finished just now may have armed it
  if (pendingRotation) {
    await pendingRotation;
  }
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
    await saveAudioSegment(await stopConsentGatedAudioRecording(), currentSessionId);
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
