#![cfg(test)]

use std::{collections::HashMap, sync::Arc, time::Duration};

use tokio::sync::RwLock;

use crate::{
    circuit::{
        circuit_is_open, circuit_record_failure, circuit_record_success, get_circuit_debug_info,
    },
    core::{CircuitBreakerConfig, CircuitState},
};

/// Test fixture: create empty circuit breaker map
fn new_circuits() -> Arc<RwLock<HashMap<String, CircuitState>>> {
    Arc::new(RwLock::new(HashMap::new()))
}

/// Test fixture: telemetry event collector
fn create_telemetry_sink() -> (
    Arc<RwLock<Vec<(String, serde_json::Value)>>>,
    impl Fn(&str, serde_json::Value) + Clone,
) {
    let events = Arc::new(RwLock::new(Vec::new()));
    let events_clone = events.clone();
    let emitter = move |event: &str, data: serde_json::Value| {
        let events = events_clone.clone();
        let event_owned = event.to_string();
        tokio::spawn(async move {
            events.write().await.push((event_owned, data));
        });
    };
    (events, emitter)
}

#[tokio::test]
async fn test_circuit_opens_after_max_failures() {
    let circuits = new_circuits();
    let config = CircuitBreakerConfig {
        max_failures: 3,
        open_duration_ms: 5_000,
    };
    let (events, emit) = create_telemetry_sink();
    let host = "api.example.com";

    // First 2 failures should not open circuit
    for _ in 0..2 {
        let result = circuit_record_failure(&circuits, host, &config, emit.clone()).await;
        assert!(
            result.is_none(),
            "circuit should not open before max_failures"
        );
    }

    // 3rd failure should open circuit
    let opened_until = circuit_record_failure(&circuits, host, &config, emit.clone()).await;
    assert!(
        opened_until.is_some(),
        "circuit should open after max_failures"
    );

    // Verify circuit is open
    let is_open = circuit_is_open(&circuits, host).await;
    assert!(is_open.is_some(), "circuit should be open");

    // Verify telemetry event emitted
    tokio::time::sleep(Duration::from_millis(10)).await; // Allow async emit to complete
    let events_guard = events.read().await;
    let circuit_open_events: Vec<_> = events_guard
        .iter()
        .filter(|(event, _)| event == "circuit-open")
        .collect();
    assert_eq!(
        circuit_open_events.len(),
        1,
        "should emit circuit-open event"
    );
}

#[tokio::test]
async fn test_circuit_transitions_to_half_open_after_timeout() {
    let circuits = new_circuits();
    let config = CircuitBreakerConfig {
        max_failures: 2,
        open_duration_ms: 100, // Short timeout for testing
    };
    let (events, emit) = create_telemetry_sink();
    let host = "api.example.com";

    // Open circuit
    for _ in 0..2 {
        circuit_record_failure(&circuits, host, &config, emit.clone()).await;
    }

    // Verify circuit is open
    let is_open_before = circuit_is_open(&circuits, host).await;
    assert!(is_open_before.is_some(), "circuit should be open");

    // Wait for timeout
    tokio::time::sleep(Duration::from_millis(150)).await;

    // Check circuit again - should be half-open (cleared)
    let is_open_after = circuit_is_open(&circuits, host).await;
    assert!(
        is_open_after.is_none(),
        "circuit should transition to half-open after timeout"
    );

    // Verify half-open state and probe flags
    let guard = circuits.read().await;
    let state = guard.get(host).expect("circuit state should exist");
    assert_eq!(
        state.consecutive_failures, 0,
        "consecutive failures should be reset after timeout"
    );
    assert!(
        state.half_open,
        "circuit should mark half_open after timeout"
    );
    assert!(
        !state.half_open_probe_in_flight,
        "half-open probe flag should be clear until a probe is issued"
    );
}

#[tokio::test]
async fn test_half_open_failure_reopens_immediately() {
    let circuits = new_circuits();
    let config = CircuitBreakerConfig {
        max_failures: 2,
        open_duration_ms: 50,
    };
    let (_, emit) = create_telemetry_sink();
    let host = "api.example.com";

    for _ in 0..2 {
        circuit_record_failure(&circuits, host, &config, emit.clone()).await;
    }

    tokio::time::sleep(Duration::from_millis(80)).await;

    let is_open_after_timeout = circuit_is_open(&circuits, host).await;
    assert!(is_open_after_timeout.is_none());

    {
        let mut guard = circuits.write().await;
        let state = guard.get_mut(host).expect("state exists");
        state.half_open = true;
        state.half_open_probe_in_flight = true;
    }

    // Failure while half-open should immediately reopen
    let reopened = circuit_record_failure(&circuits, host, &config, emit.clone())
        .await
        .expect("should reopen");
    assert!(reopened > Instant::now());

    let guard = circuits.read().await;
    let state = guard.get(host).expect("state exists");
    assert!(state.opened_until.is_some());
    assert!(
        !state.half_open,
        "half_open should be cleared after failure"
    );
    assert!(
        !state.half_open_probe_in_flight,
        "probe in flight flag should reset after failure"
    );

    tokio::time::sleep(Duration::from_millis(10)).await;
    let events_guard = events.read().await;
    assert!(
        events_guard.iter().any(|(evt, _)| evt == "circuit-open"),
        "half-open failure should emit circuit-open"
    );
}

#[tokio::test]
async fn test_success_closes_circuit() {
    let circuits = new_circuits();
    let config = CircuitBreakerConfig {
        max_failures: 2,
        open_duration_ms: 5_000,
    };
    let (events, emit) = create_telemetry_sink();
    let host = "api.example.com";

    // Open circuit
    for _ in 0..2 {
        circuit_record_failure(&circuits, host, &config, emit.clone()).await;
    }

    // Verify circuit is open
    assert!(circuit_is_open(&circuits, host).await.is_some());

    // Record success - should close circuit
    circuit_record_success(&circuits, host, emit.clone()).await;

    // Verify circuit is closed
    let is_open = circuit_is_open(&circuits, host).await;
    assert!(is_open.is_none(), "circuit should be closed after success");

    // Verify consecutive failures reset
    let guard = circuits.read().await;
    let state = guard.get(host).expect("circuit state should exist");
    assert_eq!(
        state.consecutive_failures, 0,
        "consecutive failures should be 0 after success"
    );

    // Verify telemetry event emitted
    tokio::time::sleep(Duration::from_millis(10)).await;
    let events_guard = events.read().await;
    let circuit_close_events: Vec<_> = events_guard
        .iter()
        .filter(|(event, _)| event == "circuit-close")
        .collect();
    assert_eq!(
        circuit_close_events.len(),
        1,
        "should emit circuit-close event"
    );
}

#[tokio::test]
async fn test_failure_during_degraded_state_reopens() {
    let circuits = new_circuits();
    let config = CircuitBreakerConfig {
        max_failures: 2,
        open_duration_ms: 100,
    };
    let (_, emit) = create_telemetry_sink();
    let host = "api.example.com";

    // Cause 1 failure (degraded state)
    circuit_record_failure(&circuits, host, &config, emit.clone()).await;

    // Verify circuit not open yet
    assert!(circuit_is_open(&circuits, host).await.is_none());

    // Wait for potential timeout (though circuit isn't open)
    tokio::time::sleep(Duration::from_millis(150)).await;

    // Another failure should open circuit
    let opened = circuit_record_failure(&circuits, host, &config, emit.clone()).await;
    assert!(opened.is_some(), "circuit should open after second failure");
}

#[tokio::test]
async fn test_debug_info_accuracy() {
    let circuits = new_circuits();
    let config = CircuitBreakerConfig {
        max_failures: 3,
        open_duration_ms: 10_000,
    };
    let (_, emit) = create_telemetry_sink();
    let host1 = "api.example.com";
    let host2 = "api.backup.com";

    // Host1: open circuit (3 failures)
    for _ in 0..3 {
        circuit_record_failure(&circuits, host1, &config, emit.clone()).await;
    }

    // Host2: degraded (1 failure)
    circuit_record_failure(&circuits, host2, &config, emit.clone()).await;

    // Get debug info
    let debug_info = get_circuit_debug_info(&circuits).await;

    assert_eq!(debug_info.len(), 2, "should have 2 hosts");

    let host1_info = debug_info
        .iter()
        .find(|i| i.host == host1)
        .expect("host1 should be present");
    assert_eq!(host1_info.state, "open", "host1 should be open");
    assert_eq!(host1_info.consecutive_failures, 3);
    assert!(
        host1_info.opened_until_ms.is_some(),
        "opened_until_ms should be set"
    );
    assert_eq!(host1_info.total_failures, 3);

    let host2_info = debug_info
        .iter()
        .find(|i| i.host == host2)
        .expect("host2 should be present");
    assert_eq!(host2_info.state, "degraded", "host2 should be degraded");
    assert_eq!(host2_info.consecutive_failures, 1);
    assert!(
        host2_info.opened_until_ms.is_none(),
        "should not have opened_until_ms"
    );
    assert_eq!(host2_info.total_failures, 1);
}

#[tokio::test]
async fn test_telemetry_events_include_metadata() {
    let circuits = new_circuits();
    let config = CircuitBreakerConfig {
        max_failures: 2,
        open_duration_ms: 5_000,
    };
    let (events, emit) = create_telemetry_sink();
    let host = "api.example.com";

    // Open circuit
    for _ in 0..2 {
        circuit_record_failure(&circuits, host, &config, emit.clone()).await;
    }

    tokio::time::sleep(Duration::from_millis(10)).await;
    let events_guard = events.read().await;
    let open_event = events_guard
        .iter()
        .find(|(event, _)| event == "circuit-open")
        .expect("circuit-open event should exist");

    let data = &open_event.1;
    assert_eq!(data["host"], host, "event should include host");
    assert_eq!(
        data["consecutiveFailures"], 2,
        "event should include failure count"
    );
    assert_eq!(
        data["openDurationMs"], 5_000,
        "event should include open duration"
    );
    assert!(
        data["totalFailures"].is_number(),
        "event should include total failures"
    );
}

#[tokio::test]
async fn test_success_resets_degraded_state() {
    let circuits = new_circuits();
    let config = CircuitBreakerConfig {
        max_failures: 3,
        open_duration_ms: 5_000,
    };
    let (events, emit) = create_telemetry_sink();
    let host = "api.example.com";

    // Cause 2 failures (degraded, not open)
    for _ in 0..2 {
        circuit_record_failure(&circuits, host, &config, emit.clone()).await;
    }

    // Success should reset
    circuit_record_success(&circuits, host, emit.clone()).await;

    // Verify state reset
    let guard = circuits.read().await;
    let state = guard.get(host).expect("state should exist");
    assert_eq!(
        state.consecutive_failures, 0,
        "consecutive failures should be 0"
    );
    assert_eq!(state.total_successes, 1, "total successes should be 1");

    // Verify telemetry emitted (degraded → healthy transition)
    tokio::time::sleep(Duration::from_millis(10)).await;
    let events_guard = events.read().await;
    let close_events: Vec<_> = events_guard
        .iter()
        .filter(|(event, _)| event == "circuit-close")
        .collect();
    assert_eq!(
        close_events.len(),
        1,
        "should emit circuit-close for degraded→healthy transition"
    );
}

#[tokio::test]
async fn test_concurrent_access_no_race_conditions() {
    let circuits = new_circuits();
    let config = CircuitBreakerConfig {
        max_failures: 10,
        open_duration_ms: 1_000,
    };
    let (_, emit) = create_telemetry_sink();
    let host = "api.example.com";

    // Spawn 20 concurrent tasks recording failures
    let mut handles = vec![];
    for _ in 0..20 {
        let circuits_clone = circuits.clone();
        let config_clone = config.clone();
        let emit_clone = emit.clone();
        let host_clone = host.to_string();
        handles.push(tokio::spawn(async move {
            circuit_record_failure(&circuits_clone, &host_clone, &config_clone, emit_clone).await;
        }));
    }

    // Wait for all tasks
    for handle in handles {
        handle.await.expect("task should complete");
    }

    // Verify state is consistent
    let guard = circuits.read().await;
    let state = guard.get(host).expect("state should exist");
    assert_eq!(state.total_failures, 20, "all failures should be recorded");
    assert!(
        state.consecutive_failures <= 20,
        "consecutive failures should not exceed total"
    );
}

#[tokio::test]
async fn test_multiple_hosts_independent() {
    let circuits = new_circuits();
    let config = CircuitBreakerConfig {
        max_failures: 2,
        open_duration_ms: 5_000,
    };
    let (_, emit) = create_telemetry_sink();
    let host1 = "api.example.com";
    let host2 = "api.backup.com";

    // Open circuit for host1
    for _ in 0..2 {
        circuit_record_failure(&circuits, host1, &config, emit.clone()).await;
    }

    // host2 should still be healthy
    assert!(
        circuit_is_open(&circuits, host1).await.is_some(),
        "host1 should be open"
    );
    assert!(
        circuit_is_open(&circuits, host2).await.is_none(),
        "host2 should be closed"
    );

    // Record success for host2
    circuit_record_success(&circuits, host2, emit.clone()).await;

    // host1 should still be open
    assert!(
        circuit_is_open(&circuits, host1).await.is_some(),
        "host1 should remain open"
    );
}
