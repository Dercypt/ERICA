import test from 'node:test';
import assert from 'node:assert';
import { resetMockSecureStore } from './mockExpo.mjs';
import { resetMockLocalAuthentication, setMockBiometricState } from './mockLocalAuthentication.mjs';
import { setMockSmsAvailable, setMockSendResult, getLastSentSms, resetMockSms } from './mockSms.mjs';
import { MockSQLiteDatabase } from './mockDatabase';
import { Platform } from './mockReactNative.mjs';
import {
  setupPin,
  lockVault,
  isVaultLocked,
  isMasterKeyLoaded,
  appLockController,
  getBiometricCapabilities,
  unlockWithBiometrics,
} from '../src/features/security';
import { saveContacts, type Contact } from '../src/features/contacts/contactsStorage';
import { DEFAULT_SETTINGS, saveSettings } from '../src/features/settings/settingsStorage';
import { clearHistory } from '../src/features/history/historyStorage';
import {
  initDispatchEngine,
  configureDispatchEngineOverrides,
  resetDispatchEngineOverrides,
} from '../src/features/dispatch';
import {
  setCustomComposerSender,
  dispatchEmergencySms,
  dispatchSafeSms,
} from '../src/features/dispatch/smsDispatch';
import {
  getSosService,
  resetSosService,
} from '../src/features/sos/sosMachine';
import { stopEmergencyDeterrenceAndEvidence } from '../src/features/evidence/evidenceCoordinator';

test.beforeEach(async () => {
  // The composer fallback is the iOS companion path; Android always queues instead.
  (Platform as { OS: string }).OS = 'ios';
  resetMockSecureStore();
  resetMockLocalAuthentication();
  resetMockSms();
  setCustomComposerSender(null);
  await stopEmergencyDeterrenceAndEvidence();
  lockVault();
  resetSosService();
  await clearHistory();
  await saveSettings({
    ...DEFAULT_SETTINGS,
    appLockTimeoutSeconds: 0,
    countdownSeconds: 1, // Fast 1s countdown for tests
    volumeTriggerEnabled: false,
    shakeTriggerEnabled: false,
    biometricsEnabled: true,
  });
  appLockController.destroy();
  resetDispatchEngineOverrides();
});

test.afterEach?.(async () => {
  await stopEmergencyDeterrenceAndEvidence();
  (Platform as { OS: string }).OS = 'android';
});

test('Task 5.1: iOS Companion Check - Capability-honest detection: Silent SMS is unavailable, fallback composer is used', async () => {
  // 1. Simulate iOS environment: Silent background SMS is strictly unavailable
  configureDispatchEngineOverrides({
    silentSmsSender: async () => false,
    availabilityChecker: async () => false, // iOS platform policy blocks background programmatic SMS
  });

  const contacts: Contact[] = [
    { id: 'ios_c1', name: 'iOS Guardian', phoneNumber: '+14085550199' },
  ];
  await setupPin('123456', 1000);
  await saveContacts(contacts);

  let composerOpened = false;
  let composerRecipients: string[] = [];
  let composerMessage = '';

  setCustomComposerSender(async (recipients, message) => {
    composerOpened = true;
    composerRecipients = recipients;
    composerMessage = message;
    return { result: 'sent' };
  });

  const dispatchResult = await dispatchEmergencySms({
    contacts,
    location: {
      latitude: 37.3349,
      longitude: -122.0090,
      accuracy: 5,
      timestamp: Date.now(),
    },
    triggerSource: 'Manual Button (iOS Companion)',
  });

  assert.strictEqual(dispatchResult.attempted, true);
  assert.strictEqual(composerOpened, true, 'Native SMS composer must be opened on iOS companion');
  assert.strictEqual(composerRecipients.length, 1);
  assert.strictEqual(composerRecipients[0], '+14085550199');
  assert.ok(composerMessage.includes('EMERGENCY ALERT'));
  assert.ok(composerMessage.includes('Location: 37.33490,-122.00900 (accuracy 5m)'));
});

test('Task 5.2: iOS Companion Flow - Cancellable countdown allows user to cancel before SMS composer is invoked', async () => {
  configureDispatchEngineOverrides({
    silentSmsSender: async () => false,
    availabilityChecker: async () => false,
  });

  await setupPin('654321', 1000);
  await saveContacts([{ id: 'c1', name: 'Parent', phoneNumber: '+14085551111' }]);

  let composerCalls = 0;
  setCustomComposerSender(async () => {
    composerCalls++;
    return { result: 'sent' };
  });

  const sosService = getSosService();
  sosService.send({ type: 'SETTINGS_UPDATED', countdownSeconds: 3 });

  // User taps SOS button on iOS companion screen
  sosService.send({ type: 'TRIGGER', source: 'Manual Button' });
  assert.strictEqual(sosService.getSnapshot().value, 'countdown');
  assert.strictEqual(sosService.getSnapshot().context.secondsRemaining, 3);

  // User cancels during countdown
  sosService.send({ type: 'CANCEL' });
  assert.strictEqual(sosService.getSnapshot().value, 'idle', 'Machine must safely return to idle');
  assert.strictEqual(composerCalls, 0, 'Zero SMS composer invocations when cancelled during countdown');
});

test('Task 5.3: iOS Companion Flow - Expired countdown triggers prefilled SMS composer and safe stand-down flow', async () => {
  configureDispatchEngineOverrides({
    silentSmsSender: async () => false,
    availabilityChecker: async () => false,
  });

  await setupPin('888888', 1000);
  await saveContacts([{ id: 'c1', name: 'Trusted Partner', phoneNumber: '+14085552222' }]);

  let sentMessages: string[] = [];
  setCustomComposerSender(async (recipients, msg) => {
    sentMessages.push(msg);
    return { result: 'sent' };
  });

  const sosService = getSosService();
  sosService.send({ type: 'SETTINGS_UPDATED', countdownSeconds: 1 });

  // Engage emergency
  sosService.send({ type: 'TRIGGER', source: 'Manual Button' });
  assert.strictEqual(sosService.getSnapshot().value, 'countdown');

  // Let countdown expire
  sosService.send({ type: 'TICK' });
  await new Promise((r) => setTimeout(r, 100));

  // Verify transition to active and composer triggered
  assert.strictEqual(sosService.getSnapshot().value, 'active');
  assert.strictEqual(sentMessages.length, 1);
  assert.ok(sentMessages[0].includes('EMERGENCY ALERT'));

  // Stand down: I'M SAFE
  sosService.send({ type: 'MARK_SAFE' });
  await new Promise((r) => setTimeout(r, 80));

  assert.strictEqual(sosService.getSnapshot().value, 'idle');
  assert.strictEqual(sentMessages.length, 2);
  assert.ok(sentMessages[1].includes('EMERGENCY RESOLVED'));
});

test('Task 5.4: iOS Face ID & Biometrics Gatekeeper - Biometric authentication unlocks vault cleanly on iOS', async () => {
  setMockBiometricState({ hardware: true, enrolled: true });

  await setupPin('777999', 1000);
  await appLockController.init();
  appLockController.lock();

  assert.strictEqual(appLockController.getSnapshot().isLocked, true);
  assert.strictEqual(isVaultLocked(), true);

  // Check biometric capabilities on iOS
  const caps = await getBiometricCapabilities();
  assert.strictEqual(caps.hasHardware, true);
  assert.strictEqual(caps.isEnrolled, true);

  // Trigger Face ID biometric prompt
  const unlockResult = await appLockController.unlockWithBiometrics('Verify with Face ID to unlock E.R.I.C.A.');
  assert.strictEqual(unlockResult.success, true);

  // Verify UI unlocked and master key is accessible
  assert.strictEqual(appLockController.getSnapshot().isLocked, false);
  assert.strictEqual(isVaultLocked(), false);
  assert.strictEqual(isMasterKeyLoaded(), true);
});
