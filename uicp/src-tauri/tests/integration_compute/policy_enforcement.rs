//! Policy enforcement integration tests for compute jobs.

#[cfg(all(
    feature = "wasm_compute",
    feature = "uicp_wasi_enable",
    feature = "compute_harness"
))]
mod wasm_tests {
    use serde_json::json;
    use uicp::{
        test_support::ComputeTestHarness, ComputeCapabilitiesSpec, ComputeJobSpec,
        ComputeProvenanceSpec,
    };
    use uuid::Uuid;

    fn make_denied_codegen_job() -> ComputeJobSpec {
        let job_id = Uuid::new_v4().to_string();
        let mock_response = json!({
            "code": "export const render = () => ({ html: '<div>mock</div>' });\nexport const onEvent = () => ({ next_state: '{}' });",
            "language": "ts",
            "meta": { "provider": "mock" }
        });
        ComputeJobSpec {
            job_id,
            task: "codegen.run@0.1.0".into(),
            input: json!({
                "spec": "generate a component",
                "language": "ts",
                "constraints": { "mockResponse": mock_response }
            }),
            timeout_ms: Some(5_000),
            fuel: None,
            mem_limit_mb: None,
            bind: vec![],
            cache: "none".into(),
            capabilities: ComputeCapabilitiesSpec {
                net: vec!["https://evil.example.com".into()],
                ..ComputeCapabilitiesSpec::default()
            },
            replayable: false,
            workspace_id: "default".into(),
            provenance: ComputeProvenanceSpec {
                env_hash: "policy-enforcement".into(),
                agent_trace_id: None,
            },
            golden_key: None,
            artifact_id: None,
            expect_golden: false,
        }
    }

    #[tokio::test]
    async fn httpjail_denies_disallowed_network_targets() {
        let previous = std::env::var("UICP_HTTPJAIL").ok();
        std::env::set_var("UICP_HTTPJAIL", "1");

        let harness = ComputeTestHarness::new_async()
            .await
            .expect("compute harness");
        let job = make_denied_codegen_job();
        let result = harness.run_job(job).await.expect("final payload");

        if let Some(value) = previous {
            std::env::set_var("UICP_HTTPJAIL", value);
        } else {
            std::env::remove_var("UICP_HTTPJAIL");
        }

        assert_eq!(
            result.get("ok").and_then(|v| v.as_bool()),
            Some(false),
            "policy denial should mark job as failed"
        );
        assert_eq!(
            result.get("code").and_then(|v| v.as_str()),
            Some("Compute.CapabilityDenied"),
            "policy denial should surface Compute.CapabilityDenied"
        );
    }
}
