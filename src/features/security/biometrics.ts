/**
  * Biometric Authentication Service for E.R.I.C.A.
  *
  * Integrates expo-local-authentication for biometric verification (Fingerprint / Face Unlock)
  * with seamless fallback to custom PBKDF2 stretched PIN.
  */

import * as LocalAuthentication from 'expo-local-authentication';
import { isPinConfigured, unlockVaultWithMasterKey } from './pinAuth';
import { getSettings } from '../settings/settingsStorage';

export interface BiometricCapabilities {
  hasHardware: boolean;
  isEnrolled: boolean;
  supportedTypes: string[];
  enrolledLevel: number;
}

export interface BiometricAuthResult {
  success: boolean;
  error?: string;
  fallbackChosen?: boolean;
}

/**
 * Checks whether biometric authentication hardware is present and user credentials enrolled.
 */
export async function isBiometricsAvailable(): Promise<boolean> {
  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    if (!hasHardware) return false;
    const isEnrolled = await LocalAuthentication.isEnrolledAsync();
    return isEnrolled;
  } catch (err) {
    console.warn('[Biometrics] Availability check error:', err);
    return false;
  }
}

/**
 * Inspects all biometric capabilities available on this device.
 */
export async function getBiometricCapabilities(): Promise<BiometricCapabilities> {
  try {
    const [hasHardware, isEnrolled, rawTypes, enrolledLevel] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
      LocalAuthentication.supportedAuthenticationTypesAsync(),
      LocalAuthentication.getEnrolledLevelAsync(),
    ]);

    const supportedTypes: string[] = [];
    for (const t of rawTypes) {
      if (t === LocalAuthentication.AuthenticationType.FINGERPRINT) {
        supportedTypes.push('Fingerprint');
      } else if (t === LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION) {
        supportedTypes.push('Face Unlock');
      } else if (t === LocalAuthentication.AuthenticationType.IRIS) {
        supportedTypes.push('Iris');
      }
    }

    return {
      hasHardware,
      isEnrolled,
      supportedTypes,
      enrolledLevel: enrolledLevel as number,
    };
  } catch (err) {
    console.warn('[Biometrics] Capability detection error:', err);
    return {
      hasHardware: false,
      isEnrolled: false,
      supportedTypes: [],
      enrolledLevel: 0,
    };
  }
}

/**
 * Prompts native biometric prompt (Fingerprint / Face Unlock).
 * Guarantees seamless fallback to custom PIN on cancellation or request.
 */
export async function authenticateWithBiometrics(options?: {
  promptMessage?: string;
  cancelLabel?: string;
  fallbackLabel?: string;
}): Promise<BiometricAuthResult> {
  const pinConfigured = await isPinConfigured();
  if (!pinConfigured) {
    return { success: false, error: 'NO_PIN_CONFIGURED' };
  }

  const settings = await getSettings();
  if (settings.biometricsEnabled === false) {
    return { success: false, error: 'BIOMETRICS_DISABLED' };
  }

  const available = await isBiometricsAvailable();
  if (!available) {
    return { success: false, error: 'BIOMETRICS_UNAVAILABLE' };
  }

  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: options?.promptMessage ?? 'Unlock E.R.I.C.A. with Biometrics',
      cancelLabel: options?.cancelLabel ?? 'Cancel',
      fallbackLabel: options?.fallbackLabel ?? 'Use PIN',
      disableDeviceFallback: true, // Seamless fallback directly to ERICA custom PIN
    });

    if (result.success) {
      return { success: true };
    }

    const isFallback =
      result.error === 'user_fallback' ||
      result.error === 'app_cancel' ||
      result.error === 'user_cancel' ||
      result.error === 'system_cancel';

    return {
      success: false,
      error: result.error,
      fallbackChosen: isFallback,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      fallbackChosen: true,
    };
  }
}

/**
 * Verifies biometric credentials and unlocks the vault upon success.
 * If authentication fails or fallback is chosen, vault remains locked and
 * seamlessly transitions to PIN prompt.
 */
export async function unlockWithBiometrics(options?: {
  promptMessage?: string;
}): Promise<BiometricAuthResult> {
  const authResult = await authenticateWithBiometrics(options);
  if (authResult.success) {
    await unlockVaultWithMasterKey();
  }
  return authResult;
}
