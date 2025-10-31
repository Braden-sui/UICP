#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")] // hide console window on Windows in release

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use base64::engine::general_purpose::STANDARD as BASE64_ENGINE;
use base64::Engine as _;
use chrono::Utc;
use dotenvy::dotenv;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use tauri::{async_runtime::spawn, Emitter, Manager, State, WebviewUrl};

use rand::RngCore;
use tokio::{
    sync::{RwLock, Semaphore},
    time::interval,
};
use tokio_rusqlite::Connection as AsyncConn;

mod codegen;
mod compute;
mod config;
mod infrastructure;
mod llm;
mod security;

// New module structure
mod commands;
mod initialization;
mod services;

#[cfg(any(test, feature = "compute_harness"))]
pub mod commands_harness;

use crate::infrastructure::core::{log_error, log_info, CircuitBreakerConfig};

// Re-export shared core items so crate::... references in submodules remain valid
pub use crate::infrastructure::core::{
    configure_sqlite, emit_or_log, ensure_default_workspace, files_dir_path, init_database,
    log_warn, remove_compute_job, AppState, APP_NAME, DATA_DIR, FILES_DIR, LOGS_DIR,
    OLLAMA_CLOUD_HOST_DEFAULT, OLLAMA_LOCAL_BASE_DEFAULT,
};

// Minimal inline splash script to render the futuristic loader instantly without contacting dev server.
// This runs inside a separate splash window. Keep it compact and self-contained.

static DB_PATH: std::sync::LazyLock<PathBuf> =
    std::sync::LazyLock::new(|| DATA_DIR.join("data.db"));
static ENV_PATH: std::sync::LazyLock<PathBuf> = std::sync::LazyLock::new(|| DATA_DIR.join(".env"));

// files_dir_path is re-exported from core

// CircuitState and CircuitBreakerConfig now defined in core module; configure_sqlite re-exported

// Circuit breaker functions moved to circuit.rs module

// Removed unused emit_problem_detail helper (superseded by commands/chat.rs path)

// AppState is re-exported from core

#[derive(Clone, Serialize)]
struct SaveIndicatorPayload {
    ok: bool,
    timestamp: i64,
}

// Removed unused ApiKeyStatus struct

// Persistence commands are now in commands::persistence module

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageInput {
    role: String,
    // Accept structured developer payloads (objects) and legacy string messages.
    content: serde_json::Value,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCompletionRequest {
    model: Option<String>,
    messages: Vec<ChatMessageInput>,
    stream: Option<bool>,
    tools: Option<serde_json::Value>,
    format: Option<serde_json::Value>,
    #[serde(rename = "response_format")]
    response_format: Option<serde_json::Value>,
    #[serde(rename = "tool_choice")]
    tool_choice: Option<serde_json::Value>,
    reasoning: Option<serde_json::Value>,
    options: Option<serde_json::Value>,
}

// Legacy API key commands moved to commands::api_keys

// EASTER EGG ^.^ - IF YOU SEE THIS, THANK YOU FROM THE BOTTOM OF MY HEART FOR EVEN READING MY FILES. THIS IS THE FIRST
// TIME I'VE EVER DONE THIS AND I REALLY BELIEVE IF THIS GETS TO WHAT I THINK IT CAN BE, IT COULD CHANGE HOW WE INTERACT WITH AI ON THE DAY to DAY.

#[cfg(test)]
fn normalize_model_name(raw: &str, use_cloud: bool) -> String {
    let trimmed = raw.trim();
    let (base_part, had_cloud_suffix) = if let Some(stripped) = trimmed.strip_suffix("-cloud") {
        (stripped, true)
    } else {
        (trimmed, false)
    };

    let normalize_base = |input: &str| {
        if input.contains(':') {
            input.to_string()
        } else if let Some(idx) = input.rfind('-') {
            let (prefix, suffix) = input.split_at(idx);
            let suffix = suffix.trim_start_matches('-');
            format!("{prefix}:{suffix}")
        } else {
            input.to_string()
        }
    };

    if use_cloud {
        normalize_base(base_part)
    } else {
        let base = normalize_base(base_part);
        if had_cloud_suffix {
            format!("{base}-cloud")
        } else {
            base
        }
    }
}

// Feature flag: enable backend emission of normalized StreamEvent v1 alongside legacy events
// Removed unused stream v1 backend flag helper (handled in chat command path)

// Minimal extractor that converts OpenAI-like delta JSON into StreamEvent v1 events.
// Assumes Anthropic has been pre-normalized to OpenAI-like deltas via anthropic::normalize_message.
#[cfg(test)]
fn extract_events_from_chunk(
    chunk: &serde_json::Value,
    default_channel: Option<&str>,
) -> Vec<serde_json::Value> {
    use serde_json::Value;
    let mut events: Vec<Value> = Vec::new();

    let push_content = |events: &mut Vec<Value>, channel: Option<&str>, text: &str| {
        if text.trim().is_empty() {
            return;
        }
        let mut evt = serde_json::json!({
            "type": "content",
            "text": text,
        });
        if let Some(ch) = channel {
            if let Some(obj) = evt.as_object_mut() {
                obj.insert("channel".into(), serde_json::json!(ch));
            }
        }
        events.push(evt);
    };

    let push_tool_call = |events: &mut Vec<Value>,
                          index: i64,
                          id: Option<&str>,
                          name: Option<&str>,
                          arguments: Value| {
        let mut evt = serde_json::json!({
            "type": "tool_call",
            "index": index,
            "arguments": arguments,
            "isDelta": true,
        });
        if let Some(i) = id {
            if let Some(obj) = evt.as_object_mut() {
                obj.insert("id".into(), serde_json::json!(i));
            }
        }
        if let Some(n) = name {
            if let Some(obj) = evt.as_object_mut() {
                obj.insert("name".into(), serde_json::json!(n));
            }
        }
        events.push(evt);
    };

    // Helper: handle content values that may be string, array of parts, or object
    // Reduce type complexity for closure parameters used below
    type PushContentFn = dyn Fn(&mut Vec<serde_json::Value>, Option<&str>, &str);
    type PushToolCallFn =
        dyn Fn(&mut Vec<serde_json::Value>, i64, Option<&str>, Option<&str>, serde_json::Value);

    fn handle_content_value(
        events: &mut Vec<Value>,
        channel: Option<&str>,
        value: &Value,
        push_content: &PushContentFn,
        push_tool_call: &PushToolCallFn,
    ) {
        match value {
            Value::String(s) => {
                push_content(events, channel, s);
            }
            Value::Array(arr) => {
                for entry in arr {
                    if let Value::String(s) = entry {
                        push_content(events, channel, s);
                        continue;
                    }
                    if let Value::Object(map) = entry {
                        if let Some(t) = map.get("type").and_then(|v| v.as_str()) {
                            // Some providers encode tool deltas inside content array
                            if t.eq_ignore_ascii_case("tool_call")
                                || t.eq_ignore_ascii_case("tool_call_delta")
                            {
                                let index = map.get("index").and_then(|v| v.as_i64()).unwrap_or(0);
                                // function or delta.function may contain arguments/name
                                let function_obj = map
                                    .get("function")
                                    .or_else(|| map.get("delta").and_then(|d| d.get("function")));
                                let id = map.get("id").and_then(|v| v.as_str());
                                let name = map.get("name").and_then(|v| v.as_str()).or_else(|| {
                                    function_obj
                                        .and_then(|f| f.get("name").and_then(|v| v.as_str()))
                                });
                                let arguments = map
                                    .get("arguments")
                                    .cloned()
                                    .or_else(|| {
                                        function_obj.and_then(|f| f.get("arguments").cloned())
                                    })
                                    .unwrap_or(Value::Null);
                                push_tool_call(events, index, id, name, arguments);
                                continue;
                            }
                        }
                        if let Some(text) = map.get("text").and_then(|v| v.as_str()) {
                            push_content(events, channel, text);
                            continue;
                        }
                        if let Some(val) = map.get("value").and_then(|v| v.as_str()) {
                            push_content(events, channel, val);
                            continue;
                        }
                    }
                }
            }
            Value::Object(obj) => {
                if let Some(text) = obj.get("text").and_then(|v| v.as_str()) {
                    push_content(events, channel, text);
                } else if let Some(val) = obj.get("value").and_then(|v| v.as_str()) {
                    push_content(events, channel, val);
                }
            }
            _ => {}
        }
    }

    // 1) OpenAI-like choices[].delta...
    if let Some(choices) = chunk.get("choices").and_then(|v| v.as_array()) {
        for ch in choices {
            let delta = ch
                .get("delta")
                .or_else(|| ch.get("message"))
                .or_else(|| ch.get("update"));
            if let Some(d) = delta.and_then(|v| v.as_object()) {
                if let Some(content_val) = d.get("content") {
                    handle_content_value(
                        &mut events,
                        default_channel,
                        content_val,
                        &push_content,
                        &push_tool_call,
                    );
                }
                if let Some(tool_calls) = d.get("tool_calls").and_then(|v| v.as_array()) {
                    for (idx, tc) in tool_calls.iter().enumerate() {
                        let index = d
                            .get("index")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(idx as i64);
                        let id = tc
                            .get("id")
                            .and_then(|v| v.as_str())
                            .or_else(|| tc.get("tool_call_id").and_then(|v| v.as_str()));
                        let name = tc.get("name").and_then(|v| v.as_str()).or_else(|| {
                            tc.get("function")
                                .and_then(|f| f.get("name").and_then(|v| v.as_str()))
                        });
                        let arguments = tc
                            .get("arguments")
                            .cloned()
                            .or_else(|| {
                                tc.get("function").and_then(|f| f.get("arguments").cloned())
                            })
                            .unwrap_or(Value::Null);
                        push_tool_call(&mut events, index, id, name, arguments);
                    }
                }
                if let Some(tool_call) = d.get("tool_call") {
                    let id = tool_call
                        .get("id")
                        .and_then(|v| v.as_str())
                        .or_else(|| tool_call.get("tool_call_id").and_then(|v| v.as_str()));
                    let name = tool_call.get("name").and_then(|v| v.as_str()).or_else(|| {
                        tool_call
                            .get("function")
                            .and_then(|f| f.get("name").and_then(|v| v.as_str()))
                    });
                    let arguments = tool_call
                        .get("arguments")
                        .cloned()
                        .or_else(|| {
                            tool_call
                                .get("function")
                                .and_then(|f| f.get("arguments").cloned())
                        })
                        .unwrap_or(Value::Null);
                    push_tool_call(&mut events, 0, id, name, arguments);
                }
            }
        }
    }

    // 2) Root-level delta.tool_calls
    if let Some(delta) = chunk.get("delta").and_then(|v| v.as_object()) {
        if let Some(tool_calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
            for (idx, tc) in tool_calls.iter().enumerate() {
                let id = tc
                    .get("id")
                    .and_then(|v| v.as_str())
                    .or_else(|| tc.get("tool_call_id").and_then(|v| v.as_str()));
                let name = tc.get("name").and_then(|v| v.as_str()).or_else(|| {
                    tc.get("function")
                        .and_then(|f| f.get("name").and_then(|v| v.as_str()))
                });
                let arguments = tc
                    .get("arguments")
                    .cloned()
                    .or_else(|| tc.get("function").and_then(|f| f.get("arguments").cloned()))
                    .unwrap_or(Value::Null);
                push_tool_call(&mut events, idx as i64, id, name, arguments);
            }
        }
    }

    // 3) Root-level tool_calls
    if let Some(tool_calls) = chunk.get("tool_calls").and_then(|v| v.as_array()) {
        for (idx, tc) in tool_calls.iter().enumerate() {
            let id = tc
                .get("id")
                .and_then(|v| v.as_str())
                .or_else(|| tc.get("tool_call_id").and_then(|v| v.as_str()));
            let name = tc.get("name").and_then(|v| v.as_str()).or_else(|| {
                tc.get("function")
                    .and_then(|f| f.get("name").and_then(|v| v.as_str()))
            });
            let arguments = tc
                .get("arguments")
                .cloned()
                .or_else(|| tc.get("function").and_then(|f| f.get("arguments").cloned()))
                .unwrap_or(Value::Null);
            push_tool_call(&mut events, idx as i64, id, name, arguments);
        }
    }

    // 4) Root-level content or message.content
    if let Some(content) = chunk.get("content") {
        handle_content_value(
            &mut events,
            default_channel,
            content,
            &push_content,
            &push_tool_call,
        );
    }
    if let Some(msg) = chunk.get("message").and_then(|v| v.as_object()) {
        if let Some(content) = msg.get("content") {
            handle_content_value(
                &mut events,
                default_channel,
                content,
                &push_content,
                &push_tool_call,
            );
        }
        if let Some(tcs) = msg.get("tool_calls").and_then(|v| v.as_array()) {
            for (idx, tc) in tcs.iter().enumerate() {
                let id = tc
                    .get("id")
                    .and_then(|v| v.as_str())
                    .or_else(|| tc.get("tool_call_id").and_then(|v| v.as_str()));
                let name = tc.get("name").and_then(|v| v.as_str()).or_else(|| {
                    tc.get("function")
                        .and_then(|f| f.get("name").and_then(|v| v.as_str()))
                });
                let arguments = tc
                    .get("arguments")
                    .cloned()
                    .or_else(|| tc.get("function").and_then(|f| f.get("arguments").cloned()))
                    .unwrap_or(Value::Null);
                push_tool_call(&mut events, idx as i64, id, name, arguments);
            }
        }
    }

    events
}

// Database schema management is implemented in core::init_database and helpers.

// Deprecated: legacy keyring/env migration is removed. Embedded keystore is the only source of provider keys.

// Helper to get the appropriate Ollama base URL with validation
// Removed redundant get_ollama_base_url (canonical helper now lives in commands/chat.rs)

#[cfg(test)]
mod tests {
    use super::extract_events_from_chunk;
    use super::normalize_model_name;
    use crate::llm::provider_adapters::anthropic;
    use serde_json::json;

    #[test]
    fn cloud_keeps_colon_tags() {
        assert_eq!(normalize_model_name("llama3:70b", true), "llama3:70b");
    }

    #[test]
    fn cloud_strips_trailing_cloud_suffix() {
        assert_eq!(normalize_model_name("llama3:70b-cloud", true), "llama3:70b");
    }

    #[test]
    fn cloud_converts_hyphenated_form() {
        assert_eq!(normalize_model_name("llama3-70b", true), "llama3:70b");
    }

    #[test]
    fn local_converts_hyphenated_form_to_colon() {
        assert_eq!(normalize_model_name("llama3-70b", false), "llama3:70b");
    }

    #[test]
    fn local_preserves_colon_for_daemon() {
        assert_eq!(normalize_model_name("llama3:70b", false), "llama3:70b");
    }

    #[test]
    fn extract_content_from_openai_delta() {
        let v = json!({
            "choices": [{ "delta": { "content": "Hello" } }]
        });
        let events = extract_events_from_chunk(&v, None);
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.get("type").and_then(|v| v.as_str()), Some("content"));
        assert_eq!(e.get("text").and_then(|v| v.as_str()), Some("Hello"));
        assert!(e.get("channel").is_none());
    }

    #[test]
    fn extract_tool_call_from_openai_delta() {
        let v = json!({
            "choices": [{
                "delta": { "tool_calls": [{
                    "index": 0,
                    "id": "call_1",
                    "function": { "name": "foo", "arguments": "{\"a\":1}" }
                }]}
            }]
        });
        let events = extract_events_from_chunk(&v, None);
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.get("type").and_then(|v| v.as_str()), Some("tool_call"));
        assert_eq!(e.get("index").and_then(|v| v.as_i64()), Some(0));
        assert_eq!(e.get("id").and_then(|v| v.as_str()), Some("call_1"));
        assert_eq!(e.get("name").and_then(|v| v.as_str()), Some("foo"));
    }

    #[test]
    fn extract_from_message_object_and_root_tool_calls() {
        let v = json!({
            "message": { "content": [ {"type":"text","text":"Hi"} ], "tool_calls": [{
                "id": "abc",
                "function": { "name": "bar", "arguments": "{}" }
            }]},
            "tool_calls": [{ "name": "baz", "arguments": "{}" }]
        });
        let events = extract_events_from_chunk(&v, None);
        assert!(events
            .iter()
            .any(|e| e.get("type").and_then(|v| v.as_str()) == Some("content")));
        assert!(
            events
                .iter()
                .filter(|e| e.get("type").and_then(|v| v.as_str()) == Some("tool_call"))
                .count()
                >= 2
        );
    }

    #[test]
    fn default_channel_is_injected_for_json() {
        let v = json!({ "content": [{"type":"text","text":"A"}] });
        let events = extract_events_from_chunk(&v, Some("json"));
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.get("type").and_then(|v| v.as_str()), Some("content"));
        assert_eq!(e.get("channel").and_then(|v| v.as_str()), Some("json"));
    }

    #[test]
    fn anthropic_text_delta_normalizes_to_content() {
        let raw = json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "text_delta", "text": "Hi" }
        });
        let normalized = crate::llm::anthropic::normalize_message(raw).expect("normalize");
        let events = extract_events_from_chunk(&normalized, Some("json"));
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.get("type").and_then(|v| v.as_str()), Some("content"));
        assert_eq!(e.get("text").and_then(|v| v.as_str()), Some("Hi"));
        assert_eq!(e.get("channel").and_then(|v| v.as_str()), Some("json"));
    }

    #[test]
    fn anthropic_tool_use_start_normalizes_to_tool_call() {
        let raw = json!({
            "type": "content_block_start",
            "index": 0,
            "content_block": {
                "type": "tool_use",
                "id": "tool_abc",
                "name": "run_cmd",
                "input": { "cmd": "echo hi" }
            }
        });
        let normalized = crate::llm::anthropic::normalize_message(raw).expect("normalize");
        let events = extract_events_from_chunk(&normalized, Some("json"));
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.get("type").and_then(|v| v.as_str()), Some("tool_call"));
        assert_eq!(e.get("id").and_then(|v| v.as_str()), Some("tool_abc"));
        assert_eq!(e.get("name").and_then(|v| v.as_str()), Some("run_cmd"));
    }

    #[test]
    fn openai_delta_content_injects_json_channel() {
        let v = json!({
            "choices": [{ "delta": { "content": "Hello" } }]
        });
        let events = extract_events_from_chunk(&v, Some("json"));
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.get("type").and_then(|v| v.as_str()), Some("content"));
        assert_eq!(e.get("text").and_then(|v| v.as_str()), Some("Hello"));
        assert_eq!(e.get("channel").and_then(|v| v.as_str()), Some("json"));
    }

    #[test]
    fn openrouter_delta_tool_calls_maps_to_tool_call() {
        let v = json!({
            "choices": [{
                "delta": { "tool_calls": [{
                    "index": 0,
                    "id": "call_0",
                    "function": { "name": "emit_batch", "arguments": "{\"batch\":[]}" }
                }]}
            }]
        });
        let events = extract_events_from_chunk(&v, Some("json"));
        assert_eq!(events.len(), 1);
        let e = &events[0];
        assert_eq!(e.get("type").and_then(|v| v.as_str()), Some("tool_call"));
        assert_eq!(e.get("index").and_then(|v| v.as_i64()), Some(0));
        assert_eq!(e.get("id").and_then(|v| v.as_str()), Some("call_0"));
        assert_eq!(e.get("name").and_then(|v| v.as_str()), Some("emit_batch"));
    }
}

// emit_or_log and remove_compute_job are re-exported from core

fn spawn_autosave(app_handle: tauri::AppHandle) {
    spawn(async move {
        let mut ticker = interval(Duration::from_secs(5));

        // Emit initial state immediately and seed last_emitted.
        let mut last_emitted = {
            let state: State<'_, AppState> = app_handle.state();
            let current = *state.last_save_ok.read().await;
            emit_or_log(
                &app_handle,
                "save-indicator",
                SaveIndicatorPayload {
                    ok: current,
                    timestamp: Utc::now().timestamp(),
                },
            );
            Some(current)
        };
        loop {
            ticker.tick().await;
            let state: State<'_, AppState> = app_handle.state();
            let current = *state.last_save_ok.read().await;
            if last_emitted == Some(current) {
                continue;
            }
            last_emitted = Some(current);
            emit_or_log(
                &app_handle,
                "save-indicator",
                SaveIndicatorPayload {
                    ok: current,
                    timestamp: Utc::now().timestamp(),
                },
            );
        }
    });
}

/// Spawn periodic database maintenance task for WAL checkpointing and vacuuming.
///
/// Runs every 24 hours by default (configurable via `UICP_DB_MAINTENANCE_INTERVAL_HOURS`).
/// Performs:
/// - WAL checkpoint (TRUNCATE) to prevent unbounded WAL growth
/// - PRAGMA optimize for query planner statistics
/// - VACUUM every 7 days to reclaim fragmented space
fn spawn_db_maintenance(app_handle: tauri::AppHandle) {
    spawn(async move {
        let interval_hours = std::env::var("UICP_DB_MAINTENANCE_INTERVAL_HOURS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(24);

        let vacuum_interval_days = std::env::var("UICP_DB_VACUUM_INTERVAL_DAYS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(7);

        let mut ticker = interval(Duration::from_secs(interval_hours * 60 * 60));
        let mut ticks_since_vacuum = 0u64;
        let ticks_per_vacuum = (vacuum_interval_days * 24) / interval_hours;

        loop {
            ticker.tick().await;
            let state: State<'_, AppState> = app_handle.state();

            // Skip maintenance in safe mode to avoid interfering with recovery
            if *state.safe_mode.read().await {
                continue;
            }

            #[cfg(feature = "otel_spans")]
            let _span = tracing::info_span!(
                "db_maintenance",
                run_vacuum = ticks_since_vacuum >= ticks_per_vacuum
            );
            #[cfg(feature = "otel_spans")]
            let started = Instant::now();

            let should_vacuum = ticks_since_vacuum >= ticks_per_vacuum;
            ticks_since_vacuum += 1;

            let res = state
                .db_rw
                .call(
                    move |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
                        // Always checkpoint and optimize
                        c.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize;")
                            .map_err(tokio_rusqlite::Error::from)?;
                        // Periodically vacuum to reclaim fragmented space
                        if should_vacuum {
                            c.execute_batch("VACUUM;")
                                .map_err(tokio_rusqlite::Error::from)?;
                        }

                        Ok(())
                    },
                )
                .await;

            match &res {
                Ok(()) => {
                    if should_vacuum {
                        ticks_since_vacuum = 0;
                    }
                    #[cfg(feature = "otel_spans")]
                    {
                        let ms = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
                        tracing::info!(
                            target = "uicp",
                            duration_ms = ms,
                            vacuumed = should_vacuum,
                            "db maintenance completed"
                        );
                    }
                }
                Err(e) => {
                    log_error(format!("Database maintenance failed: {e:?}"));
                    #[cfg(feature = "otel_spans")]
                    {
                        let ms = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
                        tracing::warn!(
                            target = "uicp",
                            duration_ms = ms,
                            error = %e,
                            "db maintenance failed"
                        );
                    }
                    // Emit diagnostic event for UI monitoring
                    let _ = app_handle.emit(
                        "db-maintenance-error",
                        serde_json::json!({
                            "error": format!("{e:?}"),
                            "timestamp": Utc::now().timestamp(),
                            "recommendation": "Database maintenance failed. Consider running health_quick_check."
                        }),
                    );
                }
            }

            #[cfg(feature = "otel_spans")]
            {
                let _ = &started; // preserve instrumentation variable usage guard
            }
        }
    });
}

#[allow(clippy::too_many_lines)]
fn main() {
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
    if let Err(err) = dotenv() {
        log_warn(format!("Failed to load .env: {err:?}"));
    }

    let db_path = DB_PATH.clone();

    // Initialize database and ensure directory exists BEFORE opening connections
    if let Err(err) = init_database(&db_path) {
        log_error(format!("Failed to initialize database: {err:?}"));
        std::process::exit(1);
    }
    if let Err(err) = ensure_default_workspace(&db_path) {
        log_error(format!("Failed to ensure default workspace: {err:?}"));
        std::process::exit(1);
    }

    // Now open resident async SQLite connections (one writer, one read-only)
    let db_rw = tauri::async_runtime::block_on(AsyncConn::open(&db_path))
        .expect("open sqlite rw connection");
    let db_ro = tauri::async_runtime::block_on(AsyncConn::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ))
    .expect("open sqlite ro connection");
    // Configure connections once on startup
    tauri::async_runtime::block_on(async {
        // Writer: full configuration
        let _ = db_rw
            .call(
                |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
                    use std::time::Duration;
                    c.busy_timeout(Duration::from_millis(5_000))
                        .map_err(tokio_rusqlite::Error::from)?;
                    c.pragma_update(None, "journal_mode", "WAL")
                        .map_err(tokio_rusqlite::Error::from)?;
                    c.pragma_update(None, "synchronous", "NORMAL")
                        .map_err(tokio_rusqlite::Error::from)?;
                    c.pragma_update(None, "foreign_keys", "ON")
                        .map_err(tokio_rusqlite::Error::from)?;
                    Ok(())
                },
            )
            .await;
        // Read-only: set a subset that does not require writes
        let _ = db_ro
            .call(
                |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
                    use std::time::Duration;
                    c.busy_timeout(Duration::from_millis(5_000))
                        .map_err(tokio_rusqlite::Error::from)?;
                    c.pragma_update(None, "foreign_keys", "ON")
                        .map_err(tokio_rusqlite::Error::from)?;
                    Ok(())
                },
            )
            .await;
        // Best-effort hygiene
        let _ = db_rw
            .call(
                |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
                    c.execute_batch("PRAGMA optimize; PRAGMA wal_checkpoint(TRUNCATE);")
                        .map_err(tokio_rusqlite::Error::from)
                },
            )
            .await;
    });

    let action_log = match crate::infrastructure::action_log::ActionLogService::start(&db_path) {
        Ok(handle) => handle,
        Err(err) => {
            log_error(format!("Failed to start action log service: {err:?}"));
            std::process::exit(1);
        }
    };

    if let Err(err) = action_log.append_json_blocking(
        "system.boot",
        &serde_json::json!({
            "version": env!("CARGO_PKG_VERSION"),
            "ts": chrono::Utc::now().timestamp(),
        }),
    ) {
        log_error(format!(
            "E-UICP-0660: failed to append boot action-log entry: {err:?}"
        ));
    }

    let job_token_key: [u8; 32] = {
        if let Ok(hex_key) = std::env::var("UICP_JOB_TOKEN_KEY_HEX") {
            if let Ok(bytes) = hex::decode(hex_key.trim()) {
                if bytes.len() == 32 {
                    let mut arr = [0u8; 32];
                    arr.copy_from_slice(&bytes);
                    arr
                } else {
                    let mut arr = [0u8; 32];
                    rand::thread_rng().fill_bytes(&mut arr);
                    arr
                }
            } else {
                let mut arr = [0u8; 32];
                rand::thread_rng().fill_bytes(&mut arr);
                arr
            }
        } else {
            let mut arr = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut arr);
            arr
        }
    };

    let wasm_conc = std::env::var("UICP_WASM_CONCURRENCY")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|&n| (1..=64).contains(&n))
        .unwrap_or(2);

    let state = AppState {
        db_path: db_path.clone(),
        db_ro,
        db_rw,
        last_save_ok: RwLock::new(true),
        ollama_key: RwLock::new(None),
        use_direct_cloud: RwLock::new(true), // default to cloud mode
        allow_local_opt_in: RwLock::new({
            let raw = std::env::var("UICP_OLLAMA_LOCAL_OPTIN").unwrap_or_default();
            matches!(raw.as_str(), "1" | "true" | "TRUE" | "yes" | "on")
        }),
        debug_enabled: RwLock::new({
            let raw = std::env::var("UICP_DEBUG").unwrap_or_default();
            matches!(raw.as_str(), "1" | "true" | "TRUE" | "yes" | "on")
        }),
        http: Client::builder()
            // Allow long-lived streaming responses; UI can cancel via cancel_chat.
            .connect_timeout(Duration::from_secs(10))
            .pool_idle_timeout(Some(Duration::from_secs(30)))
            .tcp_keepalive(Some(Duration::from_secs(30)))
            .build()
            .expect("Failed to build HTTP client"),
        ongoing: RwLock::new(HashMap::new()),
        compute_ongoing: RwLock::new(HashMap::new()),
        compute_sem: Arc::new(Semaphore::new(2)),
        codegen_sem: Arc::new(Semaphore::new(2)),
        wasm_sem: Arc::new(Semaphore::new(wasm_conc)),
        compute_cancel: RwLock::new(HashMap::new()),
        safe_mode: RwLock::new(false),
        safe_reason: RwLock::new(None),
        circuit_breakers: Arc::new(RwLock::new(HashMap::new())),
        circuit_config: CircuitBreakerConfig::from_env(),
        provider_circuit_manager: crate::llm::provider_circuit::ProviderCircuitManager::new(),
        chaos_engine: crate::infrastructure::chaos::ChaosEngine::new(),
        resilience_metrics: crate::infrastructure::chaos::ResilienceMetrics::new(),
        action_log,
        job_token_key,
    };

    // NOTE: Environment API key loading moved to embedded keystore flows.
    // Intentionally no-op here to avoid exposing plaintext or diverging from keystore contract.

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .manage(state)
        .plugin(tauri_plugin_fs::init());

    #[cfg(all(feature = "dialog_plugin", not(feature = "compute_harness")))]
    {
        builder = builder.plugin(tauri_plugin_dialog::init());
    }

    #[cfg(any(not(feature = "dialog_plugin"), feature = "compute_harness"))]
    {
        // WHY: Compute harness binaries run in CI/headless environments or without the dialog plugin feature; skipping
        // it avoids a hard dependency on TaskDialogIndirect so tests do not fail on stripped-down Windows hosts.
    }

    builder
        .setup(|app| {
            // Ensure base data directories exist
            if let Err(e) = std::fs::create_dir_all(&*DATA_DIR) {
                log_error(format!("create data dir failed: {e:?}"));
            }
            if let Err(e) = std::fs::create_dir_all(&*LOGS_DIR) {
                log_error(format!("create logs dir failed: {e:?}"));
            }
            if let Err(e) = std::fs::create_dir_all(&*FILES_DIR) {
                log_error(format!("create files dir failed: {e:?}"));
            }
            // Ensure bundled compute modules are installed into the user modules dir
            let handle = app.handle();
            if let Err(err) = crate::compute::registry::install_bundled_modules_if_missing(handle) {
                log_error(format!("module install failed: {err:?}"));
            }
            spawn_autosave(handle.clone());
            // Periodic DB maintenance to keep WAL and stats tidy
            spawn_db_maintenance(handle.clone());

            #[cfg(feature = "wasm_compute")]
            {
                let prewarm_handle = handle.clone();
                let join_handle = tauri::async_runtime::spawn_blocking(move || {
                    if let Err(err) = crate::compute::compute::prewarm_quickjs(&prewarm_handle) {
                        log_warn(format!("quickjs prewarm failed: {err:?}"));
                    }
                });
                std::mem::drop(join_handle);
            }

            // Create a native splash window using a bundled asset served by the frontend (works in dev and prod).
            let splash_html = r#"<!doctype html><html lang=\"en\"><head>
  <meta charset=\"UTF-8\">
  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">
  <meta name=\"color-scheme\" content=\"dark\">
  <title>UICP</title>
  <style>
    html,body{height:100%;margin:0}
    body{background:#0a0a0f;color:#cbd5e1;display:flex;align-items:center;justify-content:center;overflow:hidden}
    .shell{position:relative;display:flex;flex-direction:column;align-items:center;gap:42px}
    .text{font:500 11px -apple-system,BlinkMacSystemFont,Segoe UI,system-ui,sans-serif;letter-spacing:.22em;text-transform:uppercase;color:rgba(255,255,255,.6)}
    .cluster{position:relative;width:120px;height:120px}
    .hex{position:absolute;width:32px;height:32px;transform-origin:center}
    .hex::before{content:\"\";position:absolute;inset:0;background:linear-gradient(135deg,rgba(99,102,241,.4),rgba(139,92,246,.2));clip-path:polygon(50% 0%,100% 25%,100% 75%,50% 100%,0% 75%,0% 25%);animation:hex 3s ease-in-out infinite;will-change:transform,opacity}
    .hex:nth-child(3){top:0;left:44px}
    .hex:nth-child(4){top:22px;left:16px}
    .hex:nth-child(5){top:22px;left:72px}
    .hex:nth-child(6){top:44px;left:44px}
    .hex:nth-child(7){top:66px;left:16px}
    .hex:nth-child(8){top:66px;left:72px}
    .hex:nth-child(9){top:88px;left:44px}
    .hex:nth-child(3)::before{animation-delay:0s}
    .hex:nth-child(4)::before{animation-delay:.15s}
    .hex:nth-child(5)::before{animation-delay:.3s}
    .hex:nth-child(6)::before{animation-delay:.45s}
    .hex:nth-child(7)::before{animation-delay:.6s}
    .hex:nth-child(8)::before{animation-delay:.75s}
    .hex:nth-child(9)::before{animation-delay:.9s}
    .core{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:8px;height:8px;border-radius:50%;background:rgba(139,92,246,.9);box-shadow:0 0 20px rgba(139,92,246,.6),0 0 40px rgba(139,92,246,.3);animation:core 2s ease-in-out infinite}
    .ring{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);border:1px solid rgba(99,102,241,.12);border-radius:50%;animation:spin 8s linear infinite;will-change:transform}
    .ring.r2{width:180px;height:180px;animation-duration:12s;animation-direction:reverse}
    .ring.r1{width:140px;height:140px}
    body::before{content:\"\";position:absolute;inset:-50%;background:radial-gradient(circle at 30% 50%,rgba(99,102,241,.08) 0%,transparent 50%),radial-gradient(circle at 70% 50%,rgba(139,92,246,.06) 0%,transparent 50%);animation:drift 20s ease-in-out infinite}
    @keyframes hex{0%,100%{opacity:.3;transform:scale(.95)}50%{opacity:1;transform:scale(1.05)}}
    @keyframes core{0%,100%{transform:translate(-50%,-50%) scale(1);opacity:.9}50%{transform:translate(-50%,-50%) scale(1.3);opacity:1}}
    @keyframes spin{to{transform:translate(-50%,-50%) rotate(360deg)}}
    @keyframes drift{0%,100%{transform:translate(0,0) rotate(0)}33%{transform:translate(10%,-10%) rotate(120deg)}66%{transform:translate(-10%,10%) rotate(240deg)}}
    @media (prefers-reduced-motion: reduce){*,*::before{animation:none!important}}
  </style>
</head>
<body>
  <div class=\"shell\" role=\"status\" aria-live=\"polite\" aria-busy=\"true\" aria-label=\"Initializing application\">
    <div class=\"cluster\">
      <div class=\"ring r1\"></div>
      <div class=\"ring r2\"></div>
      <div class=\"hex\"></div>
      <div class=\"hex\"></div>
      <div class=\"hex\"></div>
      <div class=\"hex\"></div>
      <div class=\"hex\"></div>
      <div class=\"hex\"></div>
      <div class=\"hex\"></div>
      <div class=\"core\"></div>
    </div>
    <p class=\"text\">Initializing</p>
  </div>
</body></html>"#;
            // Try bundled asset first (works in prod). If unavailable in current environment, fall back to data: URL.
            let splash_try_app = tauri::WebviewWindowBuilder::new(app, "splash", WebviewUrl::App("splash.html".into()))
                .title("UICP")
                .decorations(false)
                .resizable(false)
                .inner_size(420.0, 280.0)
                .center()
                .visible(true)
                .build();
            if let Err(err) = splash_try_app {
                log_warn(format!(
                    "splash app:// failed, falling back to data URL: {err:?}"
                ));
                let data_url = format!("data:text/html;base64,{}", BASE64_ENGINE.encode(splash_html));
                let splash_fallback = tauri::WebviewWindowBuilder::new(app, "splash", WebviewUrl::External(
                    Url::parse(&data_url).expect("valid data url")
                ))
                    .title("UICP")
                    .decorations(false)
                    .resizable(false)
                    .inner_size(420.0, 280.0)
                    .center()
                    .visible(true)
                    .build();
                if let Err(err2) = splash_fallback {
                    log_error(format!(
                        "failed to create splash window (data URL fallback): {err2:?}"
                    ));
                }
            }

            // Frontend will call the `frontend_ready` command; see handler below.
            // Run DB health check at startup; enter Safe Mode on failure
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = commands::recovery::health_quick_check_internal(&handle).await {
                    log_error(format!("health_quick_check failed: {err:?}"));
                }
            });
            // Load host policies (best-effort)
            let handle2 = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = crate::security::authz::reload_policies(&handle2) {
                    log_warn(format!("reload_policies failed: {err}"));
                }
            });
            // If local opt-in is enabled by env or persisted UI toggle, probe local daemon once to enable fallback.
            let handle3 = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state: State<'_, AppState> = handle3.state();
                if *state.allow_local_opt_in.read().await {
                    crate::services::chat_service::maybe_enable_local_ollama(&state).await;
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Files
            commands::files::get_paths,
            commands::files::copy_into_files,
            commands::files::export_from_files,
            commands::files::open_path,

            // Debug
            commands::debug::set_debug,
            commands::debug::debug_circuits,
            commands::debug::mint_job_token,
            commands::debug::set_env_var,
            commands::debug::get_action_log_stats,
            commands::debug::set_allow_local_opt_in,
            commands::debug::get_ollama_mode,
            commands::debug::frontend_ready,

            // Agents
            commands::agents::load_agents_config_file,
            commands::agents::save_agents_config_file,

            // Apppack
            commands::apppack::apppack_validate,
            commands::apppack::apppack_install,
            commands::apppack::apppack_entry_html,

            // Modules
            commands::modules::verify_modules,
            commands::modules::get_modules_info,
            commands::modules::get_modules_registry,

            // Network
            commands::network::egress_fetch,
            commands::network::reload_policies,

            // API Keys (legacy)
            commands::api_keys::load_api_key,
            commands::api_keys::save_api_key,
            commands::api_keys::test_api_key,

            // Keystore
            commands::keystore::keystore_unlock,
            commands::keystore::keystore_lock,
            commands::keystore::keystore_status,
            commands::keystore::keystore_sentinel_exists,
            commands::keystore::keystore_list_ids,
            commands::keystore::keystore_autolock_reason,
            commands::keystore::secret_set,
            commands::keystore::secret_exists,
            commands::keystore::secret_delete,

            // Persistence
            commands::persistence::persist_command,
            commands::persistence::get_workspace_commands,
            commands::persistence::clear_workspace_commands,
            commands::persistence::delete_window_commands,
            commands::persistence::load_workspace,
            commands::persistence::save_workspace,

            // Providers
            commands::providers::auth_preflight,
            commands::providers::save_provider_api_key,
            commands::providers::provider_login,
            commands::providers::provider_health,
            commands::providers::provider_resolve,
            commands::providers::provider_install,

            // Recovery
            commands::recovery::health_quick_check,
            commands::recovery::determinism_probe,
            commands::recovery::recovery_action,
            commands::recovery::recovery_auto,
            commands::recovery::recovery_export,
            commands::recovery::save_checkpoint,
            commands::recovery::set_safe_mode,

            // Compute
            commands::compute::compute_call,
            commands::compute::compute_cancel,
            commands::compute::clear_compute_cache,

            // Chat
            commands::chat::chat_completion,
            commands::chat::cancel_chat,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
