use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use chrono::Utc;
use reqwest::Url;
use tauri::{
    async_runtime::{spawn, JoinHandle},
    Emitter, Manager, State,
};
use tokio::io::AsyncWriteExt;
use tokio::time::timeout;
use tokio_stream::StreamExt;

use crate::core::{emit_or_log, APP_NAME, LOGS_DIR};
use crate::events::{emit_problem_detail, extract_events_from_chunk, is_stream_v1_enabled};
use crate::provider_adapters::create_adapter;
use crate::providers::build_provider_headers;
use crate::{circuit, AppState, ChatCompletionRequest};

#[tauri::command]
pub async fn chat_completion(
    window: tauri::Window,
    state: State<'_, AppState>,
    request_id: Option<String>,
    request: ChatCompletionRequest,
    provider: Option<String>,
    _base_url: Option<String>,
) -> Result<(), String> {
    let ChatCompletionRequest {
        model,
        messages,
        stream,
        tools,
        format,
        response_format,
        tool_choice,
        reasoning,
        options,
    } = request;

    if messages.is_empty() {
        return Err("messages cannot be empty".into());
    }

    let use_cloud = *state.use_direct_cloud.read().await;
    let provider_lower = provider.as_ref().map(|s| s.to_ascii_lowercase());

    // Default actor model favors Qwen3-Coder for consistent cloud/local pairing when provider not specified.
    // Avoid reading .env here; the UI selects the model per Agent Settings.
    let requested_model = model.unwrap_or_else(|| "qwen3-coder:480b".into());
    // Only normalize for Ollama-compatible routing. OpenAI/OpenRouter expect raw model ids.
    let resolved_model = if matches!(provider_lower.as_deref(), Some("openai" | "openrouter")) {
        requested_model.clone()
    } else {
        normalize_model_name(&requested_model, use_cloud)
    };

    let mut body = serde_json::json!({
        "model": resolved_model,
        "messages": messages,
        "stream": stream.unwrap_or(true),
        "tools": tools,
    });
    if let Some(format_val) = format {
        body["format"] = format_val;
    }
    if let Some(response_format_val) = response_format {
        body["response_format"] = response_format_val;
    }
    if let Some(tool_choice_val) = tool_choice {
        body["tool_choice"] = tool_choice_val;
    }
    if let Some(reasoning_val) = reasoning.clone() {
        body["reasoning"] = reasoning_val.clone();
        if use_cloud {
            if let Some(options_val) = options.clone() {
                body["options"] = options_val;
            } else {
                body["options"] = serde_json::json!({ "reasoning": reasoning_val });
            }
        }
    } else if use_cloud {
        if let Some(options_val) = options {
            body["options"] = options_val;
        }
    }

    // Use provider adapter to transform request body
    let adapter = create_adapter(provider_lower.as_deref().unwrap_or("ollama"));
    body = adapter.transform_request(body).await?;

    let base = get_ollama_base_url(&state).await?;

    // Simple retry/backoff policy for rate limits and transient network failures (configurable via RetryEngine)

    let rid = request_id.unwrap_or_else(|| format!("req-{}", Utc::now().timestamp_millis()));
    let app_handle = window.app_handle().clone();
    let base_url = base.clone();
    let body_payload = body.clone();
    // No plaintext secret propagation; headers will be injected from keystore when needed.
    let logs_dir = LOGS_DIR.clone();
    let rid_for_task = rid.clone();
    let stream_flag_for_task = body_payload
        .get("stream")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(true);
    let circuit_breakers = Arc::clone(&state.circuit_breakers);
    let provider_circuit_manager = state.provider_circuit_manager.clone();
    let circuit_config = state.circuit_config.clone();
    let http_client = state.http.clone();
    let use_direct_cloud = *state.use_direct_cloud.read().await;
    let debug_enabled = *state.debug_enabled.read().await;
    let idle_timeout_ms = std::env::var("CHAT_IDLE_TIMEOUT_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(35_000);

    let base_host = Url::parse(&base_url)
        .ok()
        .and_then(|u| u.host_str().map(|h| h.to_string()));
    let handshake_timeout = Duration::from_secs(60);
    let idle_timeout = Duration::from_millis(idle_timeout_ms);
    let user_agent = format!("{}/tauri {}", APP_NAME, env!("CARGO_PKG_VERSION"));

    let join: JoinHandle<()> = spawn(async move {
        // best-effort logs dir
        let debug_on = debug_enabled;
        if debug_on {
            let _ = tokio::fs::create_dir_all(&logs_dir).await;
        }
        let trace_path = logs_dir.join(format!("trace-{}.ndjson", rid_for_task));

        let append_trace = |event: serde_json::Value| {
            let path = trace_path.clone();
            async move {
                let line = format!("{event}\n");
                if let Ok(mut f) = tokio::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&path)
                    .await
                {
                    let _ = f.write_all(line.as_bytes()).await;
                }
            }
        };

        let emit_debug = |payload: serde_json::Value| {
            let handle = app_handle.clone();
            async move {
                let _ = handle.emit("debug-log", payload);
            }
        };

        let emit_circuit_telemetry = |event_name: &str, payload: serde_json::Value| {
            let handle = app_handle.clone();
            let name = event_name.to_string();
            tokio::spawn(async move {
                let _ = handle.emit(&name, payload);
            });
        };

        let use_cloud = use_direct_cloud;

        if debug_on {
            let adapter = create_adapter(provider_lower.as_deref().unwrap_or("ollama"));
            let endpoint_path = adapter.endpoint_path();
            let url = if adapter.provider_name() == "ollama" && use_cloud {
                format!("{}{}", base_url, "/api/chat")
            } else if adapter.provider_name() == "ollama" && !use_cloud {
                format!("{}{}", base_url, "/chat/completions")
            } else {
                format!("{}{}", base_url, endpoint_path)
            };
            let ev = serde_json::json!({
                "ts": Utc::now().timestamp_millis(),
                "event": "request_started",
                "requestId": rid_for_task,
                "useCloud": use_cloud,
                "url": url,
                "model": body_payload.get("model").cloned().unwrap_or(serde_json::json!(null)),
                "stream": body_payload.get("stream").cloned().unwrap_or(serde_json::json!(true)),
            });
            tokio::spawn(append_trace(ev.clone()));
            tokio::spawn(emit_debug(ev));

            // request metadata snapshot (no secrets)
            let messages_len = body_payload
                .get("messages")
                .and_then(|m| m.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            let format_present = body_payload.get("format").is_some();
            let tools_count = body_payload
                .get("tools")
                .and_then(|t| t.as_array())
                .map(|a| a.len())
                .unwrap_or(0);
            let meta = serde_json::json!({
                "ts": Utc::now().timestamp_millis(),
                "event": "request_body_meta",
                "requestId": rid_for_task,
                "messages": messages_len,
                "format": format_present,
                "tools": tools_count,
            });
            tokio::spawn(append_trace(meta.clone()));
            tokio::spawn(emit_debug(meta));
        }
        let mut request_body = body_payload;
        let mut attempt_local: u8 = 0;
        let mut fallback_tried: bool = false;
        let mut local_path_fallback: bool = false;
        'outer: loop {
            attempt_local += 1;
            let adapter = create_adapter(provider_lower.as_deref().unwrap_or("ollama"));
            let endpoint_path = adapter.endpoint_path();
            let url = if adapter.provider_name() == "ollama" && (use_cloud || local_path_fallback) {
                format!("{}{}", base_url, "/api/chat")
            } else if adapter.provider_name() == "ollama" && !use_cloud && !local_path_fallback {
                format!("{}{}", base_url, "/chat/completions")
            } else {
                format!("{}{}", base_url, endpoint_path)
            };

            let host_for_attempt = Url::parse(&url)
                .ok()
                .and_then(|u| u.host_str().map(|h| h.to_string()))
                .or_else(|| base_host.clone());

            let mut half_open_probe = false;
            if let Some(host) = host_for_attempt.as_deref() {
                let provider_name = adapter.provider_name();
                match provider_circuit_manager
                    .is_circuit_open(provider_name, host)
                    .await
                {
                    Some(until) => {
                        let wait_ms = u64::try_from(
                            until.saturating_duration_since(Instant::now()).as_millis(),
                        )
                        .unwrap_or(u64::MAX);
                        if debug_on {
                            let ev = serde_json::json!({
                                "ts": Utc::now().timestamp_millis(),
                                "event": "circuit_blocked",
                                "requestId": rid_for_task,
                                "provider": provider_name,
                                "host": host,
                                "retryMs": wait_ms,
                            });
                            tokio::spawn(append_trace(ev.clone()));
                            tokio::spawn(emit_debug(ev));
                        }
                        emit_problem_detail(
                            &app_handle,
                            &rid_for_task,
                            503,
                            "CircuitOpen",
                            "Remote temporarily unavailable",
                            Some(wait_ms),
                        );
                        break;
                    }
                    None => {
                        let mut guard = circuit_breakers.write().await;
                        if let Some(state) = guard.get_mut(host) {
                            if state.half_open && !state.half_open_probe_in_flight {
                                state.half_open_probe_in_flight = true;
                                half_open_probe = true;
                                if debug_on {
                                    let ev = serde_json::json!({
                                        "ts": Utc::now().timestamp_millis(),
                                        "event": "circuit_probe",
                                        "requestId": rid_for_task,
                                        "host": host,
                                    });
                                    tokio::spawn(append_trace(ev.clone()));
                                    tokio::spawn(emit_debug(ev));
                                }
                                emit_or_log(
                                    &app_handle,
                                    "circuit-half-open-probe",
                                    serde_json::json!({
                                        "requestId": rid_for_task,
                                        "host": host,
                                    }),
                                );
                            } else if state.half_open && state.half_open_probe_in_flight {
                                let wait_ms = circuit_config.open_duration_ms;
                                if debug_on {
                                    let ev = serde_json::json!({
                                        "ts": Utc::now().timestamp_millis(),
                                        "event": "circuit_probe_skipped",
                                        "requestId": rid_for_task,
                                        "host": host,
                                        "retryMs": wait_ms,
                                    });
                                    tokio::spawn(append_trace(ev.clone()));
                                    tokio::spawn(emit_debug(ev));
                                }
                                emit_problem_detail(
                                    &app_handle,
                                    &rid_for_task,
                                    503,
                                    "CircuitHalfOpen",
                                    "Probe already in flight",
                                    Some(wait_ms),
                                );
                                break;
                            }
                        }
                        drop(guard);
                    }
                }
            }

            let mut builder = http_client
                .post(&url)
                .json(&request_body)
                .header("X-Request-Id", &rid_for_task)
                .header("Idempotency-Key", &rid_for_task)
                .header("User-Agent", user_agent.as_str());

            // Inject provider headers when a provider is specified; otherwise use Ollama Cloud headers when enabled.
            if let Some(p) = provider_lower.as_deref() {
                if p == "ollama" {
                    if use_cloud {
                        if let Ok(headers) = build_provider_headers("ollama").await {
                            for (k, v) in headers.into_iter() {
                                builder = builder.header(k, v);
                            }
                        }
                    }
                } else {
                    match build_provider_headers(p).await {
                        Ok(headers) => {
                            for (k, v) in headers.into_iter() {
                                builder = builder.header(k, v);
                            }
                        }
                        Err(e) => {
                            match e {
                                crate::keystore::KeystoreError::Permission(msg) => {
                                    // Stable, structured denial for host policy
                                    emit_problem_detail(
                                        &app_handle,
                                        &rid_for_task,
                                        403,
                                        "PolicyDenied",
                                        &msg,
                                        None,
                                    );
                                }
                                other => {
                                    emit_problem_detail(
                                        &app_handle,
                                        &rid_for_task,
                                        401,
                                        "E-UICP-SEC-LOCKED",
                                        &format!("provider headers unavailable: {}", other),
                                        None,
                                    );
                                }
                            }
                            break;
                        }
                    }
                }
            } else if use_cloud {
                if let Ok(headers) = build_provider_headers("ollama").await {
                    for (k, v) in headers.into_iter() {
                        builder = builder.header(k, v);
                    }
                }
            }

            if stream_flag_for_task {
                builder = builder.header("Accept", "text/event-stream");
            }

            let resp_res = timeout(handshake_timeout, builder.send()).await;

            let resp = match resp_res {
                Err(_) => {
                    if debug_on {
                        let ev = serde_json::json!({
                            "ts": Utc::now().timestamp_millis(),
                            "event": "request_timeout",
                            "requestId": rid_for_task,
                            "elapsedMs": u64::try_from(handshake_timeout.as_millis()).unwrap_or(u64::MAX),
                        });
                        tokio::spawn(append_trace(ev.clone()));
                        tokio::spawn(emit_debug(ev));
                    }
                    if let Some(host) = host_for_attempt.as_deref() {
                        circuit::circuit_record_failure(
                            &circuit_breakers,
                            host,
                            &circuit_config,
                            emit_circuit_telemetry,
                        )
                        .await;
                        if half_open_probe {
                            let mut guard = circuit_breakers.write().await;
                            if let Some(state) = guard.get_mut(host) {
                                state.half_open_probe_in_flight = false;
                            }
                        }
                    }
                    // Use retry engine for category-specific backoff
                    let provider_name = adapter.provider_name();
                    if let Some(delay) = provider_circuit_manager.retry_engine().should_retry(
                        provider_name,
                        None,  // No HTTP status for timeout
                        true,  // is_timeout
                        false, // is_connect
                        attempt_local,
                    ) {
                        emit_circuit_telemetry(
                            "retry_attempt",
                            serde_json::json!({
                                "provider": provider_name,
                                "category": "timeout",
                                "attempt": attempt_local,
                                "delayMs": delay.as_millis(),
                                "requestId": rid_for_task,
                            }),
                        );
                        tokio::time::sleep(delay).await;
                        continue 'outer;
                    }
                    emit_problem_detail(
                        &app_handle,
                        &rid_for_task,
                        408,
                        "RequestTimeout",
                        "Upstream handshake timed out",
                        None,
                    );
                    break;
                }
                Ok(res) => res,
            };

            match resp {
                Err(err) => {
                    if debug_on {
                        let ev = serde_json::json!({
                            "ts": Utc::now().timestamp_millis(),
                            "event": "request_error",
                            "requestId": rid_for_task,
                            "kind": "transport",
                            "error": err.to_string(),
                        });
                        tokio::spawn(append_trace(ev.clone()));
                        tokio::spawn(emit_debug(ev));
                    }
                    if let Some(host) = host_for_attempt.as_deref() {
                        let provider_name = adapter.provider_name();
                        provider_circuit_manager
                            .record_failure(provider_name, host, emit_circuit_telemetry)
                            .await;
                    }
                    // Use retry engine for category-specific backoff
                    let provider_name = adapter.provider_name();
                    let is_timeout = err.is_timeout();
                    let is_connect = err.is_connect();
                    if let Some(delay) = provider_circuit_manager.retry_engine().should_retry(
                        provider_name,
                        None, // No HTTP status for transport errors
                        is_timeout,
                        is_connect,
                        attempt_local,
                    ) {
                        let category = if is_timeout {
                            "timeout"
                        } else if is_connect {
                            "network"
                        } else {
                            "transport"
                        };
                        emit_circuit_telemetry(
                            "retry_attempt",
                            serde_json::json!({
                                "provider": provider_name,
                                "category": category,
                                "attempt": attempt_local,
                                "delayMs": delay.as_millis(),
                                "requestId": rid_for_task,
                            }),
                        );
                        tokio::time::sleep(delay).await;
                        continue 'outer;
                    }
                    emit_problem_detail(
                        &app_handle,
                        &rid_for_task,
                        503,
                        "TransportError",
                        &err.to_string(),
                        None,
                    );
                    break;
                }
                Ok(resp) => {
                    let status = resp.status();
                    if debug_on {
                        let ev = serde_json::json!({
                            "ts": Utc::now().timestamp_millis(),
                            "event": "response_status",
                            "requestId": rid_for_task,
                            "status": status.as_u16(),
                        });
                        tokio::spawn(append_trace(ev.clone()));
                        tokio::spawn(emit_debug(ev));
                    }
                    if !status.is_success() {
                        let retry_after_ms = resp
                            .headers()
                            .get("retry-after")
                            .and_then(|h| h.to_str().ok())
                            .and_then(|raw| raw.parse::<u64>().ok())
                            .map(|secs| secs.saturating_mul(1_000));

                        if let Some(host) = host_for_attempt.as_deref() {
                            let provider_name = adapter.provider_name();
                            provider_circuit_manager
                                .record_failure(provider_name, host, emit_circuit_telemetry)
                                .await;
                            if debug_on {
                                let ev = serde_json::json!({
                                    "ts": Utc::now().timestamp_millis(),
                                    "event": "response_failure",
                                    "requestId": rid_for_task,
                                    "status": status.as_u16(),
                                    "host": host,
                                    "retryMs": retry_after_ms,
                                });
                                tokio::spawn(append_trace(ev.clone()));
                                tokio::spawn(emit_debug(ev));
                            }
                        }

                        if !use_cloud && status.as_u16() == 404 && !local_path_fallback {
                            if debug_on {
                                let ev = serde_json::json!({
                                    "ts": Utc::now().timestamp_millis(),
                                    "event": "retry_path_api_chat",
                                    "requestId": rid_for_task,
                                });
                                tokio::spawn(append_trace(ev.clone()));
                                tokio::spawn(emit_debug(ev));
                            }
                            local_path_fallback = true;
                            continue 'outer;
                        }

                        // Use retry engine for category-specific backoff
                        let provider_name = adapter.provider_name();
                        let status_code = status.as_u16();
                        if let Some(delay) = provider_circuit_manager.retry_engine().should_retry(
                            provider_name,
                            Some(status_code),
                            false, // is_timeout
                            false, // is_connect
                            attempt_local,
                        ) {
                            // Respect Retry-After header for rate limits
                            let final_delay = if status_code == 429 {
                                if let Some(ms) = retry_after_ms {
                                    let delay_ms =
                                        u64::try_from(delay.as_millis()).unwrap_or(u64::MAX);
                                    Duration::from_millis(ms.max(delay_ms))
                                } else {
                                    delay
                                }
                            } else {
                                delay
                            };

                            let category = match status_code {
                                429 => "rate_limit",
                                503 => "transport",
                                _ => "transport",
                            };

                            emit_circuit_telemetry(
                                "retry_attempt",
                                serde_json::json!({
                                    "provider": provider_name,
                                    "category": category,
                                    "attempt": attempt_local,
                                    "delayMs": final_delay.as_millis(),
                                    "httpStatus": status_code,
                                    "requestId": rid_for_task,
                                }),
                            );
                            if debug_on {
                                let ev = serde_json::json!({
                                    "ts": Utc::now().timestamp_millis(),
                                    "event": "retry_backoff",
                                    "requestId": rid_for_task,
                                    "waitMs": final_delay.as_millis(),
                                    "category": category,
                                });
                                tokio::spawn(append_trace(ev.clone()));
                                tokio::spawn(emit_debug(ev));
                            }
                            tokio::time::sleep(final_delay).await;
                            continue 'outer;
                        }

                        if use_cloud && !fallback_tried {
                            if let Some(orig_model) = request_body
                                .get("model")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                            {
                                match std::env::var("FALLBACK_CLOUD_MODEL") {
                                    Ok(fallback_model)
                                        if !fallback_model.is_empty()
                                            && fallback_model != orig_model =>
                                    {
                                        if debug_on {
                                            let ev = serde_json::json!({
                                                "ts": Utc::now().timestamp_millis(),
                                                "event": "retry_with_fallback_model",
                                                "requestId": rid_for_task,
                                                "from": orig_model,
                                                "to": fallback_model,
                                            });
                                            tokio::spawn(append_trace(ev.clone()));
                                            tokio::spawn(emit_debug(ev));
                                        }
                                        request_body["model"] = serde_json::json!(fallback_model);
                                        fallback_tried = true;
                                        continue 'outer;
                                    }
                                    Err(_) if debug_on => {
                                        let ev = serde_json::json!({
                                            "ts": Utc::now().timestamp_millis(),
                                            "event": "no_fallback_configured",
                                            "requestId": rid_for_task,
                                            "from": orig_model,
                                        });
                                        tokio::spawn(append_trace(ev.clone()));
                                        tokio::spawn(emit_debug(ev));
                                    }
                                    _ => {}
                                }
                            }
                        }

                        let detail = match resp.text().await {
                            Ok(text) if !text.is_empty() => text,
                            _ => status
                                .canonical_reason()
                                .unwrap_or("Upstream failure")
                                .to_string(),
                        };
                        emit_problem_detail(
                            &app_handle,
                            &rid_for_task,
                            status.as_u16(),
                            "UpstreamFailure",
                            &detail,
                            retry_after_ms,
                        );
                        break;
                    }

                    let mut stream = resp.bytes_stream();
                    let mut stream_failed = false;
                    // SSE assembly state
                    let mut carry = String::new();
                    let mut event_buf = String::new();

                    const DEBUG_PREVIEW_CHARS: usize = 512;
                    let preview_payload = |input: &str| -> (String, bool) {
                        let mut iter = input.chars();
                        let mut out = String::new();
                        for _ in 0..DEBUG_PREVIEW_CHARS {
                            match iter.next() {
                                Some(ch) => out.push(ch),
                                None => return (out, false),
                            }
                        }
                        if iter.next().is_some() {
                            out.push_str("...");
                            (out, true)
                        } else {
                            (out, false)
                        }
                    };

                    // Feature flag: also emit normalized StreamEvent v1 alongside legacy events
                    let is_stream_v1_on = is_stream_v1_enabled();

                    // Helper to process a complete SSE payload line (assembled in event_buf)
                    let process_payload = |payload_str: &str,
                                           app_handle: &tauri::AppHandle,
                                           rid: &str| {
                        if payload_str == "[DONE]" {
                            if debug_on {
                                let ev = serde_json::json!({
                                    "ts": Utc::now().timestamp_millis(),
                                    "event": "stream_done",
                                    "requestId": rid,
                                });
                                tokio::spawn(append_trace(ev.clone()));
                                tokio::spawn(emit_debug(ev));
                            }
                            emit_or_log(
                                app_handle,
                                "ollama-completion",
                                serde_json::json!({ "done": true }),
                            );
                            if is_stream_v1_on {
                                let done_evt = serde_json::json!({ "type": "done" });
                                emit_or_log(
                                    app_handle,
                                    crate::events::EVENT_STREAM_V1,
                                    serde_json::json!({ "requestId": rid, "event": done_evt }),
                                );
                            }
                            return;
                        }
                        match serde_json::from_str::<serde_json::Value>(payload_str) {
                            Ok(val) => {
                                let adapter =
                                    create_adapter(provider_lower.as_deref().unwrap_or("ollama"));
                                let normalized = adapter.normalize_stream_event(&val);
                                let payload_ref = normalized.as_ref().unwrap_or(&val);
                                if payload_ref
                                    .get("done")
                                    .and_then(serde_json::Value::as_bool)
                                    .unwrap_or(false)
                                {
                                    if debug_on {
                                        let ev = serde_json::json!({
                                            "ts": Utc::now().timestamp_millis(),
                                            "event": "delta_done",
                                            "requestId": rid,
                                        });
                                        tokio::spawn(append_trace(ev.clone()));
                                        tokio::spawn(emit_debug(ev));
                                    }
                                    emit_or_log(
                                        app_handle,
                                        "ollama-completion",
                                        serde_json::json!({ "done": true }),
                                    );
                                    if is_stream_v1_on {
                                        let done_evt = serde_json::json!({ "type": "done" });
                                        emit_or_log(
                                            app_handle,
                                            crate::events::EVENT_STREAM_V1,
                                            serde_json::json!({ "requestId": rid, "event": done_evt }),
                                        );
                                    }
                                    return;
                                }
                                if debug_on {
                                    let (preview, truncated) = preview_payload(payload_str);
                                    let ev = serde_json::json!({
                                        "ts": Utc::now().timestamp_millis(),
                                        "event": "delta_json",
                                        "requestId": rid,
                                        "len": payload_str.len(),
                                        "payload": payload_ref.clone(),
                                        "preview": preview,
                                        "truncated": truncated,
                                    });
                                    tokio::spawn(append_trace(ev.clone()));
                                    tokio::spawn(emit_debug(ev));
                                }
                                emit_or_log(
                                    app_handle,
                                    "ollama-completion",
                                    serde_json::json!({ "done": false, "delta": payload_ref, "kind": "json" }),
                                );
                                if is_stream_v1_on {
                                    for evt in extract_events_from_chunk(payload_ref, Some("json"))
                                    {
                                        if debug_on {
                                            let evt_dbg = serde_json::json!({
                                                "ts": Utc::now().timestamp_millis(),
                                                "event": "normalized_event",
                                                "requestId": rid,
                                                "payload": evt.clone(),
                                            });
                                            tokio::spawn(append_trace(evt_dbg.clone()));
                                        }
                                        emit_or_log(
                                            app_handle,
                                            crate::events::EVENT_STREAM_V1,
                                            serde_json::json!({ "requestId": rid, "event": evt }),
                                        );
                                    }
                                }
                            }
                            Err(_) => {
                                if debug_on {
                                    let (preview, truncated) = preview_payload(payload_str);
                                    let ev = serde_json::json!({
                                        "ts": Utc::now().timestamp_millis(),
                                        "event": "delta_text",
                                        "requestId": rid,
                                        "len": payload_str.len(),
                                        "text": preview,
                                        "truncated": truncated,
                                    });
                                    tokio::spawn(append_trace(ev.clone()));
                                    tokio::spawn(emit_debug(ev));
                                }
                                emit_or_log(
                                    app_handle,
                                    "ollama-completion",
                                    serde_json::json!({ "done": false, "delta": payload_str, "kind": "text" }),
                                );
                                if is_stream_v1_on {
                                    let text = payload_str.to_string();
                                    if !text.trim().is_empty() {
                                        let evt = serde_json::json!({
                                            "type": "content",
                                            "channel": "text",
                                            "text": text,
                                        });
                                        if debug_on {
                                            let evt_dbg = serde_json::json!({
                                                "ts": Utc::now().timestamp_millis(),
                                                "event": "normalized_event",
                                                "requestId": rid,
                                                "payload": evt.clone(),
                                            });
                                            tokio::spawn(append_trace(evt_dbg.clone()));
                                        }
                                        emit_or_log(
                                            app_handle,
                                            crate::events::EVENT_STREAM_V1,
                                            serde_json::json!({ "requestId": rid, "event": evt }),
                                        );
                                    }
                                }
                            }
                        }
                    };

                    loop {
                        let next = tokio::time::timeout(idle_timeout, stream.next()).await;
                        match next {
                            Err(_) => {
                                stream_failed = true;
                                if debug_on {
                                    let ev = serde_json::json!({
                                        "ts": Utc::now().timestamp_millis(),
                                        "event": "stream_idle_timeout",
                                        "requestId": rid_for_task,
                                        "idleMs": u64::try_from(idle_timeout.as_millis()).unwrap_or(u64::MAX),
                                    });
                                    tokio::spawn(append_trace(ev.clone()));
                                    tokio::spawn(emit_debug(ev));
                                }
                                emit_problem_detail(
                                    &app_handle,
                                    &rid_for_task,
                                    408,
                                    "RequestTimeout",
                                    "Streaming idle timeout",
                                    None,
                                );
                                break;
                            }
                            Ok(None) => {
                                // Stream ended gracefully
                                if debug_on {
                                    let ev = serde_json::json!({
                                        "ts": Utc::now().timestamp_millis(),
                                        "event": "stream_eof",
                                        "requestId": rid_for_task,
                                    });
                                    tokio::spawn(append_trace(ev.clone()));
                                    tokio::spawn(emit_debug(ev));
                                }
                                // Process any trailing payload still buffered
                                if !event_buf.trim().is_empty() {
                                    process_payload(&event_buf, &app_handle, &rid_for_task);
                                    event_buf.clear();
                                }
                                emit_or_log(
                                    &app_handle,
                                    "ollama-completion",
                                    serde_json::json!({ "done": true }),
                                );
                                if is_stream_v1_on {
                                    let done_evt = serde_json::json!({ "type": "done" });
                                    emit_or_log(
                                        &app_handle,
                                        crate::events::EVENT_STREAM_V1,
                                        serde_json::json!({ "requestId": &rid_for_task, "event": done_evt }),
                                    );
                                }
                                break;
                            }
                            Ok(Some(chunk)) => match chunk {
                                Err(err) => {
                                    stream_failed = true;
                                    if debug_on {
                                        let ev = serde_json::json!({
                                            "ts": Utc::now().timestamp_millis(),
                                            "event": "stream_error",
                                            "requestId": rid_for_task,
                                            "error": err.to_string(),
                                        });
                                        tokio::spawn(append_trace(ev.clone()));
                                        tokio::spawn(emit_debug(ev));
                                    }
                                    emit_problem_detail(
                                        &app_handle,
                                        &rid_for_task,
                                        502,
                                        "StreamError",
                                        "Streaming response terminated unexpectedly",
                                        None,
                                    );
                                    break;
                                }
                                Ok(bytes) => {
                                    // Append chunk and process complete lines only; keep remainder in carry.
                                    carry.push_str(&String::from_utf8_lossy(&bytes));
                                    while let Some(idx) = carry.find('\n') {
                                        let mut line = carry[..idx].to_string();
                                        // drain including newline
                                        carry.drain(..=idx);
                                        // handle CRLF
                                        if line.ends_with('\r') {
                                            line.pop();
                                        }
                                        let trimmed = line.trim();
                                        if trimmed.is_empty() {
                                            // blank line terminates one SSE event
                                            if !event_buf.is_empty() {
                                                let payload = std::mem::take(&mut event_buf);
                                                process_payload(
                                                    &payload,
                                                    &app_handle,
                                                    &rid_for_task,
                                                );
                                            }
                                            continue;
                                        }
                                        if let Some(stripped) = trimmed.strip_prefix("data:") {
                                            let content = stripped.trim();
                                            if content == "[DONE]" {
                                                process_payload(
                                                    "[DONE]",
                                                    &app_handle,
                                                    &rid_for_task,
                                                );
                                                // reset event buffer
                                                event_buf.clear();
                                                continue;
                                            }
                                            if !event_buf.is_empty() {
                                                event_buf.push('\n');
                                            }
                                            event_buf.push_str(content);
                                            continue;
                                        }
                                        // Fallback: treat line as payload content (non-SSE providers)
                                        event_buf.push_str(trimmed);
                                    }
                                }
                            },
                        }
                    }

                    if stream_failed {
                        if let Some(host) = host_for_attempt.as_deref() {
                            circuit::circuit_record_failure(
                                &circuit_breakers,
                                host,
                                &circuit_config,
                                emit_circuit_telemetry,
                            )
                            .await;
                        }
                        break;
                    }

                    if let Some(host) = host_for_attempt.as_deref() {
                        let provider_name = adapter.provider_name();
                        provider_circuit_manager
                            .record_success(provider_name, host, emit_circuit_telemetry)
                            .await;
                        if half_open_probe {
                            let mut guard = circuit_breakers.write().await;
                            if let Some(state) = guard.get_mut(host) {
                                state.half_open_probe_in_flight = false;
                            }
                        }
                    }

                    if debug_on {
                        let ev = serde_json::json!({
                            "ts": Utc::now().timestamp_millis(),
                            "event": "completed",
                            "requestId": rid_for_task,
                        });
                        tokio::spawn(append_trace(ev.clone()));
                        tokio::spawn(emit_debug(ev));
                    }
                    emit_or_log(
                        &app_handle,
                        "ollama-completion",
                        serde_json::json!({ "done": true }),
                    );
                    break;
                }
            }
        }

        // Ensure we always cleanup the request handle on any terminal exit of the outer loop.
        remove_chat_request(&app_handle, &rid_for_task).await;
    });

    state.ongoing.write().await.insert(rid.clone(), join);
    Ok(())
}

#[tauri::command]
pub async fn cancel_chat(state: State<'_, AppState>, request_id: String) -> Result<(), String> {
    if let Some(handle) = state.ongoing.write().await.remove(&request_id) {
        handle.abort();
    }
    Ok(())
}

// Helper to get the appropriate Ollama base URL with validation
async fn get_ollama_base_url(state: &AppState) -> Result<String, String> {
    let use_cloud = *state.use_direct_cloud.read().await;
    let base = if use_cloud {
        std::env::var("OLLAMA_CLOUD_URL").unwrap_or_else(|_| "https://ollama.ai".into())
    } else {
        std::env::var("OLLAMA_BASE_URL").unwrap_or_else(|_| "http://127.0.0.1:11434".into())
    };
    Ok(base)
}

// Helper to remove an ongoing chat request
async fn remove_chat_request(app: &tauri::AppHandle, request_id: &str) {
    let state: State<'_, AppState> = app.state();
    state.ongoing.write().await.remove(request_id);
    let _ = app.emit(
        "chat-cancelled",
        serde_json::json!({ "requestId": request_id }),
    );
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_converts_hyphenated_form() {
        assert_eq!(normalize_model_name("llama3-70b", true), "llama3:70b");
    }

    #[test]
    fn cloud_keeps_colon_tags() {
        assert_eq!(normalize_model_name("llama3:70b", true), "llama3:70b");
    }

    #[test]
    fn cloud_strips_trailing_cloud_suffix() {
        assert_eq!(normalize_model_name("llama3:70b-cloud", true), "llama3:70b");
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
    fn local_appends_cloud_suffix_when_present() {
        assert_eq!(
            normalize_model_name("llama3:70b-cloud", false),
            "llama3:70b-cloud"
        );
    }

    #[test]
    fn default_channel_is_injected_for_json() {
        use crate::events::extract_events_from_chunk;
        let chunk = serde_json::json!({
            "type": "content",
            "text": "Hello"
        });
        let events = extract_events_from_chunk(&chunk, Some("json"));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["channel"], "json");
    }

    #[test]
    fn anthropic_text_delta_normalizes_to_content() {
        use crate::events::extract_events_from_chunk;
        let chunk = serde_json::json!({
            "type": "text_delta",
            "delta": {
                "type": "text_delta",
                "text": "Hello"
            }
        });
        let events = extract_events_from_chunk(&chunk, Some("json"));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "content");
        assert_eq!(events[0]["text"], "Hello");
    }

    #[test]
    fn anthropic_tool_use_start_normalizes_to_tool_call() {
        use crate::events::extract_events_from_chunk;
        let chunk = serde_json::json!({
            "type": "content_block_start",
            "content_block": {
                "type": "tool_use",
                "id": "tool_1",
                "name": "test_tool"
            }
        });
        let events = extract_events_from_chunk(&chunk, Some("json"));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "tool_call");
        assert_eq!(events[0]["tool"], "test_tool");
    }

    #[test]
    fn extract_content_from_openai_delta() {
        use crate::events::extract_events_from_chunk;
        let chunk = serde_json::json!({
            "choices": [{
                "delta": {
                    "content": "Hello"
                }
            }]
        });
        let events = extract_events_from_chunk(&chunk, Some("json"));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "content");
        assert_eq!(events[0]["text"], "Hello");
    }

    #[test]
    fn extract_from_message_object_and_root_tool_calls() {
        use crate::events::extract_events_from_chunk;
        let chunk = serde_json::json!({
            "message": {
                "role": "assistant",
                "content": null
            },
            "tool_calls": [{
                "id": "call_1",
                "type": "function",
                "function": {
                    "name": "test",
                    "arguments": "{}"
                }
            }]
        });
        let events = extract_events_from_chunk(&chunk, Some("json"));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "tool_call");
        assert_eq!(events[0]["tool"], "test");
    }

    #[test]
    fn extract_tool_call_from_openai_delta() {
        use crate::events::extract_events_from_chunk;
        let chunk = serde_json::json!({
            "choices": [{
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "test",
                            "arguments": "{}"
                        }
                    }]
                }
            }]
        });
        let events = extract_events_from_chunk(&chunk, Some("json"));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "tool_call");
        assert_eq!(events[0]["tool"], "test");
    }

    #[test]
    fn openai_delta_content_injects_json_channel() {
        use crate::events::extract_events_from_chunk;
        let chunk = serde_json::json!({
            "choices": [{
                "delta": {
                    "content": "Hello"
                }
            }]
        });
        let events = extract_events_from_chunk(&chunk, Some("json"));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["channel"], "json");
    }

    #[test]
    fn openrouter_delta_tool_calls_maps_to_tool_call() {
        use crate::events::extract_events_from_chunk;
        let chunk = serde_json::json!({
            "choices": [{
                "delta": {
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "test",
                            "arguments": "{}"
                        }
                    }]
                }
            }]
        });
        let events = extract_events_from_chunk(&chunk, Some("json"));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "tool_call");
        assert_eq!(events[0]["tool"], "test");
    }
}
