import type { SQLiteDatabase } from 'expo-sqlite';
import {
  encryptString,
  decryptString,
  isEncryptedPayload,
  isDecryptionFailure,
} from '../security/encryption';

export type OutboxStatus = 'PENDING' | 'IN_FLIGHT' | 'SENT' | 'FAILED';

export interface OutboxItem {
  id: string;
  recipient: string;
  payload: string;
  attempts: number;
  status: OutboxStatus;
  nextRetryAt: number;
  createdAt: number;
}

export interface ISQLiteDatabase {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, ...params: any[]): Promise<{ lastInsertRowId?: number; changes?: number }>;
  getAllAsync<T>(sql: string, ...params: any[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, ...params: any[]): Promise<T | null>;
}

let activeDatabase: ISQLiteDatabase | null = null;
let dbInitializationPromise: Promise<ISQLiteDatabase> | null = null;

/**
 * Configure a custom or mock database instance (useful for testing and offline simulations).
 */
export function setCustomDatabase(db: ISQLiteDatabase | null): void {
  activeDatabase = db;
  dbInitializationPromise = null;
}

/**
 * Helper to open and initialize the persistent SQLite database.
 */
export async function getDatabase(): Promise<ISQLiteDatabase> {
  if (activeDatabase) {
    return activeDatabase;
  }

  if (!dbInitializationPromise) {
    dbInitializationPromise = (async () => {
      // Dynamic import ensures safe bundling across Expo native runtime and Node testing harnesses
      const SQLite = await import('expo-sqlite');
      const db = await SQLite.openDatabaseAsync('erica_outbox.db');
      await initOutboxSchema(db as unknown as ISQLiteDatabase);
      activeDatabase = db as unknown as ISQLiteDatabase;
      return activeDatabase;
    })();
  }

  return dbInitializationPromise;
}

/**
 * Initializes the outbox_queue schema and auto-recovers interrupted in-flight messages.
 */
export async function initOutboxSchema(db: ISQLiteDatabase): Promise<void> {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS outbox_queue (
      id TEXT PRIMARY KEY NOT NULL,
      recipient TEXT NOT NULL,
      payload TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'PENDING',
      nextRetryAt INTEGER NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_queue_status_retry ON outbox_queue (status, nextRetryAt);
  `);

  // Durable crash recovery: if the app/process was killed while an SMS was IN_FLIGHT,
  // restore its status to PENDING so it can be retried rather than dropped.
  await db.runAsync(
    "UPDATE outbox_queue SET status = 'PENDING' WHERE status = 'IN_FLIGHT';"
  );
}

/**
 * Explicit initialization helper for application bootstrap.
 */
export async function initOutboxQueue(customDb?: ISQLiteDatabase): Promise<ISQLiteDatabase> {
  if (customDb) {
    setCustomDatabase(customDb);
    await initOutboxSchema(customDb);
    return customDb;
  }
  return await getDatabase();
}

/**
 * Generates a unique message ID for the outbox queue.
 */
export function generateOutboxId(): string {
  const ts = Date.now();
  const rnd = Math.random().toString(36).substring(2, 10);
  return `msg_${ts}_${rnd}`;
}

const UNDECRYPTABLE = Symbol('undecryptable');

async function decryptOutboxItem(item: OutboxItem): Promise<OutboxItem | null | typeof UNDECRYPTABLE> {
  if (!isEncryptedPayload(item.payload)) {
    return item;
  }
  try {
    const decrypted = await decryptString(item.payload);
    return { ...item, payload: decrypted };
  } catch (err) {
    console.warn(`[outboxQueue] Failed to decrypt payload for item ${item.id}:`, err);
    // Tag verification failed: this row can never be decrypted with the current key.
    // Any other error (e.g. SecureStore briefly unavailable) is transient; skip the row
    // this round and leave it PENDING.
    return isDecryptionFailure(err) ? UNDECRYPTABLE : null;
  }
}

/**
 * Decrypts rows for use. Rows that fail to decrypt are never returned: previously the
 * raw ciphertext envelope was handed to the SMS sender and texted to the contact.
 * Permanently undecryptable rows are marked FAILED so they stop being retried.
 */
async function decryptOutboxItems(items: OutboxItem[]): Promise<OutboxItem[]> {
  const results = await Promise.all(items.map(decryptOutboxItem));
  const usable: OutboxItem[] = [];
  const undecryptableIds: string[] = [];
  results.forEach((r, i) => {
    if (r === UNDECRYPTABLE) undecryptableIds.push(items[i].id);
    else if (r) usable.push(r);
  });
  if (undecryptableIds.length > 0) {
    const db = await getDatabase();
    for (const id of undecryptableIds) {
      await db.runAsync(`UPDATE outbox_queue SET status = ? WHERE id = ?;`, 'FAILED', id);
    }
  }
  return usable;
}

/**
 * Enqueues a single SMS alert into the persistent local SQLite outbox queue.
 * Payload is automatically encrypted using authenticated AES-256-GCM.
 */
export async function enqueueItem(
  recipient: string,
  payload: string,
  options?: { id?: string; nextRetryAt?: number; createdAt?: number }
): Promise<OutboxItem> {
  const db = await getDatabase();
  const now = Date.now();
  const item: OutboxItem = {
    id: options?.id ?? generateOutboxId(),
    recipient: recipient.trim(),
    payload,
    attempts: 0,
    status: 'PENDING',
    nextRetryAt: options?.nextRetryAt ?? now,
    createdAt: options?.createdAt ?? now,
  };

  const encryptedPayload = isEncryptedPayload(payload)
    ? payload
    : await encryptString(payload);

  await db.runAsync(
    `INSERT INTO outbox_queue (id, recipient, payload, attempts, status, nextRetryAt, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?);`,
    item.id,
    item.recipient,
    encryptedPayload,
    item.attempts,
    item.status,
    item.nextRetryAt,
    item.createdAt
  );

  return item;
}

/**
 * Enqueues multiple recipient alerts atomically into the persistent SQLite queue.
 */
export async function enqueueItems(
  items: Array<{ recipient: string; payload: string }>,
  options?: { nextRetryAt?: number; createdAt?: number }
): Promise<OutboxItem[]> {
  const created: OutboxItem[] = [];
  for (const it of items) {
    const item = await enqueueItem(it.recipient, it.payload, options);
    created.push(item);
  }
  return created;
}

/**
 * Retrieves pending messages that are due for delivery based on their nextRetryAt timestamp.
 */
export async function getDueItems(now: number = Date.now(), limit: number = 50): Promise<OutboxItem[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<OutboxItem>(
    `SELECT id, recipient, payload, attempts, status, nextRetryAt, createdAt
     FROM outbox_queue
     WHERE status = 'PENDING' AND nextRetryAt <= ?
     ORDER BY createdAt ASC
     LIMIT ?;`,
    now,
    limit
  );
  return await decryptOutboxItems(rows);
}

/**
 * Retrieves ALL pending items regardless of nextRetryAt.
 * Used when cellular connectivity returns to force an immediate queue flush.
 */
export async function getAllPendingItems(): Promise<OutboxItem[]> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<OutboxItem>(
    `SELECT id, recipient, payload, attempts, status, nextRetryAt, createdAt
     FROM outbox_queue
     WHERE status = 'PENDING'
     ORDER BY createdAt ASC;`
  );
  return await decryptOutboxItems(rows);
}

/**
 * Transitions items to IN_FLIGHT status while carrier handoff is in progress.
 */
export async function markInFlight(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await getDatabase();
  const placeholders = ids.map(() => '?').join(',');
  await db.runAsync(
    `UPDATE outbox_queue SET status = 'IN_FLIGHT' WHERE id IN (${placeholders});`,
    ...ids
  );
}

/**
 * Marks an item as SENT once carrier handoff succeeds.
 */
export async function markSent(id: string): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    `UPDATE outbox_queue SET status = 'SENT' WHERE id = ?;`,
    id
  );
}

/**
 * Updates an item after a failed dispatch attempt, scheduling its next retry timestamp.
 */
export async function markRetry(
  id: string,
  attempts: number,
  nextRetryAt: number,
  isFinalFailure: boolean = false
): Promise<void> {
  const db = await getDatabase();
  const nextStatus: OutboxStatus = isFinalFailure ? 'FAILED' : 'PENDING';
  await db.runAsync(
    `UPDATE outbox_queue SET attempts = ?, nextRetryAt = ?, status = ? WHERE id = ?;`,
    attempts,
    nextRetryAt,
    nextStatus,
    id
  );
}

/**
 * Resets any IN_FLIGHT items back to PENDING.
 */
export async function resetInFlightToPending(): Promise<void> {
  const db = await getDatabase();
  await db.runAsync(
    "UPDATE outbox_queue SET status = 'PENDING' WHERE status = 'IN_FLIGHT';"
  );
}

/**
 * Fetches outbox queue items with optional status filtering.
 * Payloads are automatically decrypted for consumption.
 */
export async function getOutboxItems(filter?: { status?: OutboxStatus }): Promise<OutboxItem[]> {
  const db = await getDatabase();
  let rows: OutboxItem[];
  if (filter?.status) {
    rows = await db.getAllAsync<OutboxItem>(
      `SELECT id, recipient, payload, attempts, status, nextRetryAt, createdAt
       FROM outbox_queue
       WHERE status = ?
       ORDER BY createdAt DESC;`,
      filter.status
    );
  } else {
    rows = await db.getAllAsync<OutboxItem>(
      `SELECT id, recipient, payload, attempts, status, nextRetryAt, createdAt
       FROM outbox_queue
       ORDER BY createdAt DESC;`
    );
  }
  return await decryptOutboxItems(rows);
}

/**
 * Migrates any legacy unencrypted payloads in SQLite outbox_queue to authenticated AES-256-GCM ciphertext.
 */
export async function migrateOutboxQueuePayloads(customDb?: ISQLiteDatabase): Promise<number> {
  const db = customDb ?? (await getDatabase());
  const rows = await db.getAllAsync<OutboxItem>(
    `SELECT id, recipient, payload, attempts, status, nextRetryAt, createdAt FROM outbox_queue;`
  );

  let migratedCount = 0;
  for (const row of rows) {
    if (!isEncryptedPayload(row.payload)) {
      const encrypted = await encryptString(row.payload);
      await db.runAsync(
        `UPDATE outbox_queue SET payload = ? WHERE id = ?;`,
        encrypted,
        row.id
      );
      migratedCount++;
    }
  }
  return migratedCount;
}

/**
 * Aggregates statistics about the current local outbox queue.
 */
export async function getQueueStats(): Promise<{
  pending: number;
  inFlight: number;
  sent: number;
  failed: number;
  total: number;
}> {
  const db = await getDatabase();
  const rows = await db.getAllAsync<{ status: OutboxStatus; count: number }>(
    `SELECT status, COUNT(*) as count FROM outbox_queue GROUP BY status;`
  );

  let pending = 0;
  let inFlight = 0;
  let sent = 0;
  let failed = 0;

  for (const r of rows) {
    if (r.status === 'PENDING') pending = r.count;
    else if (r.status === 'IN_FLIGHT') inFlight = r.count;
    else if (r.status === 'SENT') sent = r.count;
    else if (r.status === 'FAILED') failed = r.count;
  }

  return {
    pending,
    inFlight,
    sent,
    failed,
    total: pending + inFlight + sent + failed,
  };
}

/**
 * Clears all items in the outbox queue.
 */
export async function clearQueue(): Promise<void> {
  const db = await getDatabase();
  await db.runAsync('DELETE FROM outbox_queue;');
}
