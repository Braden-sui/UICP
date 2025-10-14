# Speed Enhancement Proposals

## Overview

Startup of the UICP desktop currently takes 25-35 seconds on cold launch before the Tauri window renders meaningful UI. The perceived stall drives user uncertainty about application health. Investigation of the Rust host and React shell surfaced several synchronous tasks that block window presentation and delay workspace hydration. Beyond cold-start latency, several runtime hotspots can slow steady-state interaction or consume excess resources.

## Cold Start Bottlenecks

- **Synchronous database preparation** in `uicp/src-tauri/src/main.rs` sets up two SQLite connections, configures pragmas, runs migrations, and performs `init_database()` plus `ensure_default_workspace()` before the window event loop starts. These all execute on the main thread via `tauri::async_runtime::block_on`, holding the UI until completion.
- **Action log bootstrap** in `uicp/src-tauri/src/action_log.rs` spawns a worker thread but performs initial connection setup synchronously. On cold user data directories the schema initialization adds noticeable latency.
- **Bundled module installation** through `registry::install_bundled_modules_if_missing()` in `uicp/src-tauri/src/registry.rs` copies WASM bundles and verifies digests inside the `Builder::setup` callback. Disk IO dominates first launch, especially on HDDs or large manifests.
- **Workspace replay on the renderer thread**: `Desktop.tsx` invokes `replayWorkspace()` from `uicp/src/lib/uicp/adapter.ts` immediately after mounting. For workspaces with numerous persisted commands, replay proceeded synchronously and blocked first paint.

## Cold Start Remedies

- **Defer heavy IO off the main thread**
  - Move module installation and manifest verification into `tauri::async_runtime::spawn` tasks that emit completion events instead of blocking `setup()`.
  - Wrap synchronous SQLite configuration and migrations in `tokio::task::spawn_blocking` to avoid stalling the Tauri event loop.

- **Surface progress to the renderer**
  - Emit startup milestones (`db-ready`, `modules-ready`, `workspace-replay-progress`) via `app.emit` so the React shell can display a loading overlay and step indicators.
  - Add a lightweight skeleton in `App.tsx` that remains until both module readiness and workspace replay completion events arrive.

- **Optimize workspace persistence**
  - Snapshot aggregate state (single JSON blob) alongside command logs to reduce replay volume, or prune redundant historical commands during shutdown.
  - **Status (2025-10-13)**: Replay now streams in batches of 20 commands and yields via `requestIdleCallback`/`setTimeout`, emitting `workspace-replay-progress` and `workspace-replay-complete` events so the UI can update incrementally.

- **Precompute or cache results**
  - Ship a pre-populated SQLite database with baseline schema to eliminate cold migration work.
  - Cache module digest verification outcomes with a sentinel file so subsequent launches skip full hash checks when manifests are unchanged.

- **Instrumentation and telemetry**
  - Record timestamps around each startup milestone in both Rust (`tracing` spans) and JS (`performance.mark`). Log aggregated launch durations to help validate improvements and catch regressions.
  - **Status (2025-10-13)**: Module installation now runs under a dedicated `tracing` span, workspace replay progress is observable from JS events, and compute/telemetry stores mark updates with `performance.mark` for correlation with host spans.

## Runtime Hotspots

### Renderer

- **`src/state/compute.ts:summarizeComputeJobs()`** — *Status: ✅ 2025-10-13*
  - Multiple `filter` and `reduce` passes executed on every store update for both `MetricsPanel.tsx` and `DevtoolsComputePanel.tsx`.
  - *Mitigation*: Collapsed all aggregations into a single pass with memoized caching, trimming redundant allocations before render.

- **`src/state/app.ts:upsertTelemetry()`** — *Status: ✅ 2025-10-13*
  - Previously cloned and `unshift`ed telemetry arrays on every trace update, triggering `MetricsPanel.tsx` re-renders.
  - *Mitigation*: Replaced the array with a fixed-size ring buffer, exposing snapshot helpers (`telemetryBufferToArray`) so panels can materialize only the rows they need.

- **`src/components/DockChat.tsx`**
  - Recomputes memoized status helpers for the full `messages` array even when unrelated state toggles.
  - **Opportunity**: Adopt selectors that expose only the latest message slice or a derived digest to limit render scope.

- **`src/components/LogsPanel.tsx`** — *Status: ✅ 2025-10-13*
  - Maintains and re-sorts large log buffers on every append.
  - *Mitigation*: Panel now reads from the telemetry ring buffer snapshot (no copying) and keeps append operations capped.

- **`src/components/AmbientParticles.tsx`**
  - Runs continuous animation regardless of focus state.
  - **Opportunity**: Pause or degrade effect when the window is unfocused to lower GPU usage.

### Workspace Persistence

- **`src/lib/uicp/adapter.ts:replayWorkspace()`** — *Status: ✅ 2025-10-13*
  - Replay now streams commands in deterministic batches, yields between chunks, and dispatches progress/completion events for the renderer. A dedupe guard prevents double-apply of identical commands.

### Host (Rust/Tauri)

- **SQLite access in command handlers** (`src-tauri/src/main.rs`)
  - Calls such as `persist_command` and `get_workspace_commands` hit the database synchronously on the Tauri invoke thread.
  - **Opportunity**: Wrap heavy operations in `tokio::task::spawn_blocking` to keep the runtime responsive.

- **Bundled module verification** (`src-tauri/src/registry.rs`) — *Status: ⏳*
  - Performs full digest checks on every launch.
  - *Progress*: Added tracing spans and skip logging; caching sentinel still pending.

- **Compute host throttling loops** (`src-tauri/src/compute.rs`) — *Status: ✅ 2025-10-13*
  - Repeated `std::thread::sleep(Duration::from_millis(10))` calls added unnecessary wakeups.
  - *Mitigation*: Throttle loops now compute dynamic sleep durations from the rate limiter and fall back to short cooperative yields, reducing CPU churn without sacrificing backpressure.

- **Action log worker** (`src-tauri/src/action_log.rs`)
  - Initializes sqlite synchronously before signalling readiness and writes entries one-by-one.
  - **Opportunity**: Batch appends or move initial configuration to a background task to shorten hot-path latency.

## Instrumentation

- Add `tracing` spans around compute queue updates, module installation, workspace replay, and cold-start checkpoints to capture runtime metrics without impacting release builds.
- Mirror critical spans in the renderer using `performance.mark` so WebView profiling ties back to host events.
- Log aggregated launch durations to track regressions across builds.

## Next Steps

1. Draft an implementation plan prioritizing asynchronous module installation and progress signaling.
2. Prototype a renderer loading overlay triggered by new startup events.
3. Bench cold and warm launches before and after each change to quantify impact and adjust backlog priorities.
4. Roll remaining renderer memoization items (DockChat, AmbientParticles) onto the backlog.
5. Land sqlite and module verification offloads to finish the host-side cold-start work.
6. Schedule action-log batching and retention once strict verification is wired into CI.
