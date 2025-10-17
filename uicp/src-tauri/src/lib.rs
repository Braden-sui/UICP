pub mod action_log;
pub mod policy;

pub use action_log::{
    ensure_action_log_schema, parse_pubkey, parse_seed, verify_chain, ActionLogHandle,
    ActionLogService, ActionLogVerifyReport,
};
pub use policy::{
    enforce_compute_policy, ComputeBindSpec, ComputeCapabilitiesSpec, ComputeFinalErr,
    ComputeFinalOk, ComputeJobSpec, ComputePartialEvent, ComputeProvenanceSpec,
};

pub mod compute;
pub mod compute_cache;
pub mod compute_input;
pub mod core;
pub mod registry;

#[cfg(feature = "wasm_compute")]
pub mod wasi_logging;

#[cfg(feature = "wasm_compute")]
pub mod component_bindings;

#[cfg(any(
    all(feature = "wasm_compute", feature = "uicp_wasi_enable"),
    test,
    feature = "compute_harness"
))]
use serde_json::Value; // WHY: compute_cache_key is exercised in harness/tests; import serde_json value there.

pub use core::{
    configure_sqlite, emit_or_log, ensure_default_workspace, files_dir_path, init_database,
    remove_compute_job, AppState, DATA_DIR, FILES_DIR, LOGS_DIR,
};

// WHY: Restrict harness-only commands to tests or the explicit compute_harness feature to avoid dead code warnings in wasm-only builds.
#[cfg(any(test, feature = "compute_harness"))]
pub mod commands;
#[cfg(any(test, feature = "compute_harness"))]
pub use commands::{
    clear_compute_cache, compute_call, compute_cancel, copy_into_files, get_modules_info,
    load_workspace, save_workspace,
};

#[cfg(any(
    all(feature = "wasm_compute", feature = "uicp_wasi_enable"),
    test,
    feature = "compute_harness"
))]
pub fn compute_cache_key(task: &str, input: &Value, env_hash: &str) -> String {
    crate::compute_cache::compute_key(task, input, env_hash)
}

// Test support infrastructure (test_support/) is only compiled when running tests
// or when the compute_harness feature is enabled. It is excluded from release builds.
#[cfg(any(test, feature = "compute_harness"))]
pub mod test_support;
