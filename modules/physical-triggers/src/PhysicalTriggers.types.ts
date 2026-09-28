export interface PanicTriggerEvent {
  source: 'Volume Button Pattern' | 'Shake Detector' | string;
  timestamp: number;
}

export interface VolumeTriggerConfig {
  enabled: boolean;
  pressCount: number;
  windowSeconds: number;
  debounceMs?: number;
  cooldownMs?: number;
}

export interface ShakeTriggerConfig {
  enabled: boolean;
  jerkThreshold: number;
  minShakes: number;
  highPassAlpha: number;
  shakeWindowMs?: number;
  minShakeIntervalMs?: number;
  cooldownMs?: number;
}

export interface ShakeTestSample {
  timestamp: number;
  currentJerk: number;
  jerkThreshold: number;
  linearX: number;
  linearY: number;
  linearZ: number;
  isSpike: boolean;
  isTriggered: boolean;
}

export interface PhysicalTriggersAdapter {
  configureVolumeTrigger(config: VolumeTriggerConfig): Promise<boolean>;
  configureShakeTrigger(config: ShakeTriggerConfig): Promise<boolean>;
  startShakeTest(config: { highPassAlpha: number; jerkThreshold: number }): Promise<boolean>;
  stopShakeTest(): Promise<boolean>;
  simulateVolumePress(): Promise<boolean>;
  simulateShake(jerk?: number): Promise<boolean>;
  isVolumeTriggerEnabled(): Promise<boolean>;
  isShakeTriggerEnabled(): Promise<boolean>;
}

export type PanicTriggerListener = (event: PanicTriggerEvent) => void;
export type ShakeTestListener = (sample: ShakeTestSample) => void;
