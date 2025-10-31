//! Modules command handlers.

use base64::engine::general_purpose::STANDARD as BASE64_ENGINE;
use base64::Engine as _;
use sha2::Digest;

use crate::compute::registry::{load_manifest, modules_dir};

/// Verify that all module entries listed in the manifest exist and match their digests.
#[tauri::command]
pub async fn verify_modules(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("verify_modules");
    let dir = modules_dir(&app);
    let manifest = load_manifest(&app).map_err(|e| format!("load manifest: {e}"))?;

    // Optional Ed25519 signature verification public key (32-byte). Accept hex or base64.
    let pubkey_opt: Option<[u8; 32]> = std::env::var("UICP_MODULES_PUBKEY").ok().and_then(|s| {
        let b64 = BASE64_ENGINE.decode(s.as_bytes()).ok();
        if let Some(bytes) = b64 {
            bytes.try_into().ok()
        } else {
            hex::decode(s).ok().and_then(|bytes| bytes.try_into().ok())
        }
    });

    let mut verified = Vec::new();
    let mut missing = Vec::new();
    let mut mismatched = Vec::new();
    let mut unsigned = Vec::new();

    for entry in &manifest.entries {
        let path = dir.join(&entry.filename);
        match std::fs::read(&path) {
            Ok(bytes) => {
                let digest = sha2::Sha256::digest(&bytes);
                let hex_digest = hex::encode(digest);
                if hex_digest == entry.digest_sha256 {
                    // Check signature if pubkey is configured
                    if let Some(pubkey) = pubkey_opt {
                        match crate::compute::registry::verify_entry_signature(entry, &pubkey) {
                            Ok(crate::compute::registry::SignatureStatus::Verified) => {
                                verified.push(entry.filename.clone())
                            }
                            Ok(crate::compute::registry::SignatureStatus::Invalid) => {
                                unsigned.push(entry.filename.clone())
                            }
                            Ok(crate::compute::registry::SignatureStatus::Missing) => {
                                unsigned.push(format!("{} (no signature)", entry.filename))
                            }
                            Err(e) => {
                                // Treat verification errors as unsigned but log
                                unsigned.push(format!("{} (sig err: {})", entry.filename, e));
                            }
                        }
                    } else {
                        verified.push(entry.filename.clone());
                    }
                } else {
                    mismatched.push(entry.filename.clone());
                }
            }
            Err(_) => {
                missing.push(entry.filename.clone());
            }
        }
    }

    Ok(serde_json::json!({
        "verified": verified,
        "missing": missing,
        "mismatched": mismatched,
        "unsigned": unsigned,
        "total": manifest.entries.len(),
        "ok": missing.is_empty() && mismatched.is_empty(),
    }))
}

/// Returns detailed module registry information with provenance for supply chain transparency.
/// Used by the devtools panel to display "museum labels" for each module.
#[tauri::command]
pub async fn get_modules_registry(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("get_modules_registry");
    let dir = crate::compute::registry::modules_dir(&app);
    let manifest = crate::compute::registry::load_manifest(&app).map_err(|e| e.to_string())?;

    let mut modules = Vec::new();
    for entry in manifest.entries {
        // Load provenance for each module (best-effort)
        let provenance =
            crate::compute::registry::load_provenance(&dir, &entry.task, &entry.version)
                .ok()
                .flatten();

        modules.push(serde_json::json!({
            "task": entry.task,
            "version": entry.version,
            "filename": entry.filename,
            "digest": entry.digest_sha256,
            "signature": entry.signature,
            "keyid": entry.keyid,
            "signedAt": entry.signed_at,
            "provenance": provenance,
        }));
    }

    // Security posture: strict mode + trust store source for UI surfacing
    let strict = std::env::var("STRICT_MODULES_VERIFY")
        .ok()
        .is_some_and(|s| {
            matches!(
                s.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        });
    let trust_store = if std::env::var("UICP_TRUST_STORE_JSON").is_ok() {
        "inline"
    } else if std::env::var("UICP_TRUST_STORE").is_ok() {
        "file"
    } else if std::env::var("UICP_MODULES_PUBKEY").is_ok() {
        "single_key"
    } else {
        "none"
    };

    Ok(serde_json::json!({
        "dir": dir.display().to_string(),
        "modules": modules,
        "strict": strict,
        "trustStore": trust_store,
    }))
}

#[tauri::command]
pub async fn get_modules_info(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("get_modules_info");
    let dir = crate::compute::registry::modules_dir(&app);
    let manifest = dir.join("manifest.json");
    let exists = manifest.exists();
    let mut entries = 0usize;
    if exists {
        if let Ok(text) = std::fs::read_to_string(&manifest) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                entries = json["entries"].as_array().map_or(0, Vec::len);
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
