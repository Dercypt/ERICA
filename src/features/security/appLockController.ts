/**
  * App Lock Lifecycle Controller for E.R.I.C.A.
  *
  * Implements:
  * - AppState lifecycle monitoring (active -> background / inactive).
  * - Immediate lock state engagement on backgrounding or after an idle timeout (e.g. 15s / 30s / Immediate).
  * - Coordination between biometric authentication, PIN fallback, and vault locking.
  */

import { AppState, type AppStateStatus } from 'react-native';
import {
  isPinConfigured,
  isDuressPinConfigured,
  isVaultLocked,
  lockVault,
  unlockWithPin as securityUnlockWithPin,
  authenticatePin,
  isDuressModeActive,
  setDuressModeActive,
} from './pinAuth';
import {
  unlockWithBiometrics as securityUnlockWithBiometrics,
  isBiometricsAvailable,
  type BiometricAuthResult,
} from './biometrics';
import { getSettings, saveSettings } from '../settings/settingsStorage';
import { triggerDuressSilentSos } from '../dispatch/duressDispatch';

export interface AppLockSnapshot {
  isLocked: boolean;
  isPinConfigured: boolean;
  isDuressPinConfigured: boolean;
  isDuressMode: boolean;
  isBiometricsAvailable: boolean;
  lockTimeoutSeconds: number;
}

export class AppLockController {
  private isLocked: boolean = true;
  private isDuressMode: boolean = false;
  private isPinConfigured: boolean = false;
  private isDuressPinConfigured: boolean = false;
  private isBiometricsAvailable: boolean = false;
  private biometricsEnabled: boolean = true;
  private lockTimeoutSeconds: number = 0; // Default 0: Immediate lock
  private lastBackgroundedAt: number | null = null;
  private idleTimer: any = null;
  private appStateSubscription: { remove: () => void } | null = null;
  private listeners = new Set<(snapshot: AppLockSnapshot) => void>();
  private initialized = false;
  private snapshot: AppLockSnapshot = {
    isLocked: false,
    isPinConfigured: false,
    isDuressPinConfigured: false,
    isDuressMode: false,
    isBiometricsAvailable: false,
    lockTimeoutSeconds: 0,
  };

  constructor() {
    this.handleAppStateChange = this.handleAppStateChange.bind(this);
    this.updateSnapshot();
  }

  private updateSnapshot(): void {
    const biometricsAllowed =
      this.isBiometricsAvailable &&
      this.biometricsEnabled &&
      !this.isDuressMode;

    this.snapshot = {
      isLocked: this.isLocked,
      isPinConfigured: this.isPinConfigured,
      isDuressPinConfigured: this.isDuressPinConfigured,
      isDuressMode: this.isDuressMode,
      isBiometricsAvailable: biometricsAllowed,
      lockTimeoutSeconds: this.lockTimeoutSeconds,
    };
  }

  /**
   * Initializes the lifecycle controller.
   * On initial open, locks out unauthorized access if a PIN is configured.
   */
  public async init(): Promise<void> {
    if (this.initialized) {
      await this.refreshState();
      return;
    }

    this.isPinConfigured = await isPinConfigured();
    this.isDuressPinConfigured = await isDuressPinConfigured();
    this.isBiometricsAvailable = await isBiometricsAvailable();
    this.isDuressMode = false;
    setDuressModeActive(false);

    const settings = await getSettings();
    this.biometricsEnabled = settings.biometricsEnabled !== false;
    this.lockTimeoutSeconds = settings.appLockTimeoutSeconds ?? 0;

    // Lock out unauthorized access the second the app is opened
    if (this.isPinConfigured) {
      this.isLocked = true;
      lockVault();
    } else {
      this.isLocked = false;
    }

    try {
      this.appStateSubscription = AppState.addEventListener('change', this.handleAppStateChange);
    } catch {
      // Ignore if AppState is unavailable (e.g., non-React-Native test environment)
    }

    if (!this.isLocked && this.lockTimeoutSeconds > 0) {
      this.resetIdleTimer();
    }

    this.initialized = true;
    this.notify();
  }

  /**
   * Handles transitions between active, background, and inactive app states.
   */
  public handleAppStateChange(nextAppState: AppStateStatus): void {
    if (nextAppState === 'background' || nextAppState === 'inactive') {
      this.lastBackgroundedAt = Date.now();
      this.clearIdleTimer();

      // Immediate timeout locks the exact second the app is backgrounded
      if (this.lockTimeoutSeconds === 0 && this.isPinConfigured) {
        this.lock();
      }
    } else if (nextAppState === 'active') {
      if (this.isPinConfigured) {
        if (this.lockTimeoutSeconds === 0) {
          // In immediate mode, ensure locked when returning to foreground
          this.lock();
        } else if (this.lastBackgroundedAt !== null) {
          const elapsedSeconds = (Date.now() - this.lastBackgroundedAt) / 1000;
          if (elapsedSeconds >= this.lockTimeoutSeconds) {
            this.lock();
          }
        }
      }

      this.lastBackgroundedAt = null;

      if (!this.isLocked && this.lockTimeoutSeconds > 0) {
        this.resetIdleTimer();
      }
    }
  }

  /**
   * Records user touch/activity to reset in-app idle timeout.
   */
  public recordActivity(): void {
    if (this.isLocked || !this.isPinConfigured || this.lockTimeoutSeconds <= 0) {
      return;
    }
    this.resetIdleTimer();
  }

  /**
   * Resets the foreground idle inactivity timer.
   */
  public resetIdleTimer(): void {
    this.clearIdleTimer();
    if (this.lockTimeoutSeconds > 0 && !this.isLocked && this.isPinConfigured) {
      this.idleTimer = setTimeout(() => {
        this.lock();
      }, this.lockTimeoutSeconds * 1000);
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /**
   * Immediately engages lock state: wipes working master key memory
   * and blocks UI/data access.
   */
  public lock(): void {
    if (!this.isPinConfigured) {
      return;
    }
    this.isLocked = true;
    this.isDuressMode = false;
    setDuressModeActive(false);
    lockVault();
    this.clearIdleTimer();
    this.notify();
  }

  /**
   * Unlocks the app using either the custom primary PIN or secondary Duress PIN.
   */
  public async unlockWithPin(pin: string): Promise<boolean> {
    const pinResult = await authenticatePin(pin);

    if (pinResult.type === 'primary') {
      const success = await securityUnlockWithPin(pin);
      if (success) {
        this.isLocked = false;
        this.isDuressMode = false;
        setDuressModeActive(false);
        this.resetIdleTimer();
        this.notify();
        return true;
      }
      return false;
    }

    if (pinResult.type === 'duress') {
      // Coercion Threat Model:
      // Real vault remains locked; master key memory remains completely purged
      lockVault();
      this.isLocked = false;
      this.isDuressMode = true;
      setDuressModeActive(true);
      this.resetIdleTimer();
      this.notify();

      // Optionally trigger stealth silent SOS ping in background if configured
      const settings = await getSettings();
      if (settings.duressSilentSosEnabled) {
        triggerDuressSilentSos().catch((err) => {
          console.warn('[appLockController] Failed to dispatch silent duress SOS:', err);
        });
      }

      return true;
    }

    return false;
  }

  /**
   * Unlocks the app using biometric verification.
   */
  public async unlockWithBiometrics(
    promptMessage?: string
  ): Promise<BiometricAuthResult> {
    // Coercion Guard: Biometrics are strictly shut off when Duress Mode is active
    if (this.isDuressMode || isDuressModeActive()) {
      return { success: false, error: 'DURESS_ACTIVE' };
    }

    const settings = await getSettings();
    if (settings.biometricsEnabled === false) {
      return { success: false, error: 'BIOMETRICS_DISABLED' };
    }

    const result = await securityUnlockWithBiometrics({ promptMessage });
    if (result.success) {
      this.isLocked = false;
      this.isDuressMode = false;
      setDuressModeActive(false);
      this.resetIdleTimer();
      this.notify();
    }
    return result;
  }

  /**
   * Configures the app lock timeout in seconds (0 = Immediate, 15, 30, 60).
   */
  public async setLockTimeoutSeconds(seconds: number): Promise<void> {
    this.lockTimeoutSeconds = seconds;
    const settings = await getSettings();
    await saveSettings({ ...settings, appLockTimeoutSeconds: seconds });

    if (!this.isLocked && seconds > 0) {
      this.resetIdleTimer();
    } else if (seconds === 0) {
      this.clearIdleTimer();
    }
    this.notify();
  }

  /**
   * Refreshes internal state from storage (e.g. after PIN setup or settings changes).
   */
  public async refreshState(): Promise<void> {
    this.isPinConfigured = await isPinConfigured();
    this.isDuressPinConfigured = await isDuressPinConfigured();
    this.isBiometricsAvailable = await isBiometricsAvailable();
    const settings = await getSettings();
    this.biometricsEnabled = settings.biometricsEnabled !== false;
    this.lockTimeoutSeconds = settings.appLockTimeoutSeconds ?? 0;
    if (!this.isPinConfigured) {
      this.isLocked = false;
      this.isDuressMode = false;
      setDuressModeActive(false);
    }
    this.notify();
  }

  /**
   * Synchronous snapshot for React useSyncExternalStore or hooks.
   */
  public getSnapshot(): AppLockSnapshot {
    return this.snapshot;
  }

  /**
   * Subscribes to lock state changes.
   */
  public subscribe(listener: (snapshot: AppLockSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.updateSnapshot();
    const snapshot = this.snapshot;
    for (const listener of Array.from(this.listeners)) {
      listener(snapshot);
    }
  }

  /**
   * Cleans up all listeners and timers.
   */
  public destroy(): void {
    this.clearIdleTimer();
    this.appStateSubscription?.remove();
    this.appStateSubscription = null;
    this.listeners.clear();
    this.initialized = false;
    this.isDuressMode = false;
    this.isDuressPinConfigured = false;
    setDuressModeActive(false);
  }
}

export const appLockController = new AppLockController();
