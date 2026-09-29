import test from 'node:test';
import assert from 'node:assert';
import { resetMockSecureStore } from './mockExpo.mjs';
import { resetMockLocalAuthentication } from './mockLocalAuthentication.mjs';
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
  await setupPin('1357', 1_000);
  await setupDuressPin('2468', 1_000);

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

    // Adversary forces victim to enter PIN; victim enters Duress PIN '2468'
    const unlockResult = await appLockController.unlockWithPin('2468');

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

    // 6. When legitimate user enters primary PIN '1357'
    (AppState as any)._setAppState('active');
    const primaryUnlock = await appLockController.unlockWithPin('1357');
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
  await setupPin('1111', 1_000);
  await setupDuressPin('9999', 1_000);
  await saveSettings({
    ...DEFAULT_SETTINGS,
    decoyContactsType: 'empty',
    duressSilentSosEnabled: false,
  });

  await appLockController.init();
  await appLockController.unlockWithPin('9999');

  const contacts = await getDecoyContacts();
  assert.deepStrictEqual(contacts, [], 'Empty decoy mode must serve empty contacts list');

  // Can add a mock contact dynamically
  await addDecoyContact({ name: 'Emergency Services', phoneNumber: '911' });
  const afterAdd = await getDecoyContacts();
  assert.strictEqual(afterAdd.length, 1);
  assert.strictEqual(afterAdd[0].name, 'Emergency Services');
});

test('3. PIN Discretion: AuthenticatePin identifies primary, duress, or invalid', async () => {
  await setupPin('4567', 1_000);
  await setupDuressPin('8901', 1_000);

  assert.deepStrictEqual(await authenticatePin('4567'), { type: 'primary' });
  assert.deepStrictEqual(await authenticatePin('8901'), { type: 'duress' });
  assert.deepStrictEqual(await authenticatePin('0000'), { type: 'invalid' });
  assert.deepStrictEqual(await authenticatePin(''), { type: 'invalid' });
});

test('4. Duress PIN Collision Invariants & Lifecycle', async () => {
  await setupPin('5555', 1_000);

  // Duress PIN cannot match primary PIN
  await assert.rejects(
    async () => setupDuressPin('5555', 1_000),
    /Duress PIN cannot be the same as your primary PIN/
  );

  await setupDuressPin('7777', 1_000);
  assert.strictEqual(await isDuressPinConfigured(), true);

  // Primary PIN cannot change to match existing Duress PIN
  await assert.rejects(
    async () => changePin('5555', '7777', 1_000),
    /Primary PIN cannot be the same as your Duress PIN/
  );

  // Changing duress PIN
  assert.strictEqual(await changeDuressPin('0000', '8888', 1_000), false);
  assert.strictEqual(await changeDuressPin('7777', '8888', 1_000), true);

  // Remove duress PIN
  await removeDuressPin();
  assert.strictEqual(await isDuressPinConfigured(), false);
  assert.strictEqual(await isPinConfigured(), true);
});
