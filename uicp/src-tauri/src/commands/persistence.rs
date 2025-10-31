//! Persistence commands for workspace and command replay functionality.

use crate::core::{emit_or_log, AppState};
use chrono::Utc;
use serde::Serialize;
use tauri::{Manager, State, Window};
use tokio_rusqlite::params;

#[derive(serde::Deserialize, serde::Serialize, Clone)]
pub struct CommandRequest {
    pub id: String,
    pub tool: String,
    pub args: serde_json::Value,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowStatePayload {
    pub id: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub title: Option<String>,
    pub z_index: i64,
    pub content: Option<String>,
}

#[derive(Clone, Serialize)]
struct SaveIndicatorPayload {
    ok: bool,
    timestamp: i64,
}

/// Persist command for replay.
#[tauri::command]
pub async fn persist_command(
    state: State<'_, AppState>,
    cmd: CommandRequest,
) -> Result<(), String> {
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
    let started = std::time::Instant::now();

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
        let ms = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
        match &res {
            Ok(()) => tracing::info!(target = "uicp", duration_ms = ms, "command persisted"),
            Err(e) => {
                tracing::warn!(target = "uicp", duration_ms = ms, error = %e, "command persist failed");
            }
        }
    }

    res.map_err(|e| format!("DB error: {e:?}"))?;
    Ok(())
}

/// Load commands in order.
#[tauri::command]
pub async fn get_workspace_commands(
    state: State<'_, AppState>,
) -> Result<Vec<CommandRequest>, String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("load_commands");

    #[cfg(feature = "otel_spans")]
    let started = std::time::Instant::now();

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
        let ms = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
        match &res {
            Ok(v) => tracing::info!(
                target = "uicp",
                duration_ms = ms,
                count = v.len(),
                "commands loaded"
            ),
            Err(e) => {
                tracing::warn!(target = "uicp", duration_ms = ms, error = %e, "commands load failed");
            }
        }
    }

    let commands = res.map_err(|e| format!("DB error: {e:?}"))?;
    Ok(commands)
}

/// Clear all commands.
#[tauri::command]
pub async fn clear_workspace_commands(state: State<'_, AppState>) -> Result<(), String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("clear_commands");

    #[cfg(feature = "otel_spans")]
    let started = std::time::Instant::now(); // instrumentation timing

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
        let ms = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
        match &res {
            Ok(()) => tracing::info!(target = "uicp", duration_ms = ms, "commands cleared"),
            Err(e) => {
                tracing::warn!(target = "uicp", duration_ms = ms, error = %e, "commands clear failed");
            }
        }
    }

    res.map_err(|e| format!("DB error: {e:?}"))?;
    Ok(())
}

/// Delete commands for specific window (~100 lines with JSON1 fallback).
#[tauri::command]
pub async fn delete_window_commands(
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
                    for (id, tool, args_json) in rows {
                        let parsed: serde_json::Value = serde_json::from_str(&args_json)
                            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?;
                        let id_match = if tool == "window.create" {
                            parsed
                                .get("id")
                                .and_then(|v| v.as_str())
                                .is_some_and(|s| s == window_id)
                        } else {
                            parsed
                                .get("windowId")
                                .and_then(|v| v.as_str())
                                .is_some_and(|s| s == window_id)
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

/// Load window states.
#[tauri::command]
pub async fn load_workspace(state: State<'_, AppState>) -> Result<Vec<WindowStatePayload>, String> {
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
                        title: row.get::<_, Option<String>>(1)?,
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
                    title: Some("Welcome".to_string()),
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

/// Save window states.
#[tauri::command]
pub async fn save_workspace(
    window: Window,
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
                    i64::try_from(index).unwrap_or(i64::MAX)
                } else {
                    win.z_index.max(i64::try_from(index).unwrap_or(i64::MAX))
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
        Ok(()) => {
            *state.last_save_ok.write().await = true;
            emit_or_log(
                window.app_handle(),
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
                window.app_handle(),
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
