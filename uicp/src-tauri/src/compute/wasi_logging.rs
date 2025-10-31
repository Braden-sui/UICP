// WHY: As of Wasmtime 37 we register wasi:logging/logging directly in the host linker.
// INVARIANT: This module intentionally contains no bindgen to avoid scanning unrelated WIT under src-tauri/wit.
pub mod wasi_logging_shim {}
