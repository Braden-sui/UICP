//! Anthropic provider adapter
//!
//! Anthropic's Messages API uses a different schema than OpenAI:
//! - system: top-level field (not a message with role="system")
//! - messages: only user/assistant/tool roles (no developer role)
//! - no response_format, format, or stream fields in body
//! - max_tokens: required field
//! - tool_call_id -> tool_use_id for tool result messages

use crate::anthropic::normalize_message;
use crate::provider_adapters::ProviderAdapter;
use async_trait::async_trait;
use serde_json::Value;

pub struct AnthropicAdapter;

#[async_trait]
impl ProviderAdapter for AnthropicAdapter {
    async fn transform_request(&self, body: Value) -> Result<Value, String> {
        let mut anthropic_body = serde_json::json!({});

        // Copy model as-is
        if let Some(model) = body.get("model") {
            anthropic_body["model"] = model.clone();
        }

        // Extract system message from messages array and set as top-level field
        let messages = body
            .get("messages")
            .and_then(|m| m.as_array())
            .ok_or_else(|| "messages must be an array".to_string())?;

        let mut system_content = String::new();
        let mut filtered_messages = Vec::new();

        for msg in messages {
            let msg_obj = msg
                .as_object()
                .ok_or_else(|| "each message must be an object".to_string())?;
            let role = msg_obj
                .get("role")
                .and_then(|r| r.as_str())
                .ok_or_else(|| "message must have a role".to_string())?;

            // WHY: Anthropic doesn't support role="developer"; map it to user
            let normalized_role = match role {
                "developer" => "user",
                "system" => {
                    // Collect system content; we'll set it as top-level field
                    if let Some(content) = msg_obj.get("content") {
                        if let Some(text) = content.as_str() {
                            if !system_content.is_empty() {
                                system_content.push('\n');
                            }
                            system_content.push_str(text);
                        }
                    }
                    continue; // Skip this message; it's now in system field
                }
                other => other,
            };

            // Build Anthropic-compatible message
            let mut anthropic_msg = serde_json::json!({
                "role": normalized_role,
            });

            // Copy content as-is (Anthropic accepts string or array of content blocks)
            if let Some(content) = msg_obj.get("content") {
                anthropic_msg["content"] = content.clone();
            }

            // Copy tool_call_id if present (for tool result messages)
            if let Some(tool_call_id) = msg_obj.get("tool_call_id") {
                anthropic_msg["tool_use_id"] = tool_call_id.clone();
            }

            filtered_messages.push(anthropic_msg);
        }

        anthropic_body["messages"] = serde_json::json!(filtered_messages);

        // Set system field if we collected any system messages
        if !system_content.is_empty() {
            anthropic_body["system"] = serde_json::json!(system_content);
        }

        // Set max_tokens (required by Anthropic; default to 4096 if not provided)
        let max_tokens = body
            .get("max_tokens")
            .or_else(|| body.get("options").and_then(|o| o.get("max_tokens")))
            .and_then(|m| m.as_i64())
            .unwrap_or(200000);
        anthropic_body["max_tokens"] = serde_json::json!(max_tokens);

        // Copy tools if present (Anthropic supports tool_use)
        if let Some(tools) = body.get("tools") {
            anthropic_body["tools"] = tools.clone();
        }

        // Copy tool_choice if present
        if let Some(tool_choice) = body.get("tool_choice") {
            anthropic_body["tool_choice"] = tool_choice.clone();
        }

        // Anthropic doesn't support response_format, format, or stream in the body
        // (stream is handled at HTTP level, not in body)

        Ok(anthropic_body)
    }

    fn endpoint_path(&self) -> &'static str {
        "/v1/messages"
    }

    fn normalize_stream_event(&self, event: &Value) -> Option<Value> {
        // Use the existing anthropic normalizer
        normalize_message(event.clone())
    }

    fn provider_name(&self) -> &'static str {
        "anthropic"
    }
}
