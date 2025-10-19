//! Script applet world smoke tests (skipped when module is absent).

#![cfg(all(
    feature = "wasm_compute",
    feature = "uicp_wasi_enable",
    feature = "compute_harness"
))]

use serde_json::json;
use std::path::PathBuf;
use std::sync::Once;
use uicp::{
    compute::preflight_component_imports, registry, test_support::ComputeTestHarness,
    ComputeCapabilitiesSpec, ComputeJobSpec, ComputeProvenanceSpec,
};

fn skip_contract_verify() {
    static INIT: Once = Once::new();
    INIT.call_once(|| std::env::set_var("UICP_SKIP_CONTRACT_VERIFY", "1"));
}

fn modules_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("modules")
}

#[test]
fn script_preflight_allows_empty_imports() {
    skip_contract_verify();
    let module = modules_dir().join("script.hello@0.1.0.wasm");
    if !module.exists() {
        eprintln!("skipping script preflight test (module missing)");
        return;
    }
    preflight_component_imports(&module, "script.hello@0.1.0").expect("script.preflight");
}

#[tokio::test]
async fn script_render_smoke_when_module_present() {
    skip_contract_verify();
    std::env::set_var(
        "UICP_MODULES_DIR",
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("modules"),
    );
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
    let found = match registry::find_module(&app.handle(), "script.hello@0.1.0") {
        Ok(Some(m)) => {
            let mut cfg = wasmtime::Config::new();
            cfg.wasm_component_model(true);
            let engine = wasmtime::Engine::new(&cfg).expect("engine");
            match wasmtime::component::Component::from_file(&engine, &m.path) {
                Ok(_) => true,
                Err(e) => {
                    eprintln!("skipping script.hello smoke (component not loadable): {e}");
                    false
                }
            }
        }
        _ => false,
    };
    if !found {
        eprintln!("skipping script.hello smoke (module not present)");
        return;
    }

    let h = ComputeTestHarness::new_async().await.expect("harness");
    let spec = ComputeJobSpec {
        job_id: uuid::Uuid::new_v4().to_string(),
        task: "script.hello@0.1.0".into(),
        input: json!({
          "mode": "render",
          "state": "{}"
        }),
        timeout_ms: Some(10_000),
        fuel: None,
        mem_limit_mb: Some(64),
        bind: vec![],
        cache: "readwrite".into(),
        capabilities: ComputeCapabilitiesSpec::default(),
        replayable: true,
        workspace_id: "default".into(),
        provenance: ComputeProvenanceSpec {
            env_hash: "script-smoke".into(),
            agent_trace_id: None,
        },
    };
    let final_ev = h.run_job(spec).await.expect("final event");
    assert_eq!(final_ev.get("ok").and_then(|v| v.as_bool()), Some(true));
    let out = final_ev.get("output").cloned().unwrap_or_default();
    let data = out
        .get("data")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    assert!(data.contains("<div>hello</div>"));
}

