import test from 'node:test';
import assert from 'node:assert';
import { resetMockSecureStore } from './mockExpo.mjs';
import { resetMockLocalAuthentication, setMockBiometricState } from './mockLocalAuthentication.mjs';
import { AppState } from './mockReactNative.mjs';
import {
  setupPin,
  lockVault,
  appLockController,
  hashPin,
  saveSecureItem,
  PIN_AUTH_STORAGE_KEY,
} from '../src/features/security';
import { DEFAULT_SETTINGS, saveSettings } from '../src/features/settings/settingsStorage';

test.beforeEach(async () => {
  resetMockSecureStore();
  resetMockLocalAuthentication();
  (AppState as any)._reset();
  lockVault();
  await saveSettings({ ...DEFAULT_SETTINGS, appLockTimeoutSeconds: 0 });
  appLockController.destroy();
});

test('snapshot reports isInitialized=false until stored state is read', async () => {
  await setupPin('246813', 1000);
  assert.strictEqual(appLockController.getSnapshot().isInitialized, false);
  await appLockController.init();
  assert.strictEqual(appLockController.getSnapshot().isInitialized, true);
  assert.strictEqual(appLockController.getSnapshot().isLocked, true);
});

test('getSnapshot is referentially stable between changes (useSyncExternalStore contract)', async () => {
  await appLockController.init();
  const a = appLockController.getSnapshot();
  assert.strictEqual(appLockController.getSnapshot(), a);
});

test('concurrent init() calls register exactly one AppState listener', async () => {
  await Promise.all([appLockController.init(), appLockController.init(), appLockController.init()]);
  assert.strictEqual((AppState as any)._listenerCount(), 1);
});

test("'inactive' (iOS notification shade / Face ID prompt) does not lock the app", async () => {
  await setupPin('135791', 1000);
  await appLockController.init();
  await appLockController.unlockWithPin('135791');
  (AppState as any)._setAppState('inactive');
  (AppState as any)._setAppState('active');
  assert.strictEqual(appLockController.getSnapshot().isLocked, false);
});

test('app-state changes during a biometric prompt do not re-lock the app', async () => {
  await setupPin('135791', 1000);
  await appLockController.init();
  setMockBiometricState({ hardware: true, enrolled: true, types: [1] });
  const pending = appLockController.unlockWithBiometrics();
  (AppState as any)._setAppState('background');
  (AppState as any)._setAppState('active');
  const result = await pending;
  assert.strictEqual(result.success, true);
  assert.strictEqual(appLockController.getSnapshot().isLocked, false);
});

test('a real background trip still locks in Immediate mode', async () => {
  await setupPin('135791', 1000);
  await appLockController.init();
  await appLockController.unlockWithPin('135791');
  (AppState as any)._setAppState('background');
  (AppState as any)._setAppState('active');
  assert.strictEqual(appLockController.getSnapshot().isLocked, true);
});

test('a legacy 4-digit PIN set before the 6-digit rule still unlocks', async () => {
  // setupPin now enforces 6 digits, so write the pre-existing record directly.
  const legacy = await hashPin('4821', undefined, 1000);
  await saveSecureItem(PIN_AUTH_STORAGE_KEY, JSON.stringify(legacy));
  await appLockController.init();
  assert.strictEqual(await appLockController.unlockWithPin('4821'), true);
  assert.strictEqual(appLockController.getSnapshot().isLocked, false);
});
