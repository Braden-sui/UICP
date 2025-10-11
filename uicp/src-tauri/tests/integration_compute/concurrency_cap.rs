//! Concurrency cap enforcement proof test.
//! AC: With cap N=2, prove two jobs run concurrently and a third queues; record queue_time.

#[cfg(all(feature = "wasm_compute", feature = "uicp_wasi_enable"))]
mod wasm_tests {
    use serde_json::json;
    use uicp::{
        test_support::ComputeTestHarness, ComputeCapabilitiesSpec, ComputeJobSpec,
        ComputeProvenanceSpec,
    };
    use uuid::Uuid;

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
        // Slow each compute job to create overlap so the third must wait for a permit.
        std::env::set_var("UICP_TEST_COMPUTE_DELAY_MS", "150");
        let harness = ComputeTestHarness::new().expect("compute harness");

        let job1 = make_job(&Uuid::new_v4().to_string(), "env-1", 400);
        let job2 = make_job(&Uuid::new_v4().to_string(), "env-2", 400);
        let job3 = make_job(&Uuid::new_v4().to_string(), "env-3", 400);

        let (res1, res2, res3) = tokio::join!(
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

        assert!(
            queue1 <= 30,
            "job1 should not queue significantly, observed {queue1}ms"
        );
        assert!(
            queue2 <= 30,
            "job2 should not queue significantly, observed {queue2}ms"
        );
        assert!(
            queue3 >= 120,
            "job3 should wait for permit, observed {queue3}ms"
        );
    }
}
