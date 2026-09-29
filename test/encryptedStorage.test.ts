import test from 'node:test';
import assert from 'node:assert';
import { resetMockSecureStore } from './mockExpo.mjs';
import AsyncStorage from './mockAsyncStorage.mjs';
import { MockSQLiteDatabase } from './mockDatabase';
import {
  generateRandomBytes,
  encryptData,
  decryptData,
  encryptString,
  decryptString,
  isEncryptedEnvelope,
  isEncryptedPayload,
  AES_GCM_IV_BYTE_LENGTH,
  AES_GCM_TAG_BYTE_LENGTH,
  AES_GCM_KEY_BYTE_LENGTH,
  hexToBytes,
  bytesToHex,
  runStorageMigration,
  isStorageMigrationComplete,
  resetStorageMigrationFlag,
  generateMasterKey,
  wipeMasterKeyMemory,
  lockVault,
} from '../src/features/security';
import {
  getContacts,
  saveContacts,
  addContact,
  updateContact,
  removeContact,
  CONTACTS_STORAGE_KEY,
  type Contact,
} from '../src/features/contacts/contactsStorage';
import {
  getHistory,
  appendHistoryEntry,
  resolveHistoryEntry,
  clearHistory,
  HISTORY_STORAGE_KEY,
  type HistoryEntry,
} from '../src/features/history/historyStorage';
import {
  initOutboxQueue,
  enqueueItem,
  getAllPendingItems,
  getDueItems,
  getOutboxItems,
  clearQueue,
} from '../src/features/dispatch/outboxQueue';

test.beforeEach(async () => {
  resetMockSecureStore();
  wipeMasterKeyMemory();
  lockVault();
  await AsyncStorage.clear();
  await resetStorageMigrationFlag();
});

test('1. Authenticated AES-256-GCM Engine: IV freshness, envelope structure, and roundtrip', async () => {
  const masterKey = await generateMasterKey();
  const secret = 'EMERGENCY: Coordinates 14.5995, 120.9842 with sensitive medical notes.';

  const env1 = await encryptData(secret, masterKey);
  assert.strictEqual(env1.version, 1);
  assert.strictEqual(env1.iv.length, AES_GCM_IV_BYTE_LENGTH * 2);
  assert.strictEqual(env1.tag.length, AES_GCM_TAG_BYTE_LENGTH * 2);
  assert.ok(env1.ciphertext.length > 0);
  assert.strictEqual(isEncryptedEnvelope(env1), true);

  // Successive encryptions of the same plaintext produce unique IVs and distinct ciphertexts
  const env2 = await encryptData(secret, masterKey);
  assert.notStrictEqual(env1.iv, env2.iv, 'Fresh IV must be generated for each encryption operation');
  assert.notStrictEqual(env1.ciphertext, env2.ciphertext, 'Ciphertexts must differ due to unique IV');

  // Successful decryption
  const decrypted1 = await decryptData(env1, masterKey);
  const decrypted2 = await decryptData(env2, masterKey);
  assert.strictEqual(decrypted1, secret);
  assert.strictEqual(decrypted2, secret);

  // Unicode, emojis, empty string support
  const emojiText = '🚨 Help requested by María José! 📍 https://maps.google.com/?q=14.5,120.9 🆘';
  const emojiEnc = await encryptString(emojiText, masterKey);
  assert.strictEqual(isEncryptedPayload(emojiEnc), true);
  assert.strictEqual(await decryptString(emojiEnc, masterKey), emojiText);

  const emptyEnc = await encryptString('', masterKey);
  assert.strictEqual(isEncryptedPayload(emptyEnc), true);
  assert.strictEqual(await decryptString(emptyEnc, masterKey), '');
});

test('2. Anti-Tampering Security: Auth tag verification rejects modified ciphertext, tag, IV, or wrong key', async () => {
  const masterKey = await generateMasterKey();
  const wrongKey = generateRandomBytes(AES_GCM_KEY_BYTE_LENGTH);
  const secret = 'CONFIDENTIAL_SOS_ALERT';

  const env = await encryptData(secret, masterKey);

  // 1. Decrypting with wrong key must be rejected
  await assert.rejects(
    async () => decryptData(env, wrongKey),
    /Decryption failed|authentication tag verification failed/i,
    'Must reject decryption when using incorrect master key'
  );

  // 2. Tampered ciphertext bit must be rejected
  const tamperedCtBytes = hexToBytes(env.ciphertext);
  tamperedCtBytes[0] ^= 0x01;
  const tamperedCtEnv = { ...env, ciphertext: bytesToHex(tamperedCtBytes) };
  await assert.rejects(
    async () => decryptData(tamperedCtEnv, masterKey),
    /Decryption failed|authentication tag verification failed/i,
    'Must reject corrupted ciphertext'
  );

  // 3. Tampered auth tag bit must be rejected
  const tamperedTagBytes = hexToBytes(env.tag);
  tamperedTagBytes[0] ^= 0x01;
  const tamperedTagEnv = { ...env, tag: bytesToHex(tamperedTagBytes) };
  await assert.rejects(
    async () => decryptData(tamperedTagEnv, masterKey),
    /Decryption failed|authentication tag verification failed/i,
    'Must reject corrupted authentication tag'
  );

  // 4. Tampered IV bit must be rejected
  const tamperedIvBytes = hexToBytes(env.iv);
  tamperedIvBytes[0] ^= 0x01;
  const tamperedIvEnv = { ...env, iv: bytesToHex(tamperedIvBytes) };
  await assert.rejects(
    async () => decryptData(tamperedIvEnv, masterKey),
    /Decryption failed|authentication tag verification failed/i,
    'Must reject corrupted IV'
  );
});

test('3. Trusted Contacts Encryption: Storage dump reveals ciphertext only while transparently readable', async () => {
  await generateMasterKey();

  const contactsToSave: Contact[] = [
    { id: 'c1', name: 'Dr. Jane Watson', phoneNumber: '+14155552671' },
    { id: 'c2', name: 'Emergency Family Member', phoneNumber: '+14155559823' },
  ];

  await saveContacts(contactsToSave);

  // Inspect raw storage in AsyncStorage (as an ADB dumper would)
  const rawStored = await AsyncStorage.getItem(CONTACTS_STORAGE_KEY);
  assert.ok(rawStored, 'Storage key must exist');
  assert.strictEqual(isEncryptedPayload(rawStored), true, 'Raw storage must be an encrypted envelope');

  // Verify that neither contact names nor numbers exist anywhere in raw flash storage
  assert.strictEqual(rawStored.includes('Jane Watson'), false, 'Contact name must never appear in raw storage');
  assert.strictEqual(rawStored.includes('+14155552671'), false, 'Phone number must never appear in raw storage');
  assert.strictEqual(rawStored.includes('Emergency Family Member'), false);

  // Read via API returns original contacts
  const retrieved = await getContacts();
  assert.strictEqual(retrieved.length, 2);
  assert.strictEqual(retrieved[0].name, 'Dr. Jane Watson');
  assert.strictEqual(retrieved[1].phoneNumber, '+14155559823');

  // Add contact continues to store only ciphertext
  await addContact({ name: 'Brother Bob', phoneNumber: '+14155550000' });
  const rawAfterAdd = await AsyncStorage.getItem(CONTACTS_STORAGE_KEY);
  assert.strictEqual(isEncryptedPayload(rawAfterAdd), true);
  assert.strictEqual(rawAfterAdd!.includes('Brother Bob'), false);

  const updatedContacts = await getContacts();
  assert.strictEqual(updatedContacts.length, 3);

  // Remove contact preserves encryption
  await removeContact('c1');
  const rawAfterRemove = await AsyncStorage.getItem(CONTACTS_STORAGE_KEY);
  assert.strictEqual(isEncryptedPayload(rawAfterRemove), true);
  const remaining = await getContacts();
  assert.strictEqual(remaining.length, 2);
});

test('4. Emergency History Logs Encryption: Logs are encrypted at rest with full lifecycle support', async () => {
  await generateMasterKey();

  const entry: HistoryEntry = {
    sessionId: 'session_998877_alpha',
    triggerSource: 'Hardware Volume Pattern (4 clicks)',
    startedAt: 1727600000000,
    resolvedAt: null,
    locationCaptured: true,
  };

  await appendHistoryEntry(entry);

  // Storage dump verification
  const rawHistory = await AsyncStorage.getItem(HISTORY_STORAGE_KEY);
  assert.ok(rawHistory);
  assert.strictEqual(isEncryptedPayload(rawHistory), true);
  assert.strictEqual(rawHistory.includes('session_998877_alpha'), false, 'Session ID must not be plaintext');
  assert.strictEqual(rawHistory.includes('Hardware Volume Pattern'), false, 'Trigger source must not be plaintext');

  // Fetch via API decrypts transparently
  const historyList = await getHistory();
  assert.strictEqual(historyList.length, 1);
  assert.strictEqual(historyList[0].sessionId, 'session_998877_alpha');
  assert.strictEqual(historyList[0].locationCaptured, true);

  // Resolve entry preserves encrypted storage
  await resolveHistoryEntry('session_998877_alpha', 1727600050000);
  const rawAfterResolve = await AsyncStorage.getItem(HISTORY_STORAGE_KEY);
  assert.strictEqual(isEncryptedPayload(rawAfterResolve), true);

  const resolvedList = await getHistory();
  assert.strictEqual(resolvedList[0].resolvedAt, 1727600050000);

  // Clear history
  await clearHistory();
  assert.strictEqual(await AsyncStorage.getItem(HISTORY_STORAGE_KEY), null);
  assert.strictEqual((await getHistory()).length, 0);
});

test('5. SQLite Outbox Queue: Payloads stored strictly as authenticated ciphertext in database rows', async () => {
  await generateMasterKey();
  const mockDb = new MockSQLiteDatabase();
  await initOutboxQueue(mockDb);
  await clearQueue();

  const secretPayload = 'EMERGENCY: User immobilized at Lat: 37.7749, Lng: -122.4194';
  const item = await enqueueItem('+14155551122', secretPayload);

  // Inspect raw SQLite row stored in database
  const rawRow = mockDb.rows.get(item.id);
  assert.ok(rawRow, 'Row must exist in SQLite database');
  assert.strictEqual(isEncryptedPayload(rawRow!.payload), true, 'SQLite payload column must contain authenticated ciphertext');
  assert.strictEqual(rawRow!.payload.includes('Lat: 37.7749'), false, 'Coordinates must never appear in SQLite raw storage');

  // Retrieve through dispatch queue APIs: payloads are transparently decrypted
  const dueItems = await getDueItems();
  assert.strictEqual(dueItems.length, 1);
  assert.strictEqual(dueItems[0].payload, secretPayload);

  const pendingItems = await getAllPendingItems();
  assert.strictEqual(pendingItems.length, 1);
  assert.strictEqual(pendingItems[0].payload, secretPayload);

  const allItems = await getOutboxItems();
  assert.strictEqual(allItems.length, 1);
  assert.strictEqual(allItems[0].payload, secretPayload);
});

test('6. Automated One-Time Migration: Converts legacy Phase 1/2 plaintext, purges storage, and is idempotent', async () => {
  const mockDb = new MockSQLiteDatabase();
  await initOutboxQueue(mockDb);

  // 1. Seed legacy Phase 1/2 unencrypted plaintext records
  const legacyContacts = [
    { id: 'legacy_1', name: 'Grandma Alice', phoneNumber: '+1234567890' },
  ];
  const legacyHistory = [
    {
      sessionId: 'legacy_session_101',
      triggerSource: 'Manual Button',
      startedAt: 1727500000000,
      resolvedAt: 1727500010000,
      locationCaptured: false,
    },
  ];

  await AsyncStorage.setItem(CONTACTS_STORAGE_KEY, JSON.stringify(legacyContacts));
  await AsyncStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(legacyHistory));

  // Seed legacy unencrypted SQLite row
  mockDb.rows.set('msg_legacy_1', {
    id: 'msg_legacy_1',
    recipient: '+1234567890',
    payload: 'LEGACY UNENCRYPTED ALERT PAYLOAD',
    attempts: 0,
    status: 'PENDING',
    nextRetryAt: Date.now(),
    createdAt: Date.now() - 1000,
  });

  // Verify records are plaintext initially
  assert.strictEqual(isEncryptedPayload(await AsyncStorage.getItem(CONTACTS_STORAGE_KEY)), false);
  assert.strictEqual(isEncryptedPayload(await AsyncStorage.getItem(HISTORY_STORAGE_KEY)), false);
  assert.strictEqual(isEncryptedPayload(mockDb.rows.get('msg_legacy_1')!.payload), false);
  assert.strictEqual(await isStorageMigrationComplete(), false);

  // 2. Execute Automated Phase 3 One-Time Migration
  const result = await runStorageMigration({ customDb: mockDb });
  assert.strictEqual(result.alreadyMigrated, false);
  assert.strictEqual(result.contactsMigrated, true, 'Contacts must be migrated');
  assert.strictEqual(result.historyMigrated, true, 'History must be migrated');
  assert.strictEqual(result.outboxMigratedCount, 1, 'SQLite outbox payload must be migrated');
  assert.strictEqual(await isStorageMigrationComplete(), true);

  // 3. Verify storage state after migration: all ciphertext, zero plaintext
  const migratedRawContacts = (await AsyncStorage.getItem(CONTACTS_STORAGE_KEY))!;
  const migratedRawHistory = (await AsyncStorage.getItem(HISTORY_STORAGE_KEY))!;
  const migratedDbRow = mockDb.rows.get('msg_legacy_1')!;

  assert.strictEqual(isEncryptedPayload(migratedRawContacts), true, 'Contacts must now be ciphertext');
  assert.strictEqual(migratedRawContacts.includes('Grandma Alice'), false, 'Plaintext contacts purged from storage');

  assert.strictEqual(isEncryptedPayload(migratedRawHistory), true, 'History must now be ciphertext');
  assert.strictEqual(migratedRawHistory.includes('legacy_session_101'), false, 'Plaintext history purged from storage');

  assert.strictEqual(isEncryptedPayload(migratedDbRow.payload), true, 'SQLite outbox payload must now be ciphertext');
  assert.strictEqual(migratedDbRow.payload.includes('LEGACY UNENCRYPTED'), false);

  // 4. Verify data accessibility: applications can read all migrated records without loss
  const contactsAfter = await getContacts();
  assert.strictEqual(contactsAfter.length, 1);
  assert.strictEqual(contactsAfter[0].name, 'Grandma Alice');

  const historyAfter = await getHistory();
  assert.strictEqual(historyAfter.length, 1);
  assert.strictEqual(historyAfter[0].sessionId, 'legacy_session_101');

  const pendingAfter = await getAllPendingItems();
  assert.strictEqual(pendingAfter.length, 1);
  assert.strictEqual(pendingAfter[0].payload, 'LEGACY UNENCRYPTED ALERT PAYLOAD');

  // 5. Idempotency test: subsequent runs do not re-encrypt or corrupt records
  const secondRun = await runStorageMigration({ customDb: mockDb });
  assert.strictEqual(secondRun.alreadyMigrated, true);
  assert.strictEqual(secondRun.contactsMigrated, false);
  assert.strictEqual(secondRun.historyMigrated, false);
  assert.strictEqual(secondRun.outboxMigratedCount, 0);

  // Data remains 100% readable
  assert.strictEqual((await getContacts())[0].name, 'Grandma Alice');
});

test('7. ADB Dump Simulation: Raw storage dump across flash storage contains zero plaintext sensitive data', async () => {
  await generateMasterKey();
  const mockDb = new MockSQLiteDatabase();
  await initOutboxQueue(mockDb);

  // Populate sensitive data
  await addContact({ name: 'Secret Agent Contact', phoneNumber: '+18005550199' });
  await appendHistoryEntry({
    sessionId: 'top_secret_sos_session',
    triggerSource: 'Covert Shake Panic',
    startedAt: Date.now(),
    resolvedAt: null,
    locationCaptured: true,
  });
  await enqueueItem('+18005550199', 'COVERT EMERGENCY DISPATCH MESSAGE AT LOCATION X');

  // Attacker dumps entire AsyncStorage storage Map and SQLite table rows
  const allAsyncStorageKeys = [CONTACTS_STORAGE_KEY, HISTORY_STORAGE_KEY];
  for (const key of allAsyncStorageKeys) {
    const rawVal = await AsyncStorage.getItem(key);
    assert.ok(rawVal, `Key ${key} must exist`);
    assert.strictEqual(isEncryptedPayload(rawVal), true, `${key} must be encrypted`);
    assert.strictEqual(rawVal!.includes('Secret Agent Contact'), false);
    assert.strictEqual(rawVal!.includes('+18005550199'), false);
    assert.strictEqual(rawVal!.includes('top_secret_sos_session'), false);
    assert.strictEqual(rawVal!.includes('Covert Shake Panic'), false);
  }

  for (const row of mockDb.rows.values()) {
    assert.strictEqual(isEncryptedPayload(row.payload), true, 'SQLite payload must be encrypted');
    assert.strictEqual(row.payload.includes('COVERT EMERGENCY DISPATCH'), false);
  }
});
