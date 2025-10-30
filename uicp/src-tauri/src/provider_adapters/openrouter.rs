//! OpenRouter provider adapter
//!
//! OpenRouter is compatible with OpenAI's API format but includes additional
//! metadata headers and requires special handling for model identifiers.

use crate::provider_adapters::ProviderAdapter;
use async_trait::async_trait;
use serde_json::Value;

pub struct OpenRouterAdapter;

#[async_trait]
impl ProviderAdapter for OpenRouterAdapter {
    async fn transform_request(&self, body: Value) -> Result<Value, String> {
        // OpenRouter uses OpenAI-compatible format, no transformation needed
        // Model identifiers are passed through as-is (e.g., "anthropic/claude-3-sonnet")
        Ok(body)
    }

    fn endpoint_path(&self) -> &'static str {
        "/chat/completions"
    }

    fn normalize_stream_event(&self, _event: &Value) -> Option<Value> {
        // OpenRouter events are OpenAI-compatible
        None
    }

    fn provider_name(&self) -> &'static str {
        "openrouter"
    }
}
