//! UICP Wasm compute host (WASI Preview 2, Component Model).
//!
//! This module selects implementation based on the `wasm_compute` feature:
//! - when enabled, it embeds Wasmtime with typed hostcalls and module registry.
//! - when disabled, it surfaces a structured error so callers know the runtime is unavailable.

use std::time::Duration;

#[cfg(feature = "wasm_compute")]
use std::time::Instant;

#[cfg(feature = "wasm_compute")]
use base64::engine::general_purpose::STANDARD as BASE64_ENGINE;
#[cfg(feature = "wasm_compute")]
use base64::Engine as _;
use tauri::async_runtime::{spawn as tauri_spawn, JoinHandle};
use tauri::{Emitter, Manager, Runtime};
#[cfg(feature = "wasm_compute")]
use tokio::sync::mpsc;
use tokio::sync::OwnedSemaphorePermit;

#[cfg(feature = "wasm_compute")]
use crate::compute_input::{
    derive_job_seed, extract_csv_input, extract_table_query_input, resolve_csv_source,
};
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
}

// -----------------------------------------------------------------------------
// Shared helpers (feature-independent) for task input prep and workspace FS policy
// -----------------------------------------------------------------------------

// NOTE: helper input tests now live in `compute_input.rs`.

#[cfg_attr(not(feature = "uicp_wasi_enable"), allow(dead_code))]
#[cfg(feature = "wasm_compute")]
mod with_runtime {
    use super::*;
    // WHY: Bring `Context` into scope for error enrichment on Wasmtime operations.
    // SAFETY: Some build permutations may not hit the `.context()` paths; suppress unused lint.
    #[allow(unused_imports)]
    use anyhow::Context as _;
    // NOTE: Wasmtime 37 API: we'll wire wasi:logging directly instead of using bindgen.
    use bytes::Bytes;
    use chrono::Utc;
    use ciborium::value::Value;
    use dashmap::DashMap;
    use once_cell::sync::Lazy;
    use serde_json;
    use sha2::{Digest, Sha256};
    use std::convert::TryFrom;
    use std::io::Cursor;
    use std::sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    };
    use tauri::AppHandle;
    use tokio::sync::mpsc::error::TryRecvError;
    use tokio::time::{sleep, Duration as TokioDuration};
    use wasmtime::{
        component::{Component, Linker, Resource, ResourceTable},
        Config, Engine, Store, StoreContextMut, StoreLimits, StoreLimitsBuilder,
    };
    use wasmtime_wasi::async_trait;
    use wasmtime_wasi::p2::{
        add_to_linker_async, DynOutputStream, OutputStream as WasiOutputStreamTrait, Pollable,
        StreamResult,
    };
    use wasmtime_wasi::{DirPerms, FilePerms, WasiCtx, WasiCtxBuilder, WasiCtxView, WasiView};

    const DEFAULT_MEMORY_LIMIT_MB: u64 = 256;
    const EPOCH_TICK_INTERVAL_MS: u64 = 10;
    // Max total bytes we will emit across all stdio log frames per job (deterministic cap)
    const MAX_LOG_BYTES: usize = 256 * 1024;
    // Max preview bytes per log frame to include in partial events
    const LOG_PREVIEW_MAX: usize = 256;

    // Adaptive controller parameters
    const ADAPT_SAMPLE_MS: u64 = 800; // sampling interval
    const AIMD_INC: f64 = 1.10; // increase factor
    const AIMD_DEC: f64 = 0.75; // decrease factor
    const WAITS_HI: u64 = 3; // waits per sample considered high
                             // Per-channel min/max bounds
    const RL_BYTES_MIN: usize = 64 * 1024; // 64 KiB/s
    const RL_BYTES_MAX: usize = 1024 * 1024; // 1 MiB/s (stdout/stderr)
    const LOGGER_BYTES_MIN: usize = 16 * 1024; // 16 KiB/s
    const LOGGER_BYTES_MAX: usize = 256 * 1024; // 256 KiB/s
    const EVENTS_MIN: u32 = 10; // 10 events/s
    const EVENTS_MAX: u32 = 60; // 60 events/s

    // Bindgen generation is deferred; we directly use typed funcs via `get_typed_func` for now.

    // removed unused is_typed_only helper

    trait TelemetryEmitter: Send + Sync {
        fn emit_debug(&self, payload: serde_json::Value);
        fn emit_partial(&self, event: crate::ComputePartialEvent);
        fn emit_partial_json(&self, payload: serde_json::Value);
    }

    enum UiEvent {
        Debug(serde_json::Value),
        PartialEvent(crate::ComputePartialEvent),
        PartialJson(serde_json::Value),
    }

    #[allow(dead_code)]
    const MAX_STDIO_CHARS: usize = 4_096;

    #[derive(Debug)]
    struct LimitsWithPeak {
        inner: StoreLimits,
        mem_peak_bytes: usize,
    }

    impl LimitsWithPeak {
        fn new(mem_limit_bytes: usize) -> Self {
            let inner = StoreLimitsBuilder::new()
                .instances(1)
                .tables(32)
                .memory_size(mem_limit_bytes)
                .build();
            Self {
                inner,
                mem_peak_bytes: 0,
            }
        }

        fn mem_peak_mb(&self) -> u64 {
            // Round up to the nearest MiB
            ((self.mem_peak_bytes as u64) + 1_048_575) / 1_048_576
        }
    }

    impl wasmtime::ResourceLimiter for LimitsWithPeak {
        fn memory_growing(
            &mut self,
            current: usize,
            desired: usize,
            maximum: Option<usize>,
        ) -> anyhow::Result<bool> {
            if desired > self.mem_peak_bytes {
                self.mem_peak_bytes = desired;
            }
            self.inner.memory_growing(current, desired, maximum)
        }

        fn table_growing(
            &mut self,
            current: usize,
            desired: usize,
            maximum: Option<usize>,
        ) -> anyhow::Result<bool> {
            self.inner.table_growing(current, desired, maximum)
        }
    }

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
        initial_fuel: u64,
        // Rate limiters and throttle counters (stdout/stderr)
        log_rate: Arc<Mutex<RateLimiterBytes>>,
        log_throttle_waits: Arc<AtomicU64>,
        // Logger quotas (uicp:host/logger)
        logger_rate: Arc<Mutex<RateLimiterBytes>>,
        logger_throttle_waits: Arc<AtomicU64>,
        partial_rate: Arc<Mutex<RateLimiterEvents>>,
        partial_throttle_waits: Arc<AtomicU64>,
        limits: LimitsWithPeak,
    }

    impl Ctx {
        fn log_p2(&mut self, level: u32, context: String, message: String) {
            let level_str = match level {
                0 => "trace",
                1 => "debug",
                2 => "info",
                3 => "warn",
                4 => "error",
                5 => "critical",
                _ => "info",
            };

            let message_bytes = message.as_bytes();
            let message_len = message_bytes.len();
            let total = message_len.saturating_add(context.len());

            loop {
                let wait_for;
                {
                    let mut rl = self.logger_rate.lock().unwrap();
                    let avail = rl.available();
                    if avail >= total {
                        rl.consume(total);
                        break;
                    }
                    let deficit = total.saturating_sub(avail);
                    wait_for = rl.recommended_sleep(deficit);
                }
                self.logger_throttle_waits.fetch_add(1, Ordering::Relaxed);
                if wait_for.as_nanos() == 0 {
                    std::thread::yield_now();
                } else {
                    std::thread::sleep(wait_for);
                }
            }

            let emitted = self.emitted_log_bytes.load(Ordering::Relaxed) as usize;
            if emitted >= self.max_log_bytes {
                // WHY: Enforce deterministic log budget; once we hit the cap we drop extra frames to keep runtime stable.
                return;
            }

            let preview_len = message_len.min(LOG_PREVIEW_MAX);
            let preview_b64 = if preview_len > 0 {
                BASE64_ENGINE.encode(&message_bytes[..preview_len])
            } else {
                String::new()
            };

            let seq_no = self
                .partial_seq
                .fetch_add(1, Ordering::Relaxed)
                .saturating_add(1);
            let tick_no = self
                .logical_tick
                .fetch_add(1, Ordering::Relaxed)
                .saturating_add(1);

            let new_total = self
                .emitted_log_bytes
                .fetch_add(message_len as u64, Ordering::Relaxed)
                .saturating_add(message_len as u64) as usize;
            let truncated = new_total > self.max_log_bytes;
            self.log_count.fetch_add(1, Ordering::Relaxed);

            self.emitter.emit_partial_json(serde_json::json!({
                "jobId": self.job_id,
                "task": self.task,
                "seq": seq_no,
                "kind": "log",
                "stream": "wasi-logging",
                "level": level_str,
                "context": context,
                "tick": tick_no,
                "bytesLen": message_len,
                "previewB64": preview_b64,
                "truncated": truncated,
            }));

            self.emitter.emit_debug(serde_json::json!({
                "event": "compute_guest_log",
                "jobId": self.job_id,
                "task": self.task,
                "level": level_str,
                "context": "wasi-logging",
                "len": message_len,
                "ts": Utc::now().timestamp_millis(),
            }));
        }
    }

    const MAX_PARTIAL_FRAME_BYTES: usize = 64 * 1024;

    struct QueueingEmitter {
        tx: Mutex<mpsc::Sender<UiEvent>>,
    }

    impl Clone for QueueingEmitter {
        fn clone(&self) -> Self {
            let tx = self.tx.lock().unwrap().clone();
            Self { tx: Mutex::new(tx) }
        }
    }

    impl TelemetryEmitter for QueueingEmitter {
        fn emit_debug(&self, payload: serde_json::Value) {
            loop {
                let tx = self.tx.lock().unwrap();
                if tx.try_send(UiEvent::Debug(payload.clone())).is_ok() {
                    break;
                }
                drop(tx);
                cooperative_backoff();
            }
        }
        fn emit_partial(&self, event: crate::ComputePartialEvent) {
            loop {
                let tx = self.tx.lock().unwrap();
                if tx.try_send(UiEvent::PartialEvent(event.clone())).is_ok() {
                    break;
                }
                drop(tx);
                cooperative_backoff();
            }
        }
        fn emit_partial_json(&self, payload: serde_json::Value) {
            loop {
                let tx = self.tx.lock().unwrap();
                if tx.try_send(UiEvent::PartialJson(payload.clone())).is_ok() {
                    break;
                }
                drop(tx);
                cooperative_backoff();
            }
        }
    }

    struct PartialStreamShared {
        emitter: Arc<dyn TelemetryEmitter>,
        job_id: String,
        task: String,
        partial_seq: Arc<AtomicU64>,
        partial_frames: Arc<AtomicU64>,
        invalid_partial_frames: Arc<AtomicU64>,
        // Rate limiting for partial frames (events/s)
        partial_rate: Arc<Mutex<RateLimiterEvents>>,
        partial_throttle_waits: Arc<AtomicU64>,
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
            self.shared.emitter.emit_debug(serde_json::json!({
                "event": "compute_partial_reject",
                "jobId": self.shared.job_id,
                "task": self.shared.task,
                "reason": err.to_string(),
                "len": len,
                "ts": Utc::now().timestamp_millis(),
            }));
        }
    }

    #[async_trait]
    impl Pollable for PartialOutputStream {
        async fn ready(&mut self) {
            loop {
                let wait_for = {
                    let mut rl = self.shared.partial_rate.lock().unwrap();
                    if rl.try_take_event() {
                        return;
                    }
                    rl.recommended_sleep()
                };
                self.shared
                    .partial_throttle_waits
                    .fetch_add(1, Ordering::Relaxed);
                if wait_for.as_nanos() == 0 {
                    tokio::task::yield_now().await;
                } else {
                    sleep(TokioDuration::from_secs_f64(wait_for.as_secs_f64())).await;
                }
            }
        }
    }

    #[async_trait]
    impl WasiOutputStreamTrait for PartialOutputStream {
        fn write(&mut self, bytes: Bytes) -> StreamResult<()> {
            if bytes.is_empty() {
                return Ok(());
            }
            match self.process_frame(bytes.as_ref()) {
                Ok(event) => {
                    self.shared.partial_frames.fetch_add(1, Ordering::Relaxed);
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

        fn flush(&mut self) -> StreamResult<()> {
            Ok(())
        }

        fn check_write(&mut self) -> StreamResult<usize> {
            let mut rl = self.shared.partial_rate.lock().unwrap();
            if rl.peek_tokens() >= 1.0 {
                Ok(usize::MAX)
            } else {
                Ok(0)
            }
        }
    }

    
    #[allow(dead_code)]
    struct GuestLogShared {
        emitter: Arc<dyn TelemetryEmitter>,
        job_id: String,
        task: String,
        seq: Arc<AtomicU64>,
        tick: Arc<AtomicU64>,
        log_count: Arc<AtomicU64>,
        emitted_bytes: Arc<AtomicU64>,
        max_bytes: usize,
        max_len: usize,
        buf: Mutex<Vec<u8>>,
        log_rate: Arc<Mutex<RateLimiterBytes>>,
        log_throttle_waits: Arc<AtomicU64>,
        action_log: crate::action_log::ActionLogHandle,
    }

    #[allow(dead_code)]
    impl GuestLogShared {
        fn clamp_preview(&self, bytes: &[u8]) -> String {
            let preview_len = bytes.len().min(LOG_PREVIEW_MAX);
            BASE64_ENGINE.encode(&bytes[..preview_len])
        }
    }

    #[allow(dead_code)]
    struct GuestLogStream {
        shared: Arc<GuestLogShared>,
        channel: &'static str,
    }

    #[allow(dead_code)]
    impl GuestLogStream {
        fn emit_message(&self, bytes: &[u8]) {
            if bytes.is_empty() {
                return;
            }
            let len = bytes.len();
            loop {
                let wait_for;
                {
                    let mut rl = self.shared.log_rate.lock().unwrap();
                    let avail = rl.available();
                    if avail >= len {
                        rl.consume(len);
                        break;
                    }
                    let deficit = len.saturating_sub(avail);
                    wait_for = rl.recommended_sleep(deficit);
                }
                self.shared
                    .log_throttle_waits
                    .fetch_add(1, Ordering::Relaxed);
                if wait_for.as_nanos() == 0 {
                    std::thread::yield_now();
                } else {
                    std::thread::sleep(wait_for);
                }
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
                    let preview_b64 = self.shared.clamp_preview(to_emit);
                    let seq_no = self.shared.seq.fetch_add(1, Ordering::Relaxed) + 1;
                    let tick_no = self.shared.tick.fetch_add(1, Ordering::Relaxed) + 1;
                    let new_total =
                        self.shared
                            .emitted_bytes
                            .fetch_add(to_emit.len() as u64, Ordering::Relaxed)
                            .saturating_add(to_emit.len() as u64) as usize;
                    let truncated = new_total > self.shared.max_bytes;

                    self.shared.log_count.fetch_add(1, Ordering::Relaxed);

                    // WHY: Append to the durable action_log before UI emission to preserve append-first semantics.
                    let full_b64 = BASE64_ENGINE.encode(to_emit);
                    if let Err(err) = self.shared.action_log.append_json(
                        "compute.log",
                        &serde_json::json!({
                            "jobId": self.shared.job_id,
                            "task": self.shared.task,
                            "stream": self.channel,
                            "seq": seq_no,
                            "tick": tick_no,
                            "bytesLen": to_emit.len(),
                            "previewB64": preview_b64,
                            "lineB64": full_b64,
                            "truncated": truncated,
                        }),
                    ) {
                        // ERROR: E-UICP-601 Action log append failed — terminate job for loud failure.
                        panic!("E-UICP-601: action log append failed: {err}");
                    }

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
                    let output =
                        truncate_message(&String::from_utf8_lossy(to_emit), self.shared.max_len);
                    self.shared.emitter.emit_debug(serde_json::json!({
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
                Self::PayloadTooLarge(len) => {
                    write!(f, "embedded payload exceeds limit (len={})", len)
                }
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

    #[allow(dead_code)]
    fn truncate_message(input: &str, max_chars: usize) -> String {
        if input.chars().count() <= max_chars {
            return input.to_owned();
        }
        let truncated: String = input.chars().take(max_chars).collect();
        format!("{truncated}... (truncated)")
    }

    // ----------------------------
    // Token-bucket rate limiters
    // ----------------------------
    struct RateLimiterBytes {
        capacity: usize,
        refill_per_sec: usize,
        tokens: f64,
        last: Instant,
    }

    impl RateLimiterBytes {
        fn new(capacity: usize, refill_per_sec: usize) -> Self {
            Self {
                capacity,
                refill_per_sec,
                tokens: capacity as f64,
                last: Instant::now(),
            }
        }
        fn refill(&mut self) {
            let elapsed = self.last.elapsed().as_secs_f64();
            if elapsed > 0.0 {
                let add = elapsed * self.refill_per_sec as f64;
                self.tokens = (self.tokens + add).min(self.capacity as f64);
                self.last = Instant::now();
            }
        }
        fn available(&mut self) -> usize {
            self.refill();
            self.tokens.max(0.0) as usize
        }
        fn consume(&mut self, n: usize) {
            self.refill();
            self.tokens = (self.tokens - n as f64).max(0.0);
        }
        fn set_rate_per_sec(&mut self, rate: usize) {
            self.refill_per_sec = rate.max(1);
        }
        fn rate_per_sec(&self) -> usize {
            self.refill_per_sec
        }
        fn capacity(&self) -> usize {
            self.capacity
        }
        fn recommended_sleep(&self, deficit: usize) -> Duration {
            if deficit == 0 {
                return Duration::from_micros(0);
            }
            let rate = self.refill_per_sec.max(1);
            let seconds = deficit as f64 / rate as f64;
            let clamped = seconds.clamp(0.000_5, 0.010);
            Duration::from_secs_f64(clamped)
        }
    }

    fn cooperative_backoff() {
        std::thread::yield_now();
        std::thread::sleep(std::time::Duration::from_micros(500));
    }

    struct RateLimiterEvents {
        capacity: f64,
        refill_per_sec: f64,
        tokens: f64,
        last: Instant,
    }
    impl RateLimiterEvents {
        fn new(capacity: u32, refill_per_sec: u32) -> Self {
            Self {
                capacity: capacity as f64,
                refill_per_sec: refill_per_sec as f64,
                tokens: capacity as f64,
                last: Instant::now(),
            }
        }
        fn refill(&mut self) {
            let elapsed = self.last.elapsed().as_secs_f64();
            if elapsed > 0.0 {
                let add = elapsed * self.refill_per_sec;
                self.tokens = (self.tokens + add).min(self.capacity);
                self.last = Instant::now();
            }
        }
        fn try_take_event(&mut self) -> bool {
            self.refill();
            if self.tokens >= 1.0 {
                self.tokens -= 1.0;
                true
            } else {
                false
            }
        }
        fn peek_tokens(&mut self) -> f64 {
            self.refill();
            self.tokens
        }
        fn set_rate_per_sec(&mut self, rate: u32) {
            self.refill_per_sec = (rate.max(1)) as f64;
        }
        fn rate_per_sec(&self) -> u32 {
            self.refill_per_sec as u32
        }
        fn recommended_sleep(&self) -> Duration {
            if self.refill_per_sec <= 0.0 {
                return Duration::from_micros(0);
            }
            let seconds = (1.0 / self.refill_per_sec).clamp(0.000_5, 0.010);
            Duration::from_secs_f64(seconds)
        }
        fn capacity(&self) -> u32 {
            self.capacity as u32
        }
    }

    impl WasiView for Ctx {
        fn ctx(&mut self) -> WasiCtxView<'_> {
            WasiCtxView {
                ctx: &mut self.wasi,
                table: &mut self.table,
            }
        }
    }

    /// Global Engine configured for the Component Model with on-disk artifact cache enabled.
    static ENGINE: Lazy<Engine> = Lazy::new(|| {
        let mut cfg = Config::new();
        cfg.wasm_component_model(true)
            .async_support(true)
            .consume_fuel(true)
            .epoch_interruption(true)
            .wasm_memory64(false);
        Engine::new(&cfg).expect("wasmtime engine")
    });

    /// Reused Linker with WASI + host interfaces registered.
    static LINKER: Lazy<Linker<Ctx>> = Lazy::new(|| {
        let mut linker = Linker::<Ctx>::new(&ENGINE);
        add_wasi_and_host(&mut linker).expect("add wasi+host");
        linker
    });

    /// LRU-ish compiled Component cache keyed by path + mtime.
    static COMPONENT_CACHE: Lazy<DashMap<String, Arc<Component>>> = Lazy::new(DashMap::new);

    fn load_component_cached(path: &std::path::Path) -> anyhow::Result<Arc<Component>> {
        use std::fs;
        use std::time::{SystemTime, UNIX_EPOCH};
        let meta = fs::metadata(path)?;
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let mtime = modified
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let key = format!("{}|{}", path.display(), mtime);
        if let Some(found) = COMPONENT_CACHE.get(&key) {
            return Ok(found.clone());
        }
        let comp = Component::from_file(&*ENGINE, path)?;
        let arc = Arc::new(comp);
        COMPONENT_CACHE.insert(key, arc.clone());
        Ok(arc)
    }

    /// Build a fresh Engine (used by some unit tests); runtime uses the global ENGINE.
    #[cfg(any(test, feature = "compute_harness"))]
    #[cfg_attr(feature = "compute_harness", allow(dead_code))]
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
    pub(super) fn spawn_job<R: Runtime>(
        app: tauri::AppHandle<R>,
        spec: ComputeJobSpec,
        permit: Option<OwnedSemaphorePermit>,
        queue_wait_ms: u64,
    ) -> JoinHandle<()> {
        tauri_spawn(async move {
            #[cfg(feature = "otel_spans")]
            let _span =
                tracing::info_span!("compute_spawn_job", job_id = %spec.job_id, task = %spec.task)
                    .entered();
            let _permit = permit;
            let started = Instant::now();
            // WHY: Feature-flag-ish env var to dump diagnostics about WASI + component at job start.
            let diag_enabled = {
                let v = std::env::var("UICP_WASI_DIAG")
                    .or_else(|_| std::env::var("uicp_wasi_diag"))
                    .unwrap_or_default();
                matches!(v.as_str(), "1" | "true" | "TRUE" | "yes" | "on")
            };

            // Register cancel channel for this job
            let (tx_cancel, rx_cancel) = tokio::sync::watch::channel(false);
            {
                let state: tauri::State<'_, crate::AppState> = app.state();
                state
                    .compute_cancel
                    .write()
                    .await
                    .insert(spec.job_id.clone(), tx_cancel);
            }

            // Reuse global engine
            let engine: &Engine = &*ENGINE;

            // Resolve module by task@version
            let module = match registry::find_module(&app, &spec.task) {
                Ok(Some(m)) => m,
                Ok(None) => {
                    #[cfg(feature = "otel_spans")]
                    tracing::info!(target = "uicp", job_id = %spec.job_id, task = %spec.task, "module not found");
                    finalize_error(
                        &app,
                        &spec,
                        error_codes::TASK_NOT_FOUND,
                        "Module not found for task",
                        started,
                        queue_wait_ms,
                        None,
                    )
                    .await;
                    let state: tauri::State<'_, crate::AppState> = app.state();
                    state.compute_cancel.write().await.remove(&spec.job_id);
                    crate::remove_compute_job(&app, &spec.job_id).await;
                    return;
                }
                Err(err) => {
                    // WHY: Surface precise context so UI can see root-cause for module resolution faults.
                    // ERROR: E-UICP-221 registry lookup failed for task; message carries inner error string.
                    let any = anyhow::Error::from(err).context(format!(
                        "E-UICP-221: registry lookup failed for task '{}': module resolve error",
                        spec.task
                    ));
                    let (code, msg) = map_trap_error(&any);
                    let message = if msg.is_empty() { any.to_string() } else { msg };
                    #[cfg(feature = "otel_spans")]
                    tracing::error!(target = "uicp", job_id = %spec.job_id, task = %spec.task, error = %message, "module resolve error");
                    finalize_error(&app, &spec, code, &message, started, queue_wait_ms, None).await;
                    let state: tauri::State<'_, crate::AppState> = app.state();
                    state.compute_cancel.write().await.remove(&spec.job_id);
                    crate::remove_compute_job(&app, &spec.job_id).await;
                    return;
                }
            };

            // Load compiled component from cache
            let component = match load_component_cached(&module.path) {
                Ok(c) => c,
                Err(err) => {
                    // WHY: Carry the on-disk path and root cause to aid diagnosing cache/compile errors.
                    // ERROR: E-UICP-222 component load failed — likely invalid encoding or wrong target (not a component).
                    let any = anyhow::Error::from(err).context(format!(
                        "E-UICP-222: load component failed for path {}",
                        module.path.display()
                    ));
                    let (code, msg) = map_trap_error(&any);
                    let chain = format!("{:#}", &any); // include error chain
                    let message = if msg.is_empty() { chain } else { msg };
                    #[cfg(feature = "otel_spans")]
                    tracing::error!(target = "uicp", job_id = %spec.job_id, task = %spec.task, error = %message, "component load error");
                    finalize_error(&app, &spec, code, &message, started, queue_wait_ms, None).await;
                    let state: tauri::State<'_, crate::AppState> = app.state();
                    state.compute_cancel.write().await.remove(&spec.job_id);
                    crate::remove_compute_job(&app, &spec.job_id).await;
                    return;
                }
            };
            if diag_enabled {
                use std::fs;
                let size = fs::metadata(&module.path).map(|m| m.len()).unwrap_or(0);
                let _ = app.emit(
                    "debug-log",
                    serde_json::json!({
                        "event": "component_loaded",
                        "jobId": spec.job_id,
                        "task": spec.task,
                        "path": module.path,
                        "size": size,
                    }),
                );
            }

            // Build store context (no preopens by default; FS/NET off). Seed deterministic fields.
            let mem_limit_mb = spec
                .mem_limit_mb
                .filter(|mb| *mb > 0)
                .unwrap_or(DEFAULT_MEMORY_LIMIT_MB);
            let mem_limit_bytes = mem_limit_mb
                .saturating_mul(1_048_576)
                .min(usize::MAX as u64) as usize;
            let limits = LimitsWithPeak::new(mem_limit_bytes);
            let deadline_ms = spec.timeout_ms.unwrap_or(30_000).min(u32::MAX as u64);

            let ui_capacity: usize = if spec.task.contains("log") { 512 } else { 256 };
            let (tx_ui, mut rx_ui) = mpsc::channel::<UiEvent>(ui_capacity);
            let app_for_ui = app.clone();
            let drain: JoinHandle<()> = tauri_spawn(async move {
                while let Some(first) = rx_ui.recv().await {
                    // Micro-batch drain to reduce await overhead when backlog accumulates
                    let mut batch: Vec<UiEvent> = Vec::with_capacity(32);
                    batch.push(first);
                    for _ in 0..31 {
                        match rx_ui.try_recv() {
                            Ok(ev) => batch.push(ev),
                            Err(TryRecvError::Empty) => break,
                            Err(TryRecvError::Disconnected) => break,
                        }
                    }
                    for ev in batch.drain(..) {
                        match ev {
                            UiEvent::Debug(v) => {
                                let _ = app_for_ui.emit("debug-log", v);
                            }
                            UiEvent::PartialEvent(e) => {
                                crate::emit_or_log(&app_for_ui, "compute.result.partial", e);
                            }
                            UiEvent::PartialJson(v) => {
                                crate::emit_or_log(&app_for_ui, "compute.result.partial", v);
                            }
                        }
                    }
                }
            });
            let _ = drain;
            let telemetry: Arc<dyn TelemetryEmitter> = Arc::new(QueueingEmitter {
                tx: Mutex::new(tx_ui),
            });
            let partial_seq = Arc::new(AtomicU64::new(0));
            let partial_frames = Arc::new(AtomicU64::new(0));
            let invalid_partials = Arc::new(AtomicU64::new(0));
            let cancelled = Arc::new(AtomicBool::new(false));
            let log_count = Arc::new(AtomicU64::new(0));
            let logical_tick = Arc::new(AtomicU64::new(0));
            let emitted_bytes = Arc::new(AtomicU64::new(0));

            // Rate limiters (per job)
            let log_rate = Arc::new(Mutex::new(RateLimiterBytes::new(1024 * 1024, 256 * 1024))); // stdout+stderr
            let log_throttle_waits = Arc::new(AtomicU64::new(0));
            let logger_rate = Arc::new(Mutex::new(RateLimiterBytes::new(64 * 1024, 64 * 1024))); // logger import
            let logger_throttle_waits = Arc::new(AtomicU64::new(0));
            let partial_rate = Arc::new(Mutex::new(RateLimiterEvents::new(30, 30)));
            let partial_throttle_waits = Arc::new(AtomicU64::new(0));

            // Adaptive controller: adjust rates based on observed throttle waits.
            {
                let mut cancel_rx_for_ctrl = rx_cancel.clone();
                let log_rate_c = log_rate.clone();
                let logger_rate_c = logger_rate.clone();
                let partial_rate_c = partial_rate.clone();
                let log_waits_c = log_throttle_waits.clone();
                let logger_waits_c = logger_throttle_waits.clone();
                let partial_waits_c = partial_throttle_waits.clone();
                tauri_spawn(async move {
                    let mut last_log: u64 = 0;
                    let mut last_logger: u64 = 0;
                    let mut last_partial: u64 = 0;
                    let mut ewma_log = 0.0f64;
                    let mut ewma_logger = 0.0f64;
                    let mut ewma_partial = 0.0f64;
                    loop {
                        tokio::select! {
                            _ = sleep(TokioDuration::from_millis(ADAPT_SAMPLE_MS)) => {},
                            changed = cancel_rx_for_ctrl.changed() => {
                                if changed.is_err() { break; }
                                if *cancel_rx_for_ctrl.borrow() { break; }
                            }
                        }
                        let cur_log = log_waits_c.load(Ordering::Relaxed);
                        let cur_logger = logger_waits_c.load(Ordering::Relaxed);
                        let cur_partial = partial_waits_c.load(Ordering::Relaxed);
                        let d_log = cur_log.saturating_sub(last_log);
                        last_log = cur_log;
                        let d_logger = cur_logger.saturating_sub(last_logger);
                        last_logger = cur_logger;
                        let d_partial = cur_partial.saturating_sub(last_partial);
                        last_partial = cur_partial;
                        ewma_log = 0.7 * ewma_log + 0.3 * (d_log as f64);
                        ewma_logger = 0.7 * ewma_logger + 0.3 * (d_logger as f64);
                        ewma_partial = 0.7 * ewma_partial + 0.3 * (d_partial as f64);

                        // stdout/stderr
                        {
                            let mut rl = log_rate_c.lock().unwrap();
                            let cur = rl.rate_per_sec();
                            if ewma_log >= WAITS_HI as f64 {
                                let next = ((cur as f64) * AIMD_DEC).round() as usize;
                                rl.set_rate_per_sec(next.max(RL_BYTES_MIN).min(RL_BYTES_MAX));
                            } else if (ewma_log + ewma_logger + ewma_partial) < 0.5 {
                                let next = ((cur as f64) * AIMD_INC).round() as usize;
                                rl.set_rate_per_sec(next.max(RL_BYTES_MIN).min(RL_BYTES_MAX));
                            }
                        }
                        // logger
                        {
                            let mut rl = logger_rate_c.lock().unwrap();
                            let cur = rl.rate_per_sec();
                            if ewma_logger >= WAITS_HI as f64 {
                                let next = ((cur as f64) * AIMD_DEC).round() as usize;
                                rl.set_rate_per_sec(
                                    next.max(LOGGER_BYTES_MIN).min(LOGGER_BYTES_MAX),
                                );
                            } else if (ewma_log + ewma_logger + ewma_partial) < 0.5 {
                                let next = ((cur as f64) * AIMD_INC).round() as usize;
                                rl.set_rate_per_sec(
                                    next.max(LOGGER_BYTES_MIN).min(LOGGER_BYTES_MAX),
                                );
                            }
                        }
                        // partial events
                        {
                            let mut rl = partial_rate_c.lock().unwrap();
                            let cur = rl.rate_per_sec();
                            if ewma_partial >= WAITS_HI as f64 {
                                let next = ((cur as f64) * AIMD_DEC).round() as u32;
                                rl.set_rate_per_sec(next.max(EVENTS_MIN).min(EVENTS_MAX));
                            } else if (ewma_log + ewma_logger + ewma_partial) < 0.5 {
                                let next = ((cur as f64) * AIMD_INC).round() as u32;
                                rl.set_rate_per_sec(next.max(EVENTS_MIN).min(EVENTS_MAX));
                            }
                        }
                    }
                });
            }

            let mut wasi_builder = WasiCtxBuilder::new();
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

            // Derive deterministic seed from job + env for replay stability
            let seed = derive_job_seed(&spec.job_id, &spec.provenance.env_hash);
            let seed_hex = hex::encode(seed);

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
                rng_seed: seed,
                logical_tick: logical_tick.clone(),
                started,
                deadline_ms: deadline_ms as u32,
                rng_counter: 0,
                log_count,
                emitted_log_bytes: emitted_bytes.clone(),
                max_log_bytes: MAX_LOG_BYTES,
                initial_fuel: 0,
                log_rate,
                log_throttle_waits,
                logger_rate,
                logger_throttle_waits,
                partial_rate,
                partial_throttle_waits,
                limits,
            };
            let mut store: Store<Ctx> = Store::new(engine, ctx);
            store.limiter(|ctx| &mut ctx.limits);

            // Optional diagnostics for mounts/imports at job start (support both cases)
            if diag_enabled {
                telemetry.emit_debug(serde_json::json!({
                    "event": "wasi_diag",
                    "jobId": spec.job_id,
                    "task": spec.task,
                    "mounts": [{ "guest": "/ws/files", "host": crate::files_dir_path().display().to_string(), "perms": "ro" }],
                    "imports": ["wasi:io/streams", "wasi:clocks", "wasi:random", "wasi:logging", "uicp:host/*"],
                }));
            }
            // Emit seed for reproducibility in debug logs
            telemetry.emit_debug(serde_json::json!({
                "event": "rng_seed",
                "jobId": spec.job_id,
                "task": spec.task,
                "seedHex": seed_hex,
            }));

            // Configure fuel (optional) and epoch deadline enforcement.
            // Spawn epoch tick pump to enforce wall-clock deadline.
            if let Some(f) = spec.fuel.filter(|f| *f > 0) {
                // Record initial fuel in context and seed store fuel.
                store.data_mut().initial_fuel = f;
                let _ = store.set_fuel(f);
            }
            let mut deadline_ticks =
                deadline_ms.saturating_add(EPOCH_TICK_INTERVAL_MS - 1) / EPOCH_TICK_INTERVAL_MS;
            if deadline_ticks == 0 {
                deadline_ticks = 1;
            }
            store.set_epoch_deadline(deadline_ticks);
            let eng: &Engine = engine;
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
                let mut rx_cancel_for_ctx = rx_cancel.clone();
                tokio::spawn(async move {
                    let _ = rx_cancel_for_ctx.changed().await;
                    cancelled.store(true, Ordering::Relaxed);
                });
            }

            // Instantiate with shared linker (WASI + host already registered)
            let linker: &Linker<Ctx> = &*LINKER;

            // Instantiate the world and call exports using typed API (no bindgen for now)
            {
                // WHY: Add instantiation context so missing-import/linkage issues are visible in final error.
                // ERROR: E-UICP-223 instantiation failure — often indicates a missing or version-mismatched import.
                let inst_res: Result<wasmtime::component::Instance, _> =
                    linker.instantiate_async(&mut store, &*component).await;
                match inst_res {
                    Ok(instance) => {
                        let task_name = spec.task.split('@').next().unwrap_or("");
                        let artificial_delay_ms = std::env::var("UICP_TEST_COMPUTE_DELAY_MS")
                            .ok()
                            .and_then(|v| v.parse::<u64>().ok());
                        if let Some(delay) = artificial_delay_ms {
                            sleep(TokioDuration::from_millis(delay)).await;
                        }
                        let mut cancel_watch = rx_cancel.clone();
                        let call_future = async {
                            match task_name {
                                "csv.parse" => match extract_csv_input(&spec.input) {
                                    Ok((src, has_header)) => {
                                        match resolve_csv_source(&spec, &src) {
                                            Ok(resolved) => {
                                                // WHY: Attach precise lookup context for missing export scenarios.
                                                // ERROR: E-UICP-224 typed-func lookup failed for export `csv#run`.
                                                let func_res: Result<
                                                    wasmtime::component::TypedFunc<
                                                        (String, String, bool),
                                                        (Result<Vec<Vec<String>>, String>,),
                                                    >,
                                                    _,
                                                > = instance
                                                    .get_typed_func(&mut store, "csv#run")
                                                    .map_err(|e| anyhow::Error::from(e)
                                                        .context("E-UICP-224: get_typed_func csv#run failed"));
                                                match func_res {
                                                    Err(e) => Err(e),
                                                    Ok(func) => match func
                                                        .call_async(
                                                            &mut store,
                                                            (
                                                                spec.job_id.clone(),
                                                                resolved,
                                                                has_header,
                                                            ),
                                                        )
                                                        .await
                                                    {
                                                        Ok((Ok(rows),)) => {
                                                            Ok(serde_json::json!(rows))
                                                        }
                                                        Ok((Err(msg),)) => {
                                                            // WHY: Propagate guest error string verbatim; caller maps to final envelope.
                                                            Err(anyhow::Error::msg(msg))
                                                        }
                                                        // ERROR: E-UICP-225 call csv#run failed — include trap context for visibility.
                                                        Err(e) => Err(anyhow::Error::from(e)
                                                            .context(
                                                                "E-UICP-225: call csv#run failed",
                                                            )),
                                                    },
                                                }
                                            }
                                            Err(e) => Err(anyhow::anyhow!(format!(
                                                "{}: {}",
                                                e.code, e.message
                                            ))),
                                        }
                                    }
                                    Err(e) => {
                                        Err(anyhow::anyhow!(format!("{}: {}", e.code, e.message)))
                                    }
                                },
                                "table.query" => match extract_table_query_input(&spec.input) {
                                    Ok((rows, select, where_opt)) => {
                                        // WHY: Attach precise lookup context for missing export scenarios.
                                        // ERROR: E-UICP-226 typed-func lookup failed for export `table#run`.
                                        let func_res: Result<
                                            wasmtime::component::TypedFunc<
                                                (
                                                    String,
                                                    Vec<Vec<String>>,
                                                    Vec<u32>,
                                                    Option<(u32, String)>,
                                                ),
                                                (Result<Vec<Vec<String>>, String>,),
                                            >,
                                            _,
                                        > = instance
                                            .get_typed_func(&mut store, "table#run")
                                            .map_err(|e| {
                                                anyhow::Error::from(e).context(
                                                    "E-UICP-226: get_typed_func table#run failed",
                                                )
                                            });
                                        match func_res {
                                            Err(e) => Err(e),
                                            Ok(func) => match func
                                                .call_async(
                                                    &mut store,
                                                    (spec.job_id.clone(), rows, select, where_opt),
                                                )
                                                .await
                                            {
                                                Ok((Ok(out),)) => Ok(serde_json::json!(out)),
                                                Ok((Err(msg),)) => Err(anyhow::Error::msg(msg)),
                                                // ERROR: E-UICP-227 call table#run failed — include trap context for visibility.
                                                Err(e) => Err(anyhow::Error::from(e)
                                                    .context("E-UICP-227: call table#run failed")),
                                            },
                                        }
                                    }
                                    Err(e) => {
                                        Err(anyhow::anyhow!(format!("{}: {}", e.code, e.message)))
                                    }
                                },
                                _ => Err(anyhow::anyhow!("unknown task for this world")),
                            }
                        };
                        tokio::select! {
                            _ = cancel_watch.changed() => {
                                let metrics = collect_metrics(&store);
                                finalize_error(
                                    &app,
                                    &spec,
                                    error_codes::CANCELLED,
                                    "Job cancelled by user",
                                    started,
                                    queue_wait_ms,
                                    Some(metrics),
                                )
                                .await;
                                epoch_pump.abort();
                                let state: tauri::State<'_, crate::AppState> = app.state();
                                state.compute_cancel.write().await.remove(&spec.job_id);
                                crate::remove_compute_job(&app, &spec.job_id).await;
                                return;
                            }
                            call_outcome = call_future => {
                                match call_outcome {
                                    Ok(output_json) => {
                                        let metrics = collect_metrics(&store);
                                        finalize_ok_with_metrics(
                                            &app,
                                            &spec,
                                            output_json,
                                            metrics,
                                            queue_wait_ms,
                                        )
                                        .await;
                                    }
                                    Err(err) => {
                                        let (code, msg) = map_trap_error(&err);
                                        let message = if msg.is_empty() { err.to_string() } else { msg };
                                        let m = collect_metrics(&store);
                                        finalize_error(
                                            &app,
                                            &spec,
                                            code,
                                            &message,
                                            started,
                                            queue_wait_ms,
                                            Some(m),
                                        )
                                        .await;
                                    }
                                }
                            }
                        }
                        epoch_pump.abort();
                    }
                    Err(err) => {
                        // WHY: Make instantiation failures actionable by including context.
                        // ERROR: E-UICP-223 propagated — see message for missing imports or signature mismatch.
                        let any = anyhow::Error::from(err).context(format!(
                            "E-UICP-223: instantiate component for task '{}' failed",
                            spec.task
                        ));
                        let (code, msg) = map_trap_error(&any);
                        let message = if msg.is_empty() { any.to_string() } else { msg };
                        let m = collect_metrics(&store);
                        finalize_error(
                            &app,
                            &spec,
                            code,
                            &message,
                            started,
                            queue_wait_ms,
                            Some(m),
                        )
                        .await;
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
        add_to_linker_async(linker)?;
        // Register wasi:logging/logging import directly for P2.
        {
            let mut inst = linker.instance("wasi:logging/logging")?;
            inst.func_wrap(
                "log",
                |mut store: StoreContextMut<'_, Ctx>,
                 (level, context, message): (u32, String, String)| {
                    store.data_mut().log_p2(level, context, message);
                    Ok(())
                },
            )?;
        }
        add_uicp_host(linker)?;
        Ok(())
    }

    #[cfg(not(feature = "uicp_wasi_enable"))]
    fn add_wasi_and_host(_linker: &mut Linker<Ctx>) -> anyhow::Result<()> {
        Err(anyhow::anyhow!(
            "WASI imports disabled; rebuild with `--features uicp_wasi_enable` to enable WASI host imports"
        ))
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

    fn add_uicp_host(linker: &mut Linker<Ctx>) -> anyhow::Result<()> {
        register_control_interface(linker, "uicp:host/control")?;
        register_control_interface(linker, "uicp:host/control@1.0.0")?;
        register_rng_interface(linker, "uicp:host/rng")?;
        register_rng_interface(linker, "uicp:host/rng@1.0.0")?;
        Ok(())
    }
    fn host_should_cancel(
        store: StoreContextMut<'_, Ctx>,
        (job,): (String,),
    ) -> anyhow::Result<(bool,)> {
        let ctx = store.data();
        if job != ctx.job_id {
            log_job_mismatch(ctx, "should-cancel", &job);
            return Ok((true,));
        }
        Ok((ctx.cancelled.load(Ordering::Relaxed),))
    }

    fn host_deadline_ms(
        store: StoreContextMut<'_, Ctx>,
        (job,): (String,),
    ) -> anyhow::Result<(u32,)> {
        let ctx = store.data();
        if job != ctx.job_id {
            log_job_mismatch(ctx, "deadline-ms", &job);
        }
        Ok((ctx.deadline_ms,))
    }

    fn host_remaining_ms(
        store: StoreContextMut<'_, Ctx>,
        (job,): (String,),
    ) -> anyhow::Result<(u32,)> {
        let ctx = store.data();
        if job != ctx.job_id {
            log_job_mismatch(ctx, "remaining-ms", &job);
        }
        let elapsed = ctx.started.elapsed().as_millis() as u64;
        let deadline = ctx.deadline_ms as u64;
        let remaining = deadline.saturating_sub(elapsed);
        Ok((remaining.min(u32::MAX as u64) as u32,))
    }

    fn host_open_partial_sink(
        mut store: StoreContextMut<'_, Ctx>,
        (job,): (String,),
    ) -> anyhow::Result<(Resource<DynOutputStream>,)> {
        if job != store.data().job_id {
            let ctx = store.data();
            log_job_mismatch(ctx, "open-partial-sink", &job);
            return Err(anyhow::anyhow!("partial sink job id mismatch"));
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
                partial_rate: ctx.partial_rate.clone(),
                partial_throttle_waits: ctx.partial_throttle_waits.clone(),
            })
        };
        let stream: DynOutputStream = Box::new(PartialOutputStream::new(shared));
        let handle = store.data_mut().table.push(stream)?;
        Ok((handle,))
    }

    fn host_rng_next_u64(
        mut store: StoreContextMut<'_, Ctx>,
        (job,): (String,),
    ) -> anyhow::Result<(u64,)> {
        if job != store.data().job_id {
            let ctx = store.data();
            log_job_mismatch(ctx, "rng.next-u64", &job);
        }
        let ctx = store.data_mut();
        let block = derive_rng_block(&ctx.rng_seed, ctx.rng_counter);
        ctx.rng_counter = ctx.rng_counter.saturating_add(1);
        Ok((u64::from_le_bytes(block[0..8].try_into().unwrap()),))
    }

    fn host_rng_fill(
        mut store: StoreContextMut<'_, Ctx>,
        (job, len): (String, u32),
    ) -> anyhow::Result<(Vec<u8>,)> {
        if job != store.data().job_id {
            let ctx = store.data();
            log_job_mismatch(ctx, "rng.fill", &job);
        }
        let ctx = store.data_mut();
        let mut out = Vec::with_capacity(len as usize);
        while out.len() < len as usize {
            let block = derive_rng_block(&ctx.rng_seed, ctx.rng_counter);
            ctx.rng_counter = ctx.rng_counter.saturating_add(1);
            let remaining = len as usize - out.len();
            out.extend_from_slice(&block[..remaining.min(block.len())]);
        }
        Ok((out,))
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

    async fn finalize_error<R: Runtime>(
        app: &AppHandle<R>,
        spec: &ComputeJobSpec,
        code: &str,
        message: &str,
        started: Instant,
        queue_wait_ms: u64,
        metrics_opt: Option<serde_json::Value>,
    ) {
        let ms = started.elapsed().as_millis() as i64;
        let metrics = if let Some(mut m) = metrics_opt {
            if let Some(map) = m.as_object_mut() {
                map.entry("queueMs".to_string())
                    .or_insert_with(|| serde_json::json!(queue_wait_ms));
            }
            Some(m)
        } else {
            Some(serde_json::json!({ "durationMs": ms, "queueMs": queue_wait_ms }))
        };
        let payload = crate::ComputeFinalErr {
            ok: false,
            job_id: spec.job_id.clone(),
            task: spec.task.clone(),
            code: code.into(),
            message: message.into(),
            metrics: metrics.clone(),
        };
        #[cfg(feature = "otel_spans")]
        tracing::error!(target = "uicp", job_id = %spec.job_id, task = %spec.task, code = %code, duration_ms = ms, "compute job failed");
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
        crate::emit_or_log(&app, "compute.result.final", payload.clone());
        if spec.replayable && spec.cache == "readwrite" {
            let key = crate::compute_cache::compute_key(
                &spec.task,
                &spec.input,
                &spec.provenance.env_hash,
            );
            let obj = serde_json::to_value(&payload).unwrap_or(serde_json::json!({}));
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

    async fn finalize_ok_with_metrics<R: Runtime>(
        app: &AppHandle<R>,
        spec: &ComputeJobSpec,
        output: serde_json::Value,
        mut metrics: serde_json::Value,
        queue_wait_ms: u64,
    ) {
        // Compute a deterministic hash of the final output for determinism goldens.
        let canonical = crate::compute_cache::canonicalize_input(&output);
        let mut hasher = sha2::Sha256::new();
        use sha2::Digest;
        hasher.update(canonical.as_bytes());
        let out_hash = hex::encode(hasher.finalize());
        if let Some(map) = metrics.as_object_mut() {
            map.insert("outputHash".into(), serde_json::json!(out_hash));
            map.entry("queueMs".to_string())
                .or_insert_with(|| serde_json::json!(queue_wait_ms));
        } else {
            metrics = serde_json::json!({
                "outputHash": out_hash,
                "queueMs": queue_wait_ms
            });
        }
        let payload = crate::ComputeFinalOk {
            ok: true,
            job_id: spec.job_id.clone(),
            task: spec.task.clone(),
            output: output.clone(),
            metrics: Some(metrics.clone()),
        };
        #[cfg(feature = "otel_spans")]
        tracing::info!(target = "uicp", job_id = %spec.job_id, task = %spec.task, "compute job completed with metrics");
        crate::emit_or_log(&app, "compute.result.final", payload);
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

    fn collect_metrics(store: &wasmtime::Store<Ctx>) -> serde_json::Value {
        let duration_ms = store.data().started.elapsed().as_millis() as i64;
        let remaining = (store.data().deadline_ms as i64 - duration_ms).max(0) as i64;
        let mut metrics = serde_json::json!({
            "durationMs": duration_ms,
            "deadlineMs": store.data().deadline_ms,
            "logCount": store.data().log_count.load(Ordering::Relaxed),
            "partialFrames": store.data().partial_frames.load(Ordering::Relaxed),
            "invalidPartialsDropped": store.data().invalid_partial_frames.load(Ordering::Relaxed),
            "remainingMsAtFinish": remaining,
            "rngSeedHex": hex::encode(store.data().rng_seed),
            "rngCounter": store.data().rng_counter,
            "logThrottleWaits": store.data().log_throttle_waits.load(Ordering::Relaxed),
            "partialThrottleWaits": store.data().partial_throttle_waits.load(Ordering::Relaxed),
            "loggerThrottleWaits": store.data().logger_throttle_waits.load(Ordering::Relaxed),
        });
        let (stdout_burst, stdout_rate, logger_burst, logger_rate, partial_burst, partial_rate) = {
            let ctx = store.data();
            let (stdout_burst, stdout_rate) = {
                let rl = ctx.log_rate.lock().unwrap();
                (rl.capacity(), rl.rate_per_sec())
            };
            let (logger_burst, logger_rate) = {
                let rl = ctx.logger_rate.lock().unwrap();
                (rl.capacity(), rl.rate_per_sec())
            };
            let (partial_burst, partial_rate) = {
                let rl = ctx.partial_rate.lock().unwrap();
                (rl.capacity(), rl.rate_per_sec())
            };
            (
                stdout_burst,
                stdout_rate,
                logger_burst,
                logger_rate,
                partial_burst,
                partial_rate,
            )
        };
        if let Some(obj) = metrics.as_object_mut() {
            obj.insert(
                "stdoutRateBytesPerSec".into(),
                serde_json::json!(stdout_rate),
            );
            obj.insert("stdoutBurstBytes".into(), serde_json::json!(stdout_burst));
            obj.insert(
                "loggerRateBytesPerSec".into(),
                serde_json::json!(logger_rate),
            );
            obj.insert("loggerBurstBytes".into(), serde_json::json!(logger_burst));
            obj.insert(
                "partialRateEventsPerSec".into(),
                serde_json::json!(partial_rate),
            );
            obj.insert(
                "partialBurstEvents".into(),
                serde_json::json!(partial_burst),
            );
        }
        // Peak memory in MiB (if any growth occurred)
        let mem_peak = store.data().limits.mem_peak_mb();
        if mem_peak > 0 {
            if let Some(obj) = metrics.as_object_mut() {
                obj.insert("memPeakMb".into(), serde_json::json!(mem_peak));
            }
        }
        // Optional fuel metrics if enabled
        if store.data().initial_fuel > 0 {
            if let Ok(remaining) = store.get_fuel() {
                let used = store.data().initial_fuel.saturating_sub(remaining);
                if let Some(obj) = metrics.as_object_mut() {
                    obj.insert("fuelUsed".into(), serde_json::json!(used));
                }
            }
        }
        metrics
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::compute_input::{fs_read_allowed, sanitize_ws_files_path};

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
        fn trap_mapping_classifies_missing_imports_as_task_not_found() {
            // WHY: Prove we classify import/linkage failures distinctly so callers can react.
            let (code, _msg) = map_trap_error(&anyhow::anyhow!(
                "component instantiate failed: missing import 'wasi:logging/logging'"
            ));
            assert_eq!(code, error_codes::TASK_NOT_FOUND);
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
            assert_eq!(err.code, error_codes::CAPABILITY_DENIED);

            let invalid =
                resolve_csv_source(&spec_ok, "ws:/files/../secret.csv").expect_err("invalid path");
            assert_eq!(invalid.code, "IO.Denied");

            let _ = std::fs::remove_file(&file_path);
            let _ = std::fs::remove_dir_all(&base);
        }

        #[test]
        fn rate_limiter_bytes_refills_over_time() {
            let mut rl = RateLimiterBytes::new(1024, 256); // 1 KiB burst, 256 B/s
            assert!(rl.available() >= 1024);
            rl.consume(800);
            let after_consume = rl.available();
            assert!(
                after_consume <= 224,
                "expected ~224 tokens left, got {}",
                after_consume
            );
            std::thread::sleep(std::time::Duration::from_millis(250));
            rl.consume(0); // trigger refill calculation
            assert!(
                rl.available() > after_consume,
                "tokens should have refilled"
            );
        }

        #[test]
        fn rate_limiter_events_refills_over_time() {
            let mut rl = RateLimiterEvents::new(10, 10); // 10 events/s
                                                         // Consume 10 events
            let mut taken = 0;
            while rl.try_take_event() {
                taken += 1;
            }
            assert_eq!(taken, 10);
            // No tokens immediately
            assert!(rl.peek_tokens() < 1.0);
            std::thread::sleep(std::time::Duration::from_millis(120));
            assert!(
                rl.peek_tokens() >= 1.0,
                "should have at least one token after 120ms"
            );
        }

        // WASI deny-by-default proofs
        #[cfg(all(feature = "wasm_compute", not(feature = "uicp_wasi_enable")))]
        #[test]
        fn wasi_add_returns_error_when_disabled() {
            let engine = build_engine().expect("engine");
            let mut linker: Linker<Ctx> = Linker::new(&engine);
            let err = add_wasi_and_host(&mut linker).expect_err("expected wasi disabled error");
            let msg = err.to_string().to_lowercase();
            assert!(
                msg.contains("wasi") && msg.contains("disabled"),
                "unexpected error: {msg}"
            );
        }

        #[cfg(all(feature = "wasm_compute", feature = "uicp_wasi_enable"))]
        #[test]
        fn wasi_add_succeeds_when_enabled() {
            let engine = build_engine().expect("engine");
            let mut linker: Linker<Ctx> = Linker::new(&engine);
            add_wasi_and_host(&mut linker).expect("wasi add ok");
        }

        #[cfg(all(feature = "wasm_compute", feature = "uicp_wasi_enable"))]
        #[test]
        fn wasi_import_surface_excludes_http_and_sockets() {
            let engine = build_engine().expect("engine");
            let mut linker: Linker<Ctx> = Linker::new(&engine);
            add_wasi_and_host(&mut linker).expect("wasi add ok");
            // Positive: logging already linked; creating a new instance should fail
            assert!(
                linker.instance("wasi:logging/logging").is_err(),
                "wasi:logging/logging should already be linked"
            );

            // Negative checks: ensure HTTP and sockets namespaces are not pre-linked.
            // Creating a placeholder function should succeed if the namespace was not pre-linked.
            {
                let mut http = linker
                    .instance("wasi:http/outgoing-handler")
                    .expect("http namespace builder");
                let ok = http.func_wrap(
                    "__placeholder",
                    |_store: StoreContextMut<'_, Ctx>, _args: ()| -> anyhow::Result<()> { Ok(()) },
                );
                assert!(ok.is_ok(), "http namespace should not be pre-linked");
            }
            {
                let mut http_types = linker
                    .instance("wasi:http/types")
                    .expect("http types namespace builder");
                let ok = http_types.func_wrap(
                    "__placeholder",
                    |_store: StoreContextMut<'_, Ctx>, _args: ()| -> anyhow::Result<()> { Ok(()) },
                );
                assert!(ok.is_ok(), "http types namespace should not be pre-linked");
            }
            {
                let mut tcp = linker
                    .instance("wasi:sockets/tcp")
                    .expect("sockets tcp namespace builder");
                let ok = tcp.func_wrap(
                    "__placeholder",
                    |_store: StoreContextMut<'_, Ctx>, _args: ()| -> anyhow::Result<()> { Ok(()) },
                );
                assert!(ok.is_ok(), "sockets tcp namespace should not be pre-linked");
            }
            {
                let mut udp = linker
                    .instance("wasi:sockets/udp")
                    .expect("sockets udp namespace builder");
                let ok = udp.func_wrap(
                    "__placeholder",
                    |_store: StoreContextMut<'_, Ctx>, _args: ()| -> anyhow::Result<()> { Ok(()) },
                );
                assert!(ok.is_ok(), "sockets udp namespace should not be pre-linked");
            }
        }

        #[cfg(feature = "uicp_wasi_enable")]
        #[test]
        fn wasi_logging_bridge_emits_partial_event() {
            use std::sync::{Arc, Mutex};

            
            struct TestEmitter {
                partials: Arc<Mutex<Vec<serde_json::Value>>>,
                debugs: Arc<Mutex<Vec<serde_json::Value>>>,
            }
            impl Default for TestEmitter {
                fn default() -> Self {
                    Self {
                        partials: Arc::new(Mutex::new(Vec::new())),
                        debugs: Arc::new(Mutex::new(Vec::new())),
                    }
                }
            }
            impl TelemetryEmitter for TestEmitter {
                fn emit_debug(&self, payload: serde_json::Value) {
                    self.debugs.lock().unwrap().push(payload);
                }
                fn emit_partial(&self, _event: crate::ComputePartialEvent) {}
                fn emit_partial_json(&self, payload: serde_json::Value) {
                    self.partials.lock().unwrap().push(payload);
                }
            }

            let captured_partials: Arc<Mutex<Vec<serde_json::Value>>> =
                Arc::new(Mutex::new(Vec::new()));
            let telemetry: Arc<dyn TelemetryEmitter> = Arc::new(TestEmitter {
                partials: captured_partials.clone(),
                debugs: Arc::new(Mutex::new(Vec::new())),
            });
            let limits = LimitsWithPeak::new(64 * 1024 * 1024);
            let mut store: Store<Ctx> = Store::new(
                &build_engine().unwrap(),
                Ctx {
                    wasi: WasiCtxBuilder::new().build(),
                    table: ResourceTable::new(),
                    emitter: telemetry.clone(),
                    job_id: "test-job".into(),
                    task: "csv.parse@1.2.0".into(),
                    partial_seq: Arc::new(AtomicU64::new(0)),
                    partial_frames: Arc::new(AtomicU64::new(0)),
                    invalid_partial_frames: Arc::new(AtomicU64::new(0)),
                    cancelled: Arc::new(AtomicBool::new(false)),
                    rng_seed: [0u8; 32],
                    logical_tick: Arc::new(AtomicU64::new(0)),
                    started: Instant::now(),
                    deadline_ms: 1000,
                    rng_counter: 0,
                    log_count: Arc::new(AtomicU64::new(0)),
                    emitted_log_bytes: Arc::new(AtomicU64::new(0)),
                    max_log_bytes: 8 * 1024,
                    initial_fuel: 0,
                    log_rate: Arc::new(Mutex::new(RateLimiterBytes::new(1024, 1024))),
                    log_throttle_waits: Arc::new(AtomicU64::new(0)),
                    logger_rate: Arc::new(Mutex::new(RateLimiterBytes::new(1024, 1024))),
                    logger_throttle_waits: Arc::new(AtomicU64::new(0)),
                    partial_rate: Arc::new(Mutex::new(RateLimiterEvents::new(10, 10))),
                    partial_throttle_waits: Arc::new(AtomicU64::new(0)),
                    limits,
                },
            );

            // Call the logging bridge directly
            {
                use wasmtime::AsContextMut;
                let mut ctx = store.as_context_mut();
                ctx.data_mut().log_p2(2, "ctx".into(), "hello world".into());
            }

            // Verify a partial event was captured with expected fields
            let part = captured_partials
                .lock()
                .unwrap()
                .pop()
                .expect("one partial emitted");
            assert_eq!(part.get("kind").and_then(|v| v.as_str()), Some("log"));
            assert_eq!(
                part.get("stream").and_then(|v| v.as_str()),
                Some("wasi-logging")
            );
            assert_eq!(part.get("level").and_then(|v| v.as_str()), Some("info"));
        }

        #[cfg(feature = "uicp_wasi_enable")]
        #[test]
        fn wasi_logging_guest_component_emits_partial_event() {
            use std::path::PathBuf;
            use std::process::Command as PCommand;
            use std::sync::{Arc, Mutex};
            use tokio::runtime::Runtime;

            // Build the tiny log test component
            let comp_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("components")
                .join("log.test");
            let manifest = comp_dir.join("Cargo.toml");
            let status = PCommand::new("cargo")
                .args(["component", "build", "--release", "--manifest-path"])
                .arg(&manifest)
                .status()
                .expect("spawn cargo component");
            assert!(status.success(), "cargo component build failed");
            let artifact = "uicp_task_log_test.wasm";
            let wasm = ["wasm32-wasip1", "wasm32-wasi", "wasm32-wasi-preview1"]
                .into_iter()
                .map(|triple| comp_dir.join("target").join(triple).join("release").join(artifact))
                .find(|candidate| candidate.exists())
                .unwrap_or_else(|| {
                    panic!(
                        "component artifact missing: expected {:?} under target/{{wasm32-wasip1, wasm32-wasi}}/release",
                        artifact
                    )
                });

            // Capture partials emitted by the host logging bridge
            
            struct TestEmitter {
                partials: Arc<Mutex<Vec<serde_json::Value>>>,
            }
            impl Default for TestEmitter {
                fn default() -> Self {
                    Self {
                        partials: Arc::new(Mutex::new(Vec::new())),
                    }
                }
            }
            impl TelemetryEmitter for TestEmitter {
                fn emit_debug(&self, _payload: serde_json::Value) {}
                fn emit_partial(&self, _event: crate::ComputePartialEvent) {}
                fn emit_partial_json(&self, payload: serde_json::Value) {
                    self.partials.lock().unwrap().push(payload);
                }
            }

            let engine = build_engine().expect("engine");
            let mut linker: Linker<Ctx> = Linker::new(&engine);
            add_wasi_and_host(&mut linker).expect("wasi+host add ok");
            let component = Component::from_file(&engine, &wasm).expect("component");

            // Minimal job context
            let tele = Arc::new(TestEmitter::default());
            let tele_trait: Arc<dyn TelemetryEmitter> = tele.clone();
            let limits = LimitsWithPeak::new(64 * 1024 * 1024);
            let rt = Runtime::new().expect("tokio runtime");
            let tele_exec = tele_trait.clone();
            let linker = linker;
            rt.block_on(async {
                let mut store: Store<Ctx> = Store::new(
                    &engine,
                    Ctx {
                        wasi: WasiCtxBuilder::new().build(),
                        table: ResourceTable::new(),
                        emitter: tele_exec,
                        job_id: "log-guest".into(),
                        task: "uicp:task-log-test".into(),
                        partial_seq: Arc::new(AtomicU64::new(0)),
                        partial_frames: Arc::new(AtomicU64::new(0)),
                        invalid_partial_frames: Arc::new(AtomicU64::new(0)),
                        cancelled: Arc::new(AtomicBool::new(false)),
                        rng_seed: [0u8; 32],
                        logical_tick: Arc::new(AtomicU64::new(0)),
                        started: Instant::now(),
                        deadline_ms: 1000,
                        rng_counter: 0,
                        log_count: Arc::new(AtomicU64::new(0)),
                        emitted_log_bytes: Arc::new(AtomicU64::new(0)),
                        max_log_bytes: 8 * 1024,
                        initial_fuel: 0,
                        log_rate: Arc::new(Mutex::new(RateLimiterBytes::new(1024, 1024))),
                        log_throttle_waits: Arc::new(AtomicU64::new(0)),
                        logger_rate: Arc::new(Mutex::new(RateLimiterBytes::new(1024, 1024))),
                        logger_throttle_waits: Arc::new(AtomicU64::new(0)),
                        partial_rate: Arc::new(Mutex::new(RateLimiterEvents::new(10, 10))),
                        partial_throttle_waits: Arc::new(AtomicU64::new(0)),
                        limits,
                    },
                );

                let instance = linker
                    .instantiate_async(&mut store, &component)
                    .await
                    .expect("instantiate");
                let func: wasmtime::component::TypedFunc<(String,), ()> = instance
                    .get_typed_func(&mut store, "task#run")
                    .expect("get run");
                func.call_async(&mut store, ("log-guest".to_string(),))
                    .await
                    .expect("call run");
            });

            let captured = tele.partials.lock().unwrap().clone();
            assert!(
                captured
                    .iter()
                    .any(|p| p.get("stream").and_then(|v| v.as_str()) == Some("wasi-logging")),
                "expected at least one wasi-logging partial"
            );
        }

        #[cfg(feature = "uicp_wasi_enable")]
        #[test]
        fn guest_stdio_frames_land_in_action_log() {
            use tempfile::tempdir;
            #[derive(Clone, Default)]
            struct NullEmitter;
            impl TelemetryEmitter for NullEmitter {
                fn emit_debug(&self, _payload: serde_json::Value) {}
                fn emit_partial(&self, _event: crate::ComputePartialEvent) {}
                fn emit_partial_json(&self, _payload: serde_json::Value) {}
            }

            let dir = tempdir().expect("tempdir");
            let db_path = dir.path().join("action.db");
            let action_log = crate::action_log::ActionLogService::start_with_seed(&db_path, None)
                .expect("action log");

            let shared = Arc::new(GuestLogShared {
                emitter: Arc::new(NullEmitter::default()),
                job_id: "job-stdout-log".into(),
                task: "task.stdout.log".into(),
                seq: Arc::new(AtomicU64::new(0)),
                tick: Arc::new(AtomicU64::new(0)),
                log_count: Arc::new(AtomicU64::new(0)),
                emitted_bytes: Arc::new(AtomicU64::new(0)),
                max_bytes: 8 * 1024,
                max_len: 512,
                buf: Mutex::new(Vec::new()),
                log_rate: Arc::new(Mutex::new(RateLimiterBytes::new(1024, 1024))),
                log_throttle_waits: Arc::new(AtomicU64::new(0)),
                action_log,
            });
            let stream = GuestLogStream {
                shared: shared.clone(),
                channel: "stdout",
            };
            stream.emit_message(b"hello action log\n");

            let conn = rusqlite::Connection::open(&db_path).expect("open sqlite");
            let record_count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM action_log WHERE kind = 'compute.log'",
                    [],
                    |r| r.get(0),
                )
                .expect("count action log rows");
            assert_eq!(record_count, 1);
        }

        #[cfg(feature = "uicp_wasi_enable")]
        #[test]
        fn rng_next_and_fill_increment_counter() {
            use wasmtime::AsContextMut;
            #[derive(Clone, Default)]
            struct NullEmitter;
            impl TelemetryEmitter for NullEmitter {
                fn emit_debug(&self, _payload: serde_json::Value) {}
                fn emit_partial(&self, _event: crate::ComputePartialEvent) {}
                fn emit_partial_json(&self, _payload: serde_json::Value) {}
            }
            let engine = build_engine().expect("engine");
            let mut store: Store<Ctx> = Store::new(
                &engine,
                Ctx {
                    wasi: WasiCtxBuilder::new().build(),
                    table: ResourceTable::new(),
                    emitter: Arc::new(NullEmitter::default()),
                    job_id: "rng-job".into(),
                    task: "rng.task".into(),
                    partial_seq: Arc::new(AtomicU64::new(0)),
                    partial_frames: Arc::new(AtomicU64::new(0)),
                    invalid_partial_frames: Arc::new(AtomicU64::new(0)),
                    cancelled: Arc::new(AtomicBool::new(false)),
                    rng_seed: [1u8; 32],
                    logical_tick: Arc::new(AtomicU64::new(0)),
                    started: Instant::now(),
                    deadline_ms: 1000,
                    rng_counter: 0,
                    log_count: Arc::new(AtomicU64::new(0)),
                    emitted_log_bytes: Arc::new(AtomicU64::new(0)),
                    max_log_bytes: 8 * 1024,
                    initial_fuel: 0,
                    log_rate: Arc::new(Mutex::new(RateLimiterBytes::new(1024, 1024))),
                    log_throttle_waits: Arc::new(AtomicU64::new(0)),
                    logger_rate: Arc::new(Mutex::new(RateLimiterBytes::new(1024, 1024))),
                    logger_throttle_waits: Arc::new(AtomicU64::new(0)),
                    partial_rate: Arc::new(Mutex::new(RateLimiterEvents::new(10, 10))),
                    partial_throttle_waits: Arc::new(AtomicU64::new(0)),
                    limits: LimitsWithPeak::new(64 * 1024 * 1024),
                },
            );

            // First next_u64 advances counter by 1
            let (a,) = host_rng_next_u64(store.as_context_mut(), ("rng-job".into(),)).unwrap();
            assert_ne!(a, 0);
            assert_eq!(store.data().rng_counter, 1);

            // Fill 16 bytes should advance counter at least once more
            let (bytes,) =
                host_rng_fill(store.as_context_mut(), ("rng-job".into(), 16u32)).unwrap();
            assert_eq!(bytes.len(), 16);
            assert!(store.data().rng_counter >= 2);

            // Subsequent next_u64 should differ
            let (b,) = host_rng_next_u64(store.as_context_mut(), ("rng-job".into(),)).unwrap();
            assert_ne!(a, b);
        }

        #[cfg(feature = "uicp_wasi_enable")]
        #[test]
        fn deadline_remaining_monotonic_nonnegative() {
            use wasmtime::AsContextMut;
            #[derive(Clone, Default)]
            struct NullEmitter;
            impl TelemetryEmitter for NullEmitter {
                fn emit_debug(&self, _payload: serde_json::Value) {}
                fn emit_partial(&self, _event: crate::ComputePartialEvent) {}
                fn emit_partial_json(&self, _payload: serde_json::Value) {}
            }
            let engine = build_engine().expect("engine");
            let mut store: Store<Ctx> = Store::new(
                &engine,
                Ctx {
                    wasi: WasiCtxBuilder::new().build(),
                    table: ResourceTable::new(),
                    emitter: Arc::new(NullEmitter::default()),
                    job_id: "clock-job".into(),
                    task: "clock.task".into(),
                    partial_seq: Arc::new(AtomicU64::new(0)),
                    partial_frames: Arc::new(AtomicU64::new(0)),
                    invalid_partial_frames: Arc::new(AtomicU64::new(0)),
                    cancelled: Arc::new(AtomicBool::new(false)),
                    rng_seed: [0u8; 32],
                    logical_tick: Arc::new(AtomicU64::new(0)),
                    started: Instant::now(),
                    deadline_ms: 50,
                    rng_counter: 0,
                    log_count: Arc::new(AtomicU64::new(0)),
                    emitted_log_bytes: Arc::new(AtomicU64::new(0)),
                    max_log_bytes: 8 * 1024,
                    initial_fuel: 0,
                    log_rate: Arc::new(Mutex::new(RateLimiterBytes::new(1024, 1024))),
                    log_throttle_waits: Arc::new(AtomicU64::new(0)),
                    logger_rate: Arc::new(Mutex::new(RateLimiterBytes::new(1024, 1024))),
                    logger_throttle_waits: Arc::new(AtomicU64::new(0)),
                    partial_rate: Arc::new(Mutex::new(RateLimiterEvents::new(10, 10))),
                    partial_throttle_waits: Arc::new(AtomicU64::new(0)),
                    limits: LimitsWithPeak::new(64 * 1024 * 1024),
                },
            );
            let (r1,) = host_remaining_ms(store.as_context_mut(), ("clock-job".into(),)).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(10));
            let (r2,) = host_remaining_ms(store.as_context_mut(), ("clock-job".into(),)).unwrap();
            assert!(r2 <= r1);
            assert!(r2 <= 50);
        }

        #[cfg(feature = "uicp_wasi_enable")]
        #[test]
        fn collect_metrics_accumulates_counters_and_mempeak() {
            use wasmtime::ResourceLimiter;
            #[derive(Clone, Default)]
            struct TestEmitter {
                debugs: Arc<Mutex<Vec<serde_json::Value>>>,
            }
            impl TelemetryEmitter for TestEmitter {
                fn emit_debug(&self, payload: serde_json::Value) {
                    self.debugs.lock().unwrap().push(payload);
                }
                fn emit_partial(&self, _event: crate::ComputePartialEvent) {}
                fn emit_partial_json(&self, _payload: serde_json::Value) {}
            }

            let engine = build_engine().expect("engine");
            let tele: Arc<dyn TelemetryEmitter> = Arc::new(TestEmitter::default());
            let limits = LimitsWithPeak::new(64 * 1024 * 1024);
            let mut store: Store<Ctx> = Store::new(
                &engine,
                Ctx {
                    wasi: WasiCtxBuilder::new().build(),
                    table: ResourceTable::new(),
                    emitter: tele,
                    job_id: "metrics-job".into(),
                    task: "metrics.task".into(),
                    partial_seq: Arc::new(AtomicU64::new(0)),
                    partial_frames: Arc::new(AtomicU64::new(0)),
                    invalid_partial_frames: Arc::new(AtomicU64::new(0)),
                    cancelled: Arc::new(AtomicBool::new(false)),
                    rng_seed: [0u8; 32],
                    logical_tick: Arc::new(AtomicU64::new(0)),
                    started: Instant::now(),
                    deadline_ms: 1000,
                    rng_counter: 0,
                    log_count: Arc::new(AtomicU64::new(0)),
                    emitted_log_bytes: Arc::new(AtomicU64::new(0)),
                    max_log_bytes: 8 * 1024,
                    initial_fuel: 0,
                    log_rate: Arc::new(Mutex::new(RateLimiterBytes::new(1024, 1024))),
                    log_throttle_waits: Arc::new(AtomicU64::new(0)),
                    logger_rate: Arc::new(Mutex::new(RateLimiterBytes::new(1024, 1024))),
                    logger_throttle_waits: Arc::new(AtomicU64::new(0)),
                    partial_rate: Arc::new(Mutex::new(RateLimiterEvents::new(10, 10))),
                    partial_throttle_waits: Arc::new(AtomicU64::new(0)),
                    limits,
                },
            );

            // Increment log count twice
            {
                use wasmtime::AsContextMut;
                let mut ctx = store.as_context_mut();
                ctx.data_mut().log_p2(2, "ctx".into(), "line-1".into());
                ctx.data_mut().log_p2(2, "ctx".into(), "hello world".into());
            }

            // Simulate memory growth to 5 MiB
            {
                let ctx = store.data_mut();
                ctx.limits
                    .memory_growing(0, 5 * 1024 * 1024, Some(64 * 1024 * 1024))
                    .expect("memory growth simulated");
            }

            let m = collect_metrics(&store);
            assert_eq!(m.get("logCount").and_then(|v| v.as_i64()), Some(2));
            // memPeakMb should be at least 5
            let mem_peak = m.get("memPeakMb").and_then(|v| v.as_i64()).unwrap_or(0);
            assert!(mem_peak >= 5);
        }
    }
}

#[cfg(not(feature = "wasm_compute"))]
mod no_runtime {
    use super::*;
    use crate::ComputeFinalErr;
    pub(super) fn spawn_job<R: Runtime>(
        app: tauri::AppHandle<R>,
        spec: ComputeJobSpec,
        permit: Option<OwnedSemaphorePermit>,
        queue_wait_ms: u64,
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
                    let payload = ComputeFinalErr { ok: false, job_id: spec.job_id.clone(), task: spec.task.clone(), code: error_codes::CANCELLED.into(), message: "Job cancelled by user".into(), metrics: Some(serde_json::json!({"queueMs": queue_wait_ms})) };
                    crate::emit_or_log(&app, "compute.result.final", payload);
                }
                _ = tokio::time::sleep(Duration::from_millis(50)) => {
                    #[cfg(feature = "otel_spans")]
                    tracing::warn!(target = "uicp", job_id = %spec.job_id, task = %spec.task, "wasm_compute feature disabled; returning fault");
                    let payload = ComputeFinalErr {
                        ok: false,
                        job_id: spec.job_id.clone(),
                        task: spec.task.clone(),
                        code: error_codes::RUNTIME_FAULT.into(),
                        message: "Wasm compute runtime disabled in this build; recompile with feature wasm_compute".into(),
                        metrics: Some(serde_json::json!({ "queueMs": queue_wait_ms })),
                    };
                    let _ = app.emit("debug-log", serde_json::json!({
                        "event": "compute_disabled",
                        "jobId": spec.job_id,
                        "task": spec.task,
                    }));
                    crate::emit_or_log(&app, "compute.result.final", payload.clone());
                    if spec.replayable && spec.cache == "readwrite" {
                        let key = crate::compute_cache::compute_key(&spec.task, &spec.input, &spec.provenance.env_hash);
                        let mut obj = serde_json::to_value(&payload).unwrap_or(serde_json::json!({}));
                        if let Some(map) = obj.as_object_mut() {
                            map.insert(
                                "metrics".into(),
                                serde_json::json!({ "queueMs": queue_wait_ms }),
                            );
                        }
                        let _ = crate::compute_cache::store(&app, &spec.workspace_id, &key, &spec.task, &spec.provenance.env_hash, &obj).await;
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
pub fn spawn_job<R: Runtime>(
    app: tauri::AppHandle<R>,
    spec: ComputeJobSpec,
    permit: Option<OwnedSemaphorePermit>,
    queue_wait_ms: u64,
) -> JoinHandle<()> {
    #[cfg(feature = "wasm_compute")]
    {
        with_runtime::spawn_job(app, spec, permit, queue_wait_ms)
    }
    #[cfg(not(feature = "wasm_compute"))]
    {
        no_runtime::spawn_job(app, spec, permit, queue_wait_ms)
    }
}
