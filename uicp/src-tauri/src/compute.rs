//! UICP Wasm compute host scaffolding.
//!
//! This module is compiled unconditionally and selects implementation
//! based on the `wasm_compute` feature:
//! - when enabled, we initialize a Wasmtime Engine (Preview 2) to
//!   prove embed viability (actual hostcalls and task registry follow).
//! - when disabled, we emit a deterministic placeholder error so the
//!   UI/adapter can be wired without the runtime.

use std::time::Duration;

use tauri::AppHandle;
use tokio::task::JoinHandle;
use tokio::sync::OwnedSemaphorePermit;

use crate::{ComputeFinalErr, ComputeJobSpec};

#[cfg(feature = "wasm_compute")]
mod with_runtime {
    use super::*;
    use wasmtime::{component::Linker, Config, Engine};
    use wasmtime_wasi::preview2::{self, WasiCtx, WasiCtxBuilder, WasiView, Table};

    /// Execution context for a single job store.
    struct Ctx {
        wasi: WasiCtx,
        table: Table,
        app: AppHandle,
        job_id: String,
        task: String,
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

    /// Spawn a compute job using Wasmtime (skeleton).
    pub(super) fn spawn_job(app: AppHandle, spec: ComputeJobSpec, permit: Option<OwnedSemaphorePermit>) -> JoinHandle<()> {
        // In this phase, we prove runtime embed and still emit a final error.
        tokio::spawn(async move {
            let _permit = permit;
            // Initialize engine once per job (later: pool it)
            let engine_res = build_engine();
            if let Err(err) = engine_res {
                let payload = ComputeFinalErr {
                    ok: false,
                    job_id: spec.job_id.clone(),
                    task: spec.task.clone(),
                    code: "Runtime.Fault".into(),
                    message: format!("Failed to init Wasm engine: {err}"),
                };
                let _ = app.emit("compute.result.final", payload);
                // remove from map
                crate::remove_compute_job(&app, &spec.job_id).await;
                return;
            }
            let engine = engine_res.unwrap();

            // Build a fresh store context per job with no ambient FS/NET.
            let wasi = WasiCtxBuilder::new()
                .inherit_random() // deterministic if seeded via future design; ok for now
                .build();
            let table = Table::new();
            let mut store = wasmtime::Store::new(&engine, Ctx {
                wasi,
                table,
                app: app.clone(),
                job_id: spec.job_id.clone(),
                task: spec.task.clone(),
            });
            if let Some(fuel) = spec.fuel { let _ = store.add_fuel(fuel); }

            // Create a Component Linker and wire WASI P2 plus our host control surface.
            let mut linker = Linker::<Ctx>::new(&engine);
            if let Err(err) = add_wasi_and_host(&mut linker) {
                let payload = ComputeFinalErr {
                    ok: false,
                    job_id: spec.job_id.clone(),
                    task: spec.task.clone(),
                    code: "Runtime.Fault".into(),
                    message: format!("Failed to link WASI/host: {err}"),
                };
                let _ = app.emit("compute.result.final", payload.clone());
                // Cache if readwrite & replayable
                if spec.replayable && spec.cache == "readwrite" {
                    let key = crate::compute_cache::compute_key(&spec.task, &spec.input, &spec.provenance.env_hash);
                    let _ = crate::compute_cache::store(&app, &key, &spec.task, &spec.provenance.env_hash, &serde_json::to_value(&payload).unwrap()).await;
                }
                crate::remove_compute_job(&app, &spec.job_id).await;
                return;
            }

            // Emit a stub partial to exercise the event path.
            let partial = crate::ComputePartialEvent {
                job_id: spec.job_id.clone(),
                task: spec.task.clone(),
                seq: 0,
                payload_b64: base64::encode("stub-partial"),
            };
            let _ = app.emit("compute.result.partial", partial);

            // TODO(next): instantiate component from registry and invoke run().
            // For now, emit a NotFound since registry is not wired.
            tokio::time::sleep(Duration::from_millis(50)).await;
            let payload = ComputeFinalErr {
                ok: false,
                job_id: spec.job_id.clone(),
                task: spec.task.clone(),
                code: "Task.NotFound".into(),
                message: "No module registry is configured".into(),
            };
            let _ = app.emit("compute.result.final", payload.clone());
            if spec.replayable && spec.cache == "readwrite" {
                let key = crate::compute_cache::compute_key(&spec.task, &spec.input, &spec.provenance.env_hash);
                let _ = crate::compute_cache::store(&app, &key, &spec.task, &spec.provenance.env_hash, &serde_json::to_value(&payload).unwrap()).await;
            }
            crate::remove_compute_job(&app, &spec.job_id).await;
        })
    }

    /// Wire core WASI Preview 2 imports and uicp:host control stubs.
    fn add_wasi_and_host(linker: &mut Linker<Ctx>) -> anyhow::Result<()> {
        // WASI Preview 2: clocks, streams, random
        preview2::wasi::clocks::monotonic_clock::add_to_linker(linker, |ctx| ctx)?;
        preview2::wasi::io::streams::add_to_linker(linker, |ctx| ctx)?;
        preview2::wasi::random::random::add_to_linker(linker, |ctx| ctx)?;

        // uicp:host/control.log(level, msg)
        linker.func_wrap(
            "uicp:host/control",
            "log",
            |mut caller: wasmtime::StoreContextMut<'_, Ctx>, level: u32, msg: &str| {
                // Map enum to string level conservatively
                let lvl = match level { 0 => "trace", 1 => "debug", 2 => "info", 3 => "warn", 4 => "error", _ => "info" };
                let payload = serde_json::json!({
                    "jobId": caller.data().job_id,
                    "task": caller.data().task,
                    "level": lvl,
                    "msg": msg,
                });
                let _ = caller.data().app.emit("compute.host.log", payload);
            },
        )?;

        // uicp:host/control.cancel-pollable(job-id) -> pollable
        // For now, return a trap since cancellation is not yet integrated.
        linker.func_wrap(
            "uicp:host/control",
            "cancel-pollable",
            |_caller: wasmtime::StoreContextMut<'_, Ctx>, _job: &str| -> anyhow::Result<u32> {
                anyhow::bail!("cancel-pollable not implemented in Phase 0");
            },
        )?;

        // uicp:host/control.open-partial-sink(job-id) -> output-stream
        // For now, return a trap until we plug a pipe to emit compute.result.partial.
        linker.func_wrap(
            "uicp:host/control",
            "open-partial-sink",
            |_caller: wasmtime::StoreContextMut<'_, Ctx>, _job: &str| -> anyhow::Result<u32> {
                anyhow::bail!("open-partial-sink not implemented in Phase 0");
            },
        )?;

        Ok(())
    }
}

#[cfg(not(feature = "wasm_compute"))]
mod no_runtime {
    use super::*;

    /// Spawn a placeholder compute job (no Wasm runtime compiled).
    pub(super) fn spawn_job(app: AppHandle, spec: ComputeJobSpec, permit: Option<OwnedSemaphorePermit>) -> JoinHandle<()> {
        tokio::spawn(async move {
            let _permit = permit;
            // Emit a stub partial to exercise the event path.
            let partial = crate::ComputePartialEvent {
                job_id: spec.job_id.clone(),
                task: spec.task.clone(),
                seq: 0,
                payload_b64: base64::encode("stub-partial"),
            };
            let _ = app.emit("compute.result.partial", partial);

            // Small delay to allow cancellation during tests and mirror async scheduling.
            tokio::time::sleep(Duration::from_millis(50)).await;
            let payload = ComputeFinalErr {
                ok: false,
                job_id: spec.job_id.clone(),
                task: spec.task.clone(),
                code: "Task.NotFound".into(),
                message: "Wasm runtime not enabled (feature wasm_compute)".into(),
            };
            let _ = app.emit("compute.result.final", payload.clone());
            if spec.replayable && spec.cache == "readwrite" {
                let key = crate::compute_cache::compute_key(&spec.task, &spec.input, &spec.provenance.env_hash);
                let _ = crate::compute_cache::store(&app, &key, &spec.task, &spec.provenance.env_hash, &serde_json::to_value(&payload).unwrap()).await;
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
