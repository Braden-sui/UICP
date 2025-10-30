//! Provider-aware circuit breaker management
//!
//! Extends the circuit breaker system to be provider-specific with operator controls.

use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::{
    circuit::{
        circuit_is_open, circuit_record_failure, circuit_record_success, get_circuit_debug_info,
    },
    core::{CircuitBreakerConfig, CircuitState},
    resilience::RetryEngine,
};

/// Provider circuit manager with per-provider isolation
#[derive(Clone)]
pub struct ProviderCircuitManager {
    /// Circuit breakers indexed by provider:host
    circuits: Arc<RwLock<HashMap<String, CircuitState>>>,
    /// Retry engine for provider-specific policies
    retry_engine: RetryEngine,
    /// Provider configurations
    provider_configs: HashMap<String, CircuitBreakerConfig>,
    /// Default configuration fallback
    default_config: CircuitBreakerConfig,
}

/// Circuit control commands for operators
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum CircuitControlCommand {
    /// Reset circuit to closed state
    Reset { provider: String, host: String },
    /// Force circuit open for testing
    ForceOpen {
        provider: String,
        host: String,
        duration_ms: u64,
    },
    /// Force circuit closed
    ForceClose { provider: String, host: String },
}

/// Provider circuit debug information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderCircuitDebugInfo {
    /// Provider name
    pub provider: String,
    /// Host
    pub host: String,
    /// Circuit key (provider:host)
    pub circuit_key: String,
    /// Circuit state details
    pub circuit: crate::circuit::CircuitDebugInfo,
}

impl ProviderCircuitManager {
    /// Create new provider circuit manager
    pub fn new() -> Self {
        let mut provider_configs = HashMap::new();
        let retry_engine = RetryEngine::new();
        let default_config = CircuitBreakerConfig::default();

        // Load provider-specific circuit configurations
        for provider in ["openai", "openrouter", "anthropic", "ollama"] {
            if let Some(config) = retry_engine.get_circuit_config(provider) {
                provider_configs.insert(provider.to_string(), config.clone());
            }
        }

        Self {
            circuits: Arc::new(RwLock::new(HashMap::new())),
            retry_engine,
            provider_configs,
            default_config,
        }
    }

    /// Get circuit key for provider and host
    pub fn get_circuit_key(&self, provider: &str, host: &str) -> String {
        format!("{}:{}", provider, host)
    }

    /// Check if circuit is open for a specific provider and host
    pub async fn is_circuit_open(&self, provider: &str, host: &str) -> Option<Instant> {
        let circuit_key = self.get_circuit_key(provider, host);
        circuit_is_open(&self.circuits, &circuit_key).await
    }

    /// Record successful request for provider circuit
    pub async fn record_success(
        &self,
        provider: &str,
        host: &str,
        emit_telemetry: impl Fn(&str, serde_json::Value),
    ) {
        let circuit_key = self.get_circuit_key(provider, host);
        circuit_record_success(&self.circuits, &circuit_key, emit_telemetry).await;
    }

    /// Record failed request for provider circuit
    pub async fn record_failure(
        &self,
        provider: &str,
        host: &str,
        emit_telemetry: impl Fn(&str, serde_json::Value),
    ) -> Option<Instant> {
        let circuit_key = self.get_circuit_key(provider, host);
        let config = self.get_provider_config(provider);
        circuit_record_failure(&self.circuits, &circuit_key, config, emit_telemetry).await
    }

    /// Get circuit breaker configuration for a provider
    fn get_provider_config(&self, provider: &str) -> &CircuitBreakerConfig {
        self.provider_configs
            .get(provider)
            .unwrap_or(&self.default_config)
    }

    /// Execute circuit control command
    pub async fn execute_control_command(
        &self,
        command: CircuitControlCommand,
        emit_telemetry: impl Fn(&str, serde_json::Value),
    ) -> Result<(), String> {
        match command {
            CircuitControlCommand::Reset { provider, host } => {
                let circuit_key = self.get_circuit_key(&provider, &host);
                let mut guard = self.circuits.write().await;
                if let Some(state) = guard.get_mut(&circuit_key) {
                    state.consecutive_failures = 0;
                    state.opened_until = None;
                    state.half_open = false;
                    state.half_open_probe_in_flight = false;

                    emit_telemetry(
                        "circuit-manual-reset",
                        serde_json::json!({
                            "provider": provider,
                            "host": host,
                            "circuitKey": circuit_key,
                        }),
                    );
                }
                Ok(())
            }
            CircuitControlCommand::ForceOpen {
                provider,
                host,
                duration_ms,
            } => {
                let circuit_key = self.get_circuit_key(&provider, &host);
                let mut guard = self.circuits.write().await;
                let state = guard.entry(circuit_key.clone()).or_default();
                state.consecutive_failures = self.get_provider_config(&provider).max_failures;
                state.opened_until = Some(Instant::now() + Duration::from_millis(duration_ms));
                state.half_open = false;
                state.half_open_probe_in_flight = false;

                emit_telemetry(
                    "circuit-manual-open",
                    serde_json::json!({
                        "provider": provider,
                        "host": host,
                        "circuitKey": circuit_key,
                        "durationMs": duration_ms,
                    }),
                );
                Ok(())
            }
            CircuitControlCommand::ForceClose { provider, host } => {
                let circuit_key = self.get_circuit_key(&provider, &host);
                let mut guard = self.circuits.write().await;
                if let Some(state) = guard.get_mut(&circuit_key) {
                    state.consecutive_failures = 0;
                    state.opened_until = None;
                    state.half_open = false;
                    state.half_open_probe_in_flight = false;

                    emit_telemetry(
                        "circuit-manual-close",
                        serde_json::json!({
                            "provider": provider,
                            "host": host,
                            "circuitKey": circuit_key,
                        }),
                    );
                }
                Ok(())
            }
        }
    }

    /// Get debug information for all provider circuits
    pub async fn get_debug_info(&self) -> Vec<ProviderCircuitDebugInfo> {
        let circuit_info = get_circuit_debug_info(&self.circuits).await;

        circuit_info
            .into_iter()
            .map(|circuit| {
                let mut parts = circuit.host.splitn(2, ':');
                let provider = parts.next().unwrap_or("unknown").to_string();
                let host = parts.next().unwrap_or("unknown").to_string();

                ProviderCircuitDebugInfo {
                    provider,
                    host,
                    circuit_key: circuit.host.clone(),
                    circuit,
                }
            })
            .collect()
    }

    /// Get retry engine reference
    pub fn retry_engine(&self) -> &RetryEngine {
        &self.retry_engine
    }
}

impl Default for ProviderCircuitManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_manager() -> ProviderCircuitManager {
        ProviderCircuitManager::new()
    }

    /// Test fixture: telemetry event collector
    fn create_test_emitter() -> impl Fn(&str, serde_json::Value) + Clone {
        move |_event: &str, _data: serde_json::Value| {}
    }

    #[tokio::test]
    async fn test_provider_circuit_isolation() {
        let manager = create_test_manager();
        let emit = create_test_emitter();

        // Open circuit for openai provider
        let openai_host = "api.openai.com";

        // Simulate failures to open circuit
        for _ in 0..3 {
            manager
                .record_failure("openai", openai_host, emit.clone())
                .await;
        }

        // Check that openai circuit is open
        assert!(manager
            .is_circuit_open("openai", openai_host)
            .await
            .is_some());

        // Check that openrouter circuit is still closed
        assert!(manager
            .is_circuit_open("openrouter", "openrouter.ai")
            .await
            .is_none());
    }

    #[tokio::test]
    async fn test_circuit_control_commands() {
        let manager = create_test_manager();
        let emit = create_test_emitter();

        // Force open circuit
        let cmd = CircuitControlCommand::ForceOpen {
            provider: "test".to_string(),
            host: "test.com".to_string(),
            duration_ms: 5000,
        };
        manager
            .execute_control_command(cmd, emit.clone())
            .await
            .unwrap();

        // Verify circuit is open
        assert!(manager.is_circuit_open("test", "test.com").await.is_some());

        // Force close circuit
        let cmd = CircuitControlCommand::ForceClose {
            provider: "test".to_string(),
            host: "test.com".to_string(),
        };
        manager
            .execute_control_command(cmd, emit.clone())
            .await
            .unwrap();

        // Verify circuit is closed
        assert!(manager.is_circuit_open("test", "test.com").await.is_none());
    }

    #[tokio::test]
    async fn test_debug_info_format() {
        let manager = create_test_manager();
        let emit = create_test_emitter();

        // Record some activity
        manager
            .record_failure("openai", "api.openai.com", emit.clone())
            .await;
        manager
            .record_success("openrouter", "openrouter.ai", emit.clone())
            .await;

        let debug_info = manager.get_debug_info().await;

        // Should have entries for both providers
        assert!(debug_info.len() >= 2);

        // Check format of debug info
        for info in debug_info {
            assert!(!info.provider.is_empty());
            assert!(!info.host.is_empty());
            assert_eq!(info.circuit_key, format!("{}:{}", info.provider, info.host));
        }
    }
}
