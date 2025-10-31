//! App pack command handlers.

use tauri::State;

use crate::apppack::{AppPackInstall, AppPackManifest};
use crate::AppState;

#[tauri::command]
pub async fn apppack_validate(dir: String) -> Result<AppPackManifest, String> {
    crate::apppack::apppack_validate(dir).await
}

#[tauri::command]
pub async fn apppack_install(
    state: State<'_, AppState>,
    dir: String,
) -> Result<AppPackInstall, String> {
    crate::apppack::apppack_install(state, dir).await
}

#[tauri::command]
pub async fn apppack_entry_html(installed_id: String) -> Result<String, String> {
    crate::apppack::apppack_entry_html(installed_id).await
}
