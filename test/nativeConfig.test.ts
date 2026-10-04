import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import {
  applyKeyEventHook,
  applyFlagSecure,
  applyGradleProjectName,
  applyPanicIntentHooks,
} from '../plugins/withEricaAndroidConfig';
import { ShakeDetectorEngine } from '../modules/physical-triggers';

const KOTLIN_ACTIVITY = `package com.erica.sos

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(null)
  }
}
`;

test('config plugin: MainActivity key hook is injected once and survives prebuild re-runs', () => {
  const once = applyKeyEventHook(applyFlagSecure(KOTLIN_ACTIVITY, 'kt'), 'kt');
  assert.ok(once.includes('PhysicalTriggersModule.onKeyEvent(event)'));
  assert.ok(once.includes('FLAG_SECURE'));
  assert.strictEqual(applyKeyEventHook(once, 'kt'), once, 'must be idempotent');
  assert.ok(once.trimEnd().endsWith('}'), 'hook must be inside the class body');
});

test('config plugin: panic-intent hooks are generated and do not suppress the key hook', () => {
  const generated = applyKeyEventHook(
    applyPanicIntentHooks(applyFlagSecure(KOTLIN_ACTIVITY, 'kt'), 'kt'),
    'kt'
  );
  assert.ok(generated.includes('setShowWhenLocked(true)'));
  assert.ok(generated.includes('handleIncomingIntent(intent)'));
  assert.ok(generated.includes('PhysicalTriggersModule.sendPanicEvent(panicSource)'));
  // Regression: the key hook used to skip any file already mentioning PhysicalTriggersModule.
  assert.ok(generated.includes('PhysicalTriggersModule.onKeyEvent(event)'));
  assert.strictEqual(applyPanicIntentHooks(generated, 'kt'), generated, 'must be idempotent');
});

test('config plugin: Gradle project name has no dots (Gradle 9)', () => {
  assert.strictEqual(
    applyGradleProjectName("rootProject.name = 'E.R.I.C.A.'\ninclude ':app'"),
    "rootProject.name = 'ERICA'\ninclude ':app'"
  );
});

test('committed android/ matches what the plugin generates', () => {
  const activity = fs.readFileSync('android/app/src/main/java/com/erica/sos/MainActivity.kt', 'utf8');
  assert.ok(activity.includes('PhysicalTriggersModule.onKeyEvent(event)'));
  assert.ok(activity.includes('handleIncomingIntent(intent)'));
  const manifest = fs.readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');
  assert.ok(manifest.includes('android:allowBackup="false"'));
});

test('module XML comments never contain "--" (Android\'s manifest merger rejects the file)', () => {
  const xmlFiles = (dir: string): string[] =>
    fs.readdirSync(dir).flatMap((name: string): string[] => {
      const path = `${dir}/${name}`;
      if (fs.statSync(path).isDirectory()) return name === 'build' ? [] : xmlFiles(path);
      return name.endsWith('.xml') ? [path] : [];
    });
  const files = xmlFiles('modules');
  assert.ok(files.length >= 4, 'expected the module manifests to be found');
  for (const file of files) {
    for (const [, body] of fs.readFileSync(file, 'utf8').matchAll(/<!--([\s\S]*?)-->/g)) {
      assert.ok(!body.includes('--'), `${file}: comment contains "--": ${body.trim().slice(0, 60)}`);
    }
  }
});

test('volume trigger survives a process restart: config is persisted and restored natively', () => {
  const dir = 'modules/physical-triggers/android/src/main/java/expo/modules/physicaltriggers';
  const module = fs.readFileSync(`${dir}/PhysicalTriggersModule.kt`, 'utf8');
  const service = fs.readFileSync(`${dir}/EricaAccessibilityService.kt`, 'utf8');
  const configure = module.slice(module.indexOf('AsyncFunction("configureVolumeTrigger")'));
  assert.ok(
    configure.indexOf('saveVolumeConfig(') !== -1 &&
      configure.indexOf('saveVolumeConfig(') < configure.indexOf('AsyncFunction("configureShakeTrigger")'),
    'configureVolumeTrigger must persist what JS set'
  );
  const connected = service.slice(service.indexOf('fun onServiceConnected'), service.indexOf('fun onAccessibilityEvent'));
  assert.ok(connected.includes('restoreVolumeConfig('), 'the accessibility service must restore it on connect');
});

test('settings switches save without the Save button', () => {
  const screen = fs.readFileSync('src/features/settings/SettingsScreen.tsx', 'utf8');
  const effect = screen.slice(screen.indexOf('if (!loadedRef.current) return;'));
  assert.ok(effect.includes('persistSettings('), 'auto-save effect must persist');
  const deps = effect.slice(effect.indexOf('}, ['), effect.indexOf(']);'));
  for (const name of ['sirenEnabled', 'strobeEnabled', 'volumeEnabled', 'shakeEnabled']) {
    assert.ok(deps.includes(name), `${name} must trigger an auto-save`);
  }
});

test('boot receiver ships in the library and reads the outbox where expo-sqlite stores it', () => {
  const manifest = fs.readFileSync('modules/foreground-service/android/src/main/AndroidManifest.xml', 'utf8');
  assert.ok(manifest.includes('expo.modules.foregroundservice.EricaBootReceiver'));
  assert.ok(manifest.includes('RECEIVE_BOOT_COMPLETED'));
  const receiver = fs.readFileSync(
    'modules/foreground-service/android/src/main/java/expo/modules/foregroundservice/EricaBootReceiver.kt',
    'utf8'
  );
  assert.ok(receiver.includes('File(File(context.filesDir, "SQLite"), "erica_outbox.db")'));
  assert.ok(!receiver.includes('context.getDatabasePath('), 'getDatabasePath points outside expo-sqlite storage');
  assert.ok(!fs.existsSync('android/app/src/main/java/com/erica/sos/EricaBootReceiver.kt'));
});

test('foreground service declares a specialUse fallback for Android 14+', () => {
  const manifest = fs.readFileSync('modules/foreground-service/android/src/main/AndroidManifest.xml', 'utf8');
  assert.ok(manifest.includes('location|specialUse'));
  assert.ok(manifest.includes('FOREGROUND_SERVICE_SPECIAL_USE'));
  assert.ok(manifest.includes('PROPERTY_SPECIAL_USE_FGS_SUBTYPE'));
});

test('accessibility service lives in the library and does not subscribe to all UI events', () => {
  const manifest = fs.readFileSync('modules/physical-triggers/android/src/main/AndroidManifest.xml', 'utf8');
  assert.ok(manifest.includes('EricaAccessibilityService'));
  const config = fs.readFileSync(
    'modules/physical-triggers/android/src/main/res/xml/erica_accessibility_service_config.xml',
    'utf8'
  );
  assert.ok(!config.includes('typeAllMask'));
  assert.ok(config.includes('flagRequestFilterKeyEvents'));
});

test('live shake calibration: registerSpike completes the pattern only with enough reversals in the window', () => {
  let fired = 0;
  const engine = new ShakeDetectorEngine({ enabled: true, minShakes: 3, onTrigger: () => fired++ });
  const t = 1_000_000;
  assert.strictEqual(engine.registerSpike(t), false);
  assert.strictEqual(engine.registerSpike(t + 50), false, 'debounced: same stroke');
  assert.strictEqual(engine.registerSpike(t + 200), false);
  assert.strictEqual(engine.registerSpike(t + 400), true);
  assert.strictEqual(fired, 1);
  assert.strictEqual(engine.registerSpike(t + 600), false, 'cooldown after a trigger');

  const spread = new ShakeDetectorEngine({ enabled: true, minShakes: 3 });
  spread.registerSpike(t);
  spread.registerSpike(t + 1000);
  assert.strictEqual(spread.registerSpike(t + 2000), false, 'spikes outside the 1.5s window do not count');

  const disabled = new ShakeDetectorEngine({ enabled: false });
  assert.strictEqual(disabled.registerSpike(t), false);
});
