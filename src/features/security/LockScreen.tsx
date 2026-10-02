import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppLock } from './useAppLock';
import { useSosService } from '../sos/sosMachine';
import { getLockoutRemainingSeconds } from './pinAuth';

function formatLockout(seconds: number): string {
  if (seconds < 60) {
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (secs === 0) {
    return `${mins} minute${mins === 1 ? '' : 's'}`;
  }
  return `${mins}m ${secs}s`;
}

export function LockScreen() {
  const { unlockWithPin, unlockWithBiometrics, isBiometricsAvailable } = useAppLock();
  const [sosState, sendSos] = useSosService();

  const [pin, setPin] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [lockoutRemaining, setLockoutRemaining] = useState(0);

  // Periodically check and count down lockout remaining time
  useEffect(() => {
    let active = true;
    const checkLockout = async () => {
      const remaining = await getLockoutRemainingSeconds();
      if (!active) return;
      setLockoutRemaining(remaining);
      if (remaining > 0) {
        setErrorMessage(`Too many failed attempts. Try again in ${formatLockout(remaining)}.`);
      }
    };
    checkLockout();

    const timer = setInterval(async () => {
      const remaining = await getLockoutRemainingSeconds();
      if (!active) return;
      setLockoutRemaining(remaining);
      if (remaining > 0) {
        setErrorMessage(`Too many failed attempts. Try again in ${formatLockout(remaining)}.`);
      } else {
        setErrorMessage((prev) => (prev.includes('Too many failed attempts') ? '' : prev));
      }
    }, 1000);

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  // Attempt seamless biometric prompt automatically upon screen appearance
  const attemptBiometrics = useCallback(async () => {
    if (!isBiometricsAvailable) return;
    setIsAuthenticating(true);
    setErrorMessage('');

    try {
      const result = await unlockWithBiometrics('Verify your biometric identity to unlock E.R.I.C.A.');
      if (!result.success && !result.fallbackChosen && result.error) {
        setErrorMessage('Biometric verification failed. Please enter your PIN.');
      }
    } catch {
      setErrorMessage('Biometrics unavailable. Please enter your PIN.');
    } finally {
      setIsAuthenticating(false);
    }
  }, [isBiometricsAvailable, unlockWithBiometrics]);

  useEffect(() => {
    attemptBiometrics();
  }, [attemptBiometrics]);

  const handlePinSubmit = async () => {
    // New PINs must be 6+ digits, but PINs set before that rule may be 4-5 digits.
    // Refusing to submit them here locked those users out of their own data for good.
    if (!pin || pin.length < 4) {
      setErrorMessage('PIN must be at least 4 digits');
      return;
    }

    setIsAuthenticating(true);
    setErrorMessage('');

    try {
      const success = await unlockWithPin(pin);
      if (!success) {
        const remaining = await getLockoutRemainingSeconds();
        if (remaining > 0) {
          setLockoutRemaining(remaining);
          setErrorMessage(`Too many failed attempts. Try again in ${formatLockout(remaining)}.`);
        } else {
          setErrorMessage('Incorrect PIN. Please try again.');
        }
        setPin('');
      } else {
        setPin('');
        setErrorMessage('');
        setLockoutRemaining(0);
      }
    } catch (err) {
      setErrorMessage('Unlock failed. Please try again.');
    } finally {
      setIsAuthenticating(false);
    }
  };

  const isEmergencyActive =
    sosState.matches('countdown') ||
    sosState.matches('dispatching') ||
    sosState.matches('active') ||
    sosState.matches('resolving');

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        {/* Emergency Dispatch Bypass Status Banner */}
        {isEmergencyActive ? (
          <View style={styles.emergencyBanner}>
            <Text style={styles.emergencyBannerTitle}>🚨 EMERGENCY ACTIVE</Text>
            {sosState.matches('countdown') && (
              <Text style={styles.emergencyBannerSubtext}>
                Dispatch countdown: {sosState.context.secondsRemaining}s
              </Text>
            )}
            {sosState.matches('dispatching') && (
              <Text style={styles.emergencyBannerSubtext}>
                Acquiring location & dispatching silent SMS...
              </Text>
            )}
            {sosState.matches('active') && (
              <Text style={styles.emergencyBannerSubtext}>
                Contacts alerted via SMS ({sosState.context.triggerSource})
              </Text>
            )}
            <Pressable
              style={styles.emergencyCancelButton}
              onPress={() => {
                if (sosState.matches('countdown')) {
                  sendSos({ type: 'CANCEL' });
                } else {
                  sendSos({ type: 'MARK_SAFE' });
                }
              }}
            >
              <Text style={styles.emergencyCancelButtonText}>
                {sosState.matches('countdown') ? 'CANCEL COUNTDOWN' : "I'M SAFE NOW"}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {/* Lock Header */}
        <View style={styles.headerContainer}>
          <View style={styles.shieldBadge}>
            <Text style={styles.shieldIcon}>🔒</Text>
          </View>
          <Text style={styles.title}>E.R.I.C.A. Security</Text>
          <Text style={styles.subtitle}>
            Enter your custom PIN or use biometric verification to access your emergency contacts and logs.
          </Text>
        </View>

        {/* PIN Input & Unlock Form */}
        <View style={styles.formContainer}>
          <TextInput
            style={styles.pinInput}
            value={pin}
            onChangeText={(v) => {
              setPin(v);
              if (errorMessage) setErrorMessage('');
            }}
            placeholder="Enter PIN"
            placeholderTextColor="#8E8E93"
            keyboardType="number-pad"
            secureTextEntry
            maxLength={12}
            autoFocus={!isBiometricsAvailable}
            onSubmitEditing={handlePinSubmit}
          />

          {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}

          <Pressable
            style={[styles.unlockButton, isAuthenticating && styles.buttonDisabled]}
            onPress={handlePinSubmit}
            disabled={isAuthenticating}
          >
            {isAuthenticating ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text style={styles.unlockButtonText}>Unlock with PIN</Text>
            )}
          </Pressable>

          {/* Biometric Verification Option */}
          {isBiometricsAvailable ? (
            <Pressable
              style={styles.biometricButton}
              onPress={attemptBiometrics}
              disabled={isAuthenticating}
            >
              <Text style={styles.biometricButtonText}>
                Fingerprint / Face Unlock
              </Text>
            </Pressable>
          ) : null}
        </View>

        {/* Emergency Dispatch Bypass Trigger */}
        {!isEmergencyActive ? (
          <View style={styles.footerContainer}>
            <Text style={styles.footerHelp}>In immediate danger?</Text>
            <Pressable
              style={styles.emergencySosButton}
              onPress={() => {
                sendSos({ type: 'TRIGGER', source: 'Lock Screen Emergency Button' });
              }}
            >
              <Text style={styles.emergencySosButtonText}>EMERGENCY SOS</Text>
            </Pressable>
            <Text style={styles.threatModelNotice}>
              Emergency dispatch & SMS alerts function immediately without requiring a PIN.
            </Text>
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0B0B0F' },
  container: {
    flex: 1,
    paddingHorizontal: 24,
    justifyContent: 'center',
    backgroundColor: '#0B0B0F',
  },
  emergencyBanner: {
    backgroundColor: '#3A1014',
    borderColor: '#D7263D',
    borderWidth: 1.5,
    borderRadius: 12,
    padding: 16,
    marginBottom: 20,
    alignItems: 'center',
  },
  emergencyBannerTitle: {
    color: '#FF4D4D',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  emergencyBannerSubtext: {
    color: '#E4E4E6',
    fontSize: 13,
    marginTop: 4,
    textAlign: 'center',
  },
  emergencyCancelButton: {
    backgroundColor: '#D7263D',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 16,
    marginTop: 10,
  },
  emergencyCancelButtonText: {
    color: 'white',
    fontSize: 13,
    fontWeight: '700',
  },
  headerContainer: { alignItems: 'center', marginBottom: 32 },
  shieldBadge: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: '#1E1E26',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#343442',
  },
  shieldIcon: { fontSize: 28 },
  title: { color: 'white', fontSize: 24, fontWeight: '700', marginBottom: 8 },
  subtitle: {
    color: '#8E8E93',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
    maxWidth: 280,
  },
  formContainer: { width: '100%', alignItems: 'center' },
  pinInput: {
    width: '100%',
    backgroundColor: '#16161C',
    borderColor: '#2C2C35',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 20,
    color: 'white',
    textAlign: 'center',
    letterSpacing: 8,
    marginBottom: 12,
  },
  errorText: { color: '#FF4D4D', fontSize: 13, marginBottom: 12, textAlign: 'center' },
  unlockButton: {
    width: '100%',
    backgroundColor: '#D7263D',
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginBottom: 12,
  },
  buttonDisabled: { opacity: 0.6 },
  unlockButtonText: { color: 'white', fontSize: 16, fontWeight: '700' },
  biometricButton: {
    paddingVertical: 12,
    paddingHorizontal: 20,
  },
  biometricButtonText: { color: '#C7C7CC', fontSize: 14, fontWeight: '600' },
  footerContainer: { marginTop: 40, alignItems: 'center' },
  footerHelp: { color: '#8E8E93', fontSize: 13, marginBottom: 8 },
  emergencySosButton: {
    backgroundColor: '#7A141E',
    borderColor: '#D7263D',
    borderWidth: 1,
    borderRadius: 24,
    paddingVertical: 10,
    paddingHorizontal: 24,
    marginBottom: 12,
  },
  emergencySosButtonText: { color: 'white', fontSize: 14, fontWeight: '700', letterSpacing: 0.5 },
  threatModelNotice: {
    color: '#636366',
    fontSize: 11,
    textAlign: 'center',
    lineHeight: 15,
    maxWidth: 260,
  },
});
