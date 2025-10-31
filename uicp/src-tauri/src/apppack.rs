use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::State;
use walkdir::WalkDir;

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
    let root = PathBuf::from(dir);
    let mut files: Vec<_> = WalkDir::new(&root)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .map(|entry| entry.into_path())
        .collect();
    files.sort();

    let mut hasher = Sha256::new();
    for path in files {
        if let Ok(relative) = path.strip_prefix(&root) {
            hasher.update(relative.to_string_lossy().as_bytes());
        }
        if let Ok(mut file) = std::fs::File::open(&path) {
            let mut buffer = Vec::new();
            if file.read_to_end(&mut buffer).is_ok() {
                hasher.update(&buffer);
            }
        }
    }
    hex::encode(hasher.finalize())
}

fn read_to_string(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))
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

pub async fn apppack_validate(dir: String) -> Result<AppPackManifest, String> {
    let root = PathBuf::from(&dir);
    let manifest_path = root.join("apppack.json");
    let manifest_text = read_to_string(&manifest_path)?;
    let m: AppPackManifest =
        serde_json::from_str(&manifest_text).map_err(|e| format!("parse:{e}"))?;
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

pub fn install_app_pack(dir: &Path) -> Result<AppPackInstall, String> {
    let dir_str = dir.to_string_lossy();
    let id = compute_id_from_dir(&dir_str);
    let dst = FILES_DIR.join("apps").join(&id);
    if !dst.exists() {
        std::fs::create_dir_all(&dst).map_err(|e| e.to_string())?;
        copy_dir_recursive(dir, &dst).map_err(|e| e.to_string())?;
    }
    Ok(AppPackInstall {
        installed_id: id.clone(),
        path: dst.display().to_string(),
    })
}

pub async fn apppack_install(
    _state: State<'_, AppState>,
    dir: String,
) -> Result<AppPackInstall, String> {
    install_app_pack(Path::new(&dir))
}

pub async fn apppack_entry_html(installed_id: String) -> Result<String, String> {
    let p = FILES_DIR
        .join("apps")
        .join(&installed_id)
        .join("index.html");
    read_to_string(&p)
}

// NOTE: The previous event-based apppack_open is not required when using iframe srcdoc + hostBridge.
// Keeping an invocation function is optional; omitted here for clarity.
