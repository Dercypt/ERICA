# ADR 001: Native Kotlin Architecture Pivot & Capability-Honest iOS Companion

- **Status**: Decided / Accepted
- **Date**: 2026-10-01
- **Context**: E.R.I.C.A. Core Architecture — Transition from Expo Go walking skeleton to native Kotlin Expo Modules on Android, formalizing the capability-honest iOS companion, and establishing real-world platform trade-offs.

---

## 1. Context & Architectural Drivers

The walking skeleton of E.R.I.C.A. (Phase 1) proved core domain logic in pure TypeScript under Expo Go. However, a safety-critical emergency response application operates under adversarial physical and operational constraints that pure JavaScript runtimes and generic cross-platform abstractions cannot satisfy:

1. **Life-Safety Invariants Under Screen-Off / Locked Conditions**:
   In an active crisis (assault, physical stalking, medical incapacitation, forced vehicle stop), a user cannot unlock their phone, navigate a touch interface, or tap an OS SMS composer modal. Alert triggering and dispatch must operate with zero visual feedback, zero touch taps, and complete survivability when the screen is off and the keyguard is locked.

2. **App Store Policy Contradictions**:
   Google Play Store policy strictly restricts the `SEND_SMS` permission to designated default SMS handler apps, which prevents personal safety applications from performing silent SMS dispatch. Apple App Store review guidelines and iOS platform sandboxing strictly forbid programmatic SMS dispatch (`MFMessageComposeViewController` requires user interaction) and background hardware button interception.

3. **Runtime Performance Constraints (Hermes Bytecode Interpreter)**:
   Cryptographic operations on Android execute under the Hermes JavaScript engine, which uses ahead-of-time bytecode compilation without a Just-In-Time (JIT) compiler. Computationally intensive algorithms like PBKDF2 key stretching cannot execute in pure JavaScript without freezing the main thread.

To reconcile these constraints, E.R.I.C.A. pivots to a hybrid architecture:
- **Pure Domain & State Logic**: Shared TypeScript.
- **Android Platform**: Custom Kotlin Expo Modules for silent SMS dispatch, foreground service lifecycle, and hardware button triggers.
- **iOS Platform**: A capability-honest companion application acknowledging platform security sandboxes without false assurances.

---

## 2. Architecture Breakdown

### 2.1 Pure Logic in Shared TypeScript

Core business logic, state management, and cryptography abstractions remain in pure TypeScript within `src/`:
- **State Machine (`sosMachine`)**: Statechart implemented with XState v5 governing countdowns, cancellable intervals, trigger aggregation, resolution, and transition guards.
- **Durable Outbox Queue & Retry Engine**: SQLite-backed queue (`erica_outbox.db`) tracking pending dispatches with exponential backoff calculation, jitter, and network state listeners (`@react-native-community/netinfo`).
- **Cryptography & Security Layer**: Abstracted interface managing master key generation, PBKDF2 stretching, envelope encryption (AES-256-GCM), constant-time comparisons (`timingSafeEqual`), and explicit memory buffer wiping (`masterKeyBuffer.fill(0)`).
- **Domain Services**: Trusted contacts CRUD, location link formatting, and session history logs.

**Rationale**:
- **100% Headless Unit Testability**: Domain logic, state transitions, and retry ladders execute in standard Node.js environments (`node --test` with `--experimental-strip-types`) in milliseconds without requiring an Android emulator or iOS simulator.
- **Single Source of Truth**: Eliminates drift between platforms for critical state transitions and data models.

### 2.2 Android Native Kotlin Expo Modules

For Android, E.R.I.C.A. integrates custom native modules using the Expo Modules API (`modules/`):

1. **`SilentSmsModule` (`modules/silent-sms`)**:
   - Directly interfaces with `android.telephony.SmsManager` (supporting multi-SIM subscriptions via `getSmsManagerForSubscriptionId`).
   - Automatically fragments payloads exceeding 160 GSM-7 / 70 UCS-2 characters using `smsManager.divideMessage(body)` into multipart messages (`sendMultipartTextMessage`).
   - Binds `PendingIntent` instances for `SMS_SENT_ACTION` and `SMS_DELIVERED_ACTION` broadcast receivers to verify radio handoff and carrier delivery.
   - **True Silent Send**: Transmits alerts in the background without opening the default SMS composer, requiring zero user intervention.
   - **Distribution Strategy**: Distributed via direct APK sideloading and F-Droid to bypass Google Play's `SEND_SMS` default-handler restriction.

2. **`ForegroundServiceModule` & `EmergencyForegroundService` (`modules/foreground-service`)**:
   - Elevated foreground service typed as `FOREGROUND_SERVICE_TYPE_LOCATION`.
   - Displays an ongoing, high-importance notification on `erica_emergency_channel` with an interactive "I'M SAFE" resolution action.
   - Implements `START_STICKY` and acquires a partial wake lock (`PowerManager.PARTIAL_WAKE_LOCK`) to guarantee CPU execution during dispatch while display silicon sleeps.
   - Overrides `onTaskRemoved()` to persist service operation when swiped away from the Recent Apps task switcher.

3. **`PhysicalTriggersModule` (`modules/physical-triggers`)**:
   - **`EricaAccessibilityService`**: Bound directly by Android's `system_server`. Intercepts hardware key events (`KeyEvent.KEYCODE_VOLUME_DOWN`) before OS volume managers consume them, functioning while the screen is locked or turned off.
   - **`VolumePatternDetector`**: Implements a sliding-window detector identifying 4 consecutive volume down clicks within a 3.0-second window.
   - **Lockscreen Elevation**: Awakens `MainActivity` over the keyguard via `setShowWhenLocked(true)` and `setTurnScreenOn(true)` using `FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_CLEAR_TOP`.
   - **`EricaBootReceiver`**: Listens for `android.intent.action.BOOT_COMPLETED`, inspects the SQLite outbox for undelivered emergency payloads, and elevates `EmergencyForegroundService` immediately upon boot.

### 2.3 iOS as a Capability-Honest Companion

Apple's iOS sandbox strictly prohibits:
- Programmatic background SMS transmission without user confirmation (private frameworks like `CTMessageCenter` cause App Store rejection and sandbox termination).
- Global interception of physical hardware keys (volume buttons) while backgrounded or locked.
- Headless, long-running background daemon services without active audio, VoIP, or navigation background modes.

**Capability-Honest Architecture**:
Rather than presenting mock capabilities or making false safety promises, E.R.I.C.A. defines an explicit, capability-honest iOS companion flow:
- **Detection**: `SilentSmsModule.isAvailableAsync()` returns `false` on iOS.
- **Cancellable Countdown**: The UI executes the full cancellable countdown state machine.
- **Fallback SMS Composer**: Upon countdown expiration, `dispatchEmergencySms` falls back to `expo-sms` (`SMS.sendSMSAsync(recipients, message)`), presenting the native iOS message composer pre-populated with emergency contacts and live GPS coordinates.
- **Biometric Gatekeeper**: Uses `expo-local-authentication` (`LocalAuthentication.authenticateAsync`) for hardware-backed Face ID / Touch ID authentication with PIN fallback.
- **Non-Blocking Guarantee**: The codebase maintains full platform branching, enabling iOS builds to pass test verification and compile without blocking Android native feature progress.

---

## 3. Measured PBKDF2 Latency vs. Theoretical Numbers

During Phase 3 runtime verification on physical Android hardware running the Hermes engine, key stretching latency was empirically measured using a 4-digit PIN, 32-byte CSPRNG salt, and 100,000 iterations of PBKDF2-HMAC-SHA256:

### Empirical Benchmark Findings (from ADR 0001 Diagnostic Probe)
- **Engine**: Hermes JavaScript Engine (`globalThis.HermesInternal` present)
- **W3C WebCrypto API (`crypto.subtle`)**: `undefined` (Hermes provides no native WebCrypto implementation)
- **CSPRNG (`crypto.getRandomValues`)**: `undefined` (requires native entropy polyfill)
- **Pure TypeScript / JavaScript Fallback Path**:
  - **Algorithm**: PBKDF2-HMAC-SHA256 (200,000 SHA-256 block compression passes, ~12.8M bitwise ops)
  - **Measured Duration**: **`207,856 ms` (~207.86 seconds / 3.46 minutes)**
  - **Logcat Verification**:
    ```text
    I ReactNativeJS: [CRYPTO_PROBE] ⏱️ Benchmarking pbkdf2HmacSha256 for 100,000 iterations...
    I ReactNativeJS: [CRYPTO_PROBE] 🎯 BENCHMARK COMPLETE: 100,000 PBKDF2 iterations took: 207856 ms
    I ReactNativeJS: [CRYPTO_PROBE] >>> CRYPTO DIAGNOSTIC PROBE FINISHED <<<
    ```

### Architectural Consequence
1. **Unviability of Pure JS Key Stretching**:
   A 3.46-minute freeze on the JavaScript single thread inevitably triggers Android ANR (Application Not Responding) dialogs and crashes the UI.
2. **Mandatory Native Acceleration**:
   Pure JS crypto cannot be used for interactive PIN derivation. Cryptographic derivation must be offloaded to native C++ JSI / OpenSSL bindings (`react-native-quick-crypto` / Android `SecretKeyFactory`), bringing 100,000-iteration latency down to **<140 ms** on reference hardware.

---

## 4. Real-World Platform Trade-offs & Adversarial Realities

### 4.1 Android 13+ Restricted Settings (`ACCESS_RESTRICTED_SETTINGS`)
Starting in Android 13 (API 33) and continued in Android 14 and 15, sideloaded applications installed outside an app store have the `ACCESS_RESTRICTED_SETTINGS` security flag applied automatically.
- **Symptom**: When a user attempts to activate `EricaAccessibilityService` in system settings, Android disables the toggle and displays: *"Restricted setting: For your security, this setting is currently unavailable."*
- **Trade-off**: Requires manual multi-step onboarding instructions:
  1. Navigate to **Settings** → **Apps** → **E.R.I.C.A.** (App Info).
  2. Tap the top-right overflow menu (**⋮**).
  3. Select **"Allow restricted settings"** and authenticate with device PIN or biometrics.
  4. Return to **Accessibility** → **E.R.I.C.A.** and toggle the service **ON**.
- **Mitigation**: In-app onboarding provides vendor-specific illustrated walkthroughs. For development/testing, ADB bypasses this via:
  ```bash
  adb shell appops set com.erica.sos ACCESS_RESTRICTED_SETTINGS allow
  ```

### 4.2 Aggressive OEM Battery Optimizers & Deep Doze
Android device manufacturers (OEMs)—specifically Xiaomi (MIUI/HyperOS), Oppo/OnePlus/Realme (ColorOS/OxygenOS), and Transsion (Infinix/Tecno XOS/HiOS)—employ aggressive non-AOSP battery management software that indiscriminately terminates background processes when the screen turns off.
- **Trade-offs & Mitigations**:
  1. **Accessibility Framework Exemption**: `EricaAccessibilityService` is bound by `system_server`. System server maintains persistent IPC pipes to accessibility services that standard Doze cycles cannot kill.
  2. **Elevated Foreground Service**: During active emergency countdowns and dispatch, `EmergencyForegroundService` runs with `START_STICKY`, `FOREGROUND_SERVICE_TYPE_LOCATION`, and holds a temporary 180s `PARTIAL_WAKE_LOCK`.
  3. **OEM Configuration Requirement**: The user must still manually exclude E.R.I.C.A. from vendor task killers (e.g. setting MIUI Battery Saver to "No restrictions", enabling ColorOS "Allow auto-launch", and disabling App Quick Freeze).

### 4.3 iOS Keychain Migration Risks
iOS Keychain storage (`expo-secure-store`) presents critical lifecycle trade-offs when users upgrade devices or restore from backups:
- **`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`**:
  Keys stored with this accessibility class are bound to device-specific hardware keys in the Secure Enclave and **do not migrate** across devices via iCloud Keychain or iTunes/Finder unencrypted backups.
- **Risk**: If the master key or PBKDF2 salt is stored as a device-only keychain item and the user restores to a new iPhone, the local encrypted SQLite vault and contacts database become permanently unrecoverable.
- **Trade-off**: Enabling iCloud Keychain synchronization violates the local-only, zero-cloud privacy guarantee. E.R.I.C.A. explicitly adopts device-bound local storage; device migration requires setting up the vault anew, preventing silent cloud leakage of sensitive safety credentials.
- **Biometric ACL Invalidation**: Enclave keys protected by biometric access control lists are invalidated if the device passcode is removed or biometrics are re-enrolled. E.R.I.C.A. implements graceful fallback to the primary 6-digit master PIN.

### 4.4 Why Biometrics Default to OFF Under Duress Mode
Under physical duress or coercion (e.g., an armed robbery, domestic abuse confrontation, stalking interception, or forced checkpoint inspection), an adversary holds physical control over the victim.

- **Vulnerability of Biometrics**:
  Biometric factors (fingerprint scanner, Face ID) offer **zero plausible deniability and zero coercion resistance**. An attacker can forcibly press a victim's finger onto the sensor or hold the device to their face while they are restrained.
- **Architectural Decision**:
  When Duress Mode is configured:
  1. Biometric authentication defaults to **OFF** (or is strictly suppressed for vault access).
  2. The application mandates a **6-digit secondary Duress PIN** distinct from the master PIN.
  3. Entering the Duress PIN unlocks a sanitized decoy vault, silently avoids triggering lockout delays, and queues a silent distress dispatch without presenting any UI alerts or siren deterrence.
  4. Allowing biometric unlock while in duress would give an assailant instant access to real emergency contacts and dispatch logs, completely defeating the duress defense mechanism.

---

## 5. Architectural Invariants

1. **Clean-Room Integrity**: Zero GPL-3.0 source code from `dhilipmpms/SOS-alerter` or other copyleft repositories is incorporated.
2. **Main Thread Safety**: No synchronous network calls, intensive cryptographic loops, or disk writes execute on the React Native UI thread.
3. **Fail-Safe Offline Dispatch**: All alerts enter an encrypted local SQLite outbox queue before transmission; cellular dropouts or airplane mode trigger exponential backoff rather than silent drop.
4. **Tested on Reference Hardware**: Claims regarding reliability and background execution are strictly documented as **tested on reference Android hardware**, explicitly rejecting sweeping overreaching assertions such as "certified across all Android devices".

---

## 6. Verification

The architecture and its platform branches are validated through a 13-suite automated test matrix covering:
- RFC/NIST cryptographic vectors and backward compatibility
- SQLite outbox dead-zone buffering, reboot survivability, and airplane mode recovery
- Duress isolation, progressive PIN lockout backoff ladder, and biometrics coercion guard
- State machine transitions (`sosMachine`) and foreground service lifecycles
- Non-blocking iOS companion fallback flow

Verification command:
```bash
npm test
```
