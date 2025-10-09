use std::{
    fs,
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
// Optional signature verification (if caller provides a public key)
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use base64::engine::general_purpose::STANDARD as BASE64_ENGINE;
use base64::Engine as _;

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
    if let Ok(dir) = std::env::var("UICP_MODULES_DIR") {
        return PathBuf::from(dir);
    }
    // Fallback: put under the app data dir beside db/logs.
    let state: tauri::State<'_, crate::AppState> = app.state();
    let mut dir = state.db_path.clone();
    dir.pop(); // drop data.db
    dir.push("modules");
    dir
}

/// Public accessor for the resolved modules directory path.
pub fn modules_dir(app: &AppHandle) -> PathBuf {
    resolve_modules_dir(app)
}

/// Best-effort installer that ensures the modules directory exists and contains
/// files referenced by the manifest. If the user's modules directory is empty
/// or missing files, and a bundled copy is present under the app resources,
/// copy the bundled directory into place.
pub fn install_bundled_modules_if_missing(app: &AppHandle) -> Result<()> {
    let target = resolve_modules_dir(app);
    let manifest_path = target.join("manifest.json");

    // Acquire a best-effort lock to avoid concurrent installers clobbering files.
    let _lock = acquire_install_lock(&target);
    if _lock.is_none() {
        // Another process/thread is installing; skip to avoid races.
        return Ok(());
    }
    let _lock = _lock.unwrap();

    // Resolve the bundled resources path (tauri bundle resources) if available.
    let bundled = app.path().resource_dir().map(|dir| dir.join("modules"));

    // If target manifest is missing but we have a bundled copy, copy all.
    if !manifest_path.exists() {
        if let Ok(src) = &bundled {
            if src.join("manifest.json").exists() {
                fs::create_dir_all(&target)
                    .with_context(|| format!("mkdir: {}", target.display()))?;
                copy_dir_all(src, &target)?;
            }
        }
        // Lock guard drops here
        return Ok(());
    }

    // Otherwise validate listed files exist; copy missing ones from bundle when possible.
    let text = fs::read_to_string(&manifest_path)
        .with_context(|| format!("read manifest: {}", manifest_path.display()))?;
    let manifest: ModuleManifest = serde_json::from_str(&text).context("parse module manifest")?;
    for entry in manifest.entries {
        let path = target.join(&entry.filename);
        if path.exists() {
            continue;
        }
        if let Ok(src) = &bundled {
            let candidate = src.join(&entry.filename);
            if candidate.exists() {
                if let Some(parent) = path.parent() {
                    if let Err(e) = fs::create_dir_all(parent) {
                        eprintln!("modules mkdir failed: {e}");
                    }
                }
                // Atomic copy-then-rename with digest verification before publish
                let tmp = path.with_extension("tmp");
                match fs::copy(&candidate, &tmp) {
                    Ok(_) => match verify_digest(&tmp, &entry.digest_sha256) {
                        Ok(true) => {
                            if let Err(e) = fs::rename(&tmp, &path) {
                                eprintln!(
                                    "modules rename failed {} -> {}: {}",
                                    tmp.display(),
                                    path.display(),
                                    e
                                );
                                let _ = fs::remove_file(&tmp);
                            }
                        }
                        Ok(false) => {
                            eprintln!(
                                "bundled digest mismatch for {} (expected {}, tmp at {})",
                                entry.filename,
                                entry.digest_sha256,
                                tmp.display()
                            );
                            let _ = fs::remove_file(&tmp);
                        }
                        Err(err) => {
                            eprintln!("digest verify error for {}: {}", entry.filename, err);
                            let _ = fs::remove_file(&tmp);
                        }
                    },
                    Err(e) => {
                        eprintln!(
                            "modules copy failed {} -> {}: {}",
                            candidate.display(),
                            tmp.display(),
                            e
                        );
                    }
                }
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
            fs::copy(&from, &to)
                .with_context(|| format!("copy {} -> {}", from.display(), to.display()))?;
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
    let text = fs::read_to_string(&manifest_path)
        .with_context(|| format!("read manifest: {}", manifest_path.display()))?;
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

/// Verify an entry's Ed25519 signature against the expected digest.
/// - `pubkey_bytes` must be the 32-byte Ed25519 public key.
/// - `entry.signature` may be base64 or hex encoded.
/// The message that is signed is the raw bytes of the hex-decoded sha256 digest.
pub fn verify_entry_signature(entry: &ModuleEntry, pubkey_bytes: &[u8]) -> Result<bool> {
    let Some(sig_str) = &entry.signature else {
        return Ok(false);
    }; // no signature provided
    if pubkey_bytes.len() != 32 {
        anyhow::bail!("pubkey must be 32 bytes (Ed25519)");
    }

    // Decode signature (try base64, then hex)
    let sig_bytes = match BASE64_ENGINE.decode(sig_str.as_bytes()) {
        Ok(b) => b,
        Err(_) => hex::decode(sig_str).context("decode signature hex")?,
    };
    let sig = Signature::try_from(sig_bytes.as_slice()).context("ed25519 signature parse")?;

    // Message is the digest bytes
    let msg = hex::decode(&entry.digest_sha256).context("decode digest hex")?;

    let vk = VerifyingKey::from_bytes(pubkey_bytes.try_into().expect("len checked"))
        .context("verifying key parse")?;
    Ok(vk.verify(&msg, &sig).is_ok())
}

/// Acquire a best-effort exclusive install lock in `dir` using a lock file.
/// Returns a guard that removes the lock file when dropped.
fn acquire_install_lock(dir: &Path) -> Option<FileLock> {
    let _ = fs::create_dir_all(dir);
    let path = dir.join(".install.lock");
    match OpenOptions::new().create_new(true).write(true).open(&path) {
        Ok(mut f) => {
            let _ = writeln!(
                f,
                "pid={}, ts={}",
                std::process::id(),
                chrono::Utc::now().timestamp()
            );
            Some(FileLock { path })
        }
        Err(_) => None,
    }
}

struct FileLock {
    path: PathBuf,
}

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use sha2::{Digest as _, Sha256};
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

    #[test]
    fn signature_verification_roundtrip() {
        // Construct a deterministic signing key (DO NOT use in production).
        let sk_bytes = [7u8; 32];
        let sk = SigningKey::from_bytes(&sk_bytes);
        let vk = sk.verifying_key();

        // Create a fake digest for message "hello".
        let mut hasher = Sha256::new();
        hasher.update(b"hello");
        let digest_hex = hex::encode(hasher.finalize());
        let msg = hex::decode(&digest_hex).unwrap();

        let sig = sk.sign(&msg);
        let sig_b64 = BASE64_ENGINE.encode(sig.to_bytes());

        let entry = ModuleEntry {
            task: "demo".into(),
            version: "1.0.0".into(),
            filename: "demo@1.0.0.wasm".into(),
            digest_sha256: digest_hex,
            signature: Some(sig_b64),
        };

        let ok = verify_entry_signature(&entry, vk.as_bytes()).unwrap();
        assert!(ok, "signature should verify");

        // Tamper digest
        let mut bad_entry = entry.clone();
        bad_entry.digest_sha256 = "00".repeat(32);
        let not_ok = verify_entry_signature(&bad_entry, vk.as_bytes()).unwrap();
        assert!(!not_ok, "signature must fail after tamper");
    }
}
