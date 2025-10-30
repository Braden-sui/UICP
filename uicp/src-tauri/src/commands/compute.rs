use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64_ENGINE;
use base64::Engine as _;
use chrono::Utc;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tauri::{
    async_runtime::spawn, Emitter, Manager, State, WebviewUrl,
};
use tokio::sync::RwLock;

use crate::core::{emit_or_log, APP_NAME, DATA_DIR, DB_PATH, ENV_PATH, FILES_DIR, LOGS_DIR};
use crate::policy::enforce_compute_policy;
use crate::compute_cache;
use crate::compute_input::canonicalize_task_input;
use crate::codegen;
use crate::compute;
use crate::registry;
use crate::authz;
use crate::policy::{
    ComputeBindSpec, ComputeCapabilitiesSpec, ComputeFinalErr,
    ComputeFinalOk, ComputeJobSpec, ComputePartialEvent, ComputeProvenanceSpec,
};

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatCompletionRequest {
    pub model: Option<String>,
    pub messages: Vec<ChatMessageInput>,
    pub stream: Option<bool>,
    pub tools: Option<serde_json::Value>,
    pub format: Option<serde_json::Value>,
    #[serde(rename = "response_format")]
    pub response_format: Option<serde_json::Value>,
    #[serde(rename = "tool_choice")]
    pub tool_choice: Option<serde_json::Value>,
    pub reasoning: Option<serde_json::Value>,
    pub options: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageInput {
    pub role: String,
    // Accept structured developer payloads (objects) and legacy string messages.
    pub content: serde_json::Value,
}

#[tauri::command]
pub async fn compute_call(
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

    // --- Host policy enforcement (coarse gate) ---
    let task_key = {
        let t = spec.task.as_str();
        if let Some(at) = t.find('@') {
            let (name, ver) = t.split_at(at);
            let ver = &ver[1..];
            let major = ver.split('.').next().unwrap_or(ver);
            format!("{}@{}", name, major)
        } else {
            t.to_string()
        }
    };
    if !crate::authz::allow_compute(&task_key) {
        let payload = ComputeFinalErr {
            ok: false,
            job_id: spec.job_id.clone(),
            task: spec.task.clone(),
            code: "PolicyDenied".into(),
            message: format!("Denied by permissions.json (scope: compute:{})", task_key),
            metrics: None,
        };
        emit_or_log(
            &window.app_handle(),
            crate::events::EVENT_COMPUTE_RESULT_FINAL,
            &payload,
        );
        return Ok(());
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
        let module_meta = crate::registry::find_module(&app_handle, &spec.task)
            .ok()
            .flatten();
        let invariants = {
            let mut parts: Vec<String> = Vec::new();
            if let Some(m) = &module_meta {
                parts.push(format!("modsha={}", m.entry.digest_sha256));
                parts.push(format!("modver={}", m.entry.version));
                if let Some(world) = m.provenance.as_ref().and_then(|p| p.wit_world.clone()) {
                    if !world.is_empty() {
                        parts.push(format!("world={}", world));
                    }
                }
                parts.push("abi=wasi-p2".to_string());
            }
            if let Ok(pver) = std::env::var("UICP_POLICY_VERSION") {
                if !pver.is_empty() {
                    parts.push(format!("policy={}", pver));
                }
            }
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
pub async fn compute_cancel(
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

#[tauri::command]
pub async fn get_paths() -> Result<serde_json::Value, String> {
    // Return canonical string paths so downstream logic receives stable values.
    Ok(serde_json::json!({
        "dataDir": DATA_DIR.display().to_string(),
        "dbPath": DB_PATH.display().to_string(),
        "envPath": ENV_PATH.display().to_string(),
        "filesDir": FILES_DIR.display().to_string(),
    }))
}
