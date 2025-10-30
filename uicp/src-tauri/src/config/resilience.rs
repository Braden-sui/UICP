//! Resilience and retry configuration

use rand::Rng;
use std::time::Duration;

/// Default retry policy configuration
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
            max_attempts: DEFAULT_RETRY_MAX_ATTEMPTS,
            base_delay_ms: DEFAULT_RETRY_BASE_DELAY_MS,
            max_delay_ms: DEFAULT_RETRY_MAX_DELAY_MS,
            multiplier: DEFAULT_RETRY_MULTIPLIER,
            jitter: DEFAULT_RETRY_JITTER,
        }
    }
}

/// Default resilience configuration values
pub const DEFAULT_RETRY_MAX_ATTEMPTS: u8 = 3;
pub const DEFAULT_RETRY_BASE_DELAY_MS: u64 = 200;
pub const DEFAULT_RETRY_MAX_DELAY_MS: u64 = 5000;
pub const DEFAULT_RETRY_MULTIPLIER: f64 = 2.0;
pub const DEFAULT_RETRY_JITTER: bool = true;

/// Rate limit retry configuration (stricter policies)
pub const RATE_LIMIT_MAX_ATTEMPTS: u8 = 5;
pub const RATE_LIMIT_BASE_DELAY_MS: u64 = 1000;
pub const RATE_LIMIT_MAX_DELAY_MS: u64 = 60000;
pub const RATE_LIMIT_MULTIPLIER: f64 = 2.0;
pub const RATE_LIMIT_JITTER: bool = true;

/// Timeout retry configuration
pub const TIMEOUT_MAX_ATTEMPTS: u8 = 3;
pub const TIMEOUT_BASE_DELAY_MS: u64 = 500;
pub const TIMEOUT_MAX_DELAY_MS: u64 = 10000;
pub const TIMEOUT_MULTIPLIER: f64 = 1.5;
pub const TIMEOUT_JITTER: bool = true;

/// Transport error retry configuration (fast recovery)
pub const TRANSPORT_MAX_ATTEMPTS: u8 = 4;
pub const TRANSPORT_BASE_DELAY_MS: u64 = 100;
pub const TRANSPORT_MAX_DELAY_MS: u64 = 2000;
pub const TRANSPORT_MULTIPLIER: f64 = 2.0;
pub const TRANSPORT_JITTER: bool = true;

/// Network error retry configuration
pub const NETWORK_MAX_ATTEMPTS: u8 = 3;
pub const NETWORK_BASE_DELAY_MS: u64 = 200;
pub const NETWORK_MAX_DELAY_MS: u64 = 5000;
pub const NETWORK_MULTIPLIER: f64 = 2.0;
pub const NETWORK_JITTER: bool = true;

/// Auth/Policy errors: no retry
pub const AUTH_POLICY_MAX_ATTEMPTS: u8 = 0;
pub const AUTH_POLICY_BASE_DELAY_MS: u64 = 100;
pub const AUTH_POLICY_MAX_DELAY_MS: u64 = 1000;
pub const AUTH_POLICY_MULTIPLIER: f64 = 1.5;
pub const AUTH_POLICY_JITTER: bool = true;

// Provider-specific circuit breaker defaults
// #[allow(dead_code)]
// pub const DEFAULT_CIRCUIT_MAX_FAILURES: u8 = 5;
// pub const DEFAULT_CIRCUIT_OPEN_MS: u64 = 30000;
// pub const DEFAULT_CIRCUIT_HALF_OPEN_MAX_CALLS: u8 = 3;

/// OpenAI-specific resilience settings
pub const OPENAI_DEFAULT_MAX_FAILURES: u8 = 3;
pub const OPENAI_DEFAULT_CIRCUIT_OPEN_MS: u64 = 30000;

/// OpenRouter-specific resilience settings
pub const OPENROUTER_DEFAULT_MAX_FAILURES: u8 = 4;
pub const OPENROUTER_DEFAULT_CIRCUIT_OPEN_MS: u64 = 20000;

/// Anthropic-specific resilience settings
pub const ANTHROPIC_DEFAULT_MAX_FAILURES: u8 = 4;
pub const ANTHROPIC_DEFAULT_CIRCUIT_OPEN_MS: u64 = 25000;

/// Ollama-specific resilience settings (local provider, more lenient)
pub const OLLAMA_DEFAULT_MAX_FAILURES: u8 = 8;
pub const OLLAMA_DEFAULT_CIRCUIT_OPEN_MS: u64 = 10000;

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

/// Create rate limit retry policy
pub fn rate_limit_policy() -> RetryPolicy {
    RetryPolicy {
        max_attempts: RATE_LIMIT_MAX_ATTEMPTS,
        base_delay_ms: RATE_LIMIT_BASE_DELAY_MS,
        max_delay_ms: RATE_LIMIT_MAX_DELAY_MS,
        multiplier: RATE_LIMIT_MULTIPLIER,
        jitter: RATE_LIMIT_JITTER,
    }
}

/// Create timeout retry policy
pub fn timeout_policy() -> RetryPolicy {
    RetryPolicy {
        max_attempts: TIMEOUT_MAX_ATTEMPTS,
        base_delay_ms: TIMEOUT_BASE_DELAY_MS,
        max_delay_ms: TIMEOUT_MAX_DELAY_MS,
        multiplier: TIMEOUT_MULTIPLIER,
        jitter: TIMEOUT_JITTER,
    }
}

/// Create transport retry policy
pub fn transport_policy() -> RetryPolicy {
    RetryPolicy {
        max_attempts: TRANSPORT_MAX_ATTEMPTS,
        base_delay_ms: TRANSPORT_BASE_DELAY_MS,
        max_delay_ms: TRANSPORT_MAX_DELAY_MS,
        multiplier: TRANSPORT_MULTIPLIER,
        jitter: TRANSPORT_JITTER,
    }
}

/// Create network retry policy
pub fn network_policy() -> RetryPolicy {
    RetryPolicy {
        max_attempts: NETWORK_MAX_ATTEMPTS,
        base_delay_ms: NETWORK_BASE_DELAY_MS,
        max_delay_ms: NETWORK_MAX_DELAY_MS,
        multiplier: NETWORK_MULTIPLIER,
        jitter: NETWORK_JITTER,
    }
}

/// Create auth/policy retry policy (no retries)
pub fn auth_policy_no_retry() -> RetryPolicy {
    RetryPolicy {
        max_attempts: AUTH_POLICY_MAX_ATTEMPTS,
        base_delay_ms: AUTH_POLICY_BASE_DELAY_MS,
        max_delay_ms: AUTH_POLICY_MAX_DELAY_MS,
        multiplier: AUTH_POLICY_MULTIPLIER,
        jitter: AUTH_POLICY_JITTER,
    }
}
