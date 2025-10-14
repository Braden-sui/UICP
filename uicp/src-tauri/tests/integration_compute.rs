//! Integration tests for compute runtime - execution-level coverage.
//! These tests replace placeholder tests with real harness-driven scenarios.

#[path = "integration_compute/mod.rs"]
mod suite;

// Ensure registry resolves modules without requiring AppState in presence checks
static _INIT_MODULES_DIR: once_cell::sync::Lazy<()> = once_cell::sync::Lazy::new(|| {
    let dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("modules");
    std::env::set_var("UICP_MODULES_DIR", dir);
});
