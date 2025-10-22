//! Integration tests for compute runtime execution-level coverage.
//! These tests require wasm_compute and uicp_wasi_enable features.

#[cfg(feature = "compute_harness")]
mod command_shims;
mod concurrency_cap;
mod determinism;
mod kill_replay_shakedown;
mod module_smoke;
mod negative_execution;
mod policy_enforcement;
mod quickjs_applet;
mod script_world;
mod smoke_test;
