use base64::engine::general_purpose::STANDARD as BASE64_ENGINE;
use base64::Engine as _;
use sha2::Digest;

use crate::keystore::get_or_init_keystore;
use crate::provider_cli::{ProviderHealthResult, ProviderLoginResult};
use crate::registry::{load_manifest, modules_dir};
use secrecy::{ExposeSecret, SecretString};

#[tauri::command]
pub async fn provider_login(provider: String) -> Result<ProviderLoginResult, String> {
    let normalized = provider.trim().to_ascii_lowercase();
    crate::provider_cli::login(&normalized).await
}

#[tauri::command]
pub async fn provider_health(provider: String) -> Result<ProviderHealthResult, String> {
    let normalized = provider.trim().to_ascii_lowercase();
    crate::provider_cli::health(&normalized).await
}

#[tauri::command]
pub async fn provider_resolve(provider: String) -> Result<serde_json::Value, String> {
    let normalized = provider.trim().to_ascii_lowercase();
    let res = crate::provider_cli::resolve(&normalized)?;
    Ok(serde_json::json!({ "exe": res.exe, "via": res.via }))
}

#[tauri::command]
pub async fn provider_install(
    provider: String,
    version: Option<String>,
) -> Result<serde_json::Value, String> {
    let normalized = provider.trim().to_ascii_lowercase();
    match crate::provider_cli::install(&normalized, version.as_deref()).await {
        Ok(r) => Ok(serde_json::json!({
            "ok": r.ok,
            "provider": r.provider,
            "exe": r.exe,
            "via": r.via,
            "detail": r.detail,
        })),
        Err(e) => Err(e),
    }
}

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
                        match crate::registry::verify_entry_signature(entry, &pubkey) {
                            Ok(crate::registry::SignatureStatus::Verified) => {
                                verified.push(entry.filename.clone())
                            }
                            Ok(crate::registry::SignatureStatus::Invalid) => {
                                unsigned.push(entry.filename.clone())
                            }
                            Ok(crate::registry::SignatureStatus::Missing) => {
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

#[tauri::command]
pub async fn save_provider_api_key(provider: String, api_key: String) -> Result<(), String> {
    let ks = get_or_init_keystore().await.map_err(|e| e.to_string())?;
    ks.secret_set(
        "uicp",
        &format!("{}_api_key", provider.to_ascii_lowercase()),
        SecretString::new(api_key),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_api_key(provider: String) -> Result<Option<String>, String> {
    let ks = get_or_init_keystore().await.map_err(|e| e.to_string())?;
    match ks
        .read_internal(
            "uicp",
            &format!("{}_api_key", provider.to_ascii_lowercase()),
        )
        .await
    {
        Ok(secret_bytes) => {
            let secret_str = String::from_utf8(secret_bytes.expose_secret().to_vec())
                .map_err(|e| e.to_string())?;
            Ok(Some(secret_str))
        }
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub async fn auth_preflight(provider: Option<String>) -> Result<serde_json::Value, String> {
    let ks = get_or_init_keystore().await.map_err(|e| e.to_string())?;
    let mut keys = std::collections::HashMap::new();

    // Check specific provider if requested
    if let Some(p) = provider {
        let account = format!("{}_api_key", p.to_ascii_lowercase());
        let exists = ks
            .secret_exists("uicp", &account)
            .await
            .map_err(|e| e.to_string())?;
        keys.insert(p, exists);
    } else {
        // Check all known providers
        for provider in ["openai", "openrouter", "anthropic", "ollama"] {
            let account = format!("{}_api_key", provider);
            let exists = ks
                .secret_exists("uicp", &account)
                .await
                .map_err(|e| e.to_string())?;
            keys.insert(provider.to_string(), exists);
        }
    }

    Ok(serde_json::json!({
        "keys": keys,
        "keystoreLocked": ks.status().locked,
    }))
}
