/**
 * Cryptographic Key Derivation & Stretching Module for E.R.I.C.A.
 *
 * Implements:
 * - Cryptographically secure salt generation (256-bit salt)
 * - PBKDF2-HMAC-SHA256 key stretching (default 100,000 iterations per OWASP recommendations)
 *   protecting user PINs against offline brute-force and dictionary attacks.
 * - Constant-time comparison (timingSafeEqual) preventing timing side-channel attacks.
 * - Buffer scrubbing (wipeBuffer) ensuring sensitive key material is wiped from memory.
 */

export const DEFAULT_PBKDF2_ITERATIONS = 100_000;
export const DEFAULT_SALT_BYTES = 32; // 256-bit salt
export const DEFAULT_KEY_BYTES = 32; // 256-bit key length
export const PBKDF2_ALGORITHM_NAME = 'PBKDF2-HMAC-SHA256';

export interface StretchedPinRecord {
  salt: string; // Hex-encoded salt
  hash: string; // Hex-encoded derived verification hash
  iterations: number;
  algorithm: string;
  keyLength: number;
}

/**
 * Wipes a Uint8Array buffer in-place with zeroes so sensitive material
 * is not retained in memory.
 */
export function wipeBuffer(buffer: Uint8Array | null | undefined): void {
  if (buffer && typeof buffer.fill === 'function') {
    buffer.fill(0);
  }
}

/**
 * Wipes multiple Uint8Array buffers in-place with zeroes.
 */
export function wipeBuffers(...buffers: (Uint8Array | null | undefined)[]): void {
  for (const b of buffers) {
    wipeBuffer(b);
  }
}

/**
 * Converts a Uint8Array to a lowercase hexadecimal string.
 */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Parses a hexadecimal string into a Uint8Array.
 */
export function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.trim();
  if (cleanHex.length % 2 !== 0) {
    throw new Error('Invalid hexadecimal string: odd number of characters.');
  }
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    const byte = parseInt(cleanHex.substring(i, i + 2), 16);
    if (isNaN(byte)) {
      throw new Error(`Invalid hexadecimal byte at index ${i}`);
    }
    bytes[i / 2] = byte;
  }
  return bytes;
}

/**
 * Constant-time comparison between two Uint8Array buffers to prevent
 * timing side-channel attacks during PIN/hash validation.
 */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * Generates cryptographically secure random bytes of specified length.
 */
export function generateRandomBytes(byteLength: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }
  try {
    // Node.js fallback
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto = require('crypto');
    const random = nodeCrypto.randomBytes(byteLength);
    bytes.set(random);
    return bytes;
  } catch {
    throw new Error('Cryptographically secure random number generator is unavailable.');
  }
}

// ---------------------------------------------------------------------------
// Pure TypeScript SHA-256 and HMAC-SHA256 (NIST FIPS 180-4 / RFC 2104)
// Zero external dependencies, portable across React Native, Node, and Web.
// ---------------------------------------------------------------------------

function rotr(n: number, x: number): number {
  return (x >>> n) | (x << (32 - n));
}
function ch(x: number, y: number, z: number): number {
  return (x & y) ^ (~x & z);
}
function maj(x: number, y: number, z: number): number {
  return (x & y) ^ (x & z) ^ (y & z);
}
function sigma0(x: number): number {
  return rotr(2, x) ^ rotr(13, x) ^ rotr(22, x);
}
function sigma1(x: number): number {
  return rotr(6, x) ^ rotr(11, x) ^ rotr(25, x);
}
function gamma0(x: number): number {
  return rotr(7, x) ^ rotr(18, x) ^ (x >>> 3);
}
function gamma1(x: number): number {
  return rotr(17, x) ^ rotr(19, x) ^ (x >>> 10);
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * Standard SHA-256 hash function.
 */
export function sha256(data: Uint8Array): Uint8Array {
  const l = data.length;
  const bitLen = BigInt(l) * 8n;
  const extra = l % 64 < 56 ? 56 - (l % 64) : 120 - (l % 64);
  const total = l + extra + 8;
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[l] = 0x80;
  const view = new DataView(buf.buffer);
  view.setBigUint64(total - 8, bitLen, false);

  let h0 = 0x6a09e667,
    h1 = 0xbb67ae85,
    h2 = 0x3c6ef372,
    h3 = 0xa54ff53a;
  let h4 = 0x510e527f,
    h5 = 0x9b05688c,
    h6 = 0x1f83d9ab,
    h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let i = 0; i < total; i += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = view.getUint32(i + t * 4, false);
    }
    for (let t = 16; t < 64; t++) {
      w[t] = (gamma1(w[t - 2]) + w[t - 7] + gamma0(w[t - 15]) + w[t - 16]) | 0;
    }
    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4,
      f = h5,
      g = h6,
      h = h7;
    for (let t = 0; t < 64; t++) {
      const t1 = (h + sigma1(e) + ch(e, f, g) + SHA256_K[t] + w[t]) | 0;
      const t2 = (sigma0(a) + maj(a, b, c)) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }

  wipeBuffer(new Uint8Array(w.buffer));
  wipeBuffer(buf);

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return out;
}

/**
 * Standard HMAC-SHA256 implementation (RFC 2104).
 */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  let k = key;
  let keyHashed = false;
  if (k.length > 64) {
    k = sha256(k);
    keyHashed = true;
  }
  const paddedKey = new Uint8Array(64);
  paddedKey.set(k);
  if (keyHashed) {
    wipeBuffer(k);
  }

  const ipad = new Uint8Array(64);
  const opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    ipad[i] = paddedKey[i] ^ 0x36;
    opad[i] = paddedKey[i] ^ 0x5c;
  }
  wipeBuffer(paddedKey);

  const inner = new Uint8Array(64 + message.length);
  inner.set(ipad);
  inner.set(message, 64);
  wipeBuffer(ipad);
  const innerHash = sha256(inner);
  wipeBuffer(inner);

  const outer = new Uint8Array(64 + 32);
  outer.set(opad);
  outer.set(innerHash, 64);
  wipeBuffers(opad, innerHash);
  const result = sha256(outer);
  wipeBuffer(outer);
  return result;
}

/**
 * Synchronous PBKDF2-HMAC-SHA256 (RFC 2898 / RFC 8018).
 */
export function pbkdf2HmacSha256Sync(
  password: string | Uint8Array,
  salt: Uint8Array,
  iterations: number,
  keyLength: number
): Uint8Array {
  const passBuf =
    typeof password === 'string' ? new TextEncoder().encode(password) : new Uint8Array(password);
  const numBlocks = Math.ceil(keyLength / 32);
  const result = new Uint8Array(numBlocks * 32);

  try {
    for (let block = 1; block <= numBlocks; block++) {
      const saltBlock = new Uint8Array(salt.length + 4);
      saltBlock.set(salt);
      new DataView(saltBlock.buffer).setUint32(salt.length, block, false);

      let u = hmacSha256(passBuf, saltBlock);
      wipeBuffer(saltBlock);

      const t = new Uint8Array(u);

      for (let iter = 1; iter < iterations; iter++) {
        const nextU = hmacSha256(passBuf, u);
        wipeBuffer(u);
        u = nextU;
        for (let j = 0; j < 32; j++) {
          t[j] ^= u[j];
        }
      }
      wipeBuffer(u);

      result.set(t, (block - 1) * 32);
      wipeBuffer(t);
    }
    return result.slice(0, keyLength);
  } finally {
    wipeBuffer(passBuf);
  }
}

/**
 * Asynchronous PBKDF2-HMAC-SHA256.
 * Uses hardware/platform acceleration (WebCrypto subtle or Node.js crypto)
 * when available, falling back to synchronous pure TS implementation.
 */
export async function pbkdf2HmacSha256(
  password: string | Uint8Array,
  salt: Uint8Array,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS,
  keyLength: number = DEFAULT_KEY_BYTES
): Promise<Uint8Array> {
  const passBuf =
    typeof password === 'string' ? new TextEncoder().encode(password) : new Uint8Array(password);

  try {
    // 1. WebCrypto API acceleration (Web / Node / modern runtimes)
    if (
      typeof globalThis !== 'undefined' &&
      globalThis.crypto?.subtle &&
      typeof globalThis.crypto.subtle.importKey === 'function' &&
      typeof globalThis.crypto.subtle.deriveBits === 'function'
    ) {
      try {
        const keyMaterial = await globalThis.crypto.subtle.importKey(
          'raw',
          passBuf,
          { name: 'PBKDF2' },
          false,
          ['deriveBits']
        );
        const derived = await globalThis.crypto.subtle.deriveBits(
          {
            name: 'PBKDF2',
            salt: salt as unknown as BufferSource,
            iterations: iterations,
            hash: 'SHA-256',
          },
          keyMaterial,
          keyLength * 8
        );
        return new Uint8Array(derived);
      } catch {
        // Fall back if subtle fails
      }
    }

    // 2. Node.js native crypto acceleration
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const nodeCrypto = require('crypto');
      if (nodeCrypto && typeof nodeCrypto.pbkdf2Sync === 'function') {
        const derived = nodeCrypto.pbkdf2Sync(
          passBuf,
          salt,
          iterations,
          keyLength,
          'sha256'
        );
        return new Uint8Array(derived);
      }
    } catch {
      // Fall back if require('crypto') fails
    }

    // 3. Portable pure TypeScript fallback
    return pbkdf2HmacSha256Sync(passBuf, salt, iterations, keyLength);
  } finally {
    wipeBuffer(passBuf);
  }
}

/**
 * Generates a fresh random cryptographic salt (256-bit).
 */
export function generateSalt(byteLength: number = DEFAULT_SALT_BYTES): Uint8Array {
  return generateRandomBytes(byteLength);
}

/**
 * Derives a cryptographic key from a PIN and salt using PBKDF2 key stretching.
 */
export async function deriveKeyFromPin(
  pin: string,
  salt: Uint8Array,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS,
  keyLength: number = DEFAULT_KEY_BYTES
): Promise<Uint8Array> {
  if (!pin || pin.length < 4) {
    throw new Error('PIN must be at least 4 characters in length.');
  }
  return await pbkdf2HmacSha256(pin, salt, iterations, keyLength);
}

/**
 * Creates a stretched verification record for a user PIN.
 * Generates a unique 256-bit cryptographic salt and performs PBKDF2 stretching
 * so PIN verification cannot be precomputed or rainbow-table attacked.
 */
export async function hashPin(
  pin: string,
  customSalt?: Uint8Array,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS
): Promise<StretchedPinRecord> {
  const salt = customSalt ? new Uint8Array(customSalt) : generateSalt(DEFAULT_SALT_BYTES);
  let derivedHash: Uint8Array | null = null;
  try {
    derivedHash = await deriveKeyFromPin(pin, salt, iterations, DEFAULT_KEY_BYTES);
    return {
      salt: bytesToHex(salt),
      hash: bytesToHex(derivedHash),
      iterations,
      algorithm: PBKDF2_ALGORITHM_NAME,
      keyLength: DEFAULT_KEY_BYTES,
    };
  } finally {
    wipeBuffer(derivedHash);
    if (!customSalt) {
      wipeBuffer(salt);
    }
  }
}

/**
 * Validates a user PIN against a stored StretchedPinRecord.
 * Uses constant-time comparison (timingSafeEqual) and wipes candidate key buffers.
 */
export async function verifyPinHash(
  pin: string,
  record: { salt: string; hash: string; iterations: number }
): Promise<boolean> {
  if (!pin || !record?.salt || !record?.hash) {
    return false;
  }
  const salt = hexToBytes(record.salt);
  const expectedHash = hexToBytes(record.hash);
  let candidateHash: Uint8Array | null = null;

  try {
    candidateHash = await pbkdf2HmacSha256(
      pin,
      salt,
      record.iterations || DEFAULT_PBKDF2_ITERATIONS,
      expectedHash.length
    );
    return timingSafeEqual(candidateHash, expectedHash);
  } finally {
    wipeBuffers(candidateHash, expectedHash, salt);
  }
}
