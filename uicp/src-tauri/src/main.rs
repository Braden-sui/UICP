#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")] // hide console window on Windows in release

use std::{path::PathBuf, time::Duration};

use anyhow::Context;
use chrono::Utc;
use dirs::document_dir;
use dotenvy::dotenv;
use once_cell::sync::Lazy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use rusqlite::{params, Connection};
use tauri::{async_runtime::spawn, Emitter, Manager, State};
use tokio::{fs, sync::RwLock, time::interval};
use tokio_stream::StreamExt;

static APP_NAME: &str = "UICP";
static OLLAMA_BASE_URL_FALLBACK: &str = "https://ollama.com/v1";
static DATA_DIR: Lazy<PathBuf> = Lazy::new(|| {
    let base = document_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join(APP_NAME)
});
static DB_PATH: Lazy<PathBuf> = Lazy::new(|| DATA_DIR.join("data.db"));
static ENV_PATH: Lazy<PathBuf> = Lazy::new(|| DATA_DIR.join(".env"));

struct AppState {
    db_path: PathBuf,
    last_save_ok: RwLock<bool>,
    ollama_key: RwLock<Option<String>>,
    http: Client,
}

#[derive(Clone, Serialize)]
struct SaveIndicatorPayload {
    ok: bool,
    timestamp: i64,
}

#[derive(Clone, Serialize)]
struct ApiKeyStatus {
    valid: bool,
    message: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct CommandRequest {
    id: String,
    tool: String,
    args: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WindowStatePayload {
    id: String,
    title: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    z_index: i64,
    content: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatMessageInput {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatCompletionRequest {
    model: Option<String>,
    messages: Vec<ChatMessageInput>,
    stream: Option<bool>,
}

#[tauri::command]
async fn get_paths() -> Result<serde_json::Value, String> {
    // Return canonical string paths so downstream logic receives stable values.
    Ok(serde_json::json!({
        "dataDir": DATA_DIR.display().to_string(),
        "dbPath": DB_PATH.display().to_string(),
        "envPath": ENV_PATH.display().to_string(),
    }))
}

#[tauri::command]
async fn load_api_key(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let key = state.ollama_key.read().await.clone();
    Ok(key)
}

#[tauri::command]
async fn save_api_key(state: State<'_, AppState>, key: String) -> Result<(), String> {
    // ensure documents directory exists
    fs::create_dir_all(&*DATA_DIR)
        .await
        .map_err(|e| format!("Failed to create data dir: {e}"))?;
    let content = format!("OLLAMA_API_KEY={}\n", key.trim());
    fs::write(&*ENV_PATH, content)
        .await
        .map_err(|e| format!("Failed to write .env: {e}"))?;
    *state.ollama_key.write().await = Some(key);
    Ok(())
}

#[tauri::command]
async fn test_api_key(state: State<'_, AppState>, window: tauri::Window) -> Result<ApiKeyStatus, String> {
    let Some(key) = state.ollama_key.read().await.clone() else {
        return Ok(ApiKeyStatus { valid: false, message: Some("No API key configured".into()) });
    };
    let client = state.http.clone();
    let base = std::env::var("OLLAMA_BASE_URL").unwrap_or_else(|_| OLLAMA_BASE_URL_FALLBACK.into());
    let result = client
        .get(format!("{}/models", base))
        .header("Authorization", key)
        .send()
        .await
        .map_err(|e| format!("HTTP error: {e}"))?;

    if result.status().is_success() {
        window
            .emit(
                "api-key-status",
                ApiKeyStatus {
                    valid: true,
                    message: Some("API key validated against Ollama Cloud".into()),
                },
            )
            .ok();
        Ok(ApiKeyStatus {
            valid: true,
            message: Some("API key validated against Ollama Cloud".into()),
        })
    } else {
        let msg = format!("Ollama responded with status {}", result.status());
        window.emit("api-key-status", ApiKeyStatus { valid: false, message: Some(msg.clone()) }).ok();
        Ok(ApiKeyStatus { valid: false, message: Some(msg) })
    }
}

#[tauri::command]
async fn enqueue_command(_state: State<'_, AppState>, cmd: CommandRequest) -> Result<(), String> {
    // TODO: insert into command queue table (future milestone)
    println!("Received command: {:?}", cmd);
    Ok(())
}

#[tauri::command]
async fn load_workspace(state: State<'_, AppState>) -> Result<Vec<WindowStatePayload>, String> {
    let db_path = state.db_path.clone();
    let windows = tokio::task::spawn_blocking(move || {
        let conn = Connection::open(db_path).context("open sqlite load workspace")?;
        let mut stmt = conn
            .prepare(
                "SELECT id, title, COALESCE(x, 40), COALESCE(y, 40), COALESCE(width, 640), \
                 COALESCE(height, 480), COALESCE(z_index, 0)
                 FROM window WHERE workspace_id = ?1 ORDER BY z_index ASC, created_at ASC",
            )
            .context("prepare window select")?;
        let rows = stmt
            .query_map(params!["default"], |row| {
                Ok(WindowStatePayload {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    x: row.get::<_, f64>(2)?,
                    y: row.get::<_, f64>(3)?,
                    width: row.get::<_, f64>(4)?,
                    height: row.get::<_, f64>(5)?,
                    z_index: row.get::<_, i64>(6)?,
                    content: None,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        Ok::<_, anyhow::Error>(if rows.is_empty() {
            vec![WindowStatePayload {
                id: uuid::Uuid::new_v4().to_string(),
                title: "Welcome".into(),
                x: 60.0,
                y: 60.0,
                width: 720.0,
                height: 420.0,
                z_index: 0,
                content: Some("<h2>Welcome to UICP</h2><p>Start asking Gui to build an app.</p>".into()),
            }]
        } else {
            rows
        })
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?
    .map_err(|e| format!("DB error: {e:?}"))?;

    Ok(windows)
}

#[tauri::command]
async fn save_workspace(
    window: tauri::Window,
    state: State<'_, AppState>,
    windows: Vec<WindowStatePayload>,
) -> Result<(), String> {
    let db_path = state.db_path.clone();
    let save_res = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let mut conn = Connection::open(db_path).context("open sqlite save workspace")?;
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM window WHERE workspace_id = ?1",
            params!["default"],
        )?;
        let now = Utc::now().timestamp();
        for (index, win) in windows.iter().enumerate() {
            let z_index = if win.z_index < 0 {
                index as i64
            } else {
                win.z_index.max(index as i64)
            };
            tx.execute(
                "INSERT INTO window (id, workspace_id, title, size, x, y, width, height, z_index, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
                params![
                    win.id,
                    "default",
                    &win.title,
                    derive_size_token(win.width, win.height),
                    win.x,
                    win.y,
                    win.width,
                    win.height,
                    z_index,
                    now,
                ],
            )?;
        }
        tx.execute(
            "UPDATE workspace SET updated_at = ?1 WHERE id = ?2",
            params![now, "default"],
        )?;
        tx.commit()?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?;

    match save_res {
        Ok(_) => {
            *state.last_save_ok.write().await = true;
            window
                .emit(
                    "save-indicator",
                    SaveIndicatorPayload {
                        ok: true,
                        timestamp: Utc::now().timestamp(),
                    },
                )
                .ok();
            Ok(())
        }
        Err(err) => {
            *state.last_save_ok.write().await = false;
            window
                .emit(
                    "save-indicator",
                    SaveIndicatorPayload {
                        ok: false,
                        timestamp: Utc::now().timestamp(),
                    },
                )
                .ok();
            Err(format!("DB error: {err:?}"))
        }
    }
}

#[tauri::command]
async fn chat_completion(
    window: tauri::Window,
    state: State<'_, AppState>,
    request: ChatCompletionRequest,
) -> Result<(), String> {
    let Some(api_key) = state.ollama_key.read().await.clone() else {
        return Err("No API key configured".into());
    };

    if request.messages.is_empty() {
        return Err("messages cannot be empty".into());
    }

    let model = request
        .model
        .unwrap_or_else(|| std::env::var("OLLAMA_MODEL").unwrap_or_else(|_| "kimi-k2:1t-cloud".into()));
    let body = serde_json::json!({
        "model": model,
        "messages": request.messages,
        "stream": request.stream.unwrap_or(true)
    });

    let base = std::env::var("OLLAMA_BASE_URL").unwrap_or_else(|_| OLLAMA_BASE_URL_FALLBACK.into());
    let response = state
        .http
        .post(format!("{}/chat/completions", base))
        .header("Authorization", api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("HTTP error: {e}"))?
        .error_for_status()
        .map_err(|e| format!("HTTP status: {e}"))?;

    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Stream error: {e}"))?;
        let text = String::from_utf8_lossy(&chunk);
        for line in text.split('\n') {
            let line = line.trim();
            if line.is_empty() || !line.starts_with("data:") {
                continue;
            }
            let payload = line.trim_start_matches("data:").trim();
            if payload == "[DONE]" {
                window.emit("ollama-completion", serde_json::json!({ "done": true })).ok();
                continue;
            }
            window
                .emit("ollama-completion", serde_json::json!({ "done": false, "delta": payload }))
                .ok();
        }
    }

    Ok(())
}

fn init_database(db_path: &PathBuf) -> anyhow::Result<()> {
    std::fs::create_dir_all(&*DATA_DIR).context("create data dir")?;
    let conn = Connection::open(db_path).context("open sqlite")?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
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
        "#,
    )
    .context("apply migrations")?;

    conn.execute("ALTER TABLE window ADD COLUMN width REAL DEFAULT 640", [])
        .ok();
    conn.execute("ALTER TABLE window ADD COLUMN height REAL DEFAULT 480", [])
        .ok();

    Ok(())
}

fn ensure_default_workspace(db_path: &PathBuf) -> anyhow::Result<()> {
    let conn = Connection::open(db_path).context("open sqlite for default workspace")?;
    let now = Utc::now().timestamp();
    conn.execute(
        "INSERT OR IGNORE INTO workspace (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        params!["default", "Default Workspace", now],
    )
    .context("insert default workspace")?;
    Ok(())
}

fn load_env_key(state: &AppState) -> anyhow::Result<()> {
    if ENV_PATH.exists() {
        for item in dotenvy::from_path_iter(&*ENV_PATH)? {
            let (key, value) = item?;
            if key == "OLLAMA_API_KEY" {
                state
                    .ollama_key
                    .blocking_write()
                    .replace(value);
            }
        }
    } else {
        // still load default .env if present elsewhere
        let _ = dotenv();
        if let Ok(val) = std::env::var("OLLAMA_API_KEY") {
            state.ollama_key.blocking_write().replace(val);
        }
    }
    Ok(())
}

fn derive_size_token(width: f64, height: f64) -> String {
    let max_dim = width.max(height);
    if max_dim <= 360.0 {
        "xs".into()
    } else if max_dim <= 520.0 {
        "sm".into()
    } else if max_dim <= 720.0 {
        "md".into()
    } else if max_dim <= 980.0 {
        "lg".into()
    } else {
        "xl".into()
    }
}

fn spawn_autosave(app_handle: tauri::AppHandle) {
    spawn(async move {
        let mut ticker = interval(Duration::from_secs(5));

        // Emit initial state immediately and seed last_emitted.
        let mut last_emitted = {
            let state: State<'_, AppState> = app_handle.state();
            let current = *state.last_save_ok.read().await;
            let _ = app_handle.emit(
                "save-indicator",
                SaveIndicatorPayload {
                    ok: current,
                    timestamp: Utc::now().timestamp(),
                },
            );
            Some(current)
        };
        loop {
            ticker.tick().await;
            let state: State<'_, AppState> = app_handle.state();
            let current = *state.last_save_ok.read().await;
            if last_emitted == Some(current) {
                continue;
            }
            last_emitted = Some(current);
            let _ = app_handle.emit(
                "save-indicator",
                SaveIndicatorPayload {
                    ok: current,
                    timestamp: Utc::now().timestamp(),
                },
            );
        }
    });
}

fn main() {
    dotenv().ok();

    let db_path = DB_PATH.clone();

    let state = AppState {
        db_path: db_path.clone(),
        last_save_ok: RwLock::new(true),
        ollama_key: RwLock::new(None),
        http: Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("Failed to build HTTP client"),
    };

    let _ = init_database(&db_path);
    let _ = ensure_default_workspace(&db_path);
    let _ = load_env_key(&state);

    tauri::Builder::default()
        .manage(state)
        .setup(|app| {
            spawn_autosave(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_paths,
            load_api_key,
            save_api_key,
            test_api_key,
            enqueue_command,
            load_workspace,
            save_workspace,
            chat_completion
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
