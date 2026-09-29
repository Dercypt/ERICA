import test from 'node:test';
import assert from 'node:assert';
import {
  calculateBackoffDelay,
  calculateNextRetryAt,
  shouldRetry,
  RetryScheduler,
} from '../src/features/dispatch/backoffScheduler';
import {
  enqueueItem,
  enqueueItems,
  getDueItems,
  getAllPendingItems,
  markInFlight,
  markSent,
  markRetry,
  getQueueStats,
  initOutboxQueue,
  clearQueue,
} from '../src/features/dispatch/outboxQueue';
import {
  setupConnectivityListener,
  isCellularConnected,
} from '../src/features/dispatch/connectivityListener';
import {
  flushOutboxQueue,
  enqueueAndDispatch,
  initDispatchEngine,
  configureDispatchEngineOverrides,
  resetDispatchEngineOverrides,
} from '../src/features/dispatch/queueProcessor';
import { triggerDuressSilentSos } from '../src/features/dispatch/duressDispatch';
import { saveContacts } from '../src/features/contacts/contactsStorage';
import { getHistory, clearHistory } from '../src/features/history/historyStorage';
import { resetMockSecureStore } from './mockExpo.mjs';
import { MockSQLiteDatabase } from './mockDatabase';
import type { NetInfoState } from '@react-native-community/netinfo';

test('1. Exponential Backoff Scheduler - 5s, 15s, 30s, 60s and configurable ceiling', () => {
  // Test default step delays (5s, 15s, 30s, 60s)
  assert.strictEqual(calculateBackoffDelay(0), 0);
  assert.strictEqual(calculateBackoffDelay(1), 5_000);  // 5s
  assert.strictEqual(calculateBackoffDelay(2), 15_000); // 15s
  assert.strictEqual(calculateBackoffDelay(3), 30_000); // 30s
  assert.strictEqual(calculateBackoffDelay(4), 60_000); // 60s

  // Attempt 5+ capped at ceiling (default 60s)
  assert.strictEqual(calculateBackoffDelay(5), 60_000);
  assert.strictEqual(calculateBackoffDelay(10), 60_000);

  // Configurable ceiling: 120s
  assert.strictEqual(calculateBackoffDelay(4, { ceilingMs: 120_000 }), 60_000);
  assert.strictEqual(calculateBackoffDelay(5, { ceilingMs: 120_000 }), 120_000);
  assert.strictEqual(calculateBackoffDelay(6, { ceilingMs: 120_000 }), 120_000);

  // Configurable ceiling: 20s
  assert.strictEqual(calculateBackoffDelay(2, { ceilingMs: 20_000 }), 15_000);
  assert.strictEqual(calculateBackoffDelay(3, { ceilingMs: 20_000 }), 20_000);
  assert.strictEqual(calculateBackoffDelay(4, { ceilingMs: 20_000 }), 20_000);

  // Does NOT give up after 3 static tries (shouldRetry continues)
  assert.strictEqual(shouldRetry(1), true);
  assert.strictEqual(shouldRetry(2), true);
  assert.strictEqual(shouldRetry(3), true);
  assert.strictEqual(shouldRetry(4), true);
  assert.strictEqual(shouldRetry(10), true);

  // Optional custom maxAttempts ceiling
  assert.strictEqual(shouldRetry(5, { maxAttempts: 5 }), false);

  // Calculate next retry timestamp
  const now = 1_000_000;
  assert.strictEqual(calculateNextRetryAt(1, now), 1_005_000);
  assert.strictEqual(calculateNextRetryAt(2, now), 1_015_000);
});

test('2. RetryScheduler - timer management and cancellation', async () => {
  const scheduler = new RetryScheduler();
  let fired = false;

  scheduler.schedule(Date.now() + 10, () => {
    fired = true;
  });

  assert.strictEqual(scheduler.isScheduled(), true);
  await new Promise((r) => setTimeout(r, 25));
  assert.strictEqual(fired, true);
  assert.strictEqual(scheduler.isScheduled(), false);

  // Cancel test
  fired = false;
  scheduler.schedule(Date.now() + 50, () => {
    fired = true;
  });
  scheduler.cancel();
  assert.strictEqual(scheduler.isScheduled(), false);
  await new Promise((r) => setTimeout(r, 60));
  assert.strictEqual(fired, false);
});

test('3. Persistent Local Queue - SQLite Schema, Fields, and Lifecycle', async () => {
  const mockDb = new MockSQLiteDatabase();
  await initOutboxQueue(mockDb);
  await clearQueue();

  // Enqueue item with required fields: id, recipient, payload, attempts, status, nextRetryAt, createdAt
  const item = await enqueueItem('+15551234567', 'EMERGENCY: Test payload');
  assert.ok(item.id.startsWith('msg_'));
  assert.strictEqual(item.recipient, '+15551234567');
  assert.strictEqual(item.payload, 'EMERGENCY: Test payload');
  assert.strictEqual(item.attempts, 0);
  assert.strictEqual(item.status, 'PENDING');
  assert.ok(item.nextRetryAt > 0);
  assert.ok(item.createdAt > 0);

  // Check stats
  let stats = await getQueueStats();
  assert.strictEqual(stats.pending, 1);
  assert.strictEqual(stats.total, 1);

  // Transition to IN_FLIGHT
  await markInFlight([item.id]);
  stats = await getQueueStats();
  assert.strictEqual(stats.inFlight, 1);
  assert.strictEqual(stats.pending, 0);

  // Mark SENT
  await markSent(item.id);
  stats = await getQueueStats();
  assert.strictEqual(stats.sent, 1);
  assert.strictEqual(stats.inFlight, 0);

  // Mark Retry on another item
  const item2 = await enqueueItem('+15559876543', 'Alert 2');
  await markInFlight([item2.id]);
  await markRetry(item2.id, 1, Date.now() + 5000);

  const pendingItems = await getAllPendingItems();
  assert.strictEqual(pendingItems.length, 1);
  assert.strictEqual(pendingItems[0].id, item2.id);
  assert.strictEqual(pendingItems[0].attempts, 1);
  assert.strictEqual(pendingItems[0].status, 'PENDING');

  // Crash recovery test: leftover IN_FLIGHT items reset to PENDING upon init
  mockDb.rows.get(item2.id)!.status = 'IN_FLIGHT';
  assert.strictEqual(mockDb.rows.get(item2.id)!.status, 'IN_FLIGHT');

  await initOutboxQueue(mockDb); // simulates app boot
  const recovered = mockDb.rows.get(item2.id);
  assert.strictEqual(recovered!.status, 'PENDING');
});

test('4. Connectivity Listener - triggers immediate flush when cellular signal returns', () => {
  let listeners: ((state: NetInfoState) => void)[] = [];
  const fakeSubscriber = (listener: (state: NetInfoState) => void) => {
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  };

  let cellularRestoredCount = 0;
  const unsubscribe = setupConnectivityListener({
    subscriber: fakeSubscriber,
    onCellularRestored: () => {
      cellularRestoredCount++;
    },
  });

  // 1. Initial state: Wifi connected (not cellular)
  listeners[0]({
    type: 'wifi' as any,
    isConnected: true,
    isInternetReachable: true,
    details: {} as any,
  });
  assert.strictEqual(cellularRestoredCount, 0);

  // 2. Dead zone: completely offline (no signal)
  listeners[0]({
    type: 'none' as any,
    isConnected: false,
    isInternetReachable: false,
    details: null as any,
  });
  assert.strictEqual(cellularRestoredCount, 0);

  // 3. Cellular signal returns!
  listeners[0]({
    type: 'cellular' as any,
    isConnected: true,
    isInternetReachable: true,
    details: {} as any,
  });
  assert.strictEqual(cellularRestoredCount, 1);

  // 4. Cell tower handover: brief cellular drop
  listeners[0]({
    type: 'none' as any,
    isConnected: false,
    isInternetReachable: false,
    details: null as any,
  });
  assert.strictEqual(cellularRestoredCount, 1);

  // 5. Cellular reconnects after tower handover!
  listeners[0]({
    type: 'cellular' as any,
    isConnected: true,
    isInternetReachable: true,
    details: {} as any,
  });
  assert.strictEqual(cellularRestoredCount, 2);

  // Teardown
  unsubscribe();
  assert.strictEqual(listeners.length, 0);
});

test('5. End-to-End: Dead Zone Queue Persistence & Instant Flush on Cellular Restoration', async () => {
  const mockDb = new MockSQLiteDatabase();
  await initOutboxQueue(mockDb);
  await clearQueue();

  let listeners: ((state: NetInfoState) => void)[] = [];
  const fakeSubscriber = (listener: (state: NetInfoState) => void) => {
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  };

  let isCarrierReachable = false;
  let sentDeliveries: { recipients: string[]; message: string }[] = [];

  const mockSilentSms = async (recipients: string[], message: string) => {
    if (!isCarrierReachable) {
      throw new Error('Carrier handoff failed: Radio off / No cellular service');
    }
    sentDeliveries.push({ recipients, message });
    return true;
  };

  const teardownEngine = await initDispatchEngine({
    customDb: mockDb,
    subscriber: fakeSubscriber,
    silentSmsSender: mockSilentSms,
    availabilityChecker: async () => true,
    ceilingMs: 60_000,
  });

  // User hits SOS while in a dead zone (isCarrierReachable = false)
  const alertResult = await enqueueAndDispatch(
    ['+1234567890', '+1987654321'],
    'EMERGENCY: User trapped in elevator'
  );

  assert.strictEqual(alertResult.attempted, true);
  assert.strictEqual(sentDeliveries.length, 0); // Not sent yet due to dead zone

  // Check persistent SQLite queue: items are safely preserved with attempts=1, status=PENDING, nextRetryAt > now
  const pending = await getAllPendingItems();
  assert.strictEqual(pending.length, 2);
  for (const item of pending) {
    assert.strictEqual(item.attempts, 1);
    assert.strictEqual(item.status, 'PENDING');
    assert.ok(item.nextRetryAt > item.createdAt);
  }

  // Signal returns! Carrier becomes reachable
  isCarrierReachable = true;

  // NetInfo fires cellular restoration event
  listeners[0]({
    type: 'cellular' as any,
    isConnected: true,
    isInternetReachable: true,
    details: {} as any,
  });

  // Wait a tick for async flush execution
  await new Promise((r) => setTimeout(r, 50));

  // Both recipients were delivered directly without dropped alerts!
  assert.strictEqual(sentDeliveries.length, 2);
  assert.strictEqual(sentDeliveries[0].recipients[0], '+1234567890');
  assert.strictEqual(sentDeliveries[1].recipients[0], '+1987654321');

  // Verify database queue has 0 pending items, all marked SENT
  const pendingAfter = await getAllPendingItems();
  assert.strictEqual(pendingAfter.length, 0);

  const stats = await getQueueStats();
  assert.strictEqual(stats.sent, 2);
  assert.strictEqual(stats.pending, 0);

  teardownEngine();
  resetDispatchEngineOverrides();
});

test('9. Duress Silent SOS: Stealth background dispatch without countdown or alarms', async () => {
  resetMockSecureStore();
  await clearHistory();

  const mockDb = new MockSQLiteDatabase();
  let deliveredRecipients: string[] = [];
  let deliveredMessage: string = '';

  configureDispatchEngineOverrides({
    silentSmsSender: async (recipients, msg) => {
      deliveredRecipients = recipients;
      deliveredMessage = msg;
      return true;
    },
    availabilityChecker: async () => true,
  });

  const teardownEngine = await initDispatchEngine({
    customDb: mockDb,
    silentSmsSender: async (recipients, msg) => {
      deliveredRecipients = recipients;
      deliveredMessage = msg;
      return true;
    },
    availabilityChecker: async () => true,
  });

  try {
    // 1. When no contacts configured: returns triggered: false safely without throwing
    const noContactsResult = await triggerDuressSilentSos();
    assert.strictEqual(noContactsResult.triggered, false);
    assert.strictEqual(deliveredRecipients.length, 0);

    // 2. Setup trusted contact
    await saveContacts([
      { id: 'c1', name: 'Emergency Contact 1', phoneNumber: '+19998887777' },
    ]);

    // 3. Trigger duress silent SOS
    const successResult = await triggerDuressSilentSos();
    assert.strictEqual(successResult.triggered, true);
    assert.deepStrictEqual(successResult.recipients, ['+19998887777']);

    // Verify SMS message content
    assert.ok(deliveredMessage.includes('EMERGENCY ALERT'));
    assert.ok(deliveredMessage.includes('Triggered via: Duress PIN (Silent SOS)'));

    // Verify history entry logged
    const history = await getHistory();
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].triggerSource, 'Duress PIN (Silent SOS)');
    assert.strictEqual(history[0].resolvedAt, null);
  } finally {
    teardownEngine();
    resetDispatchEngineOverrides();
  }
});

