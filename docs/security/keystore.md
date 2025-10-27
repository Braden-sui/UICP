# Keystore (Embedded)

Last updated: 2025-10-26

Purpose: describe the desktop's embedded keystore used for provider API keys. Plaintext keys never leave the backend; the UI cannot read secrets once stored.

Implementation
- Location: `uicp/src-tauri/src/keystore.rs`
- DB path: `<app_data_dir>/keystore/keystore.db`
- Schema: `secrets(id TEXT PRIMARY KEY, nonce BLOB, aad BLOB, ciphertext BLOB, created_at INTEGER, last_used_at INTEGER)`

Operations
- Unlock: passphrase-based; initializes or verifies a sentinel record.
- Set: `secret_set(service, account, value)` writes or updates an encrypted record.
- Read (internal): `read_internal(service, account)` returns a SecretVec<u8> (backend only).
- Delete: `secret_delete(service, account)` removes a record.
- List: `list_ids()` returns ids without exposing plaintext.

Security
- KEK: derived with Argon2id (64 MiB, t=3, p=1) from passphrase + app salt.
- DEK per secret: HKDF(SHA-256) with info `uicp:secret:<secret_id>`.
- AEAD: XChaCha20-Poly1305 using per-record 24-byte nonces and AAD `"<service>:<account>:v1"`.
- Memory hygiene: best-effort VirtualLock/mlock where available; secrets zeroized after use.

Environment
- `UICP_KEYSTORE_TTL_SEC` (default 1200): unlock TTL; extends on access.
- `UICP_KEYSTORE_MODE` (default `passphrase`): `passphrase` or `mock` (tests/dev only).

Providers
- See `uicp/src-tauri/src/providers.rs` for header construction. Mapping:
  - openai -> `Authorization: Bearer <key>`
  - anthropic -> `x-api-key: <key>`
  - openrouter -> `Authorization: Bearer <key>`, `X-Title: UICP`
  - ollama -> `Authorization: Bearer <key>`

Notes
- There is no automatic migration from `.env` to the keystore. Any previously documented migration is not active.
- Tauri commands do not expose plaintext secrets. `load_api_key` returns `null`.
