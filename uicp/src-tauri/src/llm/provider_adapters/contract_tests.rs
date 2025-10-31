//! Contract tests for provider adapters
//!
//! These tests ensure that each provider adapter correctly transforms
//! requests and normalizes responses according to the unified protocol.

#[cfg(test)]
mod tests {
    use crate::llm::provider_adapters::create_adapter;
    use serde_json::json;

    #[tokio::test]
    async fn test_openai_adapter_contract() {
        let adapter = create_adapter("openai");

        // Test request transformation (should be identity for OpenAI)
        let request = json!({
            "model": "gpt-4",
            "messages": [{"role": "user", "content": "Hello"}],
            "stream": true
        });

        let transformed = adapter.transform_request(request.clone()).await.unwrap();
        assert_eq!(transformed, request);

        // Test endpoint path
        assert_eq!(adapter.endpoint_path(), "/chat/completions");

        // Test provider name
        assert_eq!(adapter.provider_name(), "openai");

        // Test stream event normalization (should be None for OpenAI)
        let event = json!({"choices": [{"delta": {"content": "Hello"}}]});
        assert_eq!(adapter.normalize_stream_event(&event), None);
    }

    #[tokio::test]
    async fn test_openrouter_adapter_contract() {
        let adapter = create_adapter("openrouter");

        // Test request transformation (should be identity for OpenRouter)
        let request = json!({
            "model": "anthropic/claude-3-sonnet",
            "messages": [{"role": "user", "content": "Hello"}],
            "stream": true
        });

        let transformed = adapter.transform_request(request.clone()).await.unwrap();
        assert_eq!(transformed, request);

        // Test endpoint path
        assert_eq!(adapter.endpoint_path(), "/chat/completions");

        // Test provider name
        assert_eq!(adapter.provider_name(), "openrouter");

        // Test stream event normalization (should be None for OpenRouter)
        let event = json!({"choices": [{"delta": {"content": "Hello"}}]});
        assert_eq!(adapter.normalize_stream_event(&event), None);
    }

    #[tokio::test]
    async fn test_anthropic_adapter_contract() {
        let adapter = create_adapter("anthropic");

        // Test request transformation (should extract system messages)
        let request = json!({
            "model": "claude-3-sonnet-20240229",
            "messages": [
                {"role": "system", "content": "You are helpful"},
                {"role": "user", "content": "Hello"}
            ],
            "stream": true,
            "response_format": {"type": "json_object"} // Should be removed
        });

        let transformed = adapter.transform_request(request).await.unwrap();

        // System message should be moved to top-level
        assert!(transformed.get("system").is_some());
        assert_eq!(transformed["system"], "You are helpful");

        // Messages should no longer contain system message
        let messages = transformed["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["role"], "user");

        // response_format should be removed
        assert!(transformed.get("response_format").is_none());

        // max_tokens should be added if not present
        assert!(transformed.get("max_tokens").is_some());

        // Test endpoint path
        assert_eq!(adapter.endpoint_path(), "/v1/messages");

        // Test provider name
        assert_eq!(adapter.provider_name(), "anthropic");
    }

    #[tokio::test]
    async fn test_ollama_adapter_contract() {
        let adapter = create_adapter("ollama");

        // Test request transformation (should be identity for Ollama)
        let request = json!({
            "model": "llama2",
            "messages": [{"role": "user", "content": "Hello"}],
            "stream": true
        });

        let transformed = adapter.transform_request(request.clone()).await.unwrap();
        assert_eq!(transformed, request);

        // Test endpoint path
        assert_eq!(adapter.endpoint_path(), "/api/chat");

        // Test provider name
        assert_eq!(adapter.provider_name(), "ollama");

        // Test stream event normalization (should be None for Ollama)
        let event = json!({"message": {"content": "Hello"}});
        assert_eq!(adapter.normalize_stream_event(&event), None);
    }

    #[tokio::test]
    async fn test_anthropic_developer_role_mapping() {
        let adapter = create_adapter("anthropic");

        // Test that developer role is mapped to user (not system)
        let request = json!({
            "model": "claude-3-sonnet-20240229",
            "messages": [
                {"role": "system", "content": "System instruction"},
                {"role": "developer", "content": "Developer instruction"},
                {"role": "user", "content": "Hello"}
            ],
            "stream": true
        });

        let transformed = adapter.transform_request(request).await.unwrap();

        // System message should be moved to top-level
        assert!(transformed.get("system").is_some());
        assert_eq!(transformed["system"], "System instruction");

        // Messages should contain user and developer-mapped-to-user messages
        let messages = transformed["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);

        // First message should be the developer instruction mapped to user
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["content"], "Developer instruction");

        // Second message should be the original user message
        assert_eq!(messages[1]["role"], "user");
        assert_eq!(messages[1]["content"], "Hello");
    }

    #[tokio::test]
    async fn test_anthropic_tool_result_mapping() {
        let adapter = create_adapter("anthropic");

        // Test that tool_call_id is mapped to tool_use_id
        let request = json!({
            "model": "claude-3-sonnet-20240229",
            "messages": [
                {"role": "user", "content": "Hello"},
                {"role": "tool", "tool_call_id": "call_123", "content": "Result"}
            ],
            "stream": true
        });

        let transformed = adapter.transform_request(request).await.unwrap();

        // Find the tool result message
        let messages = transformed["messages"].as_array().unwrap();
        let tool_message = messages.iter().find(|m| m["role"] == "tool").unwrap();

        // tool_call_id should be mapped to tool_use_id
        assert!(tool_message.get("tool_use_id").is_some());
        assert!(tool_message.get("tool_call_id").is_none());
        assert_eq!(tool_message["tool_use_id"], "call_123");
    }

    #[test]
    fn test_adapter_factory() {
        // Test that factory returns correct adapters
        let openai = create_adapter("openai");
        assert_eq!(openai.provider_name(), "openai");

        let openrouter = create_adapter("openrouter");
        assert_eq!(openrouter.provider_name(), "openrouter");

        let anthropic = create_adapter("anthropic");
        assert_eq!(anthropic.provider_name(), "anthropic");

        let ollama = create_adapter("ollama");
        assert_eq!(ollama.provider_name(), "ollama");

        // Test that unknown provider defaults to Ollama
        let unknown = create_adapter("unknown_provider");
        assert_eq!(unknown.provider_name(), "ollama");
    }
}
