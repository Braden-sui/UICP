//! OpenAI provider adapter
//!
//! OpenAI uses the standard chat completions format that serves as the baseline
//! for other providers. Minimal transformation needed.

use crate::provider_adapters::ProviderAdapter;
use async_trait::async_trait;
use serde_json::Value;

pub struct OpenAIAdapter;

#[async_trait]
impl ProviderAdapter for OpenAIAdapter {
    async fn transform_request(&self, body: Value) -> Result<Value, String> {
        // OpenAI uses the standard format, no transformation needed
        Ok(body)
    }

    fn endpoint_path(&self) -> &'static str {
        "/chat/completions"
    }

    fn normalize_stream_event(&self, _event: &Value) -> Option<Value> {
        // OpenAI events are already in the standard format
        None
    }

    fn provider_name(&self) -> &'static str {
        "openai"
    }
}
