//! Harness-driven smoke tests that exercise real modules when present.
//! Tests are no-ops (skip) if modules are not installed.

#![cfg(all(feature = "wasm_compute", feature = "uicp_wasi_enable"))]

use serde_json::json;
use uicp::{
    registry, test_support::ComputeTestHarness, ComputeCapabilitiesSpec, ComputeJobSpec,
    ComputeProvenanceSpec,
};

#[tokio::test]
async fn csv_parse_smoke_when_module_present() {
    // Quick presence check so CI/dev without modules doesn't fail the suite.
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let found = match registry::find_module(&app.handle(), "csv.parse@1.2.0") {
        Ok(Some(_)) => true,
        _ => false,
    };
    if !found {
        eprintln!("skipping csv.parse smoke (module not present)");
        return;
    }

    let h = ComputeTestHarness::new().expect("harness");
    let spec = ComputeJobSpec {
        job_id: uuid::Uuid::new_v4().to_string(),
        task: "csv.parse@1.2.0".into(),
        input: json!({
          "source": "data:text/csv,name,age\nAlice,30\nBob,25",
          "hasHeader": true
        }),
        timeout_ms: Some(10_000),
        fuel: None,
        mem_limit_mb: Some(128),
        bind: vec![],
        cache: "readwrite".into(),
        capabilities: ComputeCapabilitiesSpec::default(),
        replayable: true,
        workspace_id: "default".into(),
        provenance: ComputeProvenanceSpec {
            env_hash: "smoke-env".into(),
            agent_trace_id: None,
        },
    };
    let final_ev = h.run_job(spec).await.expect("final event");
    assert_eq!(final_ev.get("ok").and_then(|v| v.as_bool()), Some(true));
}

#[tokio::test]
async fn table_query_smoke_when_module_present() {
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let found = match registry::find_module(&app.handle(), "table.query@0.1.0") {
        Ok(Some(_)) => true,
        _ => false,
    };
    if !found {
        eprintln!("skipping table.query smoke (module not present)");
        return;
    }

    let h = ComputeTestHarness::new().expect("harness");
    let spec = ComputeJobSpec {
        job_id: uuid::Uuid::new_v4().to_string(),
        task: "table.query@0.1.0".into(),
        input: json!({
          "rows": [["a","b"],["c","d"],["ax","y"]],
          "select": [0],
          "where_contains": {"col": 0, "needle": "a"}
        }),
        timeout_ms: Some(10_000),
        fuel: None,
        mem_limit_mb: Some(128),
        bind: vec![],
        cache: "readwrite".into(),
        capabilities: ComputeCapabilitiesSpec::default(),
        replayable: true,
        workspace_id: "default".into(),
        provenance: ComputeProvenanceSpec {
            env_hash: "smoke-env".into(),
            agent_trace_id: None,
        },
    };
    let final_ev = h.run_job(spec).await.expect("final event");
    assert_eq!(final_ev.get("ok").and_then(|v| v.as_bool()), Some(true));
}
