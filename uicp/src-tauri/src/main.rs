#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")] // hide console window on Windows in release

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use base64::engine::general_purpose::STANDARD as BASE64_ENGINE;
use base64::Engine as _;
use chrono::Utc;
use dotenvy::dotenv;
use keyring::Entry;
use once_cell::sync::Lazy;
use reqwest::{Client, Url};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use hmac::{Hmac, Mac};
use tauri::{
    async_runtime::{spawn, JoinHandle},
    Emitter, Manager, State, WebviewUrl,
};

use tokio::{
    io::AsyncWriteExt,
    sync::{RwLock, Semaphore},
    time::{interval, timeout},
};
use rand::RngCore;
use tokio_rusqlite::Connection as AsyncConn;
use tokio_stream::StreamExt;

mod action_log;
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
mod events;
mod policy;
mod provider_cli;
mod registry;
#[cfg(feature = "wasm_compute")]
mod wasi_logging;

#[cfg(any(test, feature = "compute_harness"))]
mod commands;

pub use policy::{
    enforce_compute_policy, ComputeBindSpec, ComputeCapabilitiesSpec, ComputeFinalErr,
    ComputeFinalOk, ComputeJobSpec, ComputePartialEvent, ComputeProvenanceSpec,
};

use compute_input::canonicalize_task_input;
use core::CircuitBreakerConfig;
use provider_cli::{ProviderHealthResult, ProviderLoginResult};

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

#[tauri::command]
async fn compute_call(
    window: tauri::Window,
    state: State<'_, AppState>,
    spec: ComputeJobSpec,
) -> Result<(), String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!(
        "compute_call",
        job_id = %spec.job_id,
        task = %spec.task,
        cache = %spec.cache
    );
    // Reject duplicate job ids
    if state
        .compute_ongoing
        .read()
        .await
        .contains_key(&spec.job_id)
    {
        return Err(format!("Duplicate job id {}", spec.job_id));
    }

    if let Err(err) = state
        .action_log
        .append_json(
            "compute.job.submit",
            &serde_json::json!({
                "jobId": spec.job_id.clone(),
                "task": spec.task.clone(),
                "cache": spec.cache.clone(),
                "workspaceId": spec.workspace_id.clone(),
                "ts": chrono::Utc::now().timestamp_millis(),
            }),
        )
        .await
    {
        return Err(format!("Action log append failed: {err}"));
    }

    let app_handle = window.app_handle().clone();

    let require_tokens = match std::env::var("UICP_REQUIRE_TOKENS") {
        Ok(v) => matches!(v.as_str(), "1" | "true" | "TRUE" | "on" | "yes"),
        Err(_) => false,
    };
    if require_tokens {
        let expected = {
            let key = &state.job_token_key;
            let mut mac: Hmac<Sha256> = Hmac::new_from_slice(key).map_err(|e| e.to_string())?;
            mac.update(b"UICP-TOKENv1\x00");
            mac.update(spec.job_id.as_bytes());
            mac.update(b"|");
            mac.update(spec.task.as_bytes());
            mac.update(b"|");
            mac.update(spec.workspace_id.as_bytes());
            mac.update(b"|");
            mac.update(spec.provenance.env_hash.as_bytes());
            let tag = mac.finalize().into_bytes();
            hex::encode(tag)
        };
        let provided = spec.token.as_deref().unwrap_or("");
        if provided != expected {
            let payload = ComputeFinalErr {
                ok: false,
                job_id: spec.job_id.clone(),
                task: spec.task.clone(),
                code: "Compute.CapabilityDenied".into(),
                message: "E-UICP-0701: missing or invalid job token".into(),
                metrics: None,
            };
            emit_or_log(
                &window.app_handle(),
                crate::events::EVENT_COMPUTE_RESULT_FINAL,
                &payload,
            );
            return Ok(());
        }
    }

    // --- Policy enforcement (Non-negotiables v1) ---
    if let Some(deny) = enforce_compute_policy(&spec) {
        emit_or_log(
            &app_handle,
            crate::events::EVENT_COMPUTE_RESULT_FINAL,
            &deny,
        );
        return Ok(());
    }

    let normalized_input = match canonicalize_task_input(&spec) {
        Ok(value) => value,
        Err(err) => {
            let payload = ComputeFinalErr {
                ok: false,
                job_id: spec.job_id.clone(),
                task: spec.task.clone(),
                code: err.code.into(),
                message: err.message,
                metrics: None,
            };
            emit_or_log(
                &app_handle,
                crate::events::EVENT_COMPUTE_RESULT_FINAL,
                &payload,
            );
            return Ok(());
        }
    };

    // Provider decision telemetry (host-owned)
    let is_module_task = crate::registry::find_module(&app_handle, &spec.task)
        .ok()
        .flatten()
        .is_some();
    let provider_kind = if crate::codegen::is_codegen_task(&spec.task) {
        "codegen"
    } else if is_module_task {
        "wasm"
    } else {
        "local"
    };
    emit_or_log(
        &app_handle,
        "provider-decision",
        serde_json::json!({
            "jobId": spec.job_id.clone(),
            "task": spec.task.clone(),
            "provider": provider_kind,
            "workspaceId": spec.workspace_id.clone(),
            "policyVersion": std::env::var("UICP_POLICY_VERSION").unwrap_or_default(),
            "caps": {
                "fsRead": &spec.capabilities.fs_read,
                "fsWrite": &spec.capabilities.fs_write,
                "net": &spec.capabilities.net,
                "time": spec.capabilities.time,
                "random": spec.capabilities.random,
                "longRun": spec.capabilities.long_run,
                "memHigh": spec.capabilities.mem_high
            },
            "limits": {
                "memLimitMb": spec.mem_limit_mb,
                "timeoutMs": spec.timeout_ms,
                "fuel": spec.fuel
            },
            "cacheMode": spec.cache.clone(),
        }),
    );

    // Content-addressed cache lookup when enabled (normalize policy casing)
    let cache_mode = spec.cache.to_lowercase();
    if cache_mode == "readwrite" || cache_mode == "readonly" {
        let use_v2 = std::env::var("UICP_CACHE_V2")
            .ok()
            .map(|v| matches!(v.as_str(), "1" | "true" | "TRUE" | "on" | "yes"))
            .unwrap_or(false);
        let module_meta = crate::registry::find_module(&app_handle, &spec.task).ok().flatten();
        let invariants = {
            let mut parts: Vec<String> = Vec::new();
            if let Some(m) = &module_meta {
                parts.push(format!("modsha={}", m.entry.digest_sha256));
                parts.push(format!("modver={}", m.entry.version));
                if let Some(world) = m.provenance.as_ref().and_then(|p| p.wit_world.clone()) {
                    if !world.is_empty() { parts.push(format!("world={}", world)); }
                }
                parts.push("abi=wasi-p2".to_string());
            }
            if let Ok(pver) = std::env::var("UICP_POLICY_VERSION") { if !pver.is_empty() { parts.push(format!("policy={}", pver)); } }
            parts.join("|")
        };
        let key = if use_v2 {
            compute_cache::compute_key_v2_plus(&spec, &normalized_input, &invariants)
        } else {
            compute_cache::compute_key(&spec.task, &normalized_input, &spec.provenance.env_hash)
        };
        if let Ok(Some(mut cached)) =
            compute_cache::lookup(&app_handle, &spec.workspace_id, &key).await
        {
            // Mark cache hit in metrics if possible
            if let Some(obj) = cached.as_object_mut() {
                let metrics = obj
                    .entry("metrics")
                    .or_insert_with(|| serde_json::json!({}));
                if metrics.is_object() {
                    // SAFETY: Checked is_object() above
                    metrics
                        .as_object_mut()
                        .expect("metrics.is_object() checked above")
                        .insert("cacheHit".into(), serde_json::json!(true));
                } else {
                    *metrics = serde_json::json!({ "cacheHit": true });
                }
            }
            emit_or_log(
                &app_handle,
                crate::events::EVENT_COMPUTE_RESULT_FINAL,
                cached,
            );
            return Ok(());
        } else if cache_mode == "readonly" {
            let payload = ComputeFinalErr {
                ok: false,
                job_id: spec.job_id.clone(),
                task: spec.task.clone(),
                code: "Runtime.Fault".into(),
                message: "Cache miss under ReadOnly cache policy".into(),
                metrics: None,
            };
            emit_or_log(
                &app_handle,
                crate::events::EVENT_COMPUTE_RESULT_FINAL,
                &payload,
            );
            return Ok(());
        }
    }

    // Spawn the job via compute host (feature-gated implementation), respecting concurrency caps per provider.
    let queued_at = Instant::now();
    let is_module_task = crate::registry::find_module(&app_handle, &spec.task)
        .ok()
        .flatten()
        .is_some();
    let permit = if is_module_task {
        state
            .wasm_sem
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| e.to_string())?
    } else {
        state
            .compute_sem
            .clone()
            .acquire_owned()
            .await
            .map_err(|e| e.to_string())?
    };
    let queue_wait_ms = queued_at
        .elapsed()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX);
    // Pass a normalized cache policy down to the host
    let mut spec_norm = spec.clone();
    spec_norm.cache = cache_mode;
    spec_norm.input = normalized_input;
    #[cfg(feature = "otel_spans")]
    tracing::info!(target = "uicp", job_id = %spec.job_id, wait_ms = queue_wait_ms, "compute queued permit acquired");
    let join = if codegen::is_codegen_task(&spec_norm.task) {
        codegen::spawn_job(app_handle, spec_norm, Some(permit), queue_wait_ms)
    } else {
        compute::spawn_job(app_handle, spec_norm, Some(permit), queue_wait_ms)
    };
    // Bookkeeping: track the running job so we can cancel/cleanup later.
    state
        .compute_ongoing
        .write()
        .await
        .insert(spec.job_id.clone(), join);
    Ok(())
}

#[tauri::command]
async fn compute_cancel(
    state: State<'_, AppState>,
    job_id: String,
    window: tauri::Window,
) -> Result<(), String> {
    #[cfg(feature = "otel_spans")]
    tracing::info!(target = "uicp", job_id = %job_id, "compute_cancel invoked");
    // Emit telemetry: cancel requested
    let app_handle = window.app_handle().clone();
    let _ = app_handle.emit(
        "compute-debug",
        serde_json::json!({ "jobId": job_id, "event": "cancel_requested" }),
    );

    // Signal cancellation to the job if it registered a cancel channel
    if let Some(tx) = state.compute_cancel.read().await.get(&job_id).cloned() {
        let _ = tx.send(true);
    }

    // Give 250ms grace, then hard abort if still running
    let jid = job_id.clone();
    spawn(async move {
        tokio::time::sleep(Duration::from_millis(250)).await;
        let state: State<'_, AppState> = app_handle.state();
        let aborted = {
            let ongoing = state.compute_ongoing.read().await;
            if let Some(handle) = ongoing.get(&jid) {
                handle.abort();
                true
            } else {
                false
            }
        };

        if aborted {
            // Emit telemetry and clean up maps to avoid leaks when the host did not finalize
            let _ = app_handle.emit(
                "compute-debug",
                serde_json::json!({ "jobId": jid, "event": "cancel_aborted_after_grace" }),
            );
            {
                let state: State<'_, AppState> = app_handle.state();
                state.compute_cancel.write().await.remove(&jid);
                state.compute_ongoing.write().await.remove(&jid);
            }
        }
    });
    Ok(())
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
async fn get_paths() -> Result<serde_json::Value, String> {
    // Return canonical string paths so downstream logic receives stable values.
    Ok(serde_json::json!({
        "dataDir": DATA_DIR.display().to_string(),
        "dbPath": DB_PATH.display().to_string(),
        "envPath": ENV_PATH.display().to_string(),
        "filesDir": FILES_DIR.display().to_string(),
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
    let key_trimmed = key.trim().to_string();

    // Store in OS keyring using blocking task since keyring is sync
    let key_clone = key_trimmed.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let entry = Entry::new("UICP", "ollama_api_key")
            .map_err(|e| format!("Failed to access keyring: {e}"))?;
        entry
            .set_password(&key_clone)
            .map_err(|e| format!("Failed to store key in keyring: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Join error: {e}"))??;

    *state.ollama_key.write().await = Some(key_trimmed);
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

#[tauri::command]
async fn cancel_chat(state: State<'_, AppState>, request_id: String) -> Result<(), String> {
    if let Some(handle) = state.ongoing.write().await.remove(&request_id) {
        handle.abort();
    }
    Ok(())
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

#[tauri::command]
async fn chat_completion(
    window: tauri::Window,
    state: State<'_, AppState>,
    request_id: Option<String>,
    request: ChatCompletionRequest,
) -> Result<(), String> {
    let ChatCompletionRequest {
        model,
        messages,
        stream,
        tools,
        format,
        response_format,
        tool_choice,
        reasoning,
        options,
    } = request;

    if messages.is_empty() {
        return Err("messages cannot be empty".into());
    }

    let use_cloud = *state.use_direct_cloud.read().await;
    let debug_on = *state.debug_enabled.read().await;
    let api_key_opt = state.ollama_key.read().await.clone();
    if use_cloud && api_key_opt.is_none() {
        return Err("No API key configured".into());
    }

    let requested_model = model.unwrap_or_else(|| {
        // Default actor model favors Qwen3-Coder for consistent cloud/local pairing.
        std::env::var("ACTOR_MODEL").unwrap_or_else(|_| "qwen3-coder:480b".into())
    });
    // Normalize to colon-delimited tags for both Cloud and local.
    // If the input had a "-cloud" suffix, preserve it on local to aid routing.
    let resolved_model = normalize_model_name(&requested_model, use_cloud);

    let mut body = serde_json::json!({
        "model": resolved_model,
        "messages": messages,
        "stream": stream.unwrap_or(true),
        "tools": tools,
    });
    if let Some(format_val) = format {
        body["format"] = format_val;
    }
    if let Some(response_format_val) = response_format {
        body["response_format"] = response_format_val;
    }
    if let Some(tool_choice_val) = tool_choice {
        body["tool_choice"] = tool_choice_val;
    }
    if let Some(reasoning_val) = reasoning.clone() {
        body["reasoning"] = reasoning_val.clone();
        if use_cloud {
            if let Some(options_val) = options.clone() {
                body["options"] = options_val;
            } else {
                body["options"] = serde_json::json!({ "reasoning": reasoning_val });
            }
        }
    } else if use_cloud {
        if let Some(options_val) = options {
            body["options"] = options_val;
        }
    }

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
    let stream_flag_for_task = body_payload
        .get("stream")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let circuit_breakers = Arc::clone(&state.circuit_breakers);
    let base_host = Url::parse(&base_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()));
    let handshake_timeout = Duration::from_secs(60);
    // Idle timeout for streaming chunks: if no delta arrives within this window, cancel the stream.
    let idle_timeout = Duration::from_millis(
        std::env::var("CHAT_IDLE_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(35_000),
    );
    let circuit_config = state.circuit_config.clone();
    let user_agent = format!("{}/tauri {}", APP_NAME, env!("CARGO_PKG_VERSION"));

    let join: JoinHandle<()> = spawn(async move {
        // best-effort logs dir
        if debug_on {
            let _ = tokio::fs::create_dir_all(&logs_dir).await;
        }
        let trace_path = logs_dir.join(format!("trace-{}.ndjson", rid_for_task));

        let append_trace = |event: serde_json::Value| {
            let path = trace_path.clone();
            async move {
                let line = format!("{event}\n");
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

        let emit_circuit_telemetry = |event_name: &str, payload: serde_json::Value| {
            let handle = app_handle.clone();
            let name = event_name.to_string();
            tokio::spawn(async move {
                let _ = handle.emit(&name, payload);
            });
        };

        if debug_on {
            let url = if use_cloud {
                format!("{}/api/chat", base_url)
            } else {
                format!("{}/chat/completions", base_url)
            };
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

            // request metadata snapshot (no secrets)
            let messages_len = body_payload
                .get("messages")
                .and_then(|m| m.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            let format_present = body_payload.get("format").is_some();
            let tools_count = body_payload
                .get("tools")
                .and_then(|t| t.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            let meta = serde_json::json!({
                "ts": Utc::now().timestamp_millis(),
                "event": "request_body_meta",
                "requestId": rid_for_task,
                "messages": messages_len,
                "format": format_present,
                "tools": tools_count,
            });
            tokio::spawn(append_trace(meta.clone()));
            tokio::spawn(emit_debug(meta));
        }
        let mut request_body = body_payload;
        let mut attempt_local: u8 = 0;
        let mut fallback_tried: bool = false;
        'outer: loop {
            attempt_local += 1;
            let url = if use_cloud {
                format!("{}/api/chat", base_url)
            } else {
                format!("{}/chat/completions", base_url)
            };

            let host_for_attempt = Url::parse(&url)
                .ok()
                .and_then(|u| u.host_str().map(|h| h.to_string()))
                .or_else(|| base_host.clone());

            if let Some(host) = host_for_attempt.as_deref() {
                if let Some(until) = circuit::circuit_is_open(&circuit_breakers, host).await {
                    let wait_ms =
                        until.saturating_duration_since(Instant::now()).as_millis() as u64;
                    if debug_on {
                        let ev = serde_json::json!({
                            "ts": Utc::now().timestamp_millis(),
                            "event": "circuit_blocked",
                            "requestId": rid_for_task,
                            "host": host,
                            "retryMs": wait_ms,
                        });
                        tokio::spawn(append_trace(ev.clone()));
                        tokio::spawn(emit_debug(ev));
                    }
                    emit_problem_detail(
                        &app_handle,
                        &rid_for_task,
                        503,
                        "CircuitOpen",
                        "Remote temporarily unavailable",
                        Some(wait_ms),
                    );
                    break;
                }
            }

            let mut builder = client
                .post(&url)
                .json(&request_body)
                .header("X-Request-Id", &rid_for_task)
                .header("Idempotency-Key", &rid_for_task)
                .header("User-Agent", user_agent.as_str());

            if use_cloud {
                if let Some(key) = &api_key_for_task {
                    builder = builder.header("Authorization", format!("Bearer {}", key));
                }
            }

            if stream_flag_for_task {
                builder = builder.header("Accept", "text/event-stream");
            }

            let resp_res = timeout(handshake_timeout, builder.send()).await;

            let resp = match resp_res {
                Err(_) => {
                    if debug_on {
                        let ev = serde_json::json!({
                            "ts": Utc::now().timestamp_millis(),
                            "event": "request_timeout",
                            "requestId": rid_for_task,
                            "elapsedMs": handshake_timeout.as_millis() as u64,
                        });
                        tokio::spawn(append_trace(ev.clone()));
                        tokio::spawn(emit_debug(ev));
                    }
                    if let Some(host) = host_for_attempt.as_deref() {
                        circuit::circuit_record_failure(
                            &circuit_breakers,
                            host,
                            &circuit_config,
                            emit_circuit_telemetry,
                        )
                        .await;
                    }
                    if attempt_local < max_attempts {
                        let backoff_ms = 200u64.saturating_mul(1u64 << (attempt_local as u32));
                        tokio::time::sleep(Duration::from_millis(backoff_ms.min(5_000))).await;
                        continue 'outer;
                    }
                    emit_problem_detail(
                        &app_handle,
                        &rid_for_task,
                        408,
                        "RequestTimeout",
                        "Upstream handshake timed out",
                        None,
                    );
                    break;
                }
                Ok(res) => res,
            };

            match resp {
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
                    if let Some(host) = host_for_attempt.as_deref() {
                        circuit::circuit_record_failure(
                            &circuit_breakers,
                            host,
                            &circuit_config,
                            emit_circuit_telemetry,
                        )
                        .await;
                    }
                    let transient = err.is_timeout() || err.is_connect();
                    if transient && attempt_local < max_attempts {
                        let backoff_ms = 200u64.saturating_mul(1u64 << (attempt_local as u32));
                        tokio::time::sleep(Duration::from_millis(backoff_ms.min(5_000))).await;
                        continue 'outer;
                    }
                    emit_problem_detail(
                        &app_handle,
                        &rid_for_task,
                        503,
                        "TransportError",
                        &err.to_string(),
                        None,
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
                        let retry_after_ms = resp
                            .headers()
                            .get("retry-after")
                            .and_then(|h| h.to_str().ok())
                            .and_then(|raw| raw.parse::<u64>().ok())
                            .map(|secs| secs.saturating_mul(1_000));

                        if let Some(host) = host_for_attempt.as_deref() {
                            circuit::circuit_record_failure(
                                &circuit_breakers,
                                host,
                                &circuit_config,
                                emit_circuit_telemetry,
                            )
                            .await;
                            if debug_on {
                                let ev = serde_json::json!({
                                    "ts": Utc::now().timestamp_millis(),
                                    "event": "response_failure",
                                    "requestId": rid_for_task,
                                    "status": status.as_u16(),
                                    "host": host,
                                    "retryMs": retry_after_ms,
                                });
                                tokio::spawn(append_trace(ev.clone()));
                                tokio::spawn(emit_debug(ev));
                            }
                        }

                        let should_retry = (status.as_u16() == 429 || status.as_u16() == 503)
                            && attempt_local < max_attempts;
                        if should_retry {
                            let fallback_ms = 200u64.saturating_mul(1u64 << (attempt_local as u32));
                            let wait_ms = retry_after_ms.unwrap_or(fallback_ms).min(10_000);
                            if debug_on {
                                let ev = serde_json::json!({
                                    "ts": Utc::now().timestamp_millis(),
                                    "event": "retry_backoff",
                                    "requestId": rid_for_task,
                                    "waitMs": wait_ms,
                                });
                                tokio::spawn(append_trace(ev.clone()));
                                tokio::spawn(emit_debug(ev));
                            }
                            tokio::time::sleep(Duration::from_millis(wait_ms)).await;
                            continue 'outer;
                        }

                        if use_cloud && !fallback_tried {
                            if let Some(orig_model) = request_body
                                .get("model")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                            {
                                match std::env::var("FALLBACK_CLOUD_MODEL") {
                                    Ok(fallback_model)
                                        if !fallback_model.is_empty()
                                            && fallback_model != orig_model =>
                                    {
                                        if debug_on {
                                            let ev = serde_json::json!({
                                                "ts": Utc::now().timestamp_millis(),
                                                "event": "retry_with_fallback_model",
                                                "requestId": rid_for_task,
                                                "from": orig_model,
                                                "to": fallback_model,
                                            });
                                            tokio::spawn(append_trace(ev.clone()));
                                            tokio::spawn(emit_debug(ev));
                                        }
                                        request_body["model"] = serde_json::json!(fallback_model);
                                        fallback_tried = true;
                                        continue 'outer;
                                    }
                                    Err(_) if debug_on => {
                                        let ev = serde_json::json!({
                                            "ts": Utc::now().timestamp_millis(),
                                            "event": "no_fallback_configured",
                                            "requestId": rid_for_task,
                                            "from": orig_model,
                                        });
                                        tokio::spawn(append_trace(ev.clone()));
                                        tokio::spawn(emit_debug(ev));
                                    }
                                    _ => {}
                                }
                            }
                        }

                        let detail = match resp.text().await {
                            Ok(text) if !text.is_empty() => text,
                            _ => status
                                .canonical_reason()
                                .unwrap_or("Upstream failure")
                                .to_string(),
                        };
                        emit_problem_detail(
                            &app_handle,
                            &rid_for_task,
                            status.as_u16(),
                            "UpstreamFailure",
                            &detail,
                            retry_after_ms,
                        );
                        break;
                    }

                    let mut stream = resp.bytes_stream();
                    let mut stream_failed = false;
                    // SSE assembly state
                    let mut carry = String::new();
                    let mut event_buf = String::new();

                    const DEBUG_PREVIEW_CHARS: usize = 512;
                    let preview_payload = |input: &str| -> (String, bool) {
                        let mut iter = input.chars();
                        let mut out = String::new();
                        for _ in 0..DEBUG_PREVIEW_CHARS {
                            match iter.next() {
                                Some(ch) => out.push(ch),
                                None => return (out, false),
                            }
                        }
                        if iter.next().is_some() {
                            out.push_str("...");
                            (out, true)
                        } else {
                            (out, false)
                        }
                    };

                    // Helper to process a complete SSE payload line (assembled in event_buf)
                    let process_payload = |payload_str: &str,
                                           app_handle: &tauri::AppHandle,
                                           rid: &str| {
                        if payload_str == "[DONE]" {
                            if debug_on {
                                let ev = serde_json::json!({
                                    "ts": Utc::now().timestamp_millis(),
                                    "event": "stream_done",
                                    "requestId": rid,
                                });
                                tokio::spawn(append_trace(ev.clone()));
                                tokio::spawn(emit_debug(ev));
                            }
                            emit_or_log(
                                app_handle,
                                "ollama-completion",
                                serde_json::json!({ "done": true }),
                            );
                            return;
                        }
                        match serde_json::from_str::<serde_json::Value>(payload_str) {
                            Ok(val) => {
                                if val.get("done").and_then(|v| v.as_bool()).unwrap_or(false) {
                                    if debug_on {
                                        let ev = serde_json::json!({
                                            "ts": Utc::now().timestamp_millis(),
                                            "event": "delta_done",
                                            "requestId": rid,
                                        });
                                        tokio::spawn(append_trace(ev.clone()));
                                        tokio::spawn(emit_debug(ev));
                                    }
                                    emit_or_log(
                                        app_handle,
                                        "ollama-completion",
                                        serde_json::json!({ "done": true }),
                                    );
                                    return;
                                }
                                if debug_on {
                                    let (preview, truncated) = preview_payload(payload_str);
                                    let ev = serde_json::json!({
                                        "ts": Utc::now().timestamp_millis(),
                                        "event": "delta_json",
                                        "requestId": rid,
                                        "len": payload_str.len(),
                                        "payload": val.clone(),
                                        "preview": preview,
                                        "truncated": truncated,
                                    });
                                    tokio::spawn(append_trace(ev.clone()));
                                    tokio::spawn(emit_debug(ev));
                                }
                                emit_or_log(
                                    app_handle,
                                    "ollama-completion",
                                    serde_json::json!({ "done": false, "delta": payload_str, "kind": "json" }),
                                );
                            }
                            Err(_) => {
                                if debug_on {
                                    let (preview, truncated) = preview_payload(payload_str);
                                    let ev = serde_json::json!({
                                        "ts": Utc::now().timestamp_millis(),
                                        "event": "delta_text",
                                        "requestId": rid,
                                        "len": payload_str.len(),
                                        "text": preview,
                                        "truncated": truncated,
                                    });
                                    tokio::spawn(append_trace(ev.clone()));
                                    tokio::spawn(emit_debug(ev));
                                }
                                emit_or_log(
                                    app_handle,
                                    "ollama-completion",
                                    serde_json::json!({ "done": false, "delta": payload_str, "kind": "text" }),
                                );
                            }
                        }
                    };

                    loop {
                        // Enforce idle timeout between streamed chunks
                        let next = tokio::time::timeout(idle_timeout, stream.next()).await;
                        match next {
                            Err(_) => {
                                stream_failed = true;
                                if debug_on {
                                    let ev = serde_json::json!({
                                        "ts": Utc::now().timestamp_millis(),
                                        "event": "stream_idle_timeout",
                                        "requestId": rid_for_task,
                                        "idleMs": idle_timeout.as_millis() as u64,
                                    });
                                    tokio::spawn(append_trace(ev.clone()));
                                    tokio::spawn(emit_debug(ev));
                                }
                                emit_problem_detail(
                                    &app_handle,
                                    &rid_for_task,
                                    408,
                                    "RequestTimeout",
                                    "Streaming idle timeout",
                                    None,
                                );
                                break;
                            }
                            Ok(None) => {
                                // Stream ended gracefully
                                if debug_on {
                                    let ev = serde_json::json!({
                                        "ts": Utc::now().timestamp_millis(),
                                        "event": "stream_eof",
                                        "requestId": rid_for_task,
                                    });
                                    tokio::spawn(append_trace(ev.clone()));
                                    tokio::spawn(emit_debug(ev));
                                }
                                // Process any trailing payload still buffered
                                if !event_buf.trim().is_empty() {
                                    process_payload(&event_buf, &app_handle, &rid_for_task);
                                    event_buf.clear();
                                }
                                emit_or_log(
                                    &app_handle,
                                    "ollama-completion",
                                    serde_json::json!({ "done": true }),
                                );
                                break;
                            }
                            Ok(Some(chunk)) => match chunk {
                                Err(err) => {
                                    stream_failed = true;
                                    if debug_on {
                                        let ev = serde_json::json!({
                                            "ts": Utc::now().timestamp_millis(),
                                            "event": "stream_error",
                                            "requestId": rid_for_task,
                                            "error": err.to_string(),
                                        });
                                        tokio::spawn(append_trace(ev.clone()));
                                        tokio::spawn(emit_debug(ev));
                                    }
                                    emit_problem_detail(
                                        &app_handle,
                                        &rid_for_task,
                                        502,
                                        "StreamError",
                                        "Streaming response terminated unexpectedly",
                                        None,
                                    );
                                    break;
                                }
                                Ok(bytes) => {
                                    // Append chunk and process complete lines only; keep remainder in carry.
                                    carry.push_str(&String::from_utf8_lossy(&bytes));
                                    loop {
                                        if let Some(idx) = carry.find('\n') {
                                            let mut line = carry[..idx].to_string();
                                            // drain including newline
                                            carry.drain(..=idx);
                                            // handle CRLF
                                            if line.ends_with('\r') {
                                                line.pop();
                                            }
                                            let trimmed = line.trim();
                                            if trimmed.is_empty() {
                                                // blank line terminates one SSE event
                                                if !event_buf.is_empty() {
                                                    let payload = std::mem::take(&mut event_buf);
                                                    process_payload(
                                                        &payload,
                                                        &app_handle,
                                                        &rid_for_task,
                                                    );
                                                }
                                                continue;
                                            }
                                            if let Some(stripped) = trimmed.strip_prefix("data:") {
                                                let content = stripped.trim();
                                                if content == "[DONE]" {
                                                    process_payload(
                                                        "[DONE]",
                                                        &app_handle,
                                                        &rid_for_task,
                                                    );
                                                    // reset event buffer
                                                    event_buf.clear();
                                                    continue;
                                                }
                                                event_buf.push_str(content);
                                                continue;
                                            }
                                            // Fallback: treat line as payload content (non-SSE providers)
                                            event_buf.push_str(trimmed);
                                        } else {
                                            break;
                                        }
                                    }
                                }
                            },
                        }
                    }

                    if stream_failed {
                        if let Some(host) = host_for_attempt.as_deref() {
                            circuit::circuit_record_failure(
                                &circuit_breakers,
                                host,
                                &circuit_config,
                                emit_circuit_telemetry,
                            )
                            .await;
                        }
                        break;
                    }

                    if let Some(host) = host_for_attempt.as_deref() {
                        circuit::circuit_record_success(
                            &circuit_breakers,
                            host,
                            emit_circuit_telemetry,
                        )
                        .await;
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

        // Ensure we always cleanup the request handle on any terminal exit of the outer loop.
        remove_chat_request(&app_handle, &rid_for_task).await;
    });

    state.ongoing.write().await.insert(rid.clone(), join);
    Ok(())
}

// Database schema management is implemented in core::init_database and helpers.

fn load_env_key(state: &AppState) -> anyhow::Result<()> {
    // Try to load API key from keyring first
    let entry = Entry::new("UICP", "ollama_api_key")?;
    let mut key_from_keyring = false;

    if let Ok(stored_key) = entry.get_password() {
        state.ollama_key.blocking_write().replace(stored_key);
        key_from_keyring = true;
    }

    // Load other config from .env or environment
    let mut env_api_key: Option<String> = None;

    if ENV_PATH.exists() {
        for item in dotenvy::from_path_iter(&*ENV_PATH)? {
            let (key, value) = item?;
            if key == "OLLAMA_API_KEY" {
                env_api_key = Some(value);
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
        env_api_key = std::env::var("OLLAMA_API_KEY").ok();
        if let Ok(val) = std::env::var("USE_DIRECT_CLOUD") {
            let use_cloud = val == "1" || val.to_lowercase() == "true";
            *state.use_direct_cloud.blocking_write() = use_cloud;
        }
    }

    // Migration: if API key was in .env but not in keyring, migrate it
    if !key_from_keyring {
        if let Some(key_value) = env_api_key {
            eprintln!("Migrating OLLAMA_API_KEY from .env to secure keyring...");
            if let Err(e) = entry.set_password(&key_value) {
                eprintln!("Warning: Failed to migrate API key to keyring: {e}");
            } else {
                eprintln!("Successfully migrated API key to keyring. You can now remove OLLAMA_API_KEY from .env");
            }
            state.ollama_key.blocking_write().replace(key_value);
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
                    eprintln!("Database maintenance failed: {e:?}");
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
    if let Err(err) = dotenv() {
        eprintln!("Failed to load .env: {err:?}");
    }

    let db_path = DB_PATH.clone();

    // Initialize database and ensure directory exists BEFORE opening connections
    if let Err(err) = init_database(&db_path) {
        eprintln!("Failed to initialize database: {err:?}");
        std::process::exit(1);
    }
    if let Err(err) = ensure_default_workspace(&db_path) {
        eprintln!("Failed to ensure default workspace: {err:?}");
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
            eprintln!("Failed to start action log service: {err:?}");
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
        eprintln!("E-UICP-0660: failed to append boot action-log entry: {err:?}");
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
        action_log,
        job_token_key,
    };

    if let Err(err) = load_env_key(&state) {
        eprintln!("Failed to load environment keys: {err:?}");
        std::process::exit(1);
    }

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
                eprintln!("create data dir failed: {e:?}");
            }
            if let Err(e) = std::fs::create_dir_all(&*LOGS_DIR) {
                eprintln!("create logs dir failed: {e:?}");
            }
            if let Err(e) = std::fs::create_dir_all(&*FILES_DIR) {
                eprintln!("create files dir failed: {e:?}");
            }
            // Ensure bundled compute modules are installed into the user modules dir
            if let Err(err) = crate::registry::install_bundled_modules_if_missing(&app.handle()) {
                eprintln!("module install failed: {err:?}");
            }
            spawn_autosave(app.handle().clone());
            // Periodic DB maintenance to keep WAL and stats tidy
            spawn_db_maintenance(app.handle().clone());

            #[cfg(feature = "wasm_compute")]
            {
                let handle = app.handle().clone();
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    if let Err(err) = crate::compute::prewarm_quickjs(&handle) {
                        eprintln!("quickjs prewarm failed: {err:?}");
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
                eprintln!("splash app:// failed, falling back to data URL: {err:?}");
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
                    eprintln!("failed to create splash window (data URL fallback): {err2:?}");
                }
            }

            // Frontend will call the `frontend_ready` command; see handler below.
            // Run DB health check at startup; enter Safe Mode on failure
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = health_quick_check_internal(&handle).await {
                    eprintln!("health_quick_check failed: {err:?}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_paths,
            copy_into_files,
            get_modules_info,
            get_modules_registry,
            get_action_log_stats,
            verify_modules,
            open_path,
            load_api_key,
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
            chat_completion,
            cancel_chat,
            compute_call,
            compute_cancel,
            mint_job_token,
            debug_circuits,
            kill_container,
            set_env_var,
            save_provider_api_key,
            provider_pull_image,
            provider_login,
            provider_health,
            provider_resolve,
            provider_install,
            frontend_ready,
            check_container_runtime,
            check_network_capabilities
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


/// Set or unset a process environment variable for subsequent provider operations.
/// ERROR: E-UICP-9201 invalid name
/// Check if container runtime (Docker/Podman) is available
#[tauri::command]
async fn check_container_runtime() -> Result<serde_json::Value, String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("check_container_runtime");
    use std::process::Command;
    
    // Check for Docker
    if let Ok(output) = Command::new("docker").arg("version").arg("--format").arg("{{.Server.Version}}").output() {
        if output.status.success() {
            #[cfg(feature = "otel_spans")]
            tracing::info!(target = "uicp", runtime = "docker", "container runtime detected");
            return Ok(serde_json::json!({
                "available": true,
                "runtime": "docker",
                "version": String::from_utf8_lossy(&output.stdout).trim()
            }));
        }
    }
    
    // Check for Podman
    if let Ok(output) = Command::new("podman").arg("version").arg("--format").arg("{{.Server.Version}}").output() {
        if output.status.success() {
            #[cfg(feature = "otel_spans")]
            tracing::info!(target = "uicp", runtime = "podman", "container runtime detected");
            return Ok(serde_json::json!({
                "available": true,
                "runtime": "podman",
                "version": String::from_utf8_lossy(&output.stdout).trim()
            }));
        }
    }
    
    #[cfg(feature = "otel_spans")]
    tracing::warn!(target = "uicp", "no container runtime found");
    Ok(serde_json::json!({
        "available": false,
        "error": "No container runtime found (Docker or Podman required)"
    }))
}

/// Check network capabilities and restrictions.
/// WHY: Avoid misleading telemetry; report actual network gate.
/// INVARIANT: Network is disabled unless `UICP_ALLOW_NET` is explicitly enabled.
#[tauri::command]
async fn check_network_capabilities() -> Result<serde_json::Value, String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("check_network_capabilities");

    // Gate network with an explicit env flag.
    // Accept common truthy forms: 1,true,yes,on (case-insensitive).
    fn parse_env_flag(value: &str) -> bool {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    }

    let has_network = std::env::var("UICP_ALLOW_NET")
        .ok()
        .map(|v| parse_env_flag(&v))
        .unwrap_or(false);

    // If network is enabled, it's still constrained by provider allowlists via httpjail.
    // Keep reason explicit for operators.
    let (restricted, reason) = if has_network {
        (
            true,
            Some(
                "enabled by UICP_ALLOW_NET; provider calls restricted by httpjail allowlists"
                    .to_string(),
            ),
        )
    } else {
        (
            true,
            Some("network disabled by policy; set UICP_ALLOW_NET=1 to enable".to_string()),
        )
    };

    // Load a concise httpjail allowlist summary (best-effort).
    fn allowlist_path() -> std::path::PathBuf {
        if let Some(override_os) = std::env::var_os("UICP_HTTPJAIL_ALLOWLIST") {
            let p = std::path::PathBuf::from(&override_os);
            if !p.as_os_str().is_empty() {
                return p;
            }
        }
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join("ops")
            .join("code")
            .join("network")
            .join("allowlist.json")
    }

    let policy_path = allowlist_path();
    let allowlist_summary: Option<serde_json::Value> = match std::fs::read_to_string(&policy_path) {
        Ok(content) => match serde_json::from_str::<serde_json::Value>(&content) {
            Ok(v) => {
                let mut providers_obj = serde_json::Map::new();
                if let Some(providers) = v.get("providers").and_then(|x| x.as_object()) {
                    for (name, entry) in providers {
                        let hosts = entry
                            .get("hosts")
                            .and_then(|h| h.as_array())
                            .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>())
                            .unwrap_or_default();
                        let methods = entry
                            .get("methods")
                            .and_then(|m| m.as_array())
                            .map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>())
                            .unwrap_or_default();
                        let block_post = entry
                            .get("blockPost")
                            .and_then(|b| b.as_bool())
                            .unwrap_or(true);

                        let sample_hosts: Vec<&str> = hosts.iter().copied().take(3).collect();
                        let provider_json = serde_json::json!({
                            "hostsCount": hosts.len(),
                            "hostsSample": sample_hosts,
                            "methods": methods,
                            "blockPost": block_post,
                        });
                        providers_obj.insert(name.clone(), provider_json);
                    }
                }
                Some(serde_json::json!({
                    "source": policy_path.display().to_string(),
                    "providers": providers_obj,
                }))
            }
            Err(err) => Some(serde_json::json!({
                "error": format!("E-UICP-9301: allowlist parse failed: {}", err),
                "source": policy_path.display().to_string(),
            })),
        },
        Err(err) => Some(serde_json::json!({
            "error": format!("E-UICP-9300: allowlist read failed: {}", err),
            "source": policy_path.display().to_string(),
        })),
    };

    let json = serde_json::json!({
        "hasNetwork": has_network,
        "restricted": restricted,
        "reason": reason,
        "allowlist": allowlist_summary
    });

    #[cfg(feature = "otel_spans")]
    tracing::info!(target = "uicp", has_network, restricted, "network capabilities returned");
    Ok(json)
}

#[tauri::command]
async fn set_env_var(name: String, value: Option<String>) -> Result<(), String> {
    let key = name.trim();
    if key.is_empty() || key.contains('\0') || key.contains('=') {
        return Err("E-UICP-9201: invalid env var name".into());
    }
    match value {
        Some(v) => std::env::set_var(key, v),
        None => std::env::remove_var(key),
    }
    Ok(())
}

/// Save a provider API key to the OS keyring.
/// provider: "openai" or "anthropic"
/// ERROR: E-UICP-9202 invalid provider; E-UICP-9203 keyring error
#[tauri::command]
async fn save_provider_api_key(provider: String, key: String) -> Result<(), String> {
    let account = match provider.trim().to_ascii_lowercase().as_str() {
        "openai" => "openai_api_key",
        "anthropic" => "anthropic_api_key",
        other => return Err(format!("E-UICP-9202: invalid provider '{other}'")),
    };
    let key_trimmed = key.trim().to_string();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let entry = Entry::new("UICP", account)
            .map_err(|e| format!("E-UICP-9203: keyring access failed: {e}"))?;
        entry
            .set_password(&key_trimmed)
            .map_err(|e| format!("E-UICP-9203: keyring store failed: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Join error: {e}"))??;
    Ok(())
}

/// Pull the container image for a provider (docker or podman). Returns the image name.
/// ERROR: E-UICP-9204 runtime missing; E-UICP-9205 pull failed
#[tauri::command]
async fn provider_pull_image(provider: String) -> Result<serde_json::Value, String> {
    fn try_pull(bin: &str, image: &str) -> Result<(), String> {
        let out = std::process::Command::new(bin)
            .arg("pull")
            .arg(image)
            .output()
            .map_err(|e| format!("E-UICP-9204: spawn {bin} failed: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "E-UICP-9205: {bin} pull exited {}: {}",
                out.status.code().unwrap_or(-1),
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(())
    }

    let normalized = provider.trim().to_ascii_lowercase();
    let image = match normalized.as_str() {
        "codex" => std::env::var("CODEX_IMAGE").unwrap_or_else(|_| "uicp/codex-cli:latest".into()),
        "claude" => std::env::var("CLAUDE_IMAGE").unwrap_or_else(|_| "uicp/claude-code:latest".into()),
        other => return Err(format!("E-UICP-9202: invalid provider '{other}'")),
    };
    match try_pull("docker", &image) {
        Ok(_) => Ok(serde_json::json!({ "image": image, "runtime": "docker" })),
        Err(_e1) => match try_pull("podman", &image) {
            Ok(_) => Ok(serde_json::json!({ "image": image, "runtime": "podman" })),
            Err(e2) => Err(e2),
        },
    }
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

/// Stop a running container by name using docker or podman.
/// ERROR: E-UICP-9101 spawn failed; E-UICP-9102 runtime missing
#[tauri::command]
async fn kill_container(container_name: String) -> Result<(), String> {
    fn try_stop(bin: &str, name: &str) -> Result<(), String> {
        let out = std::process::Command::new(bin)
            .arg("stop")
            .arg(name)
            .output()
            .map_err(|e| format!("E-UICP-9101: spawn {bin} failed: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "E-UICP-9101: {bin} stop exited {}: {}",
                out.status.code().unwrap_or(-1),
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(())
    }

    // Try docker then podman
    match try_stop("docker", &container_name) {
        Ok(_) => Ok(()),
        Err(_e1) => match try_stop("podman", &container_name) {
            Ok(_) => Ok(()),
            Err(e2) => Err(format!(
                "E-UICP-9102: container runtime missing or stop failed: {e2}"
            )),
        },
    }
}

#[tauri::command]
async fn provider_login(provider: String) -> Result<ProviderLoginResult, String> {
    let normalized = provider.trim().to_ascii_lowercase();
    provider_cli::login(&normalized).await
}

#[tauri::command]
async fn provider_health(provider: String) -> Result<ProviderHealthResult, String> {
    let normalized = provider.trim().to_ascii_lowercase();
    provider_cli::health(&normalized).await
}

#[tauri::command]
async fn provider_resolve(provider: String) -> Result<serde_json::Value, String> {
    let normalized = provider.trim().to_ascii_lowercase();
    let res = provider_cli::resolve(&normalized)?;
    Ok(serde_json::json!({ "exe": res.exe, "via": res.via }))
}

#[tauri::command]
async fn provider_install(
    provider: String,
    version: Option<String>,
) -> Result<serde_json::Value, String> {
    let normalized = provider.trim().to_ascii_lowercase();
    match provider_cli::install(&normalized, version.as_deref()).await {
        Ok(r) => Ok(serde_json::json!({
            "ok": r.ok,
            "provider": r.provider,
            "exe": r.exe,
            "via": r.via,
            "detail": r.detail,
        })),
        Err(e) => Err(e),
    }
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
        .map(|s| matches!(s.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
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
