import AsyncStorage from '@react-native-async-storage/async-storage';
import { getSettings } from '../settings/settingsStorage';

export interface DecoyContact {
  id: string;
  name: string;
  phoneNumber: string;
}

export const DECOY_CONTACTS_STORAGE_KEY = '@erica/decoy_contacts';

export const DEFAULT_MOCK_CONTACTS: DecoyContact[] = [
  { id: 'decoy-1', name: 'Dr. Emily Watson (Clinic)', phoneNumber: '+1 (555) 234-5678' },
  { id: 'decoy-2', name: 'Apex Roadside Assistance', phoneNumber: '+1 (800) 555-0199' },
  { id: 'decoy-3', name: 'Building Concierge / Security', phoneNumber: '+1 (555) 014-4321' },
];

/**
 * Retrieves contacts for the benign decoy screen.
 * If user configured 'empty' decoy mode and no custom mock contacts have been saved, returns [].
 * Otherwise returns saved decoy contacts or innocuous mock defaults.
 */
export async function getDecoyContacts(): Promise<DecoyContact[]> {
  const raw = await AsyncStorage.getItem(DECOY_CONTACTS_STORAGE_KEY);
  if (raw !== null) {
    try {
      return JSON.parse(raw) as DecoyContact[];
    } catch {
      return [];
    }
  }

  const settings = await getSettings();
  if (settings.decoyContactsType === 'empty') {
    return [];
  }

  return DEFAULT_MOCK_CONTACTS;
}

export async function saveDecoyContacts(contacts: DecoyContact[]): Promise<void> {
  await AsyncStorage.setItem(DECOY_CONTACTS_STORAGE_KEY, JSON.stringify(contacts));
}

export async function addDecoyContact(contact: Omit<DecoyContact, 'id'>): Promise<DecoyContact[]> {
  const contacts = await getDecoyContacts();
  const updated = [...contacts, { ...contact, id: `decoy_${Date.now()}` }];
  await saveDecoyContacts(updated);
  return updated;
}

export async function updateDecoyContact(updatedContact: DecoyContact): Promise<DecoyContact[]> {
  const contacts = await getDecoyContacts();
  const updated = contacts.map((c) => (c.id === updatedContact.id ? updatedContact : c));
  await saveDecoyContacts(updated);
  return updated;
}

export async function removeDecoyContact(id: string): Promise<DecoyContact[]> {
  const contacts = await getDecoyContacts();
  const updated = contacts.filter((c) => c.id !== id);
  await saveDecoyContacts(updated);
  return updated;
}

export async function resetDecoyContacts(): Promise<void> {
  await AsyncStorage.removeItem(DECOY_CONTACTS_STORAGE_KEY);
}
