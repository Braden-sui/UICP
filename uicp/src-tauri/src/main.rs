#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")] // hide console window on Windows in release

use std::{
    collections::HashMap,
    io::ErrorKind,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use base64::engine::general_purpose::STANDARD as BASE64_ENGINE;
use base64::Engine as _;
use chrono::Utc;
use dotenvy::dotenv;
use hmac::{Hmac, Mac};
use once_cell::sync::Lazy;
use reqwest::{Client, Url};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{
    async_runtime::{spawn, JoinHandle},
    Emitter, Manager, State, WebviewUrl,
};

use rand::RngCore;
use tokio::{
    fs,
    io::AsyncWriteExt,
    sync::{RwLock, Semaphore},
    time::{interval, timeout},
};
use tokio_rusqlite::Connection as AsyncConn;
use tokio_stream::StreamExt;

mod action_log;
mod anthropic;
mod apppack;
mod authz;
mod chaos;
mod circuit;
#[cfg(test)]
mod circuit_tests;
mod code_provider;
mod codegen;
#[cfg(feature = "wasm_compute")]
mod component_bindings;
mod compute;
mod compute_cache;
mod compute_input;
mod core;
mod egress;
mod events;
mod hostctx;
mod keystore;
mod net;
mod policy;
mod provider_adapters;
mod provider_circuit;
mod provider_cli;
mod providers;
mod registry;
mod resilience;
#[cfg(test)]
mod resilience_tests;
#[cfg(feature = "wasm_compute")]
mod wasi_logging;

// New module structure
mod commands;
mod initialization;

#[cfg(any(test, feature = "compute_harness"))]
pub mod commands_harness;

pub use policy::{
    enforce_compute_policy, ComputeBindSpec, ComputeCapabilitiesSpec, ComputeFinalErr,
    ComputeFinalOk, ComputeJobSpec, ComputePartialEvent, ComputeProvenanceSpec,
};

use crate::apppack::{apppack_entry_html, apppack_install, apppack_validate};
use crate::egress::egress_fetch;
use crate::keystore::{get_or_init_keystore, UnlockStatus};
use crate::provider_adapters::create_adapter;
use crate::providers::build_provider_headers;
use compute_input::canonicalize_task_input;
use core::{log_error, log_info, log_warn, CircuitBreakerConfig};
use provider_cli::{ProviderHealthResult, ProviderLoginResult};
use secrecy::SecretString;

// Re-export shared core items so crate::... references in submodules remain valid
pub use core::{
    configure_sqlite, emit_or_log, ensure_default_workspace, files_dir_path, init_database,
    remove_compute_job, AppState, APP_NAME, DATA_DIR, FILES_DIR, LOGS_DIR,
    OLLAMA_CLOUD_HOST_DEFAULT, OLLAMA_LOCAL_BASE_DEFAULT,
};

// Minimal inline splash script to render the futuristic loader instantly without contacting dev server.
// This runs inside a separate splash window. Keep it compact and self-contained.

static DB_PATH: Lazy<PathBuf> = Lazy::new(|| DATA_DIR.join("data.db"));
static ENV_PATH: Lazy<PathBuf> = Lazy::new(|| DATA_DIR.join(".env"));

// files_dir_path is re-exported from core

/// Remove a chat request handle from the ongoing map (helper for consistent cleanup).
pub(crate) async fn remove_chat_request(app_handle: &tauri::AppHandle, request_id: &str) {
    let state: State<'_, AppState> = app_handle.state();
    state.ongoing.write().await.remove(request_id);
}

/// Reload host permission policies from AppData/uicp/permissions.json.
#[tauri::command]
async fn reload_policies(app: tauri::AppHandle) -> Result<(), String> {
    crate::authz::reload_policies(&app)
}

// ---------------------------------------------------------------------------
// Keystore Tauri commands (no plaintext read exposure)
// ---------------------------------------------------------------------------

#[tauri::command]
async fn keystore_unlock(
    app: tauri::AppHandle,
    method: String,
    passphrase: Option<String>,
) -> Result<UnlockStatus, String> {
    let ks = get_or_init_keystore().await.map_err(|e| e.to_string())?;
    match method.to_ascii_lowercase().as_str() {
        "passphrase" => {
            let Some(p) = passphrase else {
                return Err("passphrase required".into());
            };
            let status = ks
                .unlock_passphrase(SecretString::new(p))
                .await
                .map_err(|e| e.to_string())?;
            if !status.locked {
                // Fire-and-forget: import known env vars into keystore once unlocked
                let ks_clone = ks.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = import_env_secrets_into_keystore(ks_clone).await;
                });
                // Emit telemetry for unlock
                emit_or_log(
                    &app,
                    "keystore_unlock",
                    serde_json::json!({
                        "method": status.method.map(|m| match m { crate::keystore::UnlockMethod::Passphrase => "passphrase", crate::keystore::UnlockMethod::Mock => "mock" }),
                        "ttlSec": status.ttl_remaining_sec,
                    }),
                );
            }
            Ok(status)
        }
        "mock" => Err("mock unlock not permitted in release".into()),
        _ => Err("unsupported unlock method".into()),
    }
}

#[tauri::command]
async fn keystore_lock(app: tauri::AppHandle) -> Result<(), String> {
    let ks = get_or_init_keystore().await.map_err(|e| e.to_string())?;
    ks.lock();
    // Emit telemetry for manual lock
    emit_or_log(
        &app,
        "keystore_autolock",
        serde_json::json!({ "reason": "manual" }),
    );
    Ok(())
}

#[tauri::command]
async fn keystore_status() -> Result<UnlockStatus, String> {
    let ks = get_or_init_keystore().await.map_err(|e| e.to_string())?;
    Ok(ks.status())
}

#[tauri::command]
async fn keystore_sentinel_exists() -> Result<bool, String> {
    let ks = get_or_init_keystore().await.map_err(|e| e.to_string())?;
    ks.sentinel_exists().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn keystore_list_ids() -> Result<Vec<String>, String> {
    let ks = get_or_init_keystore().await.map_err(|e| e.to_string())?;
    ks.list_ids().await.map_err(|e| e.to_string())
}

/// Emit an explicit keystore_autolock telemetry event with a reason.
#[tauri::command]
fn keystore_autolock_reason(app: tauri::AppHandle, reason: String) -> Result<(), String> {
    emit_or_log(
        &app,
        "keystore_autolock",
        serde_json::json!({ "reason": reason }),
    );
    Ok(())
}

#[tauri::command]
async fn secret_set(service: String, account: String, value: String) -> Result<(), String> {
    let ks = get_or_init_keystore().await.map_err(|e| e.to_string())?;
    ks.secret_set(&service, &account, SecretString::new(value))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn secret_exists(service: String, account: String) -> Result<serde_json::Value, String> {
    let ks = get_or_init_keystore().await.map_err(|e| e.to_string())?;
    let exists = ks
        .secret_exists(&service, &account)
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "exists": exists }))
}

#[tauri::command]
async fn secret_delete(service: String, account: String) -> Result<(), String> {
    let ks = get_or_init_keystore().await.map_err(|e| e.to_string())?;
    ks.secret_delete(&service, &account)
        .await
        .map_err(|e| e.to_string())
}

// Import known provider env vars into keystore when unlocked. Best-effort; errors are logged but not surfaced.
async fn import_env_secrets_into_keystore(
    ks: std::sync::Arc<crate::keystore::Keystore>,
) -> Result<(), String> {
    // (service, account, env_var)
    let mappings = [
        ("uicp", "openai:api_key", "OPENAI_API_KEY"),
        ("uicp", "anthropic:api_key", "ANTHROPIC_API_KEY"),
        ("uicp", "openrouter:api_key", "OPENROUTER_API_KEY"),
        ("uicp", "ollama:api_key", "OLLAMA_API_KEY"),
    ];
    for (service, account, env_key) in mappings.iter() {
        if let Ok(true) = ks.secret_exists(service, account).await {
            continue;
        }
        if let Ok(value) = std::env::var(env_key) {
            let trimmed = value.trim().to_string();
            if !trimmed.is_empty() {
                if let Err(err) = ks
                    .secret_set(service, account, SecretString::new(trimmed))
                    .await
                {
                    log_warn(
                        crate::core::LogEvent::new("env import to keystore failed")
                            .field("account", *account)
                            .field("error", err.to_string()),
                    );
                }
            }
        }
    }
    Ok(())
}

/// Copy a workspace file (ws:/files/...) to a host destination path and return the final host path.
#[tauri::command]
async fn export_from_files(ws_path: String, dest_path: String) -> Result<String, String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("export_from_files");
    use std::fs;
    use std::path::{Path, PathBuf};

    let src_buf: PathBuf = match crate::compute_input::sanitize_ws_files_path(&ws_path) {
        Ok(p) => p,
        Err(e) => return Err(format!("{}", e.message)),
    };
    if !src_buf.exists() {
        return Err(format!("Source not found: {}", ws_path));
    }
    let meta = fs::symlink_metadata(&src_buf).map_err(|e| format!("stat failed: {e}"))?;
    if !meta.file_type().is_file() {
        return Err("Source must be a regular file".into());
    }

    let dest_input = Path::new(&dest_path);
    let mut dest_final: PathBuf = if dest_input.is_dir() {
        let fname = src_buf
            .file_name()
            .ok_or_else(|| "Invalid source file name".to_string())?
            .to_string_lossy()
            .to_string();
        dest_input.join(fname)
    } else {
        dest_input.to_path_buf()
    };

    if let Some(parent) = dest_final.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            return Err(format!("Failed to create destination dir: {e}"));
        }
    }

    if dest_final.exists() {
        let stem = dest_final
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("file");
        let ext = dest_final
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        let ts = chrono::Utc::now().timestamp();
        let new_name = if ext.is_empty() {
            format!("{}-{}", stem, ts)
        } else {
            format!("{}-{}.{}", stem, ts, ext)
        };
        let parent = dest_final
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        dest_final = parent.join(new_name);
    }

    fs::copy(&src_buf, &dest_final).map_err(|e| format!("Copy failed: {e}"))?;
    Ok(dest_final.display().to_string())
}

#[tauri::command]
async fn mint_job_token(
    state: State<'_, AppState>,
    job_id: String,
    task: String,
    workspace_id: String,
    env_hash: String,
) -> Result<String, String> {
    let key = &state.job_token_key;
    let mut mac: Hmac<Sha256> = Hmac::new_from_slice(key).map_err(|e| e.to_string())?;
    mac.update(b"UICP-TOKENv1\x00");
    mac.update(job_id.as_bytes());
    mac.update(b"|");
    mac.update(task.as_bytes());
    mac.update(b"|");
    mac.update(workspace_id.as_bytes());
    mac.update(b"|");
    mac.update(env_hash.as_bytes());
    let tag = mac.finalize().into_bytes();
    Ok(hex::encode(tag))
}

// CircuitState and CircuitBreakerConfig now defined in core module; configure_sqlite re-exported

// Circuit breaker functions moved to circuit.rs module

fn emit_problem_detail(
    app_handle: &tauri::AppHandle,
    request_id: &str,
    status: u16,
    code: &str,
    detail: &str,
    retry_after_ms: Option<u64>,
) {
    let mut error = serde_json::json!({
        "status": status,
        "code": code,
        "detail": detail,
        "requestId": request_id,
    });
    if let Some(ms) = retry_after_ms {
        if let Some(obj) = error.as_object_mut() {
            obj.insert("retryAfterMs".into(), serde_json::json!(ms));
        }
    }
    emit_or_log(
        app_handle,
        "ollama-completion",
        serde_json::json!({ "done": true, "error": error }),
    );
    // Also emit normalized error event when StreamEvent v1 is enabled
    if is_stream_v1_enabled() {
        let evt = serde_json::json!({
            "type": "error",
            "code": code,
            "detail": detail,
        });
        emit_or_log(
            app_handle,
            crate::events::EVENT_STREAM_V1,
            serde_json::json!({ "requestId": request_id, "event": evt }),
        );
        // Terminal done after error for v1 channel
        let done_evt = serde_json::json!({ "type": "done" });
        emit_or_log(
            app_handle,
            crate::events::EVENT_STREAM_V1,
            serde_json::json!({ "requestId": request_id, "event": done_evt }),
        );
    }
}

// AppState is re-exported from core

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

#[derive(Debug, Serialize)]
struct AgentsConfigLoadResult {
    exists: bool,
    contents: Option<String>,
    path: String,
}

const AGENTS_CONFIG_MAX_SIZE_BYTES: usize = 512 * 1024; // 512 KiB safety cap
const AGENTS_CONFIG_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../config/agents.yaml.template"
));

fn agents_config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let resolver = app.path();
    let base = resolver
        .app_data_dir()
        .map_err(|err| format!("E-UICP-AGENTS-PATH: {}", err))?;
    Ok(base.join("uicp").join("agents.yaml"))
}

#[tauri::command]
async fn load_agents_config_file(app: tauri::AppHandle) -> Result<AgentsConfigLoadResult, String> {
    let path = agents_config_path(&app)?;
    let path_display = path.display().to_string();
    match fs::read_to_string(&path).await {
        Ok(contents) => Ok(AgentsConfigLoadResult {
            exists: true,
            contents: Some(contents),
            path: path_display,
        }),
        Err(err) if err.kind() == ErrorKind::NotFound => {
            if AGENTS_CONFIG_TEMPLATE.len() > AGENTS_CONFIG_MAX_SIZE_BYTES {
                return Err(format!(
                    "E-UICP-AGENTS-TEMPLATE-SIZE: template {} bytes exceeds limit {}",
                    AGENTS_CONFIG_TEMPLATE.len(),
                    AGENTS_CONFIG_MAX_SIZE_BYTES
                ));
            }
            if let Some(parent) = path.parent() {
                if let Err(mkdir_err) = fs::create_dir_all(parent).await {
                    log_error(format!(
                        "agents config mkdir failed at {}: {}",
                        parent.display(),
                        mkdir_err
                    ));
                    return Err(format!("E-UICP-AGENTS-MKDIR: {}", mkdir_err));
                }
            }
            let tmp_path = path.with_extension("yaml.tmp");
            if let Err(write_err) = fs::write(&tmp_path, AGENTS_CONFIG_TEMPLATE.as_bytes()).await {
                log_error(format!(
                    "agents config temp write failed at {}: {}",
                    tmp_path.display(),
                    write_err
                ));
                return Err(format!("E-UICP-AGENTS-WRITE-TMP: {}", write_err));
            }
            if fs::metadata(&path).await.is_ok() {
                if let Err(remove_err) = fs::remove_file(&path).await {
                    log_error(format!(
                        "agents config remove existing failed at {}: {}",
                        path_display, remove_err
                    ));
                    let _ = fs::remove_file(&tmp_path).await;
                    return Err(format!("E-UICP-AGENTS-REMOVE: {}", remove_err));
                }
            }
            if let Err(rename_err) = fs::rename(&tmp_path, &path).await {
                log_error(format!(
                    "agents config commit rename failed at {}: {}",
                    path_display, rename_err
                ));
                let _ = fs::remove_file(&tmp_path).await;
                return Err(format!("E-UICP-AGENTS-RENAME: {}", rename_err));
            }
            log_info(format!(
                "Bootstrapped agents.yaml from template at {}",
                path_display
            ));
            Ok(AgentsConfigLoadResult {
                exists: true,
                contents: Some(AGENTS_CONFIG_TEMPLATE.to_string()),
                path: path_display,
            })
        }
        Err(err) => {
            log_error(format!(
                "agents config read failed at {}: {}",
                path_display, err
            ));
            Err(format!("E-UICP-AGENTS-READ: {}", err))
        }
    }
}

#[tauri::command]
async fn save_agents_config_file(app: tauri::AppHandle, contents: String) -> Result<(), String> {
    if contents.len() > AGENTS_CONFIG_MAX_SIZE_BYTES {
        return Err(format!(
            "E-UICP-AGENTS-SIZE: payload {} bytes exceeds limit {}",
            contents.len(),
            AGENTS_CONFIG_MAX_SIZE_BYTES
        ));
    }

    let path = agents_config_path(&app)?;
    let path_display = path.display().to_string();
    if let Some(parent) = path.parent() {
        if let Err(err) = fs::create_dir_all(parent).await {
            log_error(format!(
                "agents config mkdir failed at {}: {}",
                parent.display(),
                err
            ));
            return Err(format!("E-UICP-AGENTS-MKDIR: {}", err));
        }
    }

    // Write contents using a temporary file for best-effort atomicity on supported platforms.
    let tmp_path = path.with_extension("yaml.tmp");
    if let Err(err) = fs::write(&tmp_path, contents.as_bytes()).await {
        log_error(format!(
            "agents config temp write failed at {}: {}",
            tmp_path.display(),
            err
        ));
        return Err(format!("E-UICP-AGENTS-WRITE-TMP: {}", err));
    }

    // Replace existing file. On Windows rename fails if target exists; remove old file first.
    if fs::metadata(&path).await.is_ok() {
        if let Err(err) = fs::remove_file(&path).await {
            log_error(format!(
                "agents config remove existing failed at {}: {}",
                path_display, err
            ));
            let _ = fs::remove_file(&tmp_path).await;
            return Err(format!("E-UICP-AGENTS-REMOVE: {}", err));
        }
    }

    if let Err(err) = fs::rename(&tmp_path, &path).await {
        log_error(format!(
            "agents config commit rename failed at {}: {}",
            path_display, err
        ));
        let _ = fs::remove_file(&tmp_path).await;
        return Err(format!("E-UICP-AGENTS-RENAME: {}", err));
    }

    Ok(())
}

#[tauri::command]


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
    // Accept structured developer payloads (objects) and legacy string messages.
    content: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatCompletionRequest {
    model: Option<String>,
    messages: Vec<ChatMessageInput>,
    stream: Option<bool>,
    tools: Option<serde_json::Value>,
    format: Option<serde_json::Value>,
    #[serde(rename = "response_format")]
    response_format: Option<serde_json::Value>,
    #[serde(rename = "tool_choice")]
    tool_choice: Option<serde_json::Value>,
    reasoning: Option<serde_json::Value>,
    options: Option<serde_json::Value>,
}


#[tauri::command]
async fn load_api_key(_state: State<'_, AppState>) -> Result<Option<String>, String> {
    // Do not return plaintext secrets via Tauri commands.
    Ok(None)
}

#[tauri::command]
async fn set_debug(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    *state.debug_enabled.write().await = enabled;
    Ok(())
}

#[tauri::command]
async fn save_api_key(_state: State<'_, AppState>, key: String) -> Result<(), String> {
    let key_trimmed = key.trim().to_string();
    // Store in embedded keystore under uicp:ollama:api_key
    let ks = get_or_init_keystore().await.map_err(|e| e.to_string())?;
    ks.secret_set("uicp", "ollama:api_key", SecretString::new(key_trimmed))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn test_api_key(
    state: State<'_, AppState>,
    window: tauri::Window,
) -> Result<ApiKeyStatus, String> {
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
        let headers = build_provider_headers("ollama")
            .await
            .map_err(|e| e.to_string())?;
        for (k, v) in headers.into_iter() {
            req = req.header(k, v);
        }
    }
    let result = req.send().await.map_err(|e| format!("HTTP error: {e}"))?;

    if result.status().is_success() {
        emit_or_log(
            &window.app_handle(),
            "api-key-status",
            ApiKeyStatus {
                valid: true,
                message: Some("API key validated against Ollama Cloud".into()),
            },
        );
        Ok(ApiKeyStatus {
            valid: true,
            message: Some("API key validated against Ollama Cloud".into()),
        })
    } else {
        let msg = format!("Ollama responded with status {}", result.status());
        emit_or_log(
            &window.app_handle(),
            "api-key-status",
            ApiKeyStatus {
                valid: false,
                message: Some(msg.clone()),
            },
        );
        Ok(ApiKeyStatus {
            valid: false,
            message: Some(msg),
        })
    }
}
// EASTER EGG ^.^ - IF YOU SEE THIS, THANK YOU FROM THE BOTTOM OF MY HEART FOR EVEN READING MY FILES. THIS IS THE FIRST
// TIME I'VE EVER DONE THIS AND I REALLY BELIEVE IF THIS GETS TO WHAT I THINK IT CAN BE, IT COULD CHANGE HOW WE INTERACT WITH AI ON THE DAY to DAY.
#[tauri::command]
async fn persist_command(state: State<'_, AppState>, cmd: CommandRequest) -> Result<(), String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("persist_command", id = %cmd.id, tool = %cmd.tool);
    // Freeze writes in Safe Mode
    if *state.safe_mode.read().await {
        return Ok(());
    }
    let id = cmd.id.clone();
    let tool = cmd.tool.clone();
    let args_json = serde_json::to_string(&cmd.args).map_err(|e| format!("{e}"))?;
    #[cfg(feature = "otel_spans")]
    let started = Instant::now();
    let res = state
        .db_rw
        .call(move |conn| -> tokio_rusqlite::Result<()> {
            let now = Utc::now().timestamp();
            conn.execute(
                "INSERT INTO tool_call (id, workspace_id, tool, args_json, result_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
                params![id, "default", tool, args_json, now],
            )
            .map(|_| ())
            .map_err(tokio_rusqlite::Error::from)
        })
        .await;
    #[cfg(feature = "otel_spans")]
    {
        let ms = started.elapsed().as_millis() as i64;
        match &res {
            Ok(_) => tracing::info!(target = "uicp", duration_ms = ms, "command persisted"),
            Err(e) => {
                tracing::warn!(target = "uicp", duration_ms = ms, error = %e, "command persist failed")
            }
        }
    }
    res.map_err(|e| format!("DB error: {e:?}"))?;
    Ok(())
}

#[tauri::command]
async fn get_workspace_commands(state: State<'_, AppState>) -> Result<Vec<CommandRequest>, String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("load_commands");
    #[cfg(feature = "otel_spans")]
    let started = Instant::now();
    let res = state
        .db_ro
        .call(|conn| -> tokio_rusqlite::Result<Vec<CommandRequest>> {
            let mut stmt = conn
                .prepare(
                    "SELECT id, tool, args_json FROM tool_call
                 WHERE workspace_id = ?1
                 ORDER BY created_at ASC",
                )
                .map_err(tokio_rusqlite::Error::from)?;
            let rows = stmt
                .query_map(params!["default"], |row| {
                    let id: String = row.get(0)?;
                    let tool: String = row.get(1)?;
                    let args_json: String = row.get(2)?;
                    let args = serde_json::from_str(&args_json)
                        .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
                    Ok(CommandRequest { id, tool, args })
                })
                .map_err(tokio_rusqlite::Error::from)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(tokio_rusqlite::Error::from)?;
            Ok(rows)
        })
        .await;
    #[cfg(feature = "otel_spans")]
    {
        let ms = started.elapsed().as_millis() as i64;
        match &res {
            Ok(v) => tracing::info!(
                target = "uicp",
                duration_ms = ms,
                count = v.len(),
                "commands loaded"
            ),
            Err(e) => {
                tracing::warn!(target = "uicp", duration_ms = ms, error = %e, "commands load failed")
            }
        }
    }
    let commands = res.map_err(|e| format!("DB error: {e:?}"))?;
    Ok(commands)
}

#[tauri::command]
async fn clear_workspace_commands(state: State<'_, AppState>) -> Result<(), String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("clear_commands");
    #[cfg(feature = "otel_spans")]
    let _started = Instant::now(); // WHY: Silence dead_code when spans disabled; still track duration where enabled.
    let res = state
        .db_rw
        .call(|conn| -> tokio_rusqlite::Result<()> {
            conn.execute(
                "DELETE FROM tool_call WHERE workspace_id = ?1",
                params!["default"],
            )
            .map(|_| ())
            .map_err(tokio_rusqlite::Error::from)
        })
        .await;
    #[cfg(feature = "otel_spans")]
    {
        let ms = _started.elapsed().as_millis() as i64;
        match &res {
            Ok(_) => tracing::info!(target = "uicp", duration_ms = ms, "commands cleared"),
            Err(e) => {
                tracing::warn!(target = "uicp", duration_ms = ms, error = %e, "commands clear failed")
            }
        }
    }
    res.map_err(|e| format!("DB error: {e:?}"))?;
    Ok(())
}

#[tauri::command]
async fn delete_window_commands(
    state: State<'_, AppState>,
    window_id: String,
) -> Result<(), String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("delete_window_commands", window_id = %window_id);
    state
        .db_rw
        .call(move |conn| {
            // Try JSON1-powered delete; fallback to manual filter if JSON1 is unavailable.
            let sql = "DELETE FROM tool_call
                 WHERE workspace_id = ?1
                 AND (
                     (tool = 'window.create' AND json_extract(args_json, '$.id') = ?2)
                     OR json_extract(args_json, '$.windowId') = ?2
                 )";
            match conn.execute(sql, params!["default", window_id.clone()]) {
                Ok(_) => Ok(()),
                Err(rusqlite::Error::SqliteFailure(_, Some(msg)))
                    if msg.contains("no such function: json_extract") =>
                {
                    let mut stmt = conn
                        .prepare(
                            "SELECT id, tool, args_json FROM tool_call WHERE workspace_id = ?1",
                        )
                        .map_err(tokio_rusqlite::Error::from)?;
                    let rows = stmt
                        .query_map(params!["default"], |row| {
                            let id: String = row.get(0)?;
                            let tool: String = row.get(1)?;
                            let args_json: String = row.get(2)?;
                            Ok((id, tool, args_json))
                        })
                        .map_err(tokio_rusqlite::Error::from)?
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(tokio_rusqlite::Error::from)?;
                    drop(stmt);
                    let mut to_delete: Vec<String> = Vec::new();
                    for (id, tool, args_json) in rows.into_iter() {
                        let parsed: serde_json::Value = serde_json::from_str(&args_json)
                            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
                        let id_match = if tool == "window.create" {
                            parsed
                                .get("id")
                                .and_then(|v| v.as_str())
                                .map(|s| s == window_id)
                                .unwrap_or(false)
                        } else {
                            parsed
                                .get("windowId")
                                .and_then(|v| v.as_str())
                                .map(|s| s == window_id)
                                .unwrap_or(false)
                        };
                        if id_match {
                            to_delete.push(id);
                        }
                    }
                    if !to_delete.is_empty() {
                        let tx = conn.transaction().map_err(tokio_rusqlite::Error::from)?;
                        for id in to_delete {
                            tx.execute("DELETE FROM tool_call WHERE id = ?1", params![id])
                                .map_err(tokio_rusqlite::Error::from)?;
                        }
                        tx.commit().map_err(tokio_rusqlite::Error::from)?;
                    }
                    Ok(())
                }
                Err(e) => Err(e.into()),
            }
        })
        .await
        .map_err(|e| format!("DB error: {e:?}"))?;
    Ok(())
}

#[tauri::command]
async fn load_workspace(state: State<'_, AppState>) -> Result<Vec<WindowStatePayload>, String> {
    let windows = state
        .db_ro
        .call(|conn| -> tokio_rusqlite::Result<Vec<WindowStatePayload>> {
            let mut stmt = conn
                .prepare(
                    "SELECT id, title, COALESCE(x, 40), COALESCE(y, 40), COALESCE(width, 640), \
                 COALESCE(height, 480), COALESCE(z_index, 0)
                 FROM window WHERE workspace_id = ?1 ORDER BY z_index ASC, created_at ASC",
                )
                .map_err(tokio_rusqlite::Error::from)?;
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
                })
                .map_err(tokio_rusqlite::Error::from)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(tokio_rusqlite::Error::from)?;
            Ok(if rows.is_empty() {
                vec![WindowStatePayload {
                    id: uuid::Uuid::new_v4().to_string(),
                    title: "Welcome".into(),
                    x: 60.0,
                    y: 60.0,
                    width: 720.0,
                    height: 420.0,
                    z_index: 0,
                    content: Some(
                        "<h2>Welcome to UICP</h2><p>Start asking Gui (Guy) to build an app.</p>"
                            .into(),
                    ),
                }]
            } else {
                rows
            })
        })
        .await
        .map_err(|e| format!("DB error: {e:?}"))?;

    Ok(windows)
}

#[tauri::command]
async fn save_workspace(
    window: tauri::Window,
    state: State<'_, AppState>,
    windows: Vec<WindowStatePayload>,
) -> Result<(), String> {
    let save_res = state
        .db_rw
        .call(move |conn| -> tokio_rusqlite::Result<()> {
            let tx = conn.transaction().map_err(tokio_rusqlite::Error::from)?;
            tx.execute(
                "DELETE FROM window WHERE workspace_id = ?1",
                params!["default"],
            )
            .map_err(tokio_rusqlite::Error::from)?;
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
                )
                .map_err(tokio_rusqlite::Error::from)?;
            }
            tx.execute(
                "UPDATE workspace SET updated_at = ?1 WHERE id = ?2",
                params![now, "default"],
            )
            .map_err(tokio_rusqlite::Error::from)?;
            tx.commit().map_err(tokio_rusqlite::Error::from)?;
            Ok(())
        })
        .await;

    match save_res {
        Ok(_) => {
            *state.last_save_ok.write().await = true;
            emit_or_log(
                &window.app_handle(),
                "save-indicator",
                SaveIndicatorPayload {
                    ok: true,
                    timestamp: Utc::now().timestamp(),
                },
            );
            Ok(())
        }
        Err(err) => {
            *state.last_save_ok.write().await = false;
            emit_or_log(
                &window.app_handle(),
                "save-indicator",
                SaveIndicatorPayload {
                    ok: false,
                    timestamp: Utc::now().timestamp(),
                },
            );
            Err(format!("DB error: {err:?}"))
        }
    }
}


fn normalize_model_name(raw: &str, use_cloud: bool) -> String {
    let trimmed = raw.trim();
    let (base_part, had_cloud_suffix) = if let Some(stripped) = trimmed.strip_suffix("-cloud") {
        (stripped, true)
    } else {
        (trimmed, false)
    };

    let normalize_base = |input: &str| {
        if input.contains(':') {
            input.to_string()
        } else if let Some(idx) = input.rfind('-') {
            let (prefix, suffix) = input.split_at(idx);
            let suffix = suffix.trim_start_matches('-');
            format!("{}:{}", prefix, suffix)
        } else {
            input.to_string()
        }
    };

    if use_cloud {
        normalize_base(base_part)
    } else {
        let base = normalize_base(base_part);
        if had_cloud_suffix {
            format!("{}-cloud", base)
        } else {
            base
        }
    }
}

// Feature flag: enable backend emission of normalized StreamEvent v1 alongside legacy events
fn is_stream_v1_enabled() -> bool {
    match std::env::var("UICP_STREAM_V1") {
        Ok(v) => {
            let s = v.trim().to_ascii_lowercase();
            matches!(s.as_str(), "1" | "true" | "on" | "yes")
        }
        Err(_) => false,
    }
}

// Minimal extractor that converts OpenAI-like delta JSON into StreamEvent v1 events.
// Assumes Anthropic has been pre-normalized to OpenAI-like deltas via anthropic::normalize_message.
fn extract_events_from_chunk(
    chunk: &serde_json::Value,
    default_channel: Option<&str>,
) -> Vec<serde_json::Value> {
    use serde_json::Value;
    let mut events: Vec<Value> = Vec::new();

    let push_content = |events: &mut Vec<Value>, channel: Option<&str>, text: &str| {
        if text.trim().is_empty() {
            return;
        }
        let mut evt = serde_json::json!({
            "type": "content",
            "text": text,
        });
        if let Some(ch) = channel {
            if let Some(obj) = evt.as_object_mut() {
                obj.insert("channel".into(), serde_json::json!(ch));
            }
        }
        events.push(evt);
    };

    let push_tool_call = |events: &mut Vec<Value>,
                          index: i64,
                          id: Option<&str>,
                          name: Option<&str>,
                          arguments: Value| {
        let mut evt = serde_json::json!({
            "type": "tool_call",
            "index": index,
            "arguments": arguments,
            "isDelta": true,
        });
        if let Some(i) = id {
            if let Some(obj) = evt.as_object_mut() {
                obj.insert("id".into(), serde_json::json!(i));
            }
        }
        if let Some(n) = name {
            if let Some(obj) = evt.as_object_mut() {
                obj.insert("name".into(), serde_json::json!(n));
            }
        }
        events.push(evt);
    };

    // Helper: handle content values that may be string, array of parts, or object
    fn handle_content_value(
        events: &mut Vec<Value>,
        channel: Option<&str>,
        value: &Value,
        push_content: &dyn Fn(&mut Vec<Value>, Option<&str>, &str),
        push_tool_call: &dyn Fn(&mut Vec<Value>, i64, Option<&str>, Option<&str>, Value),
    ) {
        match value {
            Value::String(s) => {
                push_content(events, channel, s);
            }
            Value::Array(arr) => {
                for entry in arr {
                    if let Value::String(s) = entry {
                        push_content(events, channel, s);
                        continue;
                    }
                    if let Value::Object(map) = entry {
                        if let Some(t) = map.get("type").and_then(|v| v.as_str()) {
                            // Some providers encode tool deltas inside content array
                            if t.eq_ignore_ascii_case("tool_call")
                                || t.eq_ignore_ascii_case("tool_call_delta")
                            {
                                let index = map.get("index").and_then(|v| v.as_i64()).unwrap_or(0);
                                // function or delta.function may contain arguments/name
                                let function_obj = map
                                    .get("function")
                                    .or_else(|| map.get("delta").and_then(|d| d.get("function")));
                                let name = map.get("name").and_then(|v| v.as_str()).or_else(|| {
                                    function_obj
                                        .and_then(|f| f.get("name").and_then(|v| v.as_str()))
                                });
                                let arguments = map
                                    .get("arguments")
                                    .cloned()
                                    .or_else(|| {
                                        function_obj.and_then(|f| f.get("arguments").cloned())
                                    })
                                    .unwrap_or_else(|| Value::Null);
                                let id = map
                                    .get("id")
                                    .and_then(|v| v.as_str())
                                    .or_else(|| map.get("tool_call_id").and_then(|v| v.as_str()));
                                push_tool_call(events, index, id, name, arguments);
                                continue;
                            }
                        }
                        if let Some(text) = map.get("text").and_then(|v| v.as_str()) {
                            push_content(events, channel, text);
                            continue;
                        }
                        if let Some(val) = map.get("value").and_then(|v| v.as_str()) {
                            push_content(events, channel, val);
                            continue;
                        }
                    }
                }
            }
            Value::Object(obj) => {
                if let Some(text) = obj.get("text").and_then(|v| v.as_str()) {
                    push_content(events, channel, text);
                } else if let Some(val) = obj.get("value").and_then(|v| v.as_str()) {
                    push_content(events, channel, val);
                }
            }
            _ => {}
        }
    }

    // 1) OpenAI-like choices[].delta...
    if let Some(choices) = chunk.get("choices").and_then(|v| v.as_array()) {
        for ch in choices {
            let delta = ch
                .get("delta")
                .or_else(|| ch.get("message"))
                .or_else(|| ch.get("update"));
            if let Some(d) = delta.and_then(|v| v.as_object()) {
                if let Some(content_val) = d.get("content") {
                    handle_content_value(
                        &mut events,
                        default_channel,
                        content_val,
                        &push_content,
                        &push_tool_call,
                    );
                }
                if let Some(tool_calls) = d.get("tool_calls").and_then(|v| v.as_array()) {
                    for (idx, tc) in tool_calls.iter().enumerate() {
                        let index = d
                            .get("index")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(idx as i64);
                        let id = tc
                            .get("id")
                            .and_then(|v| v.as_str())
                            .or_else(|| tc.get("tool_call_id").and_then(|v| v.as_str()));
                        let name = tc.get("name").and_then(|v| v.as_str()).or_else(|| {
                            tc.get("function")
                                .and_then(|f| f.get("name").and_then(|v| v.as_str()))
                        });
                        let arguments = tc
                            .get("arguments")
                            .cloned()
                            .or_else(|| {
                                tc.get("function").and_then(|f| f.get("arguments").cloned())
                            })
                            .unwrap_or_else(|| Value::Null);
                        push_tool_call(&mut events, index, id, name, arguments);
                    }
                }
                if let Some(tool_call) = d.get("tool_call") {
                    let id = tool_call
                        .get("id")
                        .and_then(|v| v.as_str())
                        .or_else(|| tool_call.get("tool_call_id").and_then(|v| v.as_str()));
                    let name = tool_call.get("name").and_then(|v| v.as_str()).or_else(|| {
                        tool_call
                            .get("function")
                            .and_then(|f| f.get("name").and_then(|v| v.as_str()))
                    });
                    let arguments = tool_call
                        .get("arguments")
                        .cloned()
                        .or_else(|| {
                            tool_call
                                .get("function")
                                .and_then(|f| f.get("arguments").cloned())
                        })
                        .unwrap_or_else(|| Value::Null);
                    push_tool_call(&mut events, 0, id, name, arguments);
                }
            }
        }
    }

    // 2) Root-level delta.tool_calls
    if let Some(delta) = chunk.get("delta").and_then(|v| v.as_object()) {
        if let Some(tool_calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
            for (idx, tc) in tool_calls.iter().enumerate() {
                let id = tc
                    .get("id")
                    .and_then(|v| v.as_str())
                    .or_else(|| tc.get("tool_call_id").and_then(|v| v.as_str()));
                let name = tc.get("name").and_then(|v| v.as_str()).or_else(|| {
                    tc.get("function")
                        .and_then(|f| f.get("name").and_then(|v| v.as_str()))
                });
                let arguments = tc
                    .get("arguments")
                    .cloned()
                    .or_else(|| tc.get("function").and_then(|f| f.get("arguments").cloned()))
                    .unwrap_or_else(|| Value::Null);
                push_tool_call(&mut events, idx as i64, id, name, arguments);
            }
        }
    }

    // 3) Root-level tool_calls
    if let Some(tool_calls) = chunk.get("tool_calls").and_then(|v| v.as_array()) {
        for (idx, tc) in tool_calls.iter().enumerate() {
            let id = tc
                .get("id")
                .and_then(|v| v.as_str())
                .or_else(|| tc.get("tool_call_id").and_then(|v| v.as_str()));
            let name = tc.get("name").and_then(|v| v.as_str()).or_else(|| {
                tc.get("function")
                    .and_then(|f| f.get("name").and_then(|v| v.as_str()))
            });
            let arguments = tc
                .get("arguments")
                .cloned()
                .or_else(|| tc.get("function").and_then(|f| f.get("arguments").cloned()))
                .unwrap_or_else(|| Value::Null);
            push_tool_call(&mut events, idx as i64, id, name, arguments);
        }
    }

    // 4) Root-level content or message.content
    if let Some(content) = chunk.get("content") {
        handle_content_value(
            &mut events,
            default_channel,
            content,
            &push_content,
            &push_tool_call,
        );
    }
    if let Some(msg) = chunk.get("message").and_then(|v| v.as_object()) {
        if let Some(content) = msg.get("content") {
            handle_content_value(
                &mut events,
                default_channel,
                content,
                &push_content,
                &push_tool_call,
            );
        }
        if let Some(tcs) = msg.get("tool_calls").and_then(|v| v.as_array()) {
            for (idx, tc) in tcs.iter().enumerate() {
                let id = tc
                    .get("id")
                    .and_then(|v| v.as_str())
                    .or_else(|| tc.get("tool_call_id").and_then(|v| v.as_str()));
                let name = tc.get("name").and_then(|v| v.as_str()).or_else(|| {
                    tc.get("function")
                        .and_then(|f| f.get("name").and_then(|v| v.as_str()))
                });
                let arguments = tc
                    .get("arguments")
                    .cloned()
                    .or_else(|| tc.get("function").and_then(|f| f.get("arguments").cloned()))
                    .unwrap_or_else(|| Value::Null);
                push_tool_call(&mut events, idx as i64, id, name, arguments);
            }
        }
    }

    events
}


// Database schema management is implemented in core::init_database and helpers.

// Deprecated: legacy keyring/env migration is removed. Embedded keystore is the only source of provider keys.

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

async fn maybe_enable_local_ollama(state: &AppState) {
    let allow_local = *state.allow_local_opt_in.read().await;
    if !allow_local {
        *state.use_direct_cloud.write().await = true;
        return;
    }

    let client = state.http.clone();
    let url = format!("{}/models", crate::core::OLLAMA_LOCAL_BASE_DEFAULT);
    let ok = match tokio::time::timeout(Duration::from_millis(600), client.get(url).send()).await {
        Ok(Ok(resp)) => resp.status().is_success(),
        _ => false,
    };

    let mut use_cloud = state.use_direct_cloud.write().await;
    *use_cloud = !ok;
}

#[tauri::command]
async fn set_allow_local_opt_in(state: State<'_, AppState>, allow: bool) -> Result<(), String> {
    {
        let mut allow_guard = state.allow_local_opt_in.write().await;
        *allow_guard = allow;
    }

    if allow {
        {
            let mut use_cloud = state.use_direct_cloud.write().await;
            *use_cloud = false;
        }
        maybe_enable_local_ollama(&state).await;
    } else {
        *state.use_direct_cloud.write().await = true;
    }
    Ok(())
}

#[tauri::command]
async fn get_ollama_mode(state: State<'_, AppState>) -> Result<(bool, bool), String> {
    Ok((
        *state.use_direct_cloud.read().await,
        *state.allow_local_opt_in.read().await,
    ))
}

#[cfg(test)]
mod tests {
    use super::extract_events_from_chunk;
    use super::normalize_model_name;
    use crate::anthropic;
    use serde_json::json;

    #[test]
    fn cloud_keeps_colon_tags() {
        assert_eq!(normalize_model_name("llama3:70b", true), "llama3:70b");
    }

    #[test]
    fn cloud_strips_trailing_cloud_suffix() {
        assert_eq!(normalize_model_name("llama3:70b-cloud", true), "llama3:70b");
    }

    #[test]
    fn cloud_converts_hyphenated_form() {
        assert_eq!(normalize_model_name("llama3-70b", true), "llama3:70b");
    }

    #[test]
    fn local_converts_hyphenated_form_to_colon() {
        assert_eq!(normalize_model_name("llama3-70b", false), "llama3:70b");
    }

    #[test]
    fn local_preserves_colon_for_daemon() {
        assert_eq!(normalize_model_name("llama3:70b", false), "llama3:70b");
    }

    #[test]
    fn extract_content_from_openai_delta() {
        let v = json!({
            "choices": [{ "delta": { "content": "Hello" } }]
        });
        let events = extract_events_from_chunk(&v, None);
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.get("type").and_then(|v| v.as_str()), Some("content"));
        assert_eq!(e.get("text").and_then(|v| v.as_str()), Some("Hello"));
        assert!(e.get("channel").is_none());
    }

    #[test]
    fn extract_tool_call_from_openai_delta() {
        let v = json!({
            "choices": [{
                "delta": { "tool_calls": [{
                    "index": 0,
                    "id": "call_1",
                    "function": { "name": "foo", "arguments": "{\"a\":1}" }
                }]}
            }]
        });
        let events = extract_events_from_chunk(&v, None);
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.get("type").and_then(|v| v.as_str()), Some("tool_call"));
        assert_eq!(e.get("index").and_then(|v| v.as_i64()), Some(0));
        assert_eq!(e.get("id").and_then(|v| v.as_str()), Some("call_1"));
        assert_eq!(e.get("name").and_then(|v| v.as_str()), Some("foo"));
    }

    #[test]
    fn extract_from_message_object_and_root_tool_calls() {
        let v = json!({
            "message": { "content": [ {"type":"text","text":"Hi"} ], "tool_calls": [{
                "id": "abc",
                "function": { "name": "bar", "arguments": "{}" }
            }]},
            "tool_calls": [{ "name": "baz", "arguments": "{}" }]
        });
        let events = extract_events_from_chunk(&v, None);
        assert!(events
            .iter()
            .any(|e| e.get("type").and_then(|v| v.as_str()) == Some("content")));
        assert!(
            events
                .iter()
                .filter(|e| e.get("type").and_then(|v| v.as_str()) == Some("tool_call"))
                .count()
                >= 2
        );
    }

    #[test]
    fn default_channel_is_injected_for_json() {
        let v = json!({ "content": [{"type":"text","text":"A"}] });
        let events = extract_events_from_chunk(&v, Some("json"));
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.get("type").and_then(|v| v.as_str()), Some("content"));
        assert_eq!(e.get("channel").and_then(|v| v.as_str()), Some("json"));
    }

    #[test]
    fn anthropic_text_delta_normalizes_to_content() {
        let raw = json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "text_delta", "text": "Hi" }
        });
        let normalized = anthropic::normalize_message(raw).expect("normalize");
        let events = extract_events_from_chunk(&normalized, Some("json"));
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.get("type").and_then(|v| v.as_str()), Some("content"));
        assert_eq!(e.get("text").and_then(|v| v.as_str()), Some("Hi"));
        assert_eq!(e.get("channel").and_then(|v| v.as_str()), Some("json"));
    }

    #[test]
    fn anthropic_tool_use_start_normalizes_to_tool_call() {
        let raw = json!({
            "type": "content_block_start",
            "index": 0,
            "content_block": {
                "type": "tool_use",
                "id": "tool_abc",
                "name": "run_cmd",
                "input": { "cmd": "echo hi" }
            }
        });
        let normalized = anthropic::normalize_message(raw).expect("normalize");
        let events = extract_events_from_chunk(&normalized, Some("json"));
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.get("type").and_then(|v| v.as_str()), Some("tool_call"));
        assert_eq!(e.get("id").and_then(|v| v.as_str()), Some("tool_abc"));
        assert_eq!(e.get("name").and_then(|v| v.as_str()), Some("run_cmd"));
    }

    #[test]
    fn openai_delta_content_injects_json_channel() {
        let v = json!({
            "choices": [{ "delta": { "content": "Hello" } }]
        });
        let events = extract_events_from_chunk(&v, Some("json"));
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.get("type").and_then(|v| v.as_str()), Some("content"));
        assert_eq!(e.get("text").and_then(|v| v.as_str()), Some("Hello"));
        assert_eq!(e.get("channel").and_then(|v| v.as_str()), Some("json"));
    }

    #[test]
    fn openrouter_delta_tool_calls_maps_to_tool_call() {
        let v = json!({
            "choices": [{
                "delta": { "tool_calls": [{
                    "index": 0,
                    "id": "call_0",
                    "function": { "name": "emit_batch", "arguments": "{\"batch\":[]}" }
                }]}
            }]
        });
        let events = extract_events_from_chunk(&v, Some("json"));
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.get("type").and_then(|v| v.as_str()), Some("tool_call"));
        assert_eq!(e.get("index").and_then(|v| v.as_i64()), Some(0));
        assert_eq!(e.get("id").and_then(|v| v.as_str()), Some("call_0"));
        assert_eq!(e.get("name").and_then(|v| v.as_str()), Some("emit_batch"));
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

// emit_or_log and remove_compute_job are re-exported from core

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

/// Spawn periodic database maintenance task for WAL checkpointing and vacuuming.
///
/// Runs every 24 hours by default (configurable via UICP_DB_MAINTENANCE_INTERVAL_HOURS).
/// Performs:
/// - WAL checkpoint (TRUNCATE) to prevent unbounded WAL growth
/// - PRAGMA optimize for query planner statistics
/// - VACUUM every 7 days to reclaim fragmented space
fn spawn_db_maintenance(app_handle: tauri::AppHandle) {
    spawn(async move {
        let interval_hours = std::env::var("UICP_DB_MAINTENANCE_INTERVAL_HOURS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(24);

        let vacuum_interval_days = std::env::var("UICP_DB_VACUUM_INTERVAL_DAYS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(7);

        let mut ticker = interval(Duration::from_secs(interval_hours * 60 * 60));
        let mut ticks_since_vacuum = 0u64;
        let ticks_per_vacuum = (vacuum_interval_days * 24) / interval_hours;

        loop {
            ticker.tick().await;
            let state: State<'_, AppState> = app_handle.state();

            // Skip maintenance in safe mode to avoid interfering with recovery
            if *state.safe_mode.read().await {
                continue;
            }

            #[cfg(feature = "otel_spans")]
            let _span = tracing::info_span!(
                "db_maintenance",
                run_vacuum = ticks_since_vacuum >= ticks_per_vacuum
            );
            #[cfg(feature = "otel_spans")]
            let started = Instant::now();

            let should_vacuum = ticks_since_vacuum >= ticks_per_vacuum;
            ticks_since_vacuum += 1;

            let res = state
                .db_rw
                .call(
                    move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
                        // Always checkpoint and optimize
                        c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;")
                            .map_err(tokio_rusqlite::Error::from)?;
                        // Periodically vacuum to reclaim fragmented space
                        if should_vacuum {
                            c.execute_batch("VACUUM;")
                                .map_err(tokio_rusqlite::Error::from)?;
                        }

                        Ok(())
                    },
                )
                .await;

            match &res {
                Ok(_) => {
                    if should_vacuum {
                        ticks_since_vacuum = 0;
                    }
                    #[cfg(feature = "otel_spans")]
                    {
                        let ms = started.elapsed().as_millis() as i64;
                        tracing::info!(
                            target = "uicp",
                            duration_ms = ms,
                            vacuumed = should_vacuum,
                            "db maintenance completed"
                        );
                    }
                }
                Err(e) => {
                    log_error(format!("Database maintenance failed: {e:?}"));
                    #[cfg(feature = "otel_spans")]
                    {
                        let ms = started.elapsed().as_millis() as i64;
                        tracing::warn!(
                            target = "uicp",
                            duration_ms = ms,
                            error = %e,
                            "db maintenance failed"
                        );
                    }
                    // Emit diagnostic event for UI monitoring
                    let _ = app_handle.emit(
                        "db-maintenance-error",
                        serde_json::json!({
                            "error": format!("{e:?}"),
                            "timestamp": Utc::now().timestamp(),
                            "recommendation": "Database maintenance failed. Consider running health_quick_check."
                        }),
                    );
                }
            }

            #[cfg(feature = "otel_spans")]
            {
                let _ = &started; // preserve instrumentation variable usage guard
            }
        }
    });
}

fn main() {
    #[cfg(feature = "otel_spans")]
    {
        use tracing_subscriber::{fmt, EnvFilter};
        let _ = fmt()
            .with_env_filter(EnvFilter::from_default_env())
            .try_init();
        tracing::info!(target = "uicp", "tracing initialized");
    }
    #[cfg(not(feature = "otel_spans"))]
    init_tracing();
    if let Err(err) = dotenv() {
        log_warn(format!("Failed to load .env: {err:?}"));
    }

    let db_path = DB_PATH.clone();

    // Initialize database and ensure directory exists BEFORE opening connections
    if let Err(err) = init_database(&db_path) {
        log_error(format!("Failed to initialize database: {err:?}"));
        std::process::exit(1);
    }
    if let Err(err) = ensure_default_workspace(&db_path) {
        log_error(format!("Failed to ensure default workspace: {err:?}"));
        std::process::exit(1);
    }

    // Now open resident async SQLite connections (one writer, one read-only)
    let db_rw = tauri::async_runtime::block_on(AsyncConn::open(&db_path))
        .expect("open sqlite rw connection");
    let db_ro = tauri::async_runtime::block_on(AsyncConn::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ))
    .expect("open sqlite ro connection");
    // Configure connections once on startup
    tauri::async_runtime::block_on(async {
        // Writer: full configuration
        let _ = db_rw
            .call(
                |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
                    use std::time::Duration;
                    c.busy_timeout(Duration::from_millis(5_000))
                        .map_err(tokio_rusqlite::Error::from)?;
                    c.pragma_update(None, "journal_mode", "WAL")
                        .map_err(tokio_rusqlite::Error::from)?;
                    c.pragma_update(None, "synchronous", "NORMAL")
                        .map_err(tokio_rusqlite::Error::from)?;
                    c.pragma_update(None, "foreign_keys", "ON")
                        .map_err(tokio_rusqlite::Error::from)?;
                    Ok(())
                },
            )
            .await;
        // Read-only: set a subset that does not require writes
        let _ = db_ro
            .call(
                |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
                    use std::time::Duration;
                    c.busy_timeout(Duration::from_millis(5_000))
                        .map_err(tokio_rusqlite::Error::from)?;
                    c.pragma_update(None, "foreign_keys", "ON")
                        .map_err(tokio_rusqlite::Error::from)?;
                    Ok(())
                },
            )
            .await;
        // Best-effort hygiene
        let _ = db_rw
            .call(
                |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
                    c.execute_batch("PRAGMA optimize; PRAGMA wal_checkpoint(TRUNCATE);")
                        .map_err(tokio_rusqlite::Error::from)
                },
            )
            .await;
    });

    let action_log = match action_log::ActionLogService::start(&db_path) {
        Ok(handle) => handle,
        Err(err) => {
            log_error(format!("Failed to start action log service: {err:?}"));
            std::process::exit(1);
        }
    };

    if let Err(err) = action_log.append_json_blocking(
        "system.boot",
        &serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"),
            "ts": chrono::Utc::now().timestamp(),
        }),
    ) {
        log_error(format!(
            "E-UICP-0660: failed to append boot action-log entry: {err:?}"
        ));
    }

    let job_token_key: [u8; 32] = {
        if let Ok(hex_key) = std::env::var("UICP_JOB_TOKEN_KEY_HEX") {
            if let Ok(bytes) = hex::decode(hex_key.trim()) {
                if bytes.len() == 32 {
                    let mut arr = [0u8; 32];
                    arr.copy_from_slice(&bytes);
                    arr
                } else {
                    let mut arr = [0u8; 32];
                    rand::thread_rng().fill_bytes(&mut arr);
                    arr
                }
            } else {
                let mut arr = [0u8; 32];
                rand::thread_rng().fill_bytes(&mut arr);
                arr
            }
        } else {
            let mut arr = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut arr);
            arr
        }
    };

    let wasm_conc = std::env::var("UICP_WASM_CONCURRENCY")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|&n| n >= 1 && n <= 64)
        .unwrap_or(2);

    let state = AppState {
        db_path: db_path.clone(),
        db_ro,
        db_rw,
        last_save_ok: RwLock::new(true),
        ollama_key: RwLock::new(None),
        use_direct_cloud: RwLock::new(true), // default to cloud mode
        allow_local_opt_in: RwLock::new({
            let raw = std::env::var("UICP_OLLAMA_LOCAL_OPTIN").unwrap_or_default();
            matches!(raw.as_str(), "1" | "true" | "TRUE" | "yes" | "on")
        }),
        debug_enabled: RwLock::new({
            let raw = std::env::var("UICP_DEBUG").unwrap_or_default();
            matches!(raw.as_str(), "1" | "true" | "TRUE" | "yes" | "on")
        }),
        http: Client::builder()
            // Allow long-lived streaming responses; UI can cancel via cancel_chat.
            .connect_timeout(Duration::from_secs(10))
            .pool_idle_timeout(Some(Duration::from_secs(30)))
            .tcp_keepalive(Some(Duration::from_secs(30)))
            .build()
            .expect("Failed to build HTTP client"),
        ongoing: RwLock::new(HashMap::new()),
        compute_ongoing: RwLock::new(HashMap::new()),
        compute_sem: Arc::new(Semaphore::new(2)),
        codegen_sem: Arc::new(Semaphore::new(2)),
        wasm_sem: Arc::new(Semaphore::new(wasm_conc)),
        compute_cancel: RwLock::new(HashMap::new()),
        safe_mode: RwLock::new(false),
        safe_reason: RwLock::new(None),
        circuit_breakers: Arc::new(RwLock::new(HashMap::new())),
        circuit_config: CircuitBreakerConfig::from_env(),
        provider_circuit_manager: crate::provider_circuit::ProviderCircuitManager::new(),
        chaos_engine: crate::chaos::ChaosEngine::new(),
        resilience_metrics: crate::chaos::ResilienceMetrics::new(),
        action_log,
        job_token_key,
    };

    // NOTE: Environment API key loading moved to embedded keystore flows.
    // Intentionally no-op here to avoid exposing plaintext or diverging from keystore contract.

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .manage(state)
        .plugin(tauri_plugin_fs::init());

    #[cfg(all(feature = "dialog_plugin", not(feature = "compute_harness")))]
    {
        builder = builder.plugin(tauri_plugin_dialog::init());
    }

    #[cfg(any(not(feature = "dialog_plugin"), feature = "compute_harness"))]
    {
        // WHY: Compute harness binaries run in CI/headless environments or without the dialog plugin feature; skipping
        // it avoids a hard dependency on TaskDialogIndirect so tests do not fail on stripped-down Windows hosts.
    }

    builder
        .setup(|app| {
            // Ensure base data directories exist
            if let Err(e) = std::fs::create_dir_all(&*DATA_DIR) {
                log_error(format!("create data dir failed: {e:?}"));
            }
            if let Err(e) = std::fs::create_dir_all(&*LOGS_DIR) {
                log_error(format!("create logs dir failed: {e:?}"));
            }
            if let Err(e) = std::fs::create_dir_all(&*FILES_DIR) {
                log_error(format!("create files dir failed: {e:?}"));
            }
            // Ensure bundled compute modules are installed into the user modules dir
            if let Err(err) = crate::registry::install_bundled_modules_if_missing(&app.handle()) {
                log_error(format!("module install failed: {err:?}"));
            }
            spawn_autosave(app.handle().clone());
            // Periodic DB maintenance to keep WAL and stats tidy
            spawn_db_maintenance(app.handle().clone());

            #[cfg(feature = "wasm_compute")]
            {
                let handle = app.handle().clone();
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    if let Err(err) = crate::compute::prewarm_quickjs(&handle) {
                        log_warn(format!("quickjs prewarm failed: {err:?}"));
                    }
                });
            }

            // Create a native splash window using a bundled asset served by the frontend (works in dev and prod).
            let splash_html = r#"<!doctype html><html lang=\"en\"><head>
  <meta charset=\"UTF-8\">
  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">
  <meta name=\"color-scheme\" content=\"dark\">
  <title>UICP</title>
  <style>
    html,body{height:100%;margin:0}
    body{background:#0a0a0f;color:#cbd5e1;display:flex;align-items:center;justify-content:center;overflow:hidden}
    .shell{position:relative;display:flex;flex-direction:column;align-items:center;gap:42px}
    .text{font:500 11px -apple-system,BlinkMacSystemFont,Segoe UI,system-ui,sans-serif;letter-spacing:.22em;text-transform:uppercase;color:rgba(255,255,255,.6)}
    .cluster{position:relative;width:120px;height:120px}
    .hex{position:absolute;width:32px;height:32px;transform-origin:center}
    .hex::before{content:\"\";position:absolute;inset:0;background:linear-gradient(135deg,rgba(99,102,241,.4),rgba(139,92,246,.2));clip-path:polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%);animation:hex 3s ease-in-out infinite;will-change:transform,opacity}
    .hex:nth-child(3){top:0;left:44px}
    .hex:nth-child(4){top:22px;left:16px}
    .hex:nth-child(5){top:22px;left:72px}
    .hex:nth-child(6){top:44px;left:44px}
    .hex:nth-child(7){top:66px;left:16px}
    .hex:nth-child(8){top:66px;left:72px}
    .hex:nth-child(9){top:88px;left:44px}
    .hex:nth-child(3)::before{animation-delay:0s}
    .hex:nth-child(4)::before{animation-delay:.15s}
    .hex:nth-child(5)::before{animation-delay:.3s}
    .hex:nth-child(6)::before{animation-delay:.45s}
    .hex:nth-child(7)::before{animation-delay:.6s}
    .hex:nth-child(8)::before{animation-delay:.75s}
    .hex:nth-child(9)::before{animation-delay:.9s}
    .core{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:8px;height:8px;border-radius:50%;background:rgba(139,92,246,.9);box-shadow:0 0 20px rgba(139,92,246,.6),0 0 40px rgba(139,92,246,.3);animation:core 2s ease-in-out infinite}
    .ring{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);border:1px solid rgba(99,102,241,.12);border-radius:50%;animation:spin 8s linear infinite;will-change:transform}
    .ring.r2{width:180px;height:180px;animation-duration:12s;animation-direction:reverse}
    .ring.r1{width:140px;height:140px}
    body::before{content:\"\";position:absolute;inset:-50%;background:radial-gradient(circle at 30% 50%,rgba(99,102,241,.08) 0%,transparent 50%),radial-gradient(circle at 70% 50%,rgba(139,92,246,.06) 0%,transparent 50%);animation:drift 20s ease-in-out infinite}
    @keyframes hex{0%,100%{opacity:.3;transform:scale(.95)}50%{opacity:1;transform:scale(1.05)}}
    @keyframes core{0%,100%{transform:translate(-50%,-50%) scale(1);opacity:.9}50%{transform:translate(-50%,-50%) scale(1.3);opacity:1}}
    @keyframes spin{to{transform:translate(-50%,-50%) rotate(360deg)}}
    @keyframes drift{0%,100%{transform:translate(0,0) rotate(0)}33%{transform:translate(10%,-10%) rotate(120deg)}66%{transform:translate(-10%,10%) rotate(240deg)}}
    @media (prefers-reduced-motion: reduce){*,*::before{animation:none!important}}
  </style>
</head>
<body>
  <div class=\"shell\" role=\"status\" aria-live=\"polite\" aria-busy=\"true\" aria-label=\"Initializing application\">
    <div class=\"cluster\">
      <div class=\"ring r1\"></div>
      <div class=\"ring r2\"></div>
      <div class=\"hex\"></div>
      <div class=\"hex\"></div>
      <div class=\"hex\"></div>
      <div class=\"hex\"></div>
      <div class=\"hex\"></div>
      <div class=\"hex\"></div>
      <div class=\"hex\"></div>
      <div class=\"core\"></div>
    </div>
    <p class=\"text\">Initializing</p>
  </div>
</body></html>"#;
            // Try bundled asset first (works in prod). If unavailable in current environment, fall back to data: URL.
            let splash_try_app = tauri::WebviewWindowBuilder::new(app, "splash", WebviewUrl::App("splash.html".into()))
                .title("UICP")
                .decorations(false)
                .resizable(false)
                .inner_size(420.0, 280.0)
                .center()
                .visible(true)
                .build();
            if let Err(err) = splash_try_app {
                log_warn(format!(
                    "splash app:// failed, falling back to data URL: {err:?}"
                ));
                let data_url = format!("data:text/html;base64,{}", BASE64_ENGINE.encode(splash_html));
                let splash_fallback = tauri::WebviewWindowBuilder::new(app, "splash", WebviewUrl::External(
                    Url::parse(&data_url).expect("valid data url")
                ))
                    .title("UICP")
                    .decorations(false)
                    .resizable(false)
                    .inner_size(420.0, 280.0)
                    .center()
                    .visible(true)
                    .build();
                if let Err(err2) = splash_fallback {
                    log_error(format!(
                        "failed to create splash window (data URL fallback): {err2:?}"
                    ));
                }
            }

            // Frontend will call the `frontend_ready` command; see handler below.
            // Run DB health check at startup; enter Safe Mode on failure
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = health_quick_check_internal(&handle).await {
                    log_error(format!("health_quick_check failed: {err:?}"));
                }
            });
            // Load host policies (best-effort)
            let handle2 = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = crate::authz::reload_policies(&handle2) {
                    log_warn(format!("reload_policies failed: {err}"));
                }
            });
            // If local opt-in is enabled by env or persisted UI toggle, probe local daemon once to enable fallback.
            let handle3 = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state: State<'_, AppState> = handle3.state();
                if *state.allow_local_opt_in.read().await {
                    maybe_enable_local_ollama(&state).await;
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Chat commands
            commands::chat_completion,
            commands::cancel_chat,
            // Compute commands
            commands::compute_call,
            commands::compute_cancel,
            commands::get_paths,
            // Provider commands
            commands::provider_login,
            commands::provider_health,
            commands::provider_resolve,
            commands::provider_install,
            commands::verify_modules,
            commands::save_provider_api_key,
            commands::load_api_key,
            commands::test_api_key,
            commands::auth_preflight,
            // Other commands
            copy_into_files,
            export_from_files,
            get_modules_info,
            get_modules_registry,
            get_action_log_stats,
            open_path,
            save_api_key,
            set_debug,
            test_api_key,
            persist_command,
            save_checkpoint,
            health_quick_check,
            determinism_probe,
            recovery_action,
            recovery_auto,
            recovery_export,
            clear_compute_cache,
            set_safe_mode,
            get_workspace_commands,
            clear_workspace_commands,
            delete_window_commands,
            load_workspace,
            save_workspace,
            mint_job_token,
            debug_circuits,
            debug_provider_circuits,
            circuit_control,
            chaos_configure_failure,
            chaos_stop_failure,
            chaos_get_configs,
            get_circuit_debug_info,
            reset_circuit,
            force_open_circuit,
            force_close_circuit,
            get_resilience_metrics,
            set_env_var,
            egress_fetch,
            load_agents_config_file,
            save_agents_config_file,
            keystore_unlock,
            keystore_lock,
            keystore_status,
            keystore_sentinel_exists,
            keystore_list_ids,
            keystore_autolock_reason,
            secret_set,
            secret_exists,
            secret_delete,
            reload_policies,
            apppack_validate,
            apppack_install,
            apppack_entry_html,
            set_allow_local_opt_in,
            get_ollama_mode,
            frontend_ready
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Command invoked by the frontend when the UI is fully ready.
#[tauri::command]
fn frontend_ready(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }

    Ok(())
}

#[derive(Clone, Serialize)]
struct AuthPreflightResult {
    ok: bool,
    code: String,
    detail: Option<String>,
}

#[tauri::command]
async fn auth_preflight(
    provider: String,
    app_handle: tauri::AppHandle,
) -> Result<AuthPreflightResult, String> {
    let p = provider.trim().to_ascii_lowercase();
    let start_time = std::time::Instant::now();

    match build_provider_headers(&p).await {
        Ok(_) => {
            let result = AuthPreflightResult {
                ok: true,
                code: "OK".into(),
                detail: None,
            };

            // Emit successful auth preflight telemetry
            emit_or_log(
                &app_handle,
                "auth_preflight_result",
                serde_json::json!({
                    "provider": p,
                    "success": true,
                    "code": "OK",
                    "durationMs": start_time.elapsed().as_millis(),
                }),
            );

            Ok(result)
        }
        Err(e) => {
            let msg = e.to_string();
            let low = msg.to_ascii_lowercase();
            let code = if low.contains("denied") {
                "PolicyDenied".to_string()
            } else if low.contains("unknown provider") {
                "UnknownProvider".to_string()
            } else {
                "AuthMissing".to_string()
            };
            let result = AuthPreflightResult {
                ok: false,
                code: code.clone(),
                detail: Some(msg.clone()),
            };

            // Emit failed auth preflight telemetry
            emit_or_log(
                &app_handle,
                "auth_preflight_result",
                serde_json::json!({
                    "provider": p,
                    "success": false,
                    "code": code,
                    "detail": msg,
                    "durationMs": start_time.elapsed().as_millis(),
                }),
            );

            Ok(result)
        }
    }
}

#[tauri::command]
async fn set_env_var(name: String, value: Option<String>) -> Result<(), String> {
    let key = name.trim();
    if key.is_empty() || key.contains('\0') || key.contains('=') {
        return Err("E-UICP-9201: invalid env var name".into());
    }
    let upper = key.to_ascii_uppercase();
    const ALLOWED_PREFIXES: &[&str] = &["OLLAMA_", "UICP_"];
    let allowed = ALLOWED_PREFIXES
        .iter()
        .any(|prefix| upper.starts_with(prefix));
    if !allowed {
        return Err(format!(
            "E-UICP-9203: env var '{key}' not permitted (allowed prefixes: {ALLOWED_PREFIXES:?})"
        ));
    }
    match value {
        Some(v) => std::env::set_var(key, v),
        None => std::env::remove_var(key),
    }
    Ok(())
}

/// Save a provider API key to the embedded keystore.
/// provider: "openai" or "anthropic"
/// ERROR: E-UICP-9202 invalid provider; E-UICP-SEC-LOCKED when keystore locked
#[tauri::command]
async fn save_provider_api_key(provider: String, key: String) -> Result<(), String> {
    let account = match provider.trim().to_ascii_lowercase().as_str() {
        "openai" => "openai:api_key",
        "anthropic" => "anthropic:api_key",
        "openrouter" => "openrouter:api_key",
        "ollama" => "ollama:api_key",
        _ => {
            return Err(format!("E-UICP-9202 unknown provider '{provider}'"));
        }
    };
    let key_trimmed = key.trim().to_string();
    let ks = get_or_init_keystore().await.map_err(|e| e.to_string())?;
    ks.secret_set("uicp", account, secrecy::SecretString::new(key_trimmed))
        .await
        .map_err(|e| e.to_string())
}

/// Get debug information for all circuit breakers.
/// Returns per-host state including failures, open status, and telemetry counters.
///
/// WHY: Provides runtime visibility into circuit breaker state for debugging and monitoring.
/// INVARIANT: Read-only operation; does not modify circuit state.
#[tauri::command]
async fn debug_circuits(
    state: State<'_, AppState>,
) -> Result<Vec<circuit::CircuitDebugInfo>, String> {
    let info = circuit::get_circuit_debug_info(&state.circuit_breakers).await;
    Ok(info)
}

/// Returns provider-aware circuit breaker state with provider isolation.
#[tauri::command]
async fn debug_provider_circuits(
    state: State<'_, AppState>,
) -> Result<Vec<provider_circuit::ProviderCircuitDebugInfo>, String> {
    let info = state.provider_circuit_manager.get_debug_info().await;
    Ok(info)
}

/// Execute manual circuit control commands for operators.
#[tauri::command]
async fn circuit_control(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    command: provider_circuit::CircuitControlCommand,
) -> Result<(), String> {
    let emit_circuit_telemetry = move |event_name: &str, payload: serde_json::Value| {
        let handle = app_handle.clone();
        let name = event_name.to_string();
        tauri::async_runtime::spawn(async move {
            let _ = handle.emit(&name, payload);
        });
    };

    state
        .provider_circuit_manager
        .execute_control_command(command, emit_circuit_telemetry)
        .await
}

/// Configure synthetic failure injection for chaos testing.
#[tauri::command]
async fn chaos_configure_failure(
    state: State<'_, AppState>,
    provider: String,
    config: chaos::FailureConfig,
) -> Result<(), String> {
    state.chaos_engine.configure_failure(provider, config).await
}

/// Stop synthetic failure injection for a provider.
#[tauri::command]
async fn chaos_stop_failure(state: State<'_, AppState>, provider: String) -> Result<(), String> {
    state.chaos_engine.stop_failure(&provider).await;
    Ok(())
}

/// Get current chaos configuration for all providers.
#[tauri::command]
async fn chaos_get_configs(
    state: State<'_, AppState>,
) -> Result<HashMap<String, chaos::FailureConfig>, String> {
    Ok(state.chaos_engine.get_all_configs().await)
}

/// Get circuit breaker debug information for all providers.
#[tauri::command]
async fn get_circuit_debug_info(
    state: State<'_, AppState>,
) -> Result<Vec<provider_circuit::ProviderCircuitDebugInfo>, String> {
    Ok(state.provider_circuit_manager.get_debug_info().await)
}

/// Reset a circuit breaker to closed state.
#[tauri::command]
async fn reset_circuit(
    state: State<'_, AppState>,
    provider: String,
    host: String,
) -> Result<(), String> {
    let cmd = provider_circuit::CircuitControlCommand::Reset { provider, host };
    state.provider_circuit_manager.execute_control_command(cmd, |_, _| {}).await
}

/// Force open a circuit breaker for testing.
#[tauri::command]
async fn force_open_circuit(
    state: State<'_, AppState>,
    provider: String,
    host: String,
    duration_ms: u64,
) -> Result<(), String> {
    let cmd = provider_circuit::CircuitControlCommand::ForceOpen { provider, host, duration_ms };
    state.provider_circuit_manager.execute_control_command(cmd, |_, _| {}).await
}

/// Force close a circuit breaker.
#[tauri::command]
async fn force_close_circuit(
    state: State<'_, AppState>,
    provider: String,
    host: String,
) -> Result<(), String> {
    let cmd = provider_circuit::CircuitControlCommand::ForceClose { provider, host };
    state.provider_circuit_manager.execute_control_command(cmd, |_, _| {}).await
}

/// Get resilience metrics for all providers.
#[tauri::command]
async fn get_resilience_metrics(
    state: State<'_, AppState>,
) -> Result<Vec<chaos::ResilienceMetricsSummary>, String> {
    let providers = ["openai", "openrouter", "anthropic", "ollama"];
    let mut metrics = Vec::new();
    
    for provider in providers.iter() {
        if let Some(summary) = state.resilience_metrics.get_metrics(provider).await {
            metrics.push(summary);
        }
    }
    
    Ok(metrics)
}





// Removed unused proxy env commands (get_proxy_env, set_proxy_env) to avoid dead code.

/// Verify that all module entries listed in the manifest exist and match their digests.
#[tauri::command]
async fn verify_modules(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("verify_modules");
    use crate::registry::{load_manifest, modules_dir};
    let dir = modules_dir(&app);
    let manifest = load_manifest(&app).map_err(|e| format!("load manifest: {e}"))?;

    // Optional Ed25519 signature verification public key (32-byte). Accept hex or base64.
    let pubkey_opt: Option<[u8; 32]> = std::env::var("UICP_MODULES_PUBKEY").ok().and_then(|s| {
        let b64 = BASE64_ENGINE.decode(s.as_bytes()).ok();
        let hexed = if b64.is_none() {
            hex::decode(&s).ok()
        } else {
            None
        };
        b64.or(hexed).and_then(|v| v.try_into().ok())
    });

    let mut failures: Vec<serde_json::Value> = Vec::new();
    for entry in manifest.entries.iter() {
        let path = dir.join(&entry.filename);
        // Async existence check via metadata
        let exists = tokio::fs::metadata(&path).await.is_ok();
        if !exists {
            failures.push(serde_json::json!({
                "filename": entry.filename,
                "reason": "missing",
            }));
            continue;
        }

        // Async read file, then hash on a blocking thread to avoid starving the runtime.
        let bytes = match tokio::fs::read(&path).await {
            Ok(b) => b,
            Err(err) => {
                failures.push(serde_json::json!({
                    "filename": entry.filename,
                    "reason": "io_error",
                    "message": err.to_string(),
                }));
                continue;
            }
        };

        let calc_hex = tokio::task::spawn_blocking(move || {
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            hex::encode(hasher.finalize())
        })
        .await
        .map_err(|e| format!("hash join error: {e}"))?;

        if !entry.digest_sha256.eq_ignore_ascii_case(&calc_hex) {
            failures.push(serde_json::json!({
                "filename": entry.filename,
                "reason": "digest_mismatch",
                "expected": entry.digest_sha256,
                "actual": calc_hex,
            }));
            continue;
        }

        // Optional signature verification when both signature and public key are present.
        if let (Some(_sig), Some(pk)) = (&entry.signature, pubkey_opt.as_ref()) {
            match crate::registry::verify_entry_signature(entry, pk) {
                Ok(crate::registry::SignatureStatus::Verified) => {}
                Ok(crate::registry::SignatureStatus::Invalid)
                | Ok(crate::registry::SignatureStatus::Missing) => {
                    failures.push(serde_json::json!({
                        "filename": entry.filename,
                        "reason": "signature_mismatch",
                    }))
                }
                Err(err) => failures.push(serde_json::json!({
                    "filename": entry.filename,
                    "reason": "signature_error",
                    "message": err.to_string(),
                })),
            }
        }
    }

    Ok(serde_json::json!({
        "ok": failures.is_empty(),
        "dir": dir.display().to_string(),
        "failures": failures,
        "count": manifest.entries.len(),
    }))
}

/// Copy a host file into the workspace files directory and return its ws:/ path.
#[tauri::command]
async fn copy_into_files(_app: tauri::AppHandle, src_path: String) -> Result<String, String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("copy_into_files");
    use std::fs;
    use std::path::{Path, PathBuf};

    let p = Path::new(&src_path);
    if !p.exists() {
        return Err(format!("Source path does not exist: {}", src_path));
    }

    // Only allow regular files; reject symlinks and directories.
    let meta = fs::symlink_metadata(p).map_err(|e| format!("stat failed: {e}"))?;
    if !meta.file_type().is_file() {
        return Err("Source must be a regular file".into());
    }

    // Sanitize filename (no directory traversal, keep base name)
    let fname = p
        .file_name()
        .ok_or_else(|| "Invalid source file name".to_string())?
        .to_string_lossy()
        .to_string();
    if fname.trim().is_empty() {
        return Err("Empty file name".into());
    }

    // Map to workspace files dir
    let dest_dir = crate::files_dir_path();
    if let Err(e) = fs::create_dir_all(dest_dir) {
        return Err(format!("Failed to create files dir: {e}"));
    }
    let mut dest: PathBuf = dest_dir.join(&fname);
    if dest.exists() {
        let stem = dest.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
        let ext = dest.extension().and_then(|e| e.to_str()).unwrap_or("");
        let ts = chrono::Utc::now().timestamp();
        let new_name = if ext.is_empty() {
            format!("{}-{}", stem, ts)
        } else {
            format!("{}-{}.{}", stem, ts, ext)
        };
        dest = dest_dir.join(new_name);
    }

    fs::copy(p, &dest).map_err(|e| format!("Copy failed: {e}"))?;

    // Return ws:/ path for use with compute tasks
    Ok(format!(
        "ws:/files/{}",
        dest.file_name().and_then(|s| s.to_str()).unwrap_or(&fname)
    ))
}

/// Returns detailed module registry information with provenance for supply chain transparency.
/// Used by the devtools panel to display "museum labels" for each module.
#[tauri::command]
async fn get_modules_registry(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("get_modules_registry");
    let dir = crate::registry::modules_dir(&app);
    let manifest = crate::registry::load_manifest(&app).map_err(|e| e.to_string())?;

    let mut modules = Vec::new();
    for entry in manifest.entries {
        // Load provenance for each module (best-effort)
        let provenance = crate::registry::load_provenance(&dir, &entry.task, &entry.version)
            .ok()
            .flatten();

        modules.push(serde_json::json!({
            "task": entry.task,
            "version": entry.version,
            "filename": entry.filename,
            "digest": entry.digest_sha256,
            "signature": entry.signature,
            "keyid": entry.keyid,
            "signedAt": entry.signed_at,
            "provenance": provenance,
        }));
    }

    // Security posture: strict mode + trust store source for UI surfacing
    let strict = std::env::var("STRICT_MODULES_VERIFY")
        .ok()
        .map(|s| {
            matches!(
                s.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false);
    let trust_store = if std::env::var("UICP_TRUST_STORE_JSON").is_ok() {
        "inline"
    } else if std::env::var("UICP_TRUST_STORE").is_ok() {
        "file"
    } else if std::env::var("UICP_MODULES_PUBKEY").is_ok() {
        "single_key"
    } else {
        "none"
    };

    Ok(serde_json::json!({
        "dir": dir.display().to_string(),
        "modules": modules,
        "strict": strict,
        "trustStore": trust_store,
    }))
}

#[tauri::command]
async fn get_modules_info(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("get_modules_info");
    let dir = crate::registry::modules_dir(&app);
    let manifest = dir.join("manifest.json");
    let exists = manifest.exists();
    let mut entries = 0usize;
    if exists {
        if let Ok(text) = std::fs::read_to_string(&manifest) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                entries = json["entries"].as_array().map(|a| a.len()).unwrap_or(0);
            }
        }
    }
    Ok(serde_json::json!({
        "dir": dir.display().to_string(),
        "manifest": manifest.display().to_string(),
        "hasManifest": exists,
        "entries": entries,
    }))
}

#[tauri::command]
async fn get_action_log_stats(
    state: State<'_, AppState>,
) -> Result<crate::action_log::ActionLogStatsSnapshot, String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("get_action_log_stats");
    Ok(state.action_log.stats_snapshot())
}

#[tauri::command]
async fn open_path(path: String) -> Result<(), String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("open_path");
    use std::process::Command;
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(p)
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(p)
            .spawn()
            .map_err(|e| format!("Failed to open path: {e}"))?;
        return Ok(());
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(p)
            .spawn()
            .map_err(|e| format!("Failed to open path: {e}"))?;
        return Ok(());
    }
}

async fn enter_safe_mode(app: &tauri::AppHandle, reason: &str) {
    let state: State<'_, AppState> = app.state();
    *state.safe_mode.write().await = true;
    *state.safe_reason.write().await = Some(reason.to_string());
    let _ = app.emit(
        "replay-issue",
        serde_json::json!({ "reason": reason, "action": "enter_safe_mode" }),
    );
}

#[tauri::command]
async fn health_quick_check(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    health_quick_check_internal(&app)
        .await
        .map_err(|e| format!("{e:?}"))
}

async fn health_quick_check_internal(app: &tauri::AppHandle) -> anyhow::Result<serde_json::Value> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("health_quick_check");
    let state: State<'_, AppState> = app.state();
    let status = state
        .db_ro
        .call(|conn| -> tokio_rusqlite::Result<String> {
            let mut stmt = conn
                .prepare("PRAGMA quick_check")
                .map_err(tokio_rusqlite::Error::from)?;
            let mut rows = stmt.query([]).map_err(tokio_rusqlite::Error::from)?;
            let mut results = Vec::new();
            while let Some(row) = rows.next().map_err(tokio_rusqlite::Error::from)? {
                let s: String = row.get(0).map_err(tokio_rusqlite::Error::from)?;
                results.push(s);
            }
            Ok(results.join(", "))
        })
        .await?;

    let ok = status.to_lowercase().contains("ok");
    if !ok {
        enter_safe_mode(app, "CORRUPT_DB").await;
    } else {
        emit_replay_telemetry(app, "ok", None, 0).await;
    }
    Ok(serde_json::json!({ "ok": ok, "status": status }))
}

#[tauri::command]
async fn clear_compute_cache(
    app: tauri::AppHandle,
    workspace_id: Option<String>,
) -> Result<(), String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("clear_compute_cache", workspace = %workspace_id.as_deref().unwrap_or("default"));
    let ws = workspace_id.unwrap_or_else(|| "default".into());
    let state: State<'_, AppState> = app.state();
    state
        .db_rw
        .call(move |conn| -> tokio_rusqlite::Result<()> {
            conn.execute(
                "DELETE FROM compute_cache WHERE workspace_id = ?1",
                params![ws],
            )
            .map(|_| ())
            .map_err(tokio_rusqlite::Error::from)
        })
        .await
        .map_err(|e| format!("{e:?}"))
}

#[tauri::command]
async fn set_safe_mode(
    app: tauri::AppHandle,
    enabled: bool,
    reason: Option<String>,
) -> Result<(), String> {
    let state: State<'_, AppState> = app.state();
    *state.safe_mode.write().await = enabled;
    *state.safe_reason.write().await = if enabled { reason.clone() } else { None };
    if enabled {
        let why = reason.unwrap_or_else(|| "USER_KILL_SWITCH".into());
        let _ = app.emit(
            "replay-issue",
            serde_json::json!({ "reason": why, "action": "enter_safe_mode" }),
        );
    } else {
        let _ = app.emit(
            "safe-mode",
            serde_json::json!({ "enabled": false, "reason": "cleared_by_user" }),
        );
    }
    Ok(())
}

#[tauri::command]
async fn save_checkpoint(app: tauri::AppHandle, hash: String) -> Result<(), String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("save_checkpoint", hash_len = hash.len());
    let state: State<'_, AppState> = app.state();
    if *state.safe_mode.read().await {
        return Ok(());
    }
    #[cfg(feature = "otel_spans")]
    let _started = Instant::now(); // WHY: Same instrumentation guard as elsewhere; avoid unused warnings sans spans.
    let res = state
        .db_rw
        .call(move |conn| -> tokio_rusqlite::Result<()> {
            conn.execute(
                "CREATE TABLE IF NOT EXISTS replay_checkpoint (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at INTEGER NOT NULL)",
                [],
            )
            .map_err(tokio_rusqlite::Error::from)?;
            let now = Utc::now().timestamp();
            conn.execute(
                "INSERT INTO replay_checkpoint (hash, created_at) VALUES (?1, ?2)",
                params![hash, now],
            )
            .map(|_| ())
            .map_err(tokio_rusqlite::Error::from)
        })
        .await;
    #[cfg(feature = "otel_spans")]
    {
        let ms = _started.elapsed().as_millis() as i64;
        match &res {
            Ok(_) => tracing::info!(target = "uicp", duration_ms = ms, "checkpoint saved"),
            Err(e) => {
                tracing::warn!(target = "uicp", duration_ms = ms, error = %e, "checkpoint save failed")
            }
        }
    }
    res.map_err(|e| format!("{e:?}"))
}

#[tauri::command]
async fn determinism_probe(
    app: tauri::AppHandle,
    n: u32,
    recomputed_hash: Option<String>,
) -> Result<serde_json::Value, String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!(
        "determinism_probe",
        n = n,
        has_hash = recomputed_hash.is_some()
    );
    let state: State<'_, AppState> = app.state();
    let limit = n as i64;
    let samples = state
        .db_ro
        .call(move |conn| -> tokio_rusqlite::Result<Vec<String>> {
            let mut stmt =
                conn.prepare("SELECT hash FROM replay_checkpoint ORDER BY RANDOM() LIMIT ?1")?;
            let rows = stmt
                .query_map(params![limit], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
        .map_err(|e| format!("{e:?}"))?;

    let mut drift = false;
    if let Some(current) = recomputed_hash {
        for h in &samples {
            if h != &current {
                drift = true;
                break;
            }
        }
    }
    if drift {
        enter_safe_mode(&app, "DRIFT").await;
    }
    #[cfg(feature = "otel_spans")]
    tracing::info!(
        target = "uicp",
        drift = drift,
        sampled = samples.len(),
        "determinism probe result"
    );
    Ok(serde_json::json!({ "drift": drift, "sampled": samples.len() }))
}

#[tauri::command]
async fn recovery_action(app: tauri::AppHandle, kind: String) -> Result<(), String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("recovery_action", kind = %kind);
    let emit = |app: &tauri::AppHandle, action: &str, outcome: &str, payload: serde_json::Value| {
        let _ = app.emit(
            "replay-issue",
            serde_json::json!({
                "event": "recovery_action",
                "action": action,
                "outcome": outcome,
                "details": payload,
            }),
        );
    };

    match kind.as_str() {
        "reindex" => {
            match reindex_and_integrity(&app)
                .await
                .map_err(|e| format!("reindex: {e:?}"))?
            {
                true => {
                    emit(&app, "reindex", "ok", serde_json::json!({}));
                    emit_replay_telemetry(&app, "manual_reindex", None, 0).await;
                    Ok(())
                }
                false => {
                    emit(
                        &app,
                        "reindex",
                        "failed",
                        serde_json::json!({ "reason": "integrity_check_failed" }),
                    );
                    emit_replay_telemetry(
                        &app,
                        "manual_reindex_failed",
                        Some("integrity_check_failed"),
                        0,
                    )
                    .await;
                    Err("Integrity check failed after reindex".into())
                }
            }
        }
        "compact_log" => {
            let deleted = compact_log_after_last_checkpoint(&app)
                .await
                .map_err(|e| format!("compact_log: {e:?}"))?;
            let ok = reindex_and_integrity(&app)
                .await
                .map_err(|e| format!("reindex: {e:?}"))?;
            if ok {
                emit(
                    &app,
                    "compact_log",
                    "ok",
                    serde_json::json!({ "deleted": deleted }),
                );
                emit_replay_telemetry(&app, "manual_compact", None, 0).await;
                Ok(())
            } else {
                emit(
                    &app,
                    "compact_log",
                    "failed",
                    serde_json::json!({ "deleted": deleted, "reason": "integrity_check_failed" }),
                );
                emit_replay_telemetry(
                    &app,
                    "manual_compact_failed",
                    Some("integrity_check_failed"),
                    0,
                )
                .await;
                Err("Integrity check failed after compacting log".into())
            }
        }
        "rollback_checkpoint" => {
            let truncated = rollback_to_last_checkpoint(&app)
                .await
                .map_err(|e| format!("rollback_checkpoint: {e:?}"))?;
            emit(
                &app,
                "rollback_checkpoint",
                "ok",
                serde_json::json!({ "truncated": truncated }),
            );
            emit_replay_telemetry(&app, "manual_rollback", None, 0).await;
            Ok(())
        }
        "auto" => {
            let summary = recovery_auto(app.clone()).await?;
            emit(&app, "auto", "ok", summary);
            Ok(())
        }
        "export" => {
            let bundle = recovery_export(app.clone()).await?;
            emit(&app, "export", "ok", bundle);
            Ok(())
        }
        "clear_cache" => {
            clear_compute_cache(app.clone(), Some("default".into())).await?;
            emit(&app, "clear_cache", "ok", serde_json::json!({}));
            Ok(())
        }
        other => Err(format!("Unknown recovery action: {other}")),
    }
}

#[tauri::command]
async fn recovery_auto(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("recovery_auto");
    let mut attempts: Vec<serde_json::Value> = Vec::new();
    let mut status: &str = "failed";
    let mut failed_reason: Option<String> = None;

    // a) Reindex + integrity_check
    let res_a = reindex_and_integrity(&app).await;
    match res_a {
        Ok(ok) => {
            attempts.push(serde_json::json!({"step":"reindex","ok": ok }));
            if ok {
                status = "reindexed";
                emit_replay_telemetry(&app, status, None, 0).await;
                return Ok(serde_json::json!({"attempts": attempts, "resolved": true}));
            }
        }
        Err(e) => {
            attempts
                .push(serde_json::json!({"step":"reindex","ok": false, "error": format!("{e:?}")}));
            failed_reason = Some(format!("reindex: {e}"));
        }
    }

    // b) Compact log: drop trailing incomplete segment after last checkpoint
    let res_b = compact_log_after_last_checkpoint(&app).await;
    match res_b {
        Ok(deleted) => attempts.push(
            serde_json::json!({"step":"compact_log","ok": deleted >= 0, "deleted": deleted }),
        ),
        Err(e) => attempts
            .push(serde_json::json!({"step":"compact_log","ok": false, "error": format!("{e:?}")})),
    }

    // Re-run integrity_check
    if let Ok(ok) = reindex_and_integrity(&app).await {
        if ok {
            status = "compacted";
            emit_replay_telemetry(&app, status, None, 0).await;
            return Ok(serde_json::json!({"attempts": attempts, "resolved": true}));
        }
    }

    // c) Roll back to last checkpoint (truncate log beyond checkpoint)
    let res_c = rollback_to_last_checkpoint(&app).await;
    match res_c {
        Ok(truncated) => attempts.push(serde_json::json!({"step":"rollback_checkpoint","ok": truncated >= 0, "truncated": truncated })),
        Err(e) => attempts.push(serde_json::json!({"step":"rollback_checkpoint","ok": false, "error": format!("{e:?}")})),
    }

    // d) Re-enqueue replayable jobs missing terminal results (not tracked yet)
    attempts
        .push(serde_json::json!({"step":"reenqueue_missing","ok": true, "note": "no-op in v1" }));

    // Still not OK
    failed_reason = failed_reason.or(Some("recovery_failed".into()));
    emit_replay_telemetry(&app, status, failed_reason.as_deref(), 0).await;
    Ok(serde_json::json!({"attempts": attempts, "resolved": false}))
}

#[tauri::command]
async fn recovery_export(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("recovery_export");
    let state: State<'_, AppState> = app.state();
    let logs_dir = LOGS_DIR.clone();
    let integrity = reindex_and_integrity(&app).await.unwrap_or(false);
    let counts = state
        .db_ro
        .call(|conn| -> tokio_rusqlite::Result<serde_json::Value> {
            let tool_calls: i64 = conn
                .query_row("SELECT COUNT(*) FROM tool_call", [], |r| r.get(0))
                .map_err(tokio_rusqlite::Error::from)?;
            let cache_rows: i64 = conn
                .query_row("SELECT COUNT(*) FROM compute_cache", [], |r| r.get(0))
                .map_err(tokio_rusqlite::Error::from)?;
            Ok(serde_json::json!({"tool_call": tool_calls, "compute_cache": cache_rows}))
        })
        .await
        .map_err(|e| format!("{e:?}"))?;

    let bundle = serde_json::json!({
        "integrity_ok": integrity,
        "counts": counts,
        "ts": chrono::Utc::now().timestamp(),
    });
    let path = logs_dir.join(format!(
        "diagnostics-{}.json",
        chrono::Utc::now().timestamp()
    ));
    tokio::fs::create_dir_all(&logs_dir)
        .await
        .map_err(|e| format!("{e}"))?;
    let json_bytes =
        serde_json::to_vec_pretty(&bundle).map_err(|e| format!("serialize diagnostics: {e}"))?;
    tokio::fs::write(&path, json_bytes)
        .await
        .map_err(|e| format!("{e}"))?;
    Ok(serde_json::json!({"path": path.display().to_string()}))
}

async fn reindex_and_integrity(app: &tauri::AppHandle) -> anyhow::Result<bool> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("reindex_and_integrity");
    let state: State<'_, AppState> = app.state();
    let status = state
        .db_rw
        .call(|conn| -> tokio_rusqlite::Result<String> {
            conn.execute("REINDEX", [])
                .map_err(tokio_rusqlite::Error::from)?;
            let mut stmt = conn
                .prepare("PRAGMA integrity_check")
                .map_err(tokio_rusqlite::Error::from)?;
            let mut rows = stmt.query([]).map_err(tokio_rusqlite::Error::from)?;
            let mut results = Vec::new();
            while let Some(row) = rows.next().map_err(tokio_rusqlite::Error::from)? {
                let s: String = row.get(0).map_err(tokio_rusqlite::Error::from)?;
                results.push(s);
            }
            Ok(results.join(", "))
        })
        .await?;
    Ok(status.to_lowercase().contains("ok"))
}

async fn last_checkpoint_ts(app: &tauri::AppHandle) -> anyhow::Result<Option<i64>> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("last_checkpoint_ts");
    let state: State<'_, AppState> = app.state();
    let ts = state
        .db_rw
        .call(|conn| -> tokio_rusqlite::Result<Option<i64>> {
            conn.execute(
                "CREATE TABLE IF NOT EXISTS replay_checkpoint (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at INTEGER NOT NULL)",
                [],
            )
            .map_err(tokio_rusqlite::Error::from)?;
            let ts: Option<i64> = conn
                .query_row("SELECT MAX(created_at) FROM replay_checkpoint", [], |r| r.get(0))
                .optional()
                .map_err(tokio_rusqlite::Error::from)?;
            Ok(ts)
        })
        .await?;
    Ok(ts)
}

async fn compact_log_after_last_checkpoint(app: &tauri::AppHandle) -> anyhow::Result<i64> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("compact_log_after_last_checkpoint");
    let Some(since) = last_checkpoint_ts(app).await? else {
        return Ok(0);
    };
    let state: State<'_, AppState> = app.state();
    let deleted = state
        .db_rw
        .call(move |conn| -> tokio_rusqlite::Result<i64> {
            conn.execute(
                "DELETE FROM tool_call WHERE created_at > ?1 AND (result_json IS NULL OR TRIM(result_json) = '')",
                params![since],
            )
            .map(|n| n as i64)
            .map_err(tokio_rusqlite::Error::from)
        })
        .await?;
    Ok(deleted)
}

async fn rollback_to_last_checkpoint(app: &tauri::AppHandle) -> anyhow::Result<i64> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("rollback_to_last_checkpoint");
    let Some(since) = last_checkpoint_ts(app).await? else {
        return Ok(0);
    };
    let state: State<'_, AppState> = app.state();
    let truncated = state
        .db_rw
        .call(move |conn| -> tokio_rusqlite::Result<i64> {
            conn.execute(
                "DELETE FROM tool_call WHERE created_at > ?1",
                params![since],
            )
            .map(|n| n as i64)
            .map_err(tokio_rusqlite::Error::from)
        })
        .await?;
    Ok(truncated)
}

async fn emit_replay_telemetry(
    app: &tauri::AppHandle,
    replay_status: &str,
    failed_reason: Option<&str>,
    rerun_count: i64,
) {
    let checkpoint_id = last_checkpoint_ts(app).await.ok().flatten();
    let _ = app.emit(
        "replay-telemetry",
        serde_json::json!({
            "replay_status": replay_status,
            "failed_reason": failed_reason,
            "checkpoint_id": checkpoint_id,
            "rerun_count": rerun_count,
        }),
    );
}
