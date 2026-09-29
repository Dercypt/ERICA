/**
 * Hardware-Backed Master Encryption Key Management for E.R.I.C.A.
 *
 * Implements:
 * - 256-bit AES master key generation using cryptographically secure random bytes.
 * - Hardware-backed persistence via expo-secure-store (leveraging Android Keystore / TEE).
 * - Strict in-memory lifecycle with zeroing / buffer wiping on lock to prevent key
 *   retention in static memory.
 */

import {
  generateRandomBytes,
  bytesToHex,
  hexToBytes,
  wipeBuffer,
} from './keyDerivation';
import {
  saveSecureItem,
  getSecureItem,
  deleteSecureItem,
} from './secureStorage';

export const MASTER_KEY_BYTE_LENGTH = 32; // 256 bits for AES-256
export const MASTER_KEY_STORAGE_KEY = 'erica_master_encryption_key_v1';

/**
 * In-memory buffer holding the decrypted master key only while the session is unlocked.
 * Strictly wiped upon locking or error.
 */
let activeMasterKey: Uint8Array | null = null;

/**
 * Checks whether the master key is currently loaded and available in active memory.
 */
export function isMasterKeyLoaded(): boolean {
  return activeMasterKey !== null && activeMasterKey.length === MASTER_KEY_BYTE_LENGTH;
}

/**
 * Checks whether a hardware-backed master key has already been generated and persisted.
 */
export async function hasMasterKey(): Promise<boolean> {
  const stored = await getSecureItem(MASTER_KEY_STORAGE_KEY);
  return Boolean(stored && stored.length === MASTER_KEY_BYTE_LENGTH * 2);
}

/**
 * Generates a new cryptographically secure 256-bit AES master key,
 * stores it in hardware-backed SecureStore (Android Keystore / TEE),
 * and loads it into active working memory.
 */
export async function generateMasterKey(): Promise<Uint8Array> {
  // Wipe any existing active key buffer before generating new
  wipeMasterKeyMemory();

  const newKey = generateRandomBytes(MASTER_KEY_BYTE_LENGTH);
  const hex = bytesToHex(newKey);

  try {
    await saveSecureItem(MASTER_KEY_STORAGE_KEY, hex);
    // Retain only in activeMasterKey
    activeMasterKey = new Uint8Array(newKey);
    return new Uint8Array(activeMasterKey);
  } finally {
    wipeBuffer(newKey);
  }
}

/**
 * Loads the hardware-backed master key from SecureStore into active memory.
 * Returns null if no master key is stored.
 */
export async function loadMasterKey(): Promise<Uint8Array | null> {
  if (isMasterKeyLoaded() && activeMasterKey) {
    return new Uint8Array(activeMasterKey);
  }

  const storedHex = await getSecureItem(MASTER_KEY_STORAGE_KEY);
  if (!storedHex) {
    return null;
  }

  const rawBytes = hexToBytes(storedHex);
  if (rawBytes.length !== MASTER_KEY_BYTE_LENGTH) {
    wipeBuffer(rawBytes);
    throw new Error(
      `Corrupted master key in secure storage: expected ${MASTER_KEY_BYTE_LENGTH} bytes, got ${rawBytes.length}`
    );
  }

  activeMasterKey = rawBytes;
  return new Uint8Array(activeMasterKey);
}

/**
 * Retrieves the existing hardware-backed master key, or generates a new 256-bit key
 * if none exists yet.
 */
export async function getOrCreateMasterKey(): Promise<Uint8Array> {
  const existing = await loadMasterKey();
  if (existing) {
    return existing;
  }
  return await generateMasterKey();
}

/**
 * Retrieves a temporary copy of the active unencrypted master key.
 * Throws if the vault is locked and no master key is in memory.
 */
export function getActiveMasterKey(): Uint8Array {
  if (!activeMasterKey || activeMasterKey.length !== MASTER_KEY_BYTE_LENGTH) {
    throw new Error('Master key is locked or not loaded in memory.');
  }
  return new Uint8Array(activeMasterKey);
}

/**
 * Executes a scoped cryptographic operation with access to the unencrypted master key.
 * Guarantees that any transient key buffers allocated for the operation are
 * wiped immediately in a `finally` block.
 */
export async function withMasterKey<T>(
  operation: (key: Uint8Array) => Promise<T> | T
): Promise<T> {
  const wasLoaded = isMasterKeyLoaded();
  let keyCopy: Uint8Array | null = null;
  try {
    if (!wasLoaded) {
      await getOrCreateMasterKey();
    }
    keyCopy = getActiveMasterKey();
    return await operation(keyCopy);
  } finally {
    if (keyCopy) {
      wipeBuffer(keyCopy);
    }
    if (!wasLoaded) {
      wipeMasterKeyMemory();
    }
  }
}

/**
 * Immediately scrubs and zeroes out the master key from active memory.
 * Fulfills the Security Rule: "Never retain unencrypted keys in static memory
 * longer than necessary; wipe buffers upon locking."
 */
export function wipeMasterKeyMemory(): void {
  if (activeMasterKey) {
    wipeBuffer(activeMasterKey);
    activeMasterKey = null;
  }
}

/**
 * Permanently removes the master key from hardware-backed SecureStore and
 * immediately wipes memory buffers.
 */
export async function deleteMasterKey(): Promise<void> {
  wipeMasterKeyMemory();
  await deleteSecureItem(MASTER_KEY_STORAGE_KEY);
}
