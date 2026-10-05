# PRINCIPLES: Engineering Guidelines & Escalation Protocols

This document establishes the operational principles, engineering defaults, and escalation triggers for contributors and automated agents working in the E.R.I.C.A. codebase.

---

## 1. Escalation Triggers

Automated agents and contributors MUST halt work and prompt the user for explicit approval before proceeding whenever any of the following triggers are encountered:

1. **Adding External Dependencies:**
   - Any modification to `package.json` adding, replacing, or updating dependencies or devDependencies.
   - Any addition of native Gradle dependencies (`android/build.gradle`, `modules/*/build.gradle`) or CocoaPods dependencies.
   - *Rationale:* E.R.I.C.A. has strict zero-telemetry, security, and supply-chain auditing constraints.

2. **Modifying Public API Routes or Contracts:**
   - Alterations to exported native module bridge interfaces (`modules/silent-sms`, `modules/foreground-service`, `modules/physical-triggers`, `modules/deterrence-evidence`).
   - Signature changes to public domain services (`sosMachine`, `smsDispatch`, `outboxQueue`, `locationService`, `evidenceCoordinator`).
   - Breaking changes to cross-module event emitters, listeners, or state schemas.

3. **Altering Database Schemas or Migrations:**
   - Any modification to SQLite table definitions (`erica_outbox.db`, `erica_evidence.db`), column types, or migration strategies.
   - Any change to the encrypted storage layout, key derivation parameters, or serialization formats.
   - *Rationale:* Breaking migrations risks unrecoverable corruption of emergency outbox items or evidence during live user emergencies.

4. **Sending Data Anywhere New:**
   - Adding any network request, internet delivery channel, backup destination, push service, or other third-party service.
   - *Rationale:* LAWS.md Law 5 limits what may leave the device; every new path needs the owner's approval and must be opt-in, account-free and end-to-end encrypted.

5. **Changing the Laws:**
   - Any edit to `LAWS.md` or to tests in `tests/laws/` / `test/laws/`. Only the project owner can direct such a change, and it is recorded in the LAWS.md Amendment Log.

---

## 2. Product Principles

- **The alert comes first.** ERICA exists to get an alert and a location to trusted people. Every feature is judged by whether it helps that alert arrive, and nothing may delay or endanger it.
- **SMS stays the baseline.** A contact reached by SMS needs nothing installed (LAWS.md Law 3). Other channels are optional extras.
- **Keep it simple.** The essentials are visible on the first screen. Rarely used options sit behind an "Advanced" section. Settings save the moment they change, with no Save button to forget. Use plain words, not jargon.
- **Proven on a phone, not just in tests.** Native behaviour (SMS, triggers, siren, camera, background survival) only counts as working after it has run on a real Android phone (see HARNESS.md §4).
- **Clean-room parity.** Features may be inspired by other apps such as SOS-alerter, but their source code is never copied. SOS-alerter is GPL-3.0 and E.R.I.C.A. is MIT (see CONTRIBUTING).
- **Say what is not done.** Docs, PRs and status notes state plainly what is unverified or still broken. Never claim "tested" or "complete" without recorded evidence.

---

## 3. Core Code Defaults

All implementations and refactors must strictly adhere to the following defaults:

### Explicit Domain Errors Over Silent Null Fallbacks
- Never swallow exceptions or return `null` / `undefined` when an operation fails or encounters an unhandled state.
- Throw typed, contextual domain errors (e.g. `DecryptionError`, `DispatchQueueError`) with clear diagnostics.
- Never use empty catch blocks or fallback to default dummy data in security, encryption, or dispatch execution paths.
- Exception: optional extras around the alert (siren, vibration, an emergency call, a live location update) log and continue on failure, because they must never stop the alert itself (LAWS.md Law 2).

### Avoid Premature Abstractions for Single-Use Logic
- Prefer straightforward, linear, and readable code over layered generic abstractions.
- Do not introduce design patterns, generic factories, or adapter indirections for single-call-site logic.
- Keep domain boundaries distinct: native module bridges, storage operations, and XState actors should remain direct and transparent.

### Zero Untyped Bypasses
- Strict TypeScript must be maintained across all files (`tsconfig.json`).
- Absolutely no `any`, `unknown` casts without immediate type guards, or `@ts-ignore` / `@ts-nocheck` comments.
- Do not cast values via `as unknown as T` or use unchecked type assertions (`!`) on critical security structures or nullable variables.
- Type definitions must accurately model nullable states, discriminated unions, and error returns.

---

## 4. Security & Operational Standards

- **Zero Plaintext Leakage:** Ensure memory zeroing (`Buffer.fill(0)`) is used on secret buffers immediately upon completion.
- **Fail-Safe Reliability:** If an emergency dispatch action fails, ensure the payload is preserved in the persistent outbox rather than discarded.
- **Constant-Time Verification:** Any comparison of secrets or hashes must use constant-time primitives (`timingSafeEqual`).
