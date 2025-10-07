#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")] // hide console window on Windows in release

use std::{collections::HashMap, path::PathBuf, time::Duration};

use anyhow::Context;
use chrono::Utc;
use dirs::document_dir;
use dotenvy::dotenv;
use once_cell::sync::Lazy;
use reqwest::Client;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{
    async_runtime::{spawn, JoinHandle},
    Emitter, Manager, State,
};
use tokio::{fs, io::AsyncWriteExt, sync::RwLock, time::interval};
use tokio_stream::StreamExt;

static APP_NAME: &str = "UICP";
static OLLAMA_CLOUD_HOST_DEFAULT: &str = "https://ollama.com";
static OLLAMA_LOCAL_BASE_DEFAULT: &str = "http://127.0.0.1:11434/v1";
static DATA_DIR: Lazy<PathBuf> = Lazy::new(|| {
    let base = document_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join(APP_NAME)
});
static DB_PATH: Lazy<PathBuf> = Lazy::new(|| DATA_DIR.join("data.db"));
static ENV_PATH: Lazy<PathBuf> = Lazy::new(|| DATA_DIR.join(".env"));
static LOGS_DIR: Lazy<PathBuf> = Lazy::new(|| DATA_DIR.join("logs"));

struct AppState {
    db_path: PathBuf,
    last_save_ok: RwLock<bool>,
    ollama_key: RwLock<Option<String>>,
    use_direct_cloud: RwLock<bool>,
    debug_enabled: RwLock<bool>,
    http: Client,
    ongoing: RwLock<HashMap<String, JoinHandle<()>>>,
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
    // Accept Harmony developer payloads (objects) and legacy string messages.
    content: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatCompletionRequest {
    model: Option<String>,
    messages: Vec<ChatMessageInput>,
    stream: Option<bool>,
    tools: Option<serde_json::Value>,
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
async fn set_debug(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    *state.debug_enabled.write().await = enabled;
    Ok(())
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
async fn test_api_key(
    state: State<'_, AppState>,
    window: tauri::Window,
) -> Result<ApiKeyStatus, String> {
    let Some(key) = state.ollama_key.read().await.clone() else {
        return Ok(ApiKeyStatus {
            valid: false,
            message: Some("No API key configured".into()),
        });
    };
    let client = state.http.clone();
    let base = get_ollama_base_url(&state).await?;
    let use_cloud = *state.use_direct_cloud.read().await;
    let url = if use_cloud {
        format!("{}/api/tags", base)
    } else {
        // Local OpenAI-compatible server exposes /v1/models; base already includes /v1
        format!("{}/models", base)
    };

    let mut req = client.get(url);
    if use_cloud {
        req = req.header("Authorization", format!("Bearer {}", key));
    }
    let result = req.send().await.map_err(|e| format!("HTTP error: {e}"))?;

    if result.status().is_success() {
        window
            .emit(
                "api-key-status",
                ApiKeyStatus {
                    valid: true,
                    message: Some("API key validated against Ollama Cloud".into()),
                },
            )
            .map_err(|e| format!("Failed to emit api-key-status: {e}"))?;
        Ok(ApiKeyStatus {
            valid: true,
            message: Some("API key validated against Ollama Cloud".into()),
        })
    } else {
        let msg = format!("Ollama responded with status {}", result.status());
        window
            .emit(
                "api-key-status",
                ApiKeyStatus {
                    valid: false,
                    message: Some(msg.clone()),
                },
            )
            .map_err(|e| format!("Failed to emit api-key-status: {e}"))?;
        Ok(ApiKeyStatus {
            valid: false,
            message: Some(msg),
        })
    }
}

#[tauri::command]
async fn persist_command(state: State<'_, AppState>, cmd: CommandRequest) -> Result<(), String> {
    let db_path = state.db_path.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = Connection::open(db_path).context("open sqlite persist command")?;
        let now = Utc::now().timestamp();
        let args_json = serde_json::to_string(&cmd.args).context("serialize command args")?;
        conn.execute(
            "INSERT INTO tool_call (id, workspace_id, tool, args_json, result_json, created_at)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
            params![cmd.id, "default", cmd.tool, args_json, now],
        )
        .context("insert tool_call")?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?
    .map_err(|e| format!("DB error: {e:?}"))?;
    Ok(())
}

#[tauri::command]
async fn get_workspace_commands(state: State<'_, AppState>) -> Result<Vec<CommandRequest>, String> {
    let db_path = state.db_path.clone();
    let commands = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<CommandRequest>> {
        let conn = Connection::open(db_path).context("open sqlite get commands")?;
        let mut stmt = conn
            .prepare(
                "SELECT id, tool, args_json FROM tool_call
                 WHERE workspace_id = ?1
                 ORDER BY created_at ASC",
            )
            .context("prepare tool_call select")?;
        let rows = stmt
            .query_map(params!["default"], |row| {
                let id: String = row.get(0)?;
                let tool: String = row.get(1)?;
                let args_json: String = row.get(2)?;
                let args = serde_json::from_str(&args_json)
                    .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
                Ok(CommandRequest { id, tool, args })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?
    .map_err(|e| format!("DB error: {e:?}"))?;
    Ok(commands)
}

#[tauri::command]
async fn clear_workspace_commands(state: State<'_, AppState>) -> Result<(), String> {
    let db_path = state.db_path.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = Connection::open(db_path).context("open sqlite clear commands")?;
        conn.execute(
            "DELETE FROM tool_call WHERE workspace_id = ?1",
            params!["default"],
        )
        .context("delete tool_calls")?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?
    .map_err(|e| format!("DB error: {e:?}"))?;
    Ok(())
}

#[tauri::command]
async fn delete_window_commands(
    state: State<'_, AppState>,
    window_id: String,
) -> Result<(), String> {
    let db_path = state.db_path.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = Connection::open(db_path).context("open sqlite delete window commands")?;
        // Delete commands where:
        // 1. tool = "window.create" AND args.id = window_id
        // 2. OR args.windowId = window_id (for dom.*, component.*, etc.)
        conn.execute(
            "DELETE FROM tool_call
             WHERE workspace_id = ?1
             AND (
                 (tool = 'window.create' AND json_extract(args_json, '$.id') = ?2)
                 OR json_extract(args_json, '$.windowId') = ?2
             )",
            params!["default", window_id],
        )
        .context("delete window commands")?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Join error: {e}"))?
    .map_err(|e| format!("DB error: {e:?}"))?;
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
                content: Some(
                    "<h2>Welcome to UICP</h2><p>Start asking Gui (Guy) to build an app.</p>".into(),
                ),
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
                .map_err(|e| format!("Failed to emit save-indicator: {e}"))?;
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
                .map_err(|e| format!("Failed to emit save-indicator: {e}"))?;
            Err(format!("DB error: {err:?}"))
        }
    }
}

#[tauri::command]
async fn cancel_chat(state: State<'_, AppState>, request_id: String) -> Result<(), String> {
    if let Some(handle) = state.ongoing.write().await.remove(&request_id) {
        handle.abort();
    }
    Ok(())
}

fn normalize_model_name(raw: &str, use_cloud: bool) -> String {
    let trimmed = raw.trim();
    if use_cloud {
        let core = trimmed.trim_end_matches("-cloud");
        if core.contains(':') {
            core.to_string()
        } else if let Some(idx) = core.rfind('-') {
            let (prefix, suffix) = core.split_at(idx);
            let suffix = suffix.trim_start_matches('-');
            format!("{}:{}", prefix, suffix)
        } else {
            core.to_string()
        }
    } else {
        let core = trimmed.trim_end_matches("-cloud");
        if core.contains(':') {
            core.to_string()
        } else if let Some(idx) = core.rfind('-') {
            let (prefix, suffix) = core.split_at(idx);
            let suffix = suffix.trim_start_matches('-');
            format!("{}:{}", prefix, suffix)
        } else {
            core.to_string()
        }
    }
}

#[tauri::command]
async fn chat_completion(
    window: tauri::Window,
    state: State<'_, AppState>,
    request_id: Option<String>,
    request: ChatCompletionRequest,
) -> Result<(), String> {
    if request.messages.is_empty() {
        return Err("messages cannot be empty".into());
    }

    let use_cloud = *state.use_direct_cloud.read().await;
    let debug_on = *state.debug_enabled.read().await;
    let api_key_opt = state.ollama_key.read().await.clone();
    if use_cloud && api_key_opt.is_none() {
        return Err("No API key configured".into());
    }

    let requested_model = request.model.unwrap_or_else(|| {
        // Default actor model favors Qwen3-Coder for consistent cloud/local pairing.
        std::env::var("ACTOR_MODEL").unwrap_or_else(|_| "qwen3-coder:480b".into())
    });
    // Normalize to colon-delimited tags for Cloud and OpenAI-compatible hyphen tags for local daemon.
    let resolved_model = normalize_model_name(&requested_model, use_cloud);

    let body = serde_json::json!({
        "model": resolved_model,
        "messages": request.messages,
        "stream": request.stream.unwrap_or(true),
        "tools": request.tools,
    });

    let base = get_ollama_base_url(&state).await?;

    // Simple retry/backoff policy for rate limits and transient network failures
    let max_attempts = 3u8;

    let rid = request_id.unwrap_or_else(|| format!("req-{}", Utc::now().timestamp_millis()));
    let app_handle = window.app_handle().clone();
    let client = state.http.clone();
    let base_url = base.clone();
    let body_payload = body.clone();
    let api_key_for_task = api_key_opt.clone();
    let logs_dir = LOGS_DIR.clone();
    let rid_for_task = rid.clone();

    let join: JoinHandle<()> = spawn(async move {
        // best-effort logs dir
        if debug_on {
            let _ = tokio::fs::create_dir_all(&logs_dir).await;
        }
        let trace_path = logs_dir.join(format!("trace-{}.ndjson", rid_for_task));

        let append_trace = |event: serde_json::Value| {
            let path = trace_path.clone();
            async move {
                let line = format!("{}\n", event.to_string());
                if let Ok(mut f) = tokio::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&path)
                    .await
                {
                    let _ = f.write_all(line.as_bytes()).await;
                }
            }
        };

        let emit_debug = |payload: serde_json::Value| {
            let handle = app_handle.clone();
            async move {
                let _ = handle.emit("debug-log", payload);
            }
        };

        if debug_on {
            let url = if use_cloud { format!("{}/api/chat", base_url) } else { format!("{}/chat/completions", base_url) };
            let ev = serde_json::json!({
                "ts": Utc::now().timestamp_millis(),
                "event": "request_started",
                "requestId": rid_for_task,
                "useCloud": use_cloud,
                "url": url,
                "model": body_payload.get("model").cloned().unwrap_or(serde_json::json!(null)),
                "stream": body_payload.get("stream").cloned().unwrap_or(serde_json::json!(true)),
            });
            tokio::spawn(append_trace(ev.clone()));
            tokio::spawn(emit_debug(ev));
        }
        let mut attempt_local: u8 = 0;
        'outer: loop {
            attempt_local += 1;
            // Endpoint differs between Cloud and Local
            let url = if use_cloud {
                format!("{}/api/chat", base_url)
            } else {
                format!("{}/chat/completions", base_url)
            };

            let mut builder = client.post(url).json(&body_payload);

            if use_cloud {
                if let Some(key) = &api_key_for_task {
                    builder = builder.header("Authorization", format!("Bearer {}", key));
                }
            }

            let resp_res = builder.send().await;

            match resp_res {
                Err(err) => {
                    if debug_on {
                        let ev = serde_json::json!({
                            "ts": Utc::now().timestamp_millis(),
                            "event": "request_error",
                            "requestId": rid_for_task,
                            "kind": "transport",
                            "error": err.to_string(),
                        });
                        tokio::spawn(append_trace(ev.clone()));
                        tokio::spawn(emit_debug(ev));
                    }
                    let transient = err.is_timeout() || err.is_connect();
                    if transient && attempt_local < max_attempts {
                        let backoff_ms = 200u64.saturating_mul(1u64 << (attempt_local as u32));
                        tokio::time::sleep(Duration::from_millis(backoff_ms.min(3_000))).await;
                        continue 'outer;
                    }
                    emit_or_log(
                        &app_handle,
                        "ollama-completion",
                        serde_json::json!({ "done": true }),
                    );
                    break;
                }
                Ok(resp) => {
                    let status = resp.status();
                    if debug_on {
                        let ev = serde_json::json!({
                            "ts": Utc::now().timestamp_millis(),
                            "event": "response_status",
                            "requestId": rid_for_task,
                            "status": status.as_u16(),
                        });
                        tokio::spawn(append_trace(ev.clone()));
                        tokio::spawn(emit_debug(ev));
                    }
                    if !status.is_success() {
                        if (status.as_u16() == 429 || status.as_u16() == 503)
                            && attempt_local < max_attempts
                        {
                            let retry_after_ms = resp
                                .headers()
                                .get("retry-after")
                                .and_then(|h| h.to_str().ok())
                                .and_then(|s| s.parse::<u64>().ok())
                                .map(|secs| secs.saturating_mul(1000))
                                .unwrap_or_else(|| {
                                    200u64.saturating_mul(1u64 << (attempt_local as u32))
                                });
                            tokio::time::sleep(Duration::from_millis(retry_after_ms.min(5_000)))
                                .await;
                            continue 'outer;
                        }
                        emit_or_log(
                            &app_handle,
                            "ollama-completion",
                            serde_json::json!({ "done": true }),
                        );
                        if debug_on {
                            if let Ok(text) = resp.text().await {
                                let ev = serde_json::json!({
                                    "ts": Utc::now().timestamp_millis(),
                                    "event": "response_error_body",
                                    "requestId": rid_for_task,
                                    "body": text,
                                });
                                tokio::spawn(append_trace(ev.clone()));
                                tokio::spawn(emit_debug(ev));
                            }
                        }
                        break;
                    }

                    let mut stream = resp.bytes_stream();
                    while let Some(chunk) = stream.next().await {
                        match chunk {
                            Err(_) => {
                                if debug_on {
                                    let ev = serde_json::json!({
                                        "ts": Utc::now().timestamp_millis(),
                                        "event": "stream_error",
                                        "requestId": rid_for_task,
                                    });
                                    tokio::spawn(append_trace(ev.clone()));
                                    tokio::spawn(emit_debug(ev));
                                }
                                break 'outer;
                            }
                            Ok(bytes) => {
                                let text = String::from_utf8_lossy(&bytes);
                                for raw_line in text.split('\n') {
                                    let trimmed = raw_line.trim();
                                    if trimmed.is_empty() {
                                        continue;
                                    }

                                    // Support SSE (data: ...) and JSON Lines
                                    let payload_str = if trimmed.starts_with("data:") {
                                        trimmed.trim_start_matches("data:").trim().to_string()
                                    } else {
                                        trimmed.to_string()
                                    };

                                    if payload_str == "[DONE]" {
                                        if debug_on {
                                            let ev = serde_json::json!({
                                                "ts": Utc::now().timestamp_millis(),
                                                "event": "stream_done",
                                                "requestId": rid_for_task,
                                            });
                                            tokio::spawn(append_trace(ev.clone()));
                                            tokio::spawn(emit_debug(ev));
                                        }
                                        emit_or_log(
                                            &app_handle,
                                            "ollama-completion",
                                            serde_json::json!({ "done": true }),
                                        );
                                        continue;
                                    }

                                    // Try parsing JSON to inspect metadata; we now forward raw chunks so the frontend parser can decide how to interpret harmony / legacy formats.
                                    match serde_json::from_str::<serde_json::Value>(&payload_str) {
                                        Ok(val) => {
                                            // { done: true }
                                            if val
                                                .get("done")
                                                .and_then(|v| v.as_bool())
                                                .unwrap_or(false)
                                            {
                                                if debug_on {
                                                    let ev = serde_json::json!({
                                                        "ts": Utc::now().timestamp_millis(),
                                                        "event": "delta_done",
                                                        "requestId": rid_for_task,
                                                    });
                                                    tokio::spawn(append_trace(ev.clone()));
                                                    tokio::spawn(emit_debug(ev));
                                                }
                                                emit_or_log(
                                                    &app_handle,
                                                    "ollama-completion",
                                                    serde_json::json!({ "done": true }),
                                                );
                                                continue;
                                            }
                                            if debug_on {
                                                let ev = serde_json::json!({
                                                    "ts": Utc::now().timestamp_millis(),
                                                    "event": "delta_json",
                                                    "requestId": rid_for_task,
                                                    "len": payload_str.len(),
                                                });
                                                tokio::spawn(append_trace(ev.clone()));
                                                tokio::spawn(emit_debug(ev));
                                            }
                                            emit_or_log(
                                                &app_handle,
                                                "ollama-completion",
                                                serde_json::json!({ "done": false, "delta": payload_str, "kind": "json" }),
                                            );
                                        }
                                        Err(_) => {
                                            if debug_on {
                                                let ev = serde_json::json!({
                                                    "ts": Utc::now().timestamp_millis(),
                                                    "event": "delta_text",
                                                    "requestId": rid_for_task,
                                                    "len": payload_str.len(),
                                                });
                                                tokio::spawn(append_trace(ev.clone()));
                                                tokio::spawn(emit_debug(ev));
                                            }
                                            // Pass through plain text
                                            emit_or_log(
                                                &app_handle,
                                                "ollama-completion",
                                                serde_json::json!({ "done": false, "delta": payload_str, "kind": "text" }),
                                            );
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if debug_on {
                        let ev = serde_json::json!({
                            "ts": Utc::now().timestamp_millis(),
                            "event": "completed",
                            "requestId": rid_for_task,
                        });
                        tokio::spawn(append_trace(ev.clone()));
                        tokio::spawn(emit_debug(ev));
                    }
                    emit_or_log(
                        &app_handle,
                        "ollama-completion",
                        serde_json::json!({ "done": true }),
                    );
                    break;
                }
            }
        }
    });

    state.ongoing.write().await.insert(rid.clone(), join);
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
                state.ollama_key.blocking_write().replace(value);
            } else if key == "USE_DIRECT_CLOUD" {
                let use_cloud = value == "1" || value.to_lowercase() == "true";
                *state.use_direct_cloud.blocking_write() = use_cloud;
            }
        }
    } else {
        // still load default .env if present elsewhere
        if let Err(err) = dotenv() {
            eprintln!("Failed to load fallback .env: {err:?}");
        }
        if let Ok(val) = std::env::var("OLLAMA_API_KEY") {
            state.ollama_key.blocking_write().replace(val);
        }
        if let Ok(val) = std::env::var("USE_DIRECT_CLOUD") {
            let use_cloud = val == "1" || val.to_lowercase() == "true";
            *state.use_direct_cloud.blocking_write() = use_cloud;
        }
    }
    Ok(())
}

// Helper to get the appropriate Ollama base URL with validation
async fn get_ollama_base_url(state: &AppState) -> Result<String, String> {
    let use_cloud = *state.use_direct_cloud.read().await;

    let base = if use_cloud {
        std::env::var("OLLAMA_CLOUD_HOST").unwrap_or_else(|_| OLLAMA_CLOUD_HOST_DEFAULT.to_string())
    } else {
        std::env::var("OLLAMA_LOCAL_BASE").unwrap_or_else(|_| OLLAMA_LOCAL_BASE_DEFAULT.to_string())
    };

    // Runtime assertion: reject Cloud host containing /v1
    if use_cloud && base.contains("/v1") {
        return Err(
            "Invalid configuration: Do not use /v1 for Cloud. Use https://ollama.com".to_string(),
        );
    }

    Ok(base)
}

#[cfg(test)]
mod tests {
    use super::normalize_model_name;

    #[test]
    fn cloud_keeps_colon_tags() {
        assert_eq!(normalize_model_name("gpt-oss:120b", true), "gpt-oss:120b");
    }

    #[test]
    fn cloud_strips_trailing_cloud_suffix() {
        assert_eq!(normalize_model_name("gpt-oss:120b-cloud", true), "gpt-oss:120b");
    }

    #[test]
    fn cloud_converts_hyphenated_form() {
        assert_eq!(normalize_model_name("gpt-oss-20b", true), "gpt-oss:20b");
    }

    #[test]
    fn local_converts_hyphenated_form_to_colon() {
        assert_eq!(normalize_model_name("gpt-oss-20b", false), "gpt-oss:20b");
    }

    #[test]
    fn local_preserves_colon_for_daemon() {
        assert_eq!(normalize_model_name("gpt-oss:20b", false), "gpt-oss:20b");
    }
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

fn emit_or_log<T>(app_handle: &tauri::AppHandle, event: &str, payload: T)
where
    T: serde::Serialize + Clone,
{
    if let Err(err) = app_handle.emit(event, payload) {
        eprintln!("Failed to emit {event}: {err}");
    }
}

fn spawn_autosave(app_handle: tauri::AppHandle) {
    spawn(async move {
        let mut ticker = interval(Duration::from_secs(5));

        // Emit initial state immediately and seed last_emitted.
        let mut last_emitted = {
            let state: State<'_, AppState> = app_handle.state();
            let current = *state.last_save_ok.read().await;
            emit_or_log(
                &app_handle,
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
            emit_or_log(
                &app_handle,
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
    if let Err(err) = dotenv() {
        eprintln!("Failed to load .env: {err:?}");
    }

    let db_path = DB_PATH.clone();

    let state = AppState {
        db_path: db_path.clone(),
        last_save_ok: RwLock::new(true),
        ollama_key: RwLock::new(None),
        use_direct_cloud: RwLock::new(true), // default to cloud mode
        debug_enabled: RwLock::new({
            let raw = std::env::var("UICP_DEBUG").unwrap_or_default();
            matches!(raw.as_str(), "1" | "true" | "TRUE" | "yes" | "on")
        }),
        http: Client::builder()
            // Allow long-lived streaming responses; UI can cancel via cancel_chat.
            .build()
            .expect("Failed to build HTTP client"),
        ongoing: RwLock::new(HashMap::new()),
    };

    if let Err(err) = init_database(&db_path) {
        eprintln!("Failed to initialize database: {err:?}");
        std::process::exit(1);
    }
    if let Err(err) = ensure_default_workspace(&db_path) {
        eprintln!("Failed to ensure default workspace: {err:?}");
        std::process::exit(1);
    }
    if let Err(err) = load_env_key(&state) {
        eprintln!("Failed to load environment keys: {err:?}");
        std::process::exit(1);
    }

    tauri::Builder::default()
        .manage(state)
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            spawn_autosave(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_paths,
            load_api_key,
            save_api_key,
            set_debug,
            test_api_key,
            persist_command,
            get_workspace_commands,
            clear_workspace_commands,
            delete_window_commands,
            load_workspace,
            save_workspace,
            chat_completion,
            cancel_chat
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
