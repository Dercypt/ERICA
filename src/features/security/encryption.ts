/**
 * Authenticated AES-256-GCM Encryption Engine for E.R.I.C.A.
 *
 * Implements:
 * - Authenticated symmetric encryption using AES-256-GCM (256-bit key).
 * - Fresh 96-bit (12-byte) cryptographically random IV generated for every operation.
 * - 128-bit (16-byte) authentication tag for cryptographic integrity and authenticity.
 * - Anti-tampering rejection: corrupted ciphertext, modified tag, or wrong keys fail verification.
 * - Strict in-memory buffer scrubbing for transient cryptographic material.
 * - Portable execution: Native WebCrypto (Hermes / Web / Node) with Node crypto fallback.
 */

import {
  generateRandomBytes,
  bytesToHex,
  hexToBytes,
  wipeBuffer,
  wipeBuffers,
} from './keyDerivation';
import {
  nativeAesGcmEncrypt,
  nativeAesGcmDecrypt,
  runCryptoSanityCheck,
} from './nativeCrypto';
import { withMasterKey } from './masterKey';

export { runCryptoSanityCheck };

export const AES_GCM_IV_BYTE_LENGTH = 12; // 96-bit IV per NIST SP 800-38D
export const AES_GCM_TAG_BYTE_LENGTH = 16; // 128-bit authentication tag
export const AES_GCM_KEY_BYTE_LENGTH = 32; // 256-bit key length

export interface EncryptedEnvelope {
  version: 1;
  iv: string; // Hex-encoded 12-byte IV
  tag: string; // Hex-encoded 16-byte authentication tag
  ciphertext: string; // Hex-encoded ciphertext
}

/**
 * True when `err` means the ciphertext can never be decrypted with the current key
 * (authentication tag mismatch: wrong key or tampering), as opposed to a transient
 * failure such as the key store being briefly unavailable.
 */
export function isDecryptionFailure(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('Decryption failed');
}

/**
 * Checks if an object conforms to the EncryptedEnvelope interface.
 */
export function isEncryptedEnvelope(obj: unknown): obj is EncryptedEnvelope {
  if (!obj || typeof obj !== 'object') {
    return false;
  }
  const candidate = obj as Partial<EncryptedEnvelope>;
  return (
    candidate.version === 1 &&
    typeof candidate.iv === 'string' &&
    candidate.iv.length === AES_GCM_IV_BYTE_LENGTH * 2 &&
    typeof candidate.tag === 'string' &&
    candidate.tag.length === AES_GCM_TAG_BYTE_LENGTH * 2 &&
    typeof candidate.ciphertext === 'string'
  );
}

/**
 * Checks if a string is a serialized JSON EncryptedEnvelope.
 */
export function isEncryptedPayload(raw: unknown): boolean {
  if (typeof raw !== 'string') {
    return false;
  }
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return false;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return isEncryptedEnvelope(parsed);
  } catch {
    return false;
  }
}

/**
 * Low-level authenticated AES-256-GCM encryption.
 * Generates a fresh 12-byte IV and computes a 16-byte authentication tag.
 */
export async function encryptData(
  plaintext: string | Uint8Array,
  key: Uint8Array
): Promise<EncryptedEnvelope> {
  if (key.length !== AES_GCM_KEY_BYTE_LENGTH) {
    throw new Error(
      `Invalid key length: expected ${AES_GCM_KEY_BYTE_LENGTH} bytes for AES-256-GCM, got ${key.length}`
    );
  }

  const plaintextBytes =
    typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : new Uint8Array(plaintext);
  const iv = generateRandomBytes(AES_GCM_IV_BYTE_LENGTH);

  let ciphertextBytes: Uint8Array | null = null;
  let tagBytes: Uint8Array | null = null;

  try {
    const encResult = nativeAesGcmEncrypt(plaintextBytes, key, iv);
    ciphertextBytes = encResult.ciphertextBytes;
    tagBytes = encResult.tagBytes;

    return {
      version: 1,
      iv: bytesToHex(iv),
      tag: bytesToHex(tagBytes),
      ciphertext: bytesToHex(ciphertextBytes),
    };
  } finally {
    wipeBuffers(iv, ciphertextBytes, tagBytes);
    if (typeof plaintext !== 'string') {
      wipeBuffer(plaintextBytes);
    }
  }
}

/**
 * Low-level authenticated AES-256-GCM decryption.
 * Verifies the 16-byte authentication tag before returning decrypted plaintext.
 * Throws if corrupted, tampered, or decrypted with the wrong key.
 */
export async function decryptData(
  envelope: EncryptedEnvelope | string,
  key: Uint8Array
): Promise<string> {
  if (key.length !== AES_GCM_KEY_BYTE_LENGTH) {
    throw new Error(
      `Invalid key length: expected ${AES_GCM_KEY_BYTE_LENGTH} bytes for AES-256-GCM, got ${key.length}`
    );
  }

  const parsedEnv: EncryptedEnvelope =
    typeof envelope === 'string' ? JSON.parse(envelope) : envelope;

  if (!isEncryptedEnvelope(parsedEnv)) {
    throw new Error('Invalid encrypted envelope: missing version, iv, tag, or ciphertext.');
  }

  const ivBytes = hexToBytes(parsedEnv.iv);
  const tagBytes = hexToBytes(parsedEnv.tag);
  const ciphertextBytes = hexToBytes(parsedEnv.ciphertext);

  let decryptedBytes: Uint8Array | null = null;

  try {
    decryptedBytes = nativeAesGcmDecrypt(ciphertextBytes, key, ivBytes, tagBytes);
    return new TextDecoder().decode(decryptedBytes);
  } finally {
    wipeBuffers(ivBytes, tagBytes, ciphertextBytes, decryptedBytes);
  }
}

/**
 * Encrypts a UTF-8 string with the hardware-backed master key (or provided key).
 * Returns the serialized JSON EncryptedEnvelope.
 */
export async function encryptString(plaintext: string, key?: Uint8Array): Promise<string> {
  if (key) {
    const envelope = await encryptData(plaintext, key);
    return JSON.stringify(envelope);
  }
  return await withMasterKey(async (masterKey) => {
    const envelope = await encryptData(plaintext, masterKey);
    return JSON.stringify(envelope);
  });
}

/**
 * Decrypts a serialized JSON EncryptedEnvelope with the hardware-backed master key (or provided key).
 * Returns the original UTF-8 string.
 */
export async function decryptString(encryptedJson: string, key?: Uint8Array): Promise<string> {
  if (key) {
    return await decryptData(encryptedJson, key);
  }
  return await withMasterKey(async (masterKey) => {
    return await decryptData(encryptedJson, masterKey);
  });
}
