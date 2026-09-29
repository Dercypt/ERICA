import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  encryptString,
  decryptString,
  isEncryptedPayload,
} from '../security/encryption';

export interface HistoryEntry {
  sessionId: string;
  triggerSource: string;
  startedAt: number;
  resolvedAt: number | null;
  locationCaptured: boolean;
}

export const HISTORY_STORAGE_KEY = '@erica/history';
const STORAGE_KEY = HISTORY_STORAGE_KEY;

export async function getHistory(): Promise<HistoryEntry[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return [];
  }

  // Handle encrypted ciphertext storage
  if (isEncryptedPayload(raw)) {
    try {
      const decrypted = await decryptString(raw);
      return JSON.parse(decrypted) as HistoryEntry[];
    } catch (err) {
      console.warn('[historyStorage] Failed to decrypt history:', err);
      return [];
    }
  }

  // Handle legacy Phase 1/2 plaintext: parse and automatically re-encrypt to ciphertext
  try {
    const history = JSON.parse(raw) as HistoryEntry[];
    const encrypted = await encryptString(JSON.stringify(history));
    await AsyncStorage.setItem(STORAGE_KEY, encrypted);
    return history;
  } catch (err) {
    console.warn('[historyStorage] Failed to parse legacy history:', err);
    return [];
  }
}

async function saveHistory(history: HistoryEntry[]): Promise<void> {
  const json = JSON.stringify(history);
  const encrypted = await encryptString(json);
  await AsyncStorage.setItem(STORAGE_KEY, encrypted);
}

export async function appendHistoryEntry(entry: HistoryEntry): Promise<void> {
  const history = await getHistory();
  await saveHistory([entry, ...history]);
}

export async function resolveHistoryEntry(sessionId: string, resolvedAt: number): Promise<void> {
  const history = await getHistory();
  const updated = history.map((h) => (h.sessionId === sessionId ? { ...h, resolvedAt } : h));
  await saveHistory(updated);
}

export async function clearHistory(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}
