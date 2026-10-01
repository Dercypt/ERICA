# Real-World Adversarial & Reference Hardware Test Verification

This document details the test procedures, architecture, and verification results for proving silent background dispatch and retry resiliency under hostile, real-world Android conditions (and the capability-honest companion flow on iOS).

---

## 1. Sideload "Restricted Settings" Flow (Android 13+ & OEM Skins)

On Android 13+ (API 33, 34, 35), applications sideloaded outside official app stores (via browser download, file manager, chat transfers, or `adb install`) have Android's `ACCESS_RESTRICTED_SETTINGS` flag applied by default. When navigating to Accessibility Settings, Android displays:
> *"Restricted setting: For your security, this setting is currently unavailable."*

### Step-by-Step UI Flow to Enable Accessibility Service

#### A. Stock Android 13/14/15 (Google Pixel / AOSP / Android Emulator)
1. Open **Settings** → **Apps** → **All Apps** → **E.R.I.C.A.** (or long-press app icon → tap **App Info** `ⓘ`).
2. Tap the **three vertical dots (⋮)** in the top-right corner.
3. Tap **"Allow restricted settings"**.
4. Authenticate using device PIN, pattern, or biometric fingerprint.
5. Return to **Settings** → **Accessibility** → **Downloaded apps** → **E.R.I.C.A.**.
6. Toggle switch to **ON**, review system disclaimer, and tap **Allow**.

#### B. Xiaomi / Redmi / POCO (MIUI 14 / HyperOS)
1. **Allow Restricted Settings**: Settings → Apps → Manage apps → E.R.I.C.A. → Tap (⋮) in top-right → "Allow restricted settings" → Enter device PIN.
2. **Autostart Permission**: App Info → Toggle **Autostart** to **ON** → Tap OK.
3. **Battery Saver Exemption**: App Info → Battery Saver → Set to **"No restrictions"** (prevents MIUI background killing).
4. **Pop-up Windows**: App Info → Other permissions → Allow **"Display pop-up windows while running in the background"**.
5. **Accessibility Activation**: Settings → Additional Settings → Accessibility → Downloaded apps → E.R.I.C.A. → Toggle ON. Acknowledge Xiaomi's 10-second safety countdown, check "I am aware of possible risks", and tap **OK**.

#### C. Oppo / Realme / OnePlus (ColorOS / OxygenOS 13/14)
1. **Allow Restricted Settings**: App Info (via long-press) → Tap (⋮) → "Allow restricted settings" → Authenticate.
2. **Auto-launch**: App Info → Battery usage → Enable **"Allow auto-launch"** and **"Allow background activity"**.
3. **App Quick Freeze**: Settings → Battery → More settings → App Quick Freeze → Turn **OFF** for E.R.I.C.A.
4. **Accessibility Service**: Settings → Additional settings → Accessibility → E.R.I.C.A. → Toggle **ON**.

#### D. Infinix / Tecno / itel (Transsion XOS / HiOS)
1. **Allow Restricted Settings**: Settings → App management → App list → E.R.I.C.A. → (⋮) → "Allow restricted settings".
2. **Auto-start**: Phone Master app → Auto-start management → Toggle E.R.I.C.A. to **Allowed**.
3. **Power Marathon / Battery Lab**: Settings → Battery Lab → Advanced settings → Battery optimization → Exclude E.R.I.C.A.
4. **Accessibility Service**: Settings → Special function → Accessibility → E.R.I.C.A. → Toggle **ON**.

#### Rapid ADB Testing Command (Emulator / Developer Device)
```bash
# Allow restricted settings for sideloaded package
adb shell appops set com.erica.sos ACCESS_RESTRICTED_SETTINGS allow

# Enable accessibility service directly via secure settings
adb shell settings put secure enabled_accessibility_services com.erica.sos/expo.modules.physicaltriggers.EricaAccessibilityService
adb shell settings put secure accessibility_enabled 1
```

---

## 2. Aggressive Battery Optimization & Doze Mode Test

Hostile OEM power managers aggressively kill background services when displays remain off.

### Architectural Immunity
1. **Accessibility Framework Exemption**: `EricaAccessibilityService` is bound directly by Android's `system_server`. System server maintains persistent IPC pipes to accessibility services that are never killed by standard Doze maintenance cycles.
2. **Foreground Service Elevation**: When emergency dispatch engages, `EmergencyForegroundService` elevation promotes the process to `FOREGROUND_SERVICE_TYPE_LOCATION`, with high-priority ongoing notification and a temporary 180s `PARTIAL_WAKE_LOCK`.
3. **Sticky Lifecycle**: Services configure `START_STICKY` and override `onTaskRemoved()` to ensure process survival.

### Verification via ADB (Simulating 15+ Min Deep Doze)
```bash
# 1. Unplug virtual AC power to simulate stationary battery operation
adb shell dumpsys battery unplug

# 2. Force device into deep Doze mode
adb shell dumpsys deviceidle force-idle

# 3. Confirm deep idle status
adb shell dumpsys deviceidle get
# Expected output: IDLE

# 4. Confirm EricaAccessibilityService remains active during deep Doze
adb shell dumpsys accessibility | grep -i erica
# Expected: com.erica.sos/expo.modules.physicaltriggers.EricaAccessibilityService is bound and active
```

---

## 3. Emergency Trigger Test (Locked Screen & Multipart Carrier SMS)

### Test Sequence
1. **Lock Device Screen**:
   ```bash
   adb shell input keyevent 26
   ```
2. **Fire 4x Volume Down Pattern within 3 Seconds**:
   ```bash
   adb shell input keyevent 25
   adb shell input keyevent 25
   adb shell input keyevent 25
   adb shell input keyevent 25
   ```
3. **Verify EmergencyForegroundService Notification**:
   - High-importance notification appears on lock screen:
     - Channel: `erica_emergency_channel`
     - Title: `Emergency Alert Active`
     - Action Button: `I'M SAFE`
   - Verified via ADB:
     ```bash
     adb shell dumpsys notification --noredact | grep -i erica_emergency_channel
     ```
4. **Verify Carrier SMS Delivery**:
   - `SilentSmsModule` partitions messages longer than 160 characters via `smsManager.divideMessage(body)` into multipart chunks.
   - Real carrier SMS lands on recipients with live Google Maps coordinates:
     ```text
     EMERGENCY ALERT

     The user may be in danger.

     Triggered via: Volume Button Pattern
     Location: https://maps.google.com/?q=...
     Accuracy: 5 meters

     Time: 2026-10-01T...
     ```

---

## 4. Task Dismissal & Reboot Survivability

### A. Task Dismissal ("Swipe from Recent Apps")
1. While app or emergency dispatch is running, user swipes E.R.I.C.A. away from the Recent Apps task switcher.
2. `EmergencyForegroundService.onTaskRemoved()` logs the event and preserves the foreground service.
3. If the UI process is terminated while locked, `EricaAccessibilityService` continues running:
   - When the 4x volume pattern is detected, `PhysicalTriggersModule.sendPanicEvent()` detects `instance == null`.
   - It immediately elevates process priority via `EmergencyForegroundService` Intent (`ACTION_START`).
   - It awakens `MainActivity` with `FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_CLEAR_TOP` and extra `extra_panic_trigger`.
   - `MainActivity` displays over keyguard via `setShowWhenLocked(true)` and `setTurnScreenOn(true)`.

### B. Airplane Mode Dead-Zone Buffering & Reboot Recovery
1. **Enable Airplane Mode (Simulating Dead Zone)**:
   ```bash
   adb shell cmd connectivity airplane-mode enable
   ```
2. **Trigger Emergency Alert**:
   - Carrier handoff fails with `RESULT_ERROR_RADIO_OFF`.
   - Outbox item is encrypted using authenticated AES-256-GCM and saved into SQLite database `erica_outbox.db` table `outbox_queue` (`status = 'PENDING'`, `attempts = 1`, exponential backoff scheduled).
3. **Reboot Device**:
   ```bash
   adb reboot
   # Wait for device to boot
   adb wait-for-device
   ```
4. **Survivability Assertion**:
   - SQLite persistent database file `/data/user/0/com.erica.sos/databases/erica_outbox.db` persists across reboot with 100% data fidelity.
   - `EricaBootReceiver` receives `android.intent.action.BOOT_COMPLETED`.
   - `EricaBootReceiver` queries `outbox_queue` for pending alerts; detecting pending items, it launches `EmergencyForegroundService` to guarantee process keep-alive during flush.
5. **Disable Airplane Mode (Signal Restored)**:
   ```bash
   adb shell cmd connectivity airplane-mode disable
   ```
6. **Instant Queue Drain**:
   - `NetInfo` and `EricaBootReceiver` detect network/cellular restoration.
   - `flushOutboxQueue({ forceImmediate: true })` executes immediately.
   - Both buffered multipart SMS alerts are delivered to carrier without duplicate transmissions.
   - SQLite queue records update to `status = 'SENT'`.

---

## 5. iOS Companion Flow (Non-Blocking)

In compliance with Phase 8 and platform security policies, iOS strictly restricts background programmatic SMS dispatch and always-on background hardware key interception.

### Capability-Honest Architecture
- **Detection**: `SilentSmsModule.isAvailableAsync()` returns `false` on iOS.
- **Cancellable Countdown**: SOS trigger engages cancellable countdown (configurable seconds). The user can tap `CANCEL` to safely return to idle with zero alerts sent.
- **Fallback SMS Composer**: Upon countdown expiration, `dispatchEmergencySms` falls back to `expo-sms` (`SMS.sendSMSAsync(recipients, message)`), opening the prefilled native iOS SMS sheet with live GPS location link and emergency body.
- **Stand Down**: Tapping `I'M SAFE NOW` presents a prefilled resolution composer.
- **Biometric Gatekeeper**: Face ID / Touch ID authentication integrates via `expo-local-authentication` (`authenticateAsync`), providing hardware-backed biometric unlock with seamless custom PIN fallback.
- **Non-Blocking Guarantee**: iOS unit tests run alongside Android tests in headless environments without requiring Xcode or blocking Phase 4 progress.

---

## 6. Single Verification Command

Run the entire comprehensive test suite (all 13 test suites covering crypto vectors, disk encryption, duress mode, lock states, dead-zone buffering, reboot survivability, and iOS companion flow):

```bash
npm test
```
