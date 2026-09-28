import PhysicalTriggersModule from './src/PhysicalTriggersModule';
import type {
  PanicTriggerEvent,
  PanicTriggerListener,
  PhysicalTriggersAdapter,
  ShakeTestListener,
  ShakeTestSample,
  ShakeTriggerConfig,
  VolumeTriggerConfig,
} from './src/PhysicalTriggers.types';

export * from './src/PhysicalTriggers.types';

/**
 * Pure algorithmic implementation of Volume Pattern Detection.
 * Supports multi-press sequence detection within a sliding time window,
 * key repeat filtering (prevents holding button false alarms), debouncing,
 * and post-trigger cooldown.
 */
export class VolumePatternEngine {
  private enabled: boolean;
  private pressCount: number;
  private windowMs: number;
  private debounceMs: number;
  private cooldownMs: number;
  private pressTimestamps: number[] = [];
  private lastTriggerTime = 0;
  private lastPressTime = 0;
  private onTriggerCallback?: (source: string) => void;

  constructor(options?: {
    enabled?: boolean;
    pressCount?: number;
    windowSeconds?: number;
    debounceMs?: number;
    cooldownMs?: number;
    onTrigger?: (source: string) => void;
  }) {
    this.enabled = options?.enabled ?? false;
    this.pressCount = options?.pressCount ?? 4;
    this.windowMs = (options?.windowSeconds ?? 3) * 1000;
    this.debounceMs = options?.debounceMs ?? 100;
    this.cooldownMs = options?.cooldownMs ?? 3000;
    this.onTriggerCallback = options?.onTrigger;
  }

  configure(options: Partial<VolumeTriggerConfig> & { onTrigger?: (source: string) => void }): void {
    if (options.enabled !== undefined) this.enabled = options.enabled;
    if (options.pressCount !== undefined) this.pressCount = options.pressCount;
    if (options.windowSeconds !== undefined) this.windowMs = options.windowSeconds * 1000;
    if (options.debounceMs !== undefined) this.debounceMs = options.debounceMs;
    if (options.cooldownMs !== undefined) this.cooldownMs = options.cooldownMs;
    if (options.onTrigger !== undefined) this.onTriggerCallback = options.onTrigger;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getPressCount(): number {
    return this.pressCount;
  }

  getWindowMs(): number {
    return this.windowMs;
  }

  getActivePressCount(now: number = Date.now()): number {
    const cutoff = now - this.windowMs;
    return this.pressTimestamps.filter((t) => t >= cutoff).length;
  }

  reset(): void {
    this.pressTimestamps = [];
    this.lastPressTime = 0;
  }

  onPress(timestamp: number = Date.now(), isRepeat: boolean = false): boolean {
    if (!this.enabled) {
      return false;
    }

    // STRICT FALSE ALARM CHECK: Holding down the volume button generates repeat events.
    // We strictly ignore repeat events so holding the button down never triggers panic.
    if (isRepeat) {
      return false;
    }

    // Debounce to eliminate hardware bounce
    if (timestamp - this.lastPressTime < this.debounceMs) {
      return false;
    }
    this.lastPressTime = timestamp;

    // Cooldown check following previous alert
    if (timestamp - this.lastTriggerTime < this.cooldownMs) {
      return false;
    }

    // Sliding time window: discard presses outside the window duration
    const windowStart = timestamp - this.windowMs;
    this.pressTimestamps = this.pressTimestamps.filter((t) => t >= windowStart);
    this.pressTimestamps.push(timestamp);

    if (this.pressTimestamps.length >= this.pressCount) {
      this.pressTimestamps = [];
      this.lastTriggerTime = timestamp;
      this.onTriggerCallback?.('Volume Button Pattern');
      return true;
    }

    return false;
  }
}

/**
 * Pure algorithmic implementation of High-Pass Filtered Shake Detection.
 * Isolates linear acceleration by subtracting estimated gravity (high-pass filter),
 * computes jerk (|da/dt|), and requires multi-directional reversals above an
 * adjustable jerk threshold within a tight window to prevent false alarms from
 * table drops, gentle movement, or walking.
 */
export class ShakeDetectorEngine {
  private enabled: boolean;
  private jerkThreshold: number;
  private minShakes: number;
  private highPassAlpha: number;
  private shakeWindowMs: number;
  private minShakeIntervalMs: number;
  private cooldownMs: number;

  private gravity = { x: 0, y: 0, z: 0 };
  private initialized = false;
  private lastLinear = { x: 0, y: 0, z: 0 };
  private lastTimestampMs = 0;
  private lastShakeTimeMs = 0;
  private lastTriggerTimeMs = 0;
  private shakeTimestamps: number[] = [];
  private onTriggerCallback?: (source: string) => void;

  constructor(options?: {
    enabled?: boolean;
    jerkThreshold?: number;
    minShakes?: number;
    highPassAlpha?: number;
    shakeWindowMs?: number;
    minShakeIntervalMs?: number;
    cooldownMs?: number;
    onTrigger?: (source: string) => void;
  }) {
    this.enabled = options?.enabled ?? false;
    this.jerkThreshold = options?.jerkThreshold ?? 25;
    this.minShakes = options?.minShakes ?? 3;
    this.highPassAlpha = options?.highPassAlpha ?? 0.8;
    this.shakeWindowMs = options?.shakeWindowMs ?? 1500;
    this.minShakeIntervalMs = options?.minShakeIntervalMs ?? 120;
    this.cooldownMs = options?.cooldownMs ?? 3000;
    this.onTriggerCallback = options?.onTrigger;
  }

  configure(options: Partial<ShakeTriggerConfig> & { onTrigger?: (source: string) => void }): void {
    if (options.enabled !== undefined) this.enabled = options.enabled;
    if (options.jerkThreshold !== undefined) this.jerkThreshold = options.jerkThreshold;
    if (options.minShakes !== undefined) this.minShakes = options.minShakes;
    if (options.highPassAlpha !== undefined) this.highPassAlpha = options.highPassAlpha;
    if (options.shakeWindowMs !== undefined) this.shakeWindowMs = options.shakeWindowMs;
    if (options.minShakeIntervalMs !== undefined) this.minShakeIntervalMs = options.minShakeIntervalMs;
    if (options.cooldownMs !== undefined) this.cooldownMs = options.cooldownMs;
    if (options.onTrigger !== undefined) this.onTriggerCallback = options.onTrigger;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getJerkThreshold(): number {
    return this.jerkThreshold;
  }

  getHighPassAlpha(): number {
    return this.highPassAlpha;
  }

  reset(): void {
    this.initialized = false;
    this.gravity = { x: 0, y: 0, z: 0 };
    this.lastLinear = { x: 0, y: 0, z: 0 };
    this.lastTimestampMs = 0;
    this.lastShakeTimeMs = 0;
    this.shakeTimestamps = [];
  }

  /**
   * Processes an incoming 3-axis accelerometer sample.
   * Acceleration is expected in m/s^2 (with gravity ~9.8 m/s^2).
   */
  processSample(x: number, y: number, z: number, timestampMs: number = Date.now()): ShakeTestSample {
    if (!this.initialized) {
      this.gravity = { x, y, z };
      this.lastLinear = { x: 0, y: 0, z: 0 };
      this.lastTimestampMs = timestampMs;
      this.initialized = true;
      return {
        timestamp: timestampMs,
        currentJerk: 0,
        jerkThreshold: this.jerkThreshold,
        linearX: 0,
        linearY: 0,
        linearZ: 0,
        isSpike: false,
        isTriggered: false,
      };
    }

    const dtSeconds = Math.max(0.001, (timestampMs - this.lastTimestampMs) / 1000);
    this.lastTimestampMs = timestampMs;

    // HIGH-PASS FILTER:
    // Low-pass filter tracks constant DC gravity and slow tilt
    this.gravity.x = this.highPassAlpha * this.gravity.x + (1 - this.highPassAlpha) * x;
    this.gravity.y = this.highPassAlpha * this.gravity.y + (1 - this.highPassAlpha) * y;
    this.gravity.z = this.highPassAlpha * this.gravity.z + (1 - this.highPassAlpha) * z;

    // Linear dynamic acceleration (high-pass output)
    const linearX = x - this.gravity.x;
    const linearY = y - this.gravity.y;
    const linearZ = z - this.gravity.z;

    // Jerk calculation (|da / dt|)
    const deltaX = linearX - this.lastLinear.x;
    const deltaY = linearY - this.lastLinear.y;
    const deltaZ = linearZ - this.lastLinear.z;
    const deltaLinearMag = Math.sqrt(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ);
    const currentJerk = deltaLinearMag / dtSeconds;

    this.lastLinear = { x: linearX, y: linearY, z: linearZ };

    const isSpike = currentJerk >= this.jerkThreshold;
    let isTriggered = false;

    if (this.enabled && isSpike) {
      const inCooldown = timestampMs - this.lastTriggerTimeMs < this.cooldownMs;
      const debounced = timestampMs - this.lastShakeTimeMs >= this.minShakeIntervalMs;

      if (!inCooldown && debounced) {
        this.lastShakeTimeMs = timestampMs;
        const windowCutoff = timestampMs - this.shakeWindowMs;
        this.shakeTimestamps = this.shakeTimestamps.filter((t) => t >= windowCutoff);
        this.shakeTimestamps.push(timestampMs);

        if (this.shakeTimestamps.length >= this.minShakes) {
          this.shakeTimestamps = [];
          this.lastTriggerTimeMs = timestampMs;
          isTriggered = true;
          this.onTriggerCallback?.('Shake Detector');
        }
      }
    }

    return {
      timestamp: timestampMs,
      currentJerk: Math.round(currentJerk * 100) / 100,
      jerkThreshold: this.jerkThreshold,
      linearX: Math.round(linearX * 100) / 100,
      linearY: Math.round(linearY * 100) / 100,
      linearZ: Math.round(linearZ * 100) / 100,
      isSpike,
      isTriggered,
    };
  }
}

// Global engine instances for unified JS/Native event dispatching
export const globalVolumeEngine = new VolumePatternEngine();
export const globalShakeEngine = new ShakeDetectorEngine();

const panicListeners = new Set<PanicTriggerListener>();
const shakeTestListeners = new Set<ShakeTestListener>();

export function notifyPanicTrigger(source: string, timestamp: number = Date.now()): void {
  const event: PanicTriggerEvent = { source, timestamp };
  panicListeners.forEach((fn) => {
    try {
      fn(event);
    } catch (err) {
      console.error('[PhysicalTriggers] notifyPanicTrigger error:', err);
    }
  });
}

// Connect native event listener
try {
  PhysicalTriggersModule.addListener?.('onPanicTrigger', (event: PanicTriggerEvent) => {
    notifyPanicTrigger(event.source || 'Physical Trigger', event.timestamp || Date.now());
  });

  PhysicalTriggersModule.addListener?.('onShakeTestSample', (sample: ShakeTestSample) => {
    shakeTestListeners.forEach((fn) => {
      try {
        fn(sample);
      } catch (err) {
        console.error('[PhysicalTriggers] onShakeTestSample listener error:', err);
      }
    });
  });
} catch {
  // Ignored in test/headless environments
}

// Wire engine callbacks to notifyPanicTrigger
globalVolumeEngine.configure({
  onTrigger: (source: string) => notifyPanicTrigger(source),
});
globalShakeEngine.configure({
  onTrigger: (source: string) => notifyPanicTrigger(source),
});

const defaultAdapter: PhysicalTriggersAdapter = {
  configureVolumeTrigger: async (config) => {
    globalVolumeEngine.configure(config);
    return await PhysicalTriggersModule.configureVolumeTrigger(config);
  },
  configureShakeTrigger: async (config) => {
    globalShakeEngine.configure(config);
    return await PhysicalTriggersModule.configureShakeTrigger(config);
  },
  startShakeTest: async (config) => {
    return await PhysicalTriggersModule.startShakeTest(config);
  },
  stopShakeTest: async () => {
    return await PhysicalTriggersModule.stopShakeTest();
  },
  simulateVolumePress: async () => {
    globalVolumeEngine.onPress(Date.now(), false);
    return await PhysicalTriggersModule.simulateVolumePress();
  },
  simulateShake: async (jerk?: number) => {
    const targetJerk = jerk ?? globalShakeEngine.getJerkThreshold() + 10;
    // Simulate multi-directional samples to exercise high-pass jerk engine
    const now = Date.now();
    globalShakeEngine.processSample(0, 0, 9.8, now);
    globalShakeEngine.processSample(targetJerk * 0.05, 0, 9.8, now + 50);
    globalShakeEngine.processSample(-targetJerk * 0.05, 0, 9.8, now + 200);
    globalShakeEngine.processSample(targetJerk * 0.05, 0, 9.8, now + 350);
    return await PhysicalTriggersModule.simulateShake(jerk);
  },
  isVolumeTriggerEnabled: async () => {
    return globalVolumeEngine.isEnabled();
  },
  isShakeTriggerEnabled: async () => {
    return globalShakeEngine.isEnabled();
  },
};

let activeAdapter: PhysicalTriggersAdapter = { ...defaultAdapter };

export function configurePhysicalTriggersOverrides(adapter: Partial<PhysicalTriggersAdapter>): void {
  activeAdapter = { ...activeAdapter, ...adapter };
}

export function resetPhysicalTriggersOverrides(): void {
  activeAdapter = { ...defaultAdapter };
  globalVolumeEngine.reset();
  globalShakeEngine.reset();
}

/**
 * Registers a listener for physical panic trigger events (Volume button pattern, Shake detector).
 */
export function addPanicTriggerListener(listener: PanicTriggerListener): { remove: () => void } {
  panicListeners.add(listener);
  return {
    remove: () => {
      panicListeners.delete(listener);
    },
  };
}

/**
 * Configures volume button pattern detector settings.
 */
export async function configureVolumeTrigger(config: VolumeTriggerConfig): Promise<boolean> {
  return await activeAdapter.configureVolumeTrigger(config);
}

/**
 * Configures shake detector settings.
 */
export async function configureShakeTrigger(config: ShakeTriggerConfig): Promise<boolean> {
  return await activeAdapter.configureShakeTrigger(config);
}

/**
 * Starts interactive shake sensitivity testing without arming panic alert.
 */
export function addShakeTestListener(listener: ShakeTestListener): { remove: () => void } {
  shakeTestListeners.add(listener);
  return {
    remove: () => {
      shakeTestListeners.delete(listener);
    },
  };
}

export async function startShakeSensitivityTest(config: {
  highPassAlpha: number;
  jerkThreshold: number;
}): Promise<boolean> {
  return await activeAdapter.startShakeTest(config);
}

export async function stopShakeSensitivityTest(): Promise<boolean> {
  return await activeAdapter.stopShakeTest();
}

export async function simulateVolumePress(): Promise<boolean> {
  return await activeAdapter.simulateVolumePress();
}

export async function simulateShake(jerk?: number): Promise<boolean> {
  return await activeAdapter.simulateShake(jerk);
}

export default {
  VolumePatternEngine,
  ShakeDetectorEngine,
  globalVolumeEngine,
  globalShakeEngine,
  addPanicTriggerListener,
  notifyPanicTrigger,
  configureVolumeTrigger,
  configureShakeTrigger,
  addShakeTestListener,
  startShakeSensitivityTest,
  stopShakeSensitivityTest,
  simulateVolumePress,
  simulateShake,
  configurePhysicalTriggersOverrides,
  resetPhysicalTriggersOverrides,
};
