# ADR 0001: Hermes Cryptographic Primitives (crypto.subtle) & PBKDF2 Latency Benchmark

- **Status**: Decided / Documented
- **Date**: 2026-10-01
- **Context**: E.R.I.C.A. Phase 3 (Trust & Privacy Layer) — PIN key stretching, encrypted storage vault, and runtime cryptographic capability verification.

---

## 1. Context & Objectives

To fulfill E.R.I.C.A.'s privacy-first threat model, the application requires:
1. Symmetric authenticated encryption (AES-256-GCM) to safeguard offline sensitive data (emergency contacts, dispatch queues, local history logs).
2. Cryptographic key stretching via PBKDF2-HMAC-SHA256 to protect user PINs against offline brute-force and dictionary attacks.
3. Cryptographically secure random number generation (CSPRNG) for master keys, salts, and initialization vectors (IVs).

The objective was to empirically verify whether the Android environment running the **Hermes engine natively supports the W3C WebCrypto API (`crypto.subtle`)** for AES-GCM and PBKDF2, and to measure real-world PBKDF2 latency (at 100,000 iterations) directly on device silicon under Hermes.

---

## 2. Diagnostic Probe Methodology

A diagnostic probe was deployed to the Android runtime inspecting:
- `globalThis.crypto`
- `globalThis.crypto?.subtle`
- `globalThis.crypto?.subtle?.encrypt` (AES-GCM)
- `globalThis.crypto?.subtle?.deriveBits` (PBKDF2)
- CSPRNG availability (`globalThis.crypto?.getRandomValues`)
- Real-world execution latency of 100,000 PBKDF2 iterations using the app's key derivation engine (`pbkdf2HmacSha256`)

The application was built and run via `npx expo run:android` and inspected directly via `adb logcat`.

---

## 3. Empirical Results & Findings

### 3.1 Hermes WebCrypto API Support Matrix

| Primitive / Property | Result | Notes |
| :--- | :--- | :--- |
| **JavaScript Engine** | `Hermes` | Detected via `globalThis.HermesInternal` |
| **`globalThis.crypto`** | `undefined` (`false`) | Not present globally in stock Hermes |
| **`crypto.subtle`** | `undefined` (`false`) | WebCrypto Subtle API is not provided |
| **`subtle.encrypt`** (AES-GCM) | **Unavailable** | Cannot use hardware-accelerated WebCrypto AES-GCM |
| **`subtle.deriveBits`** (PBKDF2) | **Unavailable** | Cannot use WebCrypto PBKDF2 derivation |
| **`crypto.getRandomValues`** | **Unavailable** | Requires native polyfill (`expo-crypto` / native bridge) |

### 3.2 Real-World PBKDF2 Latency Benchmark

The benchmark was executed on the Hermes runtime executing 100,000 PBKDF2-HMAC-SHA256 iterations (deriving a 32-byte key from a 4-digit PIN and 32-byte salt):

- **Iterations**: 100,000
- **Algorithm**: PBKDF2-HMAC-SHA256
- **Execution Path**: Pure TypeScript / JavaScript fallback engine (interpreted bytecode in Hermes)
- **Measured Duration**: **`207,856 ms` (~207.86 seconds / 3.46 minutes)**
- **Logcat Output**:
  ```text
  I ReactNativeJS: [CRYPTO_PROBE] ⏱️ Benchmarking pbkdf2HmacSha256 for 100,000 iterations...
  I ReactNativeJS: [CRYPTO_PROBE] 🎯 BENCHMARK COMPLETE: 100,000 PBKDF2 iterations took: 207856 ms
  I ReactNativeJS: [CRYPTO_PROBE] >>> CRYPTO DIAGNOSTIC PROBE FINISHED <<<
  ```

---

## 4. Architectural Analysis & Implications

1. **Pure JS PBKDF2 is completely non-viable for interactive UI paths**:
   - In Node.js (V8 with JIT), pure TypeScript PBKDF2 at 100,000 iterations completes in ~125–155 ms.
   - In Hermes (ahead-of-time bytecode interpreter with zero JIT compiler on Android), 100,000 iterations requires 200,000 full SHA-256 block hash passes (12.8 million bitwise operations).
   - This causes an unacceptable **3.5-minute freeze** of the JavaScript UI thread if executed directly in pure JS.

2. **Native Crypto Bridge / JSI Acceleration is Mandatory**:
   - WebCrypto `crypto.subtle` cannot be relied upon in Hermes out of the box.
   - Cryptographic acceleration must be provided by native Android primitives (`javax.crypto.SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")` or OpenSSL/BoringSSL via C++ JSI / TurboModules), or an optimized native module.
   - For offline mobile devices, if a pure JS path is ever used as a fallback, iteration counts must be adjusted with an Argon2/PBKDF2 calibration step or offloaded from the main thread.

3. **CSPRNG Requirements**:
   - `generateRandomBytes` must explicitly link to a native entropy source (such as Android's `java.security.SecureRandom` or `expo-crypto`) because Hermes does not inject `globalThis.crypto.getRandomValues`.

4. **React Lifecycle & Store Stability**:
   - `useSyncExternalStore` consumers (such as `useAppLock`) require immutable snapshot caching in `appLockController.getSnapshot()` to prevent infinite re-render loops (`Maximum update depth exceeded`).

---

## 5. Decision & Next Steps

1. **Documented Real-World Baseline**: The empirical latency figure of **207,856 ms** is recorded as the real-world baseline for 100,000 pure JS PBKDF2 iterations on Hermes.
2. **Native Cryptography Layer**: Introduce native cryptographic bindings for PBKDF2 key derivation and AES-GCM encryption in Phase 3/Phase 4.
3. **Store Snapshot Caching**: Preserved cached snapshot pattern in `AppLockController` to ensure deterministic React render cycles.
