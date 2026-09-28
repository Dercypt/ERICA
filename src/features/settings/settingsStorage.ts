import AsyncStorage from '@react-native-async-storage/async-storage';

export interface Settings {
  countdownSeconds: number;
  userName: string;
  customMessage: string;
  retryCeilingSeconds?: number;

  // Strict Safety Defaults: All physical triggers remain OFF by default
  volumeTriggerEnabled?: boolean;
  volumePressCount?: number;
  volumeWindowSeconds?: number;

  shakeTriggerEnabled?: boolean;
  shakeThreshold?: number;
  shakeMinCount?: number;
  shakeHighPassAlpha?: number;
}

const STORAGE_KEY = '@erica/settings';

export const DEFAULT_SETTINGS: Settings = {
  countdownSeconds: 10,
  userName: '',
  customMessage: '',
  retryCeilingSeconds: 60,

  // Safety Defaults: strictly false/off by default
  volumeTriggerEnabled: false,
  volumePressCount: 4,
  volumeWindowSeconds: 3,

  shakeTriggerEnabled: false,
  shakeThreshold: 25,
  shakeMinCount: 3,
  shakeHighPassAlpha: 0.8,
};

export async function getSettings(): Promise<Settings> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  return raw ? { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) } : DEFAULT_SETTINGS;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
