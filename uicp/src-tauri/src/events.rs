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

use serde_json::Value;
use tauri::Emitter;

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

    // Handle top-level normalized content objects: { "type": "content", "text": "..." }
    if let Some(t) = chunk.get("type").and_then(|v| v.as_str()) {
        if t == "content" {
            if let Some(text) = chunk.get("text").and_then(|v| v.as_str()) {
                events.push(serde_json::json!({
                    "type": "content",
                    "channel": default_channel.unwrap_or("text"),
                    "text": text,
                }));
            }
        }
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
