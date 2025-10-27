# Configuration Reference

Last updated: 2025-10-26

Purpose: single place to discover environment variables and feature flags used across UI and backend.

Frontend (Vite env)
- `VITE_UICP_MODE` (dev|test|pilot|prod): selects default UI configuration.
- `VITE_PLANNER_TIMEOUT_MS`, `VITE_ACTOR_TIMEOUT_MS`: stream timeouts.
- Network guard: see docs/security/network-guard.md for `VITE_NET_GUARD_*` and `VITE_URLHAUS_*` variables.

Backend (Rust/Tauri)
- Compute features (Cargo features): `wasm_compute`, `uicp_wasi_enable`, `otel_spans`, `compute_harness`.
- Module registry and verification:
  - `UICP_MODULES_DIR`: override modules directory.
  - `STRICT_MODULES_VERIFY`: enable strict signature verification.
  - `UICP_MODULES_PUBKEY`: Ed25519 public key (base64 or hex) for strict mode.
  - `UICP_TRUST_STORE` or `UICP_TRUST_STORE_JSON`: map of keyid → pubkey for per-entry signature verify.
- Providers/CLI resolution overrides: e.g., `UICP_CLAUDE_PATH`, managed prefix controlled by installer.
- Keystore: no public envs for plaintext; keys are stored internally via unlock flows.

Build/Tooling
- Node 20.x and pnpm 9.x (see uicp/package.json engines).
- Tauri 2.x (see uicp/src-tauri/Cargo.toml dependencies).

