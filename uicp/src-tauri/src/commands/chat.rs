//! Chat completion commands with streaming support.
use tauri::State;

use crate::{services::chat_service, AppState, ChatCompletionRequest};

#[tauri::command]
pub async fn chat_completion(
    window: tauri::Window,
    state: State<'_, AppState>,
    request_id: Option<String>,
    request: ChatCompletionRequest,
    provider: Option<String>,
    base_url: Option<String>,
) -> Result<(), String> {
    chat_service::stream_chat_completion(window, state, request_id, request, provider, base_url)
        .await
}

#[tauri::command]
pub async fn cancel_chat(state: State<'_, AppState>, request_id: String) -> Result<(), String> {
    if let Some(handle) = state.ongoing.write().await.remove(&request_id) {
        handle.abort();
    }
    Ok(())
}
