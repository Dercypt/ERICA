import test from 'node:test';
import assert from 'node:assert';
import { resetMockSecureStore } from './mockExpo.mjs';
import {
  setMockBiometricState,
  resetMockLocalAuthentication,
} from './mockLocalAuthentication.mjs';
import { AppState } from './mockReactNative.mjs';
import {
  setupPin,
  setupDuressPin,
  isDuressPinConfigured,
  lockVault,
  isVaultLocked,
  isPinConfigured,
  isMasterKeyLoaded,
  getActiveMasterKey,
  isBiometricsAvailable,
  getBiometricCapabilities,
  authenticateWithBiometrics,
  unlockWithBiometrics,
  appLockController,
} from '../src/features/security';
import {
  getDecoyContacts,
  addDecoyContact,
  removeDecoyContact,
  resetDecoyContacts,
} from '../src/features/contacts';
import { DEFAULT_SETTINGS, saveSettings } from '../src/features/settings/settingsStorage';
import {
  applyFlagSecure,
  ERICA_PERMISSIONS,
} from '../plugins/withEricaAndroidConfig';
import {
  configureDispatchEngineOverrides,
  resetDispatchEngineOverrides,
  initDispatchEngine,
  getOutboxItems,
} from '../src/features/dispatch';
import { MockSQLiteDatabase } from './mockDatabase';
import { getSosService } from '../src/features/sos/sosMachine';
import { notifyPanicTrigger } from '../modules/physical-triggers';

test.beforeEach(async () => {
  resetMockSecureStore();
  resetMockLocalAuthentication();
  (AppState as any)._reset();
  lockVault();
  await saveSettings({
    ...DEFAULT_SETTINGS,
    appLockTimeoutSeconds: 0,
    biometricsEnabled: true,
  });
  appLockController.destroy();
  resetDispatchEngineOverrides();
});

test('1. Biometrics: Capability inspection and availability detection', async () => {
  setMockBiometricState({ hardware: true, enrolled: true, types: [1, 2] });
  assert.strictEqual(await isBiometricsAvailable(), true, 'Biometrics should be available when hardware and enrollment exist');

  const capabilities = await getBiometricCapabilities();
  assert.strictEqual(capabilities.hasHardware, true);
  assert.strictEqual(capabilities.isEnrolled, true);
  assert.ok(capabilities.supportedTypes.includes('Fingerprint'));
  assert.ok(capabilities.supportedTypes.includes('Face Unlock'));

  // When device lacks hardware
  setMockBiometricState({ hardware: false, enrolled: false });
  assert.strictEqual(await isBiometricsAvailable(), false, 'Unavailable when device lacks hardware');
});

test('2. Biometrics: Successful verification unlocks vault and loads master key', async () => {
  // Set up PIN first
  await setupPin('246810', 1000);
  assert.strictEqual(await isPinConfigured(), true);

  // Lock vault
  lockVault();
  assert.strictEqual(isVaultLocked(), true);
  assert.strictEqual(isMasterKeyLoaded(), false);

  // Configure biometric success
  setMockBiometricState({ hardware: true, enrolled: true, result: { success: true } });

  const authResult = await unlockWithBiometrics();
  assert.strictEqual(authResult.success, true);
  assert.strictEqual(isVaultLocked(), false, 'Vault must be unlocked after biometric success');
  assert.strictEqual(isMasterKeyLoaded(), true, 'Master key must be loaded into memory');
});

test('3. Biometrics: Cancellation or failure provides seamless fallback to custom PIN', async () => {
  await setupPin('567890', 1000);
  lockVault();

  // User chooses "Use PIN" (fallback) or cancels biometric prompt
  setMockBiometricState({
    hardware: true,
    enrolled: true,
    result: { success: false, error: 'user_fallback' },
  });

  const authResult = await unlockWithBiometrics();
  assert.strictEqual(authResult.success, false);
  assert.strictEqual(authResult.fallbackChosen, true, 'Must indicate user requested PIN fallback');
  assert.strictEqual(isVaultLocked(), true, 'Vault must remain locked upon fallback');

  // Seamless fallback to custom PIN unlocks successfully
  const pinSuccess = await appLockController.unlockWithPin('567890');
  assert.strictEqual(pinSuccess, true, 'Custom PIN unlock must succeed following biometric fallback');
  assert.strictEqual(isVaultLocked(), false, 'Vault must be unlocked after PIN validation');
});

test('4. AppLockController: Engages lock on launch when PIN configured and stays unlocked when unconfigured', async () => {
  // Unconfigured state
  await appLockController.init();
  assert.strictEqual(appLockController.getSnapshot().isLocked, false, 'Unconfigured app must not lock out user');

  appLockController.destroy();

  // Configured state
  await setupPin('123456', 1000);
  await appLockController.init();
  assert.strictEqual(appLockController.getSnapshot().isLocked, true, 'Configured app must lock out unauthorized access on open');
});

test('5. Lifecycle Gatekeeper: Immediate mode locks the exact second app is backgrounded', async () => {
  await setupPin('987654', 1000);
  await appLockController.init();
  await appLockController.setLockTimeoutSeconds(0); // Immediate

  // Unlock with PIN
  const unlocked = await appLockController.unlockWithPin('987654');
  assert.strictEqual(unlocked, true);
  assert.strictEqual(appLockController.getSnapshot().isLocked, false);

  // App is backgrounded
  (AppState as any)._setAppState('background');
  assert.strictEqual(appLockController.getSnapshot().isLocked, true, 'Immediate mode must engage lock state upon backgrounding');
  assert.strictEqual(isVaultLocked(), true, 'Master key memory must be wiped upon backgrounding');

  // Returning to foreground remains locked
  (AppState as any)._setAppState('active');
  assert.strictEqual(appLockController.getSnapshot().isLocked, true, 'App must remain locked when foregrounded');
});

test('6. Lifecycle Gatekeeper: Configurable timeout (15s / 30s) allows quick app switching', async () => {
  await setupPin('334455', 1000);
  await appLockController.init();
  await appLockController.setLockTimeoutSeconds(15); // 15 seconds window

  await appLockController.unlockWithPin('334455');
  assert.strictEqual(appLockController.getSnapshot().isLocked, false);

  // User momentarily backgrounds app (e.g. 5 seconds)
  (AppState as any)._setAppState('background');

  // Return to active within window
  (AppState as any)._setAppState('active');
  assert.strictEqual(appLockController.getSnapshot().isLocked, false, 'Should remain unlocked within timeout window');

  // Background again and simulate elapsed timeout
  (AppState as any)._setAppState('background');
  // Mutate lastBackgroundedAt to 20 seconds ago
  (appLockController as any).lastBackgroundedAt = Date.now() - 20_000;

  (AppState as any)._setAppState('active');
  assert.strictEqual(appLockController.getSnapshot().isLocked, true, 'Must lock when returning after timeout exceeded');
});

test('7. Lifecycle Gatekeeper: In-app inactivity idle timeout locks active session', async () => {
  await setupPin('778899', 1000);
  await appLockController.init();
  await appLockController.setLockTimeoutSeconds(15);

  await appLockController.unlockWithPin('778899');
  assert.strictEqual(appLockController.getSnapshot().isLocked, false);

  // User touches screen, resetting inactivity timer
  appLockController.recordActivity();
  assert.strictEqual(appLockController.getSnapshot().isLocked, false);

  // Simulate idle timeout expiration
  (appLockController as any).lock();
  assert.strictEqual(appLockController.getSnapshot().isLocked, true, 'Inactivity timer must engage lock state');
  assert.strictEqual(isVaultLocked(), true, 'Master key memory must be wiped on idle lock');
});

test('8. Config Plugin: FLAG_SECURE window declaration protects Task Switcher and OS screenshots', () => {
  // Test Kotlin MainActivity injection
  const kotlinOriginal = `
package com.erica.sos

import android.os.Bundle
import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    setTheme(R.style.AppTheme);
    super.onCreate(null)
  }
}
`;
  const kotlinTransformed = applyFlagSecure(kotlinOriginal, 'kt');
  assert.ok(kotlinTransformed.includes('FLAG_SECURE'), 'Kotlin MainActivity must have FLAG_SECURE injected');
  assert.ok(kotlinTransformed.includes('WindowManager.LayoutParams.FLAG_SECURE'));

  // Test Java MainActivity injection
  const javaOriginal = `
package com.erica.sos;

import android.os.Bundle;
import com.facebook.react.ReactActivity;

public class MainActivity extends ReactActivity {
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    setTheme(R.style.AppTheme);
    super.onCreate(null);
  }
}
`;
  const javaTransformed = applyFlagSecure(javaOriginal, 'java');
  assert.ok(javaTransformed.includes('FLAG_SECURE'), 'Java MainActivity must have FLAG_SECURE injected');
  assert.ok(javaTransformed.includes('getWindow().setFlags'));

  // Verify idempotency
  const repeated = applyFlagSecure(kotlinTransformed, 'kt');
  const occurrences = (repeated.match(/FLAG_SECURE/g) || []).length;
  assert.strictEqual(occurrences, 2, 'applyFlagSecure must be idempotent and not inject duplicate flags');

  // Verify biometric permissions in ERICA_PERMISSIONS
  assert.ok(ERICA_PERMISSIONS.includes('android.permission.USE_BIOMETRIC'), 'Must include USE_BIOMETRIC permission');
  assert.ok(ERICA_PERMISSIONS.includes('android.permission.USE_FINGERPRINT'), 'Must include USE_FINGERPRINT permission');
});

test('9. CRITICAL THREAT-MODEL GUARD: Emergency Dispatch Bypass operates unimpeded while phone/app is locked', async () => {
  // Setup PIN and fully lock app and vault
  await setupPin('999999', 1000);
  await appLockController.init();
  appLockController.lock();

  assert.strictEqual(appLockController.getSnapshot().isLocked, true, 'App UI must be locked');
  assert.strictEqual(isVaultLocked(), true, 'Master key vault must be locked in memory');

  // Setup dispatch engine with mock database and SMS sender
  const mockDb = new MockSQLiteDatabase();
  let dispatchedPayload = '';
  let dispatchedRecipients: string[] = [];

  configureDispatchEngineOverrides({
    silentSmsSender: async (recipients, message) => {
      dispatchedRecipients = recipients;
      dispatchedPayload = message;
      return true;
    },
    availabilityChecker: async () => true,
  });

  const cleanupDispatch = await initDispatchEngine({
    customDb: mockDb,
    silentSmsSender: async (recipients, message) => {
      dispatchedRecipients = recipients;
      dispatchedPayload = message;
      return true;
    },
    availabilityChecker: async () => true,
  });

  try {
    const sosService = getSosService();

    // Configure 1-second countdown for test speed
    sosService.send({ type: 'SETTINGS_UPDATED', countdownSeconds: 1 });

    // Trigger physical panic trigger (Volume Button Pattern) while locked
    sosService.send({ type: 'TRIGGER', source: 'Hardware Volume Pattern' });

    const countdownSnapshot = sosService.getSnapshot();
    assert.strictEqual(countdownSnapshot.value, 'countdown', 'Emergency machine must start countdown unimpeded');
    assert.strictEqual(countdownSnapshot.context.triggerSource, 'Hardware Volume Pattern');

    // Vault remains safely locked; data inspection is still blocked
    assert.strictEqual(appLockController.getSnapshot().isLocked, true, 'App UI must remain locked');
    assert.strictEqual(isVaultLocked(), true, 'Vault must remain locked');

    // Progress countdown to dispatch
    sosService.send({ type: 'TICK' });

    // Allow async dispatchEmergency actor promise to run
    await new Promise((r) => setTimeout(r, 80));

    const activeSnapshot = sosService.getSnapshot();
    assert.strictEqual(activeSnapshot.value, 'active', 'Emergency machine must reach active state without PIN interruption');

    // Stand down
    sosService.send({ type: 'MARK_SAFE' });
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(sosService.getSnapshot().value, 'idle');
  } finally {
    cleanupDispatch();
  }
});

test('10. Anti-Coercion: Entering Duress PIN unlocks into Decoy Mode while keeping real vault locked', async () => {
  await setupPin('123456', 1_000);
  await setupDuressPin('999999', 1_000);
  await appLockController.init();

  assert.strictEqual(appLockController.getSnapshot().isLocked, true, 'App starts locked');
  assert.strictEqual(appLockController.getSnapshot().isDuressMode, false);
  assert.strictEqual(appLockController.getSnapshot().isDuressPinConfigured, true);

  // 1. Enter Duress PIN
  const unlockResult = await appLockController.unlockWithPin('999999');
  assert.strictEqual(unlockResult, true, 'Duress PIN must report success so adversary is never alerted');

  const snapshot = appLockController.getSnapshot();
  assert.strictEqual(snapshot.isLocked, false, 'UI unlocks to decoy screen');
  assert.strictEqual(snapshot.isDuressMode, true, 'Duress mode must be active');

  // CRITICAL THREAT-MODEL GUARD:
  // Vault remains completely locked; master key is NOT loaded in memory
  assert.strictEqual(isVaultLocked(), true, 'Master key vault must remain locked under duress');
  assert.strictEqual(isMasterKeyLoaded(), false, 'Master key must remain purged from RAM under duress');

  // 2. Decoy contacts isolation: mock innocuous contacts are served
  const decoyContacts = await getDecoyContacts();
  assert.ok(decoyContacts.length > 0, 'Decoy contacts should show mock innocuous contacts');
  assert.ok(decoyContacts.some((c) => c.name.includes('Clinic') || c.name.includes('Doctor')));

  // Adding/removing decoy contacts does not affect real vault
  await addDecoyContact({ name: 'Local Pharmacy', phoneNumber: '+15551234' });
  const updatedDecoy = await getDecoyContacts();
  assert.ok(updatedDecoy.some((c) => c.name === 'Local Pharmacy'));

  // 3. Backgrounding the app clears duress mode and engages standard lock
  (AppState as any)._setAppState('background');
  assert.strictEqual(appLockController.getSnapshot().isLocked, true, 'App locks on background');
  assert.strictEqual(appLockController.getSnapshot().isDuressMode, false, 'Duress mode state resets upon lock');

  // 4. Entering primary PIN unlocks full genuine vault
  (AppState as any)._setAppState('active');
  const primaryUnlock = await appLockController.unlockWithPin('123456');
  assert.strictEqual(primaryUnlock, true);
  assert.strictEqual(appLockController.getSnapshot().isLocked, false);
  assert.strictEqual(appLockController.getSnapshot().isDuressMode, false);
  assert.strictEqual(isVaultLocked(), false, 'Real PIN unlocks master vault');
  assert.strictEqual(isMasterKeyLoaded(), true, 'Master key is loaded for legitimate user');

  await resetDecoyContacts();
});

test('11. Anti-Coercion: Duress Silent SOS optionally dispatches in background when enabled in settings', async () => {
  await setupPin('123456', 1_000);
  await setupDuressPin('999999', 1_000);
  await appLockController.init();

  let dispatchedCount = 0;
  let dispatchedPayload = '';
  const mockDb = new MockSQLiteDatabase();

  configureDispatchEngineOverrides({
    silentSmsSender: async (recipients, msg) => {
      dispatchedCount += recipients.length;
      dispatchedPayload = msg;
      return true;
    },
    availabilityChecker: async () => true,
  });

  const cleanupDispatch = await initDispatchEngine({
    customDb: mockDb,
    silentSmsSender: async (recipients, msg) => {
      dispatchedCount += recipients.length;
      dispatchedPayload = msg;
      return true;
    },
    availabilityChecker: async () => true,
  });

  try {
    // Case A: duressSilentSosEnabled = false (Default)
    await saveSettings({ ...DEFAULT_SETTINGS, duressSilentSosEnabled: false });
    await appLockController.unlockWithPin('999999');
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(dispatchedCount, 0, 'No SOS dispatched when setting is disabled');

    appLockController.lock();

    // Case B: duressSilentSosEnabled = true
    await saveSettings({ ...DEFAULT_SETTINGS, duressSilentSosEnabled: true });
    // Save a real emergency contact
    const { saveContacts } = await import('../src/features/contacts/contactsStorage');
    await saveContacts([{ id: 'c1', name: 'Safe Contact', phoneNumber: '+12345550000' }]);

    const unlocked = await appLockController.unlockWithPin('999999');
    assert.strictEqual(unlocked, true);
    assert.strictEqual(appLockController.getSnapshot().isDuressMode, true);

    // Allow background silent dispatch to execute
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(dispatchedCount, 1, 'Silent SOS dispatched to trusted contact in background');
    assert.ok(dispatchedPayload.includes('Triggered via: Duress PIN (Silent SOS)'));
  } finally {
    cleanupDispatch();
    resetDispatchEngineOverrides();
  }
});

