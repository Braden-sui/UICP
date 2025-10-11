use tauri::{Emitter, Manager, State, Runtime};
use anyhow::Context;

use crate::{
    compute, compute_cache, registry, AppState, ComputeJobSpec, emit_or_log, enforce_compute_policy,
};
use std::time::Instant;

pub async fn compute_call<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    spec: ComputeJobSpec,
) -> Result<(), String> {
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
        emit_or_log(&app_handle, "compute.result.final", &deny);
        return Ok(());
    }

    // Cache lookup when enabled
    let cache_mode = spec.cache.to_lowercase();
    if cache_mode == "readwrite" || cache_mode == "readonly" {
        let key = compute_cache::compute_key(&spec.task, &spec.input, &spec.provenance.env_hash);
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
            emit_or_log(&app_handle, "compute.result.final", cached);
            return Ok(());
        } else if cache_mode == "readonly" {
            let payload = crate::ComputeFinalErr {
                ok: false,
                job_id: spec.job_id.clone(),
                task: spec.task.clone(),
                code: "Runtime.Fault".into(),
                message: "Cache miss under ReadOnly cache policy".into(),
            };
            emit_or_log(&app_handle, "compute.result.final", &payload);
            return Ok(());
        }
    }

    // Spawn the job respecting concurrency cap
    let queued_at = Instant::now();
    let permit = state
        .compute_sem
        .clone()
        .acquire_owned()
        .await
        .map_err(|e| e.to_string())?;
    let queue_wait_ms = queued_at.elapsed().as_millis().try_into().unwrap_or(u64::MAX);
    let mut spec_norm = spec.clone();
    spec_norm.cache = cache_mode;
    let join = compute::spawn_job(app_handle, spec_norm, Some(permit), queue_wait_ms);
    state
        .compute_ongoing
        .write()
        .await
        .insert(spec.job_id.clone(), join);
    Ok(())
}

pub async fn compute_cancel<R: Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    job_id: String,
) -> Result<(), String> {
    let app_handle = app.clone();
    let _ = app_handle.emit(
        "compute.debug",
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
                "compute.debug",
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

pub async fn get_modules_info<R: Runtime>(app: tauri::AppHandle<R>) -> Result<serde_json::Value, String> {
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

pub async fn copy_into_files(src_path: String) -> Result<String, String> {
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

    let dest_dir = crate::files_dir_path();
    if let Err(e) = fs::create_dir_all(dest_dir) {
        return Err(format!("Failed to create files dir: {e}"));
    }
    let mut dest: PathBuf = dest_dir.join(&fname);
    if dest.exists() {
        let stem = dest
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("file");
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
    let path = state.db_path.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = rusqlite::Connection::open(path).context("open sqlite for clear_compute_cache")?;
        crate::configure_sqlite(&conn).context("configure sqlite for clear_compute_cache")?;
        conn.execute(
            "DELETE FROM compute_cache WHERE workspace_id = ?1",
            rusqlite::params![ws],
        )?;
        Ok(())
    })
    .await
    .map_err(|e| format!("{e}"))?
    .map_err(|e| format!("{e:?}"))
}
