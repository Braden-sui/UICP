Wasm Components (Guest Modules)

Two reference tasks are planned for V1:

- csv.parse@1.2.0
- table.query@0.1.0

Build guidance (local):

1. Install `cargo-component` (toolchain).
2. Components implement their WIT world under `components/<task>/wit/world.wit` (world `entry`).
3. Build to a component-model Wasm: `cargo component build --release -Zunstable-options`.
4. Copy the resulting `*.wasm` to `<dataDir>/modules/` and update `<dataDir>/modules/manifest.json` with `task`, `version`, `filename`, and `digest_sha256` (sha256 of wasm bytes).
   Or run:
   `node scripts/update-manifest.mjs --manifest uicp/src-tauri/modules/manifest.json --task csv.parse --version 1.2.0 --wasm <path/to/wasm> --filename csv.parse@1.2.0.wasm --copy --outdir uicp/src-tauri/modules`
   At runtime, point the app to your modules dir with `UICP_MODULES_DIR`.

Notes

- Determinism: avoid ambient WASI random/clock; use host `uicp:host@1.0.0` imports when needed.
- Streaming: `uicp:host/control.open-partial-sink(jobId)` yields a `wasi:io/streams.output-stream` for CBOR/JSON frames.
- csv.parse v1: filesystem is OFF; pass CSV via a `data:` URI in `input.source` (e.g., `data:text/csv,foo%2Cbar%0A1%2C2`).
- table.query v1: inputs are in-memory rows (list<list<string>>), a `select` column index list, and optional `where_contains` filter.
