import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  encryptString,
  decryptString,
  isEncryptedPayload,
} from '../security/encryption';
import { DecryptionFailedError } from '../contacts/contactsStorage';

export interface EvidenceRecord {
  id: string;
  sessionId: string;
  type: 'audio' | 'photo';
  lens?: 'front' | 'rear';
  mimeType: string;
  fileSizeBytes: number;
  durationMs?: number;
  createdAt: number;
  dataBase64: string; // Base64 data (encrypted at rest inside the envelope)
}

export const EVIDENCE_STORAGE_KEY = '@erica/evidence_vault';

export async function getEvidence(): Promise<EvidenceRecord[]> {
  const raw = await AsyncStorage.getItem(EVIDENCE_STORAGE_KEY);
  if (!raw) {
    return [];
  }

  if (isEncryptedPayload(raw)) {
    try {
      const decrypted = await decryptString(raw);
      return JSON.parse(decrypted) as EvidenceRecord[];
    } catch (err) {
      console.warn('[evidenceStorage] Failed to decrypt evidence vault:', err);
      return [];
    }
  }

  // If unencrypted payload encountered (should never happen), migrate to encrypted
  try {
    const list = JSON.parse(raw) as EvidenceRecord[];
    const encrypted = await encryptString(JSON.stringify(list));
    await AsyncStorage.setItem(EVIDENCE_STORAGE_KEY, encrypted);
    return list;
  } catch (err) {
    console.warn('[evidenceStorage] Corrupted evidence storage:', err);
    return [];
  }
}

export async function saveEvidenceList(list: EvidenceRecord[]): Promise<void> {
  const json = JSON.stringify(list);
  const encrypted = await encryptString(json);
  await AsyncStorage.setItem(EVIDENCE_STORAGE_KEY, encrypted);
}

/**
 * Loads the vault before a read-modify-write. getEvidence() returns [] when the vault cannot
 * be decrypted, and writing on top of that silently destroyed every stored recording and
 * photo; here the write is refused instead so the encrypted vault is never overwritten.
 */
async function loadEvidenceForWrite(): Promise<EvidenceRecord[]> {
  const raw = await AsyncStorage.getItem(EVIDENCE_STORAGE_KEY);
  if (!raw || !isEncryptedPayload(raw)) {
    return await getEvidence();
  }
  try {
    return JSON.parse(await decryptString(raw)) as EvidenceRecord[];
  } catch (err) {
    throw new DecryptionFailedError(
      'Decryption failed: Unable to decrypt evidence vault. Refusing to overwrite it.',
      err
    );
  }
}

export async function appendEvidenceRecord(record: EvidenceRecord): Promise<void> {
  const existing = await loadEvidenceForWrite();
  await saveEvidenceList([record, ...existing]);
}

export async function appendEvidenceRecords(records: EvidenceRecord[]): Promise<void> {
  if (records.length === 0) return;
  const existing = await loadEvidenceForWrite();
  await saveEvidenceList([...records, ...existing]);
}

export async function getEvidenceBySession(sessionId: string): Promise<EvidenceRecord[]> {
  const all = await getEvidence();
  return all.filter((item) => item.sessionId === sessionId);
}

export async function deleteEvidenceRecord(id: string): Promise<void> {
  const all = await loadEvidenceForWrite();
  const updated = all.filter((item) => item.id !== id);
  await saveEvidenceList(updated);
}

export async function clearEvidence(): Promise<void> {
  await AsyncStorage.removeItem(EVIDENCE_STORAGE_KEY);
}

export default {
  getEvidence,
  saveEvidenceList,
  appendEvidenceRecord,
  appendEvidenceRecords,
  getEvidenceBySession,
  deleteEvidenceRecord,
  clearEvidence,
};
