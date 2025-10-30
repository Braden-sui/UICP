// WHY: Centralize compute event channel names to prevent drift between host components.
pub const EVENT_COMPUTE_RESULT_FINAL: &str = "compute-result-final";
#[cfg(any(test, feature = "wasm_compute", feature = "compute_harness"))]
#[allow(dead_code)]
pub const EVENT_COMPUTE_RESULT_PARTIAL: &str = "compute-result-partial";

// WHY: UI debug stream uses a dedicated event channel that the frontend listens to.
#[allow(dead_code)]
pub const EVENT_UI_DEBUG: &str = "ui-debug-log";

// WHY: Normalized LLM StreamEvent v1 channel (backend emits normalized content/tool_call/done/error events)
pub const EVENT_STREAM_V1: &str = "uicp-stream-v1";

use rusqlite::OptionalExtension;
use secrecy::SecretString;
use serde_json::Value;
use tauri::{Emitter, Manager};

// Import known provider env vars into keystore when unlocked. Best-effort; errors are logged but not surfaced.
pub async fn import_env_secrets_into_keystore(
    ks: std::sync::Arc<crate::keystore::Keystore>,
) -> Result<(), String> {
    // (service, account, env_var)
    let mappings = [
        ("uicp", "openai:api_key", "OPENAI_API_KEY"),
        ("uicp", "anthropic:api_key", "ANTHROPIC_API_KEY"),
        ("uicp", "openrouter:api_key", "OPENROUTER_API_KEY"),
        ("uicp", "ollama:api_key", "OLLAMA_API_KEY"),
    ];
    for (service, account, env_key) in mappings.iter() {
        if let Ok(val) = std::env::var(env_key) {
            if !val.is_empty() {
                let key = format!("{}:{}", service, account);
                if let Err(e) = ks.secret_set("uicp", account, SecretString::new(val)).await {
                    tracing::warn!(
                        target = "uicp",
                        "Failed to import env secret {}: {}",
                        key,
                        e
                    );
                } else {
                    tracing::info!(target = "uicp", "Imported env secret: {}", key);
                }
            }
        }
    }
    Ok(())
}

pub fn emit_problem_detail(
    app_handle: &tauri::AppHandle,
    request_id: &str,
    status: u16,
    code: &str,
    detail: &str,
    retry_after_ms: Option<u64>,
) {
    let mut error = serde_json::json!({
        "status": status,
        "code": code,
        "detail": detail,
    });
    if let Some(ms) = retry_after_ms {
        error["retryAfterMs"] = Value::Number(ms.into());
    }
    let _ = app_handle.emit(
        "problem-detail",
        serde_json::json!({
            "requestId": request_id,
            "error": error,
        }),
    );
}

pub async fn emit_replay_telemetry(
    app: &tauri::AppHandle,
    replay_status: &str,
    failed_reason: Option<&str>,
    rerun_count: i64,
) {
    let checkpoint_id = last_checkpoint_ts(app).await.ok().flatten();
    let _ = app.emit(
        "replay-telemetry",
        serde_json::json!({
            "replay_status": replay_status,
            "failed_reason": failed_reason,
            "checkpoint_id": checkpoint_id,
            "rerun_count": rerun_count,
        }),
    );
}

async fn last_checkpoint_ts(app: &tauri::AppHandle) -> anyhow::Result<Option<i64>> {
    let state: tauri::State<'_, crate::AppState> = app.state();
    let row = state
        .db_ro
        .call(move |conn| -> tokio_rusqlite::Result<Option<i64>> {
            let mut stmt = conn.prepare_cached(
                "SELECT MAX(created_at) FROM tool_call WHERE result_json IS NOT NULL",
            )?;
            let result: Option<i64> = stmt.query_row([], |row| row.get(0)).optional()?;
            Ok(result)
        })
        .await?;
    Ok(row)
}

// Feature flag: enable backend emission of normalized StreamEvent v1 alongside legacy events
pub fn is_stream_v1_enabled() -> bool {
    match std::env::var("UICP_STREAM_V1") {
        Ok(v) => matches!(v.as_str(), "1" | "true" | "TRUE" | "on" | "yes"),
        Err(_) => false,
    }
}

// Extract normalized events from provider-agnostic chunks
pub fn extract_events_from_chunk(chunk: &Value, default_channel: Option<&str>) -> Vec<Value> {
    let mut events = Vec::new();
    let empty_object = Value::Object(serde_json::Map::new());

    // Handle Anthropic-style content blocks
    if let Some(content_block) = chunk.get("content_block") {
        if let Some(block_type) = content_block.get("type").and_then(|v| v.as_str()) {
            match block_type {
                "text" => {
                    if let Some(text) = content_block.get("text").and_then(|v| v.as_str()) {
                        events.push(serde_json::json!({
                            "type": "content",
                            "channel": default_channel.unwrap_or("text"),
                            "text": text,
                        }));
                    }
                }
                "tool_use" => {
                    if let Some(name) = content_block.get("name").and_then(|v| v.as_str()) {
                        let id = content_block
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let input = content_block.get("input").unwrap_or(&empty_object);
                        events.push(serde_json::json!({
                            "type": "tool_call",
                            "channel": default_channel.unwrap_or("tool"),
                            "tool": name,
                            "toolCallId": id,
                            "arguments": input,
                        }));
                    }
                }
                _ => {}
            }
        }
    }

    // Handle OpenAI-style delta content
    if let Some(choices) = chunk.get("choices").and_then(|v| v.as_array()) {
        for choice in choices {
            if let Some(delta) = choice.get("delta") {
                // Content delta
                if let Some(content) = delta.get("content").and_then(|v| v.as_str()) {
                    events.push(serde_json::json!({
                        "type": "content",
                        "channel": default_channel.unwrap_or("text"),
                        "text": content,
                    }));
                }

                // Tool call delta
                if let Some(tool_calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                    for tool_call in tool_calls {
                        if let Some(function) = tool_call.get("function") {
                            let name = function.get("name").and_then(|v| v.as_str()).unwrap_or("");
                            let args = function
                                .get("arguments")
                                .and_then(|v| v.as_str())
                                .unwrap_or("{}");
                            let id = tool_call.get("id").and_then(|v| v.as_str()).unwrap_or("");

                            if !name.is_empty() {
                                events.push(serde_json::json!({
                                    "type": "tool_call",
                                    "channel": default_channel.unwrap_or("tool"),
                                    "tool": name,
                                    "toolCallId": id,
                                    "arguments": args,
                                }));
                            }
                        }
                    }
                }
            }
        }
    }

    // Handle message-level tool calls (OpenAI complete messages)
    if let Some(tool_calls) = chunk.get("tool_calls").and_then(|v| v.as_array()) {
        for tool_call in tool_calls {
            if let Some(function) = tool_call.get("function") {
                let name = function.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let args = function
                    .get("arguments")
                    .and_then(|v| v.as_str())
                    .unwrap_or("{}");
                let id = tool_call.get("id").and_then(|v| v.as_str()).unwrap_or("");

                if !name.is_empty() {
                    events.push(serde_json::json!({
                        "type": "tool_call",
                        "channel": default_channel.unwrap_or("tool"),
                        "tool": name,
                        "toolCallId": id,
                        "arguments": args,
                    }));
                }
            }
        }
    }

    // Handle direct content/text fields
    if let Some(content) = chunk.get("content").and_then(|v| v.as_str()) {
        events.push(serde_json::json!({
            "type": "content",
            "channel": default_channel.unwrap_or("text"),
            "text": content,
        }));
    }

    // Handle text_delta (Anthropic streaming)
    if let Some(delta) = chunk.get("delta") {
        if let Some(text) = delta.get("text").and_then(|v| v.as_str()) {
            events.push(serde_json::json!({
                "type": "content",
                "channel": default_channel.unwrap_or("text"),
                "text": text,
            }));
        }
    }

    // If no events extracted but we have content, treat as generic content
    if events.is_empty() {
        if let Some(text) = chunk.as_str() {
            if !text.trim().is_empty() {
                events.push(serde_json::json!({
                    "type": "content",
                    "channel": default_channel.unwrap_or("text"),
                    "text": text,
                }));
            }
        }
    }

    events
}
