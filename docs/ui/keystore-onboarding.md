# Keystore Onboarding (Unlock UI)

Last updated: 2025-10-26

Purpose: explain how the desktop prompts for a passphrase and resumes blocked actions once unlocked.

Overview
- Components: `uicp/src/components/KeystoreUnlockModal.tsx`, `uicp/src/components/KeystoreHotkeysListener.tsx`.
- Bridge helpers: `uicp/src/lib/bridge/tauri.ts` (request/await unlock; auto‑retry failed invokes).
- Store: `uicp/src/state/keystore.ts` (status, unlock, lock, saveProviderKey).

How it works
- When a Tauri command fails with `E-UICP-SEC-LOCKED`, the bridge dispatches a `keystore-unlock-request` event with a resume id.
- The modal listens and opens; after successful unlock it emits `keystore-unlock-resume` with the same id.
- The bridge retries the original command once and surfaces the final result.

Commands used
- `keystore_status`, `keystore_unlock(method='passphrase', passphrase)`, `keystore_lock`.
- Optional helpers: `keystore_sentinel_exists`, `keystore_list_ids`.

Hotkeys
- `Esc`: cancel unlock (emits `keystore-unlock-cancel` and does not resume).
- `Enter`: submit passphrase when the input is focused.

Notes
- Unlock TTL is set via `UICP_KEYSTORE_TTL_SEC` (default 1200). The UI shows a countdown and extends it on access.
- The UI never reads plaintext keys; saving provider keys uses `save_provider_api_key` and, for Ollama, a follow-up `test_api_key` check.
