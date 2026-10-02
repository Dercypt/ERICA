import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  encryptString,
  decryptString,
  isEncryptedPayload,
} from '../security/encryption';
import type { ISQLiteDatabase } from '../dispatch/outboxQueue';

export interface EvidenceRecord {
  id: string;
  sessionId: string;
  type: 'audio' | 'photo';
  lens?: 'front' | 'rear';
  mimeType: string;
  fileSizeBytes: number;
  durationMs?: number;
  createdAt: number;
  dataBase64: string; // Base64 data (encrypted at rest)
}

/** Everything about a record except its media bytes. */
export type EvidenceSummary = Omit<EvidenceRecord, 'dataBase64'>;

/**
 * Evidence lives in its own SQLite database, not AsyncStorage.
 *
 * The Phase 4 vault was one AsyncStorage value holding every recording and photo. Android
 * caps AsyncStorage at 6 MB in total (shared with contacts, settings and history) and cannot
 * read a single value much over 2 MB, so a couple of minutes of audio made the vault
 * unreadable and could stop contacts and settings from saving at all.
 *
 * Layout (LAWS.md Law 1 — nothing sensitive in plaintext, metadata included):
 * - evidence_records: one row per record; `envelope` is the AES-256-GCM-encrypted JSON
 *   summary (session, type, timestamps, ...). Only a random id and an insertion sequence
 *   are stored in the clear.
 * - evidence_chunks: the record's base64 media split into EVIDENCE_CHUNK_CHARS pieces, each
 *   encrypted separately so no single read or write grows with recording length.
 */
export const EVIDENCE_DB_NAME = 'erica_evidence.db';
export const EVIDENCE_CHUNK_CHARS = 256 * 1024;

/** Legacy single-value AsyncStorage vault (pre-SQLite). Migrated once, then removed. */
export const EVIDENCE_STORAGE_KEY = '@erica/evidence_vault';

let customDatabase: ISQLiteDatabase | null = null;
let dbPromise: Promise<ISQLiteDatabase> | null = null;
// Photos and audio segments are saved concurrently during an emergency. Writes use explicit
// transactions on one connection, so they must run one at a time.
let writeQueue: Promise<unknown> = Promise.resolve();

function serializeWrite<T>(write: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(write, write);
  writeQueue = next.catch(() => undefined);
  return next;
}

/**
 * Use a specific database (tests). Pass null to go back to the on-device database.
 */
export function setCustomEvidenceDatabase(db: ISQLiteDatabase | null): void {
  customDatabase = db;
  dbPromise = null;
  writeQueue = Promise.resolve();
}

async function openDatabase(): Promise<ISQLiteDatabase> {
  if (customDatabase) {
    return customDatabase;
  }
  // Dynamic import keeps the module loadable in non-native environments, like outboxQueue.
  const SQLite = await import('expo-sqlite');
  return (await SQLite.openDatabaseAsync(EVIDENCE_DB_NAME)) as unknown as ISQLiteDatabase;
}

async function getDb(): Promise<ISQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await openDatabase();
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS evidence_records (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          envelope TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS evidence_chunks (
          record_id TEXT NOT NULL,
          idx INTEGER NOT NULL,
          envelope TEXT NOT NULL,
          PRIMARY KEY (record_id, idx)
        );
      `);
      // Chunks are written before their record row, so a crash mid-write can leave chunks
      // with no record. They are unreachable; drop them.
      await db.runAsync(
        'DELETE FROM evidence_chunks WHERE record_id NOT IN (SELECT id FROM evidence_records);'
      );
      await serializeWrite(() => migrateLegacyVault(db));
      return db;
    })().catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

interface StoredSummary extends EvidenceSummary {
  chunkCount: number;
}

async function insertRecord(db: ISQLiteDatabase, record: EvidenceRecord): Promise<void> {
  const { dataBase64, ...summary } = record;
  const chunkCount = Math.ceil(dataBase64.length / EVIDENCE_CHUNK_CHARS);
  const stored: StoredSummary = { ...summary, chunkCount };

  await db.execAsync('BEGIN;');
  try {
    // Re-saving an id replaces it completely.
    await db.runAsync('DELETE FROM evidence_chunks WHERE record_id = ?;', record.id);
    await db.runAsync('DELETE FROM evidence_records WHERE id = ?;', record.id);
    for (let i = 0; i < chunkCount; i++) {
      const piece = dataBase64.slice(i * EVIDENCE_CHUNK_CHARS, (i + 1) * EVIDENCE_CHUNK_CHARS);
      await db.runAsync(
        'INSERT INTO evidence_chunks (record_id, idx, envelope) VALUES (?, ?, ?);',
        record.id,
        i,
        await encryptString(piece)
      );
    }
    await db.runAsync(
      'INSERT INTO evidence_records (id, envelope) VALUES (?, ?);',
      record.id,
      await encryptString(JSON.stringify(stored))
    );
    await db.execAsync('COMMIT;');
  } catch (err) {
    await db.execAsync('ROLLBACK;').catch(() => {});
    throw err;
  }
}

async function readSummaries(db: ISQLiteDatabase): Promise<StoredSummary[]> {
  const rows = await db.getAllAsync<{ id: string; envelope: string }>(
    'SELECT id, envelope FROM evidence_records ORDER BY seq DESC;'
  );
  const summaries: StoredSummary[] = [];
  for (const row of rows) {
    try {
      summaries.push(JSON.parse(await decryptString(row.envelope)) as StoredSummary);
    } catch (err) {
      // A record that fails authentication is left in place, never deleted or overwritten.
      console.warn(`[evidenceStorage] Skipping unreadable evidence record ${row.id}:`, err);
    }
  }
  return summaries;
}

async function readData(db: ISQLiteDatabase, summary: StoredSummary): Promise<string | null> {
  const rows = await db.getAllAsync<{ idx: number; envelope: string }>(
    'SELECT idx, envelope FROM evidence_chunks WHERE record_id = ? ORDER BY idx ASC;',
    summary.id
  );
  if (rows.length !== summary.chunkCount) {
    console.warn(`[evidenceStorage] Evidence record ${summary.id} is missing chunks`);
    return null;
  }
  try {
    const pieces: string[] = [];
    for (const row of rows) {
      pieces.push(await decryptString(row.envelope));
    }
    return pieces.join('');
  } catch (err) {
    console.warn(`[evidenceStorage] Evidence record ${summary.id} has an unreadable chunk:`, err);
    return null;
  }
}

/**
 * Moves the legacy AsyncStorage vault into SQLite once. If the legacy value cannot be
 * decrypted it is left untouched rather than deleted.
 */
async function migrateLegacyVault(db: ISQLiteDatabase): Promise<void> {
  const raw = await AsyncStorage.getItem(EVIDENCE_STORAGE_KEY);
  if (!raw) {
    return;
  }
  let legacy: EvidenceRecord[];
  try {
    legacy = JSON.parse(isEncryptedPayload(raw) ? await decryptString(raw) : raw) as EvidenceRecord[];
  } catch (err) {
    console.warn('[evidenceStorage] Legacy evidence vault is unreadable; leaving it in place:', err);
    return;
  }
  // Oldest first, so the newest ends up with the highest sequence like a live append.
  for (const record of [...legacy].reverse()) {
    await insertRecord(db, record);
  }
  await AsyncStorage.removeItem(EVIDENCE_STORAGE_KEY);
}

/**
 * Lists evidence without loading any media. Use this for counts and listings.
 */
export async function getEvidenceSummaries(): Promise<EvidenceSummary[]> {
  const db = await getDb();
  return (await readSummaries(db)).map(({ chunkCount: _chunkCount, ...summary }) => summary);
}

/**
 * Loads every record including its media, newest first. Unreadable records are skipped.
 */
export async function getEvidence(): Promise<EvidenceRecord[]> {
  const db = await getDb();
  const records: EvidenceRecord[] = [];
  for (const summary of await readSummaries(db)) {
    const dataBase64 = await readData(db, summary);
    if (dataBase64 !== null) {
      const { chunkCount: _chunkCount, ...rest } = summary;
      records.push({ ...rest, dataBase64 });
    }
  }
  return records;
}

/**
 * Replaces the whole vault with `list`.
 */
export async function saveEvidenceList(list: EvidenceRecord[]): Promise<void> {
  await clearEvidence();
  await appendEvidenceRecords(list);
}

export async function appendEvidenceRecord(record: EvidenceRecord): Promise<void> {
  const db = await getDb();
  await serializeWrite(() => insertRecord(db, record));
}

export async function appendEvidenceRecords(records: EvidenceRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await getDb();
  // Inserted in reverse so records[0] ends up newest, matching the old list order.
  await serializeWrite(async () => {
    for (const record of [...records].reverse()) {
      await insertRecord(db, record);
    }
  });
}

export async function getEvidenceBySession(sessionId: string): Promise<EvidenceRecord[]> {
  const all = await getEvidence();
  return all.filter((item) => item.sessionId === sessionId);
}

export async function deleteEvidenceRecord(id: string): Promise<void> {
  const db = await getDb();
  await serializeWrite(async () => {
    await db.execAsync('BEGIN;');
    try {
      await db.runAsync('DELETE FROM evidence_records WHERE id = ?;', id);
      await db.runAsync('DELETE FROM evidence_chunks WHERE record_id = ?;', id);
      await db.execAsync('COMMIT;');
    } catch (err) {
      await db.execAsync('ROLLBACK;').catch(() => {});
      throw err;
    }
  });
}

export async function clearEvidence(): Promise<void> {
  const db = await getDb();
  await serializeWrite(async () => {
    await db.execAsync('DELETE FROM evidence_chunks; DELETE FROM evidence_records;');
    await AsyncStorage.removeItem(EVIDENCE_STORAGE_KEY);
  });
}

export default {
  getEvidence,
  getEvidenceSummaries,
  saveEvidenceList,
  appendEvidenceRecord,
  appendEvidenceRecords,
  getEvidenceBySession,
  deleteEvidenceRecord,
  clearEvidence,
};
