//! Recovery command handlers.

use std::time::Instant;

use chrono::Utc;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::fs;
use tokio_rusqlite::{self, params, OptionalExtension};

use crate::{AppState, LOGS_DIR};

use super::compute::clear_compute_cache;

#[tauri::command]
pub async fn save_checkpoint(app: AppHandle, hash: String) -> Result<(), String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("save_checkpoint", hash_len = hash.len());
    let state: State<'_, AppState> = app.state();
    if *state.safe_mode.read().await {
        return Ok(());
    }
    #[cfg(feature = "otel_spans")]
    let started = Instant::now();
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
        let ms = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
        match &res {
            Ok(()) => tracing::info!(target = "uicp", duration_ms = ms, "checkpoint saved"),
            Err(e) => {
                tracing::warn!(target = "uicp", duration_ms = ms, error = %e, "checkpoint save failed");
            }
        }
    }
    res.map_err(|e| format!("{e:?}"))
}

#[tauri::command]
pub async fn health_quick_check(app: AppHandle) -> Result<serde_json::Value, String> {
    health_quick_check_internal(&app)
        .await
        .map_err(|e| format!("{e:?}"))
}

pub(crate) async fn health_quick_check_internal(
    app: &AppHandle,
) -> anyhow::Result<serde_json::Value> {
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
    if ok {
        emit_replay_telemetry(app, "ok", None, 0).await;
    } else {
        enter_safe_mode(app, "CORRUPT_DB").await;
    }
    Ok(json!({ "ok": ok, "status": status }))
}

#[tauri::command]
pub async fn determinism_probe(
    app: AppHandle,
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
    let limit = i64::from(n);
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
    Ok(json!({ "drift": drift, "sampled": samples.len() }))
}

#[tauri::command]
#[allow(clippy::too_many_lines)]
pub async fn recovery_action(app: AppHandle, kind: String) -> Result<(), String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("recovery_action", kind = %kind);
    let emit = |app: &AppHandle, action: &str, outcome: &str, payload: serde_json::Value| {
        let _ = app.emit(
            "replay-issue",
            json!({
                "event": "recovery_action",
                "action": action,
                "outcome": outcome,
                "details": payload,
            }),
        );
    };

    match kind.as_str() {
        "reindex" => {
            if reindex_and_integrity(&app)
                .await
                .map_err(|e| format!("reindex: {e:?}"))?
            {
                emit(&app, "reindex", "ok", json!({}));
                emit_replay_telemetry(&app, "manual_reindex", None, 0).await;
                Ok(())
            } else {
                emit(
                    &app,
                    "reindex",
                    "failed",
                    json!({ "reason": "integrity_check_failed" }),
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
        "compact_log" => {
            let deleted = compact_log_after_last_checkpoint(&app)
                .await
                .map_err(|e| format!("compact_log: {e:?}"))?;
            let ok = reindex_and_integrity(&app)
                .await
                .map_err(|e| format!("reindex: {e:?}"))?;
            if ok {
                emit(&app, "compact_log", "ok", json!({ "deleted": deleted }));
                emit_replay_telemetry(&app, "manual_compact", None, 0).await;
                Ok(())
            } else {
                emit(
                    &app,
                    "compact_log",
                    "failed",
                    json!({ "deleted": deleted, "reason": "integrity_check_failed" }),
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
                json!({ "truncated": truncated }),
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
            emit(&app, "clear_cache", "ok", json!({}));
            Ok(())
        }
        other => Err(format!("Unknown recovery action: {other}")),
    }
}

#[tauri::command]
pub async fn recovery_auto(app: AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("recovery_auto");
    let mut attempts: Vec<serde_json::Value> = Vec::new();
    let mut status: &str = "failed";
    let mut failed_reason: Option<String> = None;

    let res_a = reindex_and_integrity(&app).await;
    match res_a {
        Ok(ok) => {
            attempts.push(json!({"step":"reindex","ok": ok }));
            if ok {
                status = "reindexed";
                emit_replay_telemetry(&app, status, None, 0).await;
                return Ok(json!({"attempts": attempts, "resolved": true}));
            }
        }
        Err(e) => {
            attempts.push(json!({"step":"reindex","ok": false, "error": format!("{e:?}")}));
            failed_reason = Some(format!("reindex: {e}"));
        }
    }

    let res_b = compact_log_after_last_checkpoint(&app).await;
    match res_b {
        Ok(deleted) => {
            attempts.push(json!({"step":"compact_log","ok": deleted >= 0, "deleted": deleted }))
        }
        Err(e) => {
            attempts.push(json!({"step":"compact_log","ok": false, "error": format!("{e:?}")}))
        }
    }

    if let Ok(ok) = reindex_and_integrity(&app).await {
        if ok {
            status = "compacted";
            emit_replay_telemetry(&app, status, None, 0).await;
            return Ok(json!({"attempts": attempts, "resolved": true}));
        }
    }

    let res_c = rollback_to_last_checkpoint(&app).await;
    match res_c {
        Ok(truncated) => attempts.push(
            json!({"step":"rollback_checkpoint","ok": truncated >= 0, "truncated": truncated }),
        ),
        Err(e) => attempts
            .push(json!({"step":"rollback_checkpoint","ok": false, "error": format!("{e:?}")})),
    }

    attempts.push(json!({"step":"reenqueue_missing","ok": true, "note": "no-op in v1" }));

    failed_reason = failed_reason.or(Some("recovery_failed".into()));
    emit_replay_telemetry(&app, status, failed_reason.as_deref(), 0).await;
    Ok(json!({"attempts": attempts, "resolved": false}))
}

#[tauri::command]
pub async fn recovery_export(app: AppHandle) -> Result<serde_json::Value, String> {
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
            Ok(json!({"tool_call": tool_calls, "compute_cache": cache_rows}))
        })
        .await
        .map_err(|e| format!("{e:?}"))?;

    let bundle = json!({
        "integrity_ok": integrity,
        "counts": counts,
        "ts": chrono::Utc::now().timestamp(),
    });
    let path = logs_dir.join(format!(
        "diagnostics-{}.json",
        chrono::Utc::now().timestamp()
    ));
    fs::create_dir_all(&logs_dir)
        .await
        .map_err(|e| format!("{e}"))?;
    let json_bytes =
        serde_json::to_vec_pretty(&bundle).map_err(|e| format!("serialize diagnostics: {e}"))?;
    fs::write(&path, json_bytes)
        .await
        .map_err(|e| format!("{e}"))?;
    Ok(json!({"path": path.display().to_string()}))
}

#[tauri::command]
pub async fn set_safe_mode(
    app: AppHandle,
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
            json!({ "reason": why, "action": "enter_safe_mode" }),
        );
    } else {
        let _ = app.emit(
            "safe-mode",
            json!({ "enabled": false, "reason": "cleared_by_user" }),
        );
    }
    Ok(())
}

async fn enter_safe_mode(app: &AppHandle, reason: &str) {
    let state: State<'_, AppState> = app.state();
    *state.safe_mode.write().await = true;
    *state.safe_reason.write().await = Some(reason.to_string());
    let _ = app.emit(
        "replay-issue",
        json!({ "reason": reason, "action": "enter_safe_mode" }),
    );
}

async fn reindex_and_integrity(app: &AppHandle) -> anyhow::Result<bool> {
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

async fn last_checkpoint_ts(app: &AppHandle) -> anyhow::Result<Option<i64>> {
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

async fn compact_log_after_last_checkpoint(app: &AppHandle) -> anyhow::Result<i64> {
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
            .map(|n| i64::try_from(n).unwrap_or(i64::MAX))
            .map_err(tokio_rusqlite::Error::from)
        })
        .await?;
    Ok(deleted)
}

async fn rollback_to_last_checkpoint(app: &AppHandle) -> anyhow::Result<i64> {
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
            .map(|n| i64::try_from(n).unwrap_or(i64::MAX))
            .map_err(tokio_rusqlite::Error::from)
        })
        .await?;
    Ok(truncated)
}

async fn emit_replay_telemetry(
    app: &AppHandle,
    replay_status: &str,
    failed_reason: Option<&str>,
    rerun_count: i64,
) {
    let checkpoint_id = last_checkpoint_ts(app).await.ok().flatten();
    let _ = app.emit(
        "replay-telemetry",
        json!({
            "replay_status": replay_status,
            "failed_reason": failed_reason,
            "checkpoint_id": checkpoint_id,
            "rerun_count": rerun_count,
        }),
    );
}
