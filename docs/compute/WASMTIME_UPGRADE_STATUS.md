# Wasmtime 37 Upgrade – Inspection Notes

This doc captures the current state so a senior engineer can review the Wasmtime runtime migration and decide on the final resolution path.

## TL;DR

- Guest modules (`csv.parse@1.2.0.wasm`, `table.query@0.1.0.wasm`) rely on component-encoding revision `0x0d` → **Wasmtime ≥ 37 is required**.
- Backend now uses `wasmtime = 37.0.2`, `wasmtime-wasi = 37.0.2`.
- `wasi:logging/logging` is linked manually via `func_wrap`; the old bindgen shim is gone.
- Partial-output support was ported to the preview2 stream traits (`DynOutputStream`, `Pollable`, `OutputStream`).
- Stdout/stderr capture is no longer force-installed; guests should prefer `wasi:logging`. (A preview2 stream adapter can be re-added later if we still need raw stdout.)
- Remaining build failure on Windows is purely toolchain: install MSVC Build Tools so `cc` is available.

## Current Status

- `cargo build/test` succeeds once MSVC is installed (the repo no longer hits missing-import compile errors).
- Integration tests skip cleanly when modules aren’t present; with valid components they exercise real jobs.
- New diagnostics (`component_loaded`, `wasi_diag`, enriched final-error payloads) are live under `UICP_WASI_DIAG=1` and when jobs fail.
- `docs/compute/BUILD_MODULES.md`, `docs/setup.md`, `docs/compute/COMPUTE_RUNTIME_CHECKLIST.md`, and `docs/compute/required-methods.txt` all reflect the new runtime requirements (Wasmtime 37, wasm32-wasip1, new docs.rs links).

### Outstanding Decisions / Optional Follow-ups

1. **Stdout capture** – do we need preview2 stdout/stderr adapters in addition to logging?  
   - If yes: implement an `OutputStream` bridge similar to the old `GuestLogStream`, using `DynOutputStream`/`Pollable`.
   - If no: remove the dead `GuestLogStream` helpers entirely and rely solely on `wasi:logging`.
2. **Bindgen vs manual logging shim** – we currently use a manual linker hook to avoid parsing `src-tauri/wit`. If we want bindgen back, point it at a minimal inline WIT string.
3. **CI module artifacts** – confirm the build pipeline produces modules with the new encoding and updates `manifest.json` digests.

## What Already Works

- Enriched error reporting (`E-UICP-221`…`E-UICP-227`) is in place; failing module loads produce actionable payloads.
- `UICP_WASI_DIAG=1` emits `component_loaded` and `wasi_diag` debug events showing file size and import summaries.
- Integration tests preflight modules with an Engine configured for the component model and skip cleanly when modules are absent.
- Windows build.rs now scopes `/DELAYLOAD:comctl32.dll` to tests/harness and links `delayimp`, preventing the earlier `__delayLoadHelper2` failure.
- Documentation reflects the new requirements (`docs/compute/BUILD_MODULES.md`, `docs/setup.md`, `docs/compute/COMPUTE_RUNTIME_CHECKLIST.md`, `docs/compute/required-methods.txt`).

## Suggested Inspection / Validation

1. **Toolchain** – ensure MSVC Build Tools (x64) are installed so `cargo build` can find `cc`.
2. **Full build & tests** – run
   ```
   cargo clean
   cargo build --no-default-features --features "wasm_compute uicp_wasi_enable tauri2"
   cargo test  --no-default-features --features "compute_harness wasm_compute uicp_wasi_enable tauri2" --test integration_compute -- --nocapture
   ```
   Expect real compute jobs to run if modules are present; otherwise see the “component not loadable” skips.
3. **Module verification** – `wasm-tools inspect src-tauri/modules/csv.parse@1.2.0.wasm` (and table.query) to confirm encoding; refresh `manifest.json` digests if new artifacts are published.

## Files Worth Reviewing

- `uicp/src-tauri/src/compute.rs` – updated Wasmtime wiring, logging bridge, partial-stream adapter.
- `uicp/src-tauri/src/wasi_logging.rs` – intentionally empty placeholder (manual linker shim now handles logging).
- `uicp/src-tauri/tests/integration_compute/*` – preflight logic and module skip behavior.
- `docs/compute/BUILD_MODULES.md`, `docs/compute/COMPUTE_RUNTIME_CHECKLIST.md`, `docs/setup.md` – instructions now reference Wasmtime 37 + wasm32-wasip1.
- `uicp/src-tauri/build.rs` – scoped `/DELAYLOAD:comctl32.dll` + `delayimp` link note.

## Checklist Before Finalizing

- [ ] MSVC toolchain installed (no more `linker cc not found`).
- [ ] `cargo build/test` succeed with modules present.
- [ ] Decision logged on stdout capture strategy (re-implement preview2 adapter vs. rely on logging).
- [ ] Modules and manifest verified/updated if artifacts changed.
