//! Negative-path coverage for compute policy enforcement.
//! These tests exercise `enforce_compute_policy` to ensure capability
//! constraints fail loud with the expected error codes before execution.

use serde_json::json;
use uicp::{
    enforce_compute_policy, ComputeCapabilitiesSpec, ComputeJobSpec, ComputeProvenanceSpec,
};

fn base_spec() -> ComputeJobSpec {
    ComputeJobSpec {
        job_id: "00000000-0000-4000-8000-000000000001".into(),
        task: "csv.parse@1.2.0".into(),
        input: json!({"source":"data:text/csv,foo,bar","hasHeader":true}),
        timeout_ms: Some(30_000),
        fuel: None,
        mem_limit_mb: None,
        bind: vec![],
        cache: "readwrite".into(),
        capabilities: ComputeCapabilitiesSpec::default(),
        replayable: true,
        workspace_id: "default".into(),
        provenance: ComputeProvenanceSpec {
            env_hash: "test-env".into(),
            agent_trace_id: None,
        },
        token: None,
        golden_key: None,
        artifact_id: None,
        expect_golden: false,
    }
}

#[test]
fn timeout_below_minimum_is_denied() {
    let mut spec = base_spec();
    spec.timeout_ms = Some(500);
    let deny = enforce_compute_policy(&spec).expect("expected policy rejection");
    assert_eq!(deny.code, "Compute.CapabilityDenied");
    assert!(
        deny.message.contains("timeoutMs outside allowed range"),
        "unexpected message {}",
        deny.message
    );
}

#[test]
fn timeout_above_30s_requires_long_run_capability() {
    let mut spec = base_spec();
    spec.timeout_ms = Some(31_000);
    let deny = enforce_compute_policy(&spec).expect("expected policy rejection");
    assert_eq!(deny.code, "Compute.CapabilityDenied");
    assert!(
        deny.message.contains("longRun"),
        "unexpected message {}",
        deny.message
    );

    spec.capabilities.long_run = true;
    assert!(
        enforce_compute_policy(&spec).is_none(),
        "longRun capability should satisfy timeout extension"
    );
}

#[test]
fn memory_above_256_requires_mem_high_capability() {
    let mut spec = base_spec();
    spec.mem_limit_mb = Some(512);
    let deny = enforce_compute_policy(&spec).expect("expected policy rejection");
    assert_eq!(deny.code, "Compute.CapabilityDenied");
    assert!(
        deny.message.contains("memLimitMb>256"),
        "unexpected message {}",
        deny.message
    );

    spec.capabilities.mem_high = true;
    assert!(
        enforce_compute_policy(&spec).is_none(),
        "memHigh capability should satisfy elevated memory limit"
    );
}

#[test]
fn memory_outside_bounds_is_denied() {
    let mut spec_low = base_spec();
    spec_low.mem_limit_mb = Some(32);
    let deny_low = enforce_compute_policy(&spec_low).expect("expected lower-bound rejection");
    assert_eq!(deny_low.code, "Compute.CapabilityDenied");

    let mut spec_high = base_spec();
    spec_high.mem_limit_mb = Some(2_048);
    let deny_high = enforce_compute_policy(&spec_high).expect("expected upper-bound rejection");
    assert_eq!(deny_high.code, "Compute.CapabilityDenied");
}

#[test]
fn filesystem_paths_must_be_workspace_scoped() {
    let mut spec = base_spec();
    spec.capabilities.fs_read = vec!["file:/root/**".into()];
    let deny = enforce_compute_policy(&spec).expect("expected policy rejection");
    assert_eq!(deny.code, "Compute.CapabilityDenied");
    assert!(
        deny.message.contains("workspace-scoped"),
        "unexpected message {}",
        deny.message
    );
}

// NOTE: Network test removed - web browsing capability will allow network access by default.
// When that lands, update policy tests to validate allowlist/denylist behavior instead.
