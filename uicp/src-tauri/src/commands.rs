#![cfg(any(test, feature = "compute_harness"))]
// WHY: These command shims back compute harness/testing flows only; exclude them from production wasm builds to keep CI warning-free.

use tauri::{Emitter, Manager, Runtime, State};
// use anyhow::Context;

use crate::{
    codegen, compute, compute_cache, compute_input::canonicalize_task_input, emit_or_log,
    enforce_compute_policy, provider_cli, registry, AppState, ComputeFinalErr, ComputeJobSpec,
};
use std::time::Instant;

pub async fn compute_call<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    spec: ComputeJobSpec,
) -> Result<(), String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("compute_call", job_id = %spec.job_id, task = %spec.task, cache = %spec.cache);
    // Reject duplicate job ids
    if state
        .compute_ongoing
        .read()
        .await
        .contains_key(&spec.job_id)
    {
        return Err(format!("Duplicate job id {}", spec.job_id));
    }

    let app_handle = app.clone();

    // --- Policy enforcement ---
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

    // Provider decision telemetry (host-owned for harness)
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

    // Cache lookup when enabled
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
            if let Some(obj) = cached.as_object_mut() {
                let metrics = obj
                    .entry("metrics")
                    .or_insert_with(|| serde_json::json!({}));
                if metrics.is_object() {
                    metrics
                        .as_object_mut()
                        .unwrap()
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
            let payload = crate::ComputeFinalErr {
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

    // Spawn the job respecting concurrency cap (route wasm tasks through wasm_sem)
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
    let mut spec_norm = spec.clone();
    spec_norm.cache = cache_mode;
    spec_norm.input = normalized_input;
    let join = if codegen::is_codegen_task(&spec_norm.task) {
        codegen::spawn_job(app_handle, spec_norm, Some(permit), queue_wait_ms)
    } else {
        compute::spawn_job(app_handle, spec_norm, Some(permit), queue_wait_ms)
    };
    state
        .compute_ongoing
        .write()
        .await
        .insert(spec.job_id.clone(), join);
    #[cfg(feature = "otel_spans")]
    tracing::info!(target = "uicp", job_id = %spec.job_id, task = %spec.task, wait_ms = queue_wait_ms, "job spawned");
    Ok(())
}

pub async fn compute_cancel<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    job_id: String,
) -> Result<(), String> {
    #[cfg(feature = "otel_spans")]
    tracing::info!(target = "uicp", job_id = %job_id, "compute cancel requested");
    let app_handle = app.clone();
    let _ = app_handle.emit(
        "compute-debug",
        serde_json::json!({ "jobId": job_id, "event": "cancel_requested" }),
    );

    if let Some(tx) = state.compute_cancel.read().await.get(&job_id).cloned() {
        let _ = tx.send(true);
    }

    let jid = job_id.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
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

pub async fn get_modules_info<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<serde_json::Value, String> {
    let dir = registry::modules_dir(&app);
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

pub async fn copy_into_files<R: Runtime>(
    app: tauri::AppHandle<R>,
    src_path: String,
) -> Result<String, String> {
    use std::fs;
    use std::path::{Path, PathBuf};

    let p = Path::new(&src_path);
    if !p.exists() {
        return Err(format!("Source path does not exist: {}", src_path));
    }

    let meta = fs::symlink_metadata(p).map_err(|e| format!("stat failed: {e}"))?;
    if !meta.file_type().is_file() {
        return Err("Source must be a regular file".into());
    }

    let fname = p
        .file_name()
        .ok_or_else(|| "Invalid source file name".to_string())?
        .to_string_lossy()
        .to_string();
    if fname.trim().is_empty() {
        return Err("Empty file name".into());
    }

    // Prefer env-configured data dir (harness sets UICP_DATA_DIR) to ensure tests write under the harness workspace.
    // Prefer AppState-derived files dir to avoid stale statics/env drift across tests
    let dest_dir_buf: PathBuf = {
        let state: State<'_, AppState> = app.state();
        state
            .db_path
            .parent()
            .map(|p| p.join("files"))
            .unwrap_or_else(|| crate::files_dir_path().to_path_buf())
    };
    let dest_dir = dest_dir_buf.as_path();
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

    eprintln!(
        "copy_into_files: src={} -> dest={}",
        p.display(),
        dest.display()
    );
    fs::copy(p, &dest).map_err(|e| format!("Copy failed: {e}"))?;

    Ok(format!(
        "ws:/files/{}",
        dest.file_name().and_then(|s| s.to_str()).unwrap_or(&fname)
    ))
}

pub async fn load_workspace(state: State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    // Minimal stub for tests; not used by compute harness tests directly.
    let _db_path = state.db_path.clone();
    Ok(vec![])
}

pub async fn save_workspace(
    _window: (),
    _state: State<'_, AppState>,
    _windows: Vec<serde_json::Value>,
) -> Result<(), String> {
    // Minimal stub for tests; not used by compute harness tests directly.
    Ok(())
}

pub async fn clear_compute_cache<R: Runtime>(
    app: tauri::AppHandle<R>,
    workspace_id: Option<String>,
) -> Result<(), String> {
    let ws = workspace_id.unwrap_or_else(|| "default".into());
    let state: State<'_, AppState> = app.state();
    state
        .db_rw
        .call(move |conn| -> tokio_rusqlite::Result<()> {
            conn.execute(
                "DELETE FROM compute_cache WHERE workspace_id = ?1",
                rusqlite::params![ws],
            )
            .map_err(tokio_rusqlite::Error::from)?;
            Ok(())
        })
        .await
        .map_err(|e| format!("{e:?}"))
}

pub async fn provider_login<R: Runtime>(
    _app: tauri::AppHandle<R>,
    provider: String,
) -> Result<provider_cli::ProviderLoginResult, String> {
    let normalized = provider.trim().to_ascii_lowercase();
    provider_cli::login(&normalized).await
}

pub async fn provider_health<R: Runtime>(
    _app: tauri::AppHandle<R>,
    provider: String,
) -> Result<provider_cli::ProviderHealthResult, String> {
    let normalized = provider.trim().to_ascii_lowercase();
    provider_cli::health(&normalized).await
}
