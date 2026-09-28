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
export function requireNativeModule(name) {
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
