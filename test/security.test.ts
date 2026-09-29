import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { resetMockSecureStore } from './mockExpo.mjs';
import {
  DEFAULT_PBKDF2_ITERATIONS,
  DEFAULT_SALT_BYTES,
  DEFAULT_KEY_BYTES,
  generateRandomBytes,
  generateSalt,
  bytesToHex,
  hexToBytes,
  timingSafeEqual,
  wipeBuffer,
  wipeBuffers,
  sha256,
  hmacSha256,
  pbkdf2HmacSha256Sync,
  pbkdf2HmacSha256,
  deriveKeyFromPin,
  hashPin,
  verifyPinHash,
  saveSecureItem,
  getSecureItem,
  deleteSecureItem,
  isSecureStorageAvailable,
  generateMasterKey,
  getOrCreateMasterKey,
  loadMasterKey,
  getActiveMasterKey,
  isMasterKeyLoaded,
  hasMasterKey,
  withMasterKey,
  wipeMasterKeyMemory,
  deleteMasterKey,
  setupPin,
  validatePin,
  unlockWithPin,
  lockVault,
  isVaultLocked,
  isPinConfigured,
  changePin,
  resetSecurity,
} from '../src/features/security';

test.beforeEach(() => {
  resetMockSecureStore();
  wipeMasterKeyMemory();
  lockVault();
});

test('1. Hardware-backed SecureStore (Android Keystore / TEE) storage operations', async () => {
  const isAvailable = await isSecureStorageAvailable();
  assert.strictEqual(isAvailable, true, 'Secure storage must report available');

  const testKey = 'test_keystore_alias';
  const testVal = 'hardware_protected_secret_data';

  // Initially empty
  const initial = await getSecureItem(testKey);
  assert.strictEqual(initial, null, 'Key must initially be null');

  // Persist
  await saveSecureItem(testKey, testVal);
  const retrieved = await getSecureItem(testKey);
  assert.strictEqual(retrieved, testVal, 'Retrieved value must match persisted secret');

  // Delete
  await deleteSecureItem(testKey);
  const afterDelete = await getSecureItem(testKey);
  assert.strictEqual(afterDelete, null, 'Deleted key must resolve to null');
});

test('2. Hardware-backed 256-bit AES master key generation & persistence', async () => {
  assert.strictEqual(await hasMasterKey(), false, 'Master key must not exist initially');

  const key1 = await generateMasterKey();
  assert.strictEqual(key1 instanceof Uint8Array, true, 'Master key must be a Uint8Array');
  assert.strictEqual(key1.length, 32, 'Master key must be exactly 32 bytes (256-bit AES)');
  assert.strictEqual(await hasMasterKey(), true, 'Master key must be persisted in SecureStore');
  assert.strictEqual(isMasterKeyLoaded(), true, 'Master key must be loaded in memory');

  // getOrCreateMasterKey must return existing key without regenerating
  const retrievedKey = await getOrCreateMasterKey();
  assert.deepStrictEqual(retrievedKey, key1, 'getOrCreateMasterKey must return the existing 256-bit key');

  // Delete master key cleans up storage and memory
  await deleteMasterKey();
  assert.strictEqual(await hasMasterKey(), false, 'Master key must be removed from storage');
  assert.strictEqual(isMasterKeyLoaded(), false, 'Master key must be unloaded from memory');
});

test('3. Cryptographic randomness: successive 256-bit keys and salts are unique', () => {
  const key1 = generateRandomBytes(32);
  const key2 = generateRandomBytes(32);
  assert.notDeepStrictEqual(key1, key2, 'Generated 256-bit keys must be cryptographically distinct');

  const salt1 = generateSalt(DEFAULT_SALT_BYTES);
  const salt2 = generateSalt(DEFAULT_SALT_BYTES);
  assert.strictEqual(salt1.length, 32, 'Salt length must be 32 bytes (256 bits)');
  assert.notDeepStrictEqual(salt1, salt2, 'Successive salts must be unique');
});

test('4. PBKDF2-HMAC-SHA256 key stretching: RFC/Node standard compliance', async () => {
  const pin = '4829';
  const salt = new TextEncoder().encode('erica_device_salt_99');
  const iterations = 10_000;
  const keyLength = 32;

  // Compute via our PBKDF2
  const derived = await pbkdf2HmacSha256(pin, salt, iterations, keyLength);

  // Compute reference via Node crypto
  const expected = crypto.pbkdf2Sync(pin, salt, iterations, keyLength, 'sha256');

  assert.strictEqual(
    bytesToHex(derived),
    expected.toString('hex'),
    'PBKDF2-HMAC-SHA256 must match standard crypto derivation exactly'
  );

  // Pure TS sync implementation must also match
  const syncDerived = pbkdf2HmacSha256Sync(pin, salt, iterations, keyLength);
  assert.strictEqual(
    bytesToHex(syncDerived),
    expected.toString('hex'),
    'Pure TS synchronous PBKDF2 must match standard crypto derivation exactly'
  );
});

test('5. Salt uniqueness: Identical PINs produce completely different stretched hashes', async () => {
  const pin = '135790';

  const record1 = await hashPin(pin, undefined, 1000);
  const record2 = await hashPin(pin, undefined, 1000);

  assert.notStrictEqual(record1.salt, record2.salt, 'Salts must be randomly generated and distinct');
  assert.notStrictEqual(record1.hash, record2.hash, 'Stretched hashes must differ, preventing rainbow table attacks');

  // Both records must correctly validate their respective PIN
  assert.strictEqual(await verifyPinHash(pin, record1), true, 'Record 1 must validate PIN');
  assert.strictEqual(await verifyPinHash(pin, record2), true, 'Record 2 must validate PIN');
  assert.strictEqual(await verifyPinHash('wrong_pin', record1), false, 'Incorrect PIN must fail validation');
});

test('6. Constant-time comparison (timingSafeEqual) side-channel protection', () => {
  const buf1 = new Uint8Array([10, 20, 30, 40, 50]);
  const buf2 = new Uint8Array([10, 20, 30, 40, 50]);
  const buf3 = new Uint8Array([10, 20, 30, 40, 99]);
  const buf4 = new Uint8Array([10, 20, 30, 40]);

  assert.strictEqual(timingSafeEqual(buf1, buf2), true, 'Identical buffers must return true');
  assert.strictEqual(timingSafeEqual(buf1, buf3), false, 'Different buffers must return false');
  assert.strictEqual(timingSafeEqual(buf1, buf4), false, 'Different length buffers must return false');
});

test('7. Security Rule: In-memory buffer wiping zeroes sensitive key material', async () => {
  const buffer = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  wipeBuffer(buffer);
  assert.strictEqual(
    buffer.every((byte) => byte === 0),
    true,
    'wipeBuffer must overwrite all bytes with 0'
  );

  const b1 = new Uint8Array([10, 20]);
  const b2 = new Uint8Array([30, 40]);
  wipeBuffers(b1, b2);
  assert.strictEqual(b1.every((b) => b === 0) && b2.every((b) => b === 0), true);

  // Test master key in-memory wiping upon locking
  await generateMasterKey();
  assert.strictEqual(isMasterKeyLoaded(), true);

  // Calling wipeMasterKeyMemory must zero out the buffer and set to null
  wipeMasterKeyMemory();
  assert.strictEqual(isMasterKeyLoaded(), false, 'Master key must be unloaded after wipeMasterKeyMemory');
  assert.throws(
    () => getActiveMasterKey(),
    /Master key is locked/,
    'getActiveMasterKey must throw when master key is wiped/locked'
  );
});

test('8. Scoped withMasterKey cleanly wipes transient memory upon completion and error', async () => {
  await generateMasterKey();
  wipeMasterKeyMemory(); // Lock memory

  let keyCapture: Uint8Array | null = null;
  const result = await withMasterKey(async (key) => {
    keyCapture = key;
    assert.strictEqual(key.length, 32, 'Master key inside scope must be 32 bytes');
    return 'scoped_operation_success';
  });

  assert.strictEqual(result, 'scoped_operation_success');
  // Verify that keyCapture buffer was wiped immediately upon exit from withMasterKey
  assert.strictEqual(
    keyCapture !== null && (keyCapture as Uint8Array).every((b) => b === 0),
    true,
    'Transient master key buffer passed to withMasterKey must be wiped after completion'
  );

  // Verify wiping occurs even if operation throws
  let errorKeyCapture: Uint8Array | null = null;
  await assert.rejects(
    async () => {
      await withMasterKey(async (key) => {
        errorKeyCapture = key;
        throw new Error('Operation failed intentionally');
      });
    },
    /Operation failed intentionally/
  );

  assert.strictEqual(
    errorKeyCapture !== null && (errorKeyCapture as Uint8Array).every((b) => b === 0),
    true,
    'Transient master key buffer passed to withMasterKey must be wiped even when operation throws'
  );
});

test('9. Full PIN setup, key stretching, lock, and unlock lifecycle', async () => {
  assert.strictEqual(await isPinConfigured(), false, 'PIN must not be configured initially');
  assert.strictEqual(isVaultLocked(), true, 'Vault must start in locked state');

  // Setup PIN with 10,000 iterations for test speed
  await setupPin('7249', 10_000);
  assert.strictEqual(await isPinConfigured(), true, 'PIN must now be configured');
  assert.strictEqual(isVaultLocked(), false, 'Vault must be unlocked after setup');
  assert.strictEqual(isMasterKeyLoaded(), true, 'Master key must be loaded in memory');

  const originalMasterKey = getActiveMasterKey();

  // Lock vault
  lockVault();
  assert.strictEqual(isVaultLocked(), true, 'Vault must be locked after lockVault()');
  assert.strictEqual(isMasterKeyLoaded(), false, 'Master key must be wiped from memory on lock');

  // Attempt unlock with wrong PIN
  const wrongUnlock = await unlockWithPin('0000');
  assert.strictEqual(wrongUnlock, false, 'Unlock with wrong PIN must return false');
  assert.strictEqual(isVaultLocked(), true, 'Vault must remain locked after wrong PIN');
  assert.strictEqual(isMasterKeyLoaded(), false, 'Master key must remain wiped after wrong PIN');

  // Unlock with correct PIN
  const correctUnlock = await unlockWithPin('7249');
  assert.strictEqual(correctUnlock, true, 'Unlock with correct PIN must return true');
  assert.strictEqual(isVaultLocked(), false, 'Vault must be unlocked after correct PIN');
  assert.strictEqual(isMasterKeyLoaded(), true, 'Master key must be loaded after correct PIN');

  const restoredMasterKey = getActiveMasterKey();
  assert.deepStrictEqual(restoredMasterKey, originalMasterKey, 'Master key after unlock must match original key');
});

test('10. PIN Change with salt rotation and Security Reset', async () => {
  await setupPin('1111', 10_000);

  // Stored record before change
  const record1Json = (await getSecureItem('erica_pin_auth_record_v1'))!;
  const record1 = JSON.parse(record1Json);

  // Attempt change with wrong old PIN
  const failedChange = await changePin('9999', '2222', 10_000);
  assert.strictEqual(failedChange, false, 'changePin must fail with incorrect old PIN');

  // Successful change
  const successChange = await changePin('1111', '2222', 10_000);
  assert.strictEqual(successChange, true, 'changePin must succeed with correct old PIN');

  const record2Json = (await getSecureItem('erica_pin_auth_record_v1'))!;
  const record2 = JSON.parse(record2Json);

  assert.notStrictEqual(record1.salt, record2.salt, 'Changing PIN must rotate the salt');
  assert.strictEqual(await validatePin('2222'), true, 'New PIN must be valid');
  assert.strictEqual(await validatePin('1111'), false, 'Old PIN must no longer be valid');

  // Reset security wipes everything
  await resetSecurity();
  assert.strictEqual(await isPinConfigured(), false, 'PIN must not be configured after reset');
  assert.strictEqual(await hasMasterKey(), false, 'Master key must not exist after reset');
  assert.strictEqual(isVaultLocked(), true, 'Vault must be locked after reset');
});
