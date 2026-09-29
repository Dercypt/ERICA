import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { resetMockSecureStore } from './mockExpo.mjs';
import { AppState } from './mockReactNative.mjs';
import {
  hashPin,
  verifyPinHash,
  generateSalt,
  deriveKeyFromPin,
  timingSafeEqual,
  wipeBuffer,
  DEFAULT_PBKDF2_ITERATIONS,
  DEFAULT_SALT_BYTES,
  DEFAULT_KEY_BYTES,
  setupPin,
  validatePin,
  unlockWithPin,
  lockVault,
  isVaultLocked,
  isPinConfigured,
  changePin,
  resetSecurity,
  setupDuressPin,
  validateDuressPin,
  changeDuressPin,
  removeDuressPin,
  isDuressPinConfigured,
  authenticatePin,
  isMasterKeyLoaded,
  getActiveMasterKey,
  appLockController,
  saveSecureItem,
  getSecureItem,
  PIN_AUTH_STORAGE_KEY,
  DURESS_PIN_STORAGE_KEY,
} from '../src/features/security';

test.beforeEach(async () => {
  resetMockSecureStore();
  (AppState as any)._reset();
  lockVault();
  appLockController.destroy();
});

test('Task 1.1: PIN Hashing & Salting: PBKDF2 stretching, 256-bit salt uniqueness, and rainbow table resistance', async () => {
  const pin = '8492';
  const records = [];

  // Hash the identical PIN 5 times
  for (let i = 0; i < 5; i++) {
    const record = await hashPin(pin, undefined, 1000);
    records.push(record);
  }

  // 1. Verify all salts are 32 bytes (64 hex chars)
  for (const rec of records) {
    assert.strictEqual(rec.salt.length, DEFAULT_SALT_BYTES * 2, 'Salt must be 256-bit (64 hex characters)');
    assert.strictEqual(rec.hash.length, DEFAULT_KEY_BYTES * 2, 'Hash must be 256-bit (64 hex characters)');
    assert.strictEqual(rec.algorithm, 'PBKDF2-HMAC-SHA256');
  }

  // 2. Verify all salts are cryptographically unique
  const saltSet = new Set(records.map((r) => r.salt));
  assert.strictEqual(saltSet.size, 5, 'Every generated salt must be distinct, eliminating precomputation');

  // 3. Verify all hashes are completely distinct (rainbow table immunity)
  const hashSet = new Set(records.map((r) => r.hash));
  assert.strictEqual(hashSet.size, 5, 'Hashes for identical PINs with fresh salts must differ completely');

  // 4. Each record validates only the correct PIN
  for (const rec of records) {
    assert.strictEqual(await verifyPinHash(pin, rec), true, 'Record must validate original PIN');
    assert.strictEqual(await verifyPinHash('0000', rec), false, 'Record must reject incorrect PIN');
  }
});

test('Task 1.2: Salt Rotation & Forward Secrecy: Changing PIN rotates salt and invalidates precomputed adversary tables', async () => {
  await setupPin('1234', 1000);

  const initialRecordJson = (await getSecureItem(PIN_AUTH_STORAGE_KEY))!;
  const initialRecord = JSON.parse(initialRecordJson);

  // Adversary copies initial salt and stretched hash
  const adversaryStolenSalt = initialRecord.salt;
  const adversaryStolenHash = initialRecord.hash;

  // Legitimate user changes PIN
  const changed = await changePin('1234', '5678', 1000);
  assert.strictEqual(changed, true, 'PIN change must succeed with valid current PIN');

  const newRecordJson = (await getSecureItem(PIN_AUTH_STORAGE_KEY))!;
  const newRecord = JSON.parse(newRecordJson);

  // Salt MUST be rotated
  assert.notStrictEqual(newRecord.salt, adversaryStolenSalt, 'Salt must be rotated upon PIN change');
  assert.notStrictEqual(newRecord.hash, adversaryStolenHash, 'Derived hash must be rotated upon PIN change');

  // Old PIN no longer works
  assert.strictEqual(await validatePin('1234'), false, 'Old PIN must no longer validate');
  assert.strictEqual(await validatePin('5678'), true, 'New PIN must validate');

  // Stolen record cannot validate against newly changed state
  assert.strictEqual(await verifyPinHash('5678', { salt: adversaryStolenSalt, hash: adversaryStolenHash, iterations: 1000 }), false);
});

test('Task 1.3: Adversary Input Injection & Boundary Attacks: Short, empty, whitespace, and injection inputs', async () => {
  // Disallowed PIN setups (< 4 characters)
  await assert.rejects(async () => setupPin(''), /at least 4 characters/);
  await assert.rejects(async () => setupPin('1'), /at least 4 characters/);
  await assert.rejects(async () => setupPin('12'), /at least 4 characters/);
  await assert.rejects(async () => setupPin('123'), /at least 4 characters/);

  // Valid setup
  await setupPin('9021', 1000);
  lockVault();

  // Adversary injection and edge case unlock attempts
  const maliciousInputs = [
    '',
    '1',
    '12',
    '123',
    ' ',
    '   ',
    "' OR '1'='1",
    'admin',
    '<script>alert(1)</script>',
    '\\x00\\x00\\x00',
    '9'.repeat(1000),
  ];

  for (const input of maliciousInputs) {
    const isValid = await validatePin(input);
    assert.strictEqual(isValid, false, `Malicious or invalid input '${input.substring(0, 10)}' must be rejected`);

    const unlocked = await unlockWithPin(input);
    assert.strictEqual(unlocked, false, 'Invalid input must never unlock vault');
    assert.strictEqual(isVaultLocked(), true, 'Vault must remain locked');
    assert.strictEqual(isMasterKeyLoaded(), false, 'Master key must remain purged from RAM');
  }
});

test('Task 1.4: Adversary Storage Tampering: Corrupted SecureStore records fail safely with zero leaks', async () => {
  await setupPin('7777', 1000);
  lockVault();

  // Case 1: Corrupted JSON syntax
  await saveSecureItem(PIN_AUTH_STORAGE_KEY, '{ invalid_json: true');
  assert.strictEqual(await validatePin('7777'), false, 'Corrupted JSON must safely return false');
  assert.strictEqual(await unlockWithPin('7777'), false);
  assert.strictEqual(isVaultLocked(), true);

  // Case 2: Tampered non-hex salt
  await saveSecureItem(PIN_AUTH_STORAGE_KEY, JSON.stringify({
    salt: 'ZZZZ_NOT_HEX_SALT_!!!',
    hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    iterations: 1000,
  }));
  assert.strictEqual(await validatePin('7777'), false, 'Invalid hex salt must safely return false without crashing');
  assert.strictEqual(await unlockWithPin('7777'), false);
  assert.strictEqual(isVaultLocked(), true);

  // Case 3: Tampered hash bit (single bit flip)
  await setupPin('7777', 1000);
  lockVault();
  const validJson = (await getSecureItem(PIN_AUTH_STORAGE_KEY))!;
  const parsed = JSON.parse(validJson);
  // Flip first character
  parsed.hash = (parsed.hash[0] === 'a' ? 'b' : 'a') + parsed.hash.substring(1);
  await saveSecureItem(PIN_AUTH_STORAGE_KEY, JSON.stringify(parsed));

  assert.strictEqual(await validatePin('7777'), false, 'Flipped hash bit must fail validation');
  assert.strictEqual(await unlockWithPin('7777'), false);
  assert.strictEqual(isVaultLocked(), true);
  assert.strictEqual(isMasterKeyLoaded(), false, 'Master key must not load after failed validation');
});

test('Task 1.5: Adversary Brute-Force Simulation: Rapid unauthorized guessing guarantees zero leaks and locked state persistence', async () => {
  const correctPin = '6149';
  await setupPin(correctPin, 1000);
  lockVault();

  assert.strictEqual(isVaultLocked(), true);
  assert.strictEqual(isMasterKeyLoaded(), false);

  // Simulate adversary executing rapid brute-force dictionary/sequential attempts
  const dictionary = [
    '0000', '1234', '1111', '2222', '3333', '4444', '5555', '6666',
    '7777', '8888', '9999', '1212', '2020', '1990', '1995', '2000',
    '1357', '2468', '9876', '4321', '0123', '6789', '2580', '1470',
    '3690', '7410', '8520', '9630', '1122', '3344', '5566', '7788',
  ];

  for (const guess of dictionary) {
    const success = await unlockWithPin(guess);
    assert.strictEqual(success, false, `Guess ${guess} must be rejected`);

    // Zero Leaks Guarantee: Master key is NEVER loaded into RAM during attack
    assert.strictEqual(isVaultLocked(), true, 'Vault must remain locked at every attempt');
    assert.strictEqual(isMasterKeyLoaded(), false, 'Master key must remain purged from RAM at every attempt');
    assert.throws(
      () => getActiveMasterKey(),
      /Master key is locked or not loaded in memory/,
      'getActiveMasterKey must throw at every attempt'
    );
  }

  // Legitimate user enters correct PIN after adversary brute-force sequence
  const legitUnlock = await unlockWithPin(correctPin);
  assert.strictEqual(legitUnlock, true, 'Correct PIN must unlock successfully');
  assert.strictEqual(isVaultLocked(), false, 'Vault must now be unlocked');
  assert.strictEqual(isMasterKeyLoaded(), true, 'Master key loaded for authorized user');
  assert.strictEqual(getActiveMasterKey().length, 32, 'Master key is 256 bits');
});

test('Task 1.6: Full State Transition Matrix: Unconfigured -> Configured -> Locked -> Unlocked -> Re-locked -> Reset', async () => {
  // S0: UNCONFIGURED
  assert.strictEqual(await isPinConfigured(), false);
  assert.strictEqual(isVaultLocked(), true);
  assert.strictEqual(isMasterKeyLoaded(), false);

  // S0 -> S1: SETUP_PIN
  await setupPin('4820', 1000);
  assert.strictEqual(await isPinConfigured(), true);
  assert.strictEqual(isVaultLocked(), false);
  assert.strictEqual(isMasterKeyLoaded(), true);
  const masterKey = getActiveMasterKey();

  // S1 -> S2: LOCK_VAULT
  lockVault();
  assert.strictEqual(isVaultLocked(), true);
  assert.strictEqual(isMasterKeyLoaded(), false);
  assert.throws(() => getActiveMasterKey(), /Master key is locked/);

  // S2 -> S2: FAILED UNLOCK (State unchanged)
  const failed = await unlockWithPin('9999');
  assert.strictEqual(failed, false);
  assert.strictEqual(isVaultLocked(), true);
  assert.strictEqual(isMasterKeyLoaded(), false);

  // S2 -> S3: SUCCESSFUL UNLOCK
  const succeeded = await unlockWithPin('4820');
  assert.strictEqual(succeeded, true);
  assert.strictEqual(isVaultLocked(), false);
  assert.strictEqual(isMasterKeyLoaded(), true);
  assert.deepStrictEqual(getActiveMasterKey(), masterKey, 'Master key must match original');

  // S3 -> S4: APPLOCK CONTROLLER INTERACTION
  await appLockController.init();
  assert.strictEqual(appLockController.getSnapshot().isLocked, true, 'AppLockController must lock on startup when PIN is configured');
  assert.strictEqual(isVaultLocked(), true);

  // Unlock via controller with PIN
  const ctrlUnlock = await appLockController.unlockWithPin('4820');
  assert.strictEqual(ctrlUnlock, true);
  assert.strictEqual(appLockController.getSnapshot().isLocked, false);
  assert.strictEqual(isVaultLocked(), false);

  // Lock via controller
  appLockController.lock();
  assert.strictEqual(appLockController.getSnapshot().isLocked, true);
  assert.strictEqual(isVaultLocked(), true);
  assert.strictEqual(isMasterKeyLoaded(), false);

  // Setup Duress PIN
  await setupDuressPin('9999', 1000);
  await appLockController.refreshState();

  // Unlock with Duress PIN: transitions UI to decoy mode, but keeps real vault LOCKED
  const duressUnlock = await appLockController.unlockWithPin('9999');
  assert.strictEqual(duressUnlock, true);
  assert.strictEqual(appLockController.getSnapshot().isLocked, false);
  assert.strictEqual(appLockController.getSnapshot().isDuressMode, true);
  assert.strictEqual(isVaultLocked(), true, 'Real vault must stay locked under duress');
  assert.strictEqual(isMasterKeyLoaded(), false, 'Master key must not load under duress');

  // Relock clears duress mode
  appLockController.lock();
  assert.strictEqual(appLockController.getSnapshot().isDuressMode, false);
  assert.strictEqual(appLockController.getSnapshot().isLocked, true);

  // S4 -> S0: RESET_SECURITY
  await resetSecurity();
  assert.strictEqual(await isPinConfigured(), false);
  assert.strictEqual(await isDuressPinConfigured(), false);
  assert.strictEqual(isVaultLocked(), true);
  assert.strictEqual(isMasterKeyLoaded(), false);
});

test('Task 1.7: Side-Channel & Memory Scrubbing: Constant-time verification and zero-leak memory wiping', () => {
  // Constant-time comparison checks length and byte mismatch resistance
  const a = new Uint8Array([1, 2, 3, 4, 5]);
  const b = new Uint8Array([1, 2, 3, 4, 5]);
  const c = new Uint8Array([1, 2, 3, 4, 6]);
  const d = new Uint8Array([1, 2, 3, 4]);

  assert.strictEqual(timingSafeEqual(a, b), true);
  assert.strictEqual(timingSafeEqual(a, c), false);
  assert.strictEqual(timingSafeEqual(a, d), false);

  // In-memory zeroing
  const sensitiveBuffer = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe]);
  wipeBuffer(sensitiveBuffer);
  assert.strictEqual(sensitiveBuffer.every((byte) => byte === 0), true, 'Buffer must be zeroed in-place');
});
