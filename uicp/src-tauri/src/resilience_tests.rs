//! Tests for resilience and retry policies

#[cfg(test)]
mod tests {
    use crate::resilience::*;
    use std::time::Duration;

    #[test]
    fn test_error_categorization() {
        // Test HTTP status code categorization
        assert_eq!(
            RetryEngine::categorize_error(Some(429), false, false),
            ErrorCategory::RateLimit
        );
        assert_eq!(
            RetryEngine::categorize_error(Some(401), false, false),
            ErrorCategory::Auth
        );
        assert_eq!(
            RetryEngine::categorize_error(Some(403), false, false),
            ErrorCategory::Auth
        );
        assert_eq!(
            RetryEngine::categorize_error(Some(408), false, false),
            ErrorCategory::Timeout
        );
        assert_eq!(
            RetryEngine::categorize_error(Some(500), false, false),
            ErrorCategory::Transport
        );
        assert_eq!(
            RetryEngine::categorize_error(Some(502), false, false),
            ErrorCategory::Transport
        );
        assert_eq!(
            RetryEngine::categorize_error(Some(503), false, false),
            ErrorCategory::Transport
        );
        assert_eq!(
            RetryEngine::categorize_error(Some(400), false, false),
            ErrorCategory::Policy
        );
        assert_eq!(
            RetryEngine::categorize_error(Some(422), false, false),
            ErrorCategory::Policy
        );

        // Test network/timeout categorization
        assert_eq!(
            RetryEngine::categorize_error(None, true, false),
            ErrorCategory::Timeout
        );
        assert_eq!(
            RetryEngine::categorize_error(None, false, true),
            ErrorCategory::Network
        );
        assert_eq!(
            RetryEngine::categorize_error(None, false, false),
            ErrorCategory::Network
        );

        // Test unknown status
        assert_eq!(
            RetryEngine::categorize_error(Some(999), false, false),
            ErrorCategory::Unknown
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

        // Test exponential backoff without jitter
        assert_eq!(policy.calculate_delay(0), Duration::from_millis(100));
        assert_eq!(policy.calculate_delay(1), Duration::from_millis(200));
        assert_eq!(policy.calculate_delay(2), Duration::from_millis(400));

        // Test max delay cap
        assert_eq!(policy.calculate_delay(10), Duration::from_millis(1000));
    }

    #[test]
    fn test_retry_policy_with_jitter() {
        let policy = RetryPolicy {
            max_attempts: 3,
            base_delay_ms: 1000,
            max_delay_ms: 5000,
            multiplier: 2.0,
            jitter: true,
        };

        // With jitter, delay should be within ±25% of base delay
        let delay = policy.calculate_delay(1);
        assert!(delay >= Duration::from_millis(1500)); // 2000 - 25%
        assert!(delay <= Duration::from_millis(2500)); // 2000 + 25%
    }

    #[test]
    fn test_retry_engine_initialization() {
        let engine = RetryEngine::new();

        // Should have configurations for all providers
        assert!(engine
            .get_policy("openai", ErrorCategory::RateLimit)
            .is_some());
        assert!(engine
            .get_policy("openrouter", ErrorCategory::RateLimit)
            .is_some());
        assert!(engine
            .get_policy("anthropic", ErrorCategory::RateLimit)
            .is_some());
        assert!(engine
            .get_policy("ollama", ErrorCategory::RateLimit)
            .is_some());

        // Should have circuit configs for all providers
        assert!(engine.get_circuit_config("openai").is_some());
        assert!(engine.get_circuit_config("openrouter").is_some());
        assert!(engine.get_circuit_config("anthropic").is_some());
        assert!(engine.get_circuit_config("ollama").is_some());
    }

    #[test]
    fn test_retry_should_retry_logic() {
        let engine = RetryEngine::new();

        // Rate limit errors should retry
        let delay = engine.should_retry("openai", Some(429), false, false, 0);
        assert!(delay.is_some());
        // With jitter enabled, delay can be less than base_delay, so check reasonable range
        assert!(delay.unwrap() >= Duration::from_millis(1500)); // Allow 25% reduction due to jitter
        assert!(delay.unwrap() <= Duration::from_millis(2500)); // Allow 25% increase due to jitter

        // Auth errors should not retry
        let delay = engine.should_retry("openai", Some(401), false, false, 0);
        assert!(delay.is_none());

        // Policy errors should not retry
        let delay = engine.should_retry("openai", Some(400), false, false, 0);
        assert!(delay.is_none());

        // Transport errors should retry
        let delay = engine.should_retry("openai", Some(500), false, false, 0);
        assert!(delay.is_some());

        // Timeout errors should retry
        let delay = engine.should_retry("openai", None, true, false, 0);
        assert!(delay.is_some());

        // Network errors should retry
        let delay = engine.should_retry("openai", None, false, true, 0);
        assert!(delay.is_some());

        // Max attempts exceeded should not retry
        let delay = engine.should_retry("openai", Some(429), false, false, 10);
        assert!(delay.is_none());
    }

    #[test]
    fn test_provider_specific_policies() {
        let engine = RetryEngine::new();

        // OpenAI should have stricter rate limit policy
        let openai_policy = engine
            .get_policy("openai", ErrorCategory::RateLimit)
            .unwrap();
        assert!(openai_policy.max_attempts >= 5);
        assert!(openai_policy.base_delay_ms >= 2000);

        // OpenRouter should be more lenient
        let openrouter_policy = engine
            .get_policy("openrouter", ErrorCategory::RateLimit)
            .unwrap();
        assert!(openrouter_policy.max_attempts >= 4);
        assert!(openrouter_policy.base_delay_ms >= 1500);

        // Anthropic should have moderate limits
        let anthropic_policy = engine
            .get_policy("anthropic", ErrorCategory::RateLimit)
            .unwrap();
        assert!(anthropic_policy.max_attempts >= 3);
        assert!(anthropic_policy.base_delay_ms >= 1000);

        // Ollama should have aggressive transport retry (local provider)
        let ollama_policy = engine
            .get_policy("ollama", ErrorCategory::Transport)
            .unwrap();
        assert!(ollama_policy.max_attempts >= 5);
        assert!(ollama_policy.base_delay_ms <= 100);
    }

    #[test]
    fn test_unknown_provider_fallback() {
        let engine = RetryEngine::new();

        // Unknown provider should not have policies
        assert!(engine
            .get_policy("unknown", ErrorCategory::RateLimit)
            .is_none());
        assert!(engine.get_circuit_config("unknown").is_none());

        // Should return None for retry decisions
        let delay = engine.should_retry("unknown", Some(429), false, false, 0);
        assert!(delay.is_none());
    }

    #[test]
    fn test_retry_delay_bounds() {
        let engine = RetryEngine::new();

        // Test that delays are reasonable for different categories
        let rate_limit_delay = engine
            .should_retry("openai", Some(429), false, false, 0)
            .unwrap();
        assert!(rate_limit_delay >= Duration::from_millis(1500)); // Allow 25% reduction due to jitter
        assert!(rate_limit_delay <= Duration::from_millis(150000)); // Allow some increase due to jitter

        let transport_delay = engine
            .should_retry("openai", Some(500), false, false, 0)
            .unwrap();
        assert!(transport_delay >= Duration::from_millis(75)); // Allow 25% reduction due to jitter
        assert!(transport_delay <= Duration::from_millis(2500)); // Allow 25% increase due to jitter

        let timeout_delay = engine.should_retry("openai", None, true, false, 0).unwrap();
        assert!(timeout_delay >= Duration::from_millis(375)); // Allow 25% reduction due to jitter
        assert!(timeout_delay <= Duration::from_millis(12500)); // Allow 25% increase due to jitter
    }

    #[test]
    fn test_provider_resilience_config_default() {
        let config = ProviderResilienceConfig::default();

        // Should have policies for all categories
        assert!(config
            .retry_policies
            .contains_key(&ErrorCategory::RateLimit));
        assert!(config.retry_policies.contains_key(&ErrorCategory::Timeout));
        assert!(config
            .retry_policies
            .contains_key(&ErrorCategory::Transport));
        assert!(config.retry_policies.contains_key(&ErrorCategory::Auth));
        assert!(config.retry_policies.contains_key(&ErrorCategory::Policy));
        assert!(config.retry_policies.contains_key(&ErrorCategory::Network));

        // Auth and Policy should have 0 max attempts
        let auth_policy = config.retry_policies.get(&ErrorCategory::Auth).unwrap();
        assert_eq!(auth_policy.max_attempts, 0);

        let policy_policy = config.retry_policies.get(&ErrorCategory::Policy).unwrap();
        assert_eq!(policy_policy.max_attempts, 0);

        // Rate limit should have higher max attempts
        let rate_limit_policy = config
            .retry_policies
            .get(&ErrorCategory::RateLimit)
            .unwrap();
        assert!(rate_limit_policy.max_attempts > 0);
        assert!(rate_limit_policy.base_delay_ms > 0);
    }
}
