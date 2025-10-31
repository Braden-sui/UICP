//! Agents command handlers.

use std::io::ErrorKind;
use std::path::PathBuf;

use serde::Serialize;
use tauri::Manager as _;
use tokio::fs;

use crate::core::{log_error, log_info};

#[derive(Debug, Serialize)]
pub struct AgentsConfigLoadResult {
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
        .map_err(|err| format!("E-UICP-AGENTS-PATH: {err}"))?;
    Ok(base.join("uicp").join("agents.yaml"))
}

#[tauri::command]
pub async fn load_agents_config_file(
    app: tauri::AppHandle,
) -> Result<AgentsConfigLoadResult, String> {
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
                        "agents config mkdir failed at {}: {mkdir_err}",
                        parent.display()
                    ));
                    return Err(format!("E-UICP-AGENTS-MKDIR: {mkdir_err}"));
                }
            }
            let tmp_path = path.with_extension("yaml.tmp");
            if let Err(write_err) = fs::write(&tmp_path, AGENTS_CONFIG_TEMPLATE.as_bytes()).await {
                log_error(format!(
                    "agents config temp write failed at {}: {write_err}",
                    tmp_path.display()
                ));
                return Err(format!("E-UICP-AGENTS-WRITE-TMP: {write_err}"));
            }
            if fs::metadata(&path).await.is_ok() {
                if let Err(remove_err) = fs::remove_file(&path).await {
                    log_error(format!(
                        "agents config remove existing failed at {path_display}: {remove_err}"
                    ));
                    let _ = fs::remove_file(&tmp_path).await;
                    return Err(format!("E-UICP-AGENTS-REMOVE: {remove_err}"));
                }
            }
            if let Err(rename_err) = fs::rename(&tmp_path, &path).await {
                log_error(format!(
                    "agents config commit rename failed at {path_display}: {rename_err}"
                ));
                let _ = fs::remove_file(&tmp_path).await;
                return Err(format!("E-UICP-AGENTS-RENAME: {rename_err}"));
            }
            log_info(format!(
                "Bootstrapped agents.yaml from template at {path_display}"
            ));
            Ok(AgentsConfigLoadResult {
                exists: true,
                contents: Some(AGENTS_CONFIG_TEMPLATE.to_string()),
                path: path_display,
            })
        }
        Err(err) => {
            log_error(format!(
                "agents config read failed at {path_display}: {err}"
            ));
            Err(format!("E-UICP-AGENTS-READ: {err}"))
        }
    }
}

#[tauri::command]
pub async fn save_agents_config_file(
    app: tauri::AppHandle,
    contents: String,
) -> Result<(), String> {
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
                "agents config mkdir failed at {}: {err}",
                parent.display()
            ));
            return Err(format!("E-UICP-AGENTS-MKDIR: {err}"));
        }
    }

    // Write contents using a temporary file for best-effort atomicity on supported platforms.
    let tmp_path = path.with_extension("yaml.tmp");
    if let Err(err) = fs::write(&tmp_path, contents.as_bytes()).await {
        log_error(format!(
            "agents config temp write failed at {}: {err}",
            tmp_path.display()
        ));
        return Err(format!("E-UICP-AGENTS-WRITE-TMP: {err}"));
    }

    // Replace existing file. On Windows rename fails if target exists; remove old file first.
    if fs::metadata(&path).await.is_ok() {
        if let Err(err) = fs::remove_file(&path).await {
            log_error(format!(
                "agents config remove existing failed at {path_display}: {err}"
            ));
            let _ = fs::remove_file(&tmp_path).await;
            return Err(format!("E-UICP-AGENTS-REMOVE: {err}"));
        }
    }

    if let Err(err) = fs::rename(&tmp_path, &path).await {
        log_error(format!(
            "agents config commit rename failed at {path_display}: {err}"
        ));
        let _ = fs::remove_file(&tmp_path).await;
        return Err(format!("E-UICP-AGENTS-RENAME: {err}"));
    }

    Ok(())
}
