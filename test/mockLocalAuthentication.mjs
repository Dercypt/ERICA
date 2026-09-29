let mockHardware = true;
let mockEnrolled = true;
let mockAuthResult = { success: true };
let mockSupportedTypes = [1, 2]; // 1: FINGERPRINT, 2: FACIAL_RECOGNITION

export const AuthenticationType = {
  FINGERPRINT: 1,
  FACIAL_RECOGNITION: 2,
  IRIS: 3,
};

export const SecurityLevel = {
  NONE: 0,
  SECRET: 1,
  BIOMETRIC_WEAK: 2,
  BIOMETRIC_STRONG: 3,
};

export async function hasHardwareAsync() {
  return mockHardware;
}

export async function isEnrolledAsync() {
  return mockEnrolled;
}

export async function supportedAuthenticationTypesAsync() {
  return mockSupportedTypes;
}

export async function getEnrolledLevelAsync() {
  return SecurityLevel.BIOMETRIC_STRONG;
}

export async function authenticateAsync(options) {
  return { ...mockAuthResult };
}

export async function cancelAuthenticate() {}

export function setMockBiometricState(config) {
  if (config.hardware !== undefined) mockHardware = config.hardware;
  if (config.enrolled !== undefined) mockEnrolled = config.enrolled;
  if (config.result !== undefined) mockAuthResult = config.result;
  if (config.types !== undefined) mockSupportedTypes = config.types;
}

export function resetMockLocalAuthentication() {
  mockHardware = true;
  mockEnrolled = true;
  mockAuthResult = { success: true };
  mockSupportedTypes = [1, 2];
}

export default {
  AuthenticationType,
  SecurityLevel,
  hasHardwareAsync,
  isEnrolledAsync,
  supportedAuthenticationTypesAsync,
  getEnrolledLevelAsync,
  authenticateAsync,
  cancelAuthenticate,
  setMockBiometricState,
  resetMockLocalAuthentication,
};
