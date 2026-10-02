import { registerWebModule, NativeModule } from 'expo';
import type { AudioRecordResult, PhotoCaptureResult, RingerMode } from './DeterrenceEvidence.types';

class DeterrenceEvidenceModule extends NativeModule {
  private sirenActive = false;
  private strobeActive = false;
  private audioRecordingActive = false;
  private ringerMode: RingerMode = 'normal';

  async startSiren(respectSilentMode = true): Promise<{ started: boolean; suppressedBySilentMode: boolean }> {
    if (respectSilentMode && (this.ringerMode === 'silent' || this.ringerMode === 'vibrate')) {
      this.sirenActive = false;
      return { started: false, suppressedBySilentMode: true };
    }
    this.sirenActive = true;
    return { started: true, suppressedBySilentMode: false };
  }

  async stopSiren(): Promise<boolean> {
    this.sirenActive = false;
    return true;
  }

  async isSirenActive(): Promise<boolean> {
    return this.sirenActive;
  }

  async startStrobe(_frequencyHz = 8): Promise<boolean> {
    this.strobeActive = true;
    return true;
  }

  async stopStrobe(): Promise<boolean> {
    this.strobeActive = false;
    return true;
  }

  async isStrobeActive(): Promise<boolean> {
    return this.strobeActive;
  }

  async getRingerMode(): Promise<RingerMode> {
    return this.ringerMode;
  }

  async startAudioRecording(_sessionId: string): Promise<boolean> {
    this.audioRecordingActive = true;
    return true;
  }

  async stopAudioRecording(): Promise<AudioRecordResult | null> {
    if (!this.audioRecordingActive) return null;
    this.audioRecordingActive = false;
    return {
      uri: 'file:///mock/evidence/audio.m4a',
      durationMs: 5000,
      base64Data: 'RXJpY2FBdWRpb0V2aWRlbmNlU2FtcGxlRGF0YQ==',
      fileSizeBytes: 1024,
      mimeType: 'audio/m4a',
    };
  }

  async isAudioRecordingActive(): Promise<boolean> {
    return this.audioRecordingActive;
  }

  async capturePhoto(lens: 'front' | 'rear'): Promise<PhotoCaptureResult> {
    return {
      uri: `file:///mock/evidence/${lens}_photo.jpg`,
      lens,
      base64Data: 'RXJpY2FQaG90b0V2aWRlbmNlU2FtcGxlRGF0YQ==',
      fileSizeBytes: 2048,
      mimeType: 'image/jpeg',
      timestamp: Date.now(),
    };
  }

  async captureDualPhotos(): Promise<PhotoCaptureResult[]> {
    const rear = await this.capturePhoto('rear');
    const front = await this.capturePhoto('front');
    return [rear, front];
  }
}

export default registerWebModule(DeterrenceEvidenceModule, 'DeterrenceEvidence');
