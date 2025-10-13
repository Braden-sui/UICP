#![cfg(all(feature = "wasm_compute", feature = "uicp_wasi_enable"))]

use serde_json::{json, Value};
use uicp::{
    test_support::ComputeTestHarness, ComputeCapabilitiesSpec, ComputeJobSpec,
    ComputeProvenanceSpec,
};

fn make_job(job_id: &str, env_hash: &str, fuel: Option<u64>) -> ComputeJobSpec {
    ComputeJobSpec {
        job_id: job_id.to_string(),
        task: "table.query@0.1.0".into(),
        input: json!({
            "rows": [
                ["bob", "25"],
                ["alice", "30"],
                ["carl", "22"],
            ],
            "select": [1, 0],
        }),
        timeout_ms: Some(10_000),
        fuel,
        mem_limit_mb: None,
        bind: vec![],
        cache: "disabled".into(),
        capabilities: ComputeCapabilitiesSpec::default(),
        replayable: true,
        workspace_id: "default".into(),
        provenance: ComputeProvenanceSpec {
            env_hash: env_hash.to_string(),
            agent_trace_id: None,
        },
    }
}

fn ensure_success(final_ev: &Value) -> &serde_json::Map<String, Value> {
    assert_eq!(final_ev.get("ok").and_then(|v| v.as_bool()), Some(true));
    assert!(
        final_ev.get("code").is_none(),
        "unexpected failure code: {final_ev:?}"
    );
    final_ev
        .get("metrics")
        .and_then(|m| m.as_object())
        .expect("metrics object")
}

#[tokio::test]
async fn deterministic_runs_match_for_same_env_hash() {
    let harness = ComputeTestHarness::new().expect("harness");

    let job_spec = make_job(
        "00000000-0000-4000-8000-0000000000aa",
        "seed-env",
        Some(200_000),
    );

    let first = harness
        .run_job(job_spec.clone())
        .await
        .expect("first run should succeed");
    let first_metrics = ensure_success(&first);
    let first_output = first.get("output").expect("first output present").clone();
    let hash1 = first_metrics
        .get("outputHash")
        .and_then(|v| v.as_str())
        .expect("first output hash")
        .to_string();
    let fuel1 = first_metrics
        .get("fuelUsed")
        .and_then(|v| v.as_u64())
        .expect("fuelUsed present when fuel configured");
    let rng1 = first_metrics
        .get("rngSeedHex")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .expect("rngSeedHex present");

    let second = harness
        .run_job(job_spec)
        .await
        .expect("second run should succeed");
    let second_metrics = ensure_success(&second);
    let second_output = second.get("output").expect("second output present").clone();
    let hash2 = second_metrics
        .get("outputHash")
        .and_then(|v| v.as_str())
        .expect("second output hash")
        .to_string();
    let fuel2 = second_metrics
        .get("fuelUsed")
        .and_then(|v| v.as_u64())
        .expect("fuelUsed present when fuel configured");
    let rng2 = second_metrics
        .get("rngSeedHex")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .expect("rngSeedHex present");

    assert_eq!(first_output, second_output, "outputs should match");
    assert_eq!(hash1, hash2, "output hash must match");
    assert_eq!(fuel1, fuel2, "fuelUsed must match");
    assert_eq!(rng1, rng2, "rngSeedHex should match for identical env hash");
}

#[tokio::test]
async fn different_env_hash_changes_seed_dependent_output() {
    let harness = ComputeTestHarness::new().expect("harness");

    let base_job = make_job(
        "00000000-0000-4000-8000-0000000000bb",
        "env-a",
        Some(200_000),
    );
    let mut variant_job = base_job.clone();
    variant_job.provenance.env_hash = "env-b".into();

    let first = harness
        .run_job(base_job)
        .await
        .expect("base run should succeed");
    let first_metrics = ensure_success(&first);
    let hash1 = first_metrics
        .get("outputHash")
        .and_then(|v| v.as_str())
        .expect("first output hash");
    let rng1 = first_metrics
        .get("rngSeedHex")
        .and_then(|v| v.as_str())
        .expect("first rngSeedHex");

    let second = harness
        .run_job(variant_job)
        .await
        .expect("variant run should succeed");
    let second_metrics = ensure_success(&second);
    let hash2 = second_metrics
        .get("outputHash")
        .and_then(|v| v.as_str())
        .expect("second output hash");
    let rng2 = second_metrics
        .get("rngSeedHex")
        .and_then(|v| v.as_str())
        .expect("second rngSeedHex");

    assert_ne!(rng1, rng2, "env hash must alter derived rng seed");
    if hash1 == hash2 {
        let fuel1 = first_metrics.get("fuelUsed").and_then(|v| v.as_u64());
        let fuel2 = second_metrics.get("fuelUsed").and_then(|v| v.as_u64());
        assert_ne!(
            fuel1, fuel2,
            "at least one metric should reflect seed change"
        );
    }
}
