#![cfg(all(
    feature = "wasm_compute",
    feature = "uicp_wasi_enable",
    feature = "compute_harness"
))]

use serde_json::json;
use uicp::{
    test_support::ComputeTestHarness, ComputeCapabilitiesSpec, ComputeJobSpec, ComputeProvenanceSpec,
};
use uuid::Uuid;

fn allowed_net() -> Vec<String> {
    vec!["https://api.openai.com".to_string()]
}

fn mock_ts_ok() -> serde_json::Value {
    json!({
        "code": r#"
export function render() {
  return { html: "<div>mock</div>" };
}
export function onEvent(action, payload, state) {
  return { next_state: "{}" };
}
"#,
        "language": "ts",
        "meta": {"provider": "mock"}
    })
}

fn mock_ts_unsafe() -> serde_json::Value {
    json!({
        "code": r#"
export function render() {
  fetch("https://example.com");
  return { html: "<div>bad</div>" };
}
export function onEvent(action, payload, state) {
  return { next_state: "{}" };
}
"#,
        "language": "ts",
        "meta": {"provider": "mock"}
    })
}

#[tokio::test]
async fn codegen_mock_success_and_golden_replay() {
    let prev_jail = std::env::var("UICP_HTTPJAIL").ok();
    std::env::set_var("UICP_HTTPJAIL", "1");

    let harness = ComputeTestHarness::new_async()
        .await
        .expect("compute harness");

    let job_id1 = Uuid::new_v4().to_string();
    let spec1 = ComputeJobSpec {
        job_id: job_id1,
        task: "codegen.run@0.1.0".into(),
        input: json!({
            "spec": "generate a component",
            "language": "ts",
            "constraints": { "mockResponse": mock_ts_ok() }
        }),
        timeout_ms: Some(10_000),
        fuel: None,
        mem_limit_mb: None,
        bind: vec![],
        cache: "none".into(),
        capabilities: ComputeCapabilitiesSpec {
            net: allowed_net(),
            ..ComputeCapabilitiesSpec::default()
        },
        replayable: true,
        workspace_id: "default".into(),
        provenance: ComputeProvenanceSpec {
            env_hash: "codegen-golden-test".into(),
            agent_trace_id: None,
        },
        token: None,
        golden_key: None,
        artifact_id: None,
        expect_golden: false,
    };

    let final1 = harness.run_job(spec1).await.expect("final");
    assert_eq!(final1.get("ok").and_then(|v| v.as_bool()), Some(true));
    let metrics1 = final1.get("metrics").cloned().unwrap_or_default();
    assert_eq!(metrics1.get("goldenMatched").and_then(|v| v.as_bool()), Some(true));

    let job_id2 = Uuid::new_v4().to_string();
    let spec2 = ComputeJobSpec {
        job_id: job_id2,
        task: "codegen.run@0.1.0".into(),
        input: json!({
            "spec": "generate a component",
            "language": "ts",
            "constraints": { "mockResponse": mock_ts_ok() }
        }),
        timeout_ms: Some(10_000),
        fuel: None,
        mem_limit_mb: None,
        bind: vec![],
        cache: "none".into(),
        capabilities: ComputeCapabilitiesSpec {
            net: allowed_net(),
            ..ComputeCapabilitiesSpec::default()
        },
        replayable: true,
        workspace_id: "default".into(),
        provenance: ComputeProvenanceSpec {
            env_hash: "codegen-golden-test".into(),
            agent_trace_id: None,
        },
        token: None,
        golden_key: None,
        artifact_id: None,
        expect_golden: false,
    };

    let final2 = harness.run_job(spec2).await.expect("final");
    assert_eq!(final2.get("ok").and_then(|v| v.as_bool()), Some(true));
    let metrics2 = final2.get("metrics").cloned().unwrap_or_default();
    assert_eq!(metrics2.get("cacheHit").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(metrics2.get("durationMs").and_then(|v| v.as_u64()), Some(0));

    if let Some(v) = prev_jail { std::env::set_var("UICP_HTTPJAIL", v); } else { std::env::remove_var("UICP_HTTPJAIL"); }
}

#[tokio::test]
async fn codegen_validation_rejects_unsafe_code() {
    let harness = ComputeTestHarness::new_async()
        .await
        .expect("compute harness");

    let job = ComputeJobSpec {
        job_id: Uuid::new_v4().to_string(),
        task: "codegen.run@0.1.0".into(),
        input: json!({
            "spec": "generate a component (unsafe)",
            "language": "ts",
            "constraints": { "mockResponse": mock_ts_unsafe() }
        }),
        timeout_ms: Some(10_000),
        fuel: None,
        mem_limit_mb: None,
        bind: vec![],
        cache: "none".into(),
        capabilities: ComputeCapabilitiesSpec {
            net: allowed_net(),
            ..ComputeCapabilitiesSpec::default()
        },
        replayable: false,
        workspace_id: "default".into(),
        provenance: ComputeProvenanceSpec {
            env_hash: "codegen-unsafe-test".into(),
            agent_trace_id: None,
        },
        token: None,
        golden_key: None,
        artifact_id: None,
        expect_golden: false,
    };

    let final_ev = harness.run_job(job).await.expect("final");
    assert_eq!(final_ev.get("ok").and_then(|v| v.as_bool()), Some(false));
    assert_eq!(final_ev.get("code").and_then(|v| v.as_str()), Some("Compute.Input.Invalid"));
}

#[tokio::test]
async fn compute_readonly_cache_miss_fails() {
    let harness = ComputeTestHarness::new_async()
        .await
        .expect("compute harness");

    let job = ComputeJobSpec {
        job_id: Uuid::new_v4().to_string(),
        task: "codegen.run@0.1.0".into(),
        input: json!({
            "spec": "anything",
            "language": "ts",
            "constraints": { "temperature": 0.1 }
        }),
        timeout_ms: Some(5_000),
        fuel: None,
        mem_limit_mb: None,
        bind: vec![],
        cache: "readonly".into(),
        capabilities: ComputeCapabilitiesSpec {
            net: allowed_net(),
            ..ComputeCapabilitiesSpec::default()
        },
        replayable: true,
        workspace_id: "default".into(),
        provenance: ComputeProvenanceSpec {
            env_hash: format!("readonly-miss-{}", Uuid::new_v4()),
            agent_trace_id: None,
        },
        token: None,
        golden_key: None,
        artifact_id: None,
        expect_golden: false,
    };

    let final_ev = harness.run_job(job).await.expect("final");
    assert_eq!(final_ev.get("ok").and_then(|v| v.as_bool()), Some(false));
    assert_eq!(final_ev.get("code").and_then(|v| v.as_str()), Some("Runtime.Fault"));
    let msg = final_ev.get("message").and_then(|v| v.as_str()).unwrap_or("");
    assert!(msg.contains("Cache miss under ReadOnly cache policy"));
}
