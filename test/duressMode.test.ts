import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { resetMockSecureStore } from './mockExpo.mjs';
import {
  setMockBiometricState,
  resetMockLocalAuthentication,
} from './mockLocalAuthentication.mjs';
import { AppState } from './mockReactNative.mjs';
import { MockSQLiteDatabase } from './mockDatabase';
import {
  setupPin,
  setupDuressPin,
  changePin,
  changeDuressPin,
  removeDuressPin,
  isPinConfigured,
  isDuressPinConfigured,
  lockVault,
  isVaultLocked,
  isMasterKeyLoaded,
  getActiveMasterKey,
  appLockController,
  authenticatePin,
  authenticateWithBiometrics,
  unlockWithBiometrics,
  isDuressModeActive,
} from '../src/features/security';
import {
  getContacts,
  saveContacts,
  addContact,
  getDecoyContacts,
  addDecoyContact,
  removeDecoyContact,
  resetDecoyContacts,
} from '../src/features/contacts';
import {
  getHistory,
  clearHistory,
} from '../src/features/history';
import {
  DEFAULT_SETTINGS,
  saveSettings,
  getSettings,
} from '../src/features/settings';
import {
  initDispatchEngine,
  configureDispatchEngineOverrides,
  resetDispatchEngineOverrides,
} from '../src/features/dispatch';

test.beforeEach(async () => {
  resetMockSecureStore();
  resetMockLocalAuthentication();
  (AppState as any)._reset();
  lockVault();
  await clearHistory();
  await resetDecoyContacts();
  await saveSettings({
    ...DEFAULT_SETTINGS,
    appLockTimeoutSeconds: 0,
    duressSilentSosEnabled: false,
    decoyContactsType: 'mock',
  });
  appLockController.destroy();
  resetDispatchEngineOverrides();
});

test('1. Duress Mode Anti-Coercion: Decoy screen, real vault isolation, and stealth silent SOS', async () => {
  // Setup primary and duress PINs
  await setupPin('135790', 1_000);
  await setupDuressPin('246810', 1_000);

  // Setup real trusted contact
  await saveContacts([{ id: 'real-1', name: 'Sister Sarah', phoneNumber: '+14155552671' }]);

  // Configure stealth silent SOS on duress
  await saveSettings({
    ...DEFAULT_SETTINGS,
    duressSilentSosEnabled: true,
    decoyContactsType: 'mock',
  });

  // Track dispatched SMS
  let sentCount = 0;
  let sentPayload = '';
  let sentRecipients: string[] = [];
  const mockDb = new MockSQLiteDatabase();

  configureDispatchEngineOverrides({
    silentSmsSender: async (recipients, msg) => {
      sentCount += recipients.length;
      sentRecipients = recipients;
      sentPayload = msg;
      return true;
    },
    availabilityChecker: async () => true,
  });

  const cleanupDispatch = await initDispatchEngine({
    customDb: mockDb,
    silentSmsSender: async (recipients, msg) => {
      sentCount += recipients.length;
      sentRecipients = recipients;
      sentPayload = msg;
      return true;
    },
    availabilityChecker: async () => true,
  });

  try {
    // App launches locked
    await appLockController.init();
    assert.strictEqual(appLockController.getSnapshot().isLocked, true);
    assert.strictEqual(appLockController.getSnapshot().isDuressMode, false);
    assert.strictEqual(isVaultLocked(), true);

    // Adversary forces victim to enter PIN; victim enters Duress PIN '246810'
    const unlockResult = await appLockController.unlockWithPin('246810');

    // 1. Never alert adversary: returns true, no error shown
    assert.strictEqual(unlockResult, true, 'Duress PIN entry must succeed to avoid alerting adversary');

    const duressSnapshot = appLockController.getSnapshot();
    assert.strictEqual(duressSnapshot.isLocked, false);
    assert.strictEqual(duressSnapshot.isDuressMode, true);

    // 2. Strict Vault Isolation: Real master key remains purged and locked
    assert.strictEqual(isVaultLocked(), true, 'Master vault must remain locked');
    assert.strictEqual(isMasterKeyLoaded(), false, 'Unencrypted master key must not be loaded in memory');
    assert.throws(() => getActiveMasterKey(), /locked or not loaded/);

    // 3. Benign Decoy Contacts: Shows mock innocuous contacts
    const decoyContacts = await getDecoyContacts();
    assert.ok(decoyContacts.length >= 2);
    assert.ok(decoyContacts.every((c) => c.name !== 'Sister Sarah'), 'Real contacts must NEVER leak to decoy');
    assert.ok(decoyContacts.some((c) => c.name.includes('Clinic') || c.name.includes('Doctor')));

    // Adversary demands adding their number to trusted contacts
    await addDecoyContact({ name: 'Coercer Phone', phoneNumber: '+19990001111' });
    const updatedDecoys = await getDecoyContacts();
    assert.ok(updatedDecoys.some((c) => c.name === 'Coercer Phone'));

    // Wait for async background stealth SOS dispatch
    await new Promise((r) => setTimeout(r, 80));

    // 4. Stealth Silent SOS: dispatched to real contact in background
    assert.strictEqual(sentCount, 1);
    assert.deepStrictEqual(sentRecipients, ['+14155552671']);
    assert.ok(sentPayload.includes('Triggered via: Duress PIN (Silent SOS)'));

    // Encrypted history logged
    const history = await getHistory();
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].triggerSource, 'Duress PIN (Silent SOS)');

    // 5. Backgrounding app locks out and resets duress mode
    (AppState as any)._setAppState('background');
    assert.strictEqual(appLockController.getSnapshot().isLocked, true);
    assert.strictEqual(appLockController.getSnapshot().isDuressMode, false);

    // 6. When legitimate user enters primary PIN '135790'
    (AppState as any)._setAppState('active');
    const primaryUnlock = await appLockController.unlockWithPin('135790');
    assert.strictEqual(primaryUnlock, true);
    assert.strictEqual(appLockController.getSnapshot().isLocked, false);
    assert.strictEqual(appLockController.getSnapshot().isDuressMode, false);
    assert.strictEqual(isVaultLocked(), false, 'Genuine PIN unlocks real vault');
    assert.strictEqual(isMasterKeyLoaded(), true);

    const realContacts = await getContacts();
    assert.strictEqual(realContacts.length, 1);
    assert.strictEqual(realContacts[0].name, 'Sister Sarah');
    assert.ok(!realContacts.some((c) => c.name === 'Coercer Phone'), 'Coercer phone in decoy must not contaminate real contacts');
  } finally {
    cleanupDispatch();
  }
});

test('2. Decoy Screen Modes: Empty contacts display option', async () => {
  await setupPin('111111', 1_000);
  await setupDuressPin('999999', 1_000);
  await saveSettings({
    ...DEFAULT_SETTINGS,
    decoyContactsType: 'empty',
    duressSilentSosEnabled: false,
  });

  await appLockController.init();
  await appLockController.unlockWithPin('999999');

  const contacts = await getDecoyContacts();
  assert.deepStrictEqual(contacts, [], 'Empty decoy mode must serve empty contacts list');

  // Can add a mock contact dynamically
  await addDecoyContact({ name: 'Emergency Services', phoneNumber: '911' });
  const afterAdd = await getDecoyContacts();
  assert.strictEqual(afterAdd.length, 1);
  assert.strictEqual(afterAdd[0].name, 'Emergency Services');
});

test('3. PIN Discretion: AuthenticatePin identifies primary, duress, or invalid', async () => {
  await setupPin('456789', 1_000);
  await setupDuressPin('890123', 1_000);

  assert.deepStrictEqual(await authenticatePin('456789'), { type: 'primary' });
  assert.deepStrictEqual(await authenticatePin('890123'), { type: 'duress' });
  assert.deepStrictEqual(await authenticatePin('000000'), { type: 'invalid' });
  assert.deepStrictEqual(await authenticatePin(''), { type: 'invalid' });
});

test('4. Duress PIN Collision Invariants & Lifecycle', async () => {
  await setupPin('555555', 1_000);

  // Duress PIN cannot match primary PIN
  await assert.rejects(
    async () => setupDuressPin('555555', 1_000),
    /Duress PIN cannot be the same as your primary PIN/
  );

  await setupDuressPin('777777', 1_000);
  assert.strictEqual(await isDuressPinConfigured(), true);

  // Primary PIN cannot change to match existing Duress PIN
  await assert.rejects(
    async () => changePin('555555', '777777', 1_000),
    /Primary PIN cannot be the same as your Duress PIN/
  );

  // Changing duress PIN
  assert.strictEqual(await changeDuressPin('000000', '888888', 1_000), false);
  assert.strictEqual(await changeDuressPin('777777', '888888', 1_000), true);

  // Remove duress PIN
  await removeDuressPin();
  assert.strictEqual(await isDuressPinConfigured(), false);
  assert.strictEqual(await isPinConfigured(), true);
});

test('5. Coercion Guard: Setting Duress PIN automatically disables biometrics by default in settings', async () => {
  // Initially biometrics are enabled
  await saveSettings({
    ...DEFAULT_SETTINGS,
    biometricsEnabled: true,
  });
  let settings = await getSettings();
  assert.strictEqual(settings.biometricsEnabled, true);

  await setupPin('123456', 1_000);

  // As soon as a Duress PIN is set, biometrics are automatically disabled by default
  await setupDuressPin('654321', 1_000);

  settings = await getSettings();
  assert.strictEqual(
    settings.biometricsEnabled,
    false,
    'Setting a Duress PIN must automatically disable biometrics by default (Coercion Guard)'
  );

  // Verify that SettingsScreen enforces active security warning string
  const settingsScreenCode = fs.readFileSync('./src/features/settings/SettingsScreen.tsx', 'utf8');
  const requiredWarning =
    'Enabling biometrics allows an adversary to force unlock your real contacts using your face or finger, bypassing Duress Mode.';
  assert.ok(
    settingsScreenCode.includes(requiredWarning),
    'SettingsScreen must display active security warning when toggling biometrics with Duress PIN'
  );
});

test('6. Coercion Guard: Automatic biometric shutoff when Duress Mode is active prevents forced unlock', async () => {
  await setupPin('112233', 1_000);
  await setupDuressPin('445566', 1_000);

  // User explicitly opted in to biometrics despite warning
  await saveSettings({
    ...DEFAULT_SETTINGS,
    biometricsEnabled: true,
  });

  setMockBiometricState({
    hardware: true,
    enrolled: true,
    result: { success: true },
  });

  await appLockController.init();
  assert.strictEqual(appLockController.getSnapshot().isLocked, true);
  assert.strictEqual(appLockController.getSnapshot().isDuressMode, false);

  // Victim is coerced and unlocks into Duress Mode with Duress PIN
  const duressUnlock = await appLockController.unlockWithPin('445566');
  assert.strictEqual(duressUnlock, true);
  assert.strictEqual(appLockController.getSnapshot().isDuressMode, true);
  assert.strictEqual(isDuressModeActive(), true);

  // Coercion Threat Model:
  // Adversary tries to force victim to unlock with Face ID / Fingerprint while in Duress Mode
  // Biometrics must be AUTOMATICALLY SHUT OFF:
  const directBiometricResult = await authenticateWithBiometrics();
  assert.strictEqual(directBiometricResult.success, false);
  assert.strictEqual(directBiometricResult.error, 'DURESS_ACTIVE');

  const controllerBiometricResult = await appLockController.unlockWithBiometrics();
  assert.strictEqual(controllerBiometricResult.success, false);
  assert.strictEqual(controllerBiometricResult.error, 'DURESS_ACTIVE');

  // Snapshot indicates biometrics unavailable during duress mode
  assert.strictEqual(
    appLockController.getSnapshot().isBiometricsAvailable,
    false,
    'Biometrics must be unavailable in AppLock snapshot while Duress Mode is active'
  );

  // Real vault remains strictly locked
  assert.strictEqual(isVaultLocked(), true, 'Real vault must remain strictly locked');
  assert.strictEqual(isMasterKeyLoaded(), false, 'Master key must remain purged');
});

