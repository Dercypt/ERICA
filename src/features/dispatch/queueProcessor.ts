import { sendSilentSms, isAvailableAsync } from '../../../modules/silent-sms';
import {
  enqueueItems,
  getDueItems,
  getAllPendingItems,
  markInFlight,
  markSent,
  markRetry,
  getOutboxItems,
  initOutboxQueue,
  type ISQLiteDatabase,
  type OutboxItem,
} from './outboxQueue';
import {
  calculateNextRetryAt,
  shouldRetry,
  RetryScheduler,
  DEFAULT_BACKOFF_CONFIG,
  type BackoffConfig,
} from './backoffScheduler';
import {
  setupConnectivityListener,
  type NetInfoSubscriber,
} from './connectivityListener';

export interface FlushResult {
  processed: number;
  succeeded: number;
  failed: number;
  items: OutboxItem[];
}

export interface DispatchEngineOptions {
  ceilingMs?: number;
  backoffConfig?: Partial<BackoffConfig>;
  subscriber?: NetInfoSubscriber;
  customDb?: ISQLiteDatabase;
  silentSmsSender?: (recipients: string[], message: string) => Promise<boolean>;
  availabilityChecker?: () => Promise<boolean>;
}

const retryScheduler = new RetryScheduler();
let isFlushing = false;
let configuredCeilingMs = DEFAULT_BACKOFF_CONFIG.ceilingMs;
let smsSender = sendSilentSms;
let availabilityCheck = isAvailableAsync;

/**
 * Overrides dispatch dependencies for testing or custom simulation.
 */
export function configureDispatchEngineOverrides(options: {
  silentSmsSender?: (recipients: string[], message: string) => Promise<boolean>;
  availabilityChecker?: () => Promise<boolean>;
  ceilingMs?: number;
}): void {
  if (options.silentSmsSender) smsSender = options.silentSmsSender;
  if (options.availabilityChecker) availabilityCheck = options.availabilityChecker;
  if (options.ceilingMs) configuredCeilingMs = options.ceilingMs;
}

/**
 * Checks whether telephony SMS is available (via native module or configured override).
 */
export async function isSmsAvailable(): Promise<boolean> {
  return await availabilityCheck();
}

/**
 * Resets dispatch engine overrides back to default native module bindings.
 */
export function resetDispatchEngineOverrides(): void {
  smsSender = sendSilentSms;
  availabilityCheck = isAvailableAsync;
  configuredCeilingMs = DEFAULT_BACKOFF_CONFIG.ceilingMs;
}

let queuedFlushRequest: { forceImmediate?: boolean; ceilingMs?: number } | null = null;
let currentFlushPromise: Promise<FlushResult> | null = null;

/**
 * Flushes pending items from the outbox queue.
 *
 * @param options.forceImmediate If true, ignores nextRetryAt timestamps and dispatches all pending items immediately.
 *                               Used when cellular signal returns after a dead zone.
 * @param options.ceilingMs Optional ceiling override for backoff calculations.
 */
export async function flushOutboxQueue(options?: {
  forceImmediate?: boolean;
  ceilingMs?: number;
}): Promise<FlushResult> {
  if (isFlushing) {
    if (!queuedFlushRequest || options?.forceImmediate) {
      queuedFlushRequest = options ?? {};
    }
    return currentFlushPromise ?? Promise.resolve({ processed: 0, succeeded: 0, failed: 0, items: [] });
  }

  isFlushing = true;
  currentFlushPromise = runFlush(options);

  try {
    return await currentFlushPromise;
  } finally {
    isFlushing = false;
    currentFlushPromise = null;
    if (queuedFlushRequest) {
      const nextRequest = queuedFlushRequest;
      queuedFlushRequest = null;
      setTimeout(() => {
        flushOutboxQueue(nextRequest);
      }, 0);
    }
  }
}

async function runFlush(options?: {
  forceImmediate?: boolean;
  ceilingMs?: number;
}): Promise<FlushResult> {
  const ceilingMs = options?.ceilingMs ?? configuredCeilingMs;
  let succeeded = 0;
  let failed = 0;
  let processedItems: OutboxItem[] = [];

  const isAvailable = await availabilityCheck();
  if (!isAvailable) {
    // Telephony hardware/permission missing or disabled, reschedule for later check
    const pending = await getAllPendingItems();
    if (pending.length > 0) {
      retryScheduler.schedule(Date.now() + 10_000, () => {
        flushOutboxQueue(options);
      });
    }
    return { processed: 0, succeeded: 0, failed: 0, items: [] };
  }

  const items = options?.forceImmediate
    ? await getAllPendingItems()
    : await getDueItems(Date.now());

  if (items.length === 0) {
    // Check if there are future pending items to schedule retry timer
    await scheduleNextDueRetry(ceilingMs);
    return { processed: 0, succeeded: 0, failed: 0, items: [] };
  }

  processedItems = items;
  const itemIds = items.map((i) => i.id);
  await markInFlight(itemIds);

  for (const item of items) {
    try {
      const ok = await smsSender([item.recipient], item.payload);
      if (ok) {
        await markSent(item.id);
        succeeded++;
      } else {
        throw new Error('Carrier handoff returned false');
      }
    } catch (err) {
      failed++;
      const nextAttempts = item.attempts + 1;
      const canRetry = shouldRetry(nextAttempts, { ceilingMs });
      const nextRetryAt = calculateNextRetryAt(nextAttempts, Date.now(), { ceilingMs });

      await markRetry(item.id, nextAttempts, nextRetryAt, !canRetry);
    }
  }

  // After processing this batch, ensure any remaining or rescheduled items are timed
  await scheduleNextDueRetry(ceilingMs);

  return {
    processed: processedItems.length,
    succeeded,
    failed,
    items: processedItems,
  };
}

/**
 * Inspects all pending items in SQLite and sets the retry timer for the earliest nextRetryAt.
 */
async function scheduleNextDueRetry(ceilingMs: number): Promise<void> {
  const pending = await getAllPendingItems();
  if (pending.length === 0) {
    retryScheduler.cancel();
    return;
  }

  let earliestTime = Infinity;
  for (const item of pending) {
    if (item.nextRetryAt < earliestTime) {
      earliestTime = item.nextRetryAt;
    }
  }

  if (earliestTime !== Infinity) {
    retryScheduler.schedule(earliestTime, () => {
      flushOutboxQueue({ ceilingMs });
    });
  }
}

/**
 * Enqueues messages to the persistent local outbox queue and immediately attempts dispatch.
 */
export async function enqueueAndDispatch(
  recipients: string[],
  payload: string,
  options?: { ceilingMs?: number }
): Promise<{ attempted: boolean; recipients: string[] }> {
  if (recipients.length === 0) {
    return { attempted: false, recipients };
  }

  const itemsToEnqueue = recipients.map((recipient) => ({
    recipient,
    payload,
  }));

  await enqueueItems(itemsToEnqueue);

  // Trigger immediate dispatch
  await flushOutboxQueue({ forceImmediate: true, ceilingMs: options?.ceilingMs });

  return { attempted: true, recipients };
}

/**
 * Initializes the entire dispatch engine:
 * 1. Sets up persistent SQLite queue schema & crash recovery.
 * 2. Wires NetInfo connectivity listener for instant flushing upon cellular reconnection.
 * 3. Immediately flushes any pending messages or arms the backoff retry scheduler.
 *
 * @returns Cleanup function to stop listeners and clear timers.
 */
export async function initDispatchEngine(
  options: DispatchEngineOptions = {}
): Promise<() => void> {
  if (options.ceilingMs) configuredCeilingMs = options.ceilingMs;
  if (options.silentSmsSender) smsSender = options.silentSmsSender;
  if (options.availabilityChecker) availabilityCheck = options.availabilityChecker;

  // Initialize SQLite outbox queue schema
  await initOutboxQueue(options.customDb);

  // Wire NetInfo listener to trigger immediate queue flush the instant cellular connectivity returns
  const unsubscribeNetInfo = setupConnectivityListener({
    subscriber: options.subscriber,
    onCellularRestored: async () => {
      await flushOutboxQueue({ forceImmediate: true, ceilingMs: configuredCeilingMs });
    },
  });

  // Attempt initial flush in case pending items were persisted before restart
  await flushOutboxQueue({ ceilingMs: configuredCeilingMs }).catch((err) => {
    console.warn('[DispatchEngine] Initial queue flush warning:', err);
  });

  return () => {
    unsubscribeNetInfo();
    retryScheduler.cancel();
  };
}

export { retryScheduler };
