# Agent Settings (UI)

Last updated: 2025-10-26

Purpose: describe the Agent Settings window controls and the backend commands they use for keystore, providers, and profiles. This page documents actual UI behavior in `uicp/src/components/AgentSettingsWindow.tsx` and related state.

Overview
- Profiles: choose planner/actor profiles and reasoning effort.
- Keystore: unlock/lock, save provider API keys, view stored ids.
- Providers: login, health check, resolve path, install/update, container image pull.
- Safety toggles: Safe Mode, container firewall, strict capability minimization.
- Agents config: open/save agents.yaml (path exposed by backend).
- Compute modules (dev): shows resolved modules dir and count.

Keystore
- Unlock/Lock
  - UI dispatches keystore unlock requests when a Tauri command returns `E-UICP-SEC-LOCKED`.
  - Commands: `keystore_status`, `keystore_unlock` (passphrase), `keystore_lock`, `keystore_list_ids`.
- Save API keys
  - UI method: `useKeystore().saveProviderKey(provider, key)` → Tauri `save_provider_api_key`.
  - Supported providers in keystore: `openai`, `anthropic`, `openrouter`, `ollama`.
  - Ollama key save is followed by `test_api_key` to verify.

Providers (CLI integration)
- Health checks: `provider_health` (strict mode toggled via `set_env_var UICP_HEALTH_STRICT=1`).
- Login: `provider_login` (opens provider CLI auth flow if supported).
- Install/update: `provider_install` (managed prefix with npm where applicable).
- Resolve path: `provider_resolve` → returns `{ exe, via }` (dev aid).
- Pull images: `provider_pull_image` → returns `{ image, runtime }` when applicable.

Safety and runtime toggles
- Safe Mode: `set_safe_mode` (disables codegen path end-to-end).
- Container firewall: UI writes `UICP_DISABLE_FIREWALL` via `set_env_var` for containerized providers.
- Strict caps: UI writes `UICP_STRICT_CAPS` via `set_env_var`.

Agents config (YAML)
- Commands: `load_agents_config_file`, `save_agents_config_file`.
- Path: `<app_data_dir>/uicp/agents.yaml`.
- Schema: see docs/agents/README.md and `uicp/src/lib/agents/schema.ts`.

Notes
- The UI suppresses errors when desktop bridge (Tauri) is not available; most actions become no-ops in pure web mode.
- Some legacy proxy helpers may be no-ops if backend commands are absent. These are optional developer aids and not required for normal operation.
