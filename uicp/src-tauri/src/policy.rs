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
        });
    }
    if timeout > 30_000 && !spec.capabilities.long_run {
        return Some(ComputeFinalErr {
            ok: false,
            job_id: spec.job_id.clone(),
            task: spec.task.clone(),
            code: "Compute.CapabilityDenied".into(),
            message: "timeoutMs>30000 requires capabilities.longRun".into(),
        });
    }

    if let Some(mem) = spec.mem_limit_mb {
        if !(64..=1024).contains(&mem) {
            return Some(ComputeFinalErr {
                ok: false,
                job_id: spec.job_id.clone(),
                task: spec.task.clone(),
                code: "Compute.CapabilityDenied".into(),
                message: "memLimitMb outside allowed range (64-1024)".into(),
            });
        }
        if mem > 256 && !spec.capabilities.mem_high {
            return Some(ComputeFinalErr {
                ok: false,
                job_id: spec.job_id.clone(),
                task: spec.task.clone(),
                code: "Compute.CapabilityDenied".into(),
                message: "memLimitMb>256 requires capabilities.memHigh".into(),
            });
        }
    }

    if !spec.capabilities.net.is_empty() {
        return Some(ComputeFinalErr {
            ok: false,
            job_id: spec.job_id.clone(),
            task: spec.task.clone(),
            code: "Compute.CapabilityDenied".into(),
            message: "Network is disabled by policy (cap.net required)".into(),
        });
    }

    let fs_ok = spec
        .capabilities
        .fs_read
        .iter()
        .chain(spec.capabilities.fs_write.iter())
        .all(|p| p.starts_with("ws:/"));
    if !fs_ok {
        return Some(ComputeFinalErr {
            ok: false,
            job_id: spec.job_id.clone(),
            task: spec.task.clone(),
            code: "Compute.CapabilityDenied".into(),
            message: "Filesystem paths must be workspace-scoped (ws:/...)".into(),
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
}
