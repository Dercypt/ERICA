export class EventEmitter {
  addListener() { return { remove: () => {} }; }
  removeListeners() {}
  emit() {}
}
export class NativeModule extends EventEmitter {}
export class UnavailabilityError extends Error {
  constructor(moduleName, propertyName) {
    super(`The method or property ${moduleName}.${propertyName} is not available.`);
    this.code = 'ERR_UNAVAILABLE';
  }
}
export const Platform = {
  OS: 'android',
  select: (obj) => obj.android || obj.default,
};
export const PermissionStatus = {
  GRANTED: 'granted',
  UNDETERMINED: 'undetermined',
  DENIED: 'denied',
};
export function createPermissionHook() {
  return () => [{ status: PermissionStatus.GRANTED }, async () => ({ status: PermissionStatus.GRANTED })];
}
export function isRunningInExpoGo() {
  return false;
}
const secureStoreMap = new Map();

export function resetMockSecureStore() {
  secureStoreMap.clear();
}

export function requireNativeModule(name) {
  if (name === 'ExpoSecureStore') {
    return {
      isAvailableAsync: async () => true,
      getValueWithKeyAsync: async (key) => secureStoreMap.get(key) ?? null,
      setValueWithKeyAsync: async (value, key) => {
        secureStoreMap.set(key, String(value));
      },
      deleteValueWithKeyAsync: async (key) => {
        secureStoreMap.delete(key);
      },
      getValueWithKeySync: (key) => secureStoreMap.get(key) ?? null,
      setValueWithKeySync: (value, key) => {
        secureStoreMap.set(key, String(value));
      },
      canUseBiometricAuthentication: () => true,
      AFTER_FIRST_UNLOCK: 0,
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
      ALWAYS: 2,
      WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 3,
      ALWAYS_THIS_DEVICE_ONLY: 4,
      WHEN_UNLOCKED: 5,
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    };
  }

  return {
    isAvailableAsync: async () => false,
    sendSilentSms: async () => false,
    startService: async () => true,
    stopService: async () => true,
    updateNotification: async () => true,
    acquireWakeLock: async () => true,
    releaseWakeLock: async () => true,
    isServiceRunning: async () => false,
    isWakeLockActive: async () => false,
    configureVolumeTrigger: async () => true,
    configureShakeTrigger: async () => true,
    startShakeTest: async () => true,
    stopShakeTest: async () => true,
    simulateVolumePress: async () => true,
    simulateShake: async () => true,
    isVolumeTriggerEnabled: async () => false,
    isShakeTriggerEnabled: async () => false,
    startSiren: async () => ({ started: true, suppressedBySilentMode: false }),
    stopSiren: async () => true,
    isSirenActive: async () => false,
    startStrobe: async () => true,
    stopStrobe: async () => true,
    isStrobeActive: async () => false,
    getRingerMode: async () => 'normal',
    startAudioRecording: async () => true,
    stopAudioRecording: async () => ({
      uri: 'file:///mock/evidence/audio.m4a',
      durationMs: 5000,
      base64Data: 'RXJpY2FBdWRpb0V2aWRlbmNlU2FtcGxlRGF0YQ==',
      fileSizeBytes: 1024,
      mimeType: 'audio/m4a',
    }),
    isAudioRecordingActive: async () => false,
    capturePhoto: async (lens) => ({
      uri: `file:///mock/evidence/${lens}_photo.jpg`,
      lens,
      base64Data: 'RXJpY2FQaG90b0V2aWRlbmNlU2FtcGxlRGF0YQ==',
      fileSizeBytes: 2048,
      mimeType: 'image/jpeg',
      timestamp: Date.now(),
    }),
    captureDualPhotos: async () => [
      {
        uri: 'file:///mock/evidence/rear_photo.jpg',
        lens: 'rear',
        base64Data: 'RXJpY2FQaG90b1JlYXI=',
        fileSizeBytes: 2048,
        mimeType: 'image/jpeg',
        timestamp: Date.now(),
      },
      {
        uri: 'file:///mock/evidence/front_photo.jpg',
        lens: 'front',
        base64Data: 'RXJpY2FQaG90b0Zyb250',
        fileSizeBytes: 2048,
        mimeType: 'image/jpeg',
        timestamp: Date.now(),
      },
    ],
    addListener: () => ({ remove: () => {} }),
    removeListeners: () => {},
  };
}
export function registerWebModule(moduleClass, name) {
  return new moduleClass();
}
export default {
  NativeModule,
  requireNativeModule,
  registerWebModule,
};
