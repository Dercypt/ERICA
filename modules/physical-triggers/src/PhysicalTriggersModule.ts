import { NativeModule, requireNativeModule } from 'expo';
import type { VolumeTriggerConfig, ShakeTriggerConfig } from './PhysicalTriggers.types';

declare class PhysicalTriggersModule extends NativeModule {
  configureVolumeTrigger(config: VolumeTriggerConfig): Promise<boolean>;
  configureShakeTrigger(config: ShakeTriggerConfig): Promise<boolean>;
  startShakeTest(config: { highPassAlpha: number; jerkThreshold: number }): Promise<boolean>;
  stopShakeTest(): Promise<boolean>;
  simulateVolumePress(): Promise<boolean>;
  simulateShake(jerk?: number): Promise<boolean>;
  isVolumeTriggerEnabled(): Promise<boolean>;
  isShakeTriggerEnabled(): Promise<boolean>;
  addListener(eventName: string, listener: (event: any) => void): { remove: () => void };
  removeListeners(count: number): void;
}

export default requireNativeModule<PhysicalTriggersModule>('PhysicalTriggers');
