//! applet.quickjs integration tests (JS execution via WASI).
//! Validates end-to-end: bundled JS → base64 env var → QuickJS eval → script interface.

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

/// Minimal JS applet that implements init/render/onEvent.
const BUNDLED_JS_EXAMPLE: &str = r#"(() => {
  const exports = {};
  const module = { exports };
  
  // Simple counter applet implementation
  const applet = {
    init: function() {
      return JSON.stringify({ count: 0 });
    },
    render: function(state) {
      const model = JSON.parse(state || "{}");
      const count = model.count || 0;
      return `<div class="counter">
        <h2>Count: ${count}</h2>
        <button data-command='{"type":"script.emit","action":"increment","payload":{}}'>+</button>
        <button data-command='{"type":"script.emit","action":"decrement","payload":{}}'>-</button>
      </div>`;
    },
    onEvent: function(action, payload, state) {
      const model = JSON.parse(state || "{}");
      let count = model.count || 0;
      
      if (action === "increment") {
        count += 1;
      } else if (action === "decrement") {
        count -= 1;
      }
      
      return JSON.stringify({ next_state: JSON.stringify({ count }) });
    }
  };
  
  module.exports = applet;
  const result = module.exports?.default ?? module.exports;
  if (!result || typeof result !== 'object') {
    throw new Error('Applet bundle must export an object (default or module.exports).');
  }
  globalThis.__uicpApplet = result;
})();"#;

#[test]
fn quickjs_preflight_allows_empty_imports() {
    skip_contract_verify();
    let module = modules_dir().join("applet.quickjs@0.1.0.wasm");
    if !module.exists() {
        eprintln!("skipping applet.quickjs preflight test (module missing)");
        return;
    }
    preflight_component_imports(&module, "applet.quickjs@0.1.0").expect("quickjs.preflight");
}

#[tokio::test]
async fn quickjs_init_returns_initial_state() {
    skip_contract_verify();
    std::env::set_var("UICP_MODULES_DIR", modules_dir());

    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();

    let found = match registry::find_module(&app.handle(), "applet.quickjs@0.1.0") {
        Ok(Some(m)) => {
            let mut cfg = wasmtime::Config::new();
            cfg.wasm_component_model(true);
            let engine = wasmtime::Engine::new(&cfg).expect("engine");
            match wasmtime::component::Component::from_file(&engine, &m.path) {
                Ok(_) => true,
                Err(e) => {
                    eprintln!("skipping applet.quickjs smoke (component not loadable): {e}");
                    false
                }
            }
        }
        _ => false,
    };

    if !found {
        eprintln!("skipping applet.quickjs smoke (module not present)");
        return;
    }

    let h = ComputeTestHarness::new_async().await.expect("harness");
    let spec = ComputeJobSpec {
        job_id: uuid::Uuid::new_v4().to_string(),
        task: "applet.quickjs@0.1.0".into(),
        input: json!({
            "mode": "init",
            "source": BUNDLED_JS_EXAMPLE
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
            env_hash: "quickjs-init-test".into(),
            agent_trace_id: None,
        },
        golden_key: None,
        artifact_id: None,
        expect_golden: false,
    };

    let final_ev = h.run_job(spec).await.expect("final event");
    assert_eq!(final_ev.get("ok").and_then(|v| v.as_bool()), Some(true));

    let out = final_ev.get("output").cloned().unwrap_or_default();
    let mode = out.get("mode").and_then(|v| v.as_str()).unwrap_or_default();
    let data = out.get("data").and_then(|v| v.as_str()).unwrap_or_default();

    assert_eq!(mode, "init");
    assert!(data.contains("count"));
    let state: serde_json::Value = serde_json::from_str(data).expect("parse init state");
    assert_eq!(state.get("count"), Some(&json!(0)));
}

#[tokio::test]
async fn quickjs_render_produces_html() {
    skip_contract_verify();
    std::env::set_var("UICP_MODULES_DIR", modules_dir());

    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();

    if registry::find_module(&app.handle(), "applet.quickjs@0.1.0")
        .ok()
        .flatten()
        .is_none()
    {
        eprintln!("skipping applet.quickjs render test (module not present)");
        return;
    }

    let h = ComputeTestHarness::new_async().await.expect("harness");
    let spec = ComputeJobSpec {
        job_id: uuid::Uuid::new_v4().to_string(),
        task: "applet.quickjs@0.1.0".into(),
        input: json!({
            "mode": "render",
            "state": r#"{"count":5}"#,
            "source": BUNDLED_JS_EXAMPLE
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
            env_hash: "quickjs-render-test".into(),
            agent_trace_id: None,
        },
        golden_key: None,
        artifact_id: None,
        expect_golden: false,
    };

    let final_ev = h.run_job(spec).await.expect("final event");
    assert_eq!(final_ev.get("ok").and_then(|v| v.as_bool()), Some(true));

    let out = final_ev.get("output").cloned().unwrap_or_default();
    let mode = out.get("mode").and_then(|v| v.as_str()).unwrap_or_default();
    let data = out.get("data").and_then(|v| v.as_str()).unwrap_or_default();

    assert_eq!(mode, "render");
    assert!(data.contains("<div class=\"counter\">"));
    assert!(data.contains("Count: 5"));
    assert!(data.contains("data-command"));
}

#[tokio::test]
async fn quickjs_on_event_updates_state() {
    skip_contract_verify();
    std::env::set_var("UICP_MODULES_DIR", modules_dir());

    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();

    if registry::find_module(&app.handle(), "applet.quickjs@0.1.0")
        .ok()
        .flatten()
        .is_none()
    {
        eprintln!("skipping applet.quickjs onEvent test (module not present)");
        return;
    }

    let h = ComputeTestHarness::new_async().await.expect("harness");
    let spec = ComputeJobSpec {
        job_id: uuid::Uuid::new_v4().to_string(),
        task: "applet.quickjs@0.1.0".into(),
        input: json!({
            "mode": "on-event",
            "action": "increment",
            "payload": "{}",
            "state": r#"{"count":10}"#,
            "source": BUNDLED_JS_EXAMPLE
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
            env_hash: "quickjs-event-test".into(),
            agent_trace_id: None,
        },
        golden_key: None,
        artifact_id: None,
        expect_golden: false,
    };

    let final_ev = h.run_job(spec).await.expect("final event");
    assert_eq!(final_ev.get("ok").and_then(|v| v.as_bool()), Some(true));

    let out = final_ev.get("output").cloned().unwrap_or_default();
    let mode = out.get("mode").and_then(|v| v.as_str()).unwrap_or_default();
    let data = out.get("data").and_then(|v| v.as_str()).unwrap_or_default();

    assert_eq!(mode, "on-event");
    let result: serde_json::Value = serde_json::from_str(data).expect("parse onEvent result");
    let next_state_str = result.get("next_state").and_then(|v| v.as_str()).unwrap();
    let next_state: serde_json::Value =
        serde_json::from_str(next_state_str).expect("parse next_state");

    assert_eq!(next_state.get("count"), Some(&json!(11)));
}

#[tokio::test]
async fn quickjs_rejects_missing_source() {
    skip_contract_verify();
    std::env::set_var("UICP_MODULES_DIR", modules_dir());

    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();

    if registry::find_module(&app.handle(), "applet.quickjs@0.1.0")
        .ok()
        .flatten()
        .is_none()
    {
        eprintln!("skipping applet.quickjs validation test (module not present)");
        return;
    }

    let h = ComputeTestHarness::new_async().await.expect("harness");
    let spec = ComputeJobSpec {
        job_id: uuid::Uuid::new_v4().to_string(),
        task: "applet.quickjs@0.1.0".into(),
        input: json!({
            "mode": "init"
            // Missing source field
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
            env_hash: "quickjs-missing-source-test".into(),
            agent_trace_id: None,
        },
        golden_key: None,
        artifact_id: None,
        expect_golden: false,
    };

    let final_ev = h.run_job(spec).await.expect("final event");
    assert_eq!(final_ev.get("ok").and_then(|v| v.as_bool()), Some(false));

    let error_msg = final_ev
        .get("error")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    assert!(error_msg.contains("E-UICP-0604"));
    assert!(error_msg.contains("bundled JS source"));
}
