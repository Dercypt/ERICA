import { NativeModule, requireNativeModule } from 'expo';
import type { AudioRecordResult, PhotoCaptureResult, RingerMode } from './DeterrenceEvidence.types';

declare class DeterrenceEvidenceModule extends NativeModule {
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

  addListener(eventName: string, listener: (event: any) => void): { remove: () => void };
  removeListeners(count: number): void;
}

export default requireNativeModule<DeterrenceEvidenceModule>('DeterrenceEvidence');
