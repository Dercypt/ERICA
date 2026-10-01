import test from 'node:test';
import assert from 'node:assert';
import { resetMockSecureStore } from './mockExpo.mjs';
import { resetMockLocalAuthentication } from './mockLocalAuthentication.mjs';
import { AppState } from './mockReactNative.mjs';
import { MockSQLiteDatabase } from './mockDatabase';
import {
  setupPin,
  lockVault,
  isVaultLocked,
  isMasterKeyLoaded,
  getActiveMasterKey,
  appLockController,
  saveSecureItem,
  getSecureItem,
} from '../src/features/security';
import {
  saveContacts,
  getContacts,
  type Contact,
} from '../src/features/contacts/contactsStorage';
import {
  getHistory,
  clearHistory,
} from '../src/features/history/historyStorage';
import {
  DEFAULT_SETTINGS,
  saveSettings,
} from '../src/features/settings/settingsStorage';
import {
  initDispatchEngine,
  configureDispatchEngineOverrides,
  resetDispatchEngineOverrides,
  getOutboxItems,
} from '../src/features/dispatch';
import {
  getSosService,
  resetSosService,
  sosMachine,
} from '../src/features/sos/sosMachine';
import {
  notifyPanicTrigger,
  addPanicTriggerListener,
  resetPhysicalTriggersOverrides,
} from '../modules/physical-triggers';

function setupPhysicalPanicBridge(): () => void {
  const sub = addPanicTriggerListener((event) => {
    // Exact production listener from App.tsx:
    // If a user triggers SOS via hardware volume buttons or shake while the phone is locked,
    // the background dispatch queue and SMS sending proceed unimpeded without prompting for a PIN.
    getSosService().send({ type: 'TRIGGER', source: event?.source });
  });
  return () => sub.remove();
}

test.beforeEach(async () => {
  resetMockSecureStore();
  resetMockLocalAuthentication();
  (AppState as any)._reset();
  lockVault();
  resetSosService();
  await clearHistory();
  await saveSettings({
    ...DEFAULT_SETTINGS,
    appLockTimeoutSeconds: 0,
    countdownSeconds: 1, // Fast 1s countdown for tests
    volumeTriggerEnabled: true,
    shakeTriggerEnabled: true,
  });
  appLockController.destroy();
  resetDispatchEngineOverrides();
  resetPhysicalTriggersOverrides();
});

test('Task 3.1: Full Emergency Panic Integration: Hardware Volume Button trigger fires while app UI is locked, completing background dispatch without PIN intervention', async () => {
  // 1. Setup primary PIN and trusted contacts
  await setupPin('513792', 1000);
  const trustedContacts: Contact[] = [
    { id: 'contact_1', name: 'Guardian Alice', phoneNumber: '+15559876543' },
    { id: 'contact_2', name: 'Responder Bob', phoneNumber: '+15551234567' },
  ];
  await saveContacts(trustedContacts);

  // 2. Lock app UI and lock vault memory
  await appLockController.init();
  appLockController.lock();

  assert.strictEqual(appLockController.getSnapshot().isLocked, true, 'App UI must be strictly locked');
  assert.strictEqual(isVaultLocked(), true, 'Security vault must be locked');
  assert.strictEqual(isMasterKeyLoaded(), false, 'Master key must be purged from memory');
  assert.throws(() => getActiveMasterKey(), /Master key is locked/);

  // 3. Track SMS dispatch & background database
  let sentPayload = '';
  const sentRecipients: string[] = [];
  const mockDb = new MockSQLiteDatabase();

  configureDispatchEngineOverrides({
    silentSmsSender: async (recipients, message) => {
      sentRecipients.push(...recipients);
      sentPayload = message;
      return true;
    },
    availabilityChecker: async () => true,
  });

  const cleanupDispatch = await initDispatchEngine({
    customDb: mockDb,
    silentSmsSender: async (recipients, message) => {
      sentRecipients.push(...recipients);
      sentPayload = message;
      return true;
    },
    availabilityChecker: async () => true,
  });

  const cleanupPhysical = setupPhysicalPanicBridge();

  try {
    const sosService = getSosService();
    sosService.send({ type: 'SETTINGS_UPDATED', countdownSeconds: 1 });

    // 4. Simulate emergency trigger while app UI is locked (4 volume button presses)
    notifyPanicTrigger('Volume Button Pattern');

    // 5. Verify emergency machine transitioned to countdown
    const countdownSnapshot = sosService.getSnapshot();
    assert.strictEqual(countdownSnapshot.value, 'countdown', 'Panic trigger must engage countdown immediately');
    assert.strictEqual(countdownSnapshot.context.triggerSource, 'Volume Button Pattern');

    // CRITICAL SECURITY ASSERTION: UI must remain locked; PIN intervention is NOT required
    assert.strictEqual(appLockController.getSnapshot().isLocked, true, 'App UI must remain locked during countdown');
    assert.strictEqual(isVaultLocked(), true, 'Master vault must remain locked');
    assert.strictEqual(isMasterKeyLoaded(), false, 'Master key must not be loaded in RAM during countdown');

    // 6. Complete countdown -> triggers dispatching in background
    sosService.send({ type: 'TICK' });

    // Wait for async dispatchEmergency actor to complete
    await new Promise((r) => setTimeout(r, 120));

    // 7. Verify machine reached active state
    const activeSnapshot = sosService.getSnapshot();
    assert.strictEqual(activeSnapshot.value, 'active', 'Emergency machine must reach active state');

    // 8. Verify BACKGROUND DISPATCH SUCCEEDED without PIN intervention
    assert.strictEqual(sentRecipients.length, 2, 'Must dispatch SMS to all trusted contacts');
    assert.ok(sentRecipients.includes('+15559876543'), 'Recipient 1 must receive alert');
    assert.ok(sentRecipients.includes('+15551234567'), 'Recipient 2 must receive alert');

    assert.ok(sentPayload.includes('EMERGENCY ALERT'), 'Must include emergency header');
    assert.ok(sentPayload.includes('Triggered via: Volume Button Pattern'), 'Must include trigger source');
    assert.ok(sentPayload.includes('maps.google.com'), 'Must include GPS coordinates link');

    // 9. Verify zero leaks: UI and vault memory remain locked post-dispatch
    assert.strictEqual(appLockController.getSnapshot().isLocked, true, 'UI must remain locked after dispatch');
    assert.strictEqual(isVaultLocked(), true, 'Vault remains locked');
    assert.strictEqual(isMasterKeyLoaded(), false, 'Master key must remain purged from RAM after background dispatch');
    assert.throws(() => getActiveMasterKey(), /Master key is locked/);

    // 10. Stand down: Mark Safe
    sosService.send({ type: 'MARK_SAFE' });
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(sosService.getSnapshot().value, 'idle', 'Machine returns to idle on MARK_SAFE');
    assert.strictEqual(appLockController.getSnapshot().isLocked, true, 'UI remains locked after stand down');

    // 11. Legitimate user finally enters PIN to inspect history
    const unlocked = await appLockController.unlockWithPin('513792');
    assert.strictEqual(unlocked, true, 'Legitimate user PIN must unlock UI');
    assert.strictEqual(appLockController.getSnapshot().isLocked, false);
    assert.strictEqual(isVaultLocked(), false);
    assert.strictEqual(isMasterKeyLoaded(), true);

    const history = await getHistory();
    assert.ok(history.length >= 1, 'Emergency session must be recorded in history');
    assert.strictEqual(history[0].triggerSource, 'Volume Button Pattern');
    assert.ok(history[0].resolvedAt !== null, 'Session must be marked resolved');
  } finally {
    cleanupPhysical();
    cleanupDispatch();
  }
});

test('Task 3.2: Shake Sensor Panic Trigger while Locked: High-pass jerk trigger dispatches in background with zero leaks', async () => {
  await setupPin('992211', 1000);
  await saveContacts([{ id: 'c1', name: 'Emergency Contact', phoneNumber: '+18005550199' }]);

  await appLockController.init();
  appLockController.lock();

  assert.strictEqual(appLockController.getSnapshot().isLocked, true);
  assert.strictEqual(isVaultLocked(), true);

  let sentRecipients: string[] = [];
  let sentPayload = '';
  const mockDb = new MockSQLiteDatabase();

  configureDispatchEngineOverrides({
    silentSmsSender: async (recipients, msg) => {
      sentRecipients = recipients;
      sentPayload = msg;
      return true;
    },
    availabilityChecker: async () => true,
  });

  const cleanupDispatch = await initDispatchEngine({
    customDb: mockDb,
    silentSmsSender: async (recipients, msg) => {
      sentRecipients = recipients;
      sentPayload = msg;
      return true;
    },
    availabilityChecker: async () => true,
  });

  const cleanupPhysical = setupPhysicalPanicBridge();

  try {
    const sosService = getSosService();
    sosService.send({ type: 'SETTINGS_UPDATED', countdownSeconds: 1 });

    // Vigorous shake trigger event received while locked
    notifyPanicTrigger('Shake Detector');

    assert.strictEqual(sosService.getSnapshot().value, 'countdown');
    assert.strictEqual(sosService.getSnapshot().context.triggerSource, 'Shake Detector');
    assert.strictEqual(appLockController.getSnapshot().isLocked, true, 'UI remains locked during shake emergency');

    // Progress countdown
    sosService.send({ type: 'TICK' });
    await new Promise((r) => setTimeout(r, 120));

    assert.strictEqual(sosService.getSnapshot().value, 'active');
    assert.strictEqual(sentRecipients.length, 1);
    assert.strictEqual(sentRecipients[0], '+18005550199');
    assert.ok(sentPayload.includes('Triggered via: Shake Detector'));

    // Zero leaks
    assert.strictEqual(appLockController.getSnapshot().isLocked, true);
    assert.strictEqual(isVaultLocked(), true);
    assert.strictEqual(isMasterKeyLoaded(), false);

    sosService.send({ type: 'MARK_SAFE' });
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(sosService.getSnapshot().value, 'idle');
  } finally {
    cleanupPhysical();
    cleanupDispatch();
  }
});

test('Task 3.3: Adversary Interruption Resistance: Entering invalid PINs during emergency countdown or dispatch does NOT cancel or leak dispatch', async () => {
  await setupPin('333333', 1000);
  await saveContacts([{ id: 'c1', name: 'Trusted Guardian', phoneNumber: '+15557778888' }]);

  await appLockController.init();
  appLockController.lock();

  let sentRecipients: string[] = [];
  const mockDb = new MockSQLiteDatabase();

  configureDispatchEngineOverrides({
    silentSmsSender: async (recipients) => {
      sentRecipients = recipients;
      return true;
    },
    availabilityChecker: async () => true,
  });

  const cleanupDispatch = await initDispatchEngine({
    customDb: mockDb,
    silentSmsSender: async (recipients) => {
      sentRecipients = recipients;
      return true;
    },
    availabilityChecker: async () => true,
  });

  const cleanupPhysical = setupPhysicalPanicBridge();

  try {
    const sosService = getSosService();
    sosService.send({ type: 'SETTINGS_UPDATED', countdownSeconds: 2 });

    // Panic triggered while phone is locked
    notifyPanicTrigger('Volume Button Pattern');
    assert.strictEqual(sosService.getSnapshot().value, 'countdown');

    // Adversary attempts to guess PIN on lock screen to abort/compromise app
    const adversaryAttempts = ['000000', '123456', '999999'];
    for (const guess of adversaryAttempts) {
      const res = await appLockController.unlockWithPin(guess);
      assert.strictEqual(res, false, 'Adversary guess must be rejected');
      assert.strictEqual(appLockController.getSnapshot().isLocked, true, 'UI must remain locked');
    }

    // Emergency countdown continues unimpeded despite adversary input
    assert.strictEqual(sosService.getSnapshot().value, 'countdown', 'Emergency countdown must not be disrupted by adversary input');

    // Complete countdown
    sosService.send({ type: 'TICK' });
    sosService.send({ type: 'TICK' });
    await new Promise((r) => setTimeout(r, 120));

    // Background dispatch succeeds despite adversary interaction
    assert.strictEqual(sosService.getSnapshot().value, 'active');
    assert.strictEqual(sentRecipients.length, 1);
    assert.strictEqual(sentRecipients[0], '+15557778888');

    // Vault remains locked with zero leaks
    assert.strictEqual(isVaultLocked(), true);
    assert.strictEqual(isMasterKeyLoaded(), false);

    sosService.send({ type: 'MARK_SAFE' });
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    cleanupPhysical();
    cleanupDispatch();
  }
});
