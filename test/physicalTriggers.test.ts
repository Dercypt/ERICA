import test from 'node:test';
import assert from 'node:assert';
import { createActor } from 'xstate';
import {
  VolumePatternEngine,
  ShakeDetectorEngine,
  addPanicTriggerListener,
  notifyPanicTrigger,
} from '../modules/physical-triggers';
import { DEFAULT_SETTINGS, getSettings, saveSettings } from '../src/features/settings/settingsStorage';
import { sosMachine } from '../src/features/sos/sosMachine';

test('1. Strict Safety Defaults: All physical triggers remain OFF by default in settings and engines', async () => {
  // Verify default settings object
  assert.strictEqual(DEFAULT_SETTINGS.volumeTriggerEnabled, false, 'volumeTriggerEnabled must be false by default');
  assert.strictEqual(DEFAULT_SETTINGS.shakeTriggerEnabled, false, 'shakeTriggerEnabled must be false by default');
  assert.strictEqual(DEFAULT_SETTINGS.volumePressCount, 4, 'Default volume press count should be 4');
  assert.strictEqual(DEFAULT_SETTINGS.volumeWindowSeconds, 3, 'Default volume window should be 3s');
  assert.strictEqual(DEFAULT_SETTINGS.shakeThreshold, 25, 'Default shake threshold should be 25 m/s³');
  assert.strictEqual(DEFAULT_SETTINGS.shakeMinCount, 3, 'Default shake min count should be 3');

  // Verify default engine instances initialize disabled
  const volumeEngine = new VolumePatternEngine();
  assert.strictEqual(volumeEngine.isEnabled(), false, 'VolumePatternEngine must be disabled by default');

  const shakeEngine = new ShakeDetectorEngine();
  assert.strictEqual(shakeEngine.isEnabled(), false, 'ShakeDetectorEngine must be disabled by default');

  // Verify that an unconfigured/disabled engine ignores events (zero false alarms)
  let triggerCalled = false;
  volumeEngine.configure({
    onTrigger: () => {
      triggerCalled = true;
    },
  });

  const now = 10000;
  for (let i = 0; i < 10; i++) {
    volumeEngine.onPress(now + i * 200, false);
  }
  assert.strictEqual(triggerCalled, false, 'Disabled VolumePatternEngine must never trigger');

  shakeEngine.configure({
    onTrigger: () => {
      triggerCalled = true;
    },
  });
  shakeEngine.processSample(0, 0, 9.8, now);
  shakeEngine.processSample(100, 0, 9.8, now + 50);
  shakeEngine.processSample(-100, 0, 9.8, now + 200);
  shakeEngine.processSample(100, 0, 9.8, now + 350);
  assert.strictEqual(triggerCalled, false, 'Disabled ShakeDetectorEngine must never trigger');
});

test('2. Volume Button Pattern: Detects 4 presses within 3 seconds when enabled', async () => {
  let triggerSource = '';
  const engine = new VolumePatternEngine({
    enabled: true,
    pressCount: 4,
    windowSeconds: 3,
    debounceMs: 100,
    onTrigger: (source) => {
      triggerSource = source;
    },
  });

  const baseTime = 10000;
  // Press 1 at t = 0
  assert.strictEqual(engine.onPress(baseTime, false), false);
  // Press 2 at t = 400ms
  assert.strictEqual(engine.onPress(baseTime + 400, false), false);
  // Press 3 at t = 900ms
  assert.strictEqual(engine.onPress(baseTime + 900, false), false);
  // Press 4 at t = 1500ms (within 3s window) -> TRIGGER
  assert.strictEqual(engine.onPress(baseTime + 1500, false), true);

  assert.strictEqual(triggerSource, 'Volume Button Pattern');
});

test('3. Volume Button Pattern False Alarm Prevention: Incomplete presses or expired window do not trigger', async () => {
  let triggerCount = 0;
  const engine = new VolumePatternEngine({
    enabled: true,
    pressCount: 4,
    windowSeconds: 3,
    debounceMs: 100,
    onTrigger: () => {
      triggerCount++;
    },
  });

  const baseTime = 20000;
  // Case A: Only 3 presses in 3s -> Should not trigger
  engine.onPress(baseTime, false);
  engine.onPress(baseTime + 300, false);
  engine.onPress(baseTime + 600, false);
  assert.strictEqual(triggerCount, 0, '3 presses should not trigger a 4-press requirement');

  // Case B: 4 presses but spaced over 5s (outside 3s sliding window) -> Should not trigger
  engine.reset();
  engine.onPress(baseTime, false);
  engine.onPress(baseTime + 1200, false);
  engine.onPress(baseTime + 2500, false);
  // 4th press at 4000ms: first press at 0 is outside the 3000ms window (4000 - 3000 = 1000 > 0)
  // Remaining active presses in window = [1200, 2500, 4000] = 3 presses < 4
  const triggered = engine.onPress(baseTime + 4000, false);
  assert.strictEqual(triggered, false, 'Presses spread over 4s must not trigger 3s window');
  assert.strictEqual(triggerCount, 0, 'No trigger should have occurred');
});

test('4. Volume Button Pattern False Alarm Prevention: Holding button (key repeat) is strictly ignored', async () => {
  let triggerCount = 0;
  const engine = new VolumePatternEngine({
    enabled: true,
    pressCount: 4,
    windowSeconds: 3,
    debounceMs: 100,
    onTrigger: () => {
      triggerCount++;
    },
  });

  const baseTime = 30000;
  // User holds down volume button: first press is down, subsequent events are repeats
  engine.onPress(baseTime, false); // Real press down
  engine.onPress(baseTime + 200, true); // Repeat 1
  engine.onPress(baseTime + 400, true); // Repeat 2
  engine.onPress(baseTime + 600, true); // Repeat 3
  engine.onPress(baseTime + 800, true); // Repeat 4

  assert.strictEqual(triggerCount, 0, 'Holding volume button (key repeats) must NOT trigger panic');
});

test('5. Shake Detector: High-pass filtering eliminates constant gravity & slow tilt', async () => {
  const engine = new ShakeDetectorEngine({
    enabled: true,
    jerkThreshold: 25,
    minShakes: 3,
    highPassAlpha: 0.8,
  });

  let t = 40000;
  // Stationary phone lying on table with 1G Earth gravity along Z axis
  const initial = engine.processSample(0, 0, 9.8, t);
  assert.strictEqual(initial.currentJerk, 0, 'Initial sample jerk must be 0');

  // Stationary for 10 samples
  for (let i = 1; i <= 10; i++) {
    t += 50;
    const sample = engine.processSample(0, 0, 9.8, t);
    assert.strictEqual(sample.isSpike, false, 'Stationary device must never produce a jerk spike');
    assert.strictEqual(sample.isTriggered, false);
  }

  // Slow tilting / gentle movement: acceleration changes slowly over 2 seconds
  for (let i = 1; i <= 20; i++) {
    t += 100;
    const tiltX = (i / 20) * 3.0; // Slow tilt from 0 to 3 m/s²
    const tiltZ = 9.8 - (i / 20) * 1.5;
    const sample = engine.processSample(tiltX, 0, tiltZ, t);
    assert.ok(sample.currentJerk < 15, `Slow tilt jerk (${sample.currentJerk}) must stay well below threshold`);
    assert.strictEqual(sample.isSpike, false);
    assert.strictEqual(sample.isTriggered, false);
  }
});

test('6. Shake Detector False Alarm Prevention: Single drop / bump on table does NOT trigger', async () => {
  let triggerCount = 0;
  const engine = new ShakeDetectorEngine({
    enabled: true,
    jerkThreshold: 25,
    minShakes: 3,
    highPassAlpha: 0.8,
    onTrigger: () => {
      triggerCount++;
    },
  });

  let t = 50000;
  // Initialize filter with resting gravity
  engine.processSample(0, 0, 9.8, t);

  // Single sudden impact (e.g. phone placed down firmly or dropped onto mattress):
  // Causes a single deceleration spike in one direction, followed by rest
  t += 50;
  const impactSample = engine.processSample(0, 0, 25.0, t);
  assert.strictEqual(impactSample.isSpike, true, 'Impact produces a single spike');
  assert.strictEqual(impactSample.isTriggered, false, 'Single impact must NOT trigger panic');

  // Device comes to rest immediately
  for (let i = 1; i <= 5; i++) {
    t += 50;
    engine.processSample(0, 0, 9.8, t);
  }

  assert.strictEqual(triggerCount, 0, 'Single drop/bump must never trigger panic without reversals');
});

test('7. Shake Detector: Vigorous multi-directional shaking exceeding adjustable jerk threshold triggers panic', async () => {
  let triggerSource = '';
  const engine = new ShakeDetectorEngine({
    enabled: true,
    jerkThreshold: 25,
    minShakes: 3,
    highPassAlpha: 0.8,
    shakeWindowMs: 1500,
    minShakeIntervalMs: 100,
    onTrigger: (src) => {
      triggerSource = src;
    },
  });

  let t = 60000;
  engine.processSample(0, 0, 9.8, t);

  // Vigorous shake 1: forward stroke (+X high acceleration)
  t += 50;
  const s1 = engine.processSample(18, 0, 9.8, t);
  assert.strictEqual(s1.isSpike, true, 'Stroke 1 should exceed jerk threshold');

  // Return stroke 2: reverse direction (-X high acceleration) after 150ms
  t += 150;
  const s2 = engine.processSample(-18, 0, 9.8, t);
  assert.strictEqual(s2.isSpike, true, 'Stroke 2 should exceed jerk threshold');

  // Forward stroke 3: forward direction (+X high acceleration) after 150ms
  t += 150;
  const s3 = engine.processSample(18, 0, 9.8, t);
  assert.strictEqual(s3.isSpike, true, 'Stroke 3 should exceed jerk threshold');
  assert.strictEqual(s3.isTriggered, true, '3 vigorous shakes must trigger panic');

  assert.strictEqual(triggerSource, 'Shake Detector');
});

test('8. Shake Detector: Adjustable jerk threshold dynamically raises sensitivity bar', async () => {
  const engine = new ShakeDetectorEngine({
    enabled: true,
    jerkThreshold: 20, // Low threshold
    minShakes: 2,
    highPassAlpha: 0.8,
  });

  let t = 70000;
  engine.processSample(0, 0, 9.8, t);
  t += 50;
  // A modest movement of 2.0 m/s² in 50ms results in jerk ~32 m/s³
  const moderateShake = engine.processSample(2.0, 0, 9.8, t);
  assert.ok(moderateShake.currentJerk >= 20, `Jerk (${moderateShake.currentJerk}) should be >= 20`);
  assert.strictEqual(moderateShake.isSpike, true, 'At threshold 20, this moderate movement spikes');

  // User adjusts jerk threshold higher to 50 (stricter false-alarm rejection)
  engine.configure({ jerkThreshold: 50 });
  assert.strictEqual(engine.getJerkThreshold(), 50);

  // Same moderate movement no longer spikes under the stricter threshold
  t += 100;
  engine.processSample(0, 0, 9.8, t);
  t += 50;
  const calibratedShake = engine.processSample(2.0, 0, 9.8, t);
  assert.strictEqual(calibratedShake.isSpike, false, 'Higher jerk threshold prevents moderate shake from spiking');
});

test('9. Settings Persistence: Custom thresholds and safety toggles persist correctly', async () => {
  const customSettings = {
    ...DEFAULT_SETTINGS,
    volumeTriggerEnabled: true,
    volumePressCount: 5,
    volumeWindowSeconds: 4,
    shakeTriggerEnabled: true,
    shakeThreshold: 35,
    shakeMinCount: 4,
    shakeHighPassAlpha: 0.85,
  };

  await saveSettings(customSettings);
  const loaded = await getSettings();

  assert.strictEqual(loaded.volumeTriggerEnabled, true);
  assert.strictEqual(loaded.volumePressCount, 5);
  assert.strictEqual(loaded.volumeWindowSeconds, 4);
  assert.strictEqual(loaded.shakeTriggerEnabled, true);
  assert.strictEqual(loaded.shakeThreshold, 35);
  assert.strictEqual(loaded.shakeMinCount, 4);
  assert.strictEqual(loaded.shakeHighPassAlpha, 0.85);

  // Restore clean defaults
  await saveSettings(DEFAULT_SETTINGS);
});

test('10. End-to-End: Physical panic trigger event transitions sosMachine to countdown', async () => {
  const actor = createActor(sosMachine).start();

  try {
    assert.strictEqual(actor.getSnapshot().value, 'idle');

    // Simulate physical trigger event delivered via addPanicTriggerListener
    let receivedEventSource = '';
    const sub = addPanicTriggerListener((event) => {
      receivedEventSource = event.source;
      actor.send({ type: 'TRIGGER', source: event.source });
    });

    notifyPanicTrigger('Volume Button Pattern');

    assert.strictEqual(receivedEventSource, 'Volume Button Pattern');
    const snapshot = actor.getSnapshot();
    assert.strictEqual(snapshot.value, 'countdown');
    assert.strictEqual(snapshot.context.triggerSource, 'Volume Button Pattern');

    // Canceling properly returns to idle
    actor.send({ type: 'CANCEL' });
    assert.strictEqual(actor.getSnapshot().value, 'idle');

    // Test Shake Detector trigger source
    notifyPanicTrigger('Shake Detector');
    assert.strictEqual(actor.getSnapshot().value, 'countdown');
    assert.strictEqual(actor.getSnapshot().context.triggerSource, 'Shake Detector');

    sub.remove();
  } finally {
    actor.stop();
  }
});
