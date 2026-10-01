# LAWS: System Invariants and Governance Rules

## Primary Domain
**E.R.I.C.A. (Emergency Response & Immediate Contact Alert)** is a mission-critical, privacy-first personal-safety application built with React Native, Expo, and native Android Kotlin modules. It provides discreet emergency alerting, encrypted location sharing, offline dispatch queues, and local cryptographic privacy guarantees.

---

## Immutable Law & Invariant Governance Rule
> [!CAUTION]
> **IMMUTABLE FILES:** All files located in `tests/laws/` (and `test/laws/`) and `LAWS.md` are strictly immutable and read-only to all AI agents and automated workflows.
> 
> Under no circumstances may an agent modify, delete, bypass, or weaken any specification in `LAWS.md` or any test asserting these laws. If a task appears to require modifying a law or its corresponding invariant test, the agent MUST immediately stop and escalate to the human user.

---

## Non-Negotiable System Invariants

### Law 1: Zero Plaintext at Rest & Cryptographic Integrity
All sensitive user data—including emergency contacts, location coordinates, incident history logs, and offline emergency outbox payloads—must strictly be encrypted at rest using authenticated AES-256-GCM.
- Unencrypted sensitive data must never be written to flash storage, unencrypted key-value stores (`AsyncStorage`), unauthenticated caches, or standard logs.
- The 256-bit master key and salts must reside securely within hardware-backed storage (`SecureStore` backed by Android Keystore / iOS Keychain).
- Transient in-memory key buffers and decrypted secrets must be wiped immediately after use (`Buffer.fill(0)`).
- Secret verification and comparison must execute in constant time (`crypto.timingSafeEqual`) to prevent timing side-channels.

### Law 2: Emergency Alert Dispatch Durability & Non-Loss Guarantee
Emergency alerts initiated through any trigger mechanism (in-app countdown, 4x volume button accessibility hook, boot receiver, or duress unlock) must never be dropped or silently discarded.
- In dead zones, airplane mode, or network loss, emergency payloads must persist in the local encrypted SQLite outbox queue (`erica_outbox.db`).
- Outbox payloads must survive application background termination, process crashes, and device reboots.
- The outbox queue processor must automatically resume and drain queued alerts with exponential backoff and jitter upon network or SIM connectivity restoration.

### Law 3: Coercion Resistance & Duress Isolation (Zero-Leakage Decoy State)
When the application is unlocked using the secondary 6-digit Duress PIN under physical coercion, the system must present a completely functional decoy interface while covertly queuing emergency distress dispatches.
- The decoy user interface must look authentic and must never reveal SOS state, active dispatches, or distress indicators.
- Biometric authentication must automatically be disabled under Duress Mode because physical biometrics cannot resist physical coercion.
- Duress PIN entries must never increment failed authentication counters, trigger lockout ladders, or write lockout metadata to disk.
- Decoy contacts and decoy data stores must remain strictly isolated from authentic emergency data and master key lifecycle.

### Law 4: Deterministic SOS Lifecycle & Clean Resource Teardown
The emergency lifecycle state machine (`sosMachine`) must govern all alert states (`idle` -> `countingDown` -> `active` -> `resolving` -> `idle`) deterministically without ambiguous intermediate states.
- Entering active emergency states must start the elevated foreground service with a persistent lockscreen notification and acquire appropriate partial wake locks.
- Any transition to cancellation or resolution (`CANCEL`, `MARK_SAFE`) must synchronously release all wake locks, stop foreground services, and clean up notifications.
- No orphaned background tasks, wake locks, or notifications may remain active after returning to `idle`.

### Law 5: Zero Telemetry & Air-Gapped Privacy Boundary
E.R.I.C.A. maintains an absolute air-gap against surveillance, telemetry, and tracking.
- Zero analytics SDKs, zero advertising identifiers, zero crash-reporting telemetry beacons, and zero third-party tracking services are permitted in the codebase.
- Outbound network/cellular transmission is strictly limited to user-authorized emergency dispatch channels (such as cellular SMS via native Android `SmsManager` or system SMS composer).
