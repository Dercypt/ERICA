/**
  * useAppLock Hook - React Lifecycle Gatekeeper for E.R.I.C.A.
  *
  * Provides components with live lock state, PIN/Biometric unlock methods,
  * and inactivity tracking.
  */

import { useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import { appLockController, type AppLockSnapshot } from './appLockController';

export function useAppLock() {
  const snapshot = useSyncExternalStore(
    (onStoreChange) => appLockController.subscribe(onStoreChange),
    () => appLockController.getSnapshot(),
    () => appLockController.getSnapshot()
  );

  useEffect(() => {
    appLockController.init();
  }, []);

  const lock = useCallback(() => {
    appLockController.lock();
  }, []);

  const unlockWithPin = useCallback(async (pin: string) => {
    return await appLockController.unlockWithPin(pin);
  }, []);

  const unlockWithBiometrics = useCallback(async (promptMessage?: string) => {
    return await appLockController.unlockWithBiometrics(promptMessage);
  }, []);

  const setLockTimeoutSeconds = useCallback(async (seconds: number) => {
    await appLockController.setLockTimeoutSeconds(seconds);
  }, []);

  const recordActivity = useCallback(() => {
    appLockController.recordActivity();
  }, []);

  const refreshState = useCallback(async () => {
    await appLockController.refreshState();
  }, []);

  return {
    ...snapshot,
    lock,
    unlockWithPin,
    unlockWithBiometrics,
    setLockTimeoutSeconds,
    recordActivity,
    refreshState,
  };
}
