import test from 'node:test';
import assert from 'node:assert';
import { resetMockSecureStore } from './mockExpo.mjs';
import { mockLocationState, resetMockLocation } from './mockLocation.mjs';
import AsyncStorage from './mockAsyncStorage.mjs';
import { MockSQLiteDatabase } from './mockDatabase';
import { getCurrentLocation } from '../src/features/location/locationService';
import { dispatchEmergencySms } from '../src/features/dispatch/smsDispatch';
import {
  initDispatchEngine,
  flushOutboxQueue,
  resetDispatchEngineOverrides,
  configureDispatchEngineOverrides,
} from '../src/features/dispatch/queueProcessor';
import { getQueueStats } from '../src/features/dispatch/outboxQueue';
import {
  addContact,
  saveContacts,
  CONTACTS_STORAGE_KEY,
  DecryptionFailedError,
} from '../src/features/contacts/contactsStorage';
import { appendHistoryEntry, HISTORY_STORAGE_KEY } from '../src/features/history/historyStorage';
import { encryptString, generateRandomBytes, wipeMasterKeyMemory, lockVault } from '../src/features/security';
import { getSosService, resetSosService } from '../src/features/sos/sosMachine';
import { DEFAULT_SETTINGS, saveSettings } from '../src/features/settings/settingsStorage';

const waitFor = async (predicate: () => boolean, timeoutMs = 3000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

test.beforeEach(async () => {
  resetMockSecureStore();
  resetMockLocation();
  wipeMasterKeyMemory();
  lockVault();
  await AsyncStorage.clear();
  resetDispatchEngineOverrides();
  resetSosService();
});

test('location: a GPS fix that never arrives times out and falls back to last-known', async () => {
  mockLocationState.hang = true;
  mockLocationState.lastKnown = { coords: { latitude: 1, longitude: 2, accuracy: 50 }, timestamp: 7 } as any;
  const started = Date.now();
  const loc = await getCurrentLocation(50);
  assert.ok(Date.now() - started < 1000, 'must not wait for the hung fix');
  assert.deepStrictEqual(loc, { latitude: 1, longitude: 2, accuracy: 50, timestamp: 7 });
});

test('location: missing permission returns null instead of prompting or throwing', async () => {
  mockLocationState.permission = 'denied';
  assert.strictEqual(await getCurrentLocation(50), null);
});

test('dispatch: alert is queued even when SMS is unavailable, and sent once it becomes available', async () => {
  let smsAvailable = false;
  const sent: string[] = [];
  const teardown = await initDispatchEngine({
    customDb: new MockSQLiteDatabase(),
    subscriber: () => () => {},
    availabilityChecker: async () => smsAvailable,
    silentSmsSender: async (recipients) => {
      sent.push(...recipients);
      return true;
    },
  });
  try {
    const result = await dispatchEmergencySms({
      contacts: [{ id: '1', name: 'Ana', phoneNumber: '+15550100' }],
      location: null,
      triggerSource: 'test',
    });
    assert.strictEqual(result.attempted, true);
    assert.strictEqual(result.smsAvailable, false);
    assert.strictEqual((await getQueueStats()).pending, 1, 'alert must be persisted, not dropped');

    smsAvailable = true;
    await flushOutboxQueue({ forceImmediate: true });
    assert.deepStrictEqual(sent, ['+15550100']);
  } finally {
    teardown();
  }
});

test('outbox: a payload that fails authentication is never texted and is marked FAILED', async () => {
  const sent: string[] = [];
  const db = new MockSQLiteDatabase();
  const teardown = await initDispatchEngine({
    customDb: db,
    subscriber: () => () => {},
    availabilityChecker: async () => true,
    silentSmsSender: async (_r, message) => {
      sent.push(message);
      return true;
    },
  });
  try {
    // Ciphertext produced under some other key: decrypting with the app key fails.
    const foreign = await encryptString('EMERGENCY ALERT', generateRandomBytes(32));
    await db.runAsync(
      `INSERT INTO outbox_queue (id, recipient, payload, attempts, status, nextRetryAt, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?);`,
      'bad', '+15550100', foreign, 0, 'PENDING', 0, 0
    );
    await flushOutboxQueue({ forceImmediate: true });
    assert.strictEqual(sent.length, 0, 'ciphertext must never be sent as an SMS');
    const stats = await getQueueStats();
    assert.strictEqual(stats.failed, 1, 'undecryptable row must stop being retried');
    assert.strictEqual(stats.pending, 0);
  } finally {
    teardown();
  }
});

test('contacts and history: writes over an unreadable blob are refused, never overwrite it', async () => {
  const foreignContacts = await encryptString('[{"id":"x","name":"Old","phoneNumber":"1"}]', generateRandomBytes(32));
  await AsyncStorage.setItem(CONTACTS_STORAGE_KEY, foreignContacts);
  await assert.rejects(() => addContact({ name: 'New', phoneNumber: '2' }), DecryptionFailedError);
  assert.strictEqual(await AsyncStorage.getItem(CONTACTS_STORAGE_KEY), foreignContacts);

  const foreignHistory = await encryptString('[]', generateRandomBytes(32));
  await AsyncStorage.setItem(HISTORY_STORAGE_KEY, foreignHistory);
  await assert.rejects(
    () =>
      appendHistoryEntry({ sessionId: 's', triggerSource: 't', startedAt: 1, resolvedAt: null, locationCaptured: false }),
    DecryptionFailedError
  );
  assert.strictEqual(await AsyncStorage.getItem(HISTORY_STORAGE_KEY), foreignHistory);
});

test('SOS: with SMS unavailable the machine still reaches active, queues the alert, and warns', async () => {
  const teardown = await initDispatchEngine({
    customDb: new MockSQLiteDatabase(),
    subscriber: () => () => {},
    availabilityChecker: async () => false,
  });
  try {
    await saveSettings({ ...DEFAULT_SETTINGS, countdownSeconds: 1 });
    await saveContacts([{ id: '1', name: 'Ana', phoneNumber: '+15550100' }]);
    configureDispatchEngineOverrides({ availabilityChecker: async () => false });

    const sos = getSosService();
    sos.send({ type: 'SETTINGS_UPDATED', countdownSeconds: 1 });
    sos.send({ type: 'TRIGGER', source: 'test' });
    await waitFor(() => sos.getSnapshot().matches('active'));

    assert.ok(/queued/.test(String(sos.getSnapshot().context.lastError)));
    assert.strictEqual((await getQueueStats()).pending, 1);
  } finally {
    resetSosService();
    teardown();
  }
});
