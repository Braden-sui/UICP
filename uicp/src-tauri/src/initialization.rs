use std::sync::Arc;
use tauri::{Manager, State};
use tokio::sync::RwLock;

use crate::core::{init_tracing, AppState};

// Initialize tracing subsystem based on feature flags
pub fn init_tracing_subsystem() {
    #[cfg(feature = "otel_spans")]
    {
        use tracing_subscriber::{fmt, EnvFilter};
        let _ = fmt()
            .with_env_filter(EnvFilter::from_default_env())
            .try_init();
        tracing::info!(target = "uicp", "tracing initialized");
    }
    #[cfg(not(feature = "otel_spans"))]
    init_tracing();
}

// Initialize application state and background services
pub async fn init_app_services(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let state: State<'_, AppState> = app.state();
    
    // Initialize background tasks
    init_background_tasks(app).await;
    
    // Initialize provider circuits
    init_provider_circuits(&state).await;
    
    // Initialize local ollama if needed
    maybe_enable_local_ollama(&state).await;
    
    Ok(())
}

async fn init_background_tasks(app: &tauri::AppHandle) {
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        // Start background cleanup tasks
        crate::action_log::start_cleanup_task(app_clone).await;
    });
}

async fn init_provider_circuits(state: &AppState) {
    // Initialize provider circuit manager
    let _ = state.provider_circuit_manager.initialize().await;
}

async fn maybe_enable_local_ollama(state: &AppState) {
    // Check if local Ollama should be enabled
    if std::env::var("USE_DIRECT_CLOUD").ok().as_deref() != Some("1") {
        // Local mode - ensure Ollama daemon is available
        if let Err(e) = crate::providers::ensure_local_ollama().await {
            tracing::warn!(target = "uicp", "Failed to ensure local Ollama: {}", e);
        }
    }
}
