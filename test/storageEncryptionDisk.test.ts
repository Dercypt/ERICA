import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resetMockSecureStore } from './mockExpo.mjs';
import AsyncStorage from './mockAsyncStorage.mjs';
import { MockSQLiteDatabase } from './mockDatabase';
import {
  generateMasterKey,
  wipeMasterKeyMemory,
  lockVault,
  isVaultLocked,
  isMasterKeyLoaded,
  encryptData,
  decryptData,
  encryptString,
  decryptString,
  isEncryptedEnvelope,
  isEncryptedPayload,
  generateRandomBytes,
  hexToBytes,
  bytesToHex,
  AES_GCM_KEY_BYTE_LENGTH,
  AES_GCM_IV_BYTE_LENGTH,
  AES_GCM_TAG_BYTE_LENGTH,
} from '../src/features/security';
import {
  getContacts,
  saveContacts,
  addContact,
  CONTACTS_STORAGE_KEY,
  DecryptionFailedError,
  type Contact,
} from '../src/features/contacts/contactsStorage';
import {
  getHistory,
  appendHistoryEntry,
  HISTORY_STORAGE_KEY,
  type HistoryEntry,
} from '../src/features/history/historyStorage';
import {
  initOutboxQueue,
  enqueueItem,
  getAllPendingItems,
} from '../src/features/dispatch/outboxQueue';

test.beforeEach(async () => {
  resetMockSecureStore();
  wipeMasterKeyMemory();
  lockVault();
  await AsyncStorage.clear();
});

test('Task 2.1: Raw on-disk contacts storage contains strictly ciphertext and zero plaintext', async () => {
  await generateMasterKey();

  const sensitiveContact: Omit<Contact, 'id'> = {
    name: 'Dr. Evelyn Reed (Confidential Psychologist)',
    phoneNumber: '+15550198372',
  };

  await addContact(sensitiveContact);

  // Read raw storage value directly from disk representation in AsyncStorage
  const rawOnDisk = await AsyncStorage.getItem(CONTACTS_STORAGE_KEY);
  assert.ok(rawOnDisk, 'Raw contacts record must exist on disk');

  // Must be valid encrypted envelope JSON
  assert.strictEqual(isEncryptedPayload(rawOnDisk), true, 'Raw on-disk storage must be an encrypted payload');

  const envelope = JSON.parse(rawOnDisk!);
  assert.strictEqual(envelope.version, 1);
  assert.strictEqual(typeof envelope.iv, 'string');
  assert.strictEqual(envelope.iv.length, AES_GCM_IV_BYTE_LENGTH * 2);
  assert.strictEqual(typeof envelope.tag, 'string');
  assert.strictEqual(envelope.tag.length, AES_GCM_TAG_BYTE_LENGTH * 2);
  assert.strictEqual(typeof envelope.ciphertext, 'string');

  // Zero-Leak verification: Plaintext sensitive values MUST NOT appear in the on-disk record
  assert.strictEqual(rawOnDisk!.includes('Evelyn'), false, 'Name must not appear in raw disk storage');
  assert.strictEqual(rawOnDisk!.includes('Psychologist'), false, 'Sensitive notes must not appear in raw disk storage');
  assert.strictEqual(rawOnDisk!.includes('5550198372'), false, 'Phone number must not appear in raw disk storage');
  assert.strictEqual(rawOnDisk!.includes('phoneNumber'), false, 'JSON property keys must not appear in raw disk storage');
});

test('Task 2.2: Raw on-disk emergency history logs contain strictly ciphertext and zero plaintext', async () => {
  await generateMasterKey();

  const sensitiveHistory: HistoryEntry = {
    sessionId: 'hostage_coercion_alert_999',
    triggerSource: 'Covert Shake Panic Under Duress',
    startedAt: 1727600000000,
    resolvedAt: null,
    locationCaptured: true,
  };

  await appendHistoryEntry(sensitiveHistory);

  const rawOnDisk = await AsyncStorage.getItem(HISTORY_STORAGE_KEY);
  assert.ok(rawOnDisk, 'Raw history record must exist on disk');
  assert.strictEqual(isEncryptedPayload(rawOnDisk), true, 'History on disk must be encrypted envelope');

  // Zero-Leak verification
  assert.strictEqual(rawOnDisk!.includes('hostage_coercion_alert_999'), false);
  assert.strictEqual(rawOnDisk!.includes('Covert Shake Panic'), false);
  assert.strictEqual(rawOnDisk!.includes('startedAt'), false);
});

test('Task 2.3: Raw on-disk SQLite outbox queue table rows contain strictly ciphertext payloads', async () => {
  await generateMasterKey();
  const mockDb = new MockSQLiteDatabase();
  await initOutboxQueue(mockDb);

  const sensitivePayload = 'EMERGENCY: Kidnapping in progress at 456 Danger St. Vehicle Plate ABC-123. Medical: Diabetic.';
  const recipient = '+15559110000';

  await enqueueItem(recipient, sensitivePayload);

  // Directly inspect raw database rows on disk
  assert.strictEqual(mockDb.rows.size, 1);
  const rawDbRow = Array.from(mockDb.rows.values())[0];

  assert.strictEqual(isEncryptedPayload(rawDbRow.payload), true, 'SQLite payload column must store encrypted envelope');
  assert.strictEqual(rawDbRow.payload.includes('Kidnapping'), false, 'Sensitive payload plaintext must not appear in DB');
  assert.strictEqual(rawDbRow.payload.includes('Danger St'), false);
  assert.strictEqual(rawDbRow.payload.includes('Diabetic'), false);
  assert.strictEqual(rawDbRow.payload.includes('ABC-123'), false);

  // Decrypted retrieval via queue API works as expected
  const pending = await getAllPendingItems();
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].payload, sensitivePayload);
});

test('Task 2.4: Raw Disk File & Flash Storage Extraction: Complete raw file dump contains zero plaintext traces', async () => {
  const masterKey = await generateMasterKey();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erica_disk_sim_'));

  try {
    const rawContactsEnc = await encryptString(JSON.stringify([
      { id: '1', name: 'Safe Contact John Doe', phoneNumber: '+1234567890' },
      { id: '2', name: 'Shelter Coordinator Maria', phoneNumber: '+1987654321' },
    ]), masterKey);

    const rawHistoryEnc = await encryptString(JSON.stringify([
      { sessionId: 'covert_sos_1', triggerSource: 'Hardware Button Pattern', startedAt: 1727610000000 },
    ]), masterKey);

    const rawSqliteDump = JSON.stringify({
      outbox_queue: [
        {
          id: 'msg_101',
          recipient: '+1234567890',
          payload: await encryptString('EMERGENCY: Coordinate 14.5995, 120.9842. Suspect following me.', masterKey),
        },
      ],
    });

    // Write raw database and storage dumps to simulated disk files
    const contactsFile = path.join(tempDir, 'async_storage_contacts.json');
    const historyFile = path.join(tempDir, 'async_storage_history.json');
    const databaseFile = path.join(tempDir, 'erica_outbox.db');

    fs.writeFileSync(contactsFile, rawContactsEnc, 'utf8');
    fs.writeFileSync(historyFile, rawHistoryEnc, 'utf8');
    fs.writeFileSync(databaseFile, rawSqliteDump, 'utf8');

    // Simulate forensic memory / disk string analysis (strings / grep on disk)
    const diskFiles = [contactsFile, historyFile, databaseFile];
    const sensitiveTokens = [
      'John Doe',
      'Shelter Coordinator Maria',
      '14.5995',
      '120.9842',
      'Suspect following me',
      'covert_sos_1',
    ];

    for (const filePath of diskFiles) {
      const fileBytes = fs.readFileSync(filePath);
      const fileString = fileBytes.toString('utf8');

      for (const token of sensitiveTokens) {
        assert.strictEqual(
          fileString.includes(token),
          false,
          `Adversary disk dump scan found leaked sensitive token '${token}' in file ${path.basename(filePath)}`
        );
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Task 2.5: Deserialization Barrier: Raw on-disk ciphertext CANNOT be deserialized without the master key', async () => {
  const masterKey = await generateMasterKey();
  const secretData = {
    patientName: 'Jane Roe',
    traumaNotes: 'Under protective custody. High adversary threat.',
    emergencyContacts: ['+15550001', '+15550002'],
  };

  const encryptedJson = await encryptString(JSON.stringify(secretData), masterKey);
  const envelope = JSON.parse(encryptedJson);

  // 1. Direct standard deserialization attempt (JSON.parse) fails to extract secret data model
  assert.strictEqual(isEncryptedEnvelope(envelope), true);
  assert.strictEqual((envelope as any).patientName, undefined, 'Direct JSON parse yields ciphertext envelope, not patientName');
  assert.strictEqual((envelope as any).traumaNotes, undefined);
  assert.strictEqual((envelope as any).emergencyContacts, undefined);

  // 2. Adversary attempts decryption with arbitrary random 256-bit key
  const adversaryRandomKey = generateRandomBytes(AES_GCM_KEY_BYTE_LENGTH);
  await assert.rejects(
    async () => decryptData(envelope, adversaryRandomKey),
    /Decryption failed|authentication tag verification failed/i,
    'Decryption with wrong key must fail authentication'
  );

  // 3. Adversary attempts decryption with all-zeros key
  const allZerosKey = new Uint8Array(32);
  await assert.rejects(
    async () => decryptData(envelope, allZerosKey),
    /Decryption failed|authentication tag verification failed/i,
    'Decryption with all-zeros key must fail authentication'
  );

  // 4. Adversary attempts decryption with slightly modified master key (1 bit difference)
  const modifiedKey = new Uint8Array(masterKey);
  modifiedKey[0] ^= 0x01;
  await assert.rejects(
    async () => decryptData(envelope, modifiedKey),
    /Decryption failed|authentication tag verification failed/i,
    'Decryption with single bit key discrepancy must fail'
  );

  // 5. Successful deserialization ONLY possible with the genuine master key
  const decryptedJson = await decryptData(envelope, masterKey);
  const deserialized = JSON.parse(decryptedJson);
  assert.deepStrictEqual(deserialized, secretData, 'Only legitimate master key can deserialize secret data');
});

test('Task 2.6: Anti-Tampering Integrity on Disk: Corrupted or bit-flipped on-disk ciphertext cannot be deserialized', async () => {
  const masterKey = await generateMasterKey();
  const contacts = [{ id: 'c1', name: 'Safe Contact', phoneNumber: '+1234' }];
  await saveContacts(contacts);

  const rawRecord = (await AsyncStorage.getItem(CONTACTS_STORAGE_KEY))!;
  const parsedEnv = JSON.parse(rawRecord);

  // 1. Tamper 1 byte of ciphertext on disk
  const ctBytes = hexToBytes(parsedEnv.ciphertext);
  ctBytes[ctBytes.length - 1] ^= 0xff;
  const tamperedCtEnv = { ...parsedEnv, ciphertext: bytesToHex(ctBytes) };

  await assert.rejects(
    async () => decryptData(tamperedCtEnv, masterKey),
    /Decryption failed|authentication tag verification failed/i,
    'Tampered ciphertext bytes on disk must fail AEAD verification'
  );

  // 2. Tamper 1 byte of authentication tag on disk
  const tagBytes = hexToBytes(parsedEnv.tag);
  tagBytes[0] ^= 0x80;
  const tamperedTagEnv = { ...parsedEnv, tag: bytesToHex(tagBytes) };

  await assert.rejects(
    async () => decryptData(tamperedTagEnv, masterKey),
    /Decryption failed|authentication tag verification failed/i,
    'Tampered auth tag bytes on disk must fail AEAD verification'
  );

  // 3. Tamper 1 byte of IV on disk
  const ivBytes = hexToBytes(parsedEnv.iv);
  ivBytes[0] ^= 0x55;
  const tamperedIvEnv = { ...parsedEnv, iv: bytesToHex(ivBytes) };

  await assert.rejects(
    async () => decryptData(tamperedIvEnv, masterKey),
    /Decryption failed|authentication tag verification failed/i,
    'Tampered IV bytes on disk must fail AEAD verification'
  );

  // 4. Overwrite disk with corrupted record and verify getContacts() fails loudly with DecryptionFailedError
  await AsyncStorage.setItem(CONTACTS_STORAGE_KEY, JSON.stringify(tamperedCtEnv));
  await assert.rejects(
    async () => getContacts(),
    (err: any) => err instanceof DecryptionFailedError || err?.name === 'DecryptionFailedError',
    'Storage getter must fail loudly with DecryptionFailedError on corrupted on-disk ciphertext'
  );
});
