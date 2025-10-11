use std::{
    collections::HashSet,
    fs,
    fs::OpenOptions,
    io::{ErrorKind, Read, Write},
    path::{Component, Path, PathBuf},
    time::Duration,
};

use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
// Optional signature verification (if caller provides a public key)
use base64::engine::general_purpose::{
    STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD as BASE64_URL_SAFE_NO_PAD,
};
use base64::Engine as _;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};

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

#[cfg_attr(not(feature = "wasm_compute"), allow(dead_code))]
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
    let base = state
        .db_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| state.db_path.clone());
    base.join("modules")
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
    let bundled = bundled_modules_path(app);

    // If target manifest is missing but we have a bundled copy, copy all.
    if !manifest_path.exists() {
        if let Some(src) = &bundled {
            if src.join("manifest.json").exists() {
                fs::create_dir_all(&target)
                    .with_context(|| format!("mkdir: {}", target.display()))?;
                copy_dir_all(src, &target)?;
                if let Err(err) = verify_installed_modules(&target) {
                    eprintln!("bundled modules verification failed: {err:#}");
                }
            }
        }
        // Lock guard drops here
        return Ok(());
    }

    // Attempt a best-effort repair of invalid digests in a pre-existing manifest
    // using either the bundled manifest (preferred) or by hashing existing files.
    if manifest_path.exists() {
        let _ = try_repair_manifest(&target, &bundled);
    }

    // Otherwise validate listed files exist; copy missing ones from bundle when possible.
    let text = fs::read_to_string(&manifest_path)
        .with_context(|| format!("read manifest: {}", manifest_path.display()))?;
    let manifest = parse_manifest(&text)?;
    for entry in manifest.entries {
        if !is_clean_filename(&entry.filename) {
            eprintln!(
                "invalid module filename (must be basename only): {}",
                entry.filename
            );
            continue;
        }
        let path = target.join(&entry.filename);
        if path.exists() {
            match verify_digest(&path, &entry.digest_sha256) {
                Ok(true) => {}
                Ok(false) => {
                    if let Some(src) = &bundled {
                        let candidate = src.join(&entry.filename);
                        if candidate.exists() && !is_regular_file(&candidate) {
                            continue;
                        }
                        if candidate.exists() {
                            let tmp = path.with_extension("tmp");
                            if let Err(err) = fs::copy(&candidate, &tmp) {
                                eprintln!(
                                    "modules copy repair failed {} -> {}: {}",
                                    candidate.display(),
                                    tmp.display(),
                                    err
                                );
                            } else if let Ok(true) = verify_digest(&tmp, &entry.digest_sha256) {
                                if let Err(err) = replace_file(&tmp, &path) {
                                    eprintln!(
                                        "modules repair replace failed {} -> {}: {}",
                                        tmp.display(),
                                        path.display(),
                                        err
                                    );
                                    let _ = fs::remove_file(&tmp);
                                } else {
                                    continue;
                                }
                            } else {
                                let _ = fs::remove_file(&tmp);
                            }
                        }
                    }
                    anyhow::bail!("digest mismatch for pre-existing module {}", entry.filename);
                }
                Err(err) => return Err(err.context("verify existing module digest")),
            }
            continue;
        }
        if let Some(src) = &bundled {
            let candidate = src.join(&entry.filename);
            if candidate.exists() && !is_regular_file(&candidate) {
                continue;
            }
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
                            if let Err(e) = replace_file(&tmp, &path) {
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

/// Attempt to repair a manifest with invalid or placeholder digests.
/// Strategy:
/// 1) If a bundled manifest exists, prefer its digest values for matching task@version.
/// 2) Otherwise, compute the digest of any present module file and fill it in.
fn try_repair_manifest(target: &Path, bundled: &Option<PathBuf>) -> Result<()> {
    let manifest_path = target.join("manifest.json");
    if !manifest_path.exists() {
        return Ok(());
    }
    let text = match fs::read_to_string(&manifest_path) {
        Ok(t) => t,
        Err(_) => return Ok(()),
    };
    // Parse without validation to allow fixing bad entries.
    let mut manifest: ModuleManifest = match serde_json::from_str(&text) {
        Ok(m) => m,
        Err(_) => return Ok(()),
    };

    // Load bundled manifest if available.
    let bundled_entries: Option<Vec<ModuleEntry>> = bundled
        .as_ref()
        .and_then(|dir| {
            let p = dir.join("manifest.json");
            fs::read_to_string(&p).ok().and_then(|s| serde_json::from_str::<ModuleManifest>(&s).ok()).map(|m| m.entries)
        });

    let mut updated = false;
    for entry in manifest.entries.iter_mut() {
        if is_valid_digest_hex(&entry.digest_sha256) {
            continue;
        }
        // Try bundled digest first
        if let Some(ref entries) = bundled_entries {
            if let Some(src) = entries.iter().find(|e| e.task == entry.task && e.version == entry.version) {
                if is_valid_digest_hex(&src.digest_sha256) {
                    entry.digest_sha256 = src.digest_sha256.clone();
                    updated = true;
                    continue;
                }
            }
        }
        // Fallback: compute digest of existing file in target
        let path = target.join(&entry.filename);
        if path.exists() && is_regular_file(&path) {
            match fs::read(&path) {
                Ok(bytes) => {
                    let mut hasher = Sha256::new();
                    hasher.update(&bytes);
                    entry.digest_sha256 = hex::encode(hasher.finalize());
                    updated = true;
                }
                Err(_) => {}
            }
        }
    }

    if updated {
        let repaired = serde_json::to_string_pretty(&manifest)? + "\n";
        let _ = fs::write(&manifest_path, repaired);
    }
    Ok(())
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst).with_context(|| format!("mkdir: {}", dst.display()))?;
    for entry in fs::read_dir(src).with_context(|| format!("readdir: {}", src.display()))? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_symlink() {
            continue;
        }
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
    // Attempt a best-effort repair before strict parsing.
    let _ = try_repair_manifest(&dir, &bundled_modules_path(app));
    let text = fs::read_to_string(&manifest_path)
        .with_context(|| format!("read manifest: {}", manifest_path.display()))?;
    parse_manifest(&text)
}

#[cfg_attr(not(feature = "wasm_compute"), allow(dead_code))]
pub fn find_module(app: &AppHandle, task_at_version: &str) -> Result<Option<ModuleRef>> {
    let (task, version) = task_at_version
        .split_once('@')
        .unwrap_or((task_at_version, ""));
    let manifest = load_manifest(app)?;
    let selected = select_manifest_entry(&manifest.entries, task, version)?;
    let Some(entry) = selected else {
        return Ok(None);
    };
    if !is_clean_filename(&entry.filename) {
        anyhow::bail!(
            "manifest entry contains invalid filename: {}",
            entry.filename
        );
    }
    let dir = resolve_modules_dir(app);
    let path = dir.join(&entry.filename);
    match verify_digest(&path, &entry.digest_sha256) {
        Ok(true) => Ok(Some(ModuleRef {
            entry: entry.clone(),
            path,
        })),
        Ok(false) => anyhow::bail!("digest mismatch for {}", entry.filename),
        Err(err) => Err(err.context("verify module digest")),
    }
}

pub fn verify_digest(path: &Path, expected_hex: &str) -> Result<bool> {
    let meta = fs::symlink_metadata(path)
        .with_context(|| format!("stat module for digest: {}", path.display()))?;
    if meta.file_type().is_symlink() {
        anyhow::bail!("refusing to hash symlink: {}", path.display());
    }
    let mut file = fs::File::open(path)
        .with_context(|| format!("open module for digest: {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let read = file.read(&mut buf)?;
        if read == 0 {
            break;
        }
        hasher.update(&buf[..read]);
    }
    let got = hex::encode(hasher.finalize());
    Ok(expected_hex.eq_ignore_ascii_case(&got))
}

/// Verify an entry's Ed25519 signature against the expected digest.
/// - `pubkey_bytes` must be the 32-byte Ed25519 public key.
/// - `entry.signature` may be base64 or hex encoded.
/// The message that is signed uses domain separation to bind metadata alongside the digest.
pub fn verify_entry_signature(entry: &ModuleEntry, pubkey_bytes: &[u8]) -> Result<SignatureStatus> {
    let Some(sig_str) = &entry.signature else {
        return Ok(SignatureStatus::Missing);
    }; // no signature provided
    if pubkey_bytes.len() != 32 {
        anyhow::bail!("pubkey must be 32 bytes (Ed25519)");
    }

    // Decode signature (try base64, then hex)
    let sig_bytes = BASE64_STANDARD
        .decode(sig_str.as_bytes())
        .or_else(|_| BASE64_URL_SAFE_NO_PAD.decode(sig_str.as_bytes()))
        .or_else(|_| hex::decode(sig_str).context("decode signature hex"))?;
    let sig = Signature::try_from(sig_bytes.as_slice()).context("ed25519 signature parse")?;

    ensure!(
        is_valid_digest_hex(&entry.digest_sha256),
        "digest must be 64 hex chars"
    );
    let digest_bytes = hex::decode(&entry.digest_sha256)
        .context("decode digest hex for signature verification")?;
    let mut message = Vec::with_capacity(
        b"UICP-MODULE".len() + entry.task.len() + entry.version.len() + digest_bytes.len() + 12,
    );
    message.extend_from_slice(b"UICP-MODULE\x00");
    message.extend_from_slice(b"task=");
    message.extend_from_slice(entry.task.as_bytes());
    message.push(0);
    message.extend_from_slice(b"version=");
    message.extend_from_slice(entry.version.as_bytes());
    message.push(0);
    message.extend_from_slice(b"sha256=");
    message.extend_from_slice(&digest_bytes);

    let vk = VerifyingKey::from_bytes(pubkey_bytes.try_into().expect("len checked"))
        .context("verifying key parse")?;
    match vk.verify(&message, &sig) {
        Ok(_) => Ok(SignatureStatus::Verified),
        Err(_) => Ok(SignatureStatus::Invalid),
    }
}

/// Acquire a best-effort exclusive install lock in `dir` using a lock file.
/// Returns a guard that removes the lock file when dropped.
fn acquire_install_lock(dir: &Path) -> Option<FileLock> {
    let _ = fs::create_dir_all(dir);
    let path = dir.join(".install.lock");
    match try_create_lock_file(&path) {
        Some(lock) => Some(lock),
        None => {
            const STALE_LOCK_TTL: Duration = Duration::from_secs(300);
            if let Ok(meta) = fs::metadata(&path) {
                if let Ok(modified) = meta.modified() {
                    if modified
                        .elapsed()
                        .map(|age| age >= STALE_LOCK_TTL)
                        .unwrap_or(false)
                    {
                        let _ = fs::remove_file(&path);
                    }
                }
            }
            try_create_lock_file(&path)
        }
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

fn try_create_lock_file(path: &Path) -> Option<FileLock> {
    OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .ok()
        .map(|mut file| {
            let _ = writeln!(
                file,
                "pid={}, ts={}",
                std::process::id(),
                chrono::Utc::now().timestamp()
            );
            FileLock {
                path: path.to_path_buf(),
            }
        })
}

#[cfg(feature = "tauri2")]
fn bundled_modules_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("modules"))
}

#[cfg(not(feature = "tauri2"))]
fn bundled_modules_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().map(|dir| dir.join("modules"))
}

fn verify_installed_modules(target: &Path) -> Result<()> {
    let manifest_path = target.join("manifest.json");
    let text = fs::read_to_string(&manifest_path).with_context(|| {
        format!(
            "read manifest for verification: {}",
            manifest_path.display()
        )
    })?;
    let manifest = parse_manifest(&text)?;
    for entry in manifest.entries {
        if !is_clean_filename(&entry.filename) {
            eprintln!(
                "skipping digest check for invalid filename {}",
                entry.filename
            );
            continue;
        }
        let path = target.join(&entry.filename);
        match verify_digest(&path, &entry.digest_sha256) {
            Ok(true) => {}
            Ok(false) => {
                eprintln!(
                    "removing module {} due to digest mismatch after install",
                    entry.filename
                );
                let _ = fs::remove_file(&path);
            }
            Err(err) => {
                eprintln!("failed verifying digest for {}: {err:#}", entry.filename);
                let _ = fs::remove_file(&path);
            }
        }
    }
    Ok(())
}

fn is_clean_filename(name: &str) -> bool {
    let mut components = Path::new(name).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

fn is_valid_digest_hex(digest: &str) -> bool {
    digest.len() == 64 && digest.chars().all(|c| c.is_ascii_hexdigit())
}

fn parse_manifest(text: &str) -> Result<ModuleManifest> {
    let manifest: ModuleManifest = serde_json::from_str(text).context("parse module manifest")?;
    for entry in &manifest.entries {
        validate_manifest_entry(entry)?;
    }
    let mut seen: HashSet<(String, String)> = HashSet::new();
    for entry in &manifest.entries {
        let key = (entry.task.clone(), entry.version.clone());
        ensure!(
            seen.insert(key),
            "duplicate manifest entry for {}@{}",
            entry.task,
            entry.version
        );
    }
    Ok(manifest)
}

fn validate_manifest_entry(entry: &ModuleEntry) -> Result<()> {
    ensure!(
        !entry.task.trim().is_empty(),
        "manifest entry missing task identifier"
    );
    ensure!(
        !entry.task.contains('@'),
        "manifest entry task must not contain '@'"
    );
    ensure!(
        !entry.version.trim().is_empty(),
        "manifest entry missing version"
    );
    ensure!(
        is_clean_filename(&entry.filename),
        "manifest entry filename must be a basename"
    );
    ensure!(
        is_valid_digest_hex(&entry.digest_sha256),
        "manifest digest must be 64 hex chars"
    );
    Ok(())
}

#[cfg_attr(not(feature = "wasm_compute"), allow(dead_code))]
fn select_manifest_entry<'a>(
    entries: &'a [ModuleEntry],
    task: &str,
    version: &str,
) -> Result<Option<&'a ModuleEntry>> {
    let filtered: Vec<&ModuleEntry> = entries.iter().filter(|e| e.task == task).collect();
    if version.is_empty() {
        let mut parsed: Vec<(&ModuleEntry, semver::Version)> = Vec::new();
        for entry in &filtered {
            match semver::Version::parse(&entry.version) {
                Ok(v) => parsed.push((*entry, v)),
                Err(err) => {
                    eprintln!(
                        "skipping module {} due to invalid semver {}: {err}",
                        entry.task, entry.version
                    );
                }
            }
        }
        parsed.sort_by(|a, b| b.1.cmp(&a.1));
        if parsed.is_empty() && filtered.is_empty() {
            return Ok(None);
        }
        if parsed.is_empty() {
            anyhow::bail!("no valid semver entries for task {}", task);
        }
        Ok(parsed.first().map(|(entry, _)| *entry))
    } else {
        Ok(filtered.into_iter().find(|e| e.version == version))
    }
}

fn is_regular_file(path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_file() => true,
        Ok(_) => {
            eprintln!("skip non-regular candidate: {}", path.display());
            false
        }
        Err(err) => {
            eprintln!(
                "skip candidate {} due to metadata error: {}",
                path.display(),
                err
            );
            false
        }
    }
}

#[cfg(windows)]
fn replace_file(tmp: &Path, dest: &Path) -> std::io::Result<()> {
    if dest.exists() {
        match fs::remove_file(dest) {
            Ok(_) => {}
            Err(err) if err.kind() == ErrorKind::NotFound => {}
            Err(err) => return Err(err),
        }
    }
    fs::rename(tmp, dest)
}

#[cfg(not(windows))]
fn replace_file(tmp: &Path, dest: &Path) -> std::io::Result<()> {
    fs::rename(tmp, dest)
}

/// Tri-state signature verification outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignatureStatus {
    Missing,
    Verified,
    Invalid,
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use sha2::{Digest, Sha256};
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
        let digest_bytes = hex::decode(&digest_hex).unwrap();
        let mut canonical_message = Vec::new();
        canonical_message.extend_from_slice(b"UICP-MODULE\x00");
        canonical_message.extend_from_slice(b"task=demo\x00");
        canonical_message.extend_from_slice(b"version=1.0.0\x00");
        canonical_message.extend_from_slice(b"sha256=");
        canonical_message.extend_from_slice(&digest_bytes);

        let sig = sk.sign(&canonical_message);
        let sig_b64 = BASE64_STANDARD.encode(sig.to_bytes());

        let entry = ModuleEntry {
            task: "demo".into(),
            version: "1.0.0".into(),
            filename: "demo@1.0.0.wasm".into(),
            digest_sha256: digest_hex,
            signature: Some(sig_b64),
        };

        let ok = verify_entry_signature(&entry, vk.as_bytes()).unwrap();
        assert_eq!(ok, SignatureStatus::Verified, "signature should verify");

        // Tamper digest
        let mut bad_entry = entry.clone();
        bad_entry.digest_sha256 = "00".repeat(32);
        let not_ok = verify_entry_signature(&bad_entry, vk.as_bytes()).unwrap();
        assert_eq!(
            not_ok,
            SignatureStatus::Invalid,
            "signature must fail after tamper"
        );
    }

    #[test]
    fn clean_filename_validation() {
        assert!(is_clean_filename("module.wasm"));
        assert!(!is_clean_filename("a/module.wasm"));
        assert!(!is_clean_filename("../module.wasm"));
        assert!(!is_clean_filename("module/../evil.wasm"));
    }

    #[cfg(target_family = "windows")]
    #[test]
    fn clean_filename_rejects_backslash() {
        assert!(!is_clean_filename("dir\\module.wasm"));
    }

    #[test]
    fn manifest_entry_validation_enforces_required_fields() {
        let mut entry = ModuleEntry {
            task: "task".into(),
            version: "1.2.3".into(),
            filename: "module.wasm".into(),
            digest_sha256: "ab".repeat(32),
            signature: None,
        };
        assert!(validate_manifest_entry(&entry).is_ok());

        entry.task = "".into();
        assert!(validate_manifest_entry(&entry).is_err());

        entry.task = "bad@task".into();
        assert!(validate_manifest_entry(&entry).is_err());
    }

    #[test]
    fn select_entry_prefers_highest_semver() {
        let entries = vec![
            ModuleEntry {
                task: "task".into(),
                version: "1.0.0".into(),
                filename: "task@1.0.0.wasm".into(),
                digest_sha256: "aa".repeat(32),
                signature: None,
            },
            ModuleEntry {
                task: "task".into(),
                version: "1.2.0".into(),
                filename: "task@1.2.0.wasm".into(),
                digest_sha256: "bb".repeat(32),
                signature: None,
            },
            ModuleEntry {
                task: "task".into(),
                version: "1.1.9".into(),
                filename: "task@1.1.9.wasm".into(),
                digest_sha256: "cc".repeat(32),
                signature: None,
            },
        ];

        let selected = select_manifest_entry(&entries, "task", "")
            .unwrap()
            .unwrap();
        assert_eq!(selected.version, "1.2.0");

        let pinned = select_manifest_entry(&entries, "task", "1.0.0")
            .unwrap()
            .unwrap();
        assert_eq!(pinned.version, "1.0.0");
    }

    #[test]
    fn select_entry_errors_when_only_invalid_semver() {
        let entries = vec![ModuleEntry {
            task: "task".into(),
            version: "not-semver".into(),
            filename: "task@latest.wasm".into(),
            digest_sha256: "aa".repeat(32),
            signature: None,
        }];

        let err = select_manifest_entry(&entries, "task", "").unwrap_err();
        assert!(
            err.to_string()
                .contains("no valid semver entries for task task"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn parse_manifest_rejects_duplicates() {
        let manifest = ModuleManifest {
            entries: vec![
                ModuleEntry {
                    task: "task".into(),
                    version: "1.0.0".into(),
                    filename: "task@1.0.0.wasm".into(),
                    digest_sha256: "aa".repeat(32),
                    signature: None,
                },
                ModuleEntry {
                    task: "task".into(),
                    version: "1.0.0".into(),
                    filename: "task@1.0.0b.wasm".into(),
                    digest_sha256: "bb".repeat(32),
                    signature: None,
                },
            ],
        };
        let text = serde_json::to_string(&manifest).unwrap();
        let err = parse_manifest(&text).unwrap_err();
        assert!(
            err.to_string()
                .contains("duplicate manifest entry for task@1.0.0"),
            "unexpected error {err}"
        );
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn copy_dir_all_skips_symlinks() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();

        let src = tmp.path().join("src");
        let dst = tmp.path().join("dst");
        fs::create_dir_all(&src).unwrap();
        let file_path = src.join("file.txt");
        fs::write(&file_path, b"hello").unwrap();
        let symlink_path = src.join("link");
        symlink(&file_path, &symlink_path).unwrap();

        copy_dir_all(&src, &dst).unwrap();

        assert!(dst.join("file.txt").exists());
        assert!(!dst.join("link").exists());
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn verify_digest_rejects_symlink() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let target_dir = tmp.path().join("modules");
        fs::create_dir_all(&target_dir).unwrap();
        let real = target_dir.join("real.wasm");
        fs::write(&real, b"wasm").unwrap();
        let link = target_dir.join("link.wasm");
        symlink(&real, &link).unwrap();

        let err = verify_digest(&link, "00").unwrap_err();
        assert!(
            err.to_string().contains("refusing to hash symlink"),
            "unexpected error: {err}"
        );
    }
}
