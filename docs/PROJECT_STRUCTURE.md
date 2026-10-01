# E.R.I.C.A. Project Structure & File Categorization

This document provides a comprehensive taxonomy and architectural map of every directory and file in the E.R.I.C.A. repository.

---

## High-Level Architectural Tiers

```
┌────────────────────────────────────────────────────────────────────────┐
│                   Governance & Invariants Tier                         │
│            AGENTS.md │ LAWS.md │ PRINCIPLES.md │ HARNESS.md            │
└────────────────────────────────────────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│                    Application Shell & Navigation                      │
│             App.tsx │ index.ts │ src/app/RootNavigator.tsx             │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│                  Pure TypeScript Domain Core (src/)                    │
│    sos/        security/       dispatch/       contacts/     location/ │
│  (XState)   (AES-256-GCM)   (SQLite Outbox)  (Duress Decoy)   (GPS)    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│                   Native Hardware Modules (modules/)                   │
│   silent-sms/            foreground-service/        physical-triggers/ │
│  (Android SmsManager)   (Elevated Sticky Service)  (Accessibility Svc) │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│                 Native Platforms & Manifest Injection                  │
│       android/ (Native Gradle & Kotlin) │ plugins/ (Expo Config)       │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Governance, Invariants & Verification Harness

Governs autonomous agent execution, system invariants, verification scripts, and safety rules.

| Path | Category | Purpose |
| :--- | :--- | :--- |
| [`AGENTS.md`](../AGENTS.md) | Agent Governance | Root directives defining the 5-stage agent execution loop and governance bindings. |
| [`LAWS.md`](../LAWS.md) | Invariants | Strictly immutable system laws, architectural invariants, and safety boundaries. |
| [`PRINCIPLES.md`](../PRINCIPLES.md) | Engineering Principles | Code standards, zero untyped bypasses, and explicit escalation triggers. |
| [`HARNESS.md`](../HARNESS.md) | Verification Toolchain | Verification protocol specification and 15-iteration autonomous fix loop. |
| [`verify.sh`](../verify.sh) | Execution Script | Shell test harness executing type checking and the complete 13-suite automated test matrix. |

---

## 2. Core Domain Services (`src/features/`)

Pure TypeScript domain layer operating under zero-telemetry and privacy-first constraints.

### 2.1 Emergency SOS Core (`src/features/sos/`)
- [`src/features/sos/sosMachine.ts`](../src/features/sos/sosMachine.ts): XState v5 state machine managing emergency lifecycles: `idle` → `countdown` (cancellable window) → `dispatching` → `active` (persistent broadcast) → `resolving` / `cancelled`.
- [`src/features/sos/SosScreen.tsx`](../src/features/sos/SosScreen.tsx): Primary emergency trigger UI featuring one-motion activation button, countdown ring, and discreet abort actions.
- [`src/features/sos/index.ts`](../src/features/sos/index.ts): Feature exports.

### 2.2 Security, Cryptography & App Lock (`src/features/security/`)
- [`src/features/security/nativeCrypto.ts`](../src/features/security/nativeCrypto.ts): Native C++ JSI / OpenSSL cryptographic bindings (`react-native-quick-crypto`) for constant-time operations and hardware-accelerated algorithms.
- [`src/features/security/encryption.ts`](../src/features/security/encryption.ts): AES-256-GCM envelope encryption and decryption with authenticated data tags and CSPRNG IVs.
- [`src/features/security/keyDerivation.ts`](../src/features/security/keyDerivation.ts): PBKDF2-HMAC-SHA256 key stretching (<140 ms natively; replacing 3.5 min interpreted JS lag) for primary and duress PINs.
- [`src/features/security/masterKey.ts`](../src/features/security/masterKey.ts): Master key lifecycle manager with scoped `withMasterKey()` in-memory zeroing (`Buffer.fill(0)`).
- [`src/features/security/pinAuth.ts`](../src/features/security/pinAuth.ts): Constant-time timing-safe PIN verification, progressive lockout escalation ladder, and lockout persistence.
- [`src/features/security/secureStorage.ts`](../src/features/security/secureStorage.ts): Hardware Keystore (Android TEE/StrongBox) and Keychain (iOS Secure Enclave) storage interface via `expo-secure-store`.
- [`src/features/security/appLockController.ts`](../src/features/security/appLockController.ts): State controller managing application lock state (`locked`, `unlocked`, `duress`, `throttled`).
- [`src/features/security/biometrics.ts`](../src/features/security/biometrics.ts): Biometric authentication gatekeeper (Face ID, Touch ID, Fingerprint) disabled by default under Duress Mode.
- [`src/features/security/storageMigration.ts`](../src/features/security/storageMigration.ts): Cryptographic schema versioning and backward-compatible migration handlers.
- [`src/features/security/useAppLock.ts`](../src/features/security/useAppLock.ts): React hook attaching lock protection to navigation lifecycles and backgrounding events.
- [`src/features/security/LockScreen.tsx`](../src/features/security/LockScreen.tsx): Secure PIN keypad screen supporting duress PIN entry and biometric challenge fallback.
- [`src/features/security/index.ts`](../src/features/security/index.ts): Feature exports.

### 2.3 Resilient Offline Dispatch & Outbox Engine (`src/features/dispatch/`)
- [`src/features/dispatch/outboxQueue.ts`](../src/features/dispatch/outboxQueue.ts): Persistent SQLite database (`erica_outbox.db`) storing encrypted unsent emergency dispatches during dead zones or airplane mode.
- [`src/features/dispatch/queueProcessor.ts`](../src/features/dispatch/queueProcessor.ts): Background queue consumer draining pending dispatches FIFO upon network/connectivity restoration.
- [`src/features/dispatch/backoffScheduler.ts`](../src/features/dispatch/backoffScheduler.ts): Exponential backoff scheduler with randomized jitter to prevent dispatch stampedes.
- [`src/features/dispatch/connectivityListener.ts`](../src/features/dispatch/connectivityListener.ts): Network state listener (`@react-native-community/netinfo`) that triggers immediate queue flushes upon signal recovery.
- [`src/features/dispatch/smsDispatch.ts`](../src/features/dispatch/smsDispatch.ts): Dispatch router orchestrating silent Android SMS or triggering the capability-honest iOS composer fallback.
- [`src/features/dispatch/duressDispatch.ts`](../src/features/dispatch/duressDispatch.ts): Covert dispatch pipeline that emits silent distress signals without notifying the user or updating decoy UI state.
- [`src/features/dispatch/index.ts`](../src/features/dispatch/index.ts): Feature exports.

### 2.4 Emergency & Decoy Contacts (`src/features/contacts/`)
- [`src/features/contacts/contactsStorage.ts`](../src/features/contacts/contactsStorage.ts): Encrypted storage of trusted emergency contacts (name, phone number, priority, relationship).
- [`src/features/contacts/decoyContactsStorage.ts`](../src/features/contacts/decoyContactsStorage.ts): Isolated decoy contact database populated and displayed only when unlocked via Duress PIN.
- [`src/features/contacts/ContactsScreen.tsx`](../src/features/contacts/ContactsScreen.tsx): Contacts management UI with CRUD controls.
- [`src/features/contacts/DecoyScreen.tsx`](../src/features/contacts/DecoyScreen.tsx): Sanitized decoy contact management UI displayed during duress.
- [`src/features/contacts/index.ts`](../src/features/contacts/index.ts): Feature exports.

### 2.5 Emergency Geolocation (`src/features/location/`)
- [`src/features/location/locationService.ts`](../src/features/location/locationService.ts): High-accuracy GPS location provider formatting coordinates into Google Maps and OpenStreetMap emergency links.
- [`src/features/location/index.ts`](../src/features/location/index.ts): Feature exports.

### 2.6 Encrypted Incident History (`src/features/history/`)
- [`src/features/history/historyStorage.ts`](../src/features/history/historyStorage.ts): Encrypted on-disk audit log of triggered alerts, recipients, and dispatch statuses.
- [`src/features/history/HistoryScreen.tsx`](../src/features/history/HistoryScreen.tsx): Incident timeline viewer.
- [`src/features/history/index.ts`](../src/features/history/index.ts): Feature exports.

### 2.7 Settings & Trigger Preferences (`src/features/settings/`)
- [`src/features/settings/settingsStorage.ts`](../src/features/settings/settingsStorage.ts): Encrypted user configuration for countdown intervals, volume click patterns, and shake sensitivity.
- [`src/features/settings/SettingsScreen.tsx`](../src/features/settings/SettingsScreen.tsx): Preferences UI.
- [`src/features/settings/index.ts`](../src/features/settings/index.ts): Feature exports.

---

## 3. Application Shell & UI Navigation

Root orchestration layer mounting state providers and navigation routers.

| Path | Purpose |
| :--- | :--- |
| [`App.tsx`](../App.tsx) | Application root mounting `RootNavigator`, state contexts, and app lock lifecycle observers. |
| [`index.ts`](../index.ts) | Expo entry point invoking `registerRootComponent(App)`. |
| [`src/index.ts`](../src/index.ts) | Core module re-export barrier. |
| [`src/app/RootNavigator.tsx`](../src/app/RootNavigator.tsx) | React Navigation tab and stack router managing transitions between SOS, Contacts, History, and Settings. |
| [`src/app/index.ts`](../src/app/index.ts) | Navigation exports. |

---

## 4. Native Hardware Expo Modules (`modules/`)

Custom modular native extensions bridging OS-level hardware capabilities.

### 4.1 Silent SMS (`modules/silent-sms/`)
Bypasses standard UI composers to transmit silent emergency alerts in the background.
- `android/src/main/java/expo/modules/silentsms/SilentSmsModule.kt`: Android `SmsManager` integration (`sendTextMessage` and `sendMultipartTextMessage` with SIM subscription support).
- `ios/SilentSmsModule.swift` & `ios/SilentSms.podspec`: iOS capability-honest stub (SMS sandboxing prevents programmatic background SMS).
- `src/SilentSmsModule.ts` & `src/SilentSms.types.ts`: TypeScript typed native bridge interface.
- `src/SilentSmsModule.web.ts`: Web mock fallback.
- `expo-module.config.json` & `package.json`: Expo module manifest and metadata.

### 4.2 Foreground Service (`modules/foreground-service/`)
Guarantees uninterrupted background execution during emergency states.
- `android/src/main/java/expo/modules/foregroundservice/EmergencyForegroundService.kt`: Sticky elevated foreground service (`FOREGROUND_SERVICE_TYPE_LOCATION`) with ongoing lockscreen notification (`erica_emergency_channel`) and `PARTIAL_WAKE_LOCK`.
- `android/src/main/java/expo/modules/foregroundservice/ForegroundServiceModule.kt`: Native module controller managing service start/stop and "I'M SAFE" notification action bridge.
- `ios/ForegroundServiceModule.swift` & `ios/ForegroundService.podspec`: iOS capability-honest stub.
- `src/ForegroundServiceModule.ts` & `src/ForegroundService.types.ts`: TypeScript bridge.
- `src/ForegroundServiceModule.web.ts`: Web stub.
- `expo-module.config.json` & `package.json`: Expo module manifest.

### 4.3 Physical Hardware Triggers (`modules/physical-triggers/`)
Enables blind, one-handed emergency activation through hardware buttons and sensors.
- `android/src/main/java/expo/modules/physicaltriggers/EricaAccessibilityService.kt`: Binds to Android `system_server` to intercept 4x volume down button presses while the screen is locked/off.
- `android/src/main/java/expo/modules/physicaltriggers/VolumePatternDetector.kt`: Temporal click detector filtering out accidental volume taps.
- `android/src/main/java/expo/modules/physicaltriggers/ShakeDetector.kt`: Accelerometer sensor listener detecting rapid, deliberate shaking.
- `android/src/main/java/expo/modules/physicaltriggers/PhysicalTriggersModule.kt`: Native bridge exposing trigger events and accessibility permission checks to JS.
- `ios/PhysicalTriggersModule.swift` & `ios/PhysicalTriggers.podspec`: iOS stub (iOS prohibits background key interception).
- `src/PhysicalTriggersModule.ts` & `src/PhysicalTriggers.types.ts`: TypeScript bridge.
- `src/PhysicalTriggersModule.web.ts`: Web stub.
- `expo-module.config.json` & `package.json`: Expo module manifest.

---

## 5. Native Android Platform Layer (`android/`)

Complete Android native project generated and configured for custom permissions and services.

- `android/app/build.gradle` & `android/build.gradle`: Gradle build specifications and dependencies.
- `android/gradle.properties`: JVM build parameters and AndroidX configuration.
- `android/settings.gradle`: Native module project links.
- `android/app/proguard-rules.pro`: ProGuard / R8 code shrinking and optimization rules.
- `android/app/src/main/AndroidManifest.xml`: Permissions declaration (`SEND_SMS`, `ACCESS_FINE_LOCATION`, `FOREGROUND_SERVICE`, `RECEIVE_BOOT_COMPLETED`, `WAKE_LOCK`).
- `modules/foreground-service/android/src/main/java/expo/modules/foregroundservice/EricaBootReceiver.kt`: `BroadcastReceiver` waking outbox queue worker immediately on `ACTION_BOOT_COMPLETED`.
- `android/app/src/main/java/com/erica/sos/MainActivity.kt` & `MainApplication.kt`: Android application entry and React Native initialization.
- `modules/physical-triggers/android/src/main/res/xml/erica_accessibility_service_config.xml`: Accessibility service configuration for key event interception.
- `android/app/src/main/res/`: Resources, themes, icons, and splash assets.

---

## 6. Expo Plugins & Project Configuration

- [`plugins/withEricaAndroidConfig.js`](../plugins/withEricaAndroidConfig.js): Custom Expo Config Plugin programmatically injecting permissions, services, and receivers during `npx expo prebuild`.
- [`app.json`](../app.json): Expo application manifest defining bundle identifiers, permissions, scheme, and plugins.
- [`package.json`](../package.json) & [`package-lock.json`](../package-lock.json): Project dependencies and test runner scripts.
- [`tsconfig.json`](../tsconfig.json): TypeScript configuration and module resolution.
- [`.gitignore`](../.gitignore) & [`android/.gitignore`](../android/.gitignore): Build artifact and credential exclusion rules.

---

## 7. Automated Test Matrix & Verification Harness (`test/`)

The 13-suite automated test suite executing under Node.js (`npm test`):

| Test Suite | Focus Area |
| :--- | :--- |
| [`test/sosMachine.test.ts`](../test/sosMachine.test.ts) | State transitions, countdown cancellation, resolution, and action dispatching. |
| [`test/security.test.ts`](../test/security.test.ts) | PBKDF2 stretching, buffer memory zeroing, constant-time compare, and lockout ladder. |
| [`test/storageEncryptionDisk.test.ts`](../test/storageEncryptionDisk.test.ts) | Disk zero-plaintext leaks: verifies no raw contacts, logs, or outbox payloads touch disk unencrypted. |
| [`test/cryptoVectorsAndBackwardCompatibility.test.ts`](../test/cryptoVectorsAndBackwardCompatibility.test.ts) | RFC/Node test vectors and cryptographic schema migration compatibility. |
| [`test/appLock.test.ts`](../test/appLock.test.ts) | App lock timeout, foreground/background lifecycle, and session invalidation. |
| [`test/pinLockStateTransitions.test.ts`](../test/pinLockStateTransitions.test.ts) | PIN verification state transitions and exponential brute-force backoff delays. |
| [`test/duressMode.test.ts`](../test/duressMode.test.ts) | Duress PIN entry, decoy contact isolation, and covert distress transmission. |
| [`test/dispatch.test.ts`](../test/dispatch.test.ts) | SQLite outbox persistence, backoff jitter scheduler, and SMS dispatch router. |
| [`test/lockedEmergencyDispatch.test.ts`](../test/lockedEmergencyDispatch.test.ts) | Emergency dispatch functionality while the device is locked. |
| [`test/airplaneModeAndRebootSurvivability.test.ts`](../test/airplaneModeAndRebootSurvivability.test.ts) | Outbox durability through simulated power loss, device reboots, and dead zones. |
| [`test/physicalTriggers.test.ts`](../test/physicalTriggers.test.ts) | Accessibility volume button pattern recognition and accelerometer shake triggers. |
| [`test/encryptedStorage.test.ts`](../test/encryptedStorage.test.ts) | AES-256-GCM authenticated key-value storage engine unit tests. |
| [`test/iosCompanionFlow.test.ts`](../test/iosCompanionFlow.test.ts) | iOS capability-honest companion flow and SMS composer fallback. |
| **Mocks & Loaders** | `test/ts-resolver.mjs`, `test/types.d.ts`, `test/mockDatabase.ts`, `test/mockReactNative.mjs`, `test/mockExpo.mjs`, `test/mockSms.mjs`, `test/mockLocation.mjs`, `test/mockNetInfo.mjs`, `test/mockLocalAuthentication.mjs`, `test/mockAsyncStorage.mjs`, `test/mockComponent.mjs`. |

---

## 8. Documentation & Architecture Records (`docs/`, root)

- [`README.md`](../README.md): Primary repository overview, architecture, security guarantees, and quickstart guide.
- [`ROADMAP.md`](../ROADMAP.md) / [`docs/ROADMAP.md`](../docs/ROADMAP.md): Phase-by-phase implementation status, delivery milestones, and "done when" criteria.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md): Clean-room engineering rules, branch hygiene, and PR workflows.
- [`LICENSE`](../LICENSE): MIT License specification.
- [`docs/ADVERSARIAL_DEVICE_TESTING.md`](../docs/ADVERSARIAL_DEVICE_TESTING.md): Reference hardware testing protocols across Android OEM skins (HyperOS, ColorOS, XOS).
- [`docs/adr/0001-hermes-crypto-subtle-support-and-pbkdf2-latency.md`](../docs/adr/0001-hermes-crypto-subtle-support-and-pbkdf2-latency.md): Key stretching latency benchmark and native OpenSSL pivot.
- [`docs/adr/001-native-kotlin-and-ios-companion.md`](../docs/adr/001-native-kotlin-and-ios-companion.md): Native Kotlin architecture pivot and capability-honest iOS companion strategy.
