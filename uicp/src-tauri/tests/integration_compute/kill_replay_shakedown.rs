//! Kill/replay shakedown: run a real compute job, simulate a host restart, and ensure replay hits
//! the cache with identical output hashes and no orphaned temp files.

#![cfg(all(
    feature = "wasm_compute",
    feature = "uicp_wasi_enable",
    feature = "compute_harness"
))]
// WHY: Replay shakedown requires the full harness stack (mock runtime + Wasm compute).

use serde_json::json;
use std::sync::Once;
use uicp::{
    test_support::ComputeTestHarness, ComputeCapabilitiesSpec, ComputeJobSpec,
    ComputeProvenanceSpec,
};
use uuid::Uuid;

fn skip_contract_verify() {
    static INIT: Once = Once::new();
    INIT.call_once(|| std::env::set_var("UICP_SKIP_CONTRACT_VERIFY", "1"));
}

fn build_job(job_id: &str, env_hash: &str) -> ComputeJobSpec {
    ComputeJobSpec {
        job_id: job_id.to_string(),
        task: "csv.parse@1.2.0".into(),
        input: json!({
            "source": "data:text/csv,a,b\n1,2\n3,4",
            "hasHeader": true
        }),
        timeout_ms: Some(30_000),
        fuel: None,
        mem_limit_mb: None,
        bind: vec![],
        cache: "readwrite".into(),
        capabilities: ComputeCapabilitiesSpec::default(),
        replayable: true,
        workspace_id: "default".into(),
        provenance: ComputeProvenanceSpec {
            env_hash: env_hash.to_string(),
            agent_trace_id: None,
        },
        token: None,
        golden_key: None,
        artifact_id: None,
        expect_golden: false,
    }
}

#[tokio::test]
async fn kill_replay_produces_identical_output_hash() {
    skip_contract_verify();
    // Skip if module absent or component not loadable
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    if let Ok(Some(m)) = uicp::registry::find_module(&app.handle(), "csv.parse@1.2.0") {
        let mut cfg = wasmtime::Config::new();
        cfg.wasm_component_model(true);
        let engine = wasmtime::Engine::new(&cfg).expect("engine");
        if wasmtime::component::Component::from_file(&engine, &m.path).is_err() {
            tracing::warn!("skipping kill/replay (component not loadable)");
            return;
        }
    } else {
        tracing::warn!("skipping kill/replay (csv.parse module not available)");
        return;
    }

    let harness = ComputeTestHarness::new_async()
        .await
        .expect("compute harness");
    let data_dir = harness.workspace_dir().to_path_buf();

    let job_spec = build_job(&Uuid::new_v4().to_string(), "replay-env");

    let first_final = harness
        .run_job(job_spec.clone())
        .await
        .expect("first run should succeed");
    let metrics1 = first_final
        .get("metrics")
        .and_then(|m| m.as_object())
        .expect("first run metrics");
    let hash1 = metrics1
        .get("outputHash")
        .and_then(|v| v.as_str())
        .expect("first output hash");

    drop(harness); // simulate host shutdown

    let harness_restarted = ComputeTestHarness::with_data_dir_async(&data_dir)
        .await
        .expect("restart harness on same data dir");
    let second_final = harness_restarted
        .run_job(job_spec)
        .await
        .expect("replay run should succeed");

    let metrics2 = second_final
        .get("metrics")
        .and_then(|m| m.as_object())
        .expect("replay metrics");
    let hash2 = metrics2
        .get("outputHash")
        .and_then(|v| v.as_str())
        .expect("replay output hash");

    assert_eq!(
        hash1, hash2,
        "replayed job must produce identical output hash"
    );
    assert!(
        metrics2
            .get("cacheHit")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        "replay should be served from cache"
    );

    let files_dir = data_dir.join("files");
    if files_dir.exists() {
        let orphaned: Vec<_> = std::fs::read_dir(&files_dir)
            .expect("scan files dir")
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .map(|name| name.starts_with("tmp") || name.starts_with(".tmp"))
                    .unwrap_or(false)
            })
            .collect();
        assert!(
            orphaned.is_empty(),
            "no orphaned temp files after replay: {:?}",
            orphaned
        );
    }
}
