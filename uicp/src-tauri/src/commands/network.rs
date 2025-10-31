//! Network command handlers.
use tauri::{AppHandle, State};

use crate::AppState;

#[tauri::command]
pub async fn reload_policies(app: AppHandle) -> Result<(), String> {
    crate::authz::reload_policies(&app)
}

// Thin wrapper that delegates to the core egress implementation so the command
// lives under commands::network::* as per the modularization plan.
#[tauri::command]
pub async fn egress_fetch(
    app: AppHandle,
    state: State<'_, AppState>,
    installed_id: String,
    req: crate::egress::EgressRequest,
) -> Result<crate::egress::EgressResponse, String> {
    crate::egress::egress_fetch(app, state, installed_id, req).await
}
