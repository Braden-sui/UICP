//! Debug, diagnostics, and development commands.

use std::collections::HashMap;

use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;
use tauri::{async_runtime, AppHandle, Emitter, Manager, State};

use crate::{
    codegen::circuit, infrastructure::chaos, llm::provider_circuit,
    services::chat_service::maybe_enable_local_ollama, AppState,
};

#[tauri::command]
pub async fn set_debug(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    *state.debug_enabled.write().await = enabled;
    Ok(())
}

#[tauri::command]
pub async fn debug_circuits(
    state: State<'_, AppState>,
) -> Result<Vec<circuit::CircuitDebugInfo>, String> {
    let info = circuit::get_circuit_debug_info(&state.circuit_breakers).await;
    Ok(info)
}

#[tauri::command]
pub async fn mint_job_token(
    state: State<'_, AppState>,
    job_id: String,
    task: String,
    workspace_id: String,
    env_hash: String,
) -> Result<String, String> {
    let key = &state.job_token_key;
    let mut mac: Hmac<Sha256> = Hmac::new_from_slice(key).map_err(|e| e.to_string())?;
    mac.update(b"UICP-TOKENv1\x00");
    mac.update(job_id.as_bytes());
    mac.update(b"|");
    mac.update(task.as_bytes());
    mac.update(b"|");
    mac.update(workspace_id.as_bytes());
    mac.update(b"|");
    mac.update(env_hash.as_bytes());
    let tag = mac.finalize().into_bytes();
    Ok(hex::encode(tag))
}

#[tauri::command]
pub async fn set_env_var(name: String, value: Option<String>) -> Result<(), String> {
    let key = name.trim();
    if key.is_empty() || key.contains('\0') || key.contains('=') {
        return Err("E-UICP-9201: invalid env var name".into());
    }
    let upper = key.to_ascii_uppercase();
    let allowed_prefixes = ["OLLAMA_", "UICP_"];
    let allowed = allowed_prefixes
        .iter()
        .any(|prefix| upper.starts_with(prefix));
    if !allowed {
        return Err(format!(
            "E-UICP-9203: env var '{key}' not permitted (allowed prefixes: {allowed_prefixes:?})"
        ));
    }
    match value {
        Some(v) => std::env::set_var(key, v),
        None => std::env::remove_var(key),
    }
    Ok(())
}

#[tauri::command]
pub async fn get_action_log_stats(
    state: State<'_, AppState>,
) -> Result<crate::infrastructure::action_log::ActionLogStatsSnapshot, String> {
    Ok(state.action_log.stats_snapshot())
}

// maybe_enable_local_ollama now lives in services::chat_service

#[tauri::command]
pub async fn set_allow_local_opt_in(state: State<'_, AppState>, allow: bool) -> Result<(), String> {
    {
        let mut allow_guard = state.allow_local_opt_in.write().await;
        *allow_guard = allow;
    }

    if allow {
        {
            let mut use_cloud = state.use_direct_cloud.write().await;
            *use_cloud = false;
        }
        maybe_enable_local_ollama(&state).await;
    } else {
        *state.use_direct_cloud.write().await = true;
    }
    Ok(())
}

#[tauri::command]
pub async fn get_ollama_mode(state: State<'_, AppState>) -> Result<(bool, bool), String> {
    Ok((
        *state.use_direct_cloud.read().await,
        *state.allow_local_opt_in.read().await,
    ))
}

#[allow(clippy::needless_pass_by_value)]
#[tauri::command]
pub fn frontend_ready(app: tauri::AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }
}

#[tauri::command]
pub async fn debug_provider_circuits(
    state: State<'_, AppState>,
) -> Result<Vec<provider_circuit::ProviderCircuitDebugInfo>, String> {
    let info = state.provider_circuit_manager.get_debug_info().await;
    Ok(info)
}

#[tauri::command]
pub async fn circuit_control(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    command: provider_circuit::CircuitControlCommand,
) -> Result<(), String> {
    let emit_circuit_telemetry = move |event_name: &str, payload: Value| {
        let handle = app_handle.clone();
        let name = event_name.to_string();
        async_runtime::spawn(async move {
            let _ = handle.emit(&name, payload);
        });
    };

    state
        .provider_circuit_manager
        .execute_control_command(command, emit_circuit_telemetry)
        .await
}

#[tauri::command]
pub async fn chaos_configure_failure(
    state: State<'_, AppState>,
    provider: String,
    config: chaos::FailureConfig,
) -> Result<(), String> {
    state.chaos_engine.configure_failure(provider, config).await
}

#[tauri::command]
pub async fn chaos_stop_failure(
    state: State<'_, AppState>,
    provider: String,
) -> Result<(), String> {
    state.chaos_engine.stop_failure(&provider).await;
    Ok(())
}

#[tauri::command]
pub async fn chaos_get_configs(
    state: State<'_, AppState>,
) -> Result<HashMap<String, chaos::FailureConfig>, String> {
    Ok(state.chaos_engine.get_all_configs().await)
}

#[tauri::command]
pub async fn get_circuit_debug_info(
    state: State<'_, AppState>,
) -> Result<Vec<provider_circuit::ProviderCircuitDebugInfo>, String> {
    Ok(state.provider_circuit_manager.get_debug_info().await)
}

#[tauri::command]
pub async fn reset_circuit(
    state: State<'_, AppState>,
    provider: String,
    host: String,
) -> Result<(), String> {
    let cmd = provider_circuit::CircuitControlCommand::Reset { provider, host };
    state
        .provider_circuit_manager
        .execute_control_command(cmd, |_, _| {})
        .await
}

#[tauri::command]
pub async fn force_open_circuit(
    state: State<'_, AppState>,
    provider: String,
    host: String,
    duration_ms: u64,
) -> Result<(), String> {
    let cmd = provider_circuit::CircuitControlCommand::ForceOpen {
        provider,
        host,
        duration_ms,
    };
    state
        .provider_circuit_manager
        .execute_control_command(cmd, |_, _| {})
        .await
}

#[tauri::command]
pub async fn force_close_circuit(
    state: State<'_, AppState>,
    provider: String,
    host: String,
) -> Result<(), String> {
    let cmd = provider_circuit::CircuitControlCommand::ForceClose { provider, host };
    state
        .provider_circuit_manager
        .execute_control_command(cmd, |_, _| {})
        .await
}

#[tauri::command]
pub async fn get_resilience_metrics(
    state: State<'_, AppState>,
) -> Result<Vec<chaos::ResilienceMetricsSummary>, String> {
    let providers = ["openai", "openrouter", "anthropic", "ollama"];
    let mut metrics = Vec::new();

    for provider in &providers {
        if let Some(summary) = state.resilience_metrics.get_metrics(provider).await {
            metrics.push(summary);
        }
    }

    Ok(metrics)
}
