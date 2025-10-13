//! Integration tests for compute runtime execution-level coverage.
//! These tests require wasm_compute and uicp_wasi_enable features.

mod concurrency_cap;
mod kill_replay_shakedown;
mod negative_execution;
mod smoke_test;
mod module_smoke;
#[cfg(feature = "compute_harness")]
mod command_shims;
