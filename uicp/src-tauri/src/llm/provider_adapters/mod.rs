//! Provider adapter modules for different LLM providers
//!
//! Each adapter handles provider-specific request/response transformations,
//! ensuring the chat_completion function remains provider-agnostic.

pub mod anthropic;
pub mod ollama;
pub mod openai;
pub mod openrouter;

#[cfg(any(test, feature = "compute_harness"))]
mod contract_tests;

pub use anthropic::AnthropicAdapter;
pub use ollama::OllamaAdapter;
pub use openai::OpenAIAdapter;
pub use openrouter::OpenRouterAdapter;

use async_trait::async_trait;
use serde_json::Value;

/// Common trait for all provider adapters
#[async_trait]
pub trait ProviderAdapter {
    /// Transform the request body for this provider
    async fn transform_request(&self, body: Value) -> Result<Value, String>;

    /// Get the endpoint path for this provider
    fn endpoint_path(&self) -> &'static str;

    /// Resolve the absolute endpoint URL using the given base URL.
    /// Default implementation appends `endpoint_path()` to `base_url`.
    fn resolve_endpoint(&self, base_url: &str, _use_cloud: bool) -> String {
        let base = base_url.trim_end_matches('/');
        format!("{}{}", base, self.endpoint_path())
    }

    /// Normalize a stream event from this provider
    fn normalize_stream_event(&self, event: &Value) -> Option<Value>;

    /// Get the provider name
    fn provider_name(&self) -> &'static str;
}

/// Factory function to create the appropriate adapter
pub fn create_adapter(provider: &str) -> Box<dyn ProviderAdapter + Send + Sync> {
    match provider.to_ascii_lowercase().as_str() {
        "openai" => Box::new(OpenAIAdapter),
        "openrouter" => Box::new(OpenRouterAdapter),
        "anthropic" => Box::new(AnthropicAdapter),
        "ollama" => Box::new(OllamaAdapter),
        _ => Box::new(OllamaAdapter), // Default to Ollama for unknown providers
    }
}
