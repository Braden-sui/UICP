//! Streaming fixtures for different providers
//!
//! These fixtures represent real streaming responses from each provider
//! and are used for contract testing and validation.

use serde_json::Value;

/// OpenAI streaming fixture - standard SSE format
pub fn openai_streaming_fixture() -> Vec<&'static str> {
    vec![
        r#"data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1699012345,"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}"#,
        r#"data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1699012345,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}"#,
        r#"data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1699012345,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"!"},"finish_reason":null}]}"#,
        r#"data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1699012345,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
        "data: [DONE]",
    ]
}

/// OpenRouter streaming fixture - OpenAI-compatible with metadata
pub fn openrouter_streaming_fixture() -> Vec<&'static str> {
    vec![
        r#"data: {"id":"or-abc123","object":"chat.completion.chunk","created":1699012345,"model":"anthropic/claude-3-sonnet","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}"#,
        r#"data: {"id":"or-abc123","object":"chat.completion.chunk","created":1699012345,"model":"anthropic/claude-3-sonnet","choices":[{"index":0,"delta":{"content":"Hi there"},"finish_reason":null}]}"#,
        r#"data: {"id":"or-abc123","object":"chat.completion.chunk","created":1699012345,"model":"anthropic/claude-3-sonnet","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
        "data: [DONE]",
    ]
}

/// Anthropic streaming fixture - Messages API format
pub fn anthropic_streaming_fixture() -> Vec<&'static str> {
    vec![
        r#"event: message_start
data: {"type":"message_start","message":{"id":"msg-abc123","type":"message","role":"assistant","content":[],"model":"claude-3-sonnet-20240229","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"output_tokens":0}}}"#,
        r#"event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
        r#"event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#,
        r#"event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world!"}}"#,
        r#"event: content_block_stop
data: {"type":"content_block_stop","index":0}"#,
        r#"event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}"#,
        r#"event: message_stop
data: {"type":"message_stop"}"#,
    ]
}

/// Ollama streaming fixture - NDJSON format
pub fn ollama_streaming_fixture() -> Vec<&'static str> {
    vec![
        r#"{"model":"llama2","created_at":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":""},"done":false}"#,
        r#"{"model":"llama2","created_at":"2024-01-01T00:00:01Z","message":{"role":"assistant","content":"Hi"},"done":false}"#,
        r#"{"model":"llama2","created_at":"2024-01-01T00:00:02Z","message":{"role":"assistant","content":" there!"},"done":false}"#,
        r#"{"model":"llama2","created_at":"2024-01-01T00:00:03Z","message":{"role":"assistant","content":""},"done":true,"total_duration":1234567890,"prompt_eval_count":10,"prompt_eval_duration":123456789,"eval_count":5,"eval_duration":987654321}"#,
    ]
}

/// Tool calling fixture for OpenAI
pub fn openai_tool_calling_fixture() -> Vec<&'static str> {
    vec![
        r#"data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1699012345,"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}"#,
        r#"data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1699012345,"model":"gpt-4","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc123","type":"function","function":{"name":"create_window","arguments":"{\"title\":\"Test\"}"}}]},"finish_reason":null}]}"#,
        r#"data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1699012345,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#,
        "data: [DONE]",
    ]
}

/// Error fixture for 401 Unauthorized
pub fn error_401_fixture() -> Value {
    serde_json::json!({
        "error": {
            "message": "Invalid API key",
            "type": "invalid_request_error",
            "code": "invalid_api_key"
        }
    })
}

/// Error fixture for 429 Rate Limited
pub fn error_429_fixture() -> Value {
    serde_json::json!({
        "error": {
            "message": "Rate limit exceeded",
            "type": "rate_limit_error",
            "code": "rate_limit_exceeded"
        }
    })
}

/// Error fixture for 500 Server Error
pub fn error_500_fixture() -> Value {
    serde_json::json!({
        "error": {
            "message": "Internal server error",
            "type": "server_error",
            "code": "internal_error"
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_openai_fixture_parsing() {
        let fixture = openai_streaming_fixture();
        assert!(fixture[0].starts_with("data: {"));
        assert!(fixture[1].contains("\"content\":\"Hello\""));
        assert_eq!(*fixture.last().unwrap(), "data: [DONE]");
    }

    #[test]
    fn test_anthropic_fixture_parsing() {
        let fixture = anthropic_streaming_fixture();
        assert!(fixture[0].starts_with("event: message_start"));
        // The second line may be a data line or another event depending on fixture format; check for expected content
        assert!(fixture[1].starts_with("data:") || fixture[1].starts_with("event:"));
        // The last element may be a combined event+data line or just event; check for stop event
        let last = fixture.last().unwrap();
        assert!(last.starts_with("event: message_stop") || last.contains("event: message_stop"));
    }

    #[test]
    fn test_ollama_fixture_parsing() {
        let fixture = ollama_streaming_fixture();
        assert!(fixture[0].starts_with("{"));
        assert!(fixture[0].contains("\"role\":\"assistant\""));
        assert!(fixture.last().unwrap().contains("\"done\":true"));
    }
}
