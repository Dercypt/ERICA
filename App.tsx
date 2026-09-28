import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { RootNavigator, navigationRef } from './src/app';
import { initDispatchEngine } from './src/features/dispatch';
import { getSettings } from './src/features/settings';
import {
  configureVolumeTrigger,
  configureShakeTrigger,
  addPanicTriggerListener,
} from './modules/physical-triggers';

export async function initPhysicalTriggers(): Promise<() => void> {
  const settings = await getSettings();
  await configureVolumeTrigger({
    enabled: Boolean(settings.volumeTriggerEnabled),
    pressCount: settings.volumePressCount ?? 4,
    windowSeconds: settings.volumeWindowSeconds ?? 3,
  }).catch((err) => console.warn('[App] Failed to configure volume trigger:', err));

  await configureShakeTrigger({
    enabled: Boolean(settings.shakeTriggerEnabled),
    jerkThreshold: settings.shakeThreshold ?? 25,
    minShakes: settings.shakeMinCount ?? 3,
    highPassAlpha: settings.shakeHighPassAlpha ?? 0.8,
  }).catch((err) => console.warn('[App] Failed to configure shake trigger:', err));

  const sub = addPanicTriggerListener(() => {
    if (navigationRef.isReady()) {
      navigationRef.navigate('SOS' as never);
    }
  });

  return () => {
    sub.remove();
  };
}

export default function App() {
  useEffect(() => {
    let cleanupDispatch: (() => void) | undefined;
    let cleanupTriggers: (() => void) | undefined;

    initDispatchEngine()
      .then((fn) => {
        cleanupDispatch = fn;
      })
      .catch((err) => {
        console.warn('[App] Failed to initialize dispatch engine:', err);
      });

    initPhysicalTriggers()
      .then((fn) => {
        cleanupTriggers = fn;
      })
      .catch((err) => {
        console.warn('[App] Failed to initialize physical triggers:', err);
      });

    return () => {
      cleanupDispatch?.();
      cleanupTriggers?.();
    };
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <RootNavigator />
    </SafeAreaProvider>
  );
}
