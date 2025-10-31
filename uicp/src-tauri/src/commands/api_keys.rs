//! API keys command handlers.
use secrecy::SecretString;
use tauri::State;

use crate::keystore::get_or_init_keystore;
use crate::AppState;

#[tauri::command]
pub async fn save_api_key(_state: State<'_, AppState>, key: String) -> Result<(), String> {
    let key_trimmed = key.trim().to_string();
    let ks = get_or_init_keystore().await.map_err(|e| e.to_string())?;
    ks.secret_set("uicp", "ollama:api_key", SecretString::new(key_trimmed))
        .await
        .map_err(|e| e.to_string())
}

/// Legacy loader kept for compatibility. Does not expose the plaintext key.
#[tauri::command]
pub async fn load_api_key() -> Result<Option<String>, String> {
    // INVARIANT: Never expose secrets to the UI. Return None to indicate non-exposure.
    Ok(None)
}

/// Test whether chat can proceed given current mode (cloud/local) and key presence.
/// Cloud mode requires an Ollama API key in the keystore; local mode does not.
#[tauri::command]
pub async fn test_api_key(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let use_cloud = *state.use_direct_cloud.read().await;
    let ks = get_or_init_keystore().await.map_err(|e| e.to_string())?;
    let exists = ks
        .secret_exists("uicp", "ollama:api_key")
        .await
        .map_err(|e| e.to_string())?;

    if use_cloud {
        Ok(serde_json::json!({
            "ok": exists,
            "mode": "cloud",
        }))
    } else {
        // Local daemon does not require an API key
        Ok(serde_json::json!({
            "ok": true,
            "mode": "local",
        }))
    }
}
