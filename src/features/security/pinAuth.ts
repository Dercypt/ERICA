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
export const DURESS_PIN_STORAGE_KEY = 'erica_duress_pin_record_v1';
export const PIN_FAILED_ATTEMPTS_STORAGE_KEY = 'erica_pin_failed_attempts_v1';
export const PIN_LOCKOUT_UNTIL_STORAGE_KEY = 'erica_pin_lockout_until_v1';

/**
 * Calculates the lockout delay in seconds according to the progressive backoff ladder:
 * - 1-4 attempts: 0s (standard invalid PIN message)
 * - 5 attempts: 30-second lockout
 * - 6 attempts: 2-minute lockout (120s)
 * - 7 attempts: 5-minute lockout (300s)
 * - 8 attempts: 15-minute lockout (900s)
 * - 9+ attempts: 30-minute lockout (1800s)
 */
export function getLockoutDurationSeconds(failedAttempts: number): number {
  if (failedAttempts < 5) return 0;
  if (failedAttempts === 5) return 30;
  if (failedAttempts === 6) return 120;
  if (failedAttempts === 7) return 300;
  if (failedAttempts === 8) return 900;
  return 1800;
}

/**
 * Retrieves the persisted count of consecutive failed PIN attempts from hardware SecureStore.
 */
export async function getFailedPinAttempts(): Promise<number> {
  const raw = await getSecureItem(PIN_FAILED_ATTEMPTS_STORAGE_KEY);
  if (!raw) return 0;
  const count = parseInt(raw, 10);
  return isNaN(count) ? 0 : count;
}

/**
 * Retrieves the remaining lockout duration in seconds, or 0 if not currently locked out.
 * Reads the expiration timestamp from SecureStore to ensure app reboots cannot clear the lockout timer.
 */
export async function getLockoutRemainingSeconds(): Promise<number> {
  const raw = await getSecureItem(PIN_LOCKOUT_UNTIL_STORAGE_KEY);
  if (!raw) return 0;
  const lockoutUntil = parseInt(raw, 10);
  if (isNaN(lockoutUntil)) return 0;

  const remainingMs = lockoutUntil - Date.now();
  if (remainingMs <= 0) {
    return 0;
  }
  return Math.ceil(remainingMs / 1000);
}

/**
 * Checks whether the PIN authentication is currently throttled / locked out.
 */
export async function isPinLockedOut(): Promise<boolean> {
  const remaining = await getLockoutRemainingSeconds();
  return remaining > 0;
}

/**
 * Clears failed attempts and active lockout timestamps from hardware SecureStore.
 */
export async function resetPinLockout(): Promise<void> {
  await deleteSecureItem(PIN_FAILED_ATTEMPTS_STORAGE_KEY);
  await deleteSecureItem(PIN_LOCKOUT_UNTIL_STORAGE_KEY);
}

/**
 * Increments failed attempts counter and calculates new lockout expiration timestamp,
 * persisting both to SecureStore.
 */
export async function recordFailedPinAttempt(): Promise<{
  failedAttempts: number;
  lockoutSeconds: number;
  lockoutUntil: number | null;
}> {
  const currentAttempts = await getFailedPinAttempts();
  const nextAttempts = currentAttempts + 1;
  const lockoutSeconds = getLockoutDurationSeconds(nextAttempts);
  const now = Date.now();
  const lockoutUntil = lockoutSeconds > 0 ? now + lockoutSeconds * 1000 : null;

  await saveSecureItem(PIN_FAILED_ATTEMPTS_STORAGE_KEY, String(nextAttempts));
  if (lockoutUntil !== null) {
    await saveSecureItem(PIN_LOCKOUT_UNTIL_STORAGE_KEY, String(lockoutUntil));
  } else {
    await deleteSecureItem(PIN_LOCKOUT_UNTIL_STORAGE_KEY);
  }

  return {
    failedAttempts: nextAttempts,
    lockoutSeconds,
    lockoutUntil,
  };
}

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
 * Checks whether a secondary Duress PIN has been configured on this device.
 */
export async function isDuressPinConfigured(): Promise<boolean> {
  const recordJson = await getSecureItem(DURESS_PIN_STORAGE_KEY);
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
  if (!pin || pin.length < 6) {
    throw new Error('PIN must be at least 6 characters in length.');
  }

  const record = await hashPin(pin, undefined, iterations);
  await saveSecureItem(PIN_AUTH_STORAGE_KEY, JSON.stringify(record));

  // Initialize hardware-backed master key if not already present
  await getOrCreateMasterKey();
  vaultLocked = false;
}

/**
 * Configures an optional secondary Duress PIN.
 * Stretches the PIN with a unique salt and stores it in hardware-backed SecureStore.
 * Must be distinct from the primary PIN.
 */
export async function setupDuressPin(
  duressPin: string,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS
): Promise<void> {
  if (!duressPin || duressPin.length < 6) {
    throw new Error('Duress PIN must be at least 6 characters in length.');
  }

  const primaryConfigured = await isPinConfigured();
  if (!primaryConfigured) {
    throw new Error('Primary PIN must be configured before setting a Duress PIN.');
  }

  const isSameAsPrimary = await validatePin(duressPin);
  if (isSameAsPrimary) {
    throw new Error('Duress PIN cannot be the same as your primary PIN.');
  }

  const record = await hashPin(duressPin, undefined, iterations);
  await saveSecureItem(DURESS_PIN_STORAGE_KEY, JSON.stringify(record));
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
 * Validates entered PIN against the stored secondary duress stretched hash record.
 * Returns true if valid, false otherwise.
 */
export async function validateDuressPin(duressPin: string): Promise<boolean> {
  const rawRecord = await getSecureItem(DURESS_PIN_STORAGE_KEY);
  if (!rawRecord) {
    return false;
  }

  let record: StretchedPinRecord;
  try {
    record = JSON.parse(rawRecord);
  } catch {
    return false;
  }

  return await verifyPinHash(duressPin, record);
}

export type PinAuthResult =
  | { type: 'primary' }
  | { type: 'duress' }
  | { type: 'invalid' }
  | { type: 'locked'; remainingSeconds: number };

/**
 * Authenticates an entered PIN and determines whether it corresponds to the primary PIN,
 * the secondary Duress PIN, or is invalid / locked out.
 *
 * Rules:
 * - Entering a valid Duress PIN never increments the failed attempt counter or leaves any visible lockout artifacts.
 * - If locked out, primary PIN entry is throttled until the timer expires.
 * - Failed attempts trigger the progressive backoff ladder:
 *   - 1-4 attempts: Standard invalid message.
 *   - 5 attempts: 30-second lockout.
 *   - 6 attempts: 2-minute lockout.
 *   - 7+ attempts: Exponential delay (5m, 15m, 30m).
 */
export async function authenticatePin(pin: string): Promise<PinAuthResult> {
  // 1. Duress isolation: valid Duress PIN never increments counter or leaves lockout artifacts
  const isDuress = await validateDuressPin(pin);
  if (isDuress) {
    return { type: 'duress' };
  }

  // 2. Check if currently locked out
  const remainingLockout = await getLockoutRemainingSeconds();
  if (remainingLockout > 0) {
    return { type: 'locked', remainingSeconds: remainingLockout };
  }

  // 3. Primary PIN verification
  const isPrimary = await validatePin(pin);
  if (isPrimary) {
    await resetPinLockout();
    return { type: 'primary' };
  }

  // 4. Record failed attempt and engage backoff if threshold met
  const { lockoutSeconds } = await recordFailedPinAttempt();
  if (lockoutSeconds > 0) {
    return { type: 'locked', remainingSeconds: lockoutSeconds };
  }

  return { type: 'invalid' };
}

/**
 * Unlocks the vault using the user PIN.
 * On success, unlocks the vault, loads the master key into active memory, resets failed attempts, and returns true.
 * On failure or active lockout, remains locked and returns false.
 */
export async function unlockWithPin(pin: string): Promise<boolean> {
  const remainingLockout = await getLockoutRemainingSeconds();
  if (remainingLockout > 0) {
    return false;
  }

  const isValid = await validatePin(pin);
  if (!isValid) {
    await recordFailedPinAttempt();
    return false;
  }

  await resetPinLockout();
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

  if (!newPin || newPin.length < 6) {
    throw new Error('New PIN must be at least 6 characters in length.');
  }

  const isSameAsDuress = await validateDuressPin(newPin);
  if (isSameAsDuress) {
    throw new Error('Primary PIN cannot be the same as your Duress PIN.');
  }

  const newRecord = await hashPin(newPin, undefined, iterations);
  await saveSecureItem(PIN_AUTH_STORAGE_KEY, JSON.stringify(newRecord));
  await resetPinLockout();
  return true;
}

/**
 * Changes the secondary Duress PIN. Requires verification of the current Duress PIN first.
 */
export async function changeDuressPin(
  currentDuressPin: string,
  newDuressPin: string,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS
): Promise<boolean> {
  const isCurrentValid = await validateDuressPin(currentDuressPin);
  if (!isCurrentValid) {
    return false;
  }

  if (!newDuressPin || newDuressPin.length < 6) {
    throw new Error('New Duress PIN must be at least 6 characters in length.');
  }

  const isSameAsPrimary = await validatePin(newDuressPin);
  if (isSameAsPrimary) {
    throw new Error('Duress PIN cannot be the same as your primary PIN.');
  }

  const newRecord = await hashPin(newDuressPin, undefined, iterations);
  await saveSecureItem(DURESS_PIN_STORAGE_KEY, JSON.stringify(newRecord));
  return true;
}

/**
 * Removes the secondary Duress PIN from secure storage.
 */
export async function removeDuressPin(): Promise<void> {
  await deleteSecureItem(DURESS_PIN_STORAGE_KEY);
}

/**
 * Resets all security state: wipes PIN auth record, duress record, and master key from hardware store
 * and zeroes out working memory.
 */
export async function resetSecurity(): Promise<void> {
  lockVault();
  await deleteSecureItem(PIN_AUTH_STORAGE_KEY);
  await deleteSecureItem(DURESS_PIN_STORAGE_KEY);
  await resetPinLockout();
  await deleteMasterKey();
}
