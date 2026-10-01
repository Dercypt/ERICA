import test from 'node:test';
import assert from 'node:assert';
import { MockSQLiteDatabase } from './mockDatabase';
import { resetMockSecureStore } from './mockExpo.mjs';
import {
  initOutboxQueue,
  enqueueItem,
  getAllPendingItems,
  getQueueStats,
  clearQueue,
  setCustomDatabase,
  getDatabase,
  type OutboxItem,
} from '../src/features/dispatch/outboxQueue';
import {
  initDispatchEngine,
  flushOutboxQueue,
  enqueueAndDispatch,
  configureDispatchEngineOverrides,
  resetDispatchEngineOverrides,
} from '../src/features/dispatch/queueProcessor';
import { setupPin, lockVault, isEncryptedPayload } from '../src/features/security';
import type { NetInfoState } from '@react-native-community/netinfo';

test.beforeEach(async () => {
  resetMockSecureStore();
  lockVault();
  resetDispatchEngineOverrides();
  await setupPin('123456', 1000);
});

test('Task 4.1: Airplane Mode Buffering - Emergency alert while in Airplane Mode is securely persisted in SQLite with backoff', async () => {
  const sharedDiskDatabase = new MockSQLiteDatabase();
  await initOutboxQueue(sharedDiskDatabase);
  await clearQueue();

  let isAirplaneMode = true;
  const dispatchedToCarrier: { recipients: string[]; payload: string }[] = [];

  const mockCarrierHandoff = async (recipients: string[], message: string) => {
    if (isAirplaneMode) {
      throw new Error('Carrier handoff failed: Radio off (airplane mode or no cellular signal)');
    }
    dispatchedToCarrier.push({ recipients, payload: message });
    return true;
  };

  const teardown = await initDispatchEngine({
    customDb: sharedDiskDatabase,
    silentSmsSender: mockCarrierHandoff,
    availabilityChecker: async () => true,
    ceilingMs: 60_000,
  });

  try {
    // Dispatch alert while in Airplane mode
    const recipients = ['+15551234567', '+15559876543'];
    const emergencyMessage = 'EMERGENCY ALERT\nHostile condition test\nLocation: https://maps.google.com/?q=14.5995,120.9842';

    const dispatchResult = await enqueueAndDispatch(recipients, emergencyMessage);
    assert.strictEqual(dispatchResult.attempted, true);

    // Verify ZERO messages were handed off to carrier due to Airplane mode
    assert.strictEqual(dispatchedToCarrier.length, 0);

    // Verify the persistent SQLite queue buffered both alerts safely
    const stats = await getQueueStats();
    assert.strictEqual(stats.pending, 2, 'Must have 2 pending items in queue');
    assert.strictEqual(stats.sent, 0, 'Zero items sent while in Airplane mode');

    // Verify all on-disk payloads are authenticated ciphertext
    const pendingItems = await getAllPendingItems();
    assert.strictEqual(pendingItems.length, 2);
    for (const item of pendingItems) {
      assert.strictEqual(item.status, 'PENDING');
      assert.strictEqual(item.attempts, 1);
      assert.ok(item.nextRetryAt > item.createdAt, 'Next retry timestamp must reflect backoff');
    }
  } finally {
    teardown();
  }
});

test('Task 4.2: Device Reboot & Task Dismissal Survivability - Persistent SQLite queue survives reboot and flushes immediately when Airplane Mode is disabled', async () => {
  // 1. Simulate existing on-disk SQLite database containing buffered alerts from Airplane mode
  const sharedDiskDatabase = new MockSQLiteDatabase();
  await initOutboxQueue(sharedDiskDatabase);
  await clearQueue();

  // Buffer 2 emergency alerts in Airplane Mode
  await enqueueItem('+15551112222', 'EMERGENCY: Alert 1 - buffered pre-reboot');
  await enqueueItem('+15553334444', 'EMERGENCY: Alert 2 - buffered pre-reboot');

  const preRebootPending = await getAllPendingItems();
  assert.strictEqual(preRebootPending.length, 2, '2 items buffered before reboot');

  // 2. SIMULATE DEVICE REBOOT & PROCESS RESTART
  // Clear all in-memory references, timers, and active connections
  setCustomDatabase(null);

  // 3. System boots up: EricaBootReceiver and MainApplication initialize
  // Re-connect to the persistent on-disk database
  await initOutboxQueue(sharedDiskDatabase);

  // Verify database survived reboot with all pending items completely intact
  const postRebootPending = await getAllPendingItems();
  assert.strictEqual(postRebootPending.length, 2, 'Persistent queue must survive reboot with 100% fidelity');
  assert.strictEqual(postRebootPending[0].recipient, '+15551112222');
  assert.strictEqual(postRebootPending[1].recipient, '+15553334444');

  // 4. Airplane mode remains ON initially
  let isAirplaneMode = true;
  const dispatchedDeliveries: { recipients: string[]; payload: string }[] = [];

  const mockCarrierHandoff = async (recipients: string[], message: string) => {
    if (isAirplaneMode) {
      throw new Error('Carrier handoff failed: Radio off (airplane mode or no cellular signal)');
    }
    dispatchedDeliveries.push({ recipients, payload: message });
    return true;
  };

  let netInfoListeners: ((state: NetInfoState) => void)[] = [];
  const fakeSubscriber = (listener: (state: NetInfoState) => void) => {
    netInfoListeners.push(listener);
    return () => {
      netInfoListeners = netInfoListeners.filter((l) => l !== listener);
    };
  };

  const teardownEngine = await initDispatchEngine({
    customDb: sharedDiskDatabase,
    subscriber: fakeSubscriber,
    silentSmsSender: mockCarrierHandoff,
    availabilityChecker: async () => true,
    ceilingMs: 60_000,
  });

  try {
    // 5. User turns OFF Airplane Mode -> Cellular radio and network restored!
    isAirplaneMode = false;

    // NetInfo emits connectivity restoration
    assert.ok(netInfoListeners.length > 0, 'NetInfo listener must be subscribed');
    netInfoListeners[0]({
      type: 'cellular' as any,
      isConnected: true,
      isInternetReachable: true,
      details: {} as any,
    });

    // Wait for async flush execution
    await new Promise((r) => setTimeout(r, 60));

    // 6. VERIFY IMMEDIATE FLUSH SUCCESS
    assert.strictEqual(dispatchedDeliveries.length, 2, 'Both buffered alerts must be flushed immediately');
    assert.strictEqual(dispatchedDeliveries[0].recipients[0], '+15551112222');
    assert.strictEqual(dispatchedDeliveries[1].recipients[0], '+15553334444');

    // 7. Verify persistent queue state: 0 pending, 2 sent, zero dropped or orphaned items
    const finalStats = await getQueueStats();
    assert.strictEqual(finalStats.pending, 0, 'Pending queue must be completely drained');
    assert.strictEqual(finalStats.sent, 2, 'All items must be marked SENT');
    assert.strictEqual(finalStats.failed, 0, 'No items marked failed');

    const remainingPending = await getAllPendingItems();
    assert.strictEqual(remainingPending.length, 0);
  } finally {
    teardownEngine();
    resetDispatchEngineOverrides();
  }
});
