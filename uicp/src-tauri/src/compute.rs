//! UICP Wasm compute host (WASI Preview 2, Component Model).
//!
//! This module selects implementation based on the `wasm_compute` feature:
//! - when enabled, it embeds Wasmtime with typed hostcalls and module registry.
//! - when disabled, it surfaces a structured error so callers know the runtime is unavailable.

use std::time::Duration;

#[cfg(feature = "wasm_compute")]
use std::time::Instant;

// Base64 engine is needed by helpers regardless of wasm feature; import unconditionally.
use base64::engine::general_purpose::STANDARD as BASE64_ENGINE;
use base64::Engine as _;
use tauri::async_runtime::{spawn as tauri_spawn, JoinHandle};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::OwnedSemaphorePermit;

#[cfg(feature = "wasm_compute")]
use crate::registry;
use crate::ComputeJobSpec;

/// Centralized error code constants to keep parity with TS `compute/types.ts` and UI `compute/errors.ts`.
#[cfg_attr(not(feature = "wasm_compute"), allow(dead_code))]
pub mod error_codes {
    pub const TIMEOUT: &str = "Compute.Timeout";
    pub const CANCELLED: &str = "Compute.Cancelled";
    pub const CAPABILITY_DENIED: &str = "Compute.CapabilityDenied";
    pub const INPUT_INVALID: &str = "Compute.Input.Invalid";
    pub const TASK_NOT_FOUND: &str = "Task.NotFound";
    pub const RUNTIME_FAULT: &str = "Runtime.Fault";
    pub const RESOURCE_LIMIT: &str = "Compute.Resource.Limit";
    pub const IO_DENIED: &str = "IO.Denied";
    pub const NONDETERMINISTIC: &str = "Nondeterministic";
    pub const MODULE_SIGNATURE_INVALID: &str = "Module.SignatureInvalid";
}

// -----------------------------------------------------------------------------
// Shared helpers (feature-independent) for task input prep and workspace FS policy
// -----------------------------------------------------------------------------

// NOTE: removed unused placeholder import to avoid warning

/// Extract csv.parse input fields from a JSON value.
pub(crate) fn extract_csv_input(input: &serde_json::Value) -> Result<(String, bool), String> {
    let obj = input
        .as_object()
        .ok_or_else(|| "input must be an object".to_string())?;
    let source = obj
        .get("source")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "input.source must be a string".to_string())?
        .to_string();
    let has_header = obj
        .get("hasHeader")
        .and_then(|v| v.as_bool())
        .or_else(|| obj.get("has-header").and_then(|v| v.as_bool()))
        .unwrap_or(true);
    Ok((source, has_header))
}

/// Validate and map a `ws:/files/...` path to a host path under FILES_DIR.
/// Rules: must start with ws:/files/, no absolute, no `..` segments, normalize separators.
pub(crate) fn sanitize_ws_files_path(ws_path: &str) -> Result<std::path::PathBuf, String> {
    let prefix = "ws:/files/";
    if !ws_path.starts_with(prefix) {
        return Err("path must start with ws:/files/".into());
    }
    let rel = &ws_path[prefix.len()..];
    if rel.is_empty() {
        return Err("path missing trailing file segment".into());
    }
    let base = crate::files_dir_path();
    let base_canonical = base
        .canonicalize()
        .map_err(|err| format!("files directory unavailable: {err}"))?;
    let mut buf = std::path::PathBuf::from(base);
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return Err("parent traversal not allowed".into());
        }
        if seg.contains('\\') {
            return Err("invalid separator in path".into());
        }
        buf.push(seg);
    }
    let candidate = buf;
    match candidate.canonicalize() {
        Ok(canonical) => {
            if !canonical.starts_with(&base_canonical) {
                return Err("path escapes workspace files directory".into());
            }
            Ok(candidate)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            if let Some(parent) = candidate.parent() {
                if let Ok(parent_canon) = parent.canonicalize() {
                    if !parent_canon.starts_with(&base_canonical) {
                        return Err("path escapes workspace files directory".into());
                    }
                }
            }
            Ok(candidate)
        }
        Err(err) => Err(format!("canonicalize failed: {err}")),
    }
}

/// Capability check: ensure a ws:/ path is allowed by fs_read caps (supports /** suffix glob).
pub(crate) fn fs_read_allowed(spec: &ComputeJobSpec, ws_path: &str) -> bool {
    if spec.capabilities.fs_read.is_empty() {
        return false;
    }
    for pat in spec.capabilities.fs_read.iter() {
        let p = pat.as_str();
        if let Some(base) = p.strip_suffix("/**") {
            if ws_path.starts_with(base) {
                return true;
            }
        } else if p == ws_path {
            return true;
        }
    }
    false
}

/// Resolve csv.parse source string, enforcing workspace policy when using `ws:/files/...`.
pub(crate) fn resolve_csv_source(
    spec: &ComputeJobSpec,
    source: &str,
) -> Result<String, (&'static str, String)> {
    if !source.starts_with("ws:/files/") {
        return Ok(source.to_string());
    }
    if !fs_read_allowed(spec, source) {
        return Err((
            error_codes::CAPABILITY_DENIED,
            "fs_read does not allow this path".into(),
        ));
    }
    let host_path = sanitize_ws_files_path(source).map_err(|e| (error_codes::IO_DENIED, e))?;
    match std::fs::read(host_path) {
        Ok(bytes) => Ok(format!(
            "data:text/csv;base64,{}",
            BASE64_ENGINE.encode(bytes)
        )),
        Err(err) => Err((error_codes::IO_DENIED, format!("read failed: {err}"))),
    }
}

/// Extract table.query input fields from a JSON value.
pub(crate) fn extract_table_query_input(
    input: &serde_json::Value,
) -> Result<(Vec<Vec<String>>, Vec<u32>, Option<(u32, String)>), String> {
    let obj = input
        .as_object()
        .ok_or_else(|| "input must be an object".to_string())?;
    // rows: list<list<string>>
    let rows_val = obj
        .get("rows")
        .ok_or_else(|| "input.rows required".to_string())?;
    let rows = rows_val
        .as_array()
        .ok_or_else(|| "input.rows must be an array".to_string())?
        .iter()
        .map(|row| {
            let arr = row
                .as_array()
                .ok_or_else(|| "row must be an array".to_string())?;
            Ok(arr
                .iter()
                .map(|cell| cell.as_str().unwrap_or("").to_string())
                .collect::<Vec<String>>())
        })
        .collect::<Result<Vec<Vec<String>>, String>>()?;

    // select: list<u32>
    let select_val = obj
        .get("select")
        .ok_or_else(|| "input.select required".to_string())?;
    let select = select_val
        .as_array()
        .ok_or_else(|| "input.select must be an array".to_string())?
        .iter()
        .map(|v| {
            v.as_u64()
                .ok_or_else(|| "select entries must be non-negative integers".to_string())
                .map(|u| u as u32)
        })
        .collect::<Result<Vec<u32>, String>>()?;

    // where_contains: option<record { col: u32, needle: string }>
    let where_opt = if let Some(w) = obj.get("where_contains") {
        if w.is_null() {
            None
        } else {
            let wobj = w
                .as_object()
                .ok_or_else(|| "where_contains must be an object".to_string())?;
            let col = wobj
                .get("col")
                .and_then(|v| v.as_u64())
                .ok_or_else(|| "where_contains.col must be u32".to_string())?
                as u32;
            let needle = wobj
                .get("needle")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "where_contains.needle must be string".to_string())?
                .to_string();
            Some((col, needle))
        }
    } else {
        None
    };

    Ok((rows, select, where_opt))
}

// removed unused validate_rows_value helper

#[cfg(feature = "wasm_compute")]
mod with_runtime {
    use super::*;
    use bytes::Bytes;
    use ciborium::value::{Integer, Value};
    use chrono::Utc;
    use serde_json;
    use sha2::{Digest, Sha256};
    use std::convert::TryFrom;
    use std::sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    };
    use std::io::Cursor;
    use wasmtime::{
        component::{Component, Linker, Resource, ResourceTable},
        Config, Engine, Store, StoreContextMut, StoreLimits, StoreLimitsBuilder,
    };
    use wasmtime_wasi::{
        DirPerms, FilePerms, HostOutputStream, OutputStream as WasiOutputStream, StreamError,
        Subscribe, WasiCtx, WasiCtxBuilder, WasiView,
    };
    use wasmtime_wasi::stdio::StdoutStream as WasiStdoutStream;
    

    const DEFAULT_FUEL: u64 = 1_000_000;
    const DEFAULT_MEMORY_LIMIT_MB: u64 = 256;
    const EPOCH_TICK_INTERVAL_MS: u64 = 10;
    // Max total bytes we will emit across all stdio log frames per job (deterministic cap)
    const MAX_LOG_BYTES: usize = 256 * 1024;
    // Max preview bytes per log frame to include in partial events
    const LOG_PREVIEW_MAX: usize = 256;

    // Bindgen generation is deferred; we directly use typed funcs via `get_typed_func` for now.

    // removed unused is_typed_only helper

    /// Execution context for a single job store.
    struct Ctx {
        wasi: WasiCtx,
        table: ResourceTable,
        emitter: Arc<dyn TelemetryEmitter>,
        job_id: String,
        task: String,
        partial_seq: Arc<AtomicU64>,
        partial_frames: Arc<AtomicU64>,
        invalid_partial_frames: Arc<AtomicU64>,
        cancelled: Arc<AtomicBool>,
        // Determinism scaffolding (seeded RNG and logical clock) keeps telemetry repeatable
        rng_seed: [u8; 32],
        logical_tick: Arc<AtomicU64>,
        // Host policy and telemetry
        started: Instant,
        deadline_ms: u32,
        rng_counter: u64,
        log_count: Arc<AtomicU64>,
        // Log emission accounting
        emitted_log_bytes: Arc<AtomicU64>,
        max_log_bytes: usize,
        limits: StoreLimits,
    }

    const MAX_PARTIAL_FRAME_BYTES: usize = 64 * 1024;
    const MAX_STDIO_CHARS: usize = 4_096;

    trait TelemetryEmitter: Send + Sync {
        fn emit_debug(&self, payload: serde_json::Value);
        fn emit_partial(&self, event: crate::ComputePartialEvent);
        fn emit_partial_json(&self, payload: serde_json::Value);
    }

    #[derive(Clone)]
    struct TauriEmitter {
        app: AppHandle,
    }

    impl TelemetryEmitter for TauriEmitter {
        fn emit_debug(&self, payload: serde_json::Value) {
            let _ = self.app.emit("debug-log", payload);
        }

        fn emit_partial(&self, event: crate::ComputePartialEvent) {
            let _ = self.app.emit("compute.result.partial", event);
        }

        fn emit_partial_json(&self, payload: serde_json::Value) {
            let _ = self.app.emit("compute.result.partial", payload);
        }
    }

    struct PartialStreamShared {
        emitter: Arc<dyn TelemetryEmitter>,
        job_id: String,
        task: String,
        partial_seq: Arc<AtomicU64>,
        partial_frames: Arc<AtomicU64>,
        invalid_partial_frames: Arc<AtomicU64>,
    }

    struct PartialOutputStream {
        shared: Arc<PartialStreamShared>,
    }

    impl PartialOutputStream {
        fn new(shared: Arc<PartialStreamShared>) -> Self {
            Self { shared }
        }

        fn process_frame(
            &self,
            bytes: &[u8],
        ) -> Result<crate::ComputePartialEvent, PartialFrameError> {
            if bytes.len() > MAX_PARTIAL_FRAME_BYTES {
                return Err(PartialFrameError::TooLarge(bytes.len()));
            }
            let envelope = decode_partial_envelope(bytes)?;
            let expected = self
                .shared
                .partial_seq
                .load(Ordering::Relaxed)
                .saturating_add(1);
            if envelope.seq != expected {
                return Err(PartialFrameError::OutOfOrder {
                    expected,
                    got: envelope.seq,
                });
            }
            self.shared
                .partial_seq
                .store(envelope.seq, Ordering::Relaxed);
            Ok(crate::ComputePartialEvent {
                job_id: self.shared.job_id.clone(),
                task: self.shared.task.clone(),
                seq: envelope.seq,
                payload_b64: BASE64_ENGINE.encode(bytes),
            })
        }

        fn log_reject(&self, err: &PartialFrameError, len: usize) {
            self.shared
                .emitter
                .emit_debug(serde_json::json!({
                    "event": "compute_partial_reject",
                    "jobId": self.shared.job_id,
                    "task": self.shared.task,
                    "reason": err.to_string(),
                    "len": len,
                    "ts": Utc::now().timestamp_millis(),
                }));
        }
    }

    impl HostOutputStream for PartialOutputStream {
        fn write(&mut self, bytes: Bytes) -> Result<(), StreamError> {
            if bytes.is_empty() {
                return Ok(());
            }
            match self.process_frame(bytes.as_ref()) {
                Ok(event) => {
                    self.shared
                        .partial_frames
                        .fetch_add(1, Ordering::Relaxed);
                    self.shared.emitter.emit_partial(event);
                }
                Err(err) => {
                    self.shared
                        .invalid_partial_frames
                        .fetch_add(1, Ordering::Relaxed);
                    self.log_reject(&err, bytes.len());
                }
            }
            Ok(())
        }

        fn flush(&mut self) -> Result<(), StreamError> {
            Ok(())
        }

        fn check_write(&mut self) -> Result<usize, StreamError> {
            Ok(usize::MAX)
        }
    }

    impl Subscribe for PartialOutputStream {
        async fn ready(&mut self) {}
    }

    struct GuestLogShared {
        emitter: Arc<dyn TelemetryEmitter>,
        job_id: String,
        task: String,
        // Shared counters/state
        seq: Arc<AtomicU64>,
        tick: Arc<AtomicU64>,
        log_count: Arc<AtomicU64>,
        emitted_bytes: Arc<AtomicU64>,
        max_bytes: usize,
        max_len: usize,
        buf: Mutex<Vec<u8>>, // line buffer across writes
    }

    #[derive(Clone)]
    struct TelemetryStdout {
        shared: Arc<GuestLogShared>,
        channel: &'static str,
    }

    impl TelemetryStdout {
        fn new(shared: Arc<GuestLogShared>, channel: &'static str) -> Self {
            Self { shared, channel }
        }
    }

    impl WasiStdoutStream for TelemetryStdout {
        fn stream(&self) -> WasiOutputStream {
            Box::new(GuestLogStream {
                shared: self.shared.clone(),
                channel: self.channel,
            })
        }
    }

    struct GuestLogStream {
        shared: Arc<GuestLogShared>,
        channel: &'static str,
    }

    impl GuestLogStream {
        fn emit_message(&self, bytes: &[u8]) {
            if bytes.is_empty() {
                return;
            }
            let mut buf = self.shared.buf.lock().unwrap();
            buf.extend_from_slice(bytes);
            // Emit one event per completed line
            loop {
                if let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                    let line_with_nl: Vec<u8> = buf.drain(..=pos).collect();
                    let line = if line_with_nl.ends_with(&[b'\n']) {
                        &line_with_nl[..line_with_nl.len() - 1]
                    } else {
                        &line_with_nl[..]
                    };
                    if line.is_empty() {
                        continue;
                    }
                    // Enforce per-job cap deterministically
                    let cur = self.shared.emitted_bytes.load(Ordering::Relaxed) as usize;
                    if cur >= self.shared.max_bytes {
                        break;
                    }
                    let to_emit = line;
                    let preview_len = to_emit.len().min(LOG_PREVIEW_MAX);
                    let preview_b64 = BASE64_ENGINE.encode(&to_emit[..preview_len]);
                    let seq_no = self.shared.seq.fetch_add(1, Ordering::Relaxed) + 1;
                    let tick_no = self.shared.tick.fetch_add(1, Ordering::Relaxed) + 1;
                    let new_total = self
                        .shared
                        .emitted_bytes
                        .fetch_add(to_emit.len() as u64, Ordering::Relaxed)
                        .saturating_add(to_emit.len() as u64) as usize;
                    let truncated = new_total > self.shared.max_bytes;

                    self.shared
                        .log_count
                        .fetch_add(1, Ordering::Relaxed);

                    // Emit structured partial log event
                    self.shared.emitter.emit_partial_json(serde_json::json!({
                        "jobId": self.shared.job_id,
                        "task": self.shared.task,
                        "seq": seq_no,
                        "kind": "log",
                        "stream": self.channel,
                        "tick": tick_no,
                        "bytesLen": to_emit.len(),
                        "previewB64": preview_b64,
                        "truncated": truncated,
                    }));

                    // Mirror as debug-log for developer visibility
                    let output = truncate_message(&String::from_utf8_lossy(to_emit), self.shared.max_len);
                    self.shared
                        .emitter
                        .emit_debug(serde_json::json!({
                            "event": "compute_guest_stdio",
                            "jobId": self.shared.job_id,
                            "task": self.shared.task,
                            "channel": self.channel,
                            "len": to_emit.len(),
                            "message": output,
                            "ts": Utc::now().timestamp_millis(),
                        }));
                } else {
                    break;
                }
            }
        }
    }

    impl HostOutputStream for GuestLogStream {
        fn write(&mut self, bytes: Bytes) -> Result<(), StreamError> {
            self.emit_message(bytes.as_ref());
            Ok(())
        }

        fn flush(&mut self) -> Result<(), StreamError> {
            Ok(())
        }

        fn check_write(&mut self) -> Result<usize, StreamError> {
            Ok(usize::MAX)
        }
    }

    impl Subscribe for GuestLogStream {
        async fn ready(&mut self) {}
    }

    #[derive(Debug)]
    struct PartialEnvelope {
        seq: u64,
    }

    #[derive(Debug)]
    enum PartialFrameError {
        TooLarge(usize),
        Malformed(String),
        MissingSequence,
        OutOfOrder { expected: u64, got: u64 },
        PayloadTooLarge(usize),
    }

    impl std::fmt::Display for PartialFrameError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                Self::TooLarge(len) => write!(
                    f,
                    "frame exceeds {} bytes (len={})",
                    MAX_PARTIAL_FRAME_BYTES, len
                ),
                Self::Malformed(msg) => write!(f, "malformed frame: {msg}"),
                Self::MissingSequence => write!(f, "frame missing sequence number"),
                Self::OutOfOrder { expected, got } => write!(
                    f,
                    "frame sequence out of order (expected {}, got {})",
                    expected, got
                ),
                Self::PayloadTooLarge(len) => write!(
                    f,
                    "embedded payload exceeds limit (len={})",
                    len
                ),
            }
        }
    }

    impl std::error::Error for PartialFrameError {}

    fn decode_partial_envelope(bytes: &[u8]) -> Result<PartialEnvelope, PartialFrameError> {
        let mut cursor = Cursor::new(bytes);
        let value: Value = ciborium::de::from_reader(&mut cursor)
            .map_err(|err| PartialFrameError::Malformed(err.to_string()))?;
        match value {
            Value::Map(entries) => {
                let mut seq: Option<u64> = None;
                for (key, val) in entries {
                    let Some(index) = integer_key_to_u64(&key) else {
                        continue;
                    };
                    match index {
                        2 => {
                            seq = match &val {
                                Value::Integer(int) => u64::try_from(*int).ok(),
                                _ => None,
                            };
                        }
                        4 => validate_payload(&val)?,
                        _ => {}
                    }
                }
                let seq = seq.ok_or(PartialFrameError::MissingSequence)?;
                Ok(PartialEnvelope { seq })
            }
            _ => Err(PartialFrameError::Malformed(
                "partial payload must be a CBOR map".into(),
            )),
        }
    }

    fn integer_key_to_u64(value: &Value) -> Option<u64> {
        match value {
            Value::Integer(int) => u64::try_from(*int).ok(),
            _ => None,
        }
    }

    fn validate_payload(value: &Value) -> Result<(), PartialFrameError> {
        match value {
            Value::Bytes(buf) => {
                if buf.len() > MAX_PARTIAL_FRAME_BYTES {
                    Err(PartialFrameError::PayloadTooLarge(buf.len()))
                } else {
                    Ok(())
                }
            }
            Value::Text(text) => {
                if text.chars().count() > MAX_PARTIAL_FRAME_BYTES {
                    Err(PartialFrameError::PayloadTooLarge(text.len()))
                } else {
                    Ok(())
                }
            }
            _ => Ok(()),
        }
    }

    fn truncate_message(input: &str, max_chars: usize) -> String {
        if input.chars().count() <= max_chars {
            return input.to_owned();
        }
        let truncated: String = input.chars().take(max_chars).collect();
        format!("{truncated}... (truncated)")
    }

    impl WasiView for Ctx {
        fn table(&mut self) -> &mut ResourceTable {
            &mut self.table
        }
        fn ctx(&mut self) -> &mut WasiCtx {
            &mut self.wasi
        }
    }

    /// Build a Wasmtime engine configured for the Component Model and limits.
    fn build_engine() -> anyhow::Result<Engine> {
        let mut cfg = Config::new();
        cfg.wasm_component_model(true)
            .async_support(true)
            .consume_fuel(true)
            .epoch_interruption(true)
            .wasm_memory64(false);
        Ok(Engine::new(&cfg)?)
    }

    /// Spawn a compute job using Wasmtime: build engine/store, link WASI + host, and instantiate the component world.
    /// Execution of task exports will be wired in the next milestone; for now we finalize with a pending-wiring message.
    pub(super) fn spawn_job(
        app: AppHandle,
        spec: ComputeJobSpec,
        permit: Option<OwnedSemaphorePermit>,
    ) -> JoinHandle<()> {
        tauri_spawn(async move {
            let _permit = permit;
            let started = Instant::now();

            // Register cancel channel for this job
            let (tx_cancel, mut rx_cancel) = tokio::sync::watch::channel(false);
            {
                let state: tauri::State<'_, crate::AppState> = app.state();
                state
                    .compute_cancel
                    .write()
                    .await
                    .insert(spec.job_id.clone(), tx_cancel);
            }

            // Build engine
            let engine = match build_engine() {
                Ok(e) => e,
                Err(err) => {
                    let any = anyhow::Error::from(err);
                    let (code, msg) = map_trap_error(&any);
                    finalize_error(&app, &spec, code, &msg, started).await;
                    let state: tauri::State<'_, crate::AppState> = app.state();
                    state.compute_cancel.write().await.remove(&spec.job_id);
                    crate::remove_compute_job(&app, &spec.job_id).await;
                    return;
                }
            };

            // Resolve module by task@version
            let module = match registry::find_module(&app, &spec.task) {
                Ok(Some(m)) => m,
                Ok(None) => {
                    finalize_error(
                        &app,
                        &spec,
                        error_codes::TASK_NOT_FOUND,
                        "Module not found for task",
                        started,
                    )
                    .await;
                    let state: tauri::State<'_, crate::AppState> = app.state();
                    state.compute_cancel.write().await.remove(&spec.job_id);
                    crate::remove_compute_job(&app, &spec.job_id).await;
                    return;
                }
                Err(err) => {
                    let any = anyhow::Error::from(err);
                    let (code, msg) = map_trap_error(&any);
                    finalize_error(&app, &spec, code, &msg, started).await;
                    let state: tauri::State<'_, crate::AppState> = app.state();
                    state.compute_cancel.write().await.remove(&spec.job_id);
                    crate::remove_compute_job(&app, &spec.job_id).await;
                    return;
                }
            };

            // Create component from file
            let component = match Component::from_file(&engine, &module.path) {
                Ok(c) => c,
                Err(err) => {
                    let any = anyhow::Error::from(err);
                    let (code, msg) = map_trap_error(&any);
                    finalize_error(&app, &spec, code, &msg, started).await;
                    let state: tauri::State<'_, crate::AppState> = app.state();
                    state.compute_cancel.write().await.remove(&spec.job_id);
                    crate::remove_compute_job(&app, &spec.job_id).await;
                    return;
                }
            };

            // Build store context (no preopens by default; FS/NET off). Seed deterministic fields.
            let mem_limit_mb = spec
                .mem_limit_mb
                .filter(|mb| *mb > 0)
                .unwrap_or(DEFAULT_MEMORY_LIMIT_MB);
            let mem_limit_bytes = mem_limit_mb
                .saturating_mul(1_048_576)
                .min(usize::MAX as u64) as usize;
            let limits = StoreLimitsBuilder::new()
                .instances(1)
                .tables(32)
                .memory_size(mem_limit_bytes)
                .build();
            let deadline_ms = spec.timeout_ms.unwrap_or(30_000).min(u32::MAX as u64);

            let telemetry: Arc<dyn TelemetryEmitter> = Arc::new(TauriEmitter { app: app.clone() });
            let partial_seq = Arc::new(AtomicU64::new(0));
            let partial_frames = Arc::new(AtomicU64::new(0));
            let invalid_partials = Arc::new(AtomicU64::new(0));
            let cancelled = Arc::new(AtomicBool::new(false));
            let log_count = Arc::new(AtomicU64::new(0));
            let logical_tick = Arc::new(AtomicU64::new(0));
            let emitted_bytes = Arc::new(AtomicU64::new(0));

            let log_shared = Arc::new(GuestLogShared {
                emitter: telemetry.clone(),
                job_id: spec.job_id.clone(),
                task: spec.task.clone(),
                seq: partial_seq.clone(),
                tick: logical_tick.clone(),
                log_count: log_count.clone(),
                emitted_bytes: emitted_bytes.clone(),
                max_bytes: MAX_LOG_BYTES,
                max_len: MAX_STDIO_CHARS,
                buf: Mutex::new(Vec::new()),
            });

            let mut wasi_builder = WasiCtxBuilder::new();
            wasi_builder
                .stdout(TelemetryStdout::new(log_shared.clone(), "stdout"))
                .stderr(TelemetryStdout::new(log_shared, "stderr"));
            // Single readonly preopen for workspace files, mounted at /ws/files in the guest.
            // Only enable when the job requested workspace file access via capabilities.
            let want_ws_preopen = spec
                .capabilities
                .fs_read
                .iter()
                .chain(spec.capabilities.fs_write.iter())
                .any(|p| p.starts_with("ws:/files/"));
            if want_ws_preopen {
                let _ = wasi_builder.preopened_dir(
                    crate::files_dir_path(),
                    "/ws/files",
                    DirPerms::READ,
                    FilePerms::READ,
                );
            }
            let wasi = wasi_builder.build();

            let ctx = Ctx {
                wasi,
                table: ResourceTable::new(),
                emitter: telemetry.clone(),
                job_id: spec.job_id.clone(),
                task: spec.task.clone(),
                partial_seq,
                partial_frames,
                invalid_partial_frames: invalid_partials,
                cancelled: cancelled.clone(),
                rng_seed: [7u8; 32],
                logical_tick: logical_tick.clone(),
                started,
                deadline_ms: deadline_ms as u32,
                rng_counter: 0,
                log_count,
                emitted_log_bytes: emitted_bytes.clone(),
                max_log_bytes: MAX_LOG_BYTES,
                limits,
            };
            let mut store: Store<Ctx> = Store::new(&engine, ctx);
            store.limiter(|ctx| &mut ctx.limits);

            // Optional diagnostics for mounts/imports at job start (support both cases)
            let diag_env = std::env::var("UICP_WASI_DIAG")
                .or_else(|_| std::env::var("uicp_wasi_diag"))
                .unwrap_or_default();
            if matches!(diag_env.as_str(), "1" | "true" | "TRUE" | "yes" | "on") {
                telemetry.emit_debug(serde_json::json!({
                    "event": "wasi_diag",
                    "jobId": spec.job_id,
                    "task": spec.task,
                    "mounts": [{ "guest": "/ws/files", "host": crate::files_dir_path().display().to_string(), "perms": "ro" }],
                    "imports": ["wasi:io/streams", "wasi:clocks", "wasi:random", "uicp:host/*"],
                }));
            }

            // Configure fuel and epoch deadline enforcement.
            // Spawn epoch tick pump to enforce wall-clock deadline.
            // CPU fuel metering is disabled in V1 (wall-clock epoch deadline only). Keep knob for future.
            let _fuel_ignored = spec.fuel.filter(|f| *f > 0).unwrap_or(DEFAULT_FUEL);
            let mut deadline_ticks =
                deadline_ms.saturating_add(EPOCH_TICK_INTERVAL_MS - 1) / EPOCH_TICK_INTERVAL_MS;
            if deadline_ticks == 0 {
                deadline_ticks = 1;
            }
            store.set_epoch_deadline(deadline_ticks);
            let eng = engine.clone();
            let tick_interval = Duration::from_millis(EPOCH_TICK_INTERVAL_MS);
            let ticks = deadline_ticks;
            let epoch_pump: JoinHandle<()> = tauri_spawn(async move {
                for _ in 0..ticks {
                    tokio::time::sleep(tick_interval).await;
                    eng.increment_epoch();
                }
            });

            // Propagate cancel signal into store context
            {
                let cancelled = store.data().cancelled.clone();
                tokio::spawn(async move {
                    let _ = rx_cancel.changed().await;
                    cancelled.store(true, Ordering::Relaxed);
                });
            }

            // Link WASI and host imports, then instantiate the world
            let mut linker: Linker<Ctx> = Linker::new(&engine);
            if let Err(err) = add_wasi_and_host(&mut linker) {
                epoch_pump.abort();
                let any = anyhow::Error::from(err);
                let (code, msg) = map_trap_error(&any);
                finalize_error(&app, &spec, code, &msg, started).await;
                let state: tauri::State<'_, crate::AppState> = app.state();
                state.compute_cancel.write().await.remove(&spec.job_id);
                crate::remove_compute_job(&app, &spec.job_id).await;
                return;
            }

            // Instantiate the world and call exports using typed API (no bindgen for now)
            #[cfg(feature = "uicp_bindgen")]
            {
                let inst_res: Result<wasmtime::component::Instance, _> =
                    linker.instantiate(&mut store, &component);
                match inst_res {
                    Ok(instance) => {
                        let task_name = spec.task.split('@').next().unwrap_or("");
                        let call_res: anyhow::Result<serde_json::Value> = match task_name {
                            "csv.parse" => {
                                let src_has = extract_csv_input(&spec.input).map_err(|e| anyhow::anyhow!(e));
                                if let Err(err) = src_has {
                                    Err(err)
                                } else {
                                    let (src, has_header) = src_has.unwrap();
                                    let resolved_res = resolve_csv_source(&spec, &src)
                                        .map_err(|e| anyhow::anyhow!(format!("{}: {}", e.0, e.1)));
                                    if let Err(err) = resolved_res {
                                        Err(err)
                                    } else {
                                        let resolved = resolved_res.unwrap();
                                        // WIT `result<T, E>` comes through Wasmtime as the standard Rust `Result<T, E>`.
                                        let func_res: Result<
                                            wasmtime::component::TypedFunc<
                                                (String, String, bool),
                                                (Result<Vec<Vec<String>>, String>,),
                                            >,
                                            _,
                                        > = instance.get_typed_func(&mut store, "csv#run");
                                        match func_res {
                                            Err(e) => Err(anyhow::Error::from(e)),
                                            Ok(func) => match func
                                                .call_async(&mut store, (spec.job_id.clone(), resolved, has_header))
                                                .await
                                            {
                                                Ok((Ok(rows),)) => Ok(serde_json::json!(rows)),
                                                Ok((Err(msg),)) => Err(anyhow::Error::msg(msg)),
                                                Err(e) => Err(anyhow::Error::from(e)),
                                            },
                                        }
                                    }
                                }
                            }
                            "table.query" => {
                                let parsed = extract_table_query_input(&spec.input).map_err(|e| anyhow::anyhow!(e));
                                if let Err(err) = parsed {
                                    Err(err)
                                } else {
                                    let (rows, select, where_opt) = parsed.unwrap();
                                    let func_res: Result<
                                        wasmtime::component::TypedFunc<
                                            (String, Vec<Vec<String>>, Vec<u32>, Option<(u32, String)>),
                                            (Result<Vec<Vec<String>>, String>,),
                                        >,
                                        _,
                                    > = instance.get_typed_func(&mut store, "table#run");
                                    match func_res {
                                        Err(e) => Err(anyhow::Error::from(e)),
                                        Ok(func) => match func
                                            .call_async(&mut store, (spec.job_id.clone(), rows, select, where_opt))
                                            .await
                                        {
                                            Ok((Ok(out),)) => Ok(serde_json::json!(out)),
                                            Ok((Err(msg),)) => Err(anyhow::Error::msg(msg)),
                                            Err(e) => Err(anyhow::Error::from(e)),
                                        },
                                    }
                                }
                            }
                            _ => Err(anyhow::anyhow!("unknown task for this world")),
                        };
                        match call_res {
                            Ok(output_json) => {
                                let metrics = collect_metrics(&mut store);
                                finalize_ok_with_metrics(&app, &spec, output_json, metrics).await;
                            }
                            Err(err) => {
                                let (code, msg) = map_trap_error(&err);
                                let message = if msg.is_empty() { err.to_string() } else { msg };
                                finalize_error(&app, &spec, code, &message, started).await;
                            }
                        }
                        epoch_pump.abort();
                    }
                    Err(err) => {
                        let any = anyhow::Error::from(err);
                        let (code, msg) = map_trap_error(&any);
                        finalize_error(&app, &spec, code, &msg, started).await;
                        epoch_pump.abort();
                    }
                }
            }

            #[cfg(not(feature = "uicp_bindgen"))]
            {
                let inst_res: Result<wasmtime::component::Instance, _> =
                    linker.instantiate(&mut store, &component);
                match inst_res {
                    Ok(instance) => {
                        // Call appropriate export using typed API.
                        let task_name = spec.task.split('@').next().unwrap_or("");
                        let call_res: anyhow::Result<serde_json::Value> = match task_name {
                            "csv.parse" => {
                                let parsed = extract_csv_input(&spec.input).map_err(|e| anyhow::anyhow!(e));
                                if let Err(err) = parsed {
                                    Err(err)
                                } else {
                                    let (src, has_header) = parsed.unwrap();
                                    let resolved_res = resolve_csv_source(&spec, &src)
                                        .map_err(|e| anyhow::anyhow!(format!("{}: {}", e.0, e.1)));
                                    if let Err(err) = resolved_res {
                                        Err(err)
                                    } else {
                                        let resolved = resolved_res.unwrap();
                                        // Typed `result` from WIT surfaces as the standard Rust `Result`.
                                        let func_res: Result<
                                            wasmtime::component::TypedFunc<
                                                (String, String, bool),
                                                (Result<Vec<Vec<String>>, String>,),
                                            >,
                                            _,
                                        > = instance.get_typed_func(&mut store, "csv#run");
                                        match func_res {
                                            Err(e) => Err(anyhow::Error::from(e)),
                                            Ok(func) => match func
                                                .call_async(&mut store, (spec.job_id.clone(), resolved, has_header))
                                                .await
                                            {
                                                Ok((Ok(rows),)) => Ok(serde_json::json!(rows)),
                                                Ok((Err(msg),)) => Err(anyhow::Error::msg(msg)),
                                                Err(e) => Err(anyhow::Error::from(e)),
                                            },
                                        }
                                    }
                                }
                            }
                            "table.query" => {
                                let parsed = extract_table_query_input(&spec.input).map_err(|e| anyhow::anyhow!(e));
                                if let Err(err) = parsed {
                                    Err(err)
                                } else {
                                    let (rows, select, where_opt) = parsed.unwrap();
                                    let func_res: Result<
                                        wasmtime::component::TypedFunc<
                                            (String, Vec<Vec<String>>, Vec<u32>, Option<(u32, String)>),
                                            (Result<Vec<Vec<String>>, String>,),
                                        >,
                                        _,
                                    > = instance.get_typed_func(&mut store, "table#run");
                                    match func_res {
                                        Err(e) => Err(anyhow::Error::from(e)),
                                        Ok(func) => match func
                                            .call_async(&mut store, (spec.job_id.clone(), rows, select, where_opt))
                                            .await
                                        {
                                            Ok((Ok(out),)) => Ok(serde_json::json!(out)),
                                            Ok((Err(msg),)) => Err(anyhow::Error::msg(msg)),
                                            Err(e) => Err(anyhow::Error::from(e)),
                                        },
                                    }
                                }
                            }
                            _ => Err(anyhow::anyhow!("unknown task for this world")),
                        };
                        match call_res {
                            Ok(output_json) => {
                                let metrics = collect_metrics(&mut store);
                                finalize_ok_with_metrics(&app, &spec, output_json, metrics).await;
                            }
                            Err(err) => {
                                let (code, msg) = map_trap_error(&err);
                                let message = if msg.is_empty() { err.to_string() } else { msg };
                                finalize_error(&app, &spec, code, &message, started).await;
                            }
                        }
                        epoch_pump.abort();
                    }
                    Err(err) => {
                        let any = anyhow::Error::from(err);
                        let (code, msg) = map_trap_error(&any);
                        finalize_error(&app, &spec, code, &msg, started).await;
                        epoch_pump.abort();
                    }
                }
            }

            epoch_pump.abort();

            // Cleanup cancel map and job registry
            let state: tauri::State<'_, crate::AppState> = app.state();
            state.compute_cancel.write().await.remove(&spec.job_id);
            crate::remove_compute_job(&app, &spec.job_id).await;
        })
    }

    /// Wire core WASI Preview 2 imports only (host shims deferred to M2+).
    #[cfg(feature = "uicp_wasi_enable")]
    fn add_wasi_and_host(linker: &mut Linker<Ctx>) -> anyhow::Result<()> {
        // Provide WASI Preview 2 to the component. Preopens/policy are encoded in WasiCtx.
        wasmtime_wasi::add_to_linker_async(linker)?;
        add_uicp_host(linker)?;
        Ok(())
    }

    #[cfg(not(feature = "uicp_wasi_enable"))]
    fn add_wasi_and_host(_linker: &mut Linker<Ctx>) -> anyhow::Result<()> {
        Err(anyhow::anyhow!(
            "WASI imports disabled; rebuild with `--features uicp_wasi_enable` to enable WASI host imports"
        ))
    }

    fn add_uicp_host(linker: &mut Linker<Ctx>) -> anyhow::Result<()> {
        register_control_interface(linker, "uicp:host/control")?;
        register_control_interface(linker, "uicp:host/control@1.0.0")?;
        register_rng_interface(linker, "uicp:host/rng")?;
        register_rng_interface(linker, "uicp:host/rng@1.0.0")?;
        register_logger_interface(linker, "uicp:host/logger")?;
        register_logger_interface(linker, "uicp:host/logger@1.0.0")?;
        register_clock_interface(linker, "uicp:host/clock")?;
        register_clock_interface(linker, "uicp:host/clock@1.0.0")?;
        Ok(())
    }

    fn register_control_interface(linker: &mut Linker<Ctx>, name: &str) -> anyhow::Result<()> {
        let mut instance = linker.instance(name)?;
        instance.func_wrap("open-partial-sink", host_open_partial_sink)?;
        instance.func_wrap("should-cancel", host_should_cancel)?;
        instance.func_wrap("deadline-ms", host_deadline_ms)?;
        instance.func_wrap("remaining-ms", host_remaining_ms)?;
        Ok(())
    }

    fn register_rng_interface(linker: &mut Linker<Ctx>, name: &str) -> anyhow::Result<()> {
        let mut instance = linker.instance(name)?;
        instance.func_wrap("next-u64", host_rng_next_u64)?;
        instance.func_wrap("fill", host_rng_fill)?;
        Ok(())
    }

    fn register_logger_interface(linker: &mut Linker<Ctx>, name: &str) -> anyhow::Result<()> {
        let mut instance = linker.instance(name)?;
        instance.func_wrap("log", host_logger_log)?;
        Ok(())
    }

    fn register_clock_interface(linker: &mut Linker<Ctx>, name: &str) -> anyhow::Result<()> {
        let mut instance = linker.instance(name)?;
        instance.func_wrap("now-ms", host_clock_now_ms)?;
        Ok(())
    }

    fn host_open_partial_sink(
        mut store: StoreContextMut<'_, Ctx>,
        (job,): (String,),
    ) -> anyhow::Result<Resource<WasiOutputStream>> {
        {
            let ctx = store.data();
            if job != ctx.job_id {
                log_job_mismatch(ctx, "open-partial-sink", &job);
                return Err(anyhow::anyhow!("partial sink job id mismatch"));
            }
        }
        let shared = {
            let ctx = store.data();
            Arc::new(PartialStreamShared {
                emitter: ctx.emitter.clone(),
                job_id: ctx.job_id.clone(),
                task: ctx.task.clone(),
                partial_seq: ctx.partial_seq.clone(),
                partial_frames: ctx.partial_frames.clone(),
                invalid_partial_frames: ctx.invalid_partial_frames.clone(),
            })
        };
        let stream: WasiOutputStream = Box::new(PartialOutputStream::new(shared));
        let handle = store.data_mut().table.push(stream)?;
        Ok(handle)
    }

    fn host_should_cancel(
        mut store: StoreContextMut<'_, Ctx>,
        (job,): (String,),
    ) -> anyhow::Result<bool> {
        let ctx = store.data();
        if job != ctx.job_id {
            log_job_mismatch(ctx, "should-cancel", &job);
            return Ok(true);
        }
        Ok(ctx.cancelled.load(Ordering::Relaxed))
    }

    fn host_deadline_ms(
        store: StoreContextMut<'_, Ctx>,
        (job,): (String,),
    ) -> anyhow::Result<u32> {
        let ctx = store.data();
        if job != ctx.job_id {
            log_job_mismatch(ctx, "deadline-ms", &job);
        }
        Ok(ctx.deadline_ms)
    }

    fn host_remaining_ms(
        mut store: StoreContextMut<'_, Ctx>,
        (job,): (String,),
    ) -> anyhow::Result<u32> {
        let ctx = store.data();
        if job != ctx.job_id {
            log_job_mismatch(ctx, "remaining-ms", &job);
        }
        let elapsed = ctx.started.elapsed().as_millis() as u64;
        let deadline = ctx.deadline_ms as u64;
        let remaining = deadline.saturating_sub(elapsed);
        Ok(remaining.min(u32::MAX as u64) as u32)
    }

    fn host_rng_next_u64(
        mut store: StoreContextMut<'_, Ctx>,
        (job,): (String,),
    ) -> anyhow::Result<u64> {
        if job != store.data().job_id {
            let ctx = store.data();
            log_job_mismatch(ctx, "rng.next-u64", &job);
        }
        let ctx = store.data_mut();
        let block = derive_rng_block(&ctx.rng_seed, ctx.rng_counter);
        ctx.rng_counter = ctx.rng_counter.saturating_add(1);
        Ok(u64::from_le_bytes(block[0..8].try_into().unwrap()))
    }

    fn host_rng_fill(
        mut store: StoreContextMut<'_, Ctx>,
        (job, len): (String, u32),
    ) -> anyhow::Result<Vec<u8>> {
        if job != store.data().job_id {
            let ctx = store.data();
            log_job_mismatch(ctx, "rng.fill", &job);
        }
        let mut ctx = store.data_mut();
        let mut out = Vec::with_capacity(len as usize);
        while out.len() < len as usize {
            let block = derive_rng_block(&ctx.rng_seed, ctx.rng_counter);
            ctx.rng_counter = ctx.rng_counter.saturating_add(1);
            let remaining = len as usize - out.len();
            out.extend_from_slice(&block[..remaining.min(block.len())]);
        }
        Ok(out)
    }

    fn host_logger_log(
        mut store: StoreContextMut<'_, Ctx>,
        (level, message): (u32, String),
    ) -> anyhow::Result<()> {
        let ctx = store.data();
        static LEVELS: [&str; 5] = ["trace", "debug", "info", "warn", "error"];
        let level_str = LEVELS
            .get(level as usize)
            .copied()
            .unwrap_or("info");
        ctx.log_count.fetch_add(1, Ordering::Relaxed);

        // Partial log event with deterministic seq/tick and byte caps
        let bytes = message.as_bytes();
        let preview_len = bytes.len().min(LOG_PREVIEW_MAX);
        let preview_b64 = BASE64_ENGINE.encode(&bytes[..preview_len]);
        let seq_no = store
            .data()
            .partial_seq
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1);
        let tick_no = store
            .data()
            .logical_tick
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1);
        let new_total = store
            .data()
            .emitted_log_bytes
            .fetch_add(bytes.len() as u64, Ordering::Relaxed)
            .saturating_add(bytes.len() as u64) as usize;
        let truncated = new_total > store.data().max_log_bytes;

        store.data().emitter.emit_partial_json(serde_json::json!({
            "jobId": store.data().job_id,
            "task": store.data().task,
            "seq": seq_no,
            "kind": "log",
            "stream": "uicp_logger",
            "level": level_str,
            "tick": tick_no,
            "bytesLen": bytes.len(),
            "previewB64": preview_b64,
            "truncated": truncated,
        }));

        // Mirror to debug-log for developer visibility
        store.data().emitter.emit_debug(serde_json::json!({
            "event": "compute_guest_log",
            "jobId": store.data().job_id,
            "task": store.data().task,
            "level": level_str,
            "message": truncate_message(&message, MAX_STDIO_CHARS),
            "ts": Utc::now().timestamp_millis(),
        }));
        Ok(())
    }

    fn host_clock_now_ms(
        mut store: StoreContextMut<'_, Ctx>,
        (job,): (String,),
    ) -> anyhow::Result<u64> {
        let ctx = store.data();
        if job != ctx.job_id {
            log_job_mismatch(ctx, "clock.now-ms", &job);
        }
        // Deterministic logical time: increment a job-scoped tick and return it (ms units)
        Ok(store
            .data()
            .logical_tick
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1))
    }

    fn derive_rng_block(seed: &[u8; 32], counter: u64) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(seed);
        hasher.update(counter.to_le_bytes());
        hasher.finalize().into()
    }

    fn log_job_mismatch(ctx: &Ctx, operation: &str, requested: &str) {
        ctx.emitter.emit_debug(serde_json::json!({
            "event": "compute_job_mismatch",
            "operation": operation,
            "jobId": ctx.job_id,
            "task": ctx.task,
            "requested": requested,
            "ts": Utc::now().timestamp_millis(),
        }));
    }

    /// Map a Wasmtime/linker error into a compute taxonomy code and message.
    fn map_trap_error(err: &anyhow::Error) -> (&'static str, String) {
        // Accumulate lowercased error text across the chain for robust matching
        let mut acc = String::new();
        acc.push_str(&err.to_string().to_ascii_lowercase());
        for source in err.chain().skip(1) {
            acc.push_str("::");
            acc.push_str(&source.to_string().to_ascii_lowercase());
        }

        // Timeout signals: epoch/interrupt/deadline
        if acc.contains("epoch")
            || acc.contains("deadline")
            || acc.contains("interrupt")
            || acc.contains("deadline exceeded")
        {
            return (error_codes::TIMEOUT, String::new());
        }
        // CPU fuel exhaustion (if enabled)
        if acc.contains("fuel")
            && (acc.contains("exhaust") || acc.contains("consum") || acc.contains("out of"))
        {
            return (error_codes::RESOURCE_LIMIT, String::new());
        }
        // Memory / resource limits
        if acc.contains("out of memory")
            || (acc.contains("memory")
                && (acc.contains("limit")
                    || acc.contains("exceed")
                    || acc.contains("grow")
                    || acc.contains("oom")))
            || acc.contains("resource limit")
            || acc.contains("limit exceeded")
        {
            return (error_codes::RESOURCE_LIMIT, String::new());
        }
        // Missing exports / bad linkage
        if (acc.contains("export") && (acc.contains("not found") || acc.contains("unknown")))
            || (acc.contains("instantiate") && acc.contains("missing"))
        {
            return (error_codes::TASK_NOT_FOUND, String::new());
        }
        // Capability denial (FS/HTTP off by default in V1)
        if acc.contains("permission") || acc.contains("denied") {
            return (error_codes::CAPABILITY_DENIED, String::new());
        }
        (error_codes::RUNTIME_FAULT, String::new())
    }

    async fn finalize_error(
        app: &AppHandle,
        spec: &ComputeJobSpec,
        code: &str,
        message: &str,
        started: Instant,
    ) {
        let ms = started.elapsed().as_millis() as i64;
        let payload = crate::ComputeFinalErr {
            ok: false,
            job_id: spec.job_id.clone(),
            task: spec.task.clone(),
            code: code.into(),
            message: message.into(),
        };
        // Surface a debug-log entry for observability with a unique error code per event
        let _ = app.emit(
            "debug-log",
            serde_json::json!({
                "event": "compute_error",
                "jobId": spec.job_id,
                "task": spec.task,
                "code": code,
                "ts": chrono::Utc::now().timestamp_millis(),
            }),
        );
        let _ = app.emit("compute.result.final", payload.clone());
        if spec.replayable && spec.cache == "readwrite" {
            let key = crate::compute_cache::compute_key(
                &spec.task,
                &spec.input,
                &spec.provenance.env_hash,
            );
            let mut obj = serde_json::to_value(&payload).unwrap_or(serde_json::json!({}));
            if let Some(map) = obj.as_object_mut() {
                map.insert("metrics".into(), serde_json::json!({ "durationMs": ms }));
            }
            let _ = crate::compute_cache::store(
                app,
                &spec.workspace_id,
                &key,
                &spec.task,
                &spec.provenance.env_hash,
                &obj,
            )
            .await;
        }
    }

    async fn finalize_ok(
        app: &AppHandle,
        spec: &ComputeJobSpec,
        output: serde_json::Value,
        started: Instant,
    ) {
        let ms = started.elapsed().as_millis() as i64;
        let payload = crate::ComputeFinalOk {
            ok: true,
            job_id: spec.job_id.clone(),
            task: spec.task.clone(),
            output: output.clone(),
            metrics: Some(serde_json::json!({ "durationMs": ms })),
        };
        let _ = app.emit("compute.result.final", payload);
        if spec.replayable && spec.cache == "readwrite" {
            let key = crate::compute_cache::compute_key(
                &spec.task,
                &spec.input,
                &spec.provenance.env_hash,
            );
            let mut obj = serde_json::json!({ "ok": true, "jobId": spec.job_id, "task": spec.task, "output": output });
            if let Some(map) = obj.as_object_mut() {
                map.insert(
                    "metrics".into(),
                    serde_json::json!({ "durationMs": ms, "cacheHit": false }),
                );
            }
            let _ = crate::compute_cache::store(
                app,
                &spec.workspace_id,
                &key,
                &spec.task,
                &spec.provenance.env_hash,
                &obj,
            )
            .await;
        }
    }

    async fn finalize_ok_with_metrics(
        app: &AppHandle,
        spec: &ComputeJobSpec,
        output: serde_json::Value,
        mut metrics: serde_json::Value,
    ) {
        // Compute a deterministic hash of the final output for determinism goldens.
        let canonical = crate::compute_cache::canonicalize_input(&output);
        let mut hasher = sha2::Sha256::new();
        use sha2::Digest;
        hasher.update(canonical.as_bytes());
        let out_hash = hex::encode(hasher.finalize());
        if let Some(map) = metrics.as_object_mut() {
            map.insert("outputHash".into(), serde_json::json!(out_hash));
        }
        let payload = crate::ComputeFinalOk {
            ok: true,
            job_id: spec.job_id.clone(),
            task: spec.task.clone(),
            output: output.clone(),
            metrics: Some(metrics.clone()),
        };
        let _ = app.emit("compute.result.final", payload);
        if spec.replayable && spec.cache == "readwrite" {
            let key = crate::compute_cache::compute_key(
                &spec.task,
                &spec.input,
                &spec.provenance.env_hash,
            );
            let mut obj = serde_json::json!({ "ok": true, "jobId": spec.job_id, "task": spec.task, "output": output });
            if let Some(map) = obj.as_object_mut() {
                map.insert("metrics".into(), metrics);
            }
            let _ = crate::compute_cache::store(
                app,
                &spec.workspace_id,
                &key,
                &spec.task,
                &spec.provenance.env_hash,
                &obj,
            )
            .await;
        }
    }

    async fn cleanup_job(app: &AppHandle, job_id: &str) {
        let state: tauri::State<'_, crate::AppState> = app.state();
        state.compute_cancel.write().await.remove(job_id);
        crate::remove_compute_job(app, job_id).await;
    }

    fn collect_metrics(store: &mut wasmtime::Store<Ctx>) -> serde_json::Value {
        let duration_ms = store.data().started.elapsed().as_millis() as i64;
        let remaining = (store.data().deadline_ms as i64 - duration_ms).max(0) as i64;
        let metrics = serde_json::json!({
            "durationMs": duration_ms,
            "deadlineMs": store.data().deadline_ms,
            "logCount": store.data().log_count.load(Ordering::Relaxed),
            "partialFrames": store.data().partial_frames.load(Ordering::Relaxed),
            "invalidPartialsDropped": store.data().invalid_partial_frames.load(Ordering::Relaxed),
            "remainingMsAtFinish": remaining,
        });
        metrics
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn sanitize_ws_files_path_blocks_traversal_and_maps_under_files_dir() {
            let base = crate::files_dir_path().to_path_buf();
            std::fs::create_dir_all(&base).expect("create files dir");
            let ok = sanitize_ws_files_path("ws:/files/sub/dir/file.csv").expect("ok path");
            assert!(ok.starts_with(&base));
            assert!(ok.ends_with(std::path::Path::new("sub/dir/file.csv")));
            assert!(sanitize_ws_files_path("ws:/files/..//secret").is_err());
            assert!(sanitize_ws_files_path("ws:/other/file.txt").is_err());
            let _ = std::fs::remove_dir_all(base.join("sub"));
        }

        #[cfg(unix)]
        #[test]
        fn sanitize_ws_files_path_rejects_symlink_escape() {
            use std::os::unix::fs::symlink;
            let base = crate::files_dir_path().to_path_buf();
            std::fs::create_dir_all(&base).expect("create files dir");

            let outside_root = base.parent().unwrap().join("symlink-escape-outside");
            std::fs::create_dir_all(&outside_root).expect("create outside dir");
            let outside_file = outside_root.join("secret.txt");
            std::fs::write(&outside_file, "nope").expect("write outside");

            let link_dir = base.join("symlink-escape-link");
            let _ = std::fs::remove_file(&link_dir);
            let _ = std::fs::remove_dir(&link_dir);
            symlink(&outside_root, &link_dir).expect("create symlink");

            let err =
                sanitize_ws_files_path("ws:/files/symlink-escape-link/secret.txt").unwrap_err();
            assert!(
                err.contains("escapes workspace"),
                "unexpected error message: {err}"
            );

            let _ = std::fs::remove_file(&outside_file);
            let _ = std::fs::remove_dir_all(&outside_root);
            let _ = std::fs::remove_file(&link_dir);
        }

        #[test]
        fn fs_read_allowed_supports_exact_and_glob() {
            let mut spec = ComputeJobSpec {
                job_id: "00000000-0000-4000-8000-000000000000".into(),
                task: "csv.parse@1.2.0".into(),
                input: serde_json::json!({}),
                timeout_ms: Some(30_000),
                fuel: None,
                mem_limit_mb: None,
                bind: vec![],
                cache: "readwrite".into(),
                capabilities: crate::ComputeCapabilitiesSpec {
                    fs_read: vec!["ws:/files/**".into()],
                    fs_write: vec![],
                    net: vec![],
                    long_run: false,
                    mem_high: false,
                },
                workspace_id: "default".into(),
                replayable: true,
                provenance: crate::ComputeProvenanceSpec {
                    env_hash: "dev".into(),
                    agent_trace_id: None,
                },
            };
            assert!(fs_read_allowed(&spec, "ws:/files/sub/file.txt"));
            spec.capabilities.fs_read = vec!["ws:/files/sub/file.txt".into()];
            assert!(fs_read_allowed(&spec, "ws:/files/sub/file.txt"));
            assert!(!fs_read_allowed(&spec, "ws:/files/other/file.txt"));
        }

        #[test]
        fn trap_mapping_matches_timeouts_and_limits_and_perms() {
            let (code, _msg) = map_trap_error(&anyhow::anyhow!("epoch deadline exceeded"));
            assert_eq!(code, error_codes::TIMEOUT);

            let (code, _msg) =
                map_trap_error(&anyhow::anyhow!("out of memory while growing memory"));
            assert_eq!(code, error_codes::RESOURCE_LIMIT);

            let (code, _msg) = map_trap_error(&anyhow::anyhow!("permission denied opening file"));
            assert_eq!(code, error_codes::CAPABILITY_DENIED);
        }

        #[test]
        fn resolve_csv_source_passes_through_non_workspace_values() {
            let spec = ComputeJobSpec {
                job_id: "00000000-0000-4000-8000-000000000000".into(),
                task: "csv.parse@1.2.0".into(),
                input: serde_json::json!({}),
                timeout_ms: Some(30_000),
                fuel: None,
                mem_limit_mb: None,
                bind: vec![],
                cache: "readwrite".into(),
                capabilities: crate::ComputeCapabilitiesSpec::default(),
                workspace_id: "default".into(),
                replayable: true,
                provenance: crate::ComputeProvenanceSpec {
                    env_hash: "dev".into(),
                    agent_trace_id: None,
                },
            };
            let original = "data:text/csv,foo,bar";
            let resolved = resolve_csv_source(&spec, original).expect("passthrough");
            assert_eq!(resolved, original);
        }

        #[test]
        fn resolve_csv_source_requires_capability_and_reads_file() {
            use std::io::Write;
            let base = crate::files_dir_path().join("tests");
            std::fs::create_dir_all(&base).expect("create test dir");
            let file_path = base.join("resolve_csv_source.csv");
            {
                let mut f = std::fs::File::create(&file_path).expect("create file");
                writeln!(f, "name,qty").unwrap();
                writeln!(f, "alpha,1").unwrap();
            }
            let spec_ok = ComputeJobSpec {
                job_id: "00000000-0000-4000-8000-000000000000".into(),
                task: "csv.parse@1.2.0".into(),
                input: serde_json::json!({}),
                timeout_ms: Some(30_000),
                fuel: None,
                mem_limit_mb: None,
                bind: vec![],
                cache: "readwrite".into(),
                capabilities: crate::ComputeCapabilitiesSpec {
                    fs_read: vec!["ws:/files/**".into()],
                    ..Default::default()
                },
                workspace_id: "default".into(),
                replayable: true,
                provenance: crate::ComputeProvenanceSpec {
                    env_hash: "dev".into(),
                    agent_trace_id: None,
                },
            };
            let ws_path = "ws:/files/tests/resolve_csv_source.csv";
            let resolved = resolve_csv_source(&spec_ok, ws_path).expect("resolves");
            assert!(resolved.starts_with("data:text/csv;base64,"));
            let b64 = resolved.trim_start_matches("data:text/csv;base64,");
            let decoded = BASE64_ENGINE.decode(b64).expect("decode b64");
            let text = String::from_utf8(decoded).expect("utf8");
            assert!(text.contains("alpha,1"));

            let spec_denied = ComputeJobSpec {
                capabilities: crate::ComputeCapabilitiesSpec::default(),
                ..spec_ok.clone()
            };
            let err = resolve_csv_source(&spec_denied, ws_path).expect_err("cap denied");
            assert_eq!(err.0, error_codes::CAPABILITY_DENIED);

            let invalid =
                resolve_csv_source(&spec_ok, "ws:/files/../secret.csv").expect_err("invalid path");
            assert_eq!(invalid.0, "IO.Denied");

            let _ = std::fs::remove_file(&file_path);
            let _ = std::fs::remove_dir_all(&base);
        }
    }

// -----------------------------------------------------------------------------
// Non-wasm unit tests for helpers
// -----------------------------------------------------------------------------
#[cfg(test)]
mod helper_tests {
    use super::*;

    #[test]
    fn extract_csv_input_supports_has_header_variants() {
        let v1 = serde_json::json!({"source":"x","hasHeader":true});
        let (s1, h1) = extract_csv_input(&v1).unwrap();
        assert_eq!(s1, "x");
        assert!(h1);

        let v2 = serde_json::json!({"source":"y","has-header":false});
        let (s2, h2) = extract_csv_input(&v2).unwrap();
        assert_eq!(s2, "y");
        assert!(!h2);
    }

    #[test]
    fn extract_table_query_input_parses_rows_select_and_where() {
        let v = serde_json::json!({
            "rows": [["a","b"],["c","d"]],
            "select": [1u32,0u32],
            "where_contains": {"col": 0u32, "needle": "a"}
        });
        let (rows, sel, where_opt) = extract_table_query_input(&v).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], vec!["a".to_string(), "b".to_string()]);
        assert_eq!(sel, vec![1u32, 0u32]);
        assert_eq!(where_opt, Some((0u32, "a".into())));
    }
    }
}

#[cfg(not(feature = "wasm_compute"))]
mod no_runtime {
    use super::*;
    use crate::ComputeFinalErr;
    pub(super) fn spawn_job(
        app: AppHandle,
        spec: ComputeJobSpec,
        permit: Option<OwnedSemaphorePermit>,
    ) -> JoinHandle<()> {
        tauri_spawn(async move {
            let _permit = permit;
            // Register cancel channel
            let (tx_cancel, mut rx_cancel) = tokio::sync::watch::channel(false);
            {
                let state: tauri::State<'_, crate::AppState> = app.state();
                state
                    .compute_cancel
                    .write()
                    .await
                    .insert(spec.job_id.clone(), tx_cancel);
            }

            tokio::select! {
                _ = rx_cancel.changed() => {
                    let payload = ComputeFinalErr { ok: false, job_id: spec.job_id.clone(), task: spec.task.clone(), code: error_codes::CANCELLED.into(), message: "Job cancelled by user".into() };
                    let _ = app.emit("compute.result.final", payload);
                }
                _ = tokio::time::sleep(Duration::from_millis(50)) => {
                    let payload = ComputeFinalErr {
                        ok: false,
                        job_id: spec.job_id.clone(),
                        task: spec.task.clone(),
                        code: error_codes::RUNTIME_FAULT.into(),
                        message: "Wasm compute runtime disabled in this build; recompile with feature wasm_compute".into(),
                    };
                    let _ = app.emit("debug-log", serde_json::json!({
                        "event": "compute_disabled",
                        "jobId": spec.job_id,
                        "task": spec.task,
                    }));
                    let _ = app.emit("compute.result.final", payload.clone());
                    if spec.replayable && spec.cache == "readwrite" {
                        let key = crate::compute_cache::compute_key(&spec.task, &spec.input, &spec.provenance.env_hash);
                        let _ = crate::compute_cache::store(&app, &spec.workspace_id, &key, &spec.task, &spec.provenance.env_hash, &serde_json::to_value(&payload).unwrap()).await;
                    }
                }
            }
            // Cleanup cancel map and job registry
            {
                let state: tauri::State<'_, crate::AppState> = app.state();
                state.compute_cancel.write().await.remove(&spec.job_id);
            }
            crate::remove_compute_job(&app, &spec.job_id).await;
        })
    }
}

/// Public shim that selects the correct implementation.
pub fn spawn_job(
    app: AppHandle,
    spec: ComputeJobSpec,
    permit: Option<OwnedSemaphorePermit>,
) -> JoinHandle<()> {
    #[cfg(feature = "wasm_compute")]
    {
        with_runtime::spawn_job(app, spec, permit)
    }
    #[cfg(not(feature = "wasm_compute"))]
    {
        no_runtime::spawn_job(app, spec, permit)
    }
}
