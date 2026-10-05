# HARNESS: Verification Pipeline & Autonomous Fix Loop

This harness defines the canonical verification commands, automated toolchain, and execution rules for validating code in the E.R.I.C.A. repository.

---

## 1. Detected Toolchain

| Stage | Tool | Command | Description |
| :--- | :--- | :--- | :--- |
| **Type Checker / Static Analysis** | TypeScript Compiler | `npm run typecheck`<br>`(tsc --noEmit)` | Strict type analysis across all TypeScript source and test files. |
| **Test Runner** | Node.js Test Runner with custom TS resolver | `npm test`<br>`(node --loader ./test/ts-resolver.mjs --experimental-strip-types --test test/*.test.ts)` | Runs every `test/*.test.ts` suite: cryptography and encrypted storage, the outbox queue, the SOS state machine, the volume trigger, deterrence and evidence, parity features, and native-config checks. Native modules are mocked. |
| **Coverage Floor** | Node.js test coverage | `npm run test:coverage` | Fails if line / branch / function coverage of `src/` and the module JS bridges drops below the floor in `package.json`. |
| **Native Config Drift** | Expo prebuild | `CI=1 npx expo prebuild --platform android --no-install` then `git diff --exit-code -- android` | Fails if the committed `android/` differs from what `app.json` and the config plugins generate. |
| **Android Build** | Gradle (GitHub Actions) | `Android test APK` workflow (`.github/workflows/android-apk.yml`) | Compiles all Kotlin and produces an installable test APK. This is the only place Kotlin is compiled; local sessions may not have the Android SDK. |

---

## 2. Canonical Verification Pipeline (`./verify.sh`)

```bash
#!/usr/bin/env bash
set -euo pipefail

# 1. Type Safety & Static Analysis
npm run typecheck

# 2. Automated Test Matrix & Invariant Verification
npm test
```

The script exits immediately (`set -e`) with a non-zero code upon any failure. CI (`.github/workflows/ci.yml`) runs `./verify.sh`, then the coverage floor, then the native config drift check, on every pull request.

---

## 3. Autonomous Execution & Fix Loop Mandate

Whenever making modifications or fixing regressions:

1. **Mandatory Script Execution:**
   - The agent MUST run `./verify.sh` to validate all changes before declaring any task complete. When `src/`, `modules/`, `app.json` or `plugins/` change, it MUST also run `npm run test:coverage` and the native config drift check.
2. **Up to 15 Autonomous Fix Cycles:**
   - If verification fails, the agent runs it up to 15 times iteratively, diagnosing the error, inspecting logs, applying fixes, and re-running.
   - The agent must NOT stop or escalate after 1–2 failures if the issue can be analyzed and corrected within this budget.
   - A test is fixed by fixing the code or a wrong fixture, never by deleting or weakening the assertion. Tests are removed only together with the feature they cover, when the owner has asked for that feature to be removed.
3. **Escalation Boundary:**
   - If after 15 attempts verification is still failing, or the fix requires an Escalation Trigger in [`PRINCIPLES.md`](PRINCIPLES.md) or a change to [`LAWS.md`](LAWS.md) or `tests/laws/`, the agent must stop and escalate the details to the user.

---

## 4. On-Device Verification

Headless tests mock every native module, so they cannot prove that an SMS is sent, a trigger fires, the siren plays, or the app survives in the background. Those are verified on a real phone:

1. **Build:** open a pull request (or run the `Android test APK` workflow manually). Download the `erica-test-apk` artifact from the run. It is a release build signed with a throwaway key: for testers only, and uninstall the previous test build before installing a new one.
2. **Test:** run the relevant scenarios in [`docs/ADVERSARIAL_DEVICE_TESTING.md`](docs/ADVERSARIAL_DEVICE_TESTING.md) on a reference Android phone.
3. **Record:** add a row to the results log (§7 of that document) with date, tester, device and Android version, commit, and pass/fail notes. A native feature is not "done" until it has a passing row.
4. **Pushing and merging:** agents push and open pull requests only when the owner asks. Changes for testing go on a separate branch so the owner can install the APK and decide before merging.
