import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ScrollView, Switch, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { getSettings, saveSettings, DEFAULT_SETTINGS, type Settings } from './settingsStorage';
import { requestEvidencePermission } from '../permissions/emergencyPermissions';
import {
  isPinConfigured,
  setupPin,
  changePin,
  isDuressPinConfigured,
  setupDuressPin,
  changeDuressPin,
  removeDuressPin,
  useAppLock,
  getBiometricCapabilities,
  type BiometricCapabilities,
} from '../security';
import {
  configureVolumeTrigger,
  configureShakeTrigger,
  startShakeSensitivityTest,
  stopShakeSensitivityTest,
  addShakeTestListener,
  type ShakeTestSample,
  VolumePatternEngine,
  ShakeDetectorEngine,
} from '../../../modules/physical-triggers';
import {
  startDeterrence,
  stopDeterrence,
} from '../../../modules/deterrence-evidence';

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  description?: string;
  onChange: (val: number) => void;
}

function SliderControl({ label, value, min, max, step = 1, unit = '', description, onChange }: SliderProps) {
  const percentage = Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));

  const handleDecrease = () => {
    const next = Math.max(min, Math.round((value - step) * 100) / 100);
    onChange(next);
  };

  const handleIncrease = () => {
    const next = Math.min(max, Math.round((value + step) * 100) / 100);
    onChange(next);
  };

  return (
    <View style={styles.sliderContainer}>
      <View style={styles.sliderHeaderRow}>
        <Text style={styles.sliderLabel}>{label}</Text>
        <Text style={styles.sliderValueText}>
          {value}
          {unit}
        </Text>
      </View>
      {description ? <Text style={styles.sliderDescription}>{description}</Text> : null}
      <View style={styles.sliderTrackRow}>
        <Pressable style={styles.stepperButton} onPress={handleDecrease} accessibilityLabel={`Decrease ${label}`}>
          <Text style={styles.stepperButtonText}>−</Text>
        </Pressable>
        <View style={styles.sliderTrackBackground}>
          <View style={[styles.sliderTrackFill, { width: `${percentage}%` }]} />
        </View>
        <Pressable style={styles.stepperButton} onPress={handleIncrease} accessibilityLabel={`Increase ${label}`}>
          <Text style={styles.stepperButtonText}>+</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function SettingsScreen() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [countdownText, setCountdownText] = useState('10');
  const [retryCeilingText, setRetryCeilingText] = useState('60');
  const [saved, setSaved] = useState(false);

  // App Lock & Biometrics state
  const { lock, refreshState: refreshLockState } = useAppLock();
  const [pinConfigured, setPinConfigured] = useState(false);
  const [biometricsCap, setBiometricsCap] = useState<BiometricCapabilities>({
    hasHardware: false,
    isEnrolled: false,
    supportedTypes: [],
    enrolledLevel: 0,
  });
  const [biometricsEnabled, setBiometricsEnabled] = useState(true);
  const [lockTimeout, setLockTimeout] = useState(0);
  const [pinInput, setPinInput] = useState('');
  const [currentPinInput, setCurrentPinInput] = useState('');
  const [pinConfirmInput, setPinConfirmInput] = useState('');
  const [pinMessage, setPinMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [isChangingPin, setIsChangingPin] = useState(false);

  // Duress PIN & Anti-Coercion state
  const [duressPinConfigured, setDuressPinConfigured] = useState(false);
  const [duressPinInput, setDuressPinInput] = useState('');
  const [currentDuressPinInput, setCurrentDuressPinInput] = useState('');
  const [duressPinConfirmInput, setDuressPinConfirmInput] = useState('');
  const [duressPinMessage, setDuressPinMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [isChangingDuressPin, setIsChangingDuressPin] = useState(false);
  const [duressSilentSosEnabled, setDuressSilentSosEnabled] = useState(false);
  const [decoyContactsType, setDecoyContactsType] = useState<'mock' | 'empty'>('mock');

  // Volume button pattern state
  const [volumeEnabled, setVolumeEnabled] = useState(false);
  const [volumePressCount, setVolumePressCount] = useState(4);
  const [volumeWindowSeconds, setVolumeWindowSeconds] = useState(3);
  const [volumeTestPresses, setVolumeTestPresses] = useState(0);
  const [volumeTestSuccess, setVolumeTestSuccess] = useState(false);
  const volumeTestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const volumeEngineRef = useRef<VolumePatternEngine>(
    new VolumePatternEngine({
      enabled: true,
      pressCount: 4,
      windowSeconds: 3,
      onTrigger: () => {
        setVolumeTestSuccess(true);
        setTimeout(() => setVolumeTestSuccess(false), 2500);
      },
    })
  );

  // Shake detector state
  const [shakeEnabled, setShakeEnabled] = useState(false);
  const [shakeThreshold, setShakeThreshold] = useState(25);
  const [shakeMinCount, setShakeMinCount] = useState(3);
  const [shakeAlpha, setShakeAlpha] = useState(0.8);
  const [isShakeTesting, setIsShakeTesting] = useState(false);
  const [currentJerk, setCurrentJerk] = useState(0);
  const [shakeTestSuccess, setShakeTestSuccess] = useState(false);
  const shakeEngineRef = useRef<ShakeDetectorEngine>(
    new ShakeDetectorEngine({
      enabled: true,
      jerkThreshold: 25,
      minShakes: 3,
      highPassAlpha: 0.8,
      onTrigger: () => {
        setShakeTestSuccess(true);
        setTimeout(() => setShakeTestSuccess(false), 2500);
      },
    })
  );

  // Phase 4 Deterrence & Evidence state
  const [sirenEnabled, setSirenEnabled] = useState(false);
  const [strobeEnabled, setStrobeEnabled] = useState(false);
  const [respectSilentMode, setRespectSilentMode] = useState(true);
  const [isDeterrenceTesting, setIsDeterrenceTesting] = useState(false);
  const [deterrenceTestFeedback, setDeterrenceTestFeedback] = useState<string | null>(null);

  const [audioConsentEnabled, setAudioConsentEnabled] = useState(false);
  const [photoConsentEnabled, setPhotoConsentEnabled] = useState(false);
  const [dualCameraEnabled, setDualCameraEnabled] = useState(true);

  useFocusEffect(
    useCallback(() => {
      getSettings().then((s) => {
        setSettings(s);
        setCountdownText(String(s.countdownSeconds ?? 10));
        setRetryCeilingText(String(s.retryCeilingSeconds ?? 60));
        setVolumeEnabled(Boolean(s.volumeTriggerEnabled));
        setVolumePressCount(s.volumePressCount ?? 4);
        setVolumeWindowSeconds(s.volumeWindowSeconds ?? 3);
        setShakeEnabled(Boolean(s.shakeTriggerEnabled));
        setShakeThreshold(s.shakeThreshold ?? 25);
        setShakeMinCount(s.shakeMinCount ?? 3);
        setShakeAlpha(s.shakeHighPassAlpha ?? 0.8);
        setBiometricsEnabled(s.biometricsEnabled ?? true);
        setLockTimeout(s.appLockTimeoutSeconds ?? 0);
        setDuressSilentSosEnabled(Boolean(s.duressSilentSosEnabled));
        setDecoyContactsType(s.decoyContactsType ?? 'mock');
        setSirenEnabled(Boolean(s.deterrenceSirenEnabled));
        setStrobeEnabled(Boolean(s.deterrenceStrobeEnabled));
        setRespectSilentMode(s.respectSilentMode ?? true);
        setAudioConsentEnabled(Boolean(s.evidenceAudioConsentEnabled));
        setPhotoConsentEnabled(Boolean(s.evidencePhotoConsentEnabled));
        setDualCameraEnabled(s.evidenceDualCamera ?? true);

        volumeEngineRef.current.configure({
          enabled: true,
          pressCount: s.volumePressCount ?? 4,
          windowSeconds: s.volumeWindowSeconds ?? 3,
        });

        shakeEngineRef.current.configure({
          enabled: true,
          jerkThreshold: s.shakeThreshold ?? 25,
          minShakes: s.shakeMinCount ?? 3,
          highPassAlpha: s.shakeHighPassAlpha ?? 0.8,
        });
      });

      isPinConfigured().then(setPinConfigured);
      isDuressPinConfigured().then(setDuressPinConfigured);
      getBiometricCapabilities().then(setBiometricsCap);
    }, [])
  );

  const handleSetupPin = async () => {
    if (pinInput.length < 6) {
      setPinMessage({ text: 'PIN must be at least 6 digits', error: true });
      return;
    }
    if (pinInput !== pinConfirmInput) {
      setPinMessage({ text: 'PINs do not match', error: true });
      return;
    }
    try {
      await setupPin(pinInput);
      setPinConfigured(true);
      setPinInput('');
      setPinConfirmInput('');
      setPinMessage({ text: 'PIN successfully configured!', error: false });
      await refreshLockState();
    } catch {
      setPinMessage({ text: 'Failed to configure PIN', error: true });
    }
  };

  const handleChangePin = async () => {
    if (pinInput.length < 6) {
      setPinMessage({ text: 'New PIN must be at least 6 digits', error: true });
      return;
    }
    if (pinInput !== pinConfirmInput) {
      setPinMessage({ text: 'New PINs do not match', error: true });
      return;
    }
    try {
      const success = await changePin(currentPinInput, pinInput);
      if (!success) {
        setPinMessage({ text: 'Current PIN is incorrect', error: true });
        return;
      }
      setPinInput('');
      setCurrentPinInput('');
      setPinConfirmInput('');
      setIsChangingPin(false);
      setPinMessage({ text: 'PIN successfully updated!', error: false });
      await refreshLockState();
    } catch (err) {
      setPinMessage({
        text: err instanceof Error ? err.message : 'Failed to change PIN',
        error: true,
      });
    }
  };

  const handleSetupDuressPin = async () => {
    if (duressPinInput.length < 6) {
      setDuressPinMessage({ text: 'Duress PIN must be at least 6 digits', error: true });
      return;
    }
    if (duressPinInput !== duressPinConfirmInput) {
      setDuressPinMessage({ text: 'Duress PINs do not match', error: true });
      return;
    }
    try {
      await setupDuressPin(duressPinInput);
      setDuressPinConfigured(true);
      setBiometricsEnabled(false);
      setSettings((s) => ({ ...s, biometricsEnabled: false }));
      setDuressPinInput('');
      setDuressPinConfirmInput('');
      setDuressPinMessage({ text: 'Duress PIN successfully configured! Biometrics disabled by default (Coercion Guard).', error: false });
      await refreshLockState();
    } catch (err) {
      setDuressPinMessage({
        text: err instanceof Error ? err.message : 'Failed to configure Duress PIN',
        error: true,
      });
    }
  };

  const handleChangeDuressPin = async () => {
    if (duressPinInput.length < 6) {
      setDuressPinMessage({ text: 'New Duress PIN must be at least 6 digits', error: true });
      return;
    }
    if (duressPinInput !== duressPinConfirmInput) {
      setDuressPinMessage({ text: 'New Duress PINs do not match', error: true });
      return;
    }
    try {
      const success = await changeDuressPin(currentDuressPinInput, duressPinInput);
      if (!success) {
        setDuressPinMessage({ text: 'Current Duress PIN is incorrect', error: true });
        return;
      }
      setDuressPinInput('');
      setCurrentDuressPinInput('');
      setDuressPinConfirmInput('');
      setIsChangingDuressPin(false);
      setDuressPinMessage({ text: 'Duress PIN successfully updated!', error: false });
      await refreshLockState();
    } catch (err) {
      setDuressPinMessage({
        text: err instanceof Error ? err.message : 'Failed to change Duress PIN',
        error: true,
      });
    }
  };

  const handleRemoveDuressPin = async () => {
    try {
      await removeDuressPin();
      setDuressPinConfigured(false);
      setDuressPinInput('');
      setCurrentDuressPinInput('');
      setDuressPinConfirmInput('');
      setIsChangingDuressPin(false);
      setDuressPinMessage({ text: 'Duress PIN removed', error: false });
      await refreshLockState();
    } catch {
      setDuressPinMessage({ text: 'Failed to remove Duress PIN', error: true });
    }
  };

  const handleBiometricsToggle = (val: boolean) => {
    if (val && duressPinConfigured) {
      Alert.alert(
        'Security Warning',
        'Enabling biometrics allows an adversary to force unlock your real contacts using your face or finger, bypassing Duress Mode.',
        [
          {
            text: 'Cancel',
            style: 'cancel',
            onPress: () => {
              setBiometricsEnabled(false);
            },
          },
          {
            text: 'Enable Anyway',
            style: 'destructive',
            onPress: async () => {
              setBiometricsEnabled(true);
              const updated = { ...settings, biometricsEnabled: true };
              setSettings(updated);
              await saveSettings(updated);
              await refreshLockState();
            },
          },
        ]
      );
      return;
    }
    setBiometricsEnabled(val);
    const updated = { ...settings, biometricsEnabled: val };
    setSettings(updated);
    saveSettings(updated);
    refreshLockState();
  };

  // Listen for shake sensitivity test samples
  useEffect(() => {
    const sub = addShakeTestListener((sample: ShakeTestSample) => {
      if (isShakeTesting) {
        setCurrentJerk(Math.round(sample.currentJerk * 100) / 100);
        // The native sensor reports spikes only (it never sets isTriggered), so run the
        // reversal/window rules locally to tell the user whether the pattern would fire.
        if (sample.isSpike && shakeEngineRef.current.registerSpike(sample.timestamp)) {
          setShakeTestSuccess(true);
          setTimeout(() => setShakeTestSuccess(false), 2500);
        }
      }
    });
    return () => {
      sub.remove();
      if (isShakeTesting) {
        stopShakeSensitivityTest().catch(() => {});
      }
    };
  }, [isShakeTesting]);

  const onVolumeToggle = (enabled: boolean) => {
    setVolumeEnabled(enabled);
    setSettings((s) => ({ ...s, volumeTriggerEnabled: enabled }));
  };

  const onVolumePressCountChange = (count: number) => {
    setVolumePressCount(count);
    volumeEngineRef.current.configure({ pressCount: count });
    setSettings((s) => ({ ...s, volumePressCount: count }));
  };

  const onVolumeWindowChange = (seconds: number) => {
    setVolumeWindowSeconds(seconds);
    volumeEngineRef.current.configure({ windowSeconds: seconds });
    setSettings((s) => ({ ...s, volumeWindowSeconds: seconds }));
  };

  // Rehearsal only drives the local engine. The previous version also called the global
  // simulateVolumePress(), which fed the armed detectors and started a real SOS.
  const handleTestVolumePress = () => {
    const triggered = volumeEngineRef.current.onPress(Date.now(), false);
    const activeCount = volumeEngineRef.current.getActivePressCount();
    setVolumeTestPresses(activeCount);

    if (volumeTestTimerRef.current) {
      clearTimeout(volumeTestTimerRef.current);
    }
    volumeTestTimerRef.current = setTimeout(() => {
      setVolumeTestPresses(0);
    }, volumeWindowSeconds * 1000);

    if (triggered) {
      setVolumeTestSuccess(true);
      setTimeout(() => setVolumeTestSuccess(false), 2500);
    }
  };

  const onShakeToggle = (enabled: boolean) => {
    setShakeEnabled(enabled);
    setSettings((s) => ({ ...s, shakeTriggerEnabled: enabled }));
  };

  const onShakeThresholdChange = (threshold: number) => {
    setShakeThreshold(threshold);
    shakeEngineRef.current.configure({ jerkThreshold: threshold });
    setSettings((s) => ({ ...s, shakeThreshold: threshold }));
  };

  const onShakeMinCountChange = (count: number) => {
    setShakeMinCount(count);
    shakeEngineRef.current.configure({ minShakes: count });
    setSettings((s) => ({ ...s, shakeMinCount: count }));
  };

  const onShakeAlphaChange = (alpha: number) => {
    setShakeAlpha(alpha);
    shakeEngineRef.current.configure({ highPassAlpha: alpha });
    setSettings((s) => ({ ...s, shakeHighPassAlpha: alpha }));
  };

  const toggleShakeTest = async () => {
    if (isShakeTesting) {
      setIsShakeTesting(false);
      setCurrentJerk(0);
      await stopShakeSensitivityTest().catch(() => {});
    } else {
      setIsShakeTesting(true);
      await startShakeSensitivityTest({
        highPassAlpha: shakeAlpha,
        jerkThreshold: shakeThreshold,
      }).catch(() => {});
    }
  };

  // Same as above: never route simulated shakes into the armed global detectors.
  const handleSimulateShake = () => {
    const now = Date.now();
    shakeEngineRef.current.processSample(0, 0, 9.8, now);
    shakeEngineRef.current.processSample(shakeThreshold * 0.06, 0, 9.8, now + 50);
    const sample2 = shakeEngineRef.current.processSample(-shakeThreshold * 0.06, 0, 9.8, now + 200);
    const sample3 = shakeEngineRef.current.processSample(shakeThreshold * 0.06, 0, 9.8, now + 350);

    setCurrentJerk(sample3.currentJerk || sample2.currentJerk);
    if (sample3.isTriggered || sample2.isTriggered) {
      setShakeTestSuccess(true);
      setTimeout(() => setShakeTestSuccess(false), 2500);
    }
  };

  const onCountdownChange = (text: string) => {
    setCountdownText(text);
    const parsed = parseInt(text, 10);
    if (!isNaN(parsed) && parsed > 0) {
      setSettings((s) => ({ ...s, countdownSeconds: parsed }));
    }
  };

  const onRetryCeilingChange = (text: string) => {
    setRetryCeilingText(text);
    const parsed = parseInt(text, 10);
    if (!isNaN(parsed) && parsed > 0) {
      setSettings((s) => ({ ...s, retryCeilingSeconds: parsed }));
    }
  };

  const onSave = async () => {
    const finalCountdown = Math.max(3, parseInt(countdownText, 10) || 10);
    const finalRetryCeiling = Math.max(5, parseInt(retryCeilingText, 10) || 60);

    const toSave: Settings = {
      ...settings,
      countdownSeconds: finalCountdown,
      retryCeilingSeconds: finalRetryCeiling,
      volumeTriggerEnabled: volumeEnabled,
      volumePressCount,
      volumeWindowSeconds,
      shakeTriggerEnabled: shakeEnabled,
      shakeThreshold,
      shakeMinCount,
      shakeHighPassAlpha: shakeAlpha,
      appLockTimeoutSeconds: lockTimeout,
      biometricsEnabled,
      duressSilentSosEnabled,
      decoyContactsType,
      deterrenceSirenEnabled: sirenEnabled,
      deterrenceStrobeEnabled: strobeEnabled,
      respectSilentMode,
      evidenceAudioConsentEnabled: audioConsentEnabled,
      evidencePhotoConsentEnabled: photoConsentEnabled,
      evidenceDualCamera: dualCameraEnabled,
    };

    await saveSettings(toSave);
    await refreshLockState();
    await configureVolumeTrigger({
      enabled: volumeEnabled,
      pressCount: volumePressCount,
      windowSeconds: volumeWindowSeconds,
    }).catch(() => {});

    await configureShakeTrigger({
      enabled: shakeEnabled,
      jerkThreshold: shakeThreshold,
      minShakes: shakeMinCount,
      highPassAlpha: shakeAlpha,
    }).catch(() => {});

    setSettings(toSave);
    setCountdownText(String(finalCountdown));
    setRetryCeilingText(String(finalRetryCeiling));
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const handleTestDeterrence = async () => {
    if (isDeterrenceTesting) {
      await stopDeterrence().catch(() => {});
      setIsDeterrenceTesting(false);
      setDeterrenceTestFeedback('Test stopped.');
      setTimeout(() => setDeterrenceTestFeedback(null), 2500);
      return;
    }

    if (!sirenEnabled && !strobeEnabled) {
      setDeterrenceTestFeedback('Enable Siren or Strobe first to test.');
      setTimeout(() => setDeterrenceTestFeedback(null), 3000);
      return;
    }

    setIsDeterrenceTesting(true);
    setDeterrenceTestFeedback('Testing deterrence for 3s (no emergency dispatch)...');
    try {
      const status = await startDeterrence({
        sirenEnabled,
        strobeEnabled,
        respectSilentMode,
      });

      if (status.suppressedBySilentMode) {
        setDeterrenceTestFeedback('Siren suppressed (device in silent/vibrate mode). Strobe active.');
      }

      setTimeout(async () => {
        await stopDeterrence().catch(() => {});
        setIsDeterrenceTesting(false);
        setDeterrenceTestFeedback('✓ Deterrence test completed cleanly (stopped).');
        setTimeout(() => setDeterrenceTestFeedback(null), 3000);
      }, 3000);
    } catch {
      setIsDeterrenceTesting(false);
      setDeterrenceTestFeedback('Deterrence test failed.');
      setTimeout(() => setDeterrenceTestFeedback(null), 3000);
    }
  };

  const handleAudioConsentToggle = (val: boolean) => {
    if (val) {
      Alert.alert(
        'Informed Audio Consent',
        'Enable ambient audio recording during emergencies? Ambient audio is recorded off the main thread and strictly encrypted at rest with AES-256-GCM using your hardware master key.',
        [
          {
            text: 'Cancel',
            style: 'cancel',
            onPress: () => setAudioConsentEnabled(false),
          },
          {
            text: 'I Consent',
            style: 'default',
            onPress: async () => {
              // In-app consent is not enough; Android must grant the permission too.
              if (!(await requestEvidencePermission('audio'))) {
                setAudioConsentEnabled(false);
                Alert.alert(
                  'Microphone permission needed',
                  'Microphone access was not granted, so this stays off. You can allow it in system settings.'
                );
                return;
              }
              setAudioConsentEnabled(true);
              setSettings((s) => ({ ...s, evidenceAudioConsentEnabled: true }));
            },
          },
        ]
      );
      return;
    }
    setAudioConsentEnabled(false);
    setSettings((s) => ({ ...s, evidenceAudioConsentEnabled: false }));
  };

  const handlePhotoConsentToggle = (val: boolean) => {
    if (val) {
      Alert.alert(
        'Informed Photo Consent',
        'Enable camera photo capture during emergencies? Photos from front and rear cameras will be captured off the main thread and encrypted at rest with AES-256-GCM.',
        [
          {
            text: 'Cancel',
            style: 'cancel',
            onPress: () => setPhotoConsentEnabled(false),
          },
          {
            text: 'I Consent',
            style: 'default',
            onPress: async () => {
              // In-app consent is not enough; Android must grant the permission too.
              if (!(await requestEvidencePermission('camera'))) {
                setPhotoConsentEnabled(false);
                Alert.alert(
                  'Camera permission needed',
                  'Camera access was not granted, so this stays off. You can allow it in system settings.'
                );
                return;
              }
              setPhotoConsentEnabled(true);
              setSettings((s) => ({ ...s, evidencePhotoConsentEnabled: true }));
            },
          },
        ]
      );
      return;
    }
    setPhotoConsentEnabled(false);
    setSettings((s) => ({ ...s, evidencePhotoConsentEnabled: false }));
  };

  const jerkProgressPercent = Math.min(100, Math.round((currentJerk / Math.max(1, shakeThreshold * 1.5)) * 100));

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        <Text style={styles.title}>Settings</Text>

        {/* Section: General Emergency Settings */}
        <View style={styles.sectionCard}>
          <Text style={styles.sectionHeader}>Emergency Countdown & Retries</Text>

          <Text style={styles.label}>Countdown length (seconds)</Text>
          <TextInput
            style={styles.input}
            keyboardType="number-pad"
            value={countdownText}
            onChangeText={onCountdownChange}
            placeholder="Min 3 seconds"
            placeholderTextColor="#8E8E93"
          />
          <Text style={styles.helperText}>Configurable countdown before emergency dispatch (min 3s).</Text>

          <Text style={styles.label}>Retry backoff ceiling (seconds)</Text>
          <TextInput
            style={styles.input}
            keyboardType="number-pad"
            value={retryCeilingText}
            onChangeText={onRetryCeilingChange}
            placeholder="e.g. 60"
            placeholderTextColor="#8E8E93"
          />
          <Text style={styles.helperText}>Maximum delay ceiling between retries during cellular dead zones (min 5s).</Text>

          <Text style={styles.label}>Your name (shown to contacts)</Text>
          <TextInput
            style={styles.input}
            value={settings.userName}
            onChangeText={(v) => setSettings((s) => ({ ...s, userName: v }))}
            placeholder="e.g. Jesse"
            placeholderTextColor="#8E8E93"
          />

          <Text style={styles.label}>Custom alert message</Text>
          <TextInput
            style={[styles.input, styles.multiline]}
            value={settings.customMessage}
            onChangeText={(v) => setSettings((s) => ({ ...s, customMessage: v }))}
            placeholder="Leave blank to use the default message"
            placeholderTextColor="#8E8E93"
            multiline
          />
        </View>

        {/* Section: Security, Biometrics & App Lock Gatekeeper */}
        <View style={styles.sectionCard}>
          <Text style={styles.sectionHeader}>Security & App Lock Gatekeeper</Text>
          <Text style={styles.helperText}>
            Protects your UI and sensitive contact/history logs with PBKDF2 stretched PIN and biometrics.
          </Text>

          {/* PIN Status & Configuration */}
          <View style={styles.subSection}>
            <View style={styles.pinStatusRow}>
              <Text style={styles.triggerTitle}>
                {pinConfigured ? 'Vault Protected (PIN Active)' : 'No PIN Configured'}
              </Text>
              {pinConfigured ? (
                <Pressable
                  style={styles.lockNowButton}
                  onPress={() => lock()}
                  accessibilityLabel="Lock App Now"
                >
                  <Text style={styles.lockNowButtonText}>Lock Now</Text>
                </Pressable>
              ) : null}
            </View>

            {pinMessage ? (
              <Text
                style={[
                  styles.pinFeedbackText,
                  pinMessage.error ? styles.pinFeedbackError : styles.pinFeedbackSuccess,
                ]}
              >
                {pinMessage.text}
              </Text>
            ) : null}

            {!pinConfigured ? (
              <View style={styles.pinForm}>
                <Text style={styles.label}>Set 6-8 Digit Custom PIN</Text>
                <TextInput
                  style={styles.input}
                  placeholder="New PIN (min 6 digits)"
                  placeholderTextColor="#8E8E93"
                  keyboardType="number-pad"
                  secureTextEntry
                  value={pinInput}
                  onChangeText={setPinInput}
                />
                <TextInput
                  style={[styles.input, { marginTop: 8 }]}
                  placeholder="Confirm New PIN"
                  placeholderTextColor="#8E8E93"
                  keyboardType="number-pad"
                  secureTextEntry
                  value={pinConfirmInput}
                  onChangeText={setPinConfirmInput}
                />
                <Pressable style={styles.pinActionButton} onPress={handleSetupPin}>
                  <Text style={styles.pinActionButtonText}>Enable App Lock</Text>
                </Pressable>
              </View>
            ) : isChangingPin ? (
              <View style={styles.pinForm}>
                <Text style={styles.label}>Change PIN</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Current PIN"
                  placeholderTextColor="#8E8E93"
                  keyboardType="number-pad"
                  secureTextEntry
                  value={currentPinInput}
                  onChangeText={setCurrentPinInput}
                />
                <TextInput
                  style={[styles.input, { marginTop: 8 }]}
                  placeholder="New PIN (min 6 digits)"
                  placeholderTextColor="#8E8E93"
                  keyboardType="number-pad"
                  secureTextEntry
                  value={pinInput}
                  onChangeText={setPinInput}
                />
                <TextInput
                  style={[styles.input, { marginTop: 8 }]}
                  placeholder="Confirm New PIN"
                  placeholderTextColor="#8E8E93"
                  keyboardType="number-pad"
                  secureTextEntry
                  value={pinConfirmInput}
                  onChangeText={setPinConfirmInput}
                />
                <View style={styles.pinActionRow}>
                  <Pressable
                    style={[styles.pinActionButton, { flex: 1 }]}
                    onPress={handleChangePin}
                  >
                    <Text style={styles.pinActionButtonText}>Update PIN</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.pinCancelButton, { flex: 1 }]}
                    onPress={() => {
                      setIsChangingPin(false);
                      setPinInput('');
                      setCurrentPinInput('');
                      setPinConfirmInput('');
                      setPinMessage(null);
                    }}
                  >
                    <Text style={styles.pinCancelButtonText}>Cancel</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <Pressable
                style={styles.changePinButton}
                onPress={() => {
                  setIsChangingPin(true);
                  setPinMessage(null);
                }}
              >
                <Text style={styles.changePinButtonText}>Change Custom PIN</Text>
              </Pressable>
            )}
          </View>

          {/* Biometrics Toggle */}
          <View style={styles.subSection}>
            <View style={styles.switchRow}>
              <View style={styles.switchLabelContainer}>
                <Text style={styles.triggerTitle}>Biometric Verification</Text>
                <Text style={styles.triggerSubtitle}>
                  {biometricsCap.supportedTypes.length > 0
                    ? `Use ${biometricsCap.supportedTypes.join(' / ')} with seamless PIN fallback`
                    : 'Fingerprint / Face Unlock with seamless PIN fallback'}
                </Text>
              </View>
              <Switch
                value={biometricsEnabled}
                onValueChange={handleBiometricsToggle}
                trackColor={{ false: '#3A3A3C', true: '#2E7D32' }}
                thumbColor="#FFFFFF"
              />
            </View>
            {duressPinConfigured && biometricsEnabled ? (
              <View style={styles.coercionWarningBox}>
                <Text style={styles.coercionWarningText}>
                  ⚠️ Warning: Enabling biometrics allows an adversary to force unlock your real contacts using your face or finger, bypassing Duress Mode.
                </Text>
              </View>
            ) : null}
          </View>

          {/* Lock Timeout Selection */}
          <View style={styles.subSection}>
            <Text style={styles.triggerTitle}>App Lock Timeout</Text>
            <Text style={styles.triggerSubtitle}>
              Engage lock state immediately when backgrounded or after an idle timeout.
            </Text>

            <View style={styles.timeoutOptionsRow}>
              {[
                { label: 'Immediate', value: 0 },
                { label: '15s', value: 15 },
                { label: '30s', value: 30 },
                { label: '60s', value: 60 },
              ].map((opt) => (
                <Pressable
                  key={opt.value}
                  style={[
                    styles.timeoutOptionButton,
                    lockTimeout === opt.value && styles.timeoutOptionActive,
                  ]}
                  onPress={() => {
                    setLockTimeout(opt.value);
                    setSettings((s) => ({ ...s, appLockTimeoutSeconds: opt.value }));
                  }}
                >
                  <Text
                    style={[
                      styles.timeoutOptionText,
                      lockTimeout === opt.value && styles.timeoutOptionTextActive,
                    ]}
                  >
                    {opt.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {/* SubSection: Secondary Duress PIN & Anti-Coercion Protection */}
          <View style={styles.subSection}>
            <View style={styles.pinStatusRow}>
              <View style={{ flex: 1, paddingRight: 8 }}>
                <Text style={styles.triggerTitle}>Secondary Duress PIN (Anti-Coercion)</Text>
                <Text style={styles.triggerSubtitle}>
                  {duressPinConfigured
                    ? 'Decoy Protection Active: entering Duress PIN reveals a benign decoy screen without alerting the adversary.'
                    : 'Optional secondary PIN to enter if forced to unlock under physical coercion.'}
                </Text>
              </View>
            </View>

            {duressPinMessage ? (
              <Text
                style={[
                  styles.pinFeedbackText,
                  duressPinMessage.error ? styles.pinFeedbackError : styles.pinFeedbackSuccess,
                ]}
              >
                {duressPinMessage.text}
              </Text>
            ) : null}

            {!pinConfigured ? (
              <Text style={styles.helperText}>
                Configure your primary PIN first above to enable the secondary Duress PIN.
              </Text>
            ) : !duressPinConfigured ? (
              <View style={styles.pinForm}>
                <Text style={styles.label}>Set 6-8 Digit Duress PIN</Text>
                <TextInput
                  style={styles.input}
                  placeholder="New Duress PIN (min 6 digits)"
                  placeholderTextColor="#8E8E93"
                  keyboardType="number-pad"
                  secureTextEntry
                  value={duressPinInput}
                  onChangeText={setDuressPinInput}
                />
                <TextInput
                  style={[styles.input, { marginTop: 8 }]}
                  placeholder="Confirm Duress PIN"
                  placeholderTextColor="#8E8E93"
                  keyboardType="number-pad"
                  secureTextEntry
                  value={duressPinConfirmInput}
                  onChangeText={setDuressPinConfirmInput}
                />
                <Pressable style={styles.pinActionButton} onPress={handleSetupDuressPin}>
                  <Text style={styles.pinActionButtonText}>Enable Duress PIN</Text>
                </Pressable>
              </View>
            ) : isChangingDuressPin ? (
              <View style={styles.pinForm}>
                <Text style={styles.label}>Change Duress PIN</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Current Duress PIN"
                  placeholderTextColor="#8E8E93"
                  keyboardType="number-pad"
                  secureTextEntry
                  value={currentDuressPinInput}
                  onChangeText={setCurrentDuressPinInput}
                />
                <TextInput
                  style={[styles.input, { marginTop: 8 }]}
                  placeholder="New Duress PIN (min 6 digits)"
                  placeholderTextColor="#8E8E93"
                  keyboardType="number-pad"
                  secureTextEntry
                  value={duressPinInput}
                  onChangeText={setDuressPinInput}
                />
                <TextInput
                  style={[styles.input, { marginTop: 8 }]}
                  placeholder="Confirm New Duress PIN"
                  placeholderTextColor="#8E8E93"
                  keyboardType="number-pad"
                  secureTextEntry
                  value={duressPinConfirmInput}
                  onChangeText={setDuressPinConfirmInput}
                />
                <View style={styles.pinActionRow}>
                  <Pressable
                    style={[styles.pinActionButton, { flex: 1 }]}
                    onPress={handleChangeDuressPin}
                  >
                    <Text style={styles.pinActionButtonText}>Update Duress PIN</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.pinCancelButton, { flex: 1 }]}
                    onPress={() => {
                      setIsChangingDuressPin(false);
                      setDuressPinInput('');
                      setCurrentDuressPinInput('');
                      setDuressPinConfirmInput('');
                      setDuressPinMessage(null);
                    }}
                  >
                    <Text style={styles.pinCancelButtonText}>Cancel</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <View style={styles.pinActionRow}>
                <Pressable
                  style={[styles.changePinButton, { flex: 1, marginTop: 4 }]}
                  onPress={() => {
                    setIsChangingDuressPin(true);
                    setDuressPinMessage(null);
                  }}
                >
                  <Text style={styles.changePinButtonText}>Change Duress PIN</Text>
                </Pressable>
                <Pressable
                  style={[styles.removePinButton, { flex: 1, marginTop: 4 }]}
                  onPress={handleRemoveDuressPin}
                >
                  <Text style={styles.removePinButtonText}>Remove Duress PIN</Text>
                </Pressable>
              </View>
            )}

            {/* Duress Stealth Silent SOS Option */}
            <View style={[styles.switchRow, { marginTop: 16 }]}>
              <View style={styles.switchLabelContainer}>
                <Text style={styles.triggerTitle}>Stealth Silent SOS on Duress</Text>
                <Text style={styles.triggerSubtitle}>
                  Silently dispatch emergency SMS alert to real contacts in background when Duress PIN is entered.
                </Text>
              </View>
              <Switch
                value={duressSilentSosEnabled}
                onValueChange={(val) => {
                  setDuressSilentSosEnabled(val);
                  setSettings((s) => ({ ...s, duressSilentSosEnabled: val }));
                }}
                trackColor={{ false: '#3A3A3C', true: '#D7263D' }}
                thumbColor="#FFFFFF"
              />
            </View>

            {/* Decoy Contacts Style Selection */}
            <View style={{ marginTop: 12 }}>
              <Text style={styles.triggerTitle}>Decoy Screen Display</Text>
              <Text style={styles.triggerSubtitle}>
                Choose what the decoy screen displays when opened with the Duress PIN.
              </Text>
              <View style={styles.timeoutOptionsRow}>
                <Pressable
                  style={[
                    styles.timeoutOptionButton,
                    decoyContactsType === 'mock' && styles.timeoutOptionActive,
                  ]}
                  onPress={() => {
                    setDecoyContactsType('mock');
                    setSettings((s) => ({ ...s, decoyContactsType: 'mock' }));
                  }}
                >
                  <Text
                    style={[
                      styles.timeoutOptionText,
                      decoyContactsType === 'mock' && styles.timeoutOptionTextActive,
                    ]}
                  >
                    Mock Contacts
                  </Text>
                </Pressable>
                <Pressable
                  style={[
                    styles.timeoutOptionButton,
                    decoyContactsType === 'empty' && styles.timeoutOptionActive,
                  ]}
                  onPress={() => {
                    setDecoyContactsType('empty');
                    setSettings((s) => ({ ...s, decoyContactsType: 'empty' }));
                  }}
                >
                  <Text
                    style={[
                      styles.timeoutOptionText,
                      decoyContactsType === 'empty' && styles.timeoutOptionTextActive,
                    ]}
                  >
                    Empty List
                  </Text>
                </Pressable>
              </View>
            </View>
          </View>
        </View>

        {/* Section: Physical Triggers - Strict Safety Defaults */}
        <View style={styles.sectionCard}>
          <Text style={styles.sectionHeader}>Alternative Physical Panic Triggers</Text>
          <Text style={styles.safetyNotice}>
            Strict Safety Notice: All physical triggers remain OFF by default to eliminate false alarms. Calibrate and
            test sensitivity before enabling.
          </Text>

          {/* Trigger 1: Volume Button Pattern */}
          <View style={styles.subSection}>
            <View style={styles.switchRow}>
              <View style={styles.switchLabelContainer}>
                <Text style={styles.triggerTitle}>Volume Button Pattern</Text>
                <Text style={styles.triggerSubtitle}>Multi-press sequence (e.g., 4 presses within 3s)</Text>
              </View>
              <Switch
                value={volumeEnabled}
                onValueChange={onVolumeToggle}
                trackColor={{ false: '#3A3A3C', true: '#D7263D' }}
                thumbColor="#FFFFFF"
              />
            </View>

            <SliderControl
              label="Required Presses"
              value={volumePressCount}
              min={3}
              max={6}
              step={1}
              unit=" presses"
              description="Number of rapid presses required to trigger SOS."
              onChange={onVolumePressCountChange}
            />

            <SliderControl
              label="Time Window"
              value={volumeWindowSeconds}
              min={2}
              max={5}
              step={1}
              unit="s"
              description="Maximum duration within which all presses must occur."
              onChange={onVolumeWindowChange}
            />

            {/* Sensitivity Test: Volume Pattern */}
            <View style={styles.testBox}>
              <Text style={styles.testBoxTitle}>Volume Pattern Sensitivity Test</Text>
              <Text style={styles.testBoxSubtitle}>
                Tap Simulate Press to rehearse the rhythm. Simulated presses never dispatch an alert. Physical
                volume presses are live whenever the trigger is enabled and saved.
              </Text>

              <View style={styles.testProgressRow}>
                <Text style={styles.testCounterText}>
                  Progress: {volumeTestPresses} / {volumePressCount} presses
                </Text>
                <Pressable style={styles.testActionButton} onPress={handleTestVolumePress}>
                  <Text style={styles.testActionButtonText}>Simulate Press</Text>
                </Pressable>
              </View>

              {volumeTestSuccess && (
                <View style={styles.testSuccessBadge}>
                  <Text style={styles.testSuccessText}>
                    ✓ Pattern Verified: {volumePressCount} presses within {volumeWindowSeconds}s detected! (Safety test
                    passed - no alert sent)
                  </Text>
                </View>
              )}
            </View>
          </View>

          {/* Trigger 2: Shake Detector */}
          <View style={styles.subSection}>
            <View style={styles.switchRow}>
              <View style={styles.switchLabelContainer}>
                <Text style={styles.triggerTitle}>Shake Detector</Text>
                <Text style={styles.triggerSubtitle}>High-pass filtered accelerometer with adjustable jerk</Text>
              </View>
              <Switch
                value={shakeEnabled}
                onValueChange={onShakeToggle}
                trackColor={{ false: '#3A3A3C', true: '#D7263D' }}
                thumbColor="#FFFFFF"
              />
            </View>

            <SliderControl
              label="Jerk Threshold"
              value={shakeThreshold}
              min={10}
              max={60}
              step={5}
              unit=" m/s³"
              description="Dynamic acceleration change rate. Higher value prevents accidental triggers when walking or dropping."
              onChange={onShakeThresholdChange}
            />

            <SliderControl
              label="Required Reversals"
              value={shakeMinCount}
              min={2}
              max={5}
              step={1}
              unit=" shakes"
              description="Requires multiple directional reversals within 1.5s to filter out single drops or table bumps."
              onChange={onShakeMinCountChange}
            />

            <SliderControl
              label="High-Pass Gravity Filter (Alpha)"
              value={shakeAlpha}
              min={0.5}
              max={0.95}
              step={0.05}
              description="Separates dynamic motion from earth gravity (0.80 recommended)."
              onChange={onShakeAlphaChange}
            />

            {/* Sensitivity Test: Shake Detector */}
            <View style={styles.testBox}>
              <Text style={styles.testBoxTitle}>Shake Sensitivity & Jerk Calibration</Text>
              <Text style={styles.testBoxSubtitle}>
                Calibrate jerk threshold. Shake device vigorously or simulate to inspect response.
              </Text>

              <View style={styles.meterContainer}>
                <View style={styles.meterHeader}>
                  <Text style={styles.meterLabel}>Live Jerk: {currentJerk} m/s³</Text>
                  <Text style={styles.meterTarget}>Target: {shakeThreshold} m/s³</Text>
                </View>
                <View style={styles.meterTrack}>
                  <View
                    style={[
                      styles.meterFill,
                      {
                        width: `${jerkProgressPercent}%`,
                        backgroundColor: currentJerk >= shakeThreshold ? '#2E7D32' : '#FF9F43',
                      },
                    ]}
                  />
                </View>
              </View>

              <View style={styles.testButtonRow}>
                <Pressable
                  style={[styles.testActionButton, isShakeTesting && styles.testActionActive]}
                  onPress={toggleShakeTest}
                >
                  <Text style={styles.testActionButtonText}>{isShakeTesting ? 'Stop Live Test' : 'Live Sensor Test'}</Text>
                </Pressable>
                <Pressable style={styles.testActionButton} onPress={handleSimulateShake}>
                  <Text style={styles.testActionButtonText}>Simulate Shake</Text>
                </Pressable>
              </View>

              {shakeTestSuccess && (
                <View style={styles.testSuccessBadge}>
                  <Text style={styles.testSuccessText}>
                    ✓ Shake Verified: Jerk threshold exceeded with {shakeMinCount} reversals! (Safety test passed - no
                    alert sent)
                  </Text>
                </View>
              )}
            </View>
          </View>
        </View>

        {/* Section: Deterrence & Emergency Alarms (Phase 4) */}
        <View style={styles.sectionCard}>
          <Text style={styles.sectionHeader}>Deterrence & Emergency Alarms</Text>
          <Text style={styles.helperText}>
            Acoustic and visual deterrence activated during active emergency alerts. All deterrence routines run off the main thread.
          </Text>

          {/* Siren Switch */}
          <View style={styles.subSection}>
            <View style={styles.switchRow}>
              <View style={styles.switchLabelContainer}>
                <Text style={styles.triggerTitle}>Acoustic Alarm Siren</Text>
                <Text style={styles.triggerSubtitle}>
                  Dual-tone oscillating emergency siren sound to deter assailants and attract bystander attention.
                </Text>
              </View>
              <Switch
                value={sirenEnabled}
                onValueChange={(val) => {
                  setSirenEnabled(val);
                  setSettings((s) => ({ ...s, deterrenceSirenEnabled: val }));
                }}
                trackColor={{ false: '#3A3A3C', true: '#D7263D' }}
                thumbColor="#FFFFFF"
              />
            </View>

            {/* Strobe Switch */}
            <View style={styles.switchRow}>
              <View style={styles.switchLabelContainer}>
                <Text style={styles.triggerTitle}>Camera Flash Strobe</Text>
                <Text style={styles.triggerSubtitle}>
                  High-frequency pulsating camera LED flash for visual disorientation and nighttime deterrence.
                </Text>
              </View>
              <Switch
                value={strobeEnabled}
                onValueChange={(val) => {
                  setStrobeEnabled(val);
                  setSettings((s) => ({ ...s, deterrenceStrobeEnabled: val }));
                }}
                trackColor={{ false: '#3A3A3C', true: '#D7263D' }}
                thumbColor="#FFFFFF"
              />
            </View>

            {/* Respect Silent Mode Switch */}
            <View style={styles.switchRow}>
              <View style={styles.switchLabelContainer}>
                <Text style={styles.triggerTitle}>Respect Silent / Vibrate Mode</Text>
                <Text style={styles.triggerSubtitle}>
                  When enabled, suppresses the audible siren if device ringer is set to silent or vibrate (preserves stealth).
                </Text>
              </View>
              <Switch
                value={respectSilentMode}
                onValueChange={(val) => {
                  setRespectSilentMode(val);
                  setSettings((s) => ({ ...s, respectSilentMode: val }));
                }}
                trackColor={{ false: '#3A3A3C', true: '#2E7D32' }}
                thumbColor="#FFFFFF"
              />
            </View>

            {/* Deterrence Test Box */}
            <View style={styles.testBox}>
              <Text style={styles.testBoxTitle}>Deterrence Test Fire</Text>
              <Text style={styles.testBoxSubtitle}>
                Safely test configured siren tone and camera strobe for 3 seconds. No emergency alert will be dispatched to contacts.
              </Text>
              <Pressable
                style={[styles.testActionButton, isDeterrenceTesting && styles.testActionActive, { alignSelf: 'flex-start', marginTop: 4 }]}
                onPress={handleTestDeterrence}
              >
                <Text style={styles.testActionButtonText}>
                  {isDeterrenceTesting ? 'Stop Deterrence Test' : 'Test Siren & Strobe (3s)'}
                </Text>
              </Pressable>
              {deterrenceTestFeedback ? (
                <Text style={[styles.helperText, { marginTop: 8, color: '#FF9F43' }]}>
                  {deterrenceTestFeedback}
                </Text>
              ) : null}
            </View>
          </View>
        </View>

        {/* Section: Evidence Capture & Informed Consent (Phase 4) */}
        <View style={styles.sectionCard}>
          <Text style={styles.sectionHeader}>Evidence Capture & Informed Consent</Text>
          <Text style={styles.helperText}>
            Strict Privacy Guarantee: Evidence capture is consent-gated. All captured audio and photos are encrypted at rest with AES-256-GCM using your hardware master key.
          </Text>

          {/* Audio Consent Switch */}
          <View style={styles.subSection}>
            <View style={styles.switchRow}>
              <View style={styles.switchLabelContainer}>
                <Text style={styles.triggerTitle}>Consent-Gated Audio Recording</Text>
                <Text style={styles.triggerSubtitle}>
                  Record ambient audio during active emergency. Finalized and encrypted upon stand down.
                </Text>
              </View>
              <Switch
                value={audioConsentEnabled}
                onValueChange={handleAudioConsentToggle}
                trackColor={{ false: '#3A3A3C', true: '#2E7D32' }}
                thumbColor="#FFFFFF"
              />
            </View>

            {/* Photo Consent Switch */}
            <View style={styles.switchRow}>
              <View style={styles.switchLabelContainer}>
                <Text style={styles.triggerTitle}>Consent-Gated Photo Capture</Text>
                <Text style={styles.triggerSubtitle}>
                  Capture situational photos off the main thread during emergency dispatch.
                </Text>
              </View>
              <Switch
                value={photoConsentEnabled}
                onValueChange={handlePhotoConsentToggle}
                trackColor={{ false: '#3A3A3C', true: '#2E7D32' }}
                thumbColor="#FFFFFF"
              />
            </View>

            {photoConsentEnabled ? (
              <View style={styles.switchRow}>
                <View style={styles.switchLabelContainer}>
                  <Text style={styles.triggerTitle}>Dual Camera Capture</Text>
                  <Text style={styles.triggerSubtitle}>
                    Capture from both front (self) and rear (environment) camera lenses.
                  </Text>
                </View>
                <Switch
                  value={dualCameraEnabled}
                  onValueChange={(val) => {
                    setDualCameraEnabled(val);
                    setSettings((s) => ({ ...s, evidenceDualCamera: val }));
                  }}
                  trackColor={{ false: '#3A3A3C', true: '#2E7D32' }}
                  thumbColor="#FFFFFF"
                />
              </View>
            ) : null}
          </View>
        </View>

        <Pressable style={styles.saveButton} onPress={onSave}>
          <Text style={styles.saveButtonText}>{saved ? 'Saved ✓' : 'Save Settings'}</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#0B0B0F' },
  container: { flex: 1, backgroundColor: '#0B0B0F' },
  title: { color: 'white', fontSize: 24, fontWeight: '700', marginBottom: 16 },
  sectionCard: {
    backgroundColor: '#16161C',
    borderRadius: 12,
    padding: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#24242C',
  },
  sectionHeader: { color: 'white', fontSize: 18, fontWeight: '700', marginBottom: 8 },
  safetyNotice: { color: '#FF9F43', fontSize: 13, lineHeight: 18, marginBottom: 16 },
  subSection: {
    borderTopWidth: 1,
    borderTopColor: '#2C2C35',
    paddingTop: 16,
    marginTop: 16,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  switchLabelContainer: { flex: 1, paddingRight: 12 },
  triggerTitle: { color: 'white', fontSize: 16, fontWeight: '600' },
  triggerSubtitle: { color: '#8E8E93', fontSize: 12, marginTop: 2 },
  label: { color: '#C7C7CC', marginBottom: 6, marginTop: 12 },
  helperText: { color: '#8E8E93', fontSize: 12, marginTop: 4 },
  input: {
    borderWidth: 1,
    borderColor: '#3A3A3C',
    borderRadius: 8,
    padding: 12,
    color: 'white',
    backgroundColor: '#0B0B0F',
  },
  multiline: { minHeight: 80, textAlignVertical: 'top' },
  sliderContainer: { marginVertical: 10 },
  sliderHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sliderLabel: { color: '#C7C7CC', fontSize: 14, fontWeight: '500' },
  sliderValueText: { color: '#FF4D4D', fontSize: 14, fontWeight: '700' },
  sliderDescription: { color: '#8E8E93', fontSize: 11, marginTop: 2, marginBottom: 6 },
  sliderTrackRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  sliderTrackBackground: {
    flex: 1,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#2A2A32',
    overflow: 'hidden',
  },
  sliderTrackFill: { height: '100%', backgroundColor: '#D7263D', borderRadius: 4 },
  stepperButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#2A2A32',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperButtonText: { color: 'white', fontSize: 18, fontWeight: '700' },
  testBox: {
    backgroundColor: '#1E1E26',
    borderRadius: 10,
    padding: 12,
    marginTop: 14,
    borderWidth: 1,
    borderColor: '#343442',
  },
  testBoxTitle: { color: '#E4E4E6', fontSize: 14, fontWeight: '600' },
  testBoxSubtitle: { color: '#8E8E93', fontSize: 11, marginTop: 2, marginBottom: 10 },
  testProgressRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  testCounterText: { color: '#C7C7CC', fontSize: 13, fontWeight: '500' },
  testActionButton: {
    backgroundColor: '#3A3A48',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 6,
  },
  testActionActive: { backgroundColor: '#2E7D32' },
  testActionButtonText: { color: 'white', fontSize: 12, fontWeight: '600' },
  testButtonRow: { flexDirection: 'row', gap: 10, marginTop: 10 },
  testSuccessBadge: {
    backgroundColor: '#1B3B22',
    borderColor: '#2E7D32',
    borderWidth: 1,
    borderRadius: 6,
    padding: 8,
    marginTop: 10,
  },
  testSuccessText: { color: '#4EBA6F', fontSize: 12, fontWeight: '600', lineHeight: 16 },
  meterContainer: { marginVertical: 8 },
  meterHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  meterLabel: { color: '#C7C7CC', fontSize: 12 },
  meterTarget: { color: '#8E8E93', fontSize: 12 },
  meterTrack: {
    height: 10,
    backgroundColor: '#2A2A32',
    borderRadius: 5,
    overflow: 'hidden',
  },
  meterFill: { height: '100%', borderRadius: 5 },
  pinStatusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  lockNowButton: {
    backgroundColor: '#3A1014',
    borderColor: '#D7263D',
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  lockNowButtonText: { color: '#FF4D4D', fontSize: 12, fontWeight: '700' },
  pinFeedbackText: { fontSize: 13, marginBottom: 8, fontWeight: '500' },
  pinFeedbackSuccess: { color: '#4EBA6F' },
  pinFeedbackError: { color: '#FF4D4D' },
  pinForm: { marginTop: 8 },
  pinActionButton: {
    backgroundColor: '#D7263D',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 10,
  },
  pinActionButtonText: { color: 'white', fontSize: 14, fontWeight: '700' },
  pinActionRow: { flexDirection: 'row', gap: 10, marginTop: 10 },
  pinCancelButton: {
    backgroundColor: '#2A2A32',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  pinCancelButtonText: { color: '#C7C7CC', fontSize: 14, fontWeight: '600' },
  changePinButton: {
    backgroundColor: '#2A2A32',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 8,
  },
  changePinButtonText: { color: 'white', fontSize: 13, fontWeight: '600' },
  removePinButton: {
    backgroundColor: '#3A1014',
    borderColor: '#D7263D',
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 8,
  },
  removePinButtonText: { color: '#FF4D4D', fontSize: 13, fontWeight: '600' },
  timeoutOptionsRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  timeoutOptionButton: {
    flex: 1,
    backgroundColor: '#1E1E26',
    borderWidth: 1,
    borderColor: '#343442',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  timeoutOptionActive: {
    backgroundColor: '#D7263D',
    borderColor: '#D7263D',
  },
  timeoutOptionText: { color: '#8E8E93', fontSize: 12, fontWeight: '600' },
  timeoutOptionTextActive: { color: 'white', fontWeight: '700' },
  coercionWarningBox: {
    backgroundColor: '#3A1014',
    borderColor: '#D7263D',
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    marginTop: 10,
  },
  coercionWarningText: {
    color: '#FF6B6B',
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '500',
  },
  saveButton: {
    backgroundColor: '#D7263D',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  saveButtonText: { color: 'white', fontSize: 16, fontWeight: '700' },
});
