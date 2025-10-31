//! Resilience and circuit breaker validation tests
//!
//! These tests validate that the resilience system behaves correctly
//! under various failure scenarios and that metrics are properly collected.

use std::time::Duration;
use uicp::infrastructure::chaos::ResilienceMetrics;
use uicp::infrastructure::resilience::{ErrorCategory, RetryEngine, RetryPolicy};

#[tokio::test]
async fn test_retry_policy_categories() {
    let engine = RetryEngine::new();

    // Test rate limit retry for OpenAI (should have longer delays)
    let delay = engine.should_retry("openai", Some(429), false, false, 0);
    assert!(delay.is_some(), "OpenAI should retry rate limits");
    let delay = delay.unwrap();
    let delay_ms = delay.as_millis() as u64;
    assert!(
        delay_ms >= 1_500 && delay_ms <= 2_500,
        "OpenAI rate limit delay should fall inside jitter-adjusted range (got {} ms)",
        delay_ms
    );

    // Test auth error (no retry for any provider)
    let delay = engine.should_retry("openai", Some(401), false, false, 0);
    assert!(delay.is_none(), "Auth errors should not retry");

    let delay = engine.should_retry("anthropic", Some(403), false, false, 0);
    assert!(delay.is_none(), "Policy errors should not retry");

    // Test transport error retry
    let delay = engine.should_retry("openrouter", Some(500), false, false, 0);
    assert!(delay.is_some(), "Transport errors should retry");

    // Test timeout retry
    let delay = engine.should_retry("ollama", None, true, false, 0);
    assert!(delay.is_some(), "Timeouts should retry");

    // Test network error retry
    let delay = engine.should_retry("ollama", None, false, true, 0);
    assert!(delay.is_some(), "Network errors should retry");
}

#[tokio::test]
async fn test_retry_attempts_exhausted() {
    let engine = RetryEngine::new();

    // Test that retries stop after max attempts
    let mut delay = engine.should_retry("openai", Some(429), false, false, 0);
    assert!(delay.is_some(), "First attempt should retry");

    delay = engine.should_retry("openai", Some(429), false, false, 1);
    assert!(delay.is_some(), "Second attempt should retry");

    delay = engine.should_retry("openai", Some(429), false, false, 2);
    assert!(delay.is_some(), "Third attempt should retry");

    delay = engine.should_retry("openai", Some(429), false, false, 3);
    assert!(delay.is_some(), "Fourth attempt should retry");

    delay = engine.should_retry("openai", Some(429), false, false, 4);
    assert!(delay.is_some(), "Fifth attempt should retry");

    delay = engine.should_retry("openai", Some(429), false, false, 5);
    assert!(
        delay.is_none(),
        "Sixth attempt should not retry (exhausted)"
    );
}

#[tokio::test]
async fn test_provider_specific_policies() {
    let engine = RetryEngine::new();

    // OpenAI should have stricter rate limit policy than others
    let openai_delay = engine.should_retry("openai", Some(429), false, false, 0);
    let anthropic_delay = engine.should_retry("anthropic", Some(429), false, false, 0);

    assert!(openai_delay.is_some());
    assert!(anthropic_delay.is_some());
    assert!(
        openai_delay.unwrap() > anthropic_delay.unwrap(),
        "OpenAI should have longer rate limit delays"
    );

    // Ollama should have more aggressive transport retry (local provider)
    let ollama_delay = engine.should_retry("ollama", Some(500), false, false, 0);
    let openai_transport_delay = engine.should_retry("openai", Some(500), false, false, 0);

    assert!(ollama_delay.is_some());
    assert!(openai_transport_delay.is_some());
    assert!(
        ollama_delay.unwrap() < openai_transport_delay.unwrap(),
        "Ollama should retry faster for transport errors"
    );
}

#[tokio::test]
async fn test_error_categorization() {
    // Test HTTP status categorization
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

    // Test timeout and connection errors
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
}

#[tokio::test]
async fn test_retry_backoff_progression() {
    let policy = RetryPolicy {
        max_attempts: 3,
        base_delay_ms: 1000,
        max_delay_ms: 5000,
        multiplier: 2.0,
        jitter: false, // Disable jitter for predictable testing
    };

    // Test exponential backoff
    let delay0 = policy.calculate_delay(0);
    let delay1 = policy.calculate_delay(1);
    let delay2 = policy.calculate_delay(2);

    assert!(delay1 > delay0, "Delay should increase with attempts");
    assert!(delay2 > delay1, "Delay should increase exponentially");

    // Test max delay cap
    let delay10 = policy.calculate_delay(10);
    assert!(
        delay10 <= Duration::from_millis(policy.max_delay_ms),
        "Delay should be capped at max"
    );
}

#[tokio::test]
async fn test_jitter_prevents_thundering_herd() {
    let policy = RetryPolicy {
        max_attempts: 3,
        base_delay_ms: 1000,
        max_delay_ms: 5000,
        multiplier: 2.0,
        jitter: true,
    };

    // Calculate multiple delays to test jitter
    let mut delays = Vec::new();
    for _ in 0..10 {
        delays.push(policy.calculate_delay(1));
    }

    // With jitter, delays should vary
    let min_delay = *delays.iter().min().unwrap();
    let max_delay = *delays.iter().max().unwrap();

    assert!(
        max_delay > min_delay,
        "Jitter should create variation in delays"
    );

    // All delays should be within reasonable bounds
    for delay in &delays {
        assert!(
            *delay >= Duration::from_millis(1500),
            "Delay should be at least base * multiplier"
        );
        assert!(
            *delay <= Duration::from_millis(2500),
            "Delay should not exceed reasonable jitter range"
        );
    }
}

#[tokio::test]
async fn test_synthetic_failure_scenario() {
    let engine = RetryEngine::new();

    // Simulate a realistic failure scenario:
    // 1. Initial rate limit (429) -> retry with backoff
    // 2. Transport error (500) -> retry with shorter backoff
    // 3. Success

    let mut attempt = 0;

    // Rate limit scenario
    let delay = engine.should_retry("openai", Some(429), false, false, attempt);
    assert!(delay.is_some(), "Should retry rate limit");
    println!("Rate limit retry in {:?}", delay.unwrap());
    attempt += 1;

    // Transport error scenario
    let delay = engine.should_retry("openai", Some(500), false, false, attempt);
    assert!(delay.is_some(), "Should retry transport error");
    println!("Transport error retry in {:?}", delay.unwrap());
    attempt += 1;

    // Simulate success (no retry needed)
    let delay = engine.should_retry("openai", Some(200), false, false, attempt);
    assert!(delay.is_none(), "Should not retry on success");
}

#[tokio::test]
async fn test_failure_mode_snapshot_metrics() {
    // WHY: Capture a representative snapshot of resilience metrics during a failure/recovery cycle.
    let metrics = ResilienceMetrics::new();

    // Simulate initial failure sequence for OpenAI provider.
    metrics.record_request("openai").await;
    metrics.record_failure("openai").await;
    metrics.record_retry("openai").await;
    metrics.record_circuit_open("openai").await;

    // Simulate eventual recovery with another request succeeding.
    metrics.record_request("openai").await;
    metrics.record_success("openai", 2_300).await;

    let summary = metrics
        .get_metrics("openai")
        .await
        .expect("metrics summary should exist");

    // Snapshot expectations: 2 total requests, half succeeded, one failure, one retry, one circuit open.
    assert_eq!(summary.total_requests, 2);
    assert!(summary.success_rate > 0.0 && summary.success_rate < 1.0);
    assert!(summary.failure_rate > 0.0 && summary.failure_rate < 1.0);
    assert!(summary.retry_rate > 0.0);
    assert_eq!(summary.circuit_openings, 1);

    println!(
        "Failure snapshot: provider={} total={} success_rate={:.2}% failure_rate={:.2}% retry_rate={:.2}% avg_latency={}ms mttr={}ms circuit_openings={}",
        summary.provider,
        summary.total_requests,
        summary.success_rate * 100.0,
        summary.failure_rate * 100.0,
        summary.retry_rate * 100.0,
        summary.average_latency_ms,
        summary.mean_time_to_recovery_ms,
        summary.circuit_openings
    );
}
