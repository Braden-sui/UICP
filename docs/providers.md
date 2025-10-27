# Providers: CLI, Health, and Keystore

Last updated: 2025-10-26

Purpose: how provider CLIs are resolved/used, and how backend-only headers are built from the embedded keystore.

Backend modules
- CLI glue: uicp/src-tauri/src/provider_cli.rs
- Keystore to headers: uicp/src-tauri/src/providers.rs

Supported CLIs (CLI integration layer)
- `codex` (OpenAI Code): login and health flows
- `claude` (Anthropic Claude Code): login and health flows

Common Tauri commands
- Login: `provider_login(provider)`
- Health: `provider_health(provider)`
- Resolve: `provider_resolve(provider)` -> path + origin (PATH vs managed)
- Install (managed prefix): `provider_install(provider)` (uses `npm i -g --prefix <managed>` under the hood)

Resolution strategy
- Search order: env override (e.g., `UICP_CLAUDE_PATH`), managed prefix bin, then PATH.
- For login: headless wrapper is disabled to allow CLI browser/device flow.

Keystore usage
- `build_provider_headers(provider)` reads secrets from the internal keystore only; UI never sees plaintext.
- Providers mapped (service, account):
  - openai -> (uicp, openai:api_key) ->  `Authorization: Bearer <key>`
  - anthropic -> (uicp, anthropic:api_key) ->  `x-api-key: <key>`
  - openrouter -> (uicp, openrouter:api_key) ->  `Authorization: Bearer <key>`, `X-Title: UICP`
  - ollama -> (uicp, ollama:api_key) ->  `Authorization: Bearer <key>`

Notes
- Health/login stubs are covered by tests in uicp/src-tauri/src/provider_cli.rs.
- For local development without CLI installs, use environment overrides to point to test stubs.


- Proxy helpers are optional; some proxy commands are not exposed in the backend and are ignored by the UI when unavailable.



