use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use crate::action_log;
use anyhow::Context;
use chrono::Utc;
use dirs::data_dir;
use once_cell::sync::Lazy;
use reqwest::Client;
use rusqlite::{params, Connection, OptionalExtension};
use tauri::{async_runtime::JoinHandle, Emitter, Manager, Runtime, State};
use tokio::sync::{RwLock, Semaphore};
use tokio_rusqlite::Connection as AsyncConn;

// ----------------------------------------------------------------------------
// Constants and paths
// ----------------------------------------------------------------------------

pub static APP_NAME: &str = "UICP";
pub static OLLAMA_CLOUD_HOST_DEFAULT: &str = "https://ollama.com";
pub static OLLAMA_LOCAL_BASE_DEFAULT: &str = "http://127.0.0.1:11434/v1";

pub static DATA_DIR: Lazy<PathBuf> = Lazy::new(|| {
    if let Ok(dir) = std::env::var("UICP_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let base = data_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join(APP_NAME)
});

pub static LOGS_DIR: Lazy<PathBuf> = Lazy::new(|| DATA_DIR.join("logs"));
pub static FILES_DIR: Lazy<PathBuf> = Lazy::new(|| DATA_DIR.join("files"));

pub fn files_dir_path() -> &'static std::path::Path {
    &FILES_DIR
}

// ----------------------------------------------------------------------------
// Circuit breaker configuration
// ----------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct CircuitBreakerConfig {
    pub max_failures: u8,
    pub open_duration_ms: u64,
}

impl Default for CircuitBreakerConfig {
    fn default() -> Self {
        Self {
            max_failures: 3,
            open_duration_ms: 15_000,
        }
    }
}

impl CircuitBreakerConfig {
    /// Load configuration from environment variables with fallback to defaults.
    ///
    /// Environment variables:
    /// - UICP_CIRCUIT_MAX_FAILURES: Maximum consecutive failures before opening (default: 3)
    /// - UICP_CIRCUIT_OPEN_MS: Duration to keep circuit open in milliseconds (default: 15000)
    pub fn from_env() -> Self {
        let max_failures = std::env::var("UICP_CIRCUIT_MAX_FAILURES")
            .ok()
            .and_then(|v| v.parse::<u8>().ok())
            .unwrap_or(3);

        let open_duration_ms = std::env::var("UICP_CIRCUIT_OPEN_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(15_000);

        Self {
            max_failures,
            open_duration_ms,
        }
    }
}

// ----------------------------------------------------------------------------
// App state
// ----------------------------------------------------------------------------

#[derive(Default, Clone)]
pub struct CircuitState {
    pub consecutive_failures: u8,
    pub opened_until: Option<Instant>,
    pub last_failure_at: Option<Instant>,
    pub total_failures: u64,
    pub total_successes: u64,
}

pub struct AppState {
    pub db_path: PathBuf,
    pub db_ro: AsyncConn,
    pub db_rw: AsyncConn,
    pub last_save_ok: RwLock<bool>,
    pub ollama_key: RwLock<Option<String>>,
    pub use_direct_cloud: RwLock<bool>,
    pub debug_enabled: RwLock<bool>,
    pub http: Client,
    pub ongoing: RwLock<HashMap<String, JoinHandle<()>>>,
    pub compute_ongoing: RwLock<HashMap<String, JoinHandle<()>>>,
    pub compute_sem: Arc<Semaphore>,
    pub compute_cancel: RwLock<HashMap<String, tokio::sync::watch::Sender<bool>>>,
    pub safe_mode: RwLock<bool>,
    pub safe_reason: RwLock<Option<String>>,
    pub circuit_breakers: Arc<RwLock<HashMap<String, CircuitState>>>,
    pub circuit_config: CircuitBreakerConfig,
    pub action_log: action_log::ActionLogHandle,
}

// ----------------------------------------------------------------------------
// Shared helpers
// ----------------------------------------------------------------------------

pub fn configure_sqlite(conn: &Connection) -> anyhow::Result<()> {
    conn.busy_timeout(Duration::from_millis(5_000))
        .context("sqlite busy_timeout 5s")?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .context("sqlite journal_mode=WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .context("sqlite synchronous=NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .context("sqlite foreign_keys=ON")?;
    Ok(())
}

/// Current database schema version. Increment when making schema changes.
const SCHEMA_VERSION: i64 = 1;

pub fn init_database(db_path: &PathBuf) -> anyhow::Result<()> {
    std::fs::create_dir_all(&*DATA_DIR).context("create data dir")?;
    let conn = Connection::open(db_path).context("open sqlite")?;
    configure_sqlite(&conn).context("configure sqlite init")?;

    // Ensure schema_version table exists first for migration tracking
    ensure_schema_version_table(&conn).context("ensure schema_version table")?;

    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS workspace (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS window (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            title TEXT NOT NULL,
            size TEXT NOT NULL,
            x REAL,
            y REAL,
            width REAL,
            height REAL,
            z_index INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY(workspace_id) REFERENCES workspace(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS window_content (
            id TEXT PRIMARY KEY,
            window_id TEXT NOT NULL,
            html TEXT NOT NULL,
            version INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY(window_id) REFERENCES window(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS tool_call (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            tool TEXT NOT NULL,
            args_json TEXT NOT NULL,
            result_json TEXT,
            created_at INTEGER NOT NULL,
            FOREIGN KEY(workspace_id) REFERENCES workspace(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS compute_cache (
            workspace_id TEXT NOT NULL,
            key TEXT NOT NULL,
            task TEXT NOT NULL,
            env_hash TEXT NOT NULL,
            value_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (workspace_id, key)
        );
        CREATE TABLE IF NOT EXISTS golden_cache (
            workspace_id TEXT NOT NULL,
            key TEXT NOT NULL,
            output_hash TEXT NOT NULL,
            task TEXT NOT NULL,
            value_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (workspace_id, key)
        );
        "#,
    )
    .context("apply migrations")?;
    action_log::ensure_action_log_schema(&conn)
        .context("ensure action_log schema (init_database)")?;

    match conn.execute("ALTER TABLE window ADD COLUMN width REAL DEFAULT 640", []) {
        Ok(_) => {}
        Err(rusqlite::Error::SqliteFailure(_, Some(msg)))
            if msg.contains("duplicate column name") => {}
        Err(err) => return Err(err.into()),
    }
    match conn.execute("ALTER TABLE window ADD COLUMN height REAL DEFAULT 480", []) {
        Ok(_) => {}
        Err(rusqlite::Error::SqliteFailure(_, Some(msg)))
            if msg.contains("duplicate column name") => {}
        Err(err) => return Err(err.into()),
    }

    // Apply compute_cache migration with versioning and error recovery
    migrate_compute_cache(&conn).context(
        "compute_cache migration failed. Recovery: Stop all UICP instances, backup data.db, \
        then run 'PRAGMA integrity_check' manually. If corrupt, restore from backup or \
        delete compute_cache table to rebuild cache from scratch.",
    )?;

    {
        let mut has_value_column = false;
        let mut stmt = conn
            .prepare("PRAGMA table_info('golden_cache')")
            .context("inspect golden_cache schema")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let name: String = row.get(1)?;
            if name == "value_json" {
                has_value_column = true;
                break;
            }
        }
        if !has_value_column {
            conn.execute("ALTER TABLE golden_cache ADD COLUMN value_json TEXT", [])
                .context("add value_json column to golden_cache")?;
            conn.execute(
                "UPDATE golden_cache SET value_json = 'null' WHERE value_json IS NULL",
                [],
            )
            .context("backfill null golden_cache value_json")?;
        }
    }

    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_compute_cache_task_env ON compute_cache (workspace_id, task, env_hash)",
        [],
    )
    .context("ensure compute_cache task/env index")?;

    // Record successful migration
    record_schema_version(&conn, SCHEMA_VERSION).context("record schema version")?;

    Ok(())
}

pub fn ensure_default_workspace(db_path: &PathBuf) -> anyhow::Result<()> {
    let conn = Connection::open(db_path).context("open sqlite for default workspace")?;
    configure_sqlite(&conn).context("configure sqlite for default workspace")?;
    let now = Utc::now().timestamp();
    conn.execute(
        "INSERT OR IGNORE INTO workspace (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        params!["default", "Default Workspace", now],
    )
    .context("insert default workspace")?;
    Ok(())
}

/// Ensure schema_version table exists for tracking migrations.
fn ensure_schema_version_table(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS schema_version (
            component TEXT PRIMARY KEY,
            version INTEGER NOT NULL,
            applied_at INTEGER NOT NULL
        );
        "#,
    )
    .context("create schema_version table")?;
    Ok(())
}

/// Record a successful schema migration.
fn record_schema_version(conn: &Connection, version: i64) -> anyhow::Result<()> {
    let now = Utc::now().timestamp();
    conn.execute(
        "INSERT OR REPLACE INTO schema_version (component, version, applied_at) \
         VALUES ('compute_cache', ?1, ?2)",
        params![version, now],
    )
    .context("record schema version")?;
    Ok(())
}

/// Get current schema version for a component.
fn get_schema_version(conn: &Connection, component: &str) -> anyhow::Result<Option<i64>> {
    let version = conn
        .query_row(
            "SELECT version FROM schema_version WHERE component = ?1",
            params![component],
            |row| row.get(0),
        )
        .optional()
        .context("query schema version")?;
    Ok(version)
}

fn migrate_compute_cache(conn: &Connection) -> anyhow::Result<()> {
    // Check if migration was already completed using schema version
    if let Ok(Some(version)) = get_schema_version(conn, "compute_cache") {
        if version >= SCHEMA_VERSION {
            return Ok(());
        }
    }

    // Ensure the legacy table has the workspace column before we attempt to rebuild the PK.
    let mut has_workspace_column = false;
    {
        let mut stmt = conn
            .prepare("PRAGMA table_info('compute_cache')")
            .context("inspect compute_cache schema")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let name: String = row.get(1)?;
            if name == "workspace_id" {
                has_workspace_column = true;
                break;
            }
        }
    }
    if !has_workspace_column {
        match conn.execute(
            "ALTER TABLE compute_cache ADD COLUMN workspace_id TEXT DEFAULT 'default'",
            [],
        ) {
            Ok(_) => {}
            Err(rusqlite::Error::SqliteFailure(_, Some(msg)))
                if msg.contains("duplicate column name") => {}
            Err(err) => {
                return Err(err).context(
                    "Failed to add workspace_id column. The database may be locked or corrupt.",
                )
            }
        }
    }

    // Tighten NULLs that may have slipped in before the composite key existed.
    conn.execute(
        "UPDATE compute_cache SET workspace_id = 'default' WHERE workspace_id IS NULL",
        [],
    )
    .context("backfill null workspace_id values")?;

    // Detect if the composite primary key is already in place.
    let mut pk_columns: Vec<String> = Vec::new();
    {
        let mut stmt = conn
            .prepare("PRAGMA table_info('compute_cache')")
            .context("inspect compute_cache primary key")?;
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            let name: String = row.get(1)?;
            let pk_pos: i32 = row.get(5)?;
            if pk_pos > 0 {
                pk_columns.push(name);
            }
        }
    }
    pk_columns.sort();
    if pk_columns == ["key".to_string(), "workspace_id".to_string()] {
        // Migration already complete, just update version tracking
        return Ok(());
    }

    // Clean up any failed migration artifacts
    conn.execute("DROP TABLE IF EXISTS compute_cache_new", [])
        .context("drop stale compute_cache_new helper table")?;

    // Execute migration in transaction with enhanced error context
    conn.execute_batch(
        r#"
        BEGIN IMMEDIATE;
        CREATE TABLE compute_cache_new (
            workspace_id TEXT NOT NULL,
            key TEXT NOT NULL,
            task TEXT NOT NULL,
            env_hash TEXT NOT NULL,
            value_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (workspace_id, key)
        );
        INSERT INTO compute_cache_new (workspace_id, key, task, env_hash, value_json, created_at)
        SELECT workspace_id, key, task, env_hash, value_json, created_at
        FROM (
            SELECT
                workspace_id,
                key,
                task,
                env_hash,
                value_json,
                created_at,
                ROW_NUMBER() OVER (
                    PARTITION BY workspace_id, key
                    ORDER BY created_at DESC, rowid DESC
                ) AS rn
            FROM compute_cache
        )
        WHERE rn = 1;
        DROP TABLE compute_cache;
        ALTER TABLE compute_cache_new RENAME TO compute_cache;
        COMMIT;
        "#,
    )
    .context(
        "Failed to rebuild compute_cache table with composite primary key. \
        This migration deduplicates cache entries and adds proper workspace scoping. \
        If this fails repeatedly, the cache can be safely cleared by running: \
        'DELETE FROM compute_cache' as it will rebuild automatically.",
    )?;

    Ok(())
}

pub fn emit_or_log<R: Runtime, T>(app_handle: &tauri::AppHandle<R>, event: &str, payload: T)
where
    T: serde::Serialize + Clone,
{
    // WHY: Tauri v2 restricts event names (avoid dots). We normalize
    // names by replacing '.' with '-' before emitting so callers may
    // use either form. Prefer dashed names in new code and docs.
    // INVARIANT: All emitted event names are dash-normalized.
    let evt = if event.contains('.') {
        event.replace('.', "-")
    } else {
        event.to_string()
    };
    if let Err(err) = app_handle.emit(&evt, payload) {
        eprintln!("Failed to emit {event}: {err}");
    }
}

/// Remove a compute job from the ongoing map. Used by the compute host to release state.
pub async fn remove_compute_job<R: Runtime>(app_handle: &tauri::AppHandle<R>, job_id: &str) {
    let state: State<'_, crate::AppState> = app_handle.state();
    state.compute_ongoing.write().await.remove(job_id);
}
