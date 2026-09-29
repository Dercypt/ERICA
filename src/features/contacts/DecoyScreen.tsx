import React, { useCallback, useState } from 'react';
import { View, Text, TextInput, Pressable, FlatList, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import {
  addDecoyContact,
  getDecoyContacts,
  removeDecoyContact,
  updateDecoyContact,
  type DecoyContact,
} from './decoyContactsStorage';
import { useAppLock } from '../security/useAppLock';

/**
 * Benign Decoy Screen for E.R.I.C.A.
 *
 * CRITICAL THREAT-MODEL GUARDS:
 * 1. Opened immediately when the secondary Duress PIN is entered under coercion.
 * 2. Displays benign empty or mock innocuous contacts.
 * 3. Never alerts the adversary that a duress code was used (no duress/decoy text or banners).
 * 4. Isolated from true encrypted contacts: operations here never touch or reveal the master vault.
 */
export function DecoyScreen() {
  const { lock } = useAppLock();
  const [contacts, setContacts] = useState<DecoyContact[]>([]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(() => {
    getDecoyContacts().then(setContacts);
  }, []);

  useFocusEffect(load);

  const onSave = async () => {
    if (!name.trim() || !phone.trim()) return;
    if (editingId) {
      const updated = await updateDecoyContact({
        id: editingId,
        name: name.trim(),
        phoneNumber: phone.trim(),
      });
      setContacts(updated);
      setEditingId(null);
    } else {
      setContacts(await addDecoyContact({ name: name.trim(), phoneNumber: phone.trim() }));
    }
    setName('');
    setPhone('');
  };

  const onStartEdit = (contact: DecoyContact) => {
    setEditingId(contact.id);
    setName(contact.name);
    setPhone(contact.phoneNumber);
  };

  const onCancelEdit = () => {
    setEditingId(null);
    setName('');
    setPhone('');
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Trusted Contacts</Text>
        <Pressable
          style={styles.lockButton}
          onPress={() => lock()}
          accessibilityLabel="Lock"
        >
          <Text style={styles.lockButtonText}>🔒</Text>
        </Pressable>
      </View>

      <FlatList
        data={contacts}
        keyExtractor={(c) => c.id}
        ListEmptyComponent={
          <Text style={styles.empty}>No contacts yet — add at least one below.</Text>
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.contactInfo}>
              <Text style={styles.name}>{item.name}</Text>
              <Text style={styles.phone}>{item.phoneNumber}</Text>
            </View>
            <View style={styles.actions}>
              <Pressable onPress={() => onStartEdit(item)} style={styles.actionBtn}>
                <Text style={styles.edit}>Edit</Text>
              </Pressable>
              <Pressable
                onPress={() => removeDecoyContact(item.id).then(setContacts)}
                style={styles.actionBtn}
              >
                <Text style={styles.remove}>Remove</Text>
              </Pressable>
            </View>
          </View>
        )}
      />

      <View style={styles.form}>
        <Text style={styles.formTitle}>{editingId ? 'Edit Contact' : 'Add New Contact'}</Text>
        <TextInput
          style={styles.input}
          placeholder="Name"
          placeholderTextColor="#8E8E93"
          value={name}
          onChangeText={setName}
        />
        <TextInput
          style={styles.input}
          placeholder="Phone number"
          placeholderTextColor="#8E8E93"
          value={phone}
          onChangeText={setPhone}
          keyboardType="phone-pad"
        />
        <View style={styles.buttonRow}>
          {editingId ? (
            <Pressable style={styles.cancelButton} onPress={onCancelEdit}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </Pressable>
          ) : null}
          <Pressable
            style={[styles.addButton, editingId ? { flex: 1 } : null]}
            onPress={onSave}
          >
            <Text style={styles.addButtonText}>{editingId ? 'Save Changes' : 'Add Contact'}</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B0B0F', padding: 16 },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  title: { color: 'white', fontSize: 20, fontWeight: '700' },
  lockButton: {
    padding: 6,
    borderRadius: 6,
    backgroundColor: '#1E1E26',
    borderWidth: 1,
    borderColor: '#2C2C35',
  },
  lockButtonText: { fontSize: 16 },
  empty: { color: '#8E8E93', marginTop: 24, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1C1C1E',
  },
  contactInfo: { flex: 1 },
  name: { color: 'white', fontSize: 16, fontWeight: '600' },
  phone: { color: '#8E8E93', fontSize: 14 },
  actions: { flexDirection: 'row', gap: 12 },
  actionBtn: { paddingVertical: 4, paddingHorizontal: 6 },
  edit: { color: '#4A90E2', fontWeight: '600' },
  remove: { color: '#D7263D', fontWeight: '600' },
  form: { marginTop: 16, gap: 8 },
  formTitle: { color: '#C7C7CC', fontSize: 14, fontWeight: '600', marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: '#3A3A3C',
    borderRadius: 8,
    padding: 12,
    color: 'white',
    backgroundColor: '#16161C',
  },
  buttonRow: { flexDirection: 'row', gap: 8 },
  cancelButton: {
    borderWidth: 1,
    borderColor: '#3A3A3C',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    flex: 1,
  },
  cancelButtonText: { color: '#C7C7CC', fontWeight: '600' },
  addButton: {
    backgroundColor: '#D7263D',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
  },
  addButtonText: { color: 'white', fontWeight: '700' },
});
