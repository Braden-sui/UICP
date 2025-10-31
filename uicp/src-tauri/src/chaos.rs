//! Chaos engineering framework for synthetic failure injection
//!
//! This module provides controlled failure injection to test resilience
//! metrics and validate system behavior under adverse conditions.

use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::resilience::ErrorCategory;

type TelemetryEmitterFn = dyn Fn(&str, serde_json::Value) + Send + Sync;

/// Configuration for synthetic failure injection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailureConfig {
    /// Percentage of requests to fail (0-100)
    pub failure_rate: f64,
    /// Category of error to inject
    pub category: ErrorCategory,
    /// HTTP status code to return (for HTTP errors)
    pub http_status: Option<u16>,
    /// Whether to inject timeout instead of HTTP error
    pub inject_timeout: bool,
    /// Whether to inject connection failure
    pub inject_connect_failure: bool,
    /// Duration to delay before failing (for latency injection)
    pub delay_ms: Option<u64>,
}

impl Default for FailureConfig {
    fn default() -> Self {
        Self {
            failure_rate: 0.0,
            category: ErrorCategory::Transport,
            http_status: Some(500),
            inject_timeout: false,
            inject_connect_failure: false,
            delay_ms: None,
        }
    }
}

/// Chaos engine for managing failure injection
pub struct ChaosEngine {
    /// Active failure configurations by provider
    failure_configs: Arc<RwLock<HashMap<String, FailureConfig>>>,
    /// Request counters for failure rate calculation
    request_counters: Arc<RwLock<HashMap<String, u64>>>,
    /// Telemetry event emitter
    telemetry_emitter: Option<Arc<TelemetryEmitterFn>>,
}

/// Result of failure injection check
#[derive(Debug, Clone)]
pub enum InjectionResult {
    /// No failure injected
    None,
    /// Inject timeout failure
    Timeout,
    /// Inject connection failure
    ConnectFailure,
    /// Inject HTTP error with status
    HttpError(u16),
    /// Inject delay before proceeding
    Delay(Duration),
}

impl ChaosEngine {
    /// Create new chaos engine
    pub fn new() -> Self {
        Self {
            failure_configs: Arc::new(RwLock::new(HashMap::new())),
            request_counters: Arc::new(RwLock::new(HashMap::new())),
            telemetry_emitter: None,
        }
    }

    /// Set telemetry event emitter
    pub fn set_telemetry_emitter<F>(&mut self, emitter: F)
    where
        F: Fn(&str, serde_json::Value) + Send + Sync + 'static,
    {
        self.telemetry_emitter = Some(Arc::new(emitter));
    }

    /// Emit telemetry event if emitter is configured
    fn emit_telemetry(&self, event_name: &str, payload: serde_json::Value) {
        if let Some(emitter) = &self.telemetry_emitter {
            emitter(event_name, payload);
        }
    }

    /// Configure failure injection for a provider
    pub async fn configure_failure(
        &self,
        provider: String,
        config: FailureConfig,
    ) -> Result<(), String> {
        if config.failure_rate < 0.0 || config.failure_rate > 100.0 {
            return Err("failure_rate must be between 0 and 100".to_string());
        }

        let mut configs = self.failure_configs.write().await;
        configs.insert(provider.clone(), config.clone());

        // Emit telemetry event
        self.emit_telemetry(
            "resilience_failure_injected",
            serde_json::json!({
                "provider": provider,
                "failure_rate": config.failure_rate,
                "category": config.category,
                "http_status": config.http_status,
                "inject_timeout": config.inject_timeout,
                "inject_connect_failure": config.inject_connect_failure,
                "delay_ms": config.delay_ms
            }),
        );

        Ok(())
    }

    /// Stop failure injection for a provider
    pub async fn stop_failure(&self, provider: &str) {
        let mut configs = self.failure_configs.write().await;
        configs.remove(provider);

        // Reset counter
        let mut counters = self.request_counters.write().await;
        counters.remove(provider);

        // Emit telemetry event
        self.emit_telemetry(
            "resilience_failure_stopped",
            serde_json::json!({
                "provider": provider
            }),
        );
    }

    /// Check if failure should be injected for this request
    pub async fn should_inject_failure(&self, provider: &str) -> Result<InjectionResult, String> {
        let configs = self.failure_configs.read().await;
        let config = match configs.get(provider) {
            Some(c) => c,
            None => return Ok(InjectionResult::None),
        };

        // Increment request counter
        {
            let mut counters = self.request_counters.write().await;
            let counter = counters.entry(provider.to_string()).or_insert(0);
            *counter += 1;
        }

        // Check if we should inject failure based on rate
        if config.failure_rate > 0.0 {
            use rand::Rng;
            let mut rng = rand::thread_rng();
            if rng.gen_range(0.0..100.0) < config.failure_rate {
                // Determine what type of failure to inject
                if let Some(delay_ms) = config.delay_ms {
                    return Ok(InjectionResult::Delay(Duration::from_millis(delay_ms)));
                }

                if config.inject_timeout {
                    return Ok(InjectionResult::Timeout);
                }

                if config.inject_connect_failure {
                    return Ok(InjectionResult::ConnectFailure);
                }

                if let Some(status) = config.http_status {
                    return Ok(InjectionResult::HttpError(status));
                }
            }
        }

        Ok(InjectionResult::None)
    }

    /// Get current failure configuration for a provider
    pub async fn get_failure_config(&self, provider: &str) -> Option<FailureConfig> {
        let configs = self.failure_configs.read().await;
        configs.get(provider).cloned()
    }

    /// Get all active failure configurations
    pub async fn get_all_configs(&self) -> HashMap<String, FailureConfig> {
        let configs = self.failure_configs.read().await;
        configs.clone()
    }

    /// Get request statistics for all providers
    pub async fn get_request_stats(&self) -> HashMap<String, u64> {
        let counters = self.request_counters.read().await;
        counters.clone()
    }

    /// Reset all statistics
    pub async fn reset_stats(&self) {
        let mut counters = self.request_counters.write().await;
        counters.clear();
    }
}

impl Default for ChaosEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// Resilience metrics collector
pub struct ResilienceMetrics {
    /// Metrics data
    metrics: Arc<RwLock<ResilienceMetricsData>>,
}

/// Internal metrics data structure
#[derive(Debug, Clone, Default)]
struct ResilienceMetricsData {
    /// Total requests per provider
    total_requests: HashMap<String, u64>,
    /// Successful requests per provider
    successful_requests: HashMap<String, u64>,
    /// Failed requests per provider
    failed_requests: HashMap<String, u64>,
    /// Retry attempts per provider
    retry_attempts: HashMap<String, u64>,
    /// Circuit breaker openings per provider
    circuit_openings: HashMap<String, u64>,
    /// Request latencies (sum for average calculation)
    total_latency_ms: HashMap<String, u64>,
    /// Start time for MTTR calculation
    last_failure_time: HashMap<String, Option<Instant>>,
    /// Recovery time samples
    recovery_times_ms: HashMap<String, Vec<u64>>,
}

impl ResilienceMetrics {
    /// Create new metrics collector
    pub fn new() -> Self {
        Self {
            metrics: Arc::new(RwLock::new(ResilienceMetricsData::default())),
        }
    }

    /// Record a request attempt
    pub async fn record_request(&self, provider: &str) {
        let mut metrics = self.metrics.write().await;
        *metrics
            .total_requests
            .entry(provider.to_string())
            .or_insert(0) += 1;
    }

    /// Record a successful request
    pub async fn record_success(&self, provider: &str, latency_ms: u64) {
        let mut metrics = self.metrics.write().await;
        *metrics
            .successful_requests
            .entry(provider.to_string())
            .or_insert(0) += 1;
        *metrics
            .total_latency_ms
            .entry(provider.to_string())
            .or_insert(0) += latency_ms;

        // Check if we're recovering from a failure
        if let Some(Some(failure_time)) = metrics.last_failure_time.get(provider) {
            let recovery_time =
                u64::try_from(failure_time.elapsed().as_millis()).unwrap_or(u64::MAX);
            metrics
                .recovery_times_ms
                .entry(provider.to_string())
                .or_insert_with(Vec::new)
                .push(recovery_time);
            metrics.last_failure_time.insert(provider.to_string(), None);
        }
    }

    /// Record a failed request
    pub async fn record_failure(&self, provider: &str) {
        let mut metrics = self.metrics.write().await;
        *metrics
            .failed_requests
            .entry(provider.to_string())
            .or_insert(0) += 1;
        metrics
            .last_failure_time
            .insert(provider.to_string(), Some(Instant::now()));
    }

    /// Record a retry attempt
    pub async fn record_retry(&self, provider: &str) {
        let mut metrics = self.metrics.write().await;
        *metrics
            .retry_attempts
            .entry(provider.to_string())
            .or_insert(0) += 1;
    }

    /// Record a circuit breaker opening
    pub async fn record_circuit_open(&self, provider: &str) {
        let mut metrics = self.metrics.write().await;
        *metrics
            .circuit_openings
            .entry(provider.to_string())
            .or_insert(0) += 1;
    }

    /// Get metrics summary for a provider
    pub async fn get_metrics(&self, provider: &str) -> Option<ResilienceMetricsSummary> {
        let metrics = self.metrics.read().await;

        let total = *metrics.total_requests.get(provider)?;
        let successful = *metrics.successful_requests.get(provider).unwrap_or(&0);
        let failed = *metrics.failed_requests.get(provider).unwrap_or(&0);
        let retries = *metrics.retry_attempts.get(provider).unwrap_or(&0);
        let circuit_opens = *metrics.circuit_openings.get(provider).unwrap_or(&0);
        let total_latency = *metrics.total_latency_ms.get(provider).unwrap_or(&0);

        let recovery_times = metrics
            .recovery_times_ms
            .get(provider)
            .cloned()
            .unwrap_or_default();

        Some(ResilienceMetricsSummary {
            provider: provider.to_string(),
            total_requests: total,
            success_rate: if total > 0 {
                successful as f64 / total as f64
            } else {
                0.0
            },
            failure_rate: if total > 0 {
                failed as f64 / total as f64
            } else {
                0.0
            },
            retry_rate: if total > 0 {
                retries as f64 / total as f64
            } else {
                0.0
            },
            average_latency_ms: if total > 0 { total_latency / total } else { 0 },
            mean_time_to_recovery_ms: if recovery_times.is_empty() {
                0
            } else {
                recovery_times.iter().sum::<u64>() / recovery_times.len() as u64
            },
            circuit_openings: circuit_opens,
        })
    }

    /// Reset all metrics
    pub async fn reset(&self) {
        let mut metrics = self.metrics.write().await;
        *metrics = ResilienceMetricsData::default();
    }
}

/// Summary of resilience metrics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResilienceMetricsSummary {
    pub provider: String,
    pub total_requests: u64,
    pub success_rate: f64,
    pub failure_rate: f64,
    pub retry_rate: f64,
    pub average_latency_ms: u64,
    pub mean_time_to_recovery_ms: u64,
    pub circuit_openings: u64,
}

impl Default for ResilienceMetrics {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_chaos_engine_configuration() {
        let engine = ChaosEngine::new();

        let config = FailureConfig {
            failure_rate: 50.0,
            category: ErrorCategory::Transport,
            http_status: Some(500),
            ..Default::default()
        };

        engine
            .configure_failure("test".to_string(), config)
            .await
            .unwrap();

        let retrieved = engine.get_failure_config("test").await.unwrap();
        assert_eq!(retrieved.failure_rate, 50.0);
        assert_eq!(retrieved.http_status, Some(500));
    }

    #[tokio::test]
    async fn test_failure_injection_rate() {
        let engine = ChaosEngine::new();

        // Configure 100% failure rate
        let config = FailureConfig {
            failure_rate: 100.0,
            category: ErrorCategory::Transport,
            http_status: Some(500),
            ..Default::default()
        };
        engine
            .configure_failure("test".to_string(), config)
            .await
            .unwrap();

        // All requests should fail
        for _ in 0..10 {
            let result = engine.should_inject_failure("test").await.unwrap();
            assert!(matches!(result, InjectionResult::HttpError(500)));
        }
    }

    #[tokio::test]
    async fn test_stop_failure_injection() {
        let engine = ChaosEngine::new();

        // Configure failure
        let config = FailureConfig {
            failure_rate: 100.0,
            ..Default::default()
        };
        engine
            .configure_failure("test".to_string(), config)
            .await
            .unwrap();

        // Verify it's failing
        let result = engine.should_inject_failure("test").await.unwrap();
        assert!(!matches!(result, InjectionResult::None));

        // Stop failure injection
        engine.stop_failure("test").await;

        // Should not fail anymore
        let result = engine.should_inject_failure("test").await.unwrap();
        assert!(matches!(result, InjectionResult::None));
    }

    #[tokio::test]
    async fn test_resilience_metrics() {
        let metrics = ResilienceMetrics::new();

        metrics.record_request("test").await;
        metrics.record_success("test", 100).await;

        let summary = metrics.get_metrics("test").await;
        assert!(
            summary.is_some(),
            "metrics summary should exist after recording"
        );
        let summary = summary.unwrap();
        assert_eq!(summary.total_requests, 1);
        assert_eq!(summary.success_rate, 1.0);
        assert_eq!(summary.failure_rate, 0.0);
        assert_eq!(summary.average_latency_ms, 100);
    }

    #[tokio::test]
    async fn test_mttr_calculation() {
        let metrics = ResilienceMetrics::new();

        // Simulate failure and recovery
        metrics.record_request("test").await;
        metrics.record_failure("test").await;

        // Wait a bit
        tokio::time::sleep(Duration::from_millis(100)).await;

        metrics.record_success("test", 50).await;

        let summary = metrics.get_metrics("test").await.unwrap();
        assert!(summary.mean_time_to_recovery_ms >= 100);
    }
}
