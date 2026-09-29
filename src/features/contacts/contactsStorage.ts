import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  encryptString,
  decryptString,
  isEncryptedPayload,
} from '../security/encryption';

export interface Contact {
  id: string;
  name: string;
  phoneNumber: string;
}

export const CONTACTS_STORAGE_KEY = '@erica/contacts';
const STORAGE_KEY = CONTACTS_STORAGE_KEY;

export async function getContacts(): Promise<Contact[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return [];
  }

  // Handle encrypted ciphertext storage
  if (isEncryptedPayload(raw)) {
    try {
      const decrypted = await decryptString(raw);
      return JSON.parse(decrypted) as Contact[];
    } catch (err) {
      console.warn('[contactsStorage] Failed to decrypt contacts:', err);
      return [];
    }
  }

  // Handle legacy Phase 1/2 plaintext: parse and automatically re-encrypt to ciphertext
  try {
    const contacts = JSON.parse(raw) as Contact[];
    const encrypted = await encryptString(JSON.stringify(contacts));
    await AsyncStorage.setItem(STORAGE_KEY, encrypted);
    return contacts;
  } catch (err) {
    console.warn('[contactsStorage] Failed to parse legacy contacts:', err);
    return [];
  }
}

export async function saveContacts(contacts: Contact[]): Promise<void> {
  const json = JSON.stringify(contacts);
  const encrypted = await encryptString(json);
  await AsyncStorage.setItem(STORAGE_KEY, encrypted);
}

export async function addContact(contact: Omit<Contact, 'id'>): Promise<Contact[]> {
  const contacts = await getContacts();
  const updated = [...contacts, { ...contact, id: `${Date.now()}` }];
  await saveContacts(updated);
  return updated;
}

export async function updateContact(updatedContact: Contact): Promise<Contact[]> {
  const contacts = await getContacts();
  const updated = contacts.map((c) => (c.id === updatedContact.id ? updatedContact : c));
  await saveContacts(updated);
  return updated;
}

export async function removeContact(id: string): Promise<Contact[]> {
  const contacts = await getContacts();
  const updated = contacts.filter((c) => c.id !== id);
  await saveContacts(updated);
  return updated;
}
