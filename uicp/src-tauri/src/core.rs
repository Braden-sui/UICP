use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::Context;
use chrono::Utc;
use dirs::document_dir;
use once_cell::sync::Lazy;
use reqwest::Client;
use rusqlite::{params, Connection};
use tauri::{async_runtime::JoinHandle, Emitter, Manager, State};
use tokio::sync::{RwLock, Semaphore};

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
    let base = document_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join(APP_NAME)
});

pub static LOGS_DIR: Lazy<PathBuf> = Lazy::new(|| DATA_DIR.join("logs"));
pub static FILES_DIR: Lazy<PathBuf> = Lazy::new(|| DATA_DIR.join("files"));

pub fn files_dir_path() -> &'static std::path::Path {
    &*FILES_DIR
}

// ----------------------------------------------------------------------------
// App state
// ----------------------------------------------------------------------------

#[derive(Default)]
pub struct CircuitState {
    pub consecutive_failures: u8,
    pub opened_until: Option<Instant>,
}

pub struct AppState {
    pub db_path: PathBuf,
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

pub fn init_database(db_path: &PathBuf) -> anyhow::Result<()> {
    std::fs::create_dir_all(&*DATA_DIR).context("create data dir")?;
    let conn = Connection::open(db_path).context("open sqlite")?;
    configure_sqlite(&conn).context("configure sqlite init")?;
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
        "#,
    )
    .context("apply migrations")?;

    match conn.execute("ALTER TABLE window ADD COLUMN width REAL DEFAULT 640", []) {
        Ok(_) => {}
        Err(rusqlite::Error::SqliteFailure(_, Some(msg))) if msg.contains("duplicate column name") => {}
        Err(err) => return Err(err.into()),
    }
    match conn.execute("ALTER TABLE window ADD COLUMN height REAL DEFAULT 480", []) {
        Ok(_) => {}
        Err(rusqlite::Error::SqliteFailure(_, Some(msg))) if msg.contains("duplicate column name") => {}
        Err(err) => return Err(err.into()),
    }
    migrate_compute_cache(&conn).context("migrate compute_cache schema")?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_compute_cache_task_env ON compute_cache (workspace_id, task, env_hash)",
        [],
    )
    .context("ensure compute_cache task/env index")?;

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

fn migrate_compute_cache(conn: &Connection) -> anyhow::Result<()> {
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
            Err(rusqlite::Error::SqliteFailure(_, Some(msg))) if msg.contains("duplicate column name") => {}
            Err(err) => return Err(err.into()),
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
        return Ok(());
    }

    conn.execute("DROP TABLE IF EXISTS compute_cache_new", [])
        .context("drop stale compute_cache_new helper table")?;

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
    .context("rebuild compute_cache with composite primary key")?;

    Ok(())
}

pub fn emit_or_log<T>(app_handle: &tauri::AppHandle, event: &str, payload: T)
where
    T: serde::Serialize + Clone,
{
    if let Err(err) = app_handle.emit(event, payload) {
        eprintln!("Failed to emit {event}: {err}");
    }
}

/// Remove a compute job from the ongoing map. Used by the compute host to release state.
pub async fn remove_compute_job(app_handle: &tauri::AppHandle, job_id: &str) {
    let state: State<'_, crate::AppState> = app_handle.state();
    state.compute_ongoing.write().await.remove(job_id);
}
