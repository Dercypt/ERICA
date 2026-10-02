export type RingerMode = 'silent' | 'vibrate' | 'normal';

export interface DeterrenceConfig {
  sirenEnabled: boolean;
  strobeEnabled: boolean;
  respectSilentMode: boolean;
  strobeFrequencyHz?: number;
}

export interface DeterrenceStatus {
  sirenActive: boolean;
  strobeActive: boolean;
  ringerMode: RingerMode;
  suppressedBySilentMode: boolean;
}

export interface AudioRecordResult {
  uri: string;
  durationMs: number;
  base64Data: string;
  fileSizeBytes: number;
  mimeType: string;
}

export interface PhotoCaptureResult {
  uri: string;
  lens: 'front' | 'rear';
  base64Data: string;
  fileSizeBytes: number;
  mimeType: string;
  timestamp: number;
}

export interface EvidenceCaptureConfig {
  sessionId: string;
  audioConsentGranted: boolean;
  photoConsentGranted: boolean;
  dualCamera?: boolean;
  maxAudioDurationMs?: number;
}

export interface EvidenceCaptureResult {
  sessionId: string;
  audioResult?: AudioRecordResult;
  photoResults: PhotoCaptureResult[];
  errors: string[];
}

export interface DeterrenceEvidenceAdapter {
  startSiren(respectSilentMode?: boolean): Promise<{ started: boolean; suppressedBySilentMode: boolean }>;
  stopSiren(): Promise<boolean>;
  isSirenActive(): Promise<boolean>;

  startStrobe(frequencyHz?: number): Promise<boolean>;
  stopStrobe(): Promise<boolean>;
  isStrobeActive(): Promise<boolean>;

  getRingerMode(): Promise<RingerMode>;

  startAudioRecording(sessionId: string): Promise<boolean>;
  stopAudioRecording(): Promise<AudioRecordResult | null>;
  isAudioRecordingActive(): Promise<boolean>;

  capturePhoto(lens: 'front' | 'rear'): Promise<PhotoCaptureResult>;
  captureDualPhotos(): Promise<PhotoCaptureResult[]>;
}
