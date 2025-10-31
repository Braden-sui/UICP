use secrecy::{ExposeSecret, SecretString};

use crate::keystore::get_or_init_keystore;
use crate::provider_cli::{ProviderHealthResult, ProviderLoginResult};

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

// verify_modules moved to commands::modules

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
pub async fn provider_load_api_key(provider: String) -> Result<Option<String>, String> {
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
