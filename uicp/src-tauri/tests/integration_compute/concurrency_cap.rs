//! Concurrency cap enforcement proof test.
//! AC: With cap N=2, prove two jobs run concurrently and a third queues; record queue_time.

// WHY: Harness-backed compute tests require the mock runtime (compute_harness) plus the wasm runtime.
#[cfg(all(
    feature = "wasm_compute",
    feature = "uicp_wasi_enable",
    feature = "compute_harness"
))]
mod wasm_tests {
    use serde_json::json;
    use std::sync::Once;
    use uicp::registry;
    use uicp::{
        test_support::ComputeTestHarness, ComputeCapabilitiesSpec, ComputeJobSpec,
        ComputeProvenanceSpec,
    };
    use uuid::Uuid;

    fn skip_contract_verify() {
        static INIT: Once = Once::new();
        INIT.call_once(|| std::env::set_var("UICP_SKIP_CONTRACT_VERIFY", "1"));
    }

    fn make_job(job_id: &str, env_hash: &str, source_rows: usize) -> ComputeJobSpec {
        let rows = (0..source_rows)
            .map(|i| format!("{},{}", i, source_rows - i))
            .collect::<Vec<String>>()
            .join("\n");
        let csv = format!("a,b\n{}", rows);

        ComputeJobSpec {
            job_id: job_id.to_string(),
            task: "csv.parse@1.2.0".into(),
            input: json!({
                "source": format!("data:text/csv,{}", csv),
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
        }
    }

    #[tokio::test]
    async fn concurrency_cap_enforces_queue_with_n_equals_2() {
        skip_contract_verify();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        if let Ok(Some(m)) = registry::find_module(&app.handle(), "csv.parse@1.2.0") {
            // Preflight: ensure component parses on this host (skip if translation fails)
            let mut cfg = wasmtime::Config::new();
            cfg.wasm_component_model(true);
            let engine = wasmtime::Engine::new(&cfg).expect("engine");
            if wasmtime::component::Component::from_file(&engine, &m.path).is_err() {
                eprintln!("skipping concurrency cap (component not loadable)");
                return;
            }
        } else {
            eprintln!("skipping concurrency cap (csv.parse module not available)");
            return;
        }
        let harness = ComputeTestHarness::new_async()
            .await
            .expect("compute harness");

        // WHY: Warm Wasmtime caches so queueing assertions are not skewed by first-run JIT time.
        let warmup = make_job(&Uuid::new_v4().to_string(), "warmup-env", 8);
        let _ = harness
            .run_job(warmup)
            .await
            .expect("warmup job to complete");

        // Slow each compute job to create overlap so the third must wait for a permit.
        std::env::set_var("UICP_TEST_COMPUTE_DELAY_MS", "150");

        let job1 = make_job(&Uuid::new_v4().to_string(), "env-1", 400);
        let job2 = make_job(&Uuid::new_v4().to_string(), "env-2", 400);
        let job3 = make_job(&Uuid::new_v4().to_string(), "env-3", 400);

        let (res1, res2, res3): (
            anyhow::Result<serde_json::Value>,
            anyhow::Result<serde_json::Value>,
            anyhow::Result<serde_json::Value>,
        ) = tokio::join!(
            harness.run_job(job1),
            harness.run_job(job2),
            harness.run_job(job3)
        );

        std::env::remove_var("UICP_TEST_COMPUTE_DELAY_MS");

        let final1 = res1.expect("job1 result");
        let final2 = res2.expect("job2 result");
        let final3 = res3.expect("job3 result");

        assert!(
            final1.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
            "job1 should succeed"
        );
        assert!(
            final2.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
            "job2 should succeed"
        );
        assert!(
            final3.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
            "job3 should succeed"
        );

        let queue1 = final1
            .get("metrics")
            .and_then(|m| m.get("queueMs"))
            .and_then(|v| v.as_u64())
            .expect("job1 queueMs");
        let queue2 = final2
            .get("metrics")
            .and_then(|m| m.get("queueMs"))
            .and_then(|v| v.as_u64())
            .expect("job2 queueMs");
        let queue3 = final3
            .get("metrics")
            .and_then(|m| m.get("queueMs"))
            .and_then(|v| v.as_u64())
            .expect("job3 queueMs");

        // WHY: Tokio schedules join! futures in an unspecified order; sort so assertions target whichever job actually waited.
        let mut queues = vec![("job1", queue1), ("job2", queue2), ("job3", queue3)];
        queues.sort_by_key(|(_, q)| *q);
        // INVARIANT: queues[..] sorted ascending by queue duration (fastest first, slowest last).
        let fast_queue = queues[0].1;
        let mid_queue = queues[1].1;
        let slow_queue = queues[2].1;

        let strict_timing = std::env::var("UICP_STRICT_TIMING")
            .ok()
            .map(|v| matches!(v.as_str(), "1" | "true" | "yes"))
            .unwrap_or(false);

        if strict_timing {
            assert!(
                fast_queue <= 30,
                "first permit holder should not queue significantly (strict); queues={queues:?}"
            );
            assert!(
                mid_queue <= 30,
                "second permit holder should not queue significantly (strict); queues={queues:?}"
            );
            assert!(
                slow_queue >= 120,
                "queued job should wait for permit (strict); queues={queues:?}"
            );
        } else {
            assert!(
                slow_queue > mid_queue,
                "queued job did not wait longest; queues={queues:?}"
            );
            assert!(
                slow_queue >= mid_queue + 60,
                "queued job queue delta too small (slowest={slow_queue}ms, next={mid_queue}ms; queues={queues:?})"
            );
            assert!(
                fast_queue <= 30,
                "at least one job should start without queuing; queues={queues:?}"
            );
        }
    }
}
