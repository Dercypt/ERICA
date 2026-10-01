# E.R.I.C.A. (Emergency Response & Immediate Contact Alert)

E.R.I.C.A. is a privacy-first personal-safety application built with React Native and Expo. It provides discreet, one-motion emergency alerting, live location sharing, resilient offline dispatch queues, and local cryptographic privacy guarantees.

Designed as a clean-room implementation (zero GPL code incorporated; concepts informed by `dhilipmpms/SOS-alerter`), E.R.I.C.A. operates with zero analytics, zero ad SDKs, and zero third-party telemetry.

---

## Architecture Overview

E.R.I.C.A. employs a hybrid architecture balancing cross-platform testability with deep native Android integration and platform-honest iOS execution:

### 1. Shared Pure TypeScript Domain Core
- **State Machine (`sosMachine`)**: Built with XState v5, governing state transitions, cancellable countdowns, trigger aggregation, and resolution actions.
- **Offline Outbox Queue & Retry Engine**: Persistent SQLite database (`erica_outbox.db`) buffering unsent emergency alerts during dead zones or airplane mode, draining automatically with exponential backoff jitter upon network restoration.
- **Cryptographic & Privacy Layer**: Envelope encryption (AES-256-GCM), CSPRNG master key and salt generation, in-memory buffer zeroing (`Buffer.fill(0)`), and constant-time comparisons (`timingSafeEqual`).
- **100% Headless Testability**: Core logic executes and validates cleanly under Node.js (`npm test`) without requiring hardware emulators.

### 2. Android Native Kotlin Expo Modules
- **`SilentSmsModule` (`modules/silent-sms`)**: Directly interfaces with Android `SmsManager` (`sendTextMessage` and `sendMultipartTextMessage` with multi-SIM support), enabling **true silent background dispatch** without user interaction or opening a UI composer. Distributed via direct APK sideload and F-Droid to bypass Google Play `SEND_SMS` restrictions.
- **`ForegroundServiceModule` (`modules/foreground-service`)**: Elevated `EmergencyForegroundService` (`FOREGROUND_SERVICE_TYPE_LOCATION`) with persistent lockscreen notification (`erica_emergency_channel`), `START_STICKY` lifecycle, and partial wake locks surviving task dismissal.
- **`PhysicalTriggersModule` (`modules/physical-triggers`)**: `EricaAccessibilityService` bound to Android `system_server` to intercept 4x volume down clicks while the screen is locked or turned off, awakening the UI over keyguard. `EricaBootReceiver` guarantees outbox drain across device reboots.

### 3. iOS Capability-Honest Companion
- Adheres strictly to Apple platform sandboxing, which prohibits background programmatic SMS and global hardware key interception.
- Operates as a **capability-honest companion**: provides UI-driven cancellable countdowns, fallback to native SMS composer (`expo-sms`) pre-populated with live GPS links, and biometric authentication (Face ID / Touch ID) via `expo-local-authentication`.

---

## Hardware Testing & Platform Status

> [!IMPORTANT]
> E.R.I.C.A. is **tested on reference Android hardware** (Google Pixel and AOSP reference devices running Android 13 and Android 14), alongside verified configuration walkthroughs for hostile OEM skins (Xiaomi HyperOS/MIUI, Oppo ColorOS, Transsion XOS).
>
> We deliberately **avoid overreaching claims such as "certified"**, as the vast landscape of Android device manufacturers, proprietary battery managers, and carrier-specific basebands prevents universal guarantees.

For detailed device configuration, ADB validation commands, and OEM battery optimizer bypass steps, consult:
- [Real-World Adversarial & Reference Hardware Test Verification](docs/ADVERSARIAL_DEVICE_TESTING.md)
- [ADR 001: Native Kotlin Architecture Pivot & Capability-Honest iOS Companion](docs/adr/001-native-kotlin-and-ios-companion.md)
- [ADR 0001: Hermes Cryptographic Primitives & PBKDF2 Latency Benchmark](docs/adr/0001-hermes-crypto-subtle-support-and-pbkdf2-latency.md)

---

## Trust & Privacy Guarantees

1. **Hardware-Backed Cryptography**: All offline contacts, history logs, and outbox payloads are encrypted at rest with authenticated AES-256-GCM.
2. **Native PBKDF2 Key Stretching**: Empirically measured at **207,856 ms** (~3.46 minutes) under interpreted Hermes bytecode, key stretching was moved to native C++ JSI / OpenSSL bindings (`react-native-quick-crypto`), achieving **<140 ms** on reference hardware without UI thread freezing.
3. **Progressive Lockout Ladder**: Protects against brute-force attacks with progressive backoff delays enforced and persisted in hardware `SecureStore`.
4. **Coercion-Safe Duress Mode**: Biometric unlock defaults to **OFF** under Duress Mode because physical biometrics cannot resist physical coercion. Unlocking requires a dedicated 6-digit Duress PIN that displays a sanitized decoy interface while silently queuing distress dispatches.

---

## Project Structure & Architecture

A complete file-by-file categorization and taxonomy is documented in [docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md).

```text
ERICA/
├── AGENTS.md                # Autonomous agent directives & execution loop
├── LAWS.md                  # Immutable system invariants & read-only laws
├── PRINCIPLES.md            # Engineering defaults & escalation triggers
├── HARNESS.md               # Verification toolchain & autonomous fix protocol
├── verify.sh                # End-to-end verification harness runner
├── android/                 # Android native project and manifest configuration
├── assets/                  # App icons, splash screens, and adaptive assets
├── docs/                    # Architecture Decision Records, testing specs & roadmap
│   ├── adr/                 # Architecture Decision Records (001, 0001)
│   ├── ADVERSARIAL_DEVICE_TESTING.md
│   ├── PROJECT_STRUCTURE.md # Detailed file-by-file taxonomy & categorization
│   └── ROADMAP.md
├── modules/                 # Native Expo Modules (Android Kotlin + iOS Swift)
│   ├── foreground-service/  # EmergencyForegroundService, wake locks & notification actions
│   ├── physical-triggers/   # Volume button AccessibilityService & BootReceiver
│   └── silent-sms/          # Direct SmsManager multipart silent background dispatch
├── plugins/                 # Expo Config Plugins (manifest injection & permissions)
│   └── withEricaAndroidConfig.js
├── src/                     # Pure TypeScript domain logic & application shell
│   ├── app/                 # Root navigation and screen layout
│   └── features/            # Feature domains
│       ├── contacts/        # Encrypted emergency & decoy contacts
│       ├── dispatch/        # SQLite outbox queue & exponential backoff retry engine
│       ├── history/         # Encrypted incident & dispatch audit log
│       ├── location/        # High-accuracy emergency GPS provider
│       ├── security/        # AES-256-GCM, native PBKDF2, master key lifecycle & app lock
│       ├── settings/        # Hardware triggers and alert preferences
│       └── sos/             # XState v5 emergency state machine and primary UI
├── test/                    # 13-suite automated test matrix & headless mocks
├── App.tsx                  # Root application entry
├── app.json                 # Expo project manifest & native permissions
├── CONTRIBUTING.md          # Workflow guidelines and branch rules
├── LICENSE                  # MIT License
├── package.json             # Dependencies and test runner script
└── tsconfig.json            # TypeScript configuration
```

---

## Getting Started

### Prerequisites
- Node.js (v18+)
- npm or yarn
- Android SDK (for native Android builds) or Expo Go (for UI exploration)

### Running Automated Verification
Run the complete 13-suite automated test matrix:
```bash
npm test
```

### Type Checking
```bash
npm run typecheck
```

### Running the App
```bash
# Start development server
npm run start

# Run Android Dev Client build
npm run android

# Run iOS build
npm run ios
```

---

## License

MIT License — Copyright (c) 2026 Jesse Manuel Pimentel, Karigawa, and E.R.I.C.A. Contributors. See [LICENSE](LICENSE) for details.
