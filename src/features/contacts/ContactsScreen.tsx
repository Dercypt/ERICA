import React, { useCallback, useState } from 'react';
import { View, Text, TextInput, Pressable, FlatList, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import {
  addContact,
  getContacts,
  removeContact,
  updateContact,
  DecryptionFailedError,
  type Contact,
} from './contactsStorage';

export function ContactsScreen() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(() => {
    setErrorMessage(null);
    getContacts()
      .then((data) => {
        setContacts(data);
      })
      .catch((err) => {
        if (err instanceof DecryptionFailedError || err?.name === 'DecryptionFailedError') {
          setErrorMessage(
            'Decryption failed: Unable to decrypt contacts vault. Please re-authenticate or restore.'
          );
        } else {
          setErrorMessage(err?.message || 'Failed to load contacts.');
        }
      });
  }, []);

  useFocusEffect(load);

  const onSave = async () => {
    if (!name.trim() || !phone.trim()) return;
    try {
      if (editingId) {
        const updated = await updateContact({
          id: editingId,
          name: name.trim(),
          phoneNumber: phone.trim(),
        });
        setContacts(updated);
        setEditingId(null);
      } else {
        setContacts(await addContact({ name: name.trim(), phoneNumber: phone.trim() }));
      }
      setName('');
      setPhone('');
      setErrorMessage(null);
    } catch (err: any) {
      if (err instanceof DecryptionFailedError || err?.name === 'DecryptionFailedError') {
        setErrorMessage(
          'Decryption failed: Unable to decrypt contacts vault. Please re-authenticate or restore.'
        );
      } else {
        setErrorMessage(err?.message || 'Failed to save contact.');
      }
    }
  };

  const onRemove = (id: string) => {
    removeContact(id)
      .then((updated) => {
        setContacts(updated);
        setErrorMessage(null);
      })
      .catch((err: any) => {
        if (err instanceof DecryptionFailedError || err?.name === 'DecryptionFailedError') {
          setErrorMessage(
            'Decryption failed: Unable to decrypt contacts vault. Please re-authenticate or restore.'
          );
        } else {
          setErrorMessage(err?.message || 'Failed to remove contact.');
        }
      });
  };

  const onStartEdit = (contact: Contact) => {
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
      <Text style={styles.title}>Trusted Contacts</Text>
      {errorMessage ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerTitle}>⚠️ Vault Locked / Decryption Failed</Text>
          <Text style={styles.errorBannerText}>{errorMessage}</Text>
        </View>
      ) : null}
      <FlatList
        data={contacts}
        keyExtractor={(c) => c.id}
        ListEmptyComponent={<Text style={styles.empty}>No contacts yet — add at least one below.</Text>}
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
              <Pressable onPress={() => onRemove(item.id)} style={styles.actionBtn}>
                <Text style={styles.remove}>Remove</Text>
              </Pressable>
            </View>
          </View>
        )}
      />
      <View style={styles.form}>
        <Text style={styles.formTitle}>{editingId ? 'Edit Contact' : 'Add New Contact'}</Text>
        <TextInput style={styles.input} placeholder="Name" placeholderTextColor="#8E8E93" value={name} onChangeText={setName} />
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
          <Pressable style={[styles.addButton, editingId ? { flex: 1 } : null]} onPress={onSave}>
            <Text style={styles.addButtonText}>{editingId ? 'Save Changes' : 'Add Contact'}</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0B0B0F', padding: 16 },
  title: { color: 'white', fontSize: 20, fontWeight: '700', marginBottom: 12 },
  empty: { color: '#8E8E93', marginTop: 24, textAlign: 'center' },
  errorBanner: {
    backgroundColor: '#2A1215',
    borderColor: '#D7263D',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  errorBannerTitle: {
    color: '#FF6B6B',
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 4,
  },
  errorBannerText: {
    color: '#F8D7DA',
    fontSize: 13,
  },
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
  input: { borderWidth: 1, borderColor: '#3A3A3C', borderRadius: 8, padding: 12, color: 'white' },
  buttonRow: { flexDirection: 'row', gap: 8 },
  cancelButton: { borderWidth: 1, borderColor: '#3A3A3C', borderRadius: 8, padding: 14, alignItems: 'center', flex: 1 },
  cancelButtonText: { color: '#C7C7CC', fontWeight: '600' },
  addButton: { backgroundColor: '#D7263D', borderRadius: 8, padding: 14, alignItems: 'center' },
  addButtonText: { color: 'white', fontWeight: '700' },
});
