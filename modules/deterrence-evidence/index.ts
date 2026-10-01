import DeterrenceEvidenceModule from './src/DeterrenceEvidenceModule';
import type {
  AudioRecordResult,
  DeterrenceConfig,
  DeterrenceEvidenceAdapter,
  DeterrenceStatus,
  EvidenceCaptureConfig,
  EvidenceCaptureResult,
  PhotoCaptureResult,
  RingerMode,
} from './src/DeterrenceEvidence.types';

export * from './src/DeterrenceEvidence.types';

const defaultAdapter: DeterrenceEvidenceAdapter = {
  startSiren: (respectSilentMode) => DeterrenceEvidenceModule.startSiren(respectSilentMode),
  stopSiren: () => DeterrenceEvidenceModule.stopSiren(),
  isSirenActive: () => DeterrenceEvidenceModule.isSirenActive(),

  startStrobe: (frequencyHz) => DeterrenceEvidenceModule.startStrobe(frequencyHz),
  stopStrobe: () => DeterrenceEvidenceModule.stopStrobe(),
  isStrobeActive: () => DeterrenceEvidenceModule.isStrobeActive(),

  getRingerMode: () => DeterrenceEvidenceModule.getRingerMode(),

  startAudioRecording: (sessionId) => DeterrenceEvidenceModule.startAudioRecording(sessionId),
  stopAudioRecording: () => DeterrenceEvidenceModule.stopAudioRecording(),
  isAudioRecordingActive: () => DeterrenceEvidenceModule.isAudioRecordingActive(),

  capturePhoto: (lens) => DeterrenceEvidenceModule.capturePhoto(lens),
  captureDualPhotos: () => DeterrenceEvidenceModule.captureDualPhotos(),
};

let activeAdapter: DeterrenceEvidenceAdapter = { ...defaultAdapter };

export function configureDeterrenceEvidenceOverrides(adapter: Partial<DeterrenceEvidenceAdapter>): void {
  activeAdapter = { ...activeAdapter, ...adapter };
}

export function resetDeterrenceEvidenceOverrides(): void {
  activeAdapter = { ...defaultAdapter };
}

/**
 * Activates deterrence mechanisms (audible siren and LED strobe torch)
 * according to user settings and device ringer mode.
 *
 * All deterrence loops execute strictly off the main thread.
 */
export async function startDeterrence(config: DeterrenceConfig): Promise<DeterrenceStatus> {
  let sirenActive = false;
  let strobeActive = false;
  let suppressedBySilentMode = false;

  const ringerMode = await activeAdapter.getRingerMode();

  if (config.sirenEnabled) {
    const sirenResult = await activeAdapter.startSiren(config.respectSilentMode);
    sirenActive = sirenResult.started;
    suppressedBySilentMode = sirenResult.suppressedBySilentMode;
  }

  if (config.strobeEnabled) {
    strobeActive = await activeAdapter.startStrobe(config.strobeFrequencyHz);
  }

  return {
    sirenActive,
    strobeActive,
    ringerMode,
    suppressedBySilentMode,
  };
}

/**
 * Stops both siren and strobe immediately and releases hardware resources.
 * Deterministic Law 4 cleanup.
 */
export async function stopDeterrence(): Promise<void> {
  await Promise.all([
    activeAdapter.stopSiren().catch((err) => console.warn('[Deterrence] stopSiren error:', err)),
    activeAdapter.stopStrobe().catch((err) => console.warn('[Deterrence] stopStrobe error:', err)),
  ]);
}

/**
 * Starts consent-gated audio recording off the main thread.
 * If consent is not explicitly granted, this immediately returns false without recording.
 */
export async function startConsentGatedAudioRecording(
  sessionId: string,
  consentGranted: boolean
): Promise<boolean> {
  if (!consentGranted) {
    return false;
  }
  return await activeAdapter.startAudioRecording(sessionId);
}

/**
 * Stops the audio recording session and returns recorded metadata and base64 payload.
 */
export async function stopConsentGatedAudioRecording(): Promise<AudioRecordResult | null> {
  return await activeAdapter.stopAudioRecording();
}

/**
 * Captures consent-gated photographic evidence from front and/or rear lenses.
 * If consent is not explicitly granted, returns an empty array.
 * Off the main UI thread.
 */
export async function captureConsentGatedPhotos(
  consentGranted: boolean,
  dualCamera = true
): Promise<PhotoCaptureResult[]> {
  if (!consentGranted) {
    return [];
  }

  if (dualCamera) {
    return await activeAdapter.captureDualPhotos();
  }

  const rearPhoto = await activeAdapter.capturePhoto('rear');
  return [rearPhoto];
}

/**
 * Performs complete evidence capture orchestration for an emergency session.
 * Enforces explicit consent gates for audio and photos.
 */
export async function orchestrateEvidenceCapture(
  config: EvidenceCaptureConfig
): Promise<EvidenceCaptureResult> {
  const errors: string[] = [];
  let audioResult: AudioRecordResult | undefined;
  let photoResults: PhotoCaptureResult[] = [];

  // 1. Consent-gated photo capture (front/rear) off main thread
  if (config.photoConsentGranted) {
    try {
      photoResults = await captureConsentGatedPhotos(true, config.dualCamera ?? true);
    } catch (photoErr) {
      console.warn('[Evidence] Photo capture failed:', photoErr);
      errors.push(`Photo capture error: ${photoErr instanceof Error ? photoErr.message : String(photoErr)}`);
    }
  }

  // 2. Consent-gated audio recording off main thread
  if (config.audioConsentGranted) {
    try {
      await startConsentGatedAudioRecording(config.sessionId, true);
    } catch (audioErr) {
      console.warn('[Evidence] Audio recording start failed:', audioErr);
      errors.push(`Audio recording error: ${audioErr instanceof Error ? audioErr.message : String(audioErr)}`);
    }
  }

  return {
    sessionId: config.sessionId,
    audioResult,
    photoResults,
    errors,
  };
}

export default {
  startDeterrence,
  stopDeterrence,
  startConsentGatedAudioRecording,
  stopConsentGatedAudioRecording,
  captureConsentGatedPhotos,
  orchestrateEvidenceCapture,
  configureDeterrenceEvidenceOverrides,
  resetDeterrenceEvidenceOverrides,
};
