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
   - Alterations to exported native module bridge interfaces (`modules/silent-sms`, `modules/foreground-service`, `modules/physical-triggers`).
   - Signature changes to public domain services (`useAppLock`, `sosMachine`, `smsDispatch`, `outboxQueue`, `locationService`).
   - Breaking changes to cross-module event emitters, listeners, or state schemas.

3. **Altering Database Schemas or Migrations:**
   - Any modification to SQLite table definitions (`erica_outbox.db`), column types, or migration strategies.
   - Any change to the encrypted storage layout, key derivation parameters, or serialization formats.
   - *Rationale:* Breaking migrations risks unrecoverable data corruption of emergency outbox items or lock screen state during live user emergencies.

---

## 2. Core Code Defaults

All implementations and refactors must strictly adhere to the following defaults:

### Explicit Domain Errors Over Silent Null Fallbacks
- Never swallow exceptions or return `null` / `undefined` when an operation fails or encounters an unhandled state.
- Throw typed, contextual domain errors (e.g. `DecryptionError`, `HardwareLockoutError`, `DispatchQueueError`) with clear diagnostics.
- Never use empty catch blocks or fallback to default dummy data in security, encryption, or dispatch execution paths.

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

## 3. Security & Operational Standards

- **Zero Plaintext Leakage:** Ensure memory zeroing (`Buffer.fill(0)`) is used on secret buffers immediately upon completion.
- **Fail-Safe Reliability:** If an emergency dispatch action fails, ensure the payload is preserved in the persistent outbox rather than discarded.
- **Constant-Time Verification:** All cryptographic token or hash comparisons must use constant-time primitives (`timingSafeEqual`).
