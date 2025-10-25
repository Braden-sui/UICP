use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::core::{CircuitBreakerConfig, CircuitState};

// ----------------------------------------------------------------------------
// Circuit breaker state transitions with telemetry
// ----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CircuitDebugInfo {
    pub host: String,
    pub consecutive_failures: u8,
    pub opened_until_ms: Option<u64>,
    pub last_failure_ms_ago: Option<u64>,
    pub total_failures: u64,
    pub total_successes: u64,
    pub state: String,
    pub half_open_probe_in_flight: bool,
}

/// Check if circuit is open for the given host.
/// Returns Some(until) if circuit is open, None if closed or half-open.
///
/// WHY: Fast-path read avoids write lock contention under load.
/// INVARIANT: Expired circuits are lazily cleared on next write operation.
pub async fn circuit_is_open(
    circuits: &Arc<RwLock<HashMap<String, CircuitState>>>,
    host: &str,
) -> Option<Instant> {
    let now = Instant::now();
    {
        let guard = circuits.read().await;
        if let Some(state) = guard.get(host) {
            if let Some(until) = state.opened_until {
                if now < until {
                    return Some(until);
                }
            }
            if state.half_open {
                return None;
            }
        }
    }
    // Upgrade to write only to clear expired state
    let mut guard = circuits.write().await;
    if let Some(state) = guard.get_mut(host) {
        if let Some(until) = state.opened_until {
            if now >= until {
                state.opened_until = None;
                state.consecutive_failures = 0;
                state.half_open = true;
                state.half_open_probe_in_flight = false;
            } else {
                return Some(until);
            }
        }
    }
    None
}

/// Record successful request and reset circuit state.
/// Emits circuit.close telemetry event if circuit was previously open.
pub async fn circuit_record_success(
    circuits: &Arc<RwLock<HashMap<String, CircuitState>>>,
    host: &str,
    emit_telemetry: impl Fn(&str, serde_json::Value),
) {
    let mut guard = circuits.write().await;
    let entry = guard.entry(host.to_string()).or_default();
    let was_open = entry.opened_until.is_some();
    let was_half_open = entry.half_open;
    let had_failures = entry.consecutive_failures > 0;

    if entry.half_open {
        entry.half_open = false;
        entry.half_open_probe_in_flight = false;
    }

    entry.consecutive_failures = 0;
    entry.opened_until = None;
    entry.total_successes = entry.total_successes.saturating_add(1);

    if was_half_open {
        emit_telemetry(
            "circuit-half-open-success",
            serde_json::json!({
                "host": host,
                "totalFailures": entry.total_failures,
                "totalSuccesses": entry.total_successes,
            }),
        );
    } else if was_open || had_failures {
        emit_telemetry(
            "circuit-close",
            serde_json::json!({
                "host": host,
                "totalFailures": entry.total_failures,
                "totalSuccesses": entry.total_successes,
            }),
        );
    }
}

/// Record failed request and potentially open circuit.
/// Returns Some(until) if circuit was opened, None otherwise.
/// Emits circuit.open telemetry event when threshold is reached.
pub async fn circuit_record_failure(
    circuits: &Arc<RwLock<HashMap<String, CircuitState>>>,
    host: &str,
    config: &CircuitBreakerConfig,
    emit_telemetry: impl Fn(&str, serde_json::Value),
) -> Option<Instant> {
    let mut guard = circuits.write().await;
    let entry = guard.entry(host.to_string()).or_default();
    entry.total_failures = entry.total_failures.saturating_add(1);
    entry.last_failure_at = Some(Instant::now());

    if entry.half_open {
        entry.half_open_probe_in_flight = false;
        entry.half_open = false;
        entry.consecutive_failures = config.max_failures;
        let until = Instant::now() + Duration::from_millis(config.open_duration_ms);
        entry.opened_until = Some(until);

        // Emit circuit.open event
        emit_telemetry(
            "circuit-open",
            serde_json::json!({
                "host": host,
                "consecutiveFailures": entry.consecutive_failures,
                "openDurationMs": config.open_duration_ms,
                "totalFailures": entry.total_failures,
            }),
        );

        Some(until)
    } else {
        entry.consecutive_failures = entry.consecutive_failures.saturating_add(1);
        if entry.consecutive_failures >= config.max_failures {
            let until = Instant::now() + Duration::from_millis(config.open_duration_ms);
            entry.opened_until = Some(until);
            emit_telemetry(
                "circuit-open",
                serde_json::json!({
                    "host": host,
                    "consecutiveFailures": entry.consecutive_failures,
                    "openDurationMs": config.open_duration_ms,
                    "totalFailures": entry.total_failures,
                }),
            );
            Some(until)
        } else {
            None
        }
    }
}

/// Get debug information for all circuit breakers.
/// Used by the debug/circuits Tauri command for runtime visibility.
pub async fn get_circuit_debug_info(
    circuits: &Arc<RwLock<HashMap<String, CircuitState>>>,
) -> Vec<CircuitDebugInfo> {
    let guard = circuits.read().await;
    let now = Instant::now();

    guard
        .iter()
        .map(|(host, state)| {
            let opened_until_ms = state.opened_until.and_then(|until| {
                if until > now {
                    Some(until.saturating_duration_since(now).as_millis() as u64)
                } else {
                    None
                }
            });

            let last_failure_ms_ago = state
                .last_failure_at
                .map(|at| now.saturating_duration_since(at).as_millis() as u64);

            let state_str = if state.opened_until.is_some() && opened_until_ms.is_some() {
                "open"
            } else if state.half_open {
                "half-open"
            } else if state.consecutive_failures > 0 {
                "degraded"
            } else {
                "healthy"
            };

            CircuitDebugInfo {
                host: host.clone(),
                consecutive_failures: state.consecutive_failures,
                opened_until_ms,
                last_failure_ms_ago,
                total_failures: state.total_failures,
                total_successes: state.total_successes,
                state: state_str.to_string(),
                half_open_probe_in_flight: state.half_open_probe_in_flight,
            }
        })
        .collect()
}
