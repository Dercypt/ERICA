import { registerWebModule, NativeModule } from 'expo';
import type { VolumeTriggerConfig, ShakeTriggerConfig } from './PhysicalTriggers.types';

class PhysicalTriggersModule extends NativeModule {
  private volumeEnabled = false;
  private shakeEnabled = false;

  async configureVolumeTrigger(config: VolumeTriggerConfig): Promise<boolean> {
    this.volumeEnabled = Boolean(config.enabled);
    return true;
  }

  async configureShakeTrigger(config: ShakeTriggerConfig): Promise<boolean> {
    this.shakeEnabled = Boolean(config.enabled);
    return true;
  }

  async startShakeTest(_config: { highPassAlpha: number; jerkThreshold: number }): Promise<boolean> {
    return true;
  }

  async stopShakeTest(): Promise<boolean> {
    return true;
  }

  async simulateVolumePress(): Promise<boolean> {
    return true;
  }

  async simulateShake(_jerk?: number): Promise<boolean> {
    return true;
  }

  async isVolumeTriggerEnabled(): Promise<boolean> {
    return this.volumeEnabled;
  }

  async isShakeTriggerEnabled(): Promise<boolean> {
    return this.shakeEnabled;
  }
}

export default registerWebModule(PhysicalTriggersModule, 'PhysicalTriggers');
