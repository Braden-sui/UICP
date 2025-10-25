use serde::{Deserialize, Serialize};

/// Capability gates for compute jobs.
#[derive(Debug, Deserialize, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ComputeCapabilitiesSpec {
    #[serde(default)]
    pub fs_read: Vec<String>,
    #[serde(default)]
    pub fs_write: Vec<String>,
    #[serde(default)]
    pub net: Vec<String>,
    #[serde(default)]
    pub long_run: bool,
    #[serde(default)]
    pub mem_high: bool,
    #[serde(default)]
    pub time: bool,
    #[serde(default)]
    pub random: bool,
}

/// Provenance metadata supplied with each compute job.
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ComputeProvenanceSpec {
    pub env_hash: String,
    pub agent_trace_id: Option<String>,
}

/// Target states for binding compute outputs.
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ComputeBindSpec {
    pub to_state_path: String,
}

/// Host-side specification for executing a compute job.
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ComputeJobSpec {
    pub job_id: String,
    pub task: String,
    pub input: serde_json::Value,
    pub timeout_ms: Option<u64>,
    pub fuel: Option<u64>,
    pub mem_limit_mb: Option<u64>,
    #[serde(default)]
    pub bind: Vec<ComputeBindSpec>,
    #[serde(default = "default_cache_mode")]
    pub cache: String,
    #[serde(default)]
    pub capabilities: ComputeCapabilitiesSpec,
    #[serde(default = "default_replayable")]
    pub replayable: bool,
    #[serde(default = "default_workspace_id")]
    pub workspace_id: String,
    pub provenance: ComputeProvenanceSpec,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    // Track C: Golden cache for code generation determinism
    #[serde(skip_serializing_if = "Option::is_none")]
    pub golden_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_id: Option<String>,
    #[serde(default)]
    pub expect_golden: bool,
}

/// Terminal error envelope emitted back to the UI.
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ComputeFinalErr {
    pub ok: bool,
    pub job_id: String,
    pub task: String,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<serde_json::Value>,
}

/// Terminal success envelope emitted back to the UI.
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ComputeFinalOk {
    pub ok: bool,
    pub job_id: String,
    pub task: String,
    pub output: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<serde_json::Value>,
}

/// Partial compute event emitted during execution.
#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ComputePartialEvent {
    pub job_id: String,
    pub task: String,
    pub seq: u64,
    pub payload_b64: String,
}

fn default_cache_mode() -> String {
    "readwrite".into()
}

fn default_replayable() -> bool {
    true
}

fn default_workspace_id() -> String {
    "default".into()
}

const CODEGEN_TASK_PREFIX: &str = "codegen.run@";
fn allowed_codegen_hosts() -> Vec<String> {
    let mut hosts = vec![
        "https://api.openai.com".to_string(),
        "https://api.anthropic.com".to_string(),
    ];
    let mut push_unique = |value: &str| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return;
        }
        if !hosts.iter().any(|existing| existing == trimmed) {
            hosts.push(trimmed.to_string());
        }
    };
    if let Ok(endpoint) = std::env::var("UICP_CODEGEN_OPENAI_ENDPOINT") {
        push_unique(&endpoint);
    }
    if let Ok(endpoint) = std::env::var("UICP_CODEGEN_ANTHROPIC_ENDPOINT") {
        push_unique(&endpoint);
    }
    hosts
}

fn is_codegen_task(task: &str) -> bool {
    task.starts_with(CODEGEN_TASK_PREFIX)
}

fn codegen_host_allowed(url: &str) -> bool {
    allowed_codegen_hosts()
        .iter()
        .any(|allowed| url.starts_with(allowed))
}

/// Enforce policy gates before dispatching a compute job.
pub fn enforce_compute_policy(spec: &ComputeJobSpec) -> Option<ComputeFinalErr> {
    let timeout = spec.timeout_ms.unwrap_or(30_000);
    if !(1_000..=120_000).contains(&timeout) {
        return Some(ComputeFinalErr {
            ok: false,
            job_id: spec.job_id.clone(),
            task: spec.task.clone(),
            code: "Compute.CapabilityDenied".into(),
            message: "timeoutMs outside allowed range (1000-120000)".into(),
            metrics: None,
        });
    }
    if timeout > 30_000 && !spec.capabilities.long_run {
        return Some(ComputeFinalErr {
            ok: false,
            job_id: spec.job_id.clone(),
            task: spec.task.clone(),
            code: "Compute.CapabilityDenied".into(),
            message: "timeoutMs>30000 requires capabilities.longRun".into(),
            metrics: None,
        });
    }

    let is_codegen = is_codegen_task(&spec.task);

    if let Some(mem) = spec.mem_limit_mb {
        if !(64..=1024).contains(&mem) {
            return Some(ComputeFinalErr {
                ok: false,
                job_id: spec.job_id.clone(),
                task: spec.task.clone(),
                code: "Compute.CapabilityDenied".into(),
                message: "memLimitMb outside allowed range (64-1024)".into(),
                metrics: None,
            });
        }
        if mem > 256 && !spec.capabilities.mem_high {
            return Some(ComputeFinalErr {
                ok: false,
                job_id: spec.job_id.clone(),
                task: spec.task.clone(),
                code: "Compute.CapabilityDenied".into(),
                message: "memLimitMb>256 requires capabilities.memHigh".into(),
                metrics: None,
            });
        }
    }

    if is_codegen {
        if spec.capabilities.net.is_empty() {
            return Some(ComputeFinalErr {
                ok: false,
                job_id: spec.job_id.clone(),
                task: spec.task.clone(),
                code: "Compute.CapabilityDenied".into(),
                message:
                    "codegen.run tasks require capabilities.net pointing at the configured codegen endpoint"
                        .into(),
                metrics: None,
            });
        }
        let all_allowed = spec
            .capabilities
            .net
            .iter()
            .all(|host| codegen_host_allowed(host));
        if !all_allowed {
            let allowed = allowed_codegen_hosts().join(", ");
            return Some(ComputeFinalErr {
                ok: false,
                job_id: spec.job_id.clone(),
                task: spec.task.clone(),
                code: "Compute.CapabilityDenied".into(),
                message: format!(
                    "codegen.run tasks may only access allowlisted hosts: {}",
                    allowed
                ),
                metrics: None,
            });
        }
    } else if !spec.capabilities.net.is_empty() {
        return Some(ComputeFinalErr {
            ok: false,
            job_id: spec.job_id.clone(),
            task: spec.task.clone(),
            code: "Compute.CapabilityDenied".into(),
            message: "Network is disabled by policy (cap.net required)".into(),
            metrics: None,
        });
    }

    // Allow time and random capabilities in v2 (Balanced/Open presets).
    // Enforcement of quotas and runtime behavior remains in the compute host.

    let fs_ok = spec
        .capabilities
        .fs_read
        .iter()
        .chain(spec.capabilities.fs_write.iter())
        .all(|p| p.starts_with("ws:/"));

    if is_codegen
        && (!spec.capabilities.fs_read.is_empty() || !spec.capabilities.fs_write.is_empty())
    {
        return Some(ComputeFinalErr {
            ok: false,
            job_id: spec.job_id.clone(),
            task: spec.task.clone(),
            code: "Compute.CapabilityDenied".into(),
            message: "codegen.run tasks may not access the filesystem".into(),
            metrics: None,
        });
    }

    if !fs_ok {
        return Some(ComputeFinalErr {
            ok: false,
            job_id: spec.job_id.clone(),
            task: spec.task.clone(),
            code: "Compute.CapabilityDenied".into(),
            message: "Filesystem paths must be workspace-scoped (ws:/...)".into(),
            metrics: None,
        });
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
        let deny = enforce_compute_policy(&spec).expect("expected rejection");
        assert_eq!(deny.code, "Compute.CapabilityDenied");
    }

    #[test]
    fn timeout_above_30s_requires_long_run_capability() {
        let mut spec = base_spec();
        spec.timeout_ms = Some(31_000);
        let deny = enforce_compute_policy(&spec).expect("expected rejection");
        assert_eq!(deny.code, "Compute.CapabilityDenied");
        spec.capabilities.long_run = true;
        assert!(enforce_compute_policy(&spec).is_none());
    }

    #[test]
    fn memory_above_256_requires_mem_high_capability() {
        let mut spec = base_spec();
        spec.mem_limit_mb = Some(512);
        let deny = enforce_compute_policy(&spec).expect("expected rejection");
        assert_eq!(deny.code, "Compute.CapabilityDenied");
        spec.capabilities.mem_high = true;
        assert!(enforce_compute_policy(&spec).is_none());
    }

    #[test]
    fn filesystem_paths_must_be_workspace_scoped() {
        let mut spec = base_spec();
        spec.capabilities.fs_read = vec!["file:/root/**".into()];
        let deny = enforce_compute_policy(&spec).expect("expected rejection");
        assert_eq!(deny.code, "Compute.CapabilityDenied");
    }

    #[test]
    fn network_capabilities_are_denied_in_v1() {
        let mut spec = base_spec();
        spec.capabilities.net = vec!["https://example.com".into()];
        let deny = enforce_compute_policy(&spec).expect("expected rejection");
        assert_eq!(deny.code, "Compute.CapabilityDenied");
    }

    #[test]
    fn codegen_requires_allowlisted_network() {
        std::env::remove_var("UICP_CODEGEN_OPENAI_ENDPOINT");
        std::env::remove_var("UICP_CODEGEN_ANTHROPIC_ENDPOINT");
        let mut spec = base_spec();
        spec.task = "codegen.run@0.1.0".into();
        spec.capabilities.net = vec!["https://api.openai.com".into()];
        assert!(enforce_compute_policy(&spec).is_none());

        let mut spec_claude = spec.clone();
        spec_claude.capabilities.net = vec!["https://api.anthropic.com".into()];
        assert!(
            enforce_compute_policy(&spec_claude).is_none(),
            "anthropic endpoint should be allowed"
        );

        let mut spec_bad = spec.clone();
        spec_bad.capabilities.net = vec!["https://evil.example.com".into()];
        let deny = enforce_compute_policy(&spec_bad).expect("expected rejection");
        assert_eq!(deny.code, "Compute.CapabilityDenied");

        let mut spec_missing = spec.clone();
        spec_missing.capabilities.net.clear();
        let deny_missing =
            enforce_compute_policy(&spec_missing).expect("expected rejection for missing net");
        assert_eq!(deny_missing.code, "Compute.CapabilityDenied");

        std::env::set_var("UICP_CODEGEN_OPENAI_ENDPOINT", "http://localhost:11434");
        let mut spec_local = base_spec();
        spec_local.task = "codegen.run@0.1.0".into();
        spec_local.capabilities.net = vec!["http://localhost:11434".into()];
        assert!(
            enforce_compute_policy(&spec_local).is_none(),
            "custom endpoint from env should be allowed"
        );
        std::env::set_var("UICP_CODEGEN_ANTHROPIC_ENDPOINT", "http://localhost:2020");
        let mut spec_claude_local = base_spec();
        spec_claude_local.task = "codegen.run@0.1.0".into();
        spec_claude_local.capabilities.net = vec!["http://localhost:2020".into()];
        assert!(
            enforce_compute_policy(&spec_claude_local).is_none(),
            "anthropic override should be allowed"
        );
        std::env::remove_var("UICP_CODEGEN_OPENAI_ENDPOINT");
        std::env::remove_var("UICP_CODEGEN_ANTHROPIC_ENDPOINT");
    }

    #[test]
    fn codegen_denies_filesystem_access() {
        let mut spec = base_spec();
        spec.task = "codegen.run@0.1.0".into();
        spec.capabilities.net = vec!["https://api.openai.com".into()];
        spec.capabilities.fs_read = vec!["ws:/tmp/**".into()];
        let deny = enforce_compute_policy(&spec).expect("expected rejection");
        assert_eq!(deny.code, "Compute.CapabilityDenied");
    }

    #[test]
    fn compute_final_err_serializes_with_camel_case_keys() {
        let payload = ComputeFinalErr {
            ok: false,
            job_id: "00000000-0000-4000-8000-000000000099".into(),
            task: "applet.quickjs@0.1.0".into(),
            code: "Compute.Input.Invalid".into(),
            message: "missing source".into(),
            metrics: None,
        };
        let value = serde_json::to_value(&payload).expect("serialize final error");
        assert_eq!(
            value.get("jobId").and_then(|v| v.as_str()),
            Some("00000000-0000-4000-8000-000000000099")
        );
        assert!(value.get("job_id").is_none());
    }
}
