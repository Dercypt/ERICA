# HARNESS: Verification Pipeline & Autonomous Fix Loop

This harness defines the canonical verification commands, automated toolchain, and strict execution rules for validating code integrity in the E.R.I.C.A. repository.

---

## 1. Detected Toolchain

The E.R.I.C.A. repository relies on Node.js and TypeScript for headless cross-platform verification of pure domain core logic, security primitives, and state machines:

| Stage | Tool | Command | Description |
| :--- | :--- | :--- | :--- |
| **Type Checker / Static Analysis** | TypeScript Compiler | `npm run typecheck`<br>`(tsc --noEmit)` | Performs strict type analysis across all TypeScript source and test files. |
| **Test Runner** | Node.js Test Runner with custom TS resolver | `npm test`<br>`(node --loader ./test/ts-resolver.mjs --experimental-strip-types --test test/*.test.ts)` | Executes the automated 13-suite test matrix covering cryptography, outbox queues, SOS state machines, physical triggers, and duress modes. |
| **Linter** | Compiler Static Checks | Integrated in `tsc --noEmit` | Validates strict typing and syntax correctness without external unvetted lint dependencies. |

---

## 2. Canonical Verification Pipeline (`./verify.sh`)

All validation is consolidated into the root executable script [`verify.sh`](file:///Users/zyndrex/ERICA-sandbox/verify.sh):

```bash
#!/usr/bin/env bash
set -euo pipefail

# 1. Type Safety & Static Analysis
npm run typecheck

# 2. Automated Test Matrix & Invariant Verification
npm test
```

The script exits immediately (`set -e`) with a non-zero code upon any failure.

---

## 3. Autonomous Execution & Fix Loop Mandate

Whenever making modifications or fixing regressions:

1. **Mandatory Script Execution:**
   - The agent MUST run `./verify.sh` to validate all changes before declaring any task complete.
2. **Up to 15 Autonomous Fix Cycles:**
   - If `./verify.sh` fails (typecheck error or test failure), the agent is **strictly mandated to run `./verify.sh` up to 15 times iteratively**, diagnosing the error, inspecting logs, applying fixes, and re-running the script autonomously.
   - The agent must NOT stop or escalate to the user after 1–2 test failures if the issue can be analyzed and corrected within this 15-iteration budget.
3. **Escalation Boundary:**
   - If after 15 autonomous attempts the verification pipeline is still failing, or if the failure requires violating an Escalation Trigger in [`PRINCIPLES.md`](file:///Users/zyndrex/ERICA-sandbox/PRINCIPLES.md) or modifying immutable files in `tests/laws/` and [`LAWS.md`](file:///Users/zyndrex/ERICA-sandbox/LAWS.md), the agent must immediately stop and escalate the failure details to the user.
