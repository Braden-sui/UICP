// Non-compiling sketch of the Wasmtime host integration for UICP.
// Purpose: clarify limits, streaming, and cancellation wiring.

use anyhow::Result;
use wasmtime::{Component, Config, Engine, Store};
use wasmtime::component::{Linker, TypedFunc};
use wasmtime_wasi::preview2::{WasiCtx, WasiCtxBuilder, WasiView, Table};

struct Ctx {
  wasi: WasiCtx,
  table: Table,
  // job metadata, partial sink pipes, limits, cache handles, etc.
}

impl WasiView for Ctx {
  fn table(&self) -> &Table { &self.table }
  fn table_mut(&mut self) -> &mut Table { &mut self.table }
  fn ctx(&self) -> &WasiCtx { &self.wasi }
  fn ctx_mut(&mut self) -> &mut WasiCtx { &mut self.wasi }
}

fn build_engine() -> Result<Engine> {
  let mut cfg = Config::new();
  cfg.wasm_component_model(true)
     .wasm_memory64(false)
     .consume_fuel(true)
     .epoch_interruption(true);
  Ok(Engine::new(&cfg)?)
}

fn new_store(engine: &Engine, fuel: Option<u64>) -> Store<Ctx> {
  let table = Table::new();
  let wasi = WasiCtxBuilder::new()
      // No ambient fs or net by default; selectively add preopens/clock/random.
      .inherit_random()
      .build();
  let mut store = Store::new(engine, Ctx { wasi, table });
  if let Some(f) = fuel { store.add_fuel(f).ok(); }
  // Configure StoreLimits for memory/tables via wasmtime resource limiter.
  // Implement ResourceLimiter to trap on overuse; record peaks for telemetry.
  store
}

fn link_host(imports: &mut Linker<Ctx>) -> Result<()> {
  // Wire wasi:io/streams, random, clocks (preview2 helper crates)
  wasmtime_wasi::preview2::wasi::clocks::monotonic_clock::add_to_linker(imports, |ctx| ctx)?;
  wasmtime_wasi::preview2::wasi::io::streams::add_to_linker(imports, |ctx| ctx)?;
  wasmtime_wasi::preview2::wasi::random::random::add_to_linker(imports, |ctx| ctx)?;

  // Wire uicp:host/control (cancel-pollable, open-partial-sink, log)
  // Use custom implementations that enforce per-job policy and map to the event bus.
  // e.g., create a pipe-backed output-stream that feeds compute.result.partial events.
  Ok(())
}

fn run_task(component_bytes: &[u8], job: &JobSpec) -> Result<TaskResult> {
  let engine = build_engine()?;
  let component = Component::from_binary(&engine, component_bytes)?;

  let mut linker = Linker::new(&engine);
  link_host(&mut linker)?;

  let mut store = new_store(&engine, job.fuel);
  // Configure epoch deadline: set engine epoch periodically; spawn a timer to interrupt on timeout.

  // Instantiate component and call typed entrypoint: task.run(jobId, input)
  // Use generated bindings (wit-bindgen) once WIT is stabilized in the repo.
  // Map OK/ERR into TaskResult and emit final event.
  unimplemented!()
}

// Example types mirroring docs/src/compute/types.ts for illustration only.
struct JobSpec { fuel: Option<u64> }
struct TaskResult;
