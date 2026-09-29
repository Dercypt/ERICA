import * as SecureStore from 'expo-secure-store';

/**
 * Default options for SecureStore guaranteeing root-of-trust protection:
 * - On Android: sets the keychainService namespace backed by hardware-backed Android Keystore / TEE.
 * - On iOS: restricts access to WHEN_UNLOCKED.
 */
export const DEFAULT_SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: 'erica_keystore',
  keychainAccessible: SecureStore.WHEN_UNLOCKED,
};

/**
 * Checks whether hardware-backed secure storage is available on this device.
 */
export async function isSecureStorageAvailable(): Promise<boolean> {
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

/**
 * Persists a key-value pair into hardware-backed secure store (Android Keystore / TEE).
 */
export async function saveSecureItem(
  key: string,
  value: string,
  options?: SecureStore.SecureStoreOptions
): Promise<void> {
  const mergedOptions = { ...DEFAULT_SECURE_STORE_OPTIONS, ...options };
  await SecureStore.setItemAsync(key, value, mergedOptions);
}

/**
 * Retrieves a key-value pair from hardware-backed secure store.
 */
export async function getSecureItem(
  key: string,
  options?: SecureStore.SecureStoreOptions
): Promise<string | null> {
  const mergedOptions = { ...DEFAULT_SECURE_STORE_OPTIONS, ...options };
  return await SecureStore.getItemAsync(key, mergedOptions);
}

/**
 * Removes a key-value pair from hardware-backed secure store.
 */
export async function deleteSecureItem(
  key: string,
  options?: SecureStore.SecureStoreOptions
): Promise<void> {
  const mergedOptions = { ...DEFAULT_SECURE_STORE_OPTIONS, ...options };
  await SecureStore.deleteItemAsync(key, mergedOptions);
}
