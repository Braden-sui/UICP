Build UICP Wasm Components (Preview 2)

Goal
- Produce component-encoded Wasm artifacts that the host can load and run for tasks like `csv.parse@1.2.0` and `table.query@0.1.0`.

Requirements
- Rust toolchain (stable)
- Target: `rustup target add wasm32-wasip1`
- Cargo Component: `cargo install cargo-component` (or use `wasm-tools component` manually)
- Host runtime: Wasmtime >= 37 (supports newer component encoding `0d 00 01 00`)

Key Points
- The host expects Wasm Components (WASI Preview 2), not core Wasm (`.wasm`) modules.
- Exports must match the shapes the host calls:
  - `csv#run(jobId: string, input: string, hasHeader: bool) -> result<list<list<string>>, string>`
  - `table#run(jobId: string, rows: list<list<string>>, select: list<u32>, where?: (u32, string)) -> result<list<list<string>>, string>`
- Optional imports used by some components:
  - `wasi:logging/logging` (for guest logs)
  - `uicp:host/control` and `uicp:host/rng` (host control helpers)

Quick Scaffold (csv.parse)
1) Create a component crate (outside of src-tauri):
   - `mkdir -p components/csv.parse && cd components/csv.parse`
   - `cargo component new csv.parse --lib`

2) Define WIT world in `wit/` (minimal):
   - `wit/world.wit`:
     package uicp:csv-parse@1.2.0;
     interface csv {
       run: func(job-id: string, input: string, has-header: bool) -> result<list<list<string>>, string>
     }
     world task {
       export csv;
     }

3) Implement `lib.rs` using cargo-component bindings:
   - Use generated bindings for `csv` interface.
   - Parse CSV using a tiny parser (e.g., `split` by lines/commas) to avoid heavy deps.

4) Build:
   - `rustup target add wasm32-wasip1`
   - `cargo component build --release`
   - Artifact is under `target/wasm32-wasip1/release/*.wasm` (component-encoded)

5) Install into the host:
   - Copy artifact to `uicp/src-tauri/modules/csv.parse@1.2.0.wasm`

Table Query Scaffold (optional)
- Mirror the above with an interface `table` exposing `run(job-id, rows, select, where?)` returning `result<rows, string>`.

Diagnostics
- Set `UICP_WASI_DIAG=1` to see:
  - `component_loaded` debug logs (path/size)
  - `wasi_diag` with linked imports summary
- Failures during load/instantiate surface concrete messages with codes:
  - `E-UICP-222`: component load translation error (usually "not a component").
  - `E-UICP-223`: instantiate failed (often missing import/signature mismatch).
  - `E-UICP-224/225/226/227`: export lookup or call failures for `csv#run`/`table#run`.

Notes
- You can also adapt the provided WIT in `docs/wit/tasks/uicp-task-csv-parse@1.2.0.wit` and `docs/wit/uicp-host@1.0.0.wit` to your components.
- If your component imports logging/control/rng from different package versions, adjust the host linker or re-bind against the host’s imports.
