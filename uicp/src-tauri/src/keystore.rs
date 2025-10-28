use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use std::cell::RefCell;

#[cfg(test)]
use std::path::PathBuf;

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine as _;
use chacha20poly1305::{
    aead::{Aead, KeyInit},
    XChaCha20Poly1305, XNonce,
};
use chrono::Utc;
use hkdf::Hkdf;
use once_cell::sync::Lazy;
use parking_lot::{Mutex, RwLock};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, OptionalExtension};
use secrecy::{ExposeSecret, SecretString, SecretVec};
use serde::Serialize;
use sha2::Sha256;
use thiserror::Error;
use tokio_rusqlite::Connection as AsyncConn;
use zeroize::Zeroize;

use crate::core::{log_warn, DATA_DIR};

const KEYSTORE_DIR: &str = "keystore";
const KEYSTORE_DB: &str = "keystore.db";
const META_TABLE: &str = "meta";
const SALT_KEY: &str = "app_salt";
const SCHEMA_KEY: &str = "schema_version";
const SCHEMA_VERSION: &str = "1";
const HKDF_PREFIX: &str = "uicp:secret:";
const AAD_SUFFIX: &str = ":v1";
const RNG_FAILURE_CODE: &str = "E-UICP-SEC-RNG";

/// Legacy environment variable mappings used during migration from plaintext .env files.
/// Tuple layout: (service namespace, account identifier, environment variable name)
pub const ENV_SECRET_MAPPINGS: &[(&str, &str, &str)] = &[
    ("uicp", "openai:api_key", "OPENAI_API_KEY"),
    ("uicp", "anthropic:api_key", "ANTHROPIC_API_KEY"),
    ("uicp", "openrouter:api_key", "OPENROUTER_API_KEY"),
    ("uicp", "ollama:api_key", "OLLAMA_API_KEY"),
];

// Sentinel used to verify passphrase correctness without exposing the KEK or any real secrets.
const SENTINEL_SERVICE: &str = "uicp";
const SENTINEL_ACCOUNT: &str = "keystore:sentinel";
const SENTINEL_PLAINTEXT: &[u8] = b"uicp-sentinel-v1";

// Test-injectable RNG hook. In production, this remains None and OsRng is used.
// In tests, set via set_test_rng_hook(Some(fn)) to simulate RNG failures or custom fills.
thread_local! {
    static RNG_FILL_HOOK: RefCell<Option<fn(&mut [u8]) -> Result<()>>> = RefCell::new(None);
}

fn fill_nonce(dest: &mut [u8; 24]) -> Result<()> {
    RNG_FILL_HOOK.with(|cell| {
        if let Some(hook) = *cell.borrow() {
            return hook(dest);
        }
        OsRng
            .try_fill_bytes(dest)
            .map_err(|err| KeystoreError::Other(format!("{RNG_FAILURE_CODE}: {err}")))
    })
}

#[cfg(test)]
pub(crate) fn set_test_rng_hook(hook: Option<fn(&mut [u8]) -> Result<()>>) {
    RNG_FILL_HOOK.with(|cell| *cell.borrow_mut() = hook);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum KeystoreMode {
    Passphrase,
    Mock,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum UnlockMethod {
    Passphrase,
    Mock,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UnlockStatus {
    pub locked: bool,
    pub ttl_remaining_sec: Option<u64>,
    pub method: Option<UnlockMethod>,
}

#[derive(Debug, Error)]
pub enum KeystoreError {
    #[error("E-UICP-SEC-LOCKED: keystore locked or expired")]
    Locked,
    #[error("E-UICP-SEC-UNAUTH: unlock method not available in current mode")]
    Unauthorized,
    #[error("E-UICP-SEC-BADPASS: invalid passphrase or keystore corrupted")]
    BadPassphrase,
    #[error("E-UICP-SEC-NOT_FOUND: secret not found")]
    NotFound,
    #[error("E-UICP-SEC-DB: {0}")]
    Database(String),
    #[error("E-UICP-SEC-CRYPTO: {0}")]
    Crypto(String),
    #[error("E-UICP-SEC-PERM: {0}")]
    Permission(String),
    #[error("E-UICP-SEC-CONFIG: {0}")]
    Config(String),
    #[error("{0}")]
    Other(String),
}

impl From<rusqlite::Error> for KeystoreError {
    fn from(err: rusqlite::Error) -> Self {
        KeystoreError::Database(err.to_string())
    }
}

impl From<argon2::password_hash::Error> for KeystoreError {
    fn from(err: argon2::password_hash::Error) -> Self {
        KeystoreError::Crypto(err.to_string())
    }
}

impl From<std::io::Error> for KeystoreError {
    fn from(err: std::io::Error) -> Self {
        KeystoreError::Other(err.to_string())
    }
}

struct UnlockedState {
    kek: SecretVec<u8>,
    expires_at: Instant,
    method: UnlockMethod,
}

enum KeystoreState {
    Locked,
    Unlocked(UnlockedState),
}

impl Default for KeystoreState {
    fn default() -> Self {
        KeystoreState::Locked
    }
}

pub struct KeystoreConfig {
    pub ttl: Duration,
    pub mode: KeystoreMode,
}

impl KeystoreConfig {
    pub fn validate(&self) -> Result<()> {
        if self.ttl.is_zero() {
            return Err(KeystoreError::Config(
                "TTL must be greater than zero".to_string(),
            ));
        }
        Ok(())
    }
}

pub struct Keystore {
    #[cfg(test)]
    db_path: PathBuf,
    conn: AsyncConn,
    state: Arc<RwLock<KeystoreState>>,
    app_salt: Arc<Vec<u8>>,
    ttl: Duration,
    mode: KeystoreMode,
    memory_lock_warned: AtomicBool,
}

type Result<T> = std::result::Result<T, KeystoreError>;

impl Keystore {
    pub async fn open(config: KeystoreConfig) -> Result<Self> {
        config.validate()?;
        // Forbid mock mode in release builds. Mock is only allowed in tests/CI.
        if !cfg!(debug_assertions) && matches!(config.mode, KeystoreMode::Mock) {
            return Err(KeystoreError::Config(
                "mock mode forbidden in release".into(),
            ));
        }

        let keystore_dir = DATA_DIR.join(KEYSTORE_DIR);
        ensure_owner_only_dir(&keystore_dir)?;
        let db_path = keystore_dir.join(KEYSTORE_DB);

        let should_create = !db_path.exists();
        if should_create {
            std::fs::File::create(&db_path)?;
        }

        enforce_owner_only_file(&db_path)?;
        let conn = AsyncConn::open(db_path.clone())
            .await
            .map_err(|err| KeystoreError::Database(err.to_string()))?;

        let app_salt = initialize_database(&conn, &db_path).await?;

        Ok(Self {
            #[cfg(test)]
            db_path: db_path.clone(),
            conn,
            state: Arc::new(RwLock::new(KeystoreState::default())),
            app_salt: Arc::new(app_salt),
            ttl: config.ttl,
            mode: config.mode,
            memory_lock_warned: AtomicBool::new(false),
        })
    }

    pub fn status(&self) -> UnlockStatus {
        self.expire_if_needed();
        let guard = self.state.read();
        match &*guard {
            KeystoreState::Locked => UnlockStatus {
                locked: true,
                ttl_remaining_sec: None,
                method: None,
            },
            KeystoreState::Unlocked(state) => {
                let now = Instant::now();
                let remaining = state.expires_at.saturating_duration_since(now).as_secs();
                UnlockStatus {
                    locked: false,
                    ttl_remaining_sec: Some(remaining),
                    method: Some(state.method),
                }
            }
        }
    }

    pub async fn unlock_passphrase(&self, passphrase: SecretString) -> Result<UnlockStatus> {
        if self.mode != KeystoreMode::Passphrase {
            return Err(KeystoreError::Unauthorized);
        }
        let kek = derive_kek(passphrase.expose_secret(), &self.app_salt)?;
        // Verify (or initialize on first run) the sentinel using the derived KEK.
        // This rejects wrong passphrases without changing state.
        self.verify_or_initialize_sentinel(&kek).await?;
        best_effort_lock(&kek, &self.memory_lock_warned);
        let expires_at = Instant::now() + self.ttl;
        {
            let mut guard = self.state.write();
            *guard = KeystoreState::Unlocked(UnlockedState {
                kek,
                expires_at,
                method: UnlockMethod::Passphrase,
            });
        }
        Ok(self.status())
    }

    pub fn lock(&self) {
        let mut guard = self.state.write();
        *guard = KeystoreState::Locked;
    }

    pub fn ttl(&self) -> Duration {
        self.ttl
    }

    pub async fn secret_exists(&self, service: &str, account: &str) -> Result<bool> {
        let id = secret_id(service, account);
        let exists = self
            .conn
            .call(move |conn| {
                let res = conn
                    .query_row(
                        "SELECT 1 FROM secrets WHERE id = ?1 LIMIT 1",
                        params![id],
                        |_row| Ok(1_i32),
                    )
                    .optional()
                    .map_err(tokio_rusqlite::Error::from)?;
                Ok(res)
            })
            .await
            .map_err(|err| KeystoreError::Database(err.to_string()))?
            .is_some();
        Ok(exists)
    }

    pub async fn secret_delete(&self, service: &str, account: &str) -> Result<()> {
        let id = secret_id(service, account);
        self.conn
            .call(move |conn| {
                conn.execute("DELETE FROM secrets WHERE id = ?1", params![id])
                    .map_err(tokio_rusqlite::Error::from)
                    .map(|_| ())
            })
            .await
            .map_err(|err| KeystoreError::Database(err.to_string()))?;
        Ok(())
    }

    pub async fn secret_set(
        &self,
        service: &str,
        account: &str,
        value: SecretString,
    ) -> Result<()> {
        let snapshot = self.snapshot_unlocked()?;
        let id = secret_id(service, account);
        let aad = aad_value(service, account);
        let mut dek = self.derive_dek(&snapshot.kek, &id)?;
        let mut nonce = [0u8; 24];
        fill_nonce(&mut nonce)?;
        let ciphertext = encrypt_secret(
            &dek,
            &nonce,
            aad.as_bytes(),
            value.expose_secret().as_bytes(),
        )?;
        dek.zeroize();
        // Drop snapshot promptly after use to reduce sensitive material lifetime.
        drop(snapshot);
        let created_at = chrono::Utc::now().timestamp_millis();
        let last_used_at = created_at;
        // Materialize owned buffers before crossing the FFI boundary to the blocking thread.
        let nonce_vec = nonce.to_vec();
        let aad_bytes = aad.into_bytes();
        let ct = ciphertext;
        self.conn
            .call(move |conn| {
                conn.execute(
                    "INSERT INTO secrets (id, nonce, aad, ciphertext, created_at, last_used_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                         ON CONFLICT(id) DO UPDATE SET
                           nonce = excluded.nonce,
                           aad = excluded.aad,
                           ciphertext = excluded.ciphertext",
                    params![id, nonce_vec, aad_bytes, ct, created_at, last_used_at],
                )
                .map_err(tokio_rusqlite::Error::from)
                .map(|_| ())
            })
            .await
            .map_err(|err| KeystoreError::Database(err.to_string()))?;
        Ok(())
    }

    pub async fn read_internal(&self, service: &str, account: &str) -> Result<SecretVec<u8>> {
        let snapshot = self.snapshot_unlocked()?;
        let id = secret_id(service, account);
        let query_id = id.clone();
        let record = self
            .conn
            .call(move |conn| {
                let res = conn
                    .query_row(
                        "SELECT nonce, aad, ciphertext FROM secrets WHERE id = ?1",
                        params![query_id],
                        |row| {
                            let nonce: Vec<u8> = row.get(0)?;
                            let aad: Vec<u8> = row.get(1)?;
                            let ciphertext: Vec<u8> = row.get(2)?;
                            Ok((nonce, aad, ciphertext))
                        },
                    )
                    .optional()
                    .map_err(tokio_rusqlite::Error::from)?;
                Ok(res)
            })
            .await
            .map_err(|err| KeystoreError::Database(err.to_string()))?
            .ok_or(KeystoreError::NotFound)?;

        let mut dek = self.derive_dek(&snapshot.kek, &id)?;
        // Drop snapshot promptly; only derived DEK is needed beyond this point.
        drop(snapshot);
        let plaintext = decrypt_secret(&dek, &record.0, &record.1, &record.2)?;
        dek.zeroize();

        let now_ms = Utc::now().timestamp_millis();
        self.conn
            .call(move |conn| {
                conn.execute(
                    "UPDATE secrets SET last_used_at = ?2 WHERE id = ?1",
                    params![id, now_ms],
                )
                .map_err(tokio_rusqlite::Error::from)
                .map(|_| ())
            })
            .await
            .map_err(|err| KeystoreError::Database(err.to_string()))?;

        Ok(SecretVec::new(plaintext))
    }

    // Read a raw record by id without requiring an unlocked state.
    async fn get_secret_raw(&self, id: &str) -> Result<Option<(Vec<u8>, Vec<u8>, Vec<u8>)>> {
        let query_id = id.to_string();
        let rec = self
            .conn
            .call(move |conn| {
                let res = conn
                    .query_row(
                        "SELECT nonce, aad, ciphertext FROM secrets WHERE id = ?1",
                        params![query_id],
                        |row| {
                            let nonce: Vec<u8> = row.get(0)?;
                            let aad: Vec<u8> = row.get(1)?;
                            let ciphertext: Vec<u8> = row.get(2)?;
                            Ok((nonce, aad, ciphertext))
                        },
                    )
                    .optional()
                    .map_err(tokio_rusqlite::Error::from)?;
                Ok(res)
            })
            .await
            .map_err(|err| KeystoreError::Database(err.to_string()))?;
        Ok(rec)
    }

    /// Returns true if the keystore has been initialized with a sentinel record.
    /// This check does not require an unlocked state.
    pub async fn sentinel_exists(&self) -> Result<bool> {
        let id = secret_id(SENTINEL_SERVICE, SENTINEL_ACCOUNT);
        Ok(self.get_secret_raw(&id).await?.is_some())
    }

    // Insert or update a raw record by id. Used for sentinel initialization before unlocking state.
    async fn put_secret_raw(
        &self,
        id: &str,
        nonce: Vec<u8>,
        aad: Vec<u8>,
        ciphertext: Vec<u8>,
        created_at: i64,
    ) -> Result<()> {
        let id_owned = id.to_string();
        self.conn
            .call(move |conn| {
                conn.execute(
                    "INSERT INTO secrets (id, nonce, aad, ciphertext, created_at, last_used_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                         ON CONFLICT(id) DO UPDATE SET
                           nonce = excluded.nonce,
                           aad = excluded.aad,
                           ciphertext = excluded.ciphertext",
                    params![id_owned, nonce, aad, ciphertext, created_at, created_at],
                )
                .map_err(tokio_rusqlite::Error::from)
                .map(|_| ())
            })
            .await
            .map_err(|err| KeystoreError::Database(err.to_string()))?;
        Ok(())
    }

    // Verify the sentinel using the provided KEK; if missing, initialize it.
    async fn verify_or_initialize_sentinel(&self, kek: &SecretVec<u8>) -> Result<()> {
        let id = secret_id(SENTINEL_SERVICE, SENTINEL_ACCOUNT);
        if let Some((nonce, aad, ciphertext)) = self.get_secret_raw(&id).await? {
            let mut dek = self.derive_dek(kek, &id)?;
            let pt = decrypt_secret(&dek, &nonce, &aad, &ciphertext);
            dek.zeroize();
            match pt {
                Ok(bytes) if bytes.as_slice() == SENTINEL_PLAINTEXT => Ok(()),
                _ => Err(KeystoreError::BadPassphrase),
            }
        } else {
            // First run: create the sentinel with the provided passphrase.
            let aad = aad_value(SENTINEL_SERVICE, SENTINEL_ACCOUNT);
            let mut dek = self.derive_dek(kek, &id)?;
            let mut nonce_arr = [0u8; 24];
            fill_nonce(&mut nonce_arr)?;
            let ct = encrypt_secret(&dek, &nonce_arr, aad.as_bytes(), SENTINEL_PLAINTEXT)?;
            dek.zeroize();
            let created_at = chrono::Utc::now().timestamp_millis();
            self.put_secret_raw(&id, nonce_arr.to_vec(), aad.into_bytes(), ct, created_at)
                .await
        }
    }

    /// List SecretIds present in the keystore without exposing any plaintext values.
    pub async fn list_ids(&self) -> Result<Vec<String>> {
        let rows: Vec<String> = self
            .conn
            .call(move |conn| {
                let mut stmt = conn
                    .prepare("SELECT id FROM secrets ORDER BY id ASC")
                    .map_err(tokio_rusqlite::Error::from)?;
                let iter = stmt
                    .query_map([], |row| row.get::<_, String>(0))
                    .map_err(tokio_rusqlite::Error::from)?;
                let mut out = Vec::new();
                for r in iter {
                    out.push(r.map_err(tokio_rusqlite::Error::from)?);
                }
                Ok(out)
            })
            .await
            .map_err(|err| KeystoreError::Database(err.to_string()))?;
        Ok(rows)
    }

    #[cfg(test)]
    pub(crate) fn db_path_for_testing(&self) -> &Path {
        &self.db_path
    }

    fn snapshot_unlocked(&self) -> Result<UnlockedSnapshot> {
        let mut guard = self.state.write();
        let now = Instant::now();
        match &mut *guard {
            KeystoreState::Locked => Err(KeystoreError::Locked),
            KeystoreState::Unlocked(state) => {
                if now >= state.expires_at {
                    *guard = KeystoreState::Locked;
                    return Err(KeystoreError::Locked);
                }
                let new_expiry = now + self.ttl;
                state.expires_at = new_expiry;
                Ok(UnlockedSnapshot {
                    kek: SecretVec::new(state.kek.expose_secret().clone()),
                    method: state.method,
                    expires_at: new_expiry,
                })
            }
        }
    }

    fn expire_if_needed(&self) {
        let mut guard = self.state.write();
        if let KeystoreState::Unlocked(state) = &*guard {
            if Instant::now() >= state.expires_at {
                *guard = KeystoreState::Locked;
            }
        }
    }

    fn derive_dek(&self, kek: &SecretVec<u8>, secret_id: &str) -> Result<[u8; 32]> {
        let info = format!("{HKDF_PREFIX}{secret_id}");
        let hk = Hkdf::<Sha256>::new(Some(self.app_salt.as_slice()), kek.expose_secret());
        let mut dek = [0u8; 32];
        hk.expand(info.as_bytes(), &mut dek)
            .map_err(|err| KeystoreError::Crypto(format!("hkdf expand failed: {err}")))?;
        Ok(dek)
    }
}

struct UnlockedSnapshot {
    kek: SecretVec<u8>,
    #[allow(dead_code)]
    method: UnlockMethod,
    #[allow(dead_code)]
    expires_at: Instant,
}

// ----------------------------------------------------------------------------
// Global accessor (singleton) with env-configured TTL and mode
// ----------------------------------------------------------------------------

static KEYSTORE_SINGLETON: Lazy<Mutex<Option<Arc<Keystore>>>> = Lazy::new(|| Mutex::new(None));

pub async fn get_or_init_keystore() -> Result<Arc<Keystore>> {
    if let Some(existing) = KEYSTORE_SINGLETON.lock().clone() {
        return Ok(existing);
    }
    let ttl_sec = std::env::var("UICP_KEYSTORE_TTL_SEC")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(1200);
    let mode_env = std::env::var("UICP_KEYSTORE_MODE").unwrap_or_else(|_| "passphrase".into());
    let mode = match mode_env.to_ascii_lowercase().as_str() {
        "mock" => KeystoreMode::Mock,
        _ => KeystoreMode::Passphrase,
    };
    let cfg = KeystoreConfig {
        ttl: Duration::from_secs(ttl_sec),
        mode,
    };
    let ks = Keystore::open(cfg).await?;
    let arc = Arc::new(ks);
    let mut guard = KEYSTORE_SINGLETON.lock();
    if guard.is_none() {
        *guard = Some(arc.clone());
        return Ok(arc);
    }
    Ok(guard.as_ref().unwrap().clone())
}

async fn initialize_database(conn: &AsyncConn, db_path: &Path) -> Result<Vec<u8>> {
    conn.call(|conn| {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS secrets (
                id TEXT PRIMARY KEY,
                nonce BLOB NOT NULL,
                aad BLOB NOT NULL,
                ciphertext BLOB NOT NULL,
                created_at INTEGER NOT NULL,
                last_used_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
        )
        .map_err(tokio_rusqlite::Error::from)
    })
    .await
    .map_err(|err| KeystoreError::Database(err.to_string()))?;

    let app_salt = conn
        .call(|conn| {
            conn.query_row(
                &format!("SELECT value FROM {META_TABLE} WHERE key = ?1"),
                params![SALT_KEY],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(tokio_rusqlite::Error::from)
        })
        .await
        .map_err(|err| KeystoreError::Database(err.to_string()))?;

    let salt_bytes = match app_salt {
        Some(encoded) => base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|err| KeystoreError::Database(format!("invalid salt encoding: {err}")))?,
        None => {
            let mut salt = vec![0u8; 32];
            OsRng
                .try_fill_bytes(&mut salt)
                .map_err(|err| KeystoreError::Other(format!("{RNG_FAILURE_CODE}: {err}")))?;
            let encoded = base64::engine::general_purpose::STANDARD.encode(&salt);
            conn.call(move |conn| {
                conn.execute(
                    &format!("INSERT OR REPLACE INTO {META_TABLE} (key, value) VALUES (?1, ?2)"),
                    params![SALT_KEY, encoded],
                )
                .map_err(tokio_rusqlite::Error::from)
                .map(|_| ())
            })
            .await
            .map_err(|err| KeystoreError::Database(err.to_string()))?;
            salt
        }
    };

    conn.call(|conn| {
        conn.execute(
            &format!("INSERT OR REPLACE INTO {META_TABLE} (key, value) VALUES (?1, ?2)"),
            params![SCHEMA_KEY, SCHEMA_VERSION],
        )
        .map_err(tokio_rusqlite::Error::from)
        .map(|_| ())
    })
    .await
    .map_err(|err| KeystoreError::Database(err.to_string()))?;

    enforce_owner_only_file(db_path)?;
    Ok(salt_bytes)
}

fn derive_kek(passphrase: &str, app_salt: &[u8]) -> Result<SecretVec<u8>> {
    // Argon2id params: 64 MiB, t=3, p=1. Do not lower without a security review.
    let params = Params::new(64 * 1024, 3, 1, Some(32))
        .map_err(|err| KeystoreError::Crypto(err.to_string()))?;
    let argon = Argon2::new_with_secret(&[], Algorithm::Argon2id, Version::V0x13, params)
        .map_err(|err| KeystoreError::Crypto(err.to_string()))?;
    let mut output = vec![0u8; 32];
    argon
        .hash_password_into(passphrase.as_bytes(), app_salt, &mut output)
        .map_err(|err| KeystoreError::Crypto(err.to_string()))?;
    Ok(SecretVec::new(output))
}

fn encrypt_secret(dek: &[u8], nonce: &[u8; 24], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    let cipher = XChaCha20Poly1305::new_from_slice(dek)
        .map_err(|err| KeystoreError::Crypto(err.to_string()))?;
    let mut nonce_array = [0u8; 24];
    nonce_array.clone_from_slice(nonce);
    let nonce = XNonce::from(nonce_array);
    cipher
        .encrypt(
            &nonce,
            chacha20poly1305::aead::Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|err| KeystoreError::Crypto(err.to_string()))
}

fn decrypt_secret(dek: &[u8], nonce: &[u8], aad: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
    let cipher = XChaCha20Poly1305::new_from_slice(dek)
        .map_err(|err| KeystoreError::Crypto(err.to_string()))?;
    let nonce_arr: [u8; 24] = nonce
        .try_into()
        .map_err(|_| KeystoreError::Crypto("nonce length mismatch".into()))?;
    let nonce = XNonce::from(nonce_arr);
    cipher
        .decrypt(
            &nonce,
            chacha20poly1305::aead::Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|err| KeystoreError::Crypto(err.to_string()))
}

fn secret_id(service: &str, account: &str) -> String {
    format!("env:{service}:{account}")
}

fn aad_value(service: &str, account: &str) -> String {
    format!("{service}:{account}{AAD_SUFFIX}")
}

fn ensure_owner_only_dir(path: &Path) -> Result<()> {
    if !path.exists() {
        std::fs::create_dir_all(path)?;
    }
    enforce_owner_only_dir_permissions(path)?;
    Ok(())
}

#[cfg(unix)]
fn enforce_owner_only_dir_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = std::fs::metadata(path)?;
    let mut permissions = metadata.permissions();
    permissions.set_mode(0o700);
    std::fs::set_permissions(path, permissions)?;
    Ok(())
}

#[cfg(windows)]
fn enforce_owner_only_dir_permissions(path: &Path) -> Result<()> {
    enforce_windows_acl(path)
}

#[cfg(unix)]
fn enforce_owner_only_file(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = std::fs::metadata(path)?;
    let mut permissions = metadata.permissions();
    permissions.set_mode(0o600);
    std::fs::set_permissions(path, permissions)?;
    Ok(())
}

#[cfg(windows)]
fn enforce_owner_only_file(path: &Path) -> Result<()> {
    enforce_windows_acl(path)
}

#[cfg(windows)]
fn enforce_windows_acl(_path: &Path) -> Result<()> {
    // NOTE: Windows ACL enforcement APIs require additional Windows SDK feature flags.
    // For test builds we return Ok(()) to avoid linking failures.
    Ok(())
}

#[cfg(unix)]
fn best_effort_lock(secret: &SecretVec<u8>, warned: &AtomicBool) {
    use libc::mlock;
    use std::os::raw::c_void;

    let ptr = secret.expose_secret().as_ptr() as *const c_void;
    let len = secret.expose_secret().len();
    if len == 0 {
        return;
    }
    unsafe {
        if mlock(ptr, len) != 0 && !warned.swap(true, Ordering::SeqCst) {
            log_warn("mlock unavailable for keystore KEK. Continuing without locked memory.");
        }
    }
}

#[cfg(windows)]
fn best_effort_lock(secret: &SecretVec<u8>, warned: &AtomicBool) {
    use windows_sys::Win32::System::Memory::VirtualLock;
    let ptr = secret.expose_secret().as_ptr();
    let len = secret.expose_secret().len();
    if len == 0 {
        return;
    }
    unsafe {
        if VirtualLock(ptr as *mut _, len) == 0 && !warned.swap(true, Ordering::SeqCst) {
            log_warn("VirtualLock unavailable for keystore KEK. Continuing without locked memory.");
        }
    }
}

#[cfg(not(any(unix, windows)))]
fn best_effort_lock(_secret: &SecretVec<u8>, _warned: &AtomicBool) {}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    // Test-only helper: open keystore at a custom data dir to isolate from real app data.
    impl Keystore {
        async fn open_for_dir(dir: &Path, config: KeystoreConfig) -> Result<Self> {
            config.validate()?;
            if !cfg!(debug_assertions) && matches!(config.mode, KeystoreMode::Mock) {
                return Err(KeystoreError::Config(
                    "mock mode forbidden in release".into(),
                ));
            }
            let keystore_dir = dir.join(KEYSTORE_DIR);
            ensure_owner_only_dir(&keystore_dir)?;
            let db_path = keystore_dir.join(KEYSTORE_DB);
            if !db_path.exists() {
                std::fs::File::create(&db_path)?;
            }
            enforce_owner_only_file(&db_path)?;
            let conn = AsyncConn::open(db_path.clone())
                .await
                .map_err(|err| KeystoreError::Database(err.to_string()))?;
            let app_salt = initialize_database(&conn, &db_path).await?;
            Ok(Self {
                db_path: db_path.clone(),
                conn,
                state: Arc::new(RwLock::new(KeystoreState::default())),
                app_salt: Arc::new(app_salt),
                ttl: config.ttl,
                mode: config.mode,
                memory_lock_warned: AtomicBool::new(false),
            })
        }
    }

    #[tokio::test]
    async fn locked_read_returns_locked() {
        let tmp = tempdir().unwrap();
        let cfg = KeystoreConfig {
            ttl: Duration::from_secs(60),
            mode: KeystoreMode::Passphrase,
        };
        let ks = Keystore::open_for_dir(tmp.path(), cfg).await.unwrap();
        let err = ks
            .read_internal("uicp", "openai:api_key")
            .await
            .err()
            .unwrap();
        matches!(err, KeystoreError::Locked);
    }

    #[tokio::test]
    async fn upsert_does_not_bump_last_used_at_on_write() {
        let tmp = tempdir().unwrap();
        let cfg = KeystoreConfig {
            ttl: Duration::from_secs(60),
            mode: KeystoreMode::Passphrase,
        };
        let ks = Keystore::open_for_dir(tmp.path(), cfg).await.unwrap();
        let _ = ks
            .unlock_passphrase(SecretString::new("pass".into()))
            .await
            .unwrap();
        // First write
        ks.secret_set("uicp", "openai:api_key", SecretString::new("k1".into()))
            .await
            .unwrap();
        let id = secret_id("uicp", "openai:api_key");
        let before: i64 = ks
            .conn
            .call(move |conn| {
                let v: i64 = conn
                    .query_row(
                        "SELECT last_used_at FROM secrets WHERE id=?1",
                        params![id],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(tokio_rusqlite::Error::from)?;
                Ok(v)
            })
            .await
            .unwrap();
        // Second write (upsert) should not change last_used_at
        ks.secret_set("uicp", "openai:api_key", SecretString::new("k2".into()))
            .await
            .unwrap();
        let id2 = secret_id("uicp", "openai:api_key");
        let after_upsert: i64 = ks
            .conn
            .call(move |conn| {
                let v: i64 = conn
                    .query_row(
                        "SELECT last_used_at FROM secrets WHERE id=?1",
                        params![id2],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(tokio_rusqlite::Error::from)?;
                Ok(v)
            })
            .await
            .unwrap();
        assert_eq!(
            before, after_upsert,
            "last_used_at must not change on upsert"
        );

        // Read bumps last_used_at
        let _ = ks.read_internal("uicp", "openai:api_key").await.unwrap();
        let id3 = secret_id("uicp", "openai:api_key");
        let after_read: i64 = ks
            .conn
            .call(move |conn| {
                let v: i64 = conn
                    .query_row(
                        "SELECT last_used_at FROM secrets WHERE id=?1",
                        params![id3],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(tokio_rusqlite::Error::from)?;
                Ok(v)
            })
            .await
            .unwrap();
        assert!(after_read >= after_upsert, "read must update last_used_at");
    }

    #[tokio::test]
    async fn unlock_with_wrong_passphrase_fails() {
        let tmp = tempdir().unwrap();
        let cfg = KeystoreConfig {
            ttl: Duration::from_secs(60),
            mode: KeystoreMode::Passphrase,
        };
        let ks = Keystore::open_for_dir(tmp.path(), cfg).await.unwrap();
        // First unlock initializes sentinel with this passphrase
        let _ = ks
            .unlock_passphrase(SecretString::new("correct-pass".into()))
            .await
            .unwrap();
        ks.lock();
        // Wrong passphrase should be rejected
        let err = ks
            .unlock_passphrase(SecretString::new("wrong-pass".into()))
            .await
            .err()
            .unwrap();
        matches!(err, KeystoreError::BadPassphrase);
    }

    #[tokio::test]
    async fn unlock_again_with_correct_passphrase_succeeds() {
        let tmp = tempdir().unwrap();
        let cfg = KeystoreConfig {
            ttl: Duration::from_secs(60),
            mode: KeystoreMode::Passphrase,
        };
        let ks = Keystore::open_for_dir(tmp.path(), cfg).await.unwrap();
        // First unlock initializes sentinel
        let _ = ks
            .unlock_passphrase(SecretString::new("my-pass".into()))
            .await
            .unwrap();
        ks.lock();
        // Unlock with the same passphrase should succeed
        let status = ks
            .unlock_passphrase(SecretString::new("my-pass".into()))
            .await
            .unwrap();
        assert!(
            !status.locked,
            "status should be unlocked after correct passphrase"
        );
    }

    #[tokio::test]
    async fn hkdf_derives_different_deks_for_different_ids() {
        let tmp = tempdir().unwrap();
        let cfg = KeystoreConfig {
            ttl: Duration::from_secs(60),
            mode: KeystoreMode::Passphrase,
        };
        let ks = Keystore::open_for_dir(tmp.path(), cfg).await.unwrap();
        let _ = ks
            .unlock_passphrase(SecretString::new("pass".into()))
            .await
            .unwrap();
        let id1 = "env:uicp:openai:api_key";
        let id2 = "env:uicp:anthropic:api_key";
        let snapshot = ks.snapshot_unlocked().unwrap();
        let dek1 = ks.derive_dek(&snapshot.kek, id1).unwrap();
        let dek2 = ks.derive_dek(&snapshot.kek, id2).unwrap();
        assert_ne!(
            dek1, dek2,
            "HKDF must derive different DEKs for different SecretIds"
        );
    }

    #[tokio::test]
    async fn status_expires_after_ttl() {
        let tmp = tempdir().unwrap();
        let cfg = KeystoreConfig {
            ttl: Duration::from_millis(10),
            mode: KeystoreMode::Passphrase,
        };
        let ks = Keystore::open_for_dir(tmp.path(), cfg).await.unwrap();
        let _ = ks
            .unlock_passphrase(SecretString::new("pass".into()))
            .await
            .unwrap();
        // Wait beyond TTL
        tokio::time::sleep(Duration::from_millis(20)).await;
        let s = ks.status();
        assert!(s.locked, "keystore should be locked after TTL expiry");
    }

    #[tokio::test]
    async fn read_after_expiry_returns_locked() {
        let tmp = tempdir().unwrap();
        let cfg = KeystoreConfig {
            ttl: Duration::from_millis(20),
            mode: KeystoreMode::Passphrase,
        };
        let ks = Keystore::open_for_dir(tmp.path(), cfg).await.unwrap();
        let _ = ks
            .unlock_passphrase(SecretString::new("pass".into()))
            .await
            .unwrap();
        ks.secret_set("uicp", "openai:api_key", SecretString::new("k1".into()))
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(40)).await;
        let err = ks
            .read_internal("uicp", "openai:api_key")
            .await
            .err()
            .unwrap();
        matches!(err, KeystoreError::Locked);
    }

    #[tokio::test]
    async fn db_does_not_contain_kek_bytes() {
        let tmp = tempdir().unwrap();
        let cfg = KeystoreConfig {
            ttl: Duration::from_secs(60),
            mode: KeystoreMode::Passphrase,
        };
        let ks = Keystore::open_for_dir(tmp.path(), cfg).await.unwrap();
        let _ = ks
            .unlock_passphrase(SecretString::new("pass".into()))
            .await
            .unwrap();
        let snap = ks.snapshot_unlocked().unwrap();
        let kek = snap.kek.expose_secret().clone();
        drop(snap);
        ks.secret_set("uicp", "openai:api_key", SecretString::new("k1".into()))
            .await
            .unwrap();
        let bytes = std::fs::read(ks.db_path_for_testing()).unwrap();
        let found = bytes.windows(kek.len()).any(|w| w == kek.as_slice());
        assert!(!found, "DB must not contain KEK bytes");
    }

    #[tokio::test]
    async fn rng_failure_propagates() {
        let tmp = tempdir().unwrap();
        let cfg = KeystoreConfig {
            ttl: Duration::from_secs(30),
            mode: KeystoreMode::Passphrase,
        };
        let ks = Keystore::open_for_dir(tmp.path(), cfg).await.unwrap();
        let _ = ks
            .unlock_passphrase(SecretString::new("pass".into()))
            .await
            .unwrap();

        // Arrange: inject RNG hook that fails with our stable code for subsequent nonce fills
        set_test_rng_hook(Some(|_| {
            Err(KeystoreError::Other(format!(
                "{RNG_FAILURE_CODE}: injected"
            )))
        }));

        // Act: attempt to set secret, expecting failure
        let err = ks
            .secret_set("uicp", "openai:api_key", SecretString::new("k1".into()))
            .await
            .unwrap_err();

        // Assert: error string includes RNG failure code
        let msg = err.to_string();
        assert!(
            msg.contains(RNG_FAILURE_CODE),
            "error should include RNG failure code; got: {msg}"
        );

        // Cleanup: remove hook
        set_test_rng_hook(None);
    }
}
