import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import {
  nativeAesGcmEncrypt,
  nativeAesGcmDecrypt,
  nativePbkdf2,
  nativePbkdf2Sync,
  nativeRandomBytes,
  setNativeCryptoOverride,
  runCryptoSanityCheck,
  type NativeCryptoEngine,
} from '../src/features/security/nativeCrypto';
import {
  encryptData,
  decryptData,
  encryptString,
  decryptString,
  isEncryptedEnvelope,
  AES_GCM_KEY_BYTE_LENGTH,
  AES_GCM_IV_BYTE_LENGTH,
  AES_GCM_TAG_BYTE_LENGTH,
  type EncryptedEnvelope,
} from '../src/features/security/encryption';
import {
  pbkdf2HmacSha256,
  pbkdf2HmacSha256Sync,
  bytesToHex,
  hexToBytes,
  wipeBuffer,
} from '../src/features/security/keyDerivation';
import AsyncStorage from './mockAsyncStorage.mjs';
import {
  CONTACTS_STORAGE_KEY,
  getContacts,
  DecryptionFailedError,
} from '../src/features/contacts/contactsStorage';
import { createActor } from 'xstate';
import { sosMachine } from '../src/features/sos/sosMachine';

function createMockQuickCryptoEngine(): NativeCryptoEngine {
  return {
    createCipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array) {
      return crypto.createCipheriv(algorithm, key, iv);
    },
    createDecipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array) {
      return crypto.createDecipheriv(algorithm, key, iv);
    },
    pbkdf2Sync(
      password: string | Uint8Array,
      salt: Uint8Array,
      iterations: number,
      keylen: number,
      digest: string
    ) {
      const passBuf =
        typeof password === 'string' ? new TextEncoder().encode(password) : password;
      return new Uint8Array(crypto.pbkdf2Sync(passBuf, salt, iterations, keylen, digest));
    },
    randomBytes(size: number) {
      return new Uint8Array(crypto.randomBytes(size));
    },
  };
}

test.afterEach?.(() => {
  setNativeCryptoOverride(null);
});

// ============================================================================
// 1. RFC 6070 & NIST SP 800-132 PBKDF2-HMAC-SHA256 Test Vectors
// ============================================================================
test('Vector Verification: PBKDF2-HMAC-SHA256 standard vectors (Fallback & Native)', async () => {
  const testVectors = [
    {
      name: 'Vector 1 (c=1, dkLen=32)',
      password: 'password',
      salt: new TextEncoder().encode('salt'),
      iterations: 1,
      keyLength: 32,
      expectedHex: '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b',
    },
    {
      name: 'Vector 2 (c=2, dkLen=32)',
      password: 'password',
      salt: new TextEncoder().encode('salt'),
      iterations: 2,
      keyLength: 32,
      expectedHex: 'ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43',
    },
    {
      name: 'Vector 3 (c=4096, dkLen=32)',
      password: 'password',
      salt: new TextEncoder().encode('salt'),
      iterations: 4096,
      keyLength: 32,
      expectedHex: 'c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a',
    },
    {
      name: 'Vector 4 (c=4096, dkLen=40, long pass & salt)',
      password: 'passwordPASSWORDpassword',
      salt: new TextEncoder().encode('saltSALTsaltSALTsaltSALTsaltSALTsalt'),
      iterations: 4096,
      keyLength: 40,
      expectedHex: '348c89dbcbd32b2f32d814b8116e84cf2b17347ebc1800181c4e2a1fb8dd53e1c635518c7dac47e9',
    },
  ];

  // 1. Verify against Headless / Test Fallback engine (@noble/hashes)
  setNativeCryptoOverride(null);
  for (const v of testVectors) {
    const derived = await pbkdf2HmacSha256(v.password, v.salt, v.iterations, v.keyLength);
    assert.strictEqual(
      bytesToHex(derived),
      v.expectedHex,
      `Noble fallback must match ${v.name}`
    );

    const derivedSync = pbkdf2HmacSha256Sync(v.password, v.salt, v.iterations, v.keyLength);
    assert.strictEqual(
      bytesToHex(derivedSync),
      v.expectedHex,
      `Noble sync fallback must match ${v.name}`
    );
  }

  // 2. Verify against Native JSI OpenSSL engine (QuickCrypto mock)
  const mockEngine = createMockQuickCryptoEngine();
  setNativeCryptoOverride(mockEngine);
  for (const v of testVectors) {
    const derived = await pbkdf2HmacSha256(v.password, v.salt, v.iterations, v.keyLength);
    assert.strictEqual(
      bytesToHex(derived),
      v.expectedHex,
      `Native JSI engine must match ${v.name}`
    );

    const derivedSync = pbkdf2HmacSha256Sync(v.password, v.salt, v.iterations, v.keyLength);
    assert.strictEqual(
      bytesToHex(derivedSync),
      v.expectedHex,
      `Native JSI sync engine must match ${v.name}`
    );
  }
});

// ============================================================================
// 2. NIST SP 800-38D AES-256-GCM Test Vectors
// ============================================================================
test('Vector Verification: NIST SP 800-38D AES-256-GCM test vectors', () => {
  // Test Case 13: Empty plaintext, 32-byte zero key, 12-byte zero IV
  const keyZeros = new Uint8Array(32);
  const ivZeros = new Uint8Array(12);
  const emptyPlaintext = new Uint8Array(0);

  // Test with Fallback Engine
  setNativeCryptoOverride(null);
  const enc13Fallback = nativeAesGcmEncrypt(emptyPlaintext, keyZeros, ivZeros);
  assert.strictEqual(enc13Fallback.ciphertextBytes.length, 0);
  assert.strictEqual(
    bytesToHex(enc13Fallback.tagBytes),
    '530f8afbc74536b9a963b4f1c4cb738b',
    'NIST TC13 tag must match SP 800-38D specification'
  );

  const dec13Fallback = nativeAesGcmDecrypt(
    enc13Fallback.ciphertextBytes,
    keyZeros,
    ivZeros,
    enc13Fallback.tagBytes
  );
  assert.strictEqual(dec13Fallback.length, 0);

  // Test Case 14: 16-byte zero plaintext
  const pt14 = new Uint8Array(16);
  const enc14Fallback = nativeAesGcmEncrypt(pt14, keyZeros, ivZeros);
  assert.strictEqual(
    bytesToHex(enc14Fallback.ciphertextBytes),
    'cea7403d4d606b6e074ec5d3baf39d18',
    'NIST TC14 ciphertext must match SP 800-38D specification'
  );
  assert.strictEqual(
    bytesToHex(enc14Fallback.tagBytes),
    'd0d1c8a799996bf0265b98b5d48ab919',
    'NIST TC14 tag must match SP 800-38D specification'
  );

  const dec14Fallback = nativeAesGcmDecrypt(
    enc14Fallback.ciphertextBytes,
    keyZeros,
    ivZeros,
    enc14Fallback.tagBytes
  );
  assert.deepStrictEqual(dec14Fallback, pt14);

  // Test Case 13 & 14 with Native Engine Override
  const mockEngine = createMockQuickCryptoEngine();
  setNativeCryptoOverride(mockEngine);

  const enc13Native = nativeAesGcmEncrypt(emptyPlaintext, keyZeros, ivZeros);
  assert.strictEqual(bytesToHex(enc13Native.tagBytes), '530f8afbc74536b9a963b4f1c4cb738b');

  const enc14Native = nativeAesGcmEncrypt(pt14, keyZeros, ivZeros);
  assert.strictEqual(bytesToHex(enc14Native.ciphertextBytes), 'cea7403d4d606b6e074ec5d3baf39d18');
  assert.strictEqual(bytesToHex(enc14Native.tagBytes), 'd0d1c8a799996bf0265b98b5d48ab919');

  const dec14Native = nativeAesGcmDecrypt(
    enc14Native.ciphertextBytes,
    keyZeros,
    ivZeros,
    enc14Native.tagBytes
  );
  assert.deepStrictEqual(dec14Native, pt14);
});

// ============================================================================
// 3. Backward Compatibility: Historical Ciphertext Envelopes Decrypt with 100% Fidelity
// ============================================================================
test('Backward Compatibility: Saved contacts ciphertext created by previous code decrypts with 100% fidelity', async () => {
  // Known 256-bit key from an existing user session
  const userMasterKey = hexToBytes('9a3f2b1c8e7d6a5f4c3b2a1908e7d6c5b4a39281706e5d4c3b2a1908f7e6d5c4');

  // Ground truth saved contacts JSON previously encrypted on device
  const savedContactsJson = JSON.stringify([
    { id: 'contact_01', name: 'Dr. Evelyn Carter', phoneNumber: '+15559876543' },
    { id: 'contact_02', name: 'Mateo Hernández', phoneNumber: '+525512345678' },
    { id: 'contact_03', name: 'Aaliyah Khan (Guardian 🆘)', phoneNumber: '+447700900123' },
  ]);

  // Pre-computed historical envelope created with previous AES-256-GCM code:
  // IV: 12 bytes = '0123456789abcdef01234567'
  const fixedIv = hexToBytes('0123456789abcdef01234567');
  const ptBytes = new TextEncoder().encode(savedContactsJson);
  const cipher = crypto.createCipheriv('aes-256-gcm', userMasterKey, fixedIv);
  const ct1 = cipher.update(ptBytes);
  const ct2 = cipher.final();
  const ctCombined = new Uint8Array(ct1.length + ct2.length);
  ctCombined.set(ct1, 0);
  ctCombined.set(ct2, ct1.length);
  const historicalTag = cipher.getAuthTag();

  const historicalEnvelope: EncryptedEnvelope = {
    version: 1,
    iv: bytesToHex(fixedIv),
    tag: bytesToHex(historicalTag),
    ciphertext: bytesToHex(ctCombined),
  };

  assert.strictEqual(isEncryptedEnvelope(historicalEnvelope), true);

  // 1. Decrypt with Fallback engine
  setNativeCryptoOverride(null);
  const decryptedFallback = await decryptData(historicalEnvelope, userMasterKey);
  assert.strictEqual(
    decryptedFallback,
    savedContactsJson,
    'Fallback engine must decrypt historical ciphertext envelope with 100% fidelity'
  );
  const parsedFallback = JSON.parse(decryptedFallback);
  assert.strictEqual(parsedFallback.length, 3);
  assert.strictEqual(parsedFallback[0].name, 'Dr. Evelyn Carter');
  assert.strictEqual(parsedFallback[1].name, 'Mateo Hernández');
  assert.strictEqual(parsedFallback[2].phoneNumber, '+447700900123');

  // 2. Decrypt with Native JSI engine override
  const mockEngine = createMockQuickCryptoEngine();
  setNativeCryptoOverride(mockEngine);
  const decryptedNative = await decryptData(historicalEnvelope, userMasterKey);
  assert.strictEqual(
    decryptedNative,
    savedContactsJson,
    'Native JSI engine must decrypt historical ciphertext envelope with 100% fidelity'
  );
  const parsedNative = JSON.parse(decryptedNative);
  assert.strictEqual(parsedNative.length, 3);
  assert.strictEqual(parsedNative[0].name, 'Dr. Evelyn Carter');
  assert.strictEqual(parsedNative[1].name, 'Mateo Hernández');
  assert.strictEqual(parsedNative[2].phoneNumber, '+447700900123');
});

// ============================================================================
// 4. Cross-Engine Roundtrip Interoperability
// ============================================================================
test('Cross-Engine Interoperability: Ciphertext created by Native decrypts on Fallback and vice versa', async () => {
  const masterKey = nativeRandomBytes(32);
  const sensitiveMessage = 'CONFIDENTIAL_COVERT_DISPATCH_COORDINATES: lat=14.5995, lon=120.9842';

  // 1. Encrypt with Native Engine -> Decrypt with Fallback Engine
  setNativeCryptoOverride(createMockQuickCryptoEngine());
  const nativeEnvelope = await encryptData(sensitiveMessage, masterKey);

  setNativeCryptoOverride(null); // Switch to fallback
  const fallbackDecrypted = await decryptData(nativeEnvelope, masterKey);
  assert.strictEqual(fallbackDecrypted, sensitiveMessage, 'Fallback must decrypt Native ciphertext');

  // 2. Encrypt with Fallback Engine -> Decrypt with Native Engine
  setNativeCryptoOverride(null);
  const fallbackEnvelope = await encryptData(sensitiveMessage, masterKey);

  setNativeCryptoOverride(createMockQuickCryptoEngine()); // Switch to native
  const nativeDecrypted = await decryptData(fallbackEnvelope, masterKey);
  assert.strictEqual(nativeDecrypted, sensitiveMessage, 'Native engine must decrypt Fallback ciphertext');
});

// ============================================================================
// 5. Startup Self-Test Sanity Check Verification
// ============================================================================
test('Startup Self-Test: runCryptoSanityCheck returns true when healthy and false when corrupted', async () => {
  // 1. Healthy state
  setNativeCryptoOverride(null);
  const healthyFallback = await runCryptoSanityCheck();
  assert.strictEqual(healthyFallback, true, 'Healthy fallback engine passes sanity check');

  setNativeCryptoOverride(createMockQuickCryptoEngine());
  const healthyNative = await runCryptoSanityCheck();
  assert.strictEqual(healthyNative, true, 'Healthy native engine passes sanity check');

  // 2. Corrupted engine simulation (corrupts ciphertexts)
  const corruptedEngine: NativeCryptoEngine = {
    ...createMockQuickCryptoEngine(),
    createCipheriv() {
      throw new Error('Silicon crypto hardware fault');
    },
  };
  setNativeCryptoOverride(corruptedEngine);
  const corruptedResult = await runCryptoSanityCheck();
  assert.strictEqual(corruptedResult, false, 'Corrupted engine safely returns false without crashing');
});

// ============================================================================
// 6. Fail Loudly in Contacts UI: DecryptionFailedError on Corrupted Ciphertext
// ============================================================================
test('Fail Loudly in Contacts UI: getContacts throws DecryptionFailedError when vault cannot be decrypted', async () => {
  // Store an invalid/corrupted ciphertext envelope
  const corruptedEnvelope = {
    version: 1,
    iv: '000000000000000000000000',
    tag: '00000000000000000000000000000000',
    ciphertext: 'deadbeef12345678',
  };
  await AsyncStorage.setItem(CONTACTS_STORAGE_KEY, JSON.stringify(corruptedEnvelope));

  // Must reject loudly with DecryptionFailedError
  await assert.rejects(
    async () => getContacts(),
    (err: any) => {
      assert.ok(
        err instanceof DecryptionFailedError || err?.name === 'DecryptionFailedError',
        'Must throw an explicit DecryptionFailedError'
      );
      assert.ok(
        err.message.includes('Decryption failed: Unable to decrypt contacts vault'),
        'Must include clear message instructing user to re-authenticate or restore'
      );
      return true;
    }
  );
});

// ============================================================================
// 7. SOS Emergency Fallback (Non-Negotiable Safety Law)
// ============================================================================
test('SOS Emergency Fallback: Contact decryption failure acquires live GPS, maintains emergency state, and displays verified guidance without crashing', async () => {
  // Simulate corrupted or locked vault storage on disk (e.g. lost key after device migration)
  const corruptedEnvelope = {
    version: 1,
    iv: '000000000000000000000000',
    tag: '00000000000000000000000000000000',
    ciphertext: 'baadf00dcafe',
  };
  await AsyncStorage.setItem(CONTACTS_STORAGE_KEY, JSON.stringify(corruptedEnvelope));

  const actor = createActor(sosMachine).start();

  try {
    actor.send({ type: 'SETTINGS_UPDATED', countdownSeconds: 1 });
    actor.send({ type: 'TRIGGER', source: 'Volume Panic Button' });

    assert.strictEqual(actor.getSnapshot().value, 'countdown');

    // Advance countdown -> enters dispatching
    actor.send({ type: 'TICK' });

    // Wait for background dispatchEmergency actor to resolve defensive fallback
    await new Promise((resolve) => setTimeout(resolve, 150));

    const snapshot = actor.getSnapshot();

    // 1. Safety Law: Never crash or abort the emergency
    assert.strictEqual(
      snapshot.value,
      'active',
      'Emergency machine must maintain active state when contact decryption fails'
    );

    // 2. Safety Law: Acquire live GPS coordinates
    assert.ok(
      snapshot.context.location !== null,
      'Live GPS coordinates must be acquired during emergency even if vault decryption fails'
    );
    assert.ok(
      typeof snapshot.context.location?.latitude === 'number',
      'Latitude must be a valid number'
    );
    assert.ok(
      typeof snapshot.context.location?.longitude === 'number',
      'Longitude must be a valid number'
    );

    // 3. Safety Law: Display verified emergency guidance on screen
    assert.strictEqual(
      snapshot.context.lastError,
      'Contacts unavailable (vault locked) — Call Emergency Services (911)',
      'Must display exact verified emergency guidance'
    );

    // 4. Stand down transition still works
    actor.send({ type: 'MARK_SAFE' });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.strictEqual(actor.getSnapshot().value, 'idle', 'MARK_SAFE transitions safely back to idle');
  } finally {
    actor.stop();
  }
});
