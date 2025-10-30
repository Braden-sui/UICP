//! Resilience and retry policies for LLM providers
//!
//! This module implements category-specific retry/backoff policies and
//! provider-aware circuit breaker configurations to improve system resilience.

use std::{collections::HashMap, time::Duration};

use rand::Rng;
use serde::{Deserialize, Serialize};

/// Error categories for different retry strategies
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ErrorCategory {
    /// HTTP 429 - Rate limiting with longer delays and Retry-After respect
    RateLimit,
    /// HTTP 408 - Request timeouts with moderate delays
    Timeout,
    /// HTTP 5xx - Transport errors with shorter delays for fast recovery
    Transport,
    /// HTTP 401/403 - Authentication failures (no retry)
    Auth,
    /// HTTP 4xx (except 429) - Client errors (no retry)
    Policy,
    /// Network/connectivity issues
    Network,
    /// Unknown or uncategorized errors
    Unknown,
}

/// Retry policy configuration
#[derive(Debug, Clone)]
pub struct RetryPolicy {
    /// Maximum number of retry attempts
    pub max_attempts: u8,
    /// Base delay in milliseconds
    pub base_delay_ms: u64,
    /// Maximum delay in milliseconds
    pub max_delay_ms: u64,
    /// Multiplier for exponential backoff
    pub multiplier: f64,
    /// Whether to add jitter to prevent thundering herd
    pub jitter: bool,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            base_delay_ms: 200,
            max_delay_ms: 5000,
            multiplier: 2.0,
            jitter: true,
        }
    }
}

impl RetryPolicy {
    /// Calculate delay for a given attempt number
    pub fn calculate_delay(&self, attempt: u8) -> Duration {
        let delay_ms = (self.base_delay_ms as f64 * self.multiplier.powi(attempt as i32)) as u64;
        let delay_ms = delay_ms.min(self.max_delay_ms);

        let final_delay = if self.jitter {
            let jitter_range = delay_ms / 4;
            let mut rng = rand::thread_rng();
            let offset = rng.gen_range(0..=2 * jitter_range);
            delay_ms.saturating_add(offset).saturating_sub(jitter_range)
        } else {
            delay_ms
        };

        Duration::from_millis(final_delay)
    }
}

/// Provider-specific resilience configuration
#[derive(Debug, Clone)]
pub struct ProviderResilienceConfig {
    /// Retry policies by error category
    pub retry_policies: HashMap<ErrorCategory, RetryPolicy>,
    /// Circuit breaker configuration
    pub circuit_config: crate::core::CircuitBreakerConfig,
}

impl Default for ProviderResilienceConfig {
    fn default() -> Self {
        let mut retry_policies = HashMap::new();

        // Rate limit: longer delays, respect Retry-After
        retry_policies.insert(
            ErrorCategory::RateLimit,
            RetryPolicy {
                max_attempts: 5,
                base_delay_ms: 1000,
                max_delay_ms: 60000,
                multiplier: 2.0,
                jitter: true,
            },
        );

        // Timeout: moderate delays
        retry_policies.insert(
            ErrorCategory::Timeout,
            RetryPolicy {
                max_attempts: 3,
                base_delay_ms: 500,
                max_delay_ms: 10000,
                multiplier: 1.5,
                jitter: true,
            },
        );

        // Transport: shorter delays for fast recovery
        retry_policies.insert(
            ErrorCategory::Transport,
            RetryPolicy {
                max_attempts: 4,
                base_delay_ms: 100,
                max_delay_ms: 2000,
                multiplier: 2.0,
                jitter: true,
            },
        );

        // Network: connection issues
        retry_policies.insert(
            ErrorCategory::Network,
            RetryPolicy {
                max_attempts: 3,
                base_delay_ms: 200,
                max_delay_ms: 5000,
                multiplier: 2.0,
                jitter: true,
            },
        );

        // Auth and Policy errors: no retry
        retry_policies.insert(
            ErrorCategory::Auth,
            RetryPolicy {
                max_attempts: 0,
                base_delay_ms: 0,
                max_delay_ms: 0,
                multiplier: 1.0,
                jitter: false,
            },
        );

        retry_policies.insert(
            ErrorCategory::Policy,
            RetryPolicy {
                max_attempts: 0,
                base_delay_ms: 0,
                max_delay_ms: 0,
                multiplier: 1.0,
                jitter: false,
            },
        );

        Self {
            retry_policies,
            circuit_config: crate::core::CircuitBreakerConfig::default(),
        }
    }
}

/// Retry engine for determining if and when to retry requests
#[derive(Clone)]
pub struct RetryEngine {
    configs: HashMap<String, ProviderResilienceConfig>,
}

impl RetryEngine {
    /// Create new retry engine with provider configurations
    pub fn new() -> Self {
        let mut configs = HashMap::new();

        // Load default configurations
        configs.insert("openai".to_string(), Self::load_openai_config());
        configs.insert("openrouter".to_string(), Self::load_openrouter_config());
        configs.insert("anthropic".to_string(), Self::load_anthropic_config());
        configs.insert("ollama".to_string(), Self::load_ollama_config());

        Self { configs }
    }

    /// Load OpenAI-specific configuration
    fn load_openai_config() -> ProviderResilienceConfig {
        let mut config = ProviderResilienceConfig::default();

        // Override from environment if present
        if let Ok(max_failures) = std::env::var("UICP_OPENAI_MAX_FAILURES") {
            if let Ok(v) = max_failures.parse::<u8>() {
                config.circuit_config.max_failures = v;
            }
        }

        if let Ok(open_ms) = std::env::var("UICP_OPENAI_CIRCUIT_OPEN_MS") {
            if let Ok(v) = open_ms.parse::<u64>() {
                config.circuit_config.open_duration_ms = v;
            }
        }

        // OpenAI-specific retry policies
        if let Some(policy) = config.retry_policies.get_mut(&ErrorCategory::RateLimit) {
            // OpenAI has strict rate limits
            policy.max_attempts = 5;
            policy.base_delay_ms = 2000;
            policy.max_delay_ms = 120000; // 2 minutes
        }

        config
    }

    /// Load OpenRouter-specific configuration
    fn load_openrouter_config() -> ProviderResilienceConfig {
        let mut config = ProviderResilienceConfig::default();

        // Override from environment if present
        if let Ok(max_failures) = std::env::var("UICP_OPENROUTER_MAX_FAILURES") {
            if let Ok(v) = max_failures.parse::<u8>() {
                config.circuit_config.max_failures = v;
            }
        }

        if let Ok(open_ms) = std::env::var("UICP_OPENROUTER_CIRCUIT_OPEN_MS") {
            if let Ok(v) = open_ms.parse::<u64>() {
                config.circuit_config.open_duration_ms = v;
            }
        }

        // OpenRouter is generally more lenient
        if let Some(policy) = config.retry_policies.get_mut(&ErrorCategory::RateLimit) {
            policy.max_attempts = 4;
            policy.base_delay_ms = 1500;
            policy.max_delay_ms = 60000;
        }

        config
    }

    /// Load Anthropic-specific configuration
    fn load_anthropic_config() -> ProviderResilienceConfig {
        let mut config = ProviderResilienceConfig::default();

        // Override from environment if present
        if let Ok(max_failures) = std::env::var("UICP_ANTHROPIC_MAX_FAILURES") {
            if let Ok(v) = max_failures.parse::<u8>() {
                config.circuit_config.max_failures = v;
            }
        }

        if let Ok(open_ms) = std::env::var("UICP_ANTHROPIC_CIRCUIT_OPEN_MS") {
            if let Ok(v) = open_ms.parse::<u64>() {
                config.circuit_config.open_duration_ms = v;
            }
        }

        // Anthropic has moderate rate limits
        if let Some(policy) = config.retry_policies.get_mut(&ErrorCategory::RateLimit) {
            policy.max_attempts = 3;
            policy.base_delay_ms = 1000;
            policy.max_delay_ms = 30000;
        }

        config
    }

    /// Load Ollama-specific configuration
    fn load_ollama_config() -> ProviderResilienceConfig {
        let mut config = ProviderResilienceConfig::default();

        // Override from environment if present
        if let Ok(max_failures) = std::env::var("UICP_OLLAMA_MAX_FAILURES") {
            if let Ok(v) = max_failures.parse::<u8>() {
                config.circuit_config.max_failures = v;
            }
        }

        if let Ok(open_ms) = std::env::var("UICP_OLLAMA_CIRCUIT_OPEN_MS") {
            if let Ok(v) = open_ms.parse::<u64>() {
                config.circuit_config.open_duration_ms = v;
            }
        }

        // Ollama is local, more aggressive retry
        if let Some(policy) = config.retry_policies.get_mut(&ErrorCategory::Transport) {
            policy.max_attempts = 5;
            policy.base_delay_ms = 50;
            policy.max_delay_ms = 1000;
        }

        config
    }

    /// Categorize an error based on HTTP status and error type
    pub fn categorize_error(
        status: Option<u16>,
        is_timeout: bool,
        is_connect: bool,
    ) -> ErrorCategory {
        if is_timeout {
            ErrorCategory::Timeout
        } else if is_connect {
            ErrorCategory::Network
        } else if let Some(status) = status {
            match status {
                429 => ErrorCategory::RateLimit,
                401 | 403 => ErrorCategory::Auth,
                408 => ErrorCategory::Timeout,
                500..=599 => ErrorCategory::Transport,
                400..=499 => ErrorCategory::Policy,
                _ => ErrorCategory::Unknown,
            }
        } else {
            ErrorCategory::Network
        }
    }

    /// Get retry policy for a specific provider and error category
    pub fn get_policy(&self, provider: &str, category: ErrorCategory) -> Option<&RetryPolicy> {
        self.configs
            .get(provider)
            .and_then(|config| config.retry_policies.get(&category))
    }

    /// Get circuit breaker configuration for a provider
    pub fn get_circuit_config(&self, provider: &str) -> Option<&crate::core::CircuitBreakerConfig> {
        self.configs
            .get(provider)
            .map(|config| &config.circuit_config)
    }

    /// Determine if a request should be retried and calculate delay
    pub fn should_retry(
        &self,
        provider: &str,
        status: Option<u16>,
        is_timeout: bool,
        is_connect: bool,
        attempt: u8,
    ) -> Option<Duration> {
        let category = Self::categorize_error(status, is_timeout, is_connect);
        let policy = self.get_policy(provider, category)?;

        if attempt < policy.max_attempts {
            Some(policy.calculate_delay(attempt))
        } else {
            None
        }
    }
}

impl Default for RetryEngine {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_categorization() {
        assert_eq!(
            RetryEngine::categorize_error(Some(429), false, false),
            ErrorCategory::RateLimit
        );
        assert_eq!(
            RetryEngine::categorize_error(Some(401), false, false),
            ErrorCategory::Auth
        );
        assert_eq!(
            RetryEngine::categorize_error(Some(500), false, false),
            ErrorCategory::Transport
        );
        assert_eq!(
            RetryEngine::categorize_error(Some(400), false, false),
            ErrorCategory::Policy
        );
        assert_eq!(
            RetryEngine::categorize_error(None, false, true),
            ErrorCategory::Network
        );
        assert_eq!(
            RetryEngine::categorize_error(None, true, false),
            ErrorCategory::Timeout
        );
    }

    #[test]
    fn test_retry_policy_calculation() {
        let policy = RetryPolicy {
            max_attempts: 3,
            base_delay_ms: 100,
            max_delay_ms: 1000,
            multiplier: 2.0,
            jitter: false,
        };

        let delay0 = policy.calculate_delay(0);
        assert_eq!(delay0, Duration::from_millis(100));

        let delay1 = policy.calculate_delay(1);
        assert_eq!(delay1, Duration::from_millis(200));

        let delay2 = policy.calculate_delay(2);
        assert_eq!(delay2, Duration::from_millis(400));

        // Test max delay cap
        let delay10 = policy.calculate_delay(10);
        assert_eq!(delay10, Duration::from_millis(1000));
    }

    #[test]
    fn test_retry_engine() {
        let engine = RetryEngine::new();

        // Test rate limit retry for OpenAI
        let delay = engine.should_retry("openai", Some(429), false, false, 0);
        assert!(delay.is_some());
        // With jitter enabled, delay can be less than base_delay, so check reasonable range
        assert!(delay.unwrap() >= Duration::from_millis(1500)); // Allow 25% reduction due to jitter
        assert!(delay.unwrap() <= Duration::from_millis(2500)); // Allow 25% increase due to jitter

        // Test auth error (no retry)
        let delay = engine.should_retry("openai", Some(401), false, false, 0);
        assert!(delay.is_none());

        // Test max attempts exceeded
        let delay = engine.should_retry("openai", Some(429), false, false, 10);
        assert!(delay.is_none());
    }

    #[test]
    fn test_provider_configs() {
        let engine = RetryEngine::new();

        // OpenAI should have stricter rate limit policy
        let openai_policy = engine.get_policy("openai", ErrorCategory::RateLimit);
        assert!(openai_policy.is_some());
        assert!(openai_policy.unwrap().max_attempts >= 5);

        // Ollama should have more aggressive transport retry
        let ollama_policy = engine.get_policy("ollama", ErrorCategory::Transport);
        assert!(ollama_policy.is_some());
        assert!(ollama_policy.unwrap().max_attempts >= 5);
    }
}
