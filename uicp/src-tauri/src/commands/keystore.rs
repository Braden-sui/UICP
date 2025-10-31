//! Keystore command handlers.

use crate::infrastructure::core::{emit_or_log, log_warn};
use crate::security::keystore::{get_or_init_keystore, UnlockStatus};
use secrecy::SecretString;

// ---------------------------------------------------------------------------
// Keystore Tauri commands (no plaintext read exposure)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn keystore_unlock(
    app: tauri::AppHandle,
    method: String,
    passphrase: Option<String>,
) -> Result<UnlockStatus, String> {
    let ks = get_or_init_keystore().await.map_err(|e| e.to_string())?;
    match method.to_ascii_lowercase().as_str() {
        "passphrase" => {
            let Some(p) = passphrase else {
                return Err("passphrase required".into());
            };
            let status = ks
                .unlock_passphrase(SecretString::new(p))
                .await
                .map_err(|e| e.to_string())?;
            if !status.locked {
                // Fire-and-forget: import known env vars into keystore once unlocked
                let ks_clone = ks.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = import_env_secrets_into_keystore(ks_clone).await;
                });
                // Emit telemetry for unlock
                emit_or_log(
                    &app,
                    "keystore_unlock",
                    serde_json::json!({
                        "method": status.method.map(|m| match m { crate::security::keystore::UnlockMethod::Passphrase => "passphrase", crate::security::keystore::UnlockMethod::Mock => "mock" }),
                        "ttlSec": status.ttl_remaining_sec,
                    }),
                );
            }
            Ok(status)
        }
        "mock" => Err("mock unlock not permitted in release".into()),
        _ => Err("unsupported unlock method".into()),
    }
}

#[tauri::command]
pub async fn keystore_lock(app: tauri::AppHandle) -> Result<(), String> {
    let ks = get_or_init_keystore().await.map_err(|e| e.to_string())?;
    ks.lock();
    // Emit telemetry for manual lock
    emit_or_log(
        &app,
        "keystore_autolock",
        serde_json::json!({ "reason": "manual" }),
    );
    Ok(())
}

#[tauri::command]
pub async fn keystore_status() -> Result<UnlockStatus, String> {
    let ks = get_or_init_keystore().await.map_err(|e| e.to_string())?;
    Ok(ks.status())
}

#[tauri::command]
pub async fn keystore_sentinel_exists() -> Result<bool, String> {
    let ks = get_or_init_keystore().await.map_err(|e| e.to_string())?;
    ks.sentinel_exists().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn keystore_list_ids() -> Result<Vec<String>, String> {
    let ks = get_or_init_keystore().await.map_err(|e| e.to_string())?;
    ks.list_ids().await.map_err(|e| e.to_string())
}

/// Emit an explicit `keystore_autolock` telemetry event with a reason.
#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn keystore_autolock_reason(app: tauri::AppHandle, reason: String) {
    emit_or_log(
        &app,
        "keystore_autolock",
        serde_json::json!({ "reason": reason }),
    );
}

#[tauri::command]
pub async fn secret_set(service: String, account: String, value: String) -> Result<(), String> {
    let ks = get_or_init_keystore().await.map_err(|e| e.to_string())?;
    ks.secret_set(&service, &account, SecretString::new(value))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn secret_exists(service: String, account: String) -> Result<serde_json::Value, String> {
    let ks = get_or_init_keystore().await.map_err(|e| e.to_string())?;
    let exists = ks
        .secret_exists(&service, &account)
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "exists": exists }))
}

#[tauri::command]
pub async fn secret_delete(service: String, account: String) -> Result<(), String> {
    let ks = get_or_init_keystore().await.map_err(|e| e.to_string())?;
    ks.secret_delete(&service, &account)
        .await
        .map_err(|e| e.to_string())
}

// Import known provider env vars into keystore when unlocked. Best-effort; errors are logged but not surfaced.
async fn import_env_secrets_into_keystore(
    ks: std::sync::Arc<crate::security::keystore::Keystore>,
) -> Result<(), String> {
    // (service, account, env_var)
    let mappings = [
        ("uicp", "openai:api_key", "OPENAI_API_KEY"),
        ("uicp", "anthropic:api_key", "ANTHROPIC_API_KEY"),
        ("uicp", "openrouter:api_key", "OPENROUTER_API_KEY"),
        ("uicp", "ollama:api_key", "OLLAMA_API_KEY"),
    ];
    for (service, account, env_key) in &mappings {
        if let Ok(true) = ks.secret_exists(service, account).await {
            continue;
        }
        if let Ok(value) = std::env::var(env_key) {
            let trimmed = value.trim().to_string();
            if !trimmed.is_empty() {
                if let Err(err) = ks
                    .secret_set(service, account, SecretString::new(trimmed))
                    .await
                {
                    log_warn(
                        crate::infrastructure::core::LogEvent::new("env import to keystore failed")
                            .field("account", *account)
                            .field("error", err.to_string()),
                    );
                }
            }
        }
    }
    Ok(())
}
