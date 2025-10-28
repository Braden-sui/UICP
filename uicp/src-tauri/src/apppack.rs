use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use tauri::State;

use crate::{AppState, FILES_DIR};

#[derive(Debug, serde::Deserialize, serde::Serialize)]
pub struct AppPackManifest {
    pub schema: String,
    pub name: String,
    pub version: String,
    pub entry: String,
    pub ui: Option<serde_json::Value>,
}

fn compute_id_from_dir(dir: &str) -> String {
    // Use SHA-256 over provided dir string (stable without new deps)
    let mut h = Sha256::new();
    h.update(dir.as_bytes());
    hex::encode(h.finalize())
}

fn read_to_string(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| format!("{}: {}", path.display(), e))
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> io::Result<()> {
    if !dst.exists() {
        fs::create_dir_all(dst)?;
    }
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else if ty.is_file() {
            // Best-effort copy; overwrite existing
            fs::copy(entry.path(), to)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn apppack_validate(dir: String) -> Result<AppPackManifest, String> {
    let root = PathBuf::from(&dir);
    let manifest_path = root.join("apppack.json");
    let manifest_text = read_to_string(&manifest_path)?;
    let m: AppPackManifest =
        serde_json::from_str(&manifest_text).map_err(|e| format!("parse:{}", e))?;
    if m.schema != "uicp.app/0.1" {
        return Err("E:unsupported-schema".into());
    }
    let entry_path = root.join(&m.entry);
    if !entry_path.is_file() {
        return Err("E:entry-missing".into());
    }
    Ok(m)
}

#[derive(Debug, serde::Serialize)]
pub struct AppPackInstall {
    pub installed_id: String,
    pub path: String,
}

#[tauri::command]
pub async fn apppack_install(
    _state: State<'_, AppState>,
    dir: String,
) -> Result<AppPackInstall, String> {
    let id = compute_id_from_dir(&dir);
    let dst = FILES_DIR.join("apps").join(&id);
    if !dst.exists() {
        std::fs::create_dir_all(&dst).map_err(|e| e.to_string())?;
        copy_dir_recursive(&PathBuf::from(&dir), &dst).map_err(|e| e.to_string())?;
    }
    Ok(AppPackInstall {
        installed_id: id.clone(),
        path: dst.display().to_string(),
    })
}

#[tauri::command]
pub async fn apppack_entry_html(installed_id: String) -> Result<String, String> {
    let p = FILES_DIR
        .join("apps")
        .join(&installed_id)
        .join("index.html");
    read_to_string(&p)
}

// NOTE: The previous event-based apppack_open is not required when using iframe srcdoc + hostBridge.
// Keeping an invocation function is optional; omitted here for clarity.
