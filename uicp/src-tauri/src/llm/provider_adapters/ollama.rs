//! Ollama provider adapter
//!
//! Ollama supports both local and cloud modes with different endpoints:
//! - Cloud: /api/chat (requires plain model IDs without :cloud suffix)
//! - Local: /api/chat (when local_path_fallback=true) or /chat/completions

use super::ProviderAdapter;
use async_trait::async_trait;
use serde_json::Value;

pub struct OllamaAdapter;

#[async_trait]
impl ProviderAdapter for OllamaAdapter {
    async fn transform_request(&self, body: Value) -> Result<Value, String> {
        // Ollama uses OpenAI-compatible format, no transformation needed
        // Model normalization is handled at the router level
        Ok(body)
    }

    fn endpoint_path(&self) -> &'static str {
        // This will be dynamically determined based on cloud/local mode
        // The actual path selection logic remains in the main chat_completion function
        "/api/chat"
    }

    fn normalize_stream_event(&self, _event: &Value) -> Option<Value> {
        // Ollama events are OpenAI-compatible
        None
    }

    fn provider_name(&self) -> &'static str {
        "ollama"
    }
}
