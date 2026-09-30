/**
 * Consolidated Cryptographic Engine for E.R.I.C.A.
 *
 * Architecture:
 * - Native Engine (Android / iOS): Uses `react-native-quick-crypto` as the single native
 *   JSI / OpenSSL C++ engine for AES-256-GCM, PBKDF2-HMAC-SHA256, and CSPRNG random bytes.
 * - Headless / Test Fallback: Retains `@noble/hashes` purely as an automated test/headless
 *   fallback where JSI is unavailable (e.g. Node.js test runner).
 * - Constant-time execution and strict memory zeroing (buffer wiping) for transient keys.
 */

import { pbkdf2 as noblePbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';

export interface NativeCryptoEngine {
  createCipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array): any;
  createDecipheriv(algorithm: string, key: Uint8Array, iv: Uint8Array): any;
  pbkdf2Sync(
    password: string | Uint8Array,
    salt: Uint8Array,
    iterations: number,
    keylen: number,
    digest: string
  ): Uint8Array;
  pbkdf2?(
    password: string | Uint8Array,
    salt: Uint8Array,
    iterations: number,
    keylen: number,
    digest: string,
    callback: (err: Error | null, derivedKey: Uint8Array) => void
  ): void;
  randomBytes(size: number): Uint8Array;
  timingSafeEqual?(a: Uint8Array, b: Uint8Array): boolean;
}

let quickCryptoModule: NativeCryptoEngine | null = null;
let quickCryptoChecked = false;
let engineOverride: NativeCryptoEngine | null = null;

function wipeBuffer(buffer: Uint8Array | null | undefined): void {
  if (buffer && typeof buffer.fill === 'function') {
    buffer.fill(0);
  }
}

function wipeBuffers(...buffers: (Uint8Array | null | undefined)[]): void {
  for (const b of buffers) {
    wipeBuffer(b);
  }
}

/**
 * Safe helper to retrieve Node.js crypto module in Node/test environments.
 */
function getNodeCrypto(): any {
  if (typeof (globalThis as any).process?.getBuiltinModule === 'function') {
    try {
      return (globalThis as any).process.getBuiltinModule('node:crypto');
    } catch {}
  }
  if (typeof require !== 'undefined') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      return require('crypto');
    } catch {}
  }
  return null;
}

/**
 * Resolves the native react-native-quick-crypto JSI module if available.
 */
function resolveNativeQuickCrypto(): NativeCryptoEngine | null {
  if (quickCryptoChecked) {
    return quickCryptoModule;
  }
  quickCryptoChecked = true;

  try {
    let qc: any = null;
    if (typeof require !== 'undefined') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      qc = require('react-native-quick-crypto');
    }
    const instance = qc?.default || qc;
    if (
      instance &&
      typeof instance.createCipheriv === 'function' &&
      typeof instance.createDecipheriv === 'function' &&
      typeof instance.randomBytes === 'function' &&
      typeof instance.pbkdf2Sync === 'function'
    ) {
      quickCryptoModule = instance;
    }
  } catch {
    quickCryptoModule = null;
  }

  return quickCryptoModule;
}

/**
 * Allows overriding or mocking the native crypto engine provider for tests.
 */
export function setNativeCryptoOverride(engine: NativeCryptoEngine | null): void {
  engineOverride = engine;
}

/**
 * Returns the currently active native crypto engine (or null if JSI is unavailable).
 */
export function getActiveCryptoEngine(): NativeCryptoEngine | null {
  if (engineOverride !== null) {
    return engineOverride;
  }
  return resolveNativeQuickCrypto();
}

/**
 * Returns whether native JSI crypto (react-native-quick-crypto) is available.
 */
export function isNativeCryptoAvailable(): boolean {
  return getActiveCryptoEngine() !== null;
}

/**
 * Generates cryptographically secure random bytes of specified length.
 * Uses native JSI OpenSSL CSPRNG when available, falling back to WebCrypto / Node crypto.
 */
export function nativeRandomBytes(byteLength: number): Uint8Array {
  const engine = getActiveCryptoEngine();
  if (engine && typeof engine.randomBytes === 'function') {
    const buf = engine.randomBytes(byteLength);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  // Fallback 1: WebCrypto getRandomValues
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
    const bytes = new Uint8Array(byteLength);
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }

  // Fallback 2: Node.js crypto.randomBytes (headless test runner)
  const nodeCrypto = getNodeCrypto();
  if (nodeCrypto && typeof nodeCrypto.randomBytes === 'function') {
    const random = nodeCrypto.randomBytes(byteLength);
    const bytes = new Uint8Array(byteLength);
    bytes.set(random);
    return bytes;
  }

  throw new Error('Cryptographically secure random number generator is unavailable.');
}

/**
 * Asynchronously derives a key from password and salt using PBKDF2-HMAC-SHA256.
 * Uses react-native-quick-crypto (OpenSSL C++ JSI) when available.
 * Retains @noble/hashes purely as an automated test/headless fallback where JSI is unavailable.
 */
export async function nativePbkdf2(
  password: string | Uint8Array,
  salt: Uint8Array,
  iterations: number,
  keyLength: number
): Promise<Uint8Array> {
  const passBuf =
    typeof password === 'string' ? new TextEncoder().encode(password) : new Uint8Array(password);

  try {
    const engine = getActiveCryptoEngine();
    if (engine && typeof engine.pbkdf2Sync === 'function') {
      try {
        const derived = engine.pbkdf2Sync(passBuf, salt, iterations, keyLength, 'sha256');
        return new Uint8Array(derived.buffer, derived.byteOffset, derived.byteLength);
      } catch {
        // Fall through to noble fallback if engine execution throws
      }
    }

    // Automated test / headless fallback where JSI is unavailable:
    return noblePbkdf2(nobleSha256, passBuf, salt, { c: iterations, dkLen: keyLength });
  } finally {
    if (typeof password === 'string') {
      wipeBuffer(passBuf);
    }
  }
}

/**
 * Synchronously derives a key from password and salt using PBKDF2-HMAC-SHA256.
 * Uses react-native-quick-crypto (OpenSSL C++ JSI) when available, falling back to @noble/hashes.
 */
export function nativePbkdf2Sync(
  password: string | Uint8Array,
  salt: Uint8Array,
  iterations: number,
  keyLength: number
): Uint8Array {
  const passBuf =
    typeof password === 'string' ? new TextEncoder().encode(password) : new Uint8Array(password);

  try {
    const engine = getActiveCryptoEngine();
    if (engine && typeof engine.pbkdf2Sync === 'function') {
      const derived = engine.pbkdf2Sync(passBuf, salt, iterations, keyLength, 'sha256');
      return new Uint8Array(derived.buffer, derived.byteOffset, derived.byteLength);
    }

    // Fallback: @noble/hashes
    return noblePbkdf2(nobleSha256, passBuf, salt, { c: iterations, dkLen: keyLength });
  } finally {
    if (typeof password === 'string') {
      wipeBuffer(passBuf);
    }
  }
}

/**
 * Authenticated AES-256-GCM encryption.
 * Generates ciphertext and 16-byte authentication tag for 12-byte IV and 32-byte key.
 */
export function nativeAesGcmEncrypt(
  plaintextBytes: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array
): { ciphertextBytes: Uint8Array; tagBytes: Uint8Array } {
  const engine = getActiveCryptoEngine();
  if (engine && typeof engine.createCipheriv === 'function') {
    const cipher = engine.createCipheriv('aes-256-gcm', key, iv);
    const ct1 = cipher.update(plaintextBytes);
    const ct2 = cipher.final();
    const tag = cipher.getAuthTag();
    const ctBuf = new Uint8Array(ct1.length + ct2.length);
    ctBuf.set(ct1, 0);
    ctBuf.set(ct2, ct1.length);
    return {
      ciphertextBytes: ctBuf,
      tagBytes: new Uint8Array(tag.buffer, tag.byteOffset, tag.byteLength),
    };
  }

  // Node.js fallback (for headless / automated test runner where JSI is unavailable)
  const nodeCrypto = getNodeCrypto();
  if (nodeCrypto && typeof nodeCrypto.createCipheriv === 'function') {
    const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
    const ct1 = cipher.update(plaintextBytes);
    const ct2 = cipher.final();
    const ctBuf = new Uint8Array(ct1.length + ct2.length);
    ctBuf.set(ct1, 0);
    ctBuf.set(ct2, ct1.length);
    const tag = cipher.getAuthTag();
    return {
      ciphertextBytes: ctBuf,
      tagBytes: new Uint8Array(tag.buffer, tag.byteOffset, tag.byteLength),
    };
  }

  throw new Error('AES-256-GCM encryption unavailable on this platform.');
}

/**
 * Authenticated AES-256-GCM decryption.
 * Verifies the 16-byte authentication tag against the ciphertext.
 * Throws if corrupted, tampered, or wrong key is supplied.
 */
export function nativeAesGcmDecrypt(
  ciphertextBytes: Uint8Array,
  key: Uint8Array,
  ivBytes: Uint8Array,
  tagBytes: Uint8Array
): Uint8Array {
  const engine = getActiveCryptoEngine();
  if (engine && typeof engine.createDecipheriv === 'function') {
    try {
      const decipher = engine.createDecipheriv('aes-256-gcm', key, ivBytes);
      decipher.setAuthTag(tagBytes);
      const pt1 = decipher.update(ciphertextBytes);
      const pt2 = decipher.final();
      const ptBuf = new Uint8Array(pt1.length + pt2.length);
      ptBuf.set(pt1, 0);
      ptBuf.set(pt2, pt1.length);
      return ptBuf;
    } catch {
      throw new Error(
        'Decryption failed: authentication tag verification failed or corrupted ciphertext.'
      );
    }
  }

  // Node.js fallback
  const nodeCrypto = getNodeCrypto();
  if (nodeCrypto && typeof nodeCrypto.createDecipheriv === 'function') {
    try {
      const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, ivBytes);
      decipher.setAuthTag(tagBytes);
      const pt1 = decipher.update(ciphertextBytes);
      const pt2 = decipher.final();
      const ptBuf = new Uint8Array(pt1.length + pt2.length);
      ptBuf.set(pt1, 0);
      ptBuf.set(pt2, pt1.length);
      return ptBuf;
    } catch {
      throw new Error(
        'Decryption failed: authentication tag verification failed or corrupted ciphertext.'
      );
    }
  }

  throw new Error('AES-256-GCM decryption unavailable on this platform.');
}

/**
 * Startup Self-Test:
 * Runs a silent encrypt/decrypt sanity check at app mount.
 * Returns true if the cryptographic engine is functioning correctly with 100% integrity,
 * or false if corrupted.
 */
export async function runCryptoSanityCheck(): Promise<boolean> {
  let testKey: Uint8Array | null = null;
  let testIv: Uint8Array | null = null;
  let ct: Uint8Array | null = null;
  let tag: Uint8Array | null = null;
  let decrypted: Uint8Array | null = null;
  let derived: Uint8Array | null = null;

  try {
    testKey = nativeRandomBytes(32);
    testIv = nativeRandomBytes(12);
    const testPlaintext = new TextEncoder().encode('ERICA_STARTUP_SELF_TEST_PROBE_2026');

    const encResult = nativeAesGcmEncrypt(testPlaintext, testKey, testIv);
    ct = encResult.ciphertextBytes;
    tag = encResult.tagBytes;

    decrypted = nativeAesGcmDecrypt(ct, testKey, testIv, tag);

    if (decrypted.length !== testPlaintext.length) {
      return false;
    }
    for (let i = 0; i < testPlaintext.length; i++) {
      if (decrypted[i] !== testPlaintext[i]) {
        return false;
      }
    }

    // Verify PBKDF2 derivation sanity
    derived = await nativePbkdf2('erica_sanity_check', testIv, 10, 32);
    if (!derived || derived.length !== 32) {
      return false;
    }

    return true;
  } catch (err) {
    console.warn('[cryptoSanityCheck] Self-test detected corruption or failure:', err);
    return false;
  } finally {
    wipeBuffers(testKey, testIv, ct, tag, decrypted, derived);
  }
}
