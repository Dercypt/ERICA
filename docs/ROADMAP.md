# E.R.I.C.A. Roadmap

Emergency Response & Immediate Contact Alert — a privacy-first personal-safety
app. This roadmap sequences the build phase by phase. Each phase lists its
goal, its concrete tasks, and a "done when" line — don't start the next phase
until the current one's done-when is true.

Design reference (ideas only, no code reused): `dhilipmpms/SOS-alerter`
(GPL-3.0). See the README for why this is a clean-room build.

## Phase 0 — Team foundations

Process, not code. Do this before writing feature code.

- [x] Branch protection: work happens on feature branches + PRs, not direct
      pushes to `master`.
- [x] Resolve README/LICENSE content with the whole team — copyright holder
      formally settled as Jesse Manuel Pimentel, Karigawa, and E.R.I.C.A.
      Contributors under the MIT License; README updated to document the native
      Kotlin architecture and disciplined hardware testing.
- [x] Distribution path: sideload / F-Droid, not Play Store — Play restricts
      the `SEND_SMS` permission to default SMS/dialer apps, which blocks
      silent send otherwise. Confirm the team agrees.
- [x] Split Phase 1 ownership across the team.

**Done when:** everyone pushes to feature branches, the README/LICENSE
question is settled, and Phase 1 tasks have owners.

## Phase 1 — Walking skeleton (Expo Go, zero native code)

Goal: prove the logic end-to-end before touching native code.

1. App shell — Home/SOS, Contacts, Settings, History screens, wired but empty.
2. Contacts CRUD, stored locally.
3. SOS button + cancellable countdown, length read from settings (not
   hardcoded — SOS-alerter shipped this as a bug).
4. Location fetch (`expo-location`) → Google Maps link.
5. SMS via `expo-sms` (composer-based — user taps send; fine for this phase,
   proves the message/contact loop).
6. Local session history log.

**Done when:** add a contact → hit SOS → countdown → composer opens
pre-filled with live location to the right people. Runs in Expo Go.

## Phase 2 — Native foundations

Goal: everything that requires leaving Expo Go for a Dev Client build.

1. `expo prebuild` + Dev Client + a config plugin for Android native code.
2. Foreground service as its own small module — not a single god-service.
3. Native module wrapping `SmsManager.sendTextMessage()` directly — true
   silent send, no composer.
4. Persistent outbox queue — durable, survives app kill/reboot, retries with
   backoff instead of giving up after a fixed number of tries.
5. Background triggers added one at a time, each **off by default** until
   tuned: hardware-button sequence, shake. Voice trigger deferred — it needs
   internet, which fights the offline goal.

**Done when:** SOS fires silently with the screen off, a real SMS lands on
contacts' phones with zero taps, and a dropped signal keeps retrying instead
of vanishing after 3 tries.

*Hardware verification note:* Native Kotlin modules are **tested on reference Android hardware** under Doze and restricted settings constraints, deliberately avoiding overreaching claims like "certified" across fragmented OEM skins. See [ADR 001](adr/001-native-kotlin-and-ios-companion.md) and [ADVERSARIAL_DEVICE_TESTING.md](ADVERSARIAL_DEVICE_TESTING.md).

## Phase 3 — Trust & privacy layer

The gap that matters most for this app's actual threat model — the phone
ending up in the wrong hands.

1. App-lock: PIN/biometric on open.
2. Encrypted local storage for contacts, logs, evidence.
3. Decoy/hidden-icon option — stretch, scope later.

**Done when:** the phone in someone else's hands is locked out without the
PIN, and the local database is unreadable without the app's key.

## Phase 4 — Deterrence & evidence

- [x] Siren + strobe, respecting silent mode.
- [x] Consent-gated audio recording.
- [x] Consent-gated photo capture (front/rear).

All off the main thread — SOS-alerter blocked on geocoding and DB writes
during its emergency path.

**Done when:** Siren audio and strobe torch fire asynchronously off the main thread respecting ringer mode, ambient audio and dual-camera photos are consent-gated and encrypted at rest with AES-256-GCM, and deterministic teardown releases all hardware upon stand down.

## Phase 5 — Reliability & tests

1. Unit tests on the dispatch/retry/queue logic — SOS-alerter shipped this
   with zero tests, on the single most safety-critical path in the app.
2. Integration test for the full trigger → countdown → dispatch path.
3. CI runs the suite on every PR.
4. Adversarial test matrix covering dead-zone outbox buffering, reboot survivability, task dismissal, and progressive PIN throttling.

**Done when:** All test suites pass cleanly (`npm test`). Emergency dispatch and background survivability are **tested on reference Android hardware** under adversarial conditions (simulated 15+ min deep Doze, locked keyguard, airplane mode dead-zones), avoiding overreaching claims like "certified" due to OEM-specific task killer variations.

## Phase 6 — Onboarding & polish

First-run flow with a trigger calibration/test-fire mode, so users know what
will and won't set it off before it matters. Settings screens for everything
above. Visual design pass.

## Phase 7 — Dispatch abstraction for institutional integration

Define a `DispatchChannel` interface now (SMS is channel #1) so a future
telco or PNP dispatch API slots in without touching trigger or UI code — the
architectural hook the government pitch needs.

Bluetooth mesh and a LoRa companion device are real ideas, flagged as
separate future tracks — they don't block the app phases above.

## Phase 8 — iOS companion

Once Android is solid. iOS forbids programmatic background SMS and always-on
sensor triggers, so this ships as a capability-honest companion, not feature
parity — stated plainly in the concept paper's Scope & Limitations.

*Implementation note:* Delivered as a capability-honest companion: UI-driven cancellable countdown, `expo-sms` composer fallback, and Face ID / Touch ID biometric gatekeeper (`expo-local-authentication`). Non-blocking tests run cleanly in headless CI without requiring Xcode.
