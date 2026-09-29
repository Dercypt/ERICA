/**
 * PIN Authentication & Key-Stretching Service for E.R.I.C.A.
 *
 * Implements:
 * - Salt + PBKDF2 key-stretching for PIN validation to protect against offline brute-force attacks.
 * - Integration with hardware-backed master key lifecycle.
 * - Vault lock / unlock state management with automatic buffer wiping.
 */

import {
  hashPin,
  verifyPinHash,
  DEFAULT_PBKDF2_ITERATIONS,
} from './keyDerivation';
import type { StretchedPinRecord } from './keyDerivation';
import {
  saveSecureItem,
  getSecureItem,
  deleteSecureItem,
} from './secureStorage';
import {
  getOrCreateMasterKey,
  loadMasterKey,
  wipeMasterKeyMemory,
  deleteMasterKey,
} from './masterKey';

export const PIN_AUTH_STORAGE_KEY = 'erica_pin_auth_record_v1';

let vaultLocked = true;

/**
 * Checks whether the vault is currently locked.
 */
export function isVaultLocked(): boolean {
  return vaultLocked;
}

/**
 * Checks whether a PIN has already been configured on this device.
 */
export async function isPinConfigured(): Promise<boolean> {
  const recordJson = await getSecureItem(PIN_AUTH_STORAGE_KEY);
  return Boolean(recordJson);
}

/**
 * Configures or re-initializes a PIN.
 * Generates a fresh 256-bit salt, stretches the PIN with PBKDF2 (100,000 iterations),
 * securely stores the record in hardware-backed SecureStore, and creates the master key.
 */
export async function setupPin(
  pin: string,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS
): Promise<void> {
  if (!pin || pin.length < 4) {
    throw new Error('PIN must be at least 4 characters in length.');
  }

  const record = await hashPin(pin, undefined, iterations);
  await saveSecureItem(PIN_AUTH_STORAGE_KEY, JSON.stringify(record));

  // Initialize hardware-backed master key if not already present
  await getOrCreateMasterKey();
  vaultLocked = false;
}

/**
 * Validates entered PIN against the stored stretched hash record.
 * Returns true if valid, false otherwise.
 */
export async function validatePin(pin: string): Promise<boolean> {
  const rawRecord = await getSecureItem(PIN_AUTH_STORAGE_KEY);
  if (!rawRecord) {
    return false;
  }

  let record: StretchedPinRecord;
  try {
    record = JSON.parse(rawRecord);
  } catch {
    return false;
  }

  return await verifyPinHash(pin, record);
}

/**
 * Unlocks the vault using the user PIN.
 * On success, unlocks the vault, loads the master key into active memory, and returns true.
 * On failure, remains locked and returns false.
 */
export async function unlockWithPin(pin: string): Promise<boolean> {
  const isValid = await validatePin(pin);
  if (!isValid) {
    return false;
  }

  await loadMasterKey();
  vaultLocked = false;
  return true;
}

/**
 * Directly unlocks the vault and loads the master key into active memory.
 * Invoked by biometric verification upon authenticated fingerprint/face unlock.
 */
export async function unlockVaultWithMasterKey(): Promise<void> {
  await loadMasterKey();
  vaultLocked = false;
}

/**
 * Locks the security vault.
 * Immediately purges the unencrypted master key from memory and wipes all active buffers.
 */
export function lockVault(): void {
  vaultLocked = true;
  wipeMasterKeyMemory();
}

/**
 * Changes the user PIN. Requires verification of the current PIN first.
 * Rotates the salt to ensure forward secrecy of the stretched hash.
 */
export async function changePin(
  currentPin: string,
  newPin: string,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS
): Promise<boolean> {
  const isCurrentValid = await validatePin(currentPin);
  if (!isCurrentValid) {
    return false;
  }

  if (!newPin || newPin.length < 4) {
    throw new Error('New PIN must be at least 4 characters in length.');
  }

  const newRecord = await hashPin(newPin, undefined, iterations);
  await saveSecureItem(PIN_AUTH_STORAGE_KEY, JSON.stringify(newRecord));
  return true;
}

/**
 * Resets all security state: wipes PIN auth record and master key from hardware store
 * and zeroes out working memory.
 */
export async function resetSecurity(): Promise<void> {
  lockVault();
  await deleteSecureItem(PIN_AUTH_STORAGE_KEY);
  await deleteMasterKey();
}
