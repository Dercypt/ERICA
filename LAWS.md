# LAWS: System Invariants and Governance Rules

## Primary Domain
**E.R.I.C.A. (Emergency Response & Immediate Contact Alert)** is a personal-safety application built with React Native, Expo, and native Android Kotlin modules. Its job is to get an emergency alert, with the user's location, to the people they trust. It provides fast SOS triggering, a durable offline dispatch queue, optional deterrence and evidence capture, and encryption of everything it stores.

---

## Immutable Law & Invariant Governance Rule
> [!CAUTION]
> **IMMUTABLE FILES:** All files located in `tests/laws/` (and `test/laws/`) and `LAWS.md` are read-only to AI agents and automated workflows acting on their own initiative.
>
> An agent may never modify, delete, bypass, or weaken any specification in `LAWS.md` or any test asserting these laws unless the project owner explicitly directs that specific change. If a task appears to require modifying a law or its invariant test, the agent MUST stop and escalate to the human user. Every owner-directed change is recorded in the Amendment Log at the end of this file.

---

## Non-Negotiable System Invariants

### Law 1: Zero Plaintext at Rest & Cryptographic Integrity
All sensitive user data, including emergency contacts, location coordinates, incident history logs, evidence recordings and photos, and offline emergency outbox payloads, must be encrypted at rest using authenticated AES-256-GCM.
- Unencrypted sensitive data must never be written to flash storage, unencrypted key-value stores (`AsyncStorage`), unauthenticated caches, or standard logs.
- The 256-bit master key must reside in hardware-backed storage (`SecureStore`, backed by Android Keystore / iOS Keychain). It is device-bound and does not depend on any user secret.
- Transient in-memory key buffers and decrypted secrets must be wiped immediately after use (`Buffer.fill(0)`).
- Any comparison of secrets must execute in constant time (`timingSafeEqual`).

### Law 2: Emergency Alert Dispatch Durability & Non-Loss Guarantee
Emergency alerts initiated through any trigger (the in-app SOS button, the volume-button pattern, or a resumed alert after reboot) must never be dropped or silently discarded, whatever the delivery channel.
- In dead zones, airplane mode, or network loss, emergency payloads must persist in the local encrypted SQLite outbox queue (`erica_outbox.db`).
- Outbox payloads must survive application background termination, process crashes, and device reboots.
- The outbox queue processor must automatically resume and drain queued alerts with exponential backoff and jitter when connectivity returns.
- An optional extra step (an emergency phone call, a live location update) must never delay, replace, or cancel the alert itself.

### Law 3: SIM SMS Baseline
Sending the alert as an SMS through the user's own SIM is the baseline delivery channel and must always remain available.
- A contact reached by SMS must never need to install anything, create an account, or have an internet connection to receive an alert.
- Any other delivery channel (for example an internet channel) is optional and additive. It may be offered in place of SMS only when the user chooses it for a contact, and it must never remove the ability to send by SMS.
- Alert text must stay readable on any phone: plain text, no reliance on links or rich formatting to convey the location.

### Law 4: Deterministic SOS Lifecycle & Clean Resource Teardown
The emergency lifecycle state machine (`sosMachine`) must govern all alert states (`idle` -> `countdown` -> `dispatching` -> `active` -> `resolving` -> `idle`) deterministically, without ambiguous intermediate states.
- Entering active emergency states must start the elevated foreground service with a persistent lockscreen notification and acquire appropriate partial wake locks.
- Any transition to cancellation or resolution (`CANCEL`, `DISMISS`, `MARK_SAFE`) must release all wake locks, stop foreground services, stop the siren, strobe and vibration, stop live location updates, and clean up notifications.
- No orphaned background tasks, timers, wake locks, or notifications may remain active after returning to `idle`.

### Law 5: Zero Telemetry & Minimal Transmission
E.R.I.C.A. collects nothing about its users.
- Zero analytics SDKs, zero advertising identifiers, zero crash-reporting telemetry beacons, and zero third-party tracking services are permitted in the codebase.
- Data may leave the device only:
  - as an emergency alert or follow-up (location update, resolution) sent over a channel the user has set up, or
  - as a backup the user starts themselves.
- SMS through the user's SIM, and calls the user has enabled, are always permitted channels.
- Any internet channel or backup must be opt-in, must work without creating a user account, and must be end-to-end encrypted so that no server or relay can read message contents or stored data.

---

## Amendment Log

| Date | Directed by | Change |
| :--- | :--- | :--- |
| 2026-10-05 | Project owner | PIN, biometric and duress-PIN features removed from the app. Law 3 (Coercion Resistance & Duress Isolation) replaced by Law 3 (SIM SMS Baseline). Law 5 changed from "SMS only" to allow opt-in, account-free, end-to-end encrypted internet channels and user-started backups. Law 2 trigger list updated (shake and duress triggers removed). Law 4 state names corrected to match `sosMachine` and teardown extended to vibration and live location. Law 1 extended to evidence and clarified that the master key does not depend on a PIN. |
