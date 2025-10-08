use std::{fs, path::{Path, PathBuf}};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleEntry {
    pub task: String,          // e.g., "csv.parse"
    pub version: String,       // e.g., "1.2.0"
    pub filename: String,      // e.g., "csv.parse@1.2.0.wasm"
    pub digest_sha256: String, // hex-encoded
    #[serde(default)]
    pub signature: Option<String>, // optional, hex/base64
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModuleManifest {
    pub entries: Vec<ModuleEntry>,
}

#[derive(Debug, Clone)]
pub struct ModuleRef {
    pub entry: ModuleEntry,
    pub path: PathBuf,
}

fn resolve_modules_dir(app: &AppHandle) -> PathBuf {
    // Allow override via env for dev; else, place near app data dir under \"modules\".
    if let Ok(dir) = std::env::var("UICP_MODULES_DIR") { return PathBuf::from(dir); }
    // Fallback: put under the app data dir beside db/logs.
    let state: tauri::State<'_, crate::AppState> = app.state();
    let mut dir = state.db_path.clone();
    dir.pop(); // drop data.db
    dir.push("modules");
    dir
}

/// Public accessor for the resolved modules directory path.
pub fn modules_dir(app: &AppHandle) -> PathBuf { resolve_modules_dir(app) }

/// Best-effort installer that ensures the modules directory exists and contains
/// files referenced by the manifest. If the user's modules directory is empty
/// or missing files, and a bundled copy is present under the app resources,
/// copy the bundled directory into place.
pub fn install_bundled_modules_if_missing(app: &AppHandle) -> Result<()> {
    let target = resolve_modules_dir(app);
    let manifest_path = target.join("manifest.json");

    // Resolve the bundled resources path (tauri bundle resources) if available.
    let bundled = app
        .path()
        .resource_dir()
        .map(|dir| dir.join("modules"));

    // If target manifest is missing but we have a bundled copy, copy all.
    if !manifest_path.exists() {
        if let Some(src) = &bundled {
            if src.join("manifest.json").exists() {
                fs::create_dir_all(&target).with_context(|| format!("mkdir: {}", target.display()))?;
                copy_dir_all(src, &target)?;
                return Ok(());
            }
        }
        return Ok(());
    }

    // Otherwise validate listed files exist; copy missing ones from bundle when possible.
    let text = fs::read_to_string(&manifest_path).with_context(|| format!("read manifest: {}", manifest_path.display()))?;
    let manifest: ModuleManifest = serde_json::from_str(&text).context("parse module manifest")?;
    for entry in manifest.entries {
        let path = target.join(&entry.filename);
        if path.exists() { continue; }
        if let Some(src) = &bundled {
            let candidate = src.join(&entry.filename);
            if candidate.exists() {
                if let Some(parent) = path.parent() { fs::create_dir_all(parent).ok(); }
                fs::copy(&candidate, &path).ok();
            }
        }
    }
    Ok(())
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst).with_context(|| format!("mkdir: {}", dst.display()))?;
    for entry in fs::read_dir(src).with_context(|| format!("readdir: {}", src.display()))? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&from, &to)?;
        } else if ty.is_file() {
            fs::copy(&from, &to).with_context(|| format!("copy {} -> {}", from.display(), to.display()))?;
        }
    }
    Ok(())
}

pub fn load_manifest(app: &AppHandle) -> Result<ModuleManifest> {
    let dir = resolve_modules_dir(app);
    let manifest_path = dir.join("manifest.json");
    if !manifest_path.exists() {
        return Ok(ModuleManifest::default());
    }
    let text = fs::read_to_string(&manifest_path).with_context(|| format!("read manifest: {}", manifest_path.display()))?;
    let manifest: ModuleManifest = serde_json::from_str(&text).context("parse module manifest")?;
    Ok(manifest)
}

pub fn find_module(app: &AppHandle, task_at_version: &str) -> Result<Option<ModuleRef>> {
    let (task, version) = task_at_version
        .split_once('@')
        .unwrap_or((task_at_version, ""));
    let manifest = load_manifest(app)?;
    if let Some(entry) = manifest
        .entries
        .into_iter()
        .find(|e| e.task == task && (version.is_empty() || e.version == version))
    {
        let dir = resolve_modules_dir(app);
        let path = dir.join(&entry.filename);
        return Ok(Some(ModuleRef { entry, path }));
    }
    Ok(None)
}

pub fn verify_digest(path: &Path, expected_hex: &str) -> Result<bool> {
    let bytes = fs::read(path).with_context(|| format!("read module: {}", path.display()))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let got = hex::encode(hasher.finalize());
    Ok(expected_hex.eq_ignore_ascii_case(&got))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn digest_verification_detects_mismatch_and_match() {
        let mut f = NamedTempFile::new().expect("temp");
        writeln!(f, "hello").unwrap();
        let path = f.path().to_path_buf();
        let bytes = std::fs::read(&path).unwrap();
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let hex = hex::encode(hasher.finalize());
        assert!(verify_digest(&path, &hex).unwrap());
        assert!(!verify_digest(&path, "deadbeef").unwrap());
    }
}
