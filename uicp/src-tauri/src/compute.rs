//! UICP Wasm compute host (WASI Preview 2, Component Model).
//!
//! This module selects implementation based on the `wasm_compute` feature:
//! - when enabled, it embeds Wasmtime with typed hostcalls and module registry.
//! - when disabled, it emits deterministic placeholder events for adapter wiring.

use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64_ENGINE;
use base64::Engine;
use tauri::async_runtime::{spawn as tauri_spawn, JoinHandle};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::OwnedSemaphorePermit;

use crate::{ComputeFinalErr, ComputeJobSpec};
#[cfg(feature = "wasm_compute")]
use crate::registry;

#[cfg(feature = "wasm_compute")]
mod with_runtime {
    use super::*;
    use wasmtime::{component::{Linker, Component, TypedFunc}, Config, Engine, StoreLimits, StoreLimitsBuilder};
    use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiView, Table};
    use wasmtime_wasi::bindings;
    #[allow(unused_imports)]
    use wasmtime_wasi::bindings::wasi::io::streams::{HostOutputStream, StreamError};
    use std::sync::{Arc, atomic::{AtomicBool, Ordering}};

    fn extract_csv_input(input: &serde_json::Value) -> Result<(String, bool), String> {
        let obj = input.as_object().ok_or_else(|| "input must be an object".to_string())?;
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

    fn is_typed_only() -> bool {
        match std::env::var("UICP_COMPUTE_TYPED_ONLY") {
            // Explicit opt-out
            Ok(v) if matches!(v.as_str(), "0" | "false" | "FALSE" | "no" | "off") => false,
            // Default ON
            _ => true,
        }
    }

    fn extract_table_query_input(input: &serde_json::Value) -> Result<(Vec<Vec<String>>, Vec<u32>, Option<(u32, String)>), String> {
        let obj = input.as_object().ok_or_else(|| "input must be an object".to_string())?;
        // rows: list<list<string>>
        let rows_val = obj.get("rows").ok_or_else(|| "input.rows required".to_string())?;
        let rows = rows_val.as_array().ok_or_else(|| "input.rows must be an array".to_string())?
            .iter()
            .map(|row| {
                let arr = row.as_array().ok_or_else(|| "row must be an array".to_string())?;
                Ok(arr.iter().map(|cell| cell.as_str().unwrap_or("").to_string()).collect::<Vec<String>>())
            })
            .collect::<Result<Vec<Vec<String>>, String>>()?;

        // select: list<u32>
        let select_val = obj.get("select").ok_or_else(|| "input.select required".to_string())?;
        let select = select_val.as_array().ok_or_else(|| "input.select must be an array".to_string())?
            .iter()
            .map(|v| v.as_u64().ok_or_else(|| "select entries must be non-negative integers".to_string()).map(|u| u as u32))
            .collect::<Result<Vec<u32>, String>>()?;

        // where_contains: option<record { col: u32, needle: string }>
        let where_opt = if let Some(w) = obj.get("where_contains") {
            if w.is_null() { None } else {
                let wobj = w.as_object().ok_or_else(|| "where_contains must be an object".to_string())?;
                let col = wobj.get("col").and_then(|v| v.as_u64()).ok_or_else(|| "where_contains.col must be u32".to_string())? as u32;
                let needle = wobj.get("needle").and_then(|v| v.as_str()).ok_or_else(|| "where_contains.needle must be string".to_string())?.to_string();
                Some((col, needle))
            }
        } else { None };

        Ok((rows, select, where_opt))
    }

    fn validate_rows_value(val: &serde_json::Value) -> bool {
        let arr = match val.as_array() { Some(a) => a, None => return false };
        for row in arr.iter() {
            let r = match row.as_array() { Some(r) => r, None => return false };
            for cell in r.iter() {
                if !cell.is_string() { return false; }
            }
        }
        true
    }

    /// Execution context for a single job store.
    struct Ctx {
        wasi: WasiCtx,
        table: Table,
        app: AppHandle,
        job_id: String,
        task: String,
        partial_seq: u64,
        partial_frames: Arc<std::sync::atomic::AtomicU64>,
        invalid_partial_frames: Arc<std::sync::atomic::AtomicU64>,
        cancelled: Arc<AtomicBool>,
        // Determinism scaffolding (seeded RNG and logical clock placeholders)
        rng_seed: [u8; 32],
        logical_tick: u64,
        // Host policy and telemetry
        started: Instant,
        deadline_ms: u32,
        rng_counter: u64,
        log_count: u32,
    }

    impl WasiView for Ctx {
        fn table(&self) -> &Table { &self.table }
        fn table_mut(&mut self) -> &mut Table { &mut self.table }
        fn ctx(&self) -> &WasiCtx { &self.wasi }
        fn ctx_mut(&mut self) -> &mut WasiCtx { &mut self.wasi }
    }

    /// Build a Wasmtime engine configured for the Component Model and limits.
    fn build_engine() -> anyhow::Result<Engine> {
        let mut cfg = Config::new();
        cfg.wasm_component_model(true)
            .consume_fuel(true)
            .epoch_interruption(true)
            .wasm_memory64(false);
        Ok(Engine::new(&cfg)?)
    }

    /// Spawn a compute job using Wasmtime with epoch timeout and memory limits configured.
    pub(super) fn spawn_job(app: AppHandle, spec: ComputeJobSpec, permit: Option<OwnedSemaphorePermit>) -> JoinHandle<()> {
        tauri_spawn(async move {
            let _permit = permit;

            let engine = match build_engine() {
                Ok(engine) => engine,
                Err(err) => {
                    let payload = ComputeFinalErr {
                        ok: false,
                        job_id: spec.job_id.clone(),
                        task: spec.task.clone(),
                        code: "Runtime.Fault".into(),
                        message: format!("Failed to init Wasm engine: {err}"),
                    };
                    let _ = app.emit("compute.result.final", payload);
                    crate::remove_compute_job(&app, &spec.job_id).await;
                    return;
                }
            };

            let wasi = WasiCtxBuilder::new().build();
            let table = Table::new();
            let mut seed_bytes = [0u8; 32];
            {
                use sha2::{Digest, Sha256};
                let mut hasher = Sha256::new();
                hasher.update(spec.job_id.as_bytes());
                hasher.update(b"|");
                hasher.update(spec.provenance.env_hash.as_bytes());
                let out = hasher.finalize();
                seed_bytes.copy_from_slice(&out[..32]);
            }

            let timeout_ms = spec.timeout_ms.unwrap_or(30_000);
            let cancel_flag = Arc::new(AtomicBool::new(false));

            let mut store = wasmtime::Store::new(&engine, Ctx {
                wasi,
                table,
                app: app.clone(),
                job_id: spec.job_id.clone(),
                task: spec.task.clone(),
                partial_seq: 0,
                partial_frames: Arc::new(std::sync::atomic::AtomicU64::new(0)),
                invalid_partial_frames: Arc::new(std::sync::atomic::AtomicU64::new(0)),
                cancelled: cancel_flag.clone(),
                rng_seed: seed_bytes,
                logical_tick: 0,
                started: Instant::now(),
                deadline_ms: (timeout_ms as u32).min(120_000),
                rng_counter: 0,
                log_count: 0,
            });
            if let Some(fuel) = spec.fuel {
                let _ = store.add_fuel(fuel);
            }

            let mem_mb = spec.mem_limit_mb.unwrap_or(256);
            let mem_bytes: u64 = (mem_mb as u64) * 1024 * 1024;
            let mut limits = StoreLimitsBuilder::new()
                .memory_size(mem_bytes)
                .instances(64)
                .tables(64)
                .build();
            store.limiter(|_ctx| &mut limits);

            if timeout_ms > 0 {
                store.set_epoch_deadline(1);
                let engine_for_timer = engine.clone();
                let job_for_timer = spec.job_id.clone();
                let app_for_timer = app.clone();
                tauri_spawn(async move {
                    tokio::time::sleep(Duration::from_millis(timeout_ms)).await;
                    engine_for_timer.increment_epoch();
                    let payload = serde_json::json!({
                        "jobId": job_for_timer,
                        "event": "epoch_timeout_fired",
                        "timeoutMs": timeout_ms
                    });
                    let _ = app_for_timer.emit("compute.debug", payload);
                });
            }

            let mut linker = Linker::<Ctx>::new(&engine);
            if let Err(err) = add_wasi_and_host(&mut linker) {
                let (code, msg) = map_trap_error(&err);
                let payload = ComputeFinalErr {
                    ok: false,
                    job_id: spec.job_id.clone(),
                    task: spec.task.clone(),
                    code: code.into(),
                    message: if msg.is_empty() { format!("Failed to link WASI/host: {err}") } else { msg },
                };
                let _ = app.emit("compute.result.final", payload.clone());
                if spec.replayable && spec.cache == "readwrite" {
                    let key = crate::compute_cache::compute_key(&spec.task, &spec.input, &spec.provenance.env_hash);
                    let _ = crate::compute_cache::store(&app, "default", &key, &spec.task, &spec.provenance.env_hash, &serde_json::to_value(&payload).unwrap()).await;
                }
                crate::remove_compute_job(&app, &spec.job_id).await;
                return;
            }

            let (tx_cancel, mut rx_cancel) = tokio::sync::watch::channel(false);
            {
                let state: tauri::State<'_, crate::AppState> = app.state();
                state.compute_cancel.write().await.insert(spec.job_id.clone(), tx_cancel);
            }
            let cancel_flag_for_task = cancel_flag.clone();
            tauri_spawn(async move {
                let _ = rx_cancel.changed().await;
                cancel_flag_for_task.store(true, Ordering::Relaxed);
            });

            let module_ref = match registry::find_module(&app, &spec.task) {
                Ok(Some(m)) => m,
                _ => {
                    finalize_error(&app, &spec, "Task.NotFound", "Module not registered", Instant::now()).await;
                    let state: tauri::State<'_, crate::AppState> = app.state();
                    state.compute_cancel.write().await.remove(&spec.job_id);
                    crate::remove_compute_job(&app, &spec.job_id).await;
                    return;
                }
            };

            let digest_ok = registry::verify_digest(&module_ref.path, &module_ref.entry.digest_sha256).unwrap_or(false);
            if !digest_ok {
                finalize_error(&app, &spec, "Task.NotFound", "Module digest mismatch", Instant::now()).await;
                let state: tauri::State<'_, crate::AppState> = app.state();
                state.compute_cancel.write().await.remove(&spec.job_id);
                crate::remove_compute_job(&app, &spec.job_id).await;
                return;
            }

            let component = match Component::from_file(&engine, &module_ref.path) {
                Ok(comp) => comp,
                Err(err) => {
                    let (code, msg) = map_trap_error(&err);
                    let message = if msg.is_empty() { format!("Failed to load component: {err}") } else { msg };
                    finalize_error(&app, &spec, code, &message, Instant::now()).await;
                    cleanup_job(&app, &spec.job_id).await;
                    return;
                }
            };

            let mut instance = match linker.instantiate(&mut store, &component) {
                Ok(instance) => instance,
                Err(err) => {
                    let (code, msg) = map_trap_error(&err);
                    let message = if msg.is_empty() { format!("Failed to instantiate: {err}") } else { msg };
                    finalize_error(&app, &spec, code, &message, Instant::now()).await;
                    cleanup_job(&app, &spec.job_id).await;
                    return;
                }
            };

            if spec.task.starts_with("csv.parse@") {
                let (source, has_header) = match extract_csv_input(&spec.input) {
                    Ok(val) => val,
                    Err(e) => {
                        finalize_error(&app, &spec, "Input.Invalid", &e, Instant::now()).await;
                        cleanup_job(&app, &spec.job_id).await;
                        return;
                    }
                };
                match instance.get_typed_func::<(String, (String, bool)), Result<Vec<Vec<String>>, String>>(&mut store, "task#run") {
                    Err(err) => {
                        if is_typed_only() {
                            let message = format!("Typed export not found: {err}");
                            finalize_error(&app, &spec, "Task.NotFound", &message, Instant::now()).await;
                            cleanup_job(&app, &spec.job_id).await;
                            return;
                        }
                    }
                    Ok(run_typed) => {
                        match run_typed.call(&mut store, (spec.job_id.clone(), (source, has_header))) {
                            Err(err) => {
                                let (code, msg) = map_trap_error(&err);
                                let message = if msg.is_empty() { format!("Invocation failed: {err}") } else { msg };
                                finalize_error(&app, &spec, code, &message, Instant::now()).await;
                                cleanup_job(&app, &spec.job_id).await;
                                return;
                            }
                            Ok(result) => match result {
                                Ok(rows) => {
                                    let metrics = collect_metrics(&mut store);
                                    finalize_ok_with_metrics(&app, &spec, serde_json::json!(rows), metrics).await;
                                    cleanup_job(&app, &spec.job_id).await;
                                    return;
                                }
                                Err(e_str) => {
                                    finalize_error(&app, &spec, "Runtime.Fault", &e_str, Instant::now()).await;
                                    cleanup_job(&app, &spec.job_id).await;
                                    return;
                                }
                            },
                        }
                    }
                }
            }

            if spec.task.starts_with("table.query@") {
                let (rows, select, where_contains) = match extract_table_query_input(&spec.input) {
                    Ok(val) => val,
                    Err(e) => {
                        finalize_error(&app, &spec, "Input.Invalid", &e, Instant::now()).await;
                        cleanup_job(&app, &spec.job_id).await;
                        return;
                    }
                };
                match instance.get_typed_func::<(String, (Vec<Vec<String>>, Vec<u32>, Option<(u32, String)>)), Result<Vec<Vec<String>>, String>>(&mut store, "task#run") {
                    Err(err) => {
                        if is_typed_only() {
                            let message = format!("Typed export not found: {err}");
                            finalize_error(&app, &spec, "Task.NotFound", &message, Instant::now()).await;
                            cleanup_job(&app, &spec.job_id).await;
                            return;
                        }
                    }
                    Ok(run_typed) => {
                        match run_typed.call(&mut store, (spec.job_id.clone(), (rows, select, where_contains))) {
                            Err(err) => {
                                let (code, msg) = map_trap_error(&err);
                                let message = if msg.is_empty() { format!("Invocation failed: {err}") } else { msg };
                                finalize_error(&app, &spec, code, &message, Instant::now()).await;
                                cleanup_job(&app, &spec.job_id).await;
                                return;
                            }
                            Ok(result) => match result {
                                Ok(rows) => {
                                    let metrics = collect_metrics(&mut store);
                                    finalize_ok_with_metrics(&app, &spec, serde_json::json!(rows), metrics).await;
                                    cleanup_job(&app, &spec.job_id).await;
                                    return;
                                }
                                Err(e_str) => {
                                    finalize_error(&app, &spec, "Runtime.Fault", &e_str, Instant::now()).await;
                                    cleanup_job(&app, &spec.job_id).await;
                                    return;
                                }
                            },
                        }
                    }
                }
            }

            if is_typed_only() {
                finalize_error(&app, &spec, "Task.NotFound", "Typed-only mode: generic run disabled", Instant::now()).await;
                cleanup_job(&app, &spec.job_id).await;
                return;
            }

            let run_generic = match instance.get_typed_func::<(String, String), Result<String, String>>(&mut store, "run") {
                Ok(func) => func,
                Err(err) => {
                    let message = format!("run() export not available or signature mismatch: {err}");
                    finalize_error(&app, &spec, "Task.NotFound", &message, Instant::now()).await;
                    cleanup_job(&app, &spec.job_id).await;
                    return;
                }
            };

            let input_json = match serde_json::to_string(&spec.input) {
                Ok(json) => json,
                Err(e) => {
                    finalize_error(&app, &spec, "Input.Invalid", &format!("Invalid input: {e}"), Instant::now()).await;
                    cleanup_job(&app, &spec.job_id).await;
                    return;
                }
            };

            match run_generic.call(&mut store, (spec.job_id.clone(), input_json)) {
                Err(err) => {
                    let (code, msg) = map_trap_error(&err);
                    let message = if msg.is_empty() { format!("Invocation failed: {err}") } else { msg };
                    finalize_error(&app, &spec, code, &message, Instant::now()).await;
                    cleanup_job(&app, &spec.job_id).await;
                    return;
                }
                Ok(result) => match result {
                    Ok(ok_json) => {
                        let mut metrics = collect_metrics(&mut store);
                        match serde_json::from_str::<serde_json::Value>(&ok_json) {
                            Ok(val) => {
                                if spec.task.starts_with("csv.parse@") || spec.task.starts_with("table.query@") {
                                    if !validate_rows_value(&val) {
                                        finalize_error(&app, &spec, "Input.Invalid", "Typed output validation failed", Instant::now()).await;
                                        cleanup_job(&app, &spec.job_id).await;
                                        return;
                                    }
                                }
                                finalize_ok_with_metrics(&app, &spec, val, metrics).await;
                                cleanup_job(&app, &spec.job_id).await;
                                return;
                            }
                            Err(e) => {
                                finalize_error(&app, &spec, "Input.Invalid", &format!("Output parse error: {e}"), Instant::now()).await;
                                cleanup_job(&app, &spec.job_id).await;
                                return;
                            }
                        }
                    }
                    Err(e_str) => {
                        finalize_error(&app, &spec, "Runtime.Fault", &e_str, Instant::now()).await;
                        cleanup_job(&app, &spec.job_id).await;
                        return;
                    }
                },
            }

        })
    }

    /// Wire core WASI Preview 2 imports and uicp:host control stubs.
    fn add_wasi_and_host(linker: &mut Linker<Ctx>) -> anyhow::Result<()> {
        // WASI Preview 2 imports: streams (+ filesystem wiring for future preopens)
        bindings::wasi::io::streams::add_to_linker(linker, |ctx| ctx)?;
        // Default policy is FS OFF; preopens (if any) are configured in the WasiCtx.
        // Linking here is safe without preopens; guest open attempts will fail.
        bindings::wasi::filesystem::types::add_to_linker(linker, |ctx| ctx)?;

        // uicp:host/logger.log(level, msg) with truncation and rate limit
        linker.func_wrap(
            "uicp:host/logger",
            "log",
            |mut caller: wasmtime::StoreContextMut<'_, Ctx>, level: u32, msg: &str| {
                const MAX_LEN: usize = 4096;
                const MAX_COUNT: u32 = 200;
                if caller.data().log_count >= MAX_COUNT { return; }
                let truncated = if msg.len() > MAX_LEN { &msg[..MAX_LEN] } else { msg };
                let lvl = match level { 0 => "trace", 1 => "debug", 2 => "info", 3 => "warn", 4 => "error", _ => "info" };
                let payload = serde_json::json!({
                    "jobId": caller.data().job_id,
                    "task": caller.data().task,
                    "level": lvl,
                    "msg": truncated,
                });
                let _ = caller.data().app.emit("compute.host.log", payload);
                caller.data_mut().log_count = caller.data().log_count.saturating_add(1);
            },
        )?;

        // uicp:host/control.should-cancel(job-id) -> bool
        linker.func_wrap(
            "uicp:host/control",
            "should-cancel",
            |caller: wasmtime::StoreContextMut<'_, Ctx>, _job: &str| -> bool {
                // Treat zero remaining as cancel signal; future: also check a shared cancel flag.
                if caller.data().cancelled.load(Ordering::Relaxed) {
                    return true;
                }
                let elapsed = caller.data().started.elapsed().as_millis() as u64;
                let rem = caller.data().deadline_ms as i64 - elapsed as i64;
                rem <= 0
            },
        )?;

        // uicp:host/control.deadline-ms(job-id) -> u32
        linker.func_wrap(
            "uicp:host/control",
            "deadline-ms",
            |caller: wasmtime::StoreContextMut<'_, Ctx>, _job: &str| -> u32 { caller.data().deadline_ms },
        )?;

        // uicp:host/control.remaining-ms(job-id) -> u32
        linker.func_wrap(
            "uicp:host/control",
            "remaining-ms",
            |caller: wasmtime::StoreContextMut<'_, Ctx>, _job: &str| -> u32 {
                let elapsed = caller.data().started.elapsed().as_millis() as u64;
                let d = caller.data().deadline_ms as i64 - elapsed as i64;
                if d <= 0 { 0 } else { d as u32 }
            },
        )?;

        // uicp:host/control.open-partial-sink(job-id) -> streams.output-stream
        // Returns a host-backed output stream that forwards bytes as partial events.
        linker.func_wrap(
            "uicp:host/control",
            "open-partial-sink",
            |mut caller: wasmtime::StoreContextMut<'_, Ctx>, _job: &str| -> anyhow::Result<u32> {
                // Define a host output stream that emits partial events on each write.
                struct PartialSink {
                    app: AppHandle,
                    job_id: String,
                    task: String,
                    seq: u64,
                    frames_counter: Arc<std::sync::atomic::AtomicU64>,
                    invalid_counter: Arc<std::sync::atomic::AtomicU64>,
                }

                impl HostOutputStream for PartialSink {
                    fn write(&mut self, buf: bytes::Bytes) -> anyhow::Result<Result<usize, StreamError>> {
                        let chunk = buf.as_ref();
                        // Enforce frame size cap 64KiB (truncate beyond); drop frames beyond max count
                        if chunk.is_empty() { return Ok(Ok(0)); }
                        // Drop frames after 1000 to avoid unbounded streams (policy)
                        if self.seq >= 1000 {
                            // Accept as written (no trap), but do not emit.
                            return Ok(Ok(chunk.len().min(65536)));
                        }
                        if chunk.len() > 65536 { return Ok(Ok(65536)); }
                        // Validate CBOR envelope (best effort). Expect map with integer keys 1,2,3 minimally present.
                        let mut valid = false;
                        if let Ok(val) = ciborium::de::from_reader::<ciborium::value::Value, _>(std::io::Cursor::new(chunk)) {
                            if let ciborium::value::Value::Map(entries) = val {
                                let mut have_t = false; let mut have_s = false; let mut have_ts = false;
                                for (k, _v) in &entries {
                                    if let ciborium::value::Value::Integer(i) = k {
                                        let x = i128::from(*i);
                                        if x == 1 { have_t = true; }
                                        if x == 2 { have_s = true; }
                                        if x == 3 { have_ts = true; }
                                    }
                                }
                                valid = have_t && have_s && have_ts;
                            }
                        }
                        if !valid {
                            // Drop invalid frames; emit a host log entry for observability and count
                            self.invalid_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            let _ = self.app.emit(
                                "compute.host.log",
                                serde_json::json!({
                                    "jobId": self.job_id,
                                    "task": self.task,
                                    "level": "warn",
                                    "msg": "dropped invalid partial frame (CBOR validation failed)",
                                }),
                            );
                            return Ok(Ok(chunk.len()));
                        }
                        // Max frames policy: 1000
                        // Note: we can’t read caller.data() here; track per-sink seq and let host drop after policy if wired.
                        let payload = crate::ComputePartialEvent {
                            job_id: self.job_id.clone(),
                            task: self.task.clone(),
                            seq: self.seq,
                            payload_b64: BASE64_ENGINE.encode(chunk),
                        };
                        let _ = self.app.emit("compute.result.partial", payload);
                        self.seq = self.seq.saturating_add(1);
                        self.frames_counter.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        Ok(Ok(chunk.len()))
                    }
                    fn flush(&mut self) -> anyhow::Result<Result<(), StreamError>> {
                        Ok(Ok(()))
                    }
                    fn check_write(&mut self) -> anyhow::Result<Result<usize, StreamError>> {
                        // Offer a reasonable chunk window to the guest
                        Ok(Ok(64 * 1024))
                    }
                }

                // Push the stream into the table and return its handle.
                let handle = caller.data_mut().table.push_output_stream(Box::new(PartialSink {
                    app: caller.data().app.clone(),
                    job_id: caller.data().job_id.clone(),
                    task: caller.data().task.clone(),
                    seq: caller.data().partial_seq,
                    frames_counter: caller.data().partial_frames.clone(),
                    invalid_counter: caller.data().invalid_partial_frames.clone(),
                }))?;
                // Return the resource index as u32
                Ok(handle)
            },
        )?;

        // Deterministic RNG: uicp:host/rng.next-u64(job) -> u64
        linker.func_wrap(
            "uicp:host/rng",
            "next-u64",
            |mut caller: wasmtime::StoreContextMut<'_, Ctx>, _job: &str| -> u64 {
                use sha2::{Digest, Sha256};
                let ctr = caller.data().rng_counter;
                caller.data_mut().rng_counter = ctr.saturating_add(1);
                let mut hasher = Sha256::new();
                hasher.update(&caller.data().rng_seed);
                hasher.update(&ctr.to_le_bytes());
                let out = hasher.finalize();
                let mut bytes = [0u8; 8];
                bytes.copy_from_slice(&out[0..8]);
                u64::from_le_bytes(bytes)
            },
        )?;

        // Deterministic RNG: uicp:host/rng.fill(job, len) -> list<u8>
        linker.func_wrap(
            "uicp:host/rng",
            "fill",
            |mut caller: wasmtime::StoreContextMut<'_, Ctx>, _job: &str, len: u32| -> Vec<u8> {
                let mut out = Vec::with_capacity(len as usize);
                while (out.len() as u32) < len {
                    let v = {
                        use sha2::{Digest, Sha256};
                        let ctr = caller.data().rng_counter;
                        caller.data_mut().rng_counter = ctr.saturating_add(1);
                        let mut hasher = Sha256::new();
                        hasher.update(&caller.data().rng_seed);
                        hasher.update(&ctr.to_le_bytes());
                        hasher.finalize()
                    };
                    out.extend_from_slice(&v);
                }
                out.truncate(len as usize);
                out
            },
        )?;

        // Logical clock: uicp:host/clock.now-ms(job) -> u64 (deterministic logical time)
        linker.func_wrap(
            "uicp:host/clock",
            "now-ms",
            |mut caller: wasmtime::StoreContextMut<'_, Ctx>, _job: &str| -> u64 {
                let t = caller.data().logical_tick;
                caller.data_mut().logical_tick = t.saturating_add(1);
                t
            },
        )?;

        Ok(())
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
        if acc.contains("epoch") || acc.contains("deadline") || acc.contains("interrupt") || acc.contains("deadline exceeded") {
            return ("Timeout", String::new());
        }
        // CPU fuel exhaustion (if enabled)
        if acc.contains("fuel") && (acc.contains("exhaust") || acc.contains("consum") || acc.contains("out of")) {
            return ("Resource.Limit", String::new());
        }
        // Memory / resource limits
        if acc.contains("out of memory")
            || (acc.contains("memory") && (acc.contains("limit") || acc.contains("exceed") || acc.contains("grow") || acc.contains("oom")))
            || acc.contains("resource limit")
            || acc.contains("limit exceeded")
        {
            return ("Resource.Limit", String::new());
        }
        // Missing exports / bad linkage
        if (acc.contains("export") && (acc.contains("not found") || acc.contains("unknown")))
            || (acc.contains("instantiate") && acc.contains("missing"))
        {
            return ("Task.NotFound", String::new());
        }
        // Capability denial (FS/HTTP off by default in V1)
        if acc.contains("permission") || acc.contains("denied") {
            return ("CapabilityDenied", String::new());
        }
        ("Runtime.Fault", String::new())
    }

    async fn finalize_error(app: &AppHandle, spec: &ComputeJobSpec, code: &str, message: &str, started: Instant) {
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
            let key = crate::compute_cache::compute_key(&spec.task, &spec.input, &spec.provenance.env_hash);
            let mut obj = serde_json::to_value(&payload).unwrap_or(serde_json::json!({}));
            if let Some(map) = obj.as_object_mut() {
                map.insert("metrics".into(), serde_json::json!({ "durationMs": ms }));
            }
            let _ = crate::compute_cache::store(app, "default", &key, &spec.task, &spec.provenance.env_hash, &obj).await;
        }
    }

    async fn finalize_ok(app: &AppHandle, spec: &ComputeJobSpec, output: serde_json::Value, started: Instant) {
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
            let key = crate::compute_cache::compute_key(&spec.task, &spec.input, &spec.provenance.env_hash);
            let mut obj = serde_json::json!({ "ok": true, "jobId": spec.job_id, "task": spec.task, "output": output });
            if let Some(map) = obj.as_object_mut() {
                map.insert("metrics".into(), serde_json::json!({ "durationMs": ms, "cacheHit": false }));
            }
            let _ = crate::compute_cache::store(app, "default", &key, &spec.task, &spec.provenance.env_hash, &obj).await;
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
            let key = crate::compute_cache::compute_key(&spec.task, &spec.input, &spec.provenance.env_hash);
            let mut obj = serde_json::json!({ "ok": true, "jobId": spec.job_id, "task": spec.task, "output": output });
            if let Some(map) = obj.as_object_mut() {
                map.insert("metrics".into(), metrics);
            }
            let _ = crate::compute_cache::store(app, "default", &key, &spec.task, &spec.provenance.env_hash, &obj).await;
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
        let mut metrics = serde_json::json!({
            "durationMs": duration_ms,
            "deadlineMs": store.data().deadline_ms,
            "logCount": store.data().log_count,
            "partialFrames": store.data().partial_frames.load(Ordering::Relaxed),
            "invalidPartialsDropped": store.data().invalid_partial_frames.load(Ordering::Relaxed),
            "remainingMsAtFinish": remaining,
        });
        if let Some(consumed) = store.fuel_consumed() {
            if consumed > 0 {
                if let Some(map) = metrics.as_object_mut() {
                    map.insert("fuelUsed".into(), serde_json::json!(consumed));
                }
            }
        }
        metrics
    }
}

#[cfg(not(feature = "wasm_compute"))]
mod no_runtime {
    use super::*;

    /// Spawn a placeholder compute job (no Wasm runtime compiled).
    pub(super) fn spawn_job(app: AppHandle, spec: ComputeJobSpec, permit: Option<OwnedSemaphorePermit>) -> JoinHandle<()> {
        tauri_spawn(async move {
            let _permit = permit;
            // Register cancel channel
            let (tx_cancel, mut rx_cancel) = tokio::sync::watch::channel(false);
            {
                let state: tauri::State<'_, crate::AppState> = app.state();
                state.compute_cancel.write().await.insert(spec.job_id.clone(), tx_cancel);
            }

            // Emit a stub partial to exercise the event path.
            let partial = crate::ComputePartialEvent { job_id: spec.job_id.clone(), task: spec.task.clone(), seq: 0, payload_b64: BASE64_ENGINE.encode("stub-partial") };
            let _ = app.emit("compute.result.partial", partial);

            tokio::select! {
                _ = rx_cancel.changed() => {
                    let payload = ComputeFinalErr { ok: false, job_id: spec.job_id.clone(), task: spec.task.clone(), code: "Cancelled".into(), message: "Job cancelled by user".into() };
                    let _ = app.emit("compute.result.final", payload);
                }
                _ = tokio::time::sleep(Duration::from_millis(50)) => {
                    let payload = ComputeFinalErr { ok: false, job_id: spec.job_id.clone(), task: spec.task.clone(), code: "Task.NotFound".into(), message: "Wasm runtime not enabled (feature wasm_compute)".into() };
                    let _ = app.emit("compute.result.final", payload.clone());
                    if spec.replayable && spec.cache == "readwrite" {
                        let key = crate::compute_cache::compute_key(&spec.task, &spec.input, &spec.provenance.env_hash);
                        let _ = crate::compute_cache::store(&app, "default", &key, &spec.task, &spec.provenance.env_hash, &serde_json::to_value(&payload).unwrap()).await;
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
pub fn spawn_job(app: AppHandle, spec: ComputeJobSpec, permit: Option<OwnedSemaphorePermit>) -> JoinHandle<()> {
    #[cfg(feature = "wasm_compute")]
    {
        with_runtime::spawn_job(app, spec, permit)
    }
    #[cfg(not(feature = "wasm_compute"))]
    {
        no_runtime::spawn_job(app, spec, permit)
    }
}
