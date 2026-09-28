import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ScrollView, Switch } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { getSettings, saveSettings, DEFAULT_SETTINGS, type Settings } from './settingsStorage';
import {
  configureVolumeTrigger,
  configureShakeTrigger,
  startShakeSensitivityTest,
  stopShakeSensitivityTest,
  addShakeTestListener,
  simulateVolumePress,
  simulateShake,
  type ShakeTestSample,
  VolumePatternEngine,
  ShakeDetectorEngine,
} from '../../../modules/physical-triggers';

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
    }, [])
  );

  // Listen for shake sensitivity test samples
  useEffect(() => {
    const sub = addShakeTestListener((sample: ShakeTestSample) => {
      if (isShakeTesting) {
        setCurrentJerk(sample.currentJerk);
        if (sample.isTriggered) {
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

  const handleTestVolumePress = () => {
    simulateVolumePress().catch(() => {});
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

  const handleSimulateShake = () => {
    simulateShake(shakeThreshold + 15).catch(() => {});
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
    };

    await saveSettings(toSave);
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
                Press physical volume buttons or tap simulate below. In test mode, no alert will be dispatched to
                contacts.
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
  saveButton: {
    backgroundColor: '#D7263D',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  saveButtonText: { color: 'white', fontSize: 16, fontWeight: '700' },
});
