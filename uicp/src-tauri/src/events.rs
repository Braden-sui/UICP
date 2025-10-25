// WHY: Centralize compute event channel names to prevent drift between host components.
pub const EVENT_COMPUTE_RESULT_FINAL: &str = "compute-result-final";
#[cfg(any(test, feature = "wasm_compute", feature = "compute_harness"))]
#[allow(dead_code)]
pub const EVENT_COMPUTE_RESULT_PARTIAL: &str = "compute-result-partial";
