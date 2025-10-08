RFC: Wasm‑Only Compute Plane for UICP

Author: Kestrel
Status: Proposal
Audience: UICP core (Tauri/Rust), Adapter, Frontend (TS/React), Agent/runtime owners

1) Context

UICP today: local‑first desktop (Tauri: Rust backend + TS/React). Agents can only emit validated data‑ops (e.g., state.*, dom.*, api.call) and cannot perform general computation that feeds typed results back into subsequent ops.

Ask (explicit): design a plan that only goes Wasm—no in‑proc native tasks or extra worker binaries—while keeping determinism, safety, and offline‑first.

Ecosystem premise we rely on

- WASI Preview 2 / 0.2.x (component model era) for cross‑language Wasm components via WIT interfaces.
- The Component Model and wit‑bindgen/cargo‑component provide typed bindings across languages (Rust/C/etc.).
- Wasm runtimes (Wasmtime in Tauri) expose portable resource/time limits: fuel metering, epoch‑based interruption, and store limits for memory/tables.
- WASI P2 standard interfaces we’ll lean on: wasi:io/streams, wasi:filesystem, wasi:random, wasi:clocks, optional wasi:http (off by default).

2) Goals

- Pure Wasm execution: every compute task is a WASI P2 component; the host (Tauri/Rust) provides only explicit, capability‑scoped hostcalls.
- Typed contracts end‑to‑end: task inputs/outputs are WIT‑defined, with codegen on host and guest.
- Determinism & replay: job results are content‑addressed; replay re‑applies results without re‑execution (unless invalidated).
- Isolation & least privilege: no ambient FS/NET/time; only declared capabilities via WASI/WIT imports.
- Offline‑first: local modules; no default network.
- Streaming: tasks can emit partial, typed updates using a well‑defined channel compatible with wasi:io/streams.
- DX: one‑command scaffolds for new tasks; golden determinism tests; local dashboard.
- Portability: Win/Mac/Linux parity; modules are cross‑language via Component Model.

Success criteria

- Two exemplar tasks (csv.parse, table.query) run as Wasm components, produce typed results bound into state.*, support cancellation/timeout, and survive kill/replay with identical outcomes.
- Capability violations, timeouts, and OOM are surfaced via a clear error taxonomy (non‑fatal to app).
- Dashboard shows per‑job lifecycle, partials, and resource usage.

3) Non‑Goals

- In‑proc Rust tasks, native worker binaries, or cloud‑first compute.
- UI scaffolds beyond tiny examples needed for interface clarity.
- General purpose scripting from the UI process.

4) Options (Wasm‑only choices)

A. Component Model + Typed WIT per task (strict typing)

- Each task publishes its own WIT package and world; host uses generated bindings.
- Pros: maximal type safety; great DX with cargo‑component/wit‑bindgen.
- Cons: more ceremony per task; WIT evolution must be versioned.

B. Generic “envelope” world (CBOR/JSON bytes)

- Single generic world with run(input: list<u8>) -> result<list<u8>, error>; schemas enforced by host.
- Pros: fastest to onboard; fewer WIT packages.
- Cons: weaker compile‑time typing; shifts validation to host.

C. Hybrid (Recommended)

- Core “system” world (logging/progress/streaming/cancel) + task‑specific WIT for input/output. That gives typed contracts and a stable host API surface.

Runtime choice: Wasmtime embedded in Tauri (mature P2 support, limits, strong Rust API).

5) Recommendation (Wasm‑only)

- Adopt Component Model + Hybrid WIT on Wasmtime:
  - A stable host package `uicp:host` defines progress, logging, cache lookup, cancellation, etc., plus optional capabilities (FS/HTTP/RNG/Clocks) plumbed through WASI P2.
  - Each task ships a typed WIT package `uicp:task/<name>@<semver>` with a single entrypoint.
  - Stream partials via a host‑provided `wasi:io/streams.output-stream`; return final results from `run`.
  - Enforce limits with StoreLimits, fuel, and epoch interruption; make cancellation cooperative + preemptive.
  - Package distribution initially bundled; optional registry later (e.g., Warg/OCI) without changing contracts.

6) Design (HLD)

6.1 Components

- Adapter (Frontend) — unchanged op model; introduces `api.call("compute.call", JobSpec)` & `compute.cancel`.
- Compute Host (Rust/Tauri) — embeds Wasmtime, instantiates components in isolated Stores; provides `uicp:host` and selected WASI imports; enforces limits.
- Module Registry — list of `.wasm` components with metadata (task name, version, digest, capabilities).
- Job Queue + Result Store — persistent FIFO; content‑addressed cache: `H = hash(task, canonical(input), moduleVersion, envHash)`.
- Event Bus — emits `compute.result.partial` and `compute.result.final`.

6.2 Key types (host/TS sketches mirroring WIT per‑task IO)

type JobSpec = {
  jobId: string;           // UUID
  task: string;            // "csv.parse@1.2.0"
  input: unknown;          // validated against task's WIT‑reflected schema
  timeoutMs: number;       // default 30_000
  fuel?: number;           // instruction budget
  memLimitMb?: number;     // linear memory limit
  bind: { toStatePath: string }[];
  cache: 'readwrite' | 'readOnly' | 'bypass';
  capabilities: {
    fsRead?: string[];     // "ws:/data/**" (mapped to wasi:filesystem preopens)
    fsWrite?: string[];
    net?: string[];        // allowlisted origins for wasi:http
  };
  replayable?: boolean;    // default true
  provenance: { envHash: string; agentTraceId?: string };
};

Error taxonomy (terminal): Timeout, Cancelled, CapabilityDenied, Input.Invalid, Task.NotFound, Runtime.Fault, Resource.Limit, IO.Denied, Nondeterministic.

6.3 WIT (host & task)

uicp:host (stable; versioned)

```
package uicp:host@1.0.0

type job-id = string
type blob = list<u8>

interface control {
  // For cooperative cancellation with poll()
  cancel-pollable: func(job: job-id) -> wasi:io/poll.pollable
  // Progress / partials over a host-provided stream
  open-partial-sink: func(job: job-id) -> wasi:io/streams.output-stream
  // Structured logging
  log: func(level: enum { trace, debug, info, warn, error }, msg: string)
}

world system {
  import control
  // Capabilities are provided by selectively wiring:
  import wasi:io/streams
  import wasi:clocks/monotonic-clock
  import wasi:random/random
  // Optional (off by default; allowlist enforced by host):
  // import wasi:filesystem/types
  // import wasi:http/outgoing-handler
}
```

Task WIT (example csv.parse)

```
package uicp:task-csv-parse@1.2.0

interface task {
  type Input = record { source: string, has-header: bool }
  type Output = list<record { cols: list<string> }>
  run: func(job: uicp:host/job-id, input: Input) -> result<Output, string>
}

world entry {
  import uicp:host/system
  export task
}
```

Guests use `uicp:host/control.open-partial-sink` to stream typed CBOR/JSON chunks to the host via `wasi:io/streams`.

6.4 Sequence (async, streaming, bind)

- Agent → `api.call("compute.call", JobSpec)` → Adapter → persist
- Adapter → enqueue → JobQueue → dispatch → Compute Host
- Host: lookup module, verify digest/capabilities, instantiate Store (limits, fuel, epoch), provide imports + partial sink, call `task.run(jobId, input)`
- Guest: write progress/partials to output‑stream; cooperatively check cancel‑pollable; return final Output
- Host: emit `compute.result.partial`; on final Ok/Err: `compute.result.final` → Adapter
- Adapter: apply bindings (state.set), persist envelope, update status

6.5 Determinism & Idempotency

- Cache key: `hash(task,input,moduleVersion,envHash)`; identical jobs reuse cached result.
- No ambient time/RNG: use host‑provided monotonic clock and seeded random; seeds persisted in JobSpec.
- FS & HTTP: off by default; if enabled, host proxies and records request/response digests for audit. `wasi:http` wired only for allowlisted origins.

6.6 Isolation & Limits

- Time: epoch‑based interruption for hard deadlines (preemptive); cooperative cancel via cancel‑pollable.
- CPU: fuel metering; trap when depleted.
- Memory: per‑Store linear memory limit via StoreLimits; hard cap traps; surface peak usage.
- Instances/Tables: Store limits constrain resource creation.

6.7 Observability hooks

- Capture stdout/stderr (via wasi:cli if used) and structured `uicp:host.log`.
- Attach spans {jobId, task, version, driver:"wasmtime"}; child spans for FS/NET hostcalls.
- Surface CPU ms (from fuel), mem peak (from store limits), cache hits.

6.8 Packaging & Integrity

- Bundled components with `[name]@[semver].[sha256].wasm` + manifest.
- Optional future: fetch from Warg/OCI (signed digests) while staying offline‑default.

6.9 Timeouts & Budgets v1

Decision: Defaults (v1)

- Hard wall‑clock timeout: 30,000 ms for every job unless explicitly overridden.
- Concurrency cap: 2 jobs running at once (queue the rest).
- Memory cap (linear memory per job): 256 MB default.
- CPU metering: Off by default (use wall‑clock timeout first; enable fuel only for misbehaving tasks or third‑party modules).
- Network: OFF by default.
- Filesystem: workspace‑scoped allowlist only.

These are deterministic because they’re constants, not environment‑dependent.

Overrides (tight and explicit)

Knob / Allowed Range / Requires Flag
- timeoutMs: 1,000–120,000; ≤30,000: none; >30,000: cap.longRun
- memLimitMb: 64–1024; >256: cap.memHigh
- concurrency (global): N/A; Operator setting only
- net: allowlisted origins; cap.net + host allowlist
- fsRead/fsWrite: specific ws:/… globs; Declared in JobSpec

If the job asks for more than policy allows, it is rejected up front with Compute.CapabilityDenied.

Semantics (how timeouts actually behave)

- Hard deadline: At timeoutMs, the runtime traps the job (preemptive). Result is terminal with status="timeout".
- Graceful cancel: If the user cancels, we signal cancel immediately and give the guest 250 ms grace; then hard‑stop if still running.
- Progress keep‑alive: Not required for correctness. We do not kill a job for “no partials”. (Some legit compute is quiet.)
- Replay safety: A timeout is a terminal error we replay as an error (we don’t re‑run on startup).

Tiers (so people choose sane timeouts)

- Interactive (UI feel‑good): ≤2s
- Standard (default): ≤30s
- Long‑run (opt‑in): ≤120s, needs cap.longRun

If a task routinely needs >30s, it must document why and request cap.longRun; otherwise it’s a smell and we push back.

Minimal API (no extra jargon)

```
type JobSpec = {
  jobId: string;
  task: string;                // "csv.parse@1.2.0"
  input: unknown;
  bind: { toStatePath: string }[];
  timeoutMs?: number;          // default 30000; max 120000 with cap.longRun
  memLimitMb?: number;         // default 256; max 1024 with cap.memHigh
  capabilities?: {
    fsRead?: string[];
    fsWrite?: string[];
    net?: string[];            // exact origins, if allowed
    longRun?: boolean;         // request >30s
    memHigh?: boolean;         // request >256MB
  };
  cache?: 'readwrite' | 'readOnly' | 'bypass';
  replayable?: boolean;        // default true
  provenance: { envHash: string; agentTraceId?: string };
};
```

Failure codes you’ll see:

- Compute.Timeout (hit the hard deadline)
- Compute.CapabilityDenied (asked for more than policy)
- Compute.Resource.Limit (blew the mem cap)

Why 30s is the right default

- Human‑scale: Users tolerate up to ~30s if they see “working”; beyond that it feels stuck.
- Engineering‑scale: Keeps long‑running/abusive tasks from burning your laptop; anything needing more must be designed intentionally.
- Determinism: Fixed constant → same behavior across machines, avoids “it worked on mine in 45s”.

Test checklist (fast, actionable)

- Unit: ensure timeoutMs default applied when omitted; rejection when timeoutMs>30000 without cap.longRun.
- Integration: synthetic busy‑loop job dies at ~30s with Compute.Timeout; cancel works within ~250ms grace.
- Replay: a timed‑out job replays as error; UI state is identical after restart.
- Perf: two concurrent 30s jobs do not exceed process CPU/mem budgets; third is queued.

Dashboard nudges (quality of life)

- Show a pill next to each job: Interactive, Standard, Long‑run.
- If a module asks for cap.longRun or cap.memHigh, show a small shield icon and tooltip (why + who approved).

Where we won’t get fancy (yet)

- No auto‑scaling timeouts “by input size” — that risks non‑determinism.
- No per‑op adaptive budgets — same reason; complexity without clear payoff.

Worth exploring—backlog it. Finish the default policy first.
```

7) Rollout (Wasm‑only)

- Phase 0 — Contracts + Host skeleton (1–2 sprints)
  - Land JobSpec/JobResultEnvelope, error taxonomy, and adapter materialization.
  - Implement Wasmtime embed: epoch + fuel + store limits; `uicp:host` world; result cache.
  - Local dashboard MVP: job list, statuses, last errors.

- Phase 1 — MVP tasks & streaming (1–2 sprints)
  - Ship `csv.parse` and `table.query` components (Rust with cargo‑component) using typed WIT; stream progress via `wasi:io/streams`.
  - Bindings generator in build to produce TS types for inputs/outputs from WIT.

- Phase 2 — Capabilities & policies (2 sprints)
  - Wire `wasi:filesystem` (workspace‑scoped preopens) and enforce path allowlists.
  - Optional `wasi:http` behind per‑job allowlist + recording.
  - Secrets remain opaque handles (no plain strings in Wasm).

- Phase 3 — Distribution & DX (ongoing)
  - Module registry UI; version pinning; content‑addressed cache browser.
  - Optional Warg/OCI client for signed module updates (disabled by default).

Rollback: Contracts are independent of engine internals; if a module misbehaves, disable it via manifest policy without changing the host.

8) Risks & Mitigations

- Tooling churn in WASI P2/Component Model → pin to WASI 0.2.x, gate upgrades behind golden tests.
- Streaming complexity across the component boundary → standardize on `wasi:io/streams.output-stream` for partials with CBOR schemas; honor backpressure.
- Performance overhead vs native → cache aggressively; prefer zero‑copy buffers; use epoch for low‑overhead deadlines.
- Memory accounting gaps → combine StoreLimits with RSS sampling; trap on limits and mark `Resource.Limit`.
- Developer friction (WIT per task) → templates (cargo component new uicp-task), WIT→TS typegen.

9) Observability

- Logs: structured per job (queued/running/partial/final), capability usage, cache events; redact inputs by default.
- Metrics: `jobs_running`, `jobs_completed_total{status}`, `job_duration_ms` p50/p95/p99, `cache_hit_ratio`, `fuel_used`, `mem_peak_mb`.
- Traces: span `job:<task>` (driver, version, inputHash); child spans for FS/HTTP calls.
- Dashboard: live job table; inspect envelopes; show partials stream; top tasks by duration.

10) Testing

- Unit (guest & host): guest logic with table‑driven tests; WIT conformance; host capability gating, limit enforcement, error taxonomy.
- Contract: golden tests `(input, seed, envHash) → outputHash` for each module; run twice to prove determinism. Schema round‑trip: WIT ↔ generated TS types.
- Integration: e2e agent→adapter→host→component→partials→final→bind→replay. Kill tests, capability violations, timeouts, OOM.
- CI gates: “No secret strings” linter; determinism gate; coverage thresholds; WASI P2 version pinning check.

10.1 Shakedown Tests (must pass in CI)

- Kill and replay: kill mid-job, restart, result is terminal with no state corruption.
- Timeout and cancel: job hits 30s default and returns Compute.Timeout; user cancel finishes within 250 ms.
- Determinism: same input twice → identical output hash and identical state ops.
- Capability fences: attempt net or out-of-scope fs returns IO.Denied (no host crash).
- Resource abuse: mem hog traps at limit; app stays responsive.
- Cache poisoning: flip a byte in cached result → host detects mismatch and either recomputes or errors per policy.
- Redaction: logs contain no secrets or full paths outside workspace.
- Cross-platform triplet: same suite passes on Windows, macOS, Linux.

10.2 Owner Acceptance Criteria

- The 6 invariants (below) are enforced in code, not just docs.
- The 8 shakedown tests run in CI and must pass to merge.
- Dashboard shows per job status, duration, mem peak, cache hit, and last error.
- Defaults: 30s timeout, 256 MB per job, 2 concurrent jobs, net off, fs allowlist only.

6.10 Non‑Negotiables (Locked v1)

- State-only bindings: compute can only write to `state.*` via bindings. No arbitrary UI ops.
- Default deny: net off, fs limited to workspace allowlist, secrets never serialized.
- Determinism guard: seeded RNG hostcall, logical clock only, content-addressed results, strict version pin on each module.
- Isolation limits: Wasmtime store memory cap, hard timeout with epoch interrupt, optional fuel for bad actors.
- Signed modules: every module has a digest and signature; manifests pin to digest; cache verifies before use.
- Replay contract: on restart we reapply persisted results; we do not re-run jobs unless explicitly invalidated by input or version.

11) Open Questions (Spikes)

- Partial message schema: WIT “stream” types are early; use `wasi:io/streams` + CBOR for now; validate size & backpressure.
- Cancellation UX: frequency of cancel‑pollable checks vs epoch interruption; measure overhead.
- HTTP surface: standardize wasi:http subset (client‑only).
- Registry: Warg vs OCI first; prototype both.
- Language support: WASI SDK for C/C++; quantify perf deltas for CSV parsing.

12) Minimal Examples (clarifying interfaces)

Frontend ops

```
[
  { "api.call": { "name": "compute.call", "args": {
      "jobId": "f24a1b1e-7b2b-4f3b-9256-4b0905f91151",
      "task": "csv.parse@1.2.0",
      "input": { "source": "ws:/files/sales.csv", "hasHeader": true },
      "bind": [{ "toStatePath": "/tables/sales" }],
      "timeoutMs": 30000,
      "capabilities": { "fsRead": ["ws:/files/**"] },
      "provenance": { "envHash": "abc123" }
  }}}
]
```

Guest (Rust with cargo‑component) — export `run(job, input)`; stream partial progress via host sink; return final rows.

Host — map partial CBOR chunks to `compute.result.partial` events; on final Ok, apply `state.set("/tables/sales", rows)`.

13) Bottom line

This Wasm‑only path is viable and future‑proof, front‑loading componentization, WIT discipline, and streaming. The plan keeps contracts stable, uses WASI P2 + Wasmtime, and leaves room to grow (registries, more languages) without rip‑and‑replace.

14) Timeline & Reassessment

- V1 scope: host skeleton, compute.call, compute.cancel, result cache, 2 tasks (csv.parse, table.query), dashboard v1.
- Start: 2025-10-15. Code freeze: 2025-11-30.
- Reassessment of WASI P2 tooling: 2025-12-15. If breaking changes land, pin and defer upgrades.
- V2 scope: FS preopens, HTTP allowlist, golden determinism tests expanded, policy toggles.
- If that timeline is tight, reduce to one task in V1 and ship surfaces first.
- Recovery Playbook

Automated attempts (in order)
- Reindex: rebuild SQLite indices and run `PRAGMA integrity_check`.
- Compact log: drop trailing incomplete segment after the last checkpoint, then retry replay.
- Roll back to last valid checkpoint snapshot, then apply log from that point.
- If replayable jobs are missing terminal results, re-enqueue them; otherwise mark as stale.

User choices
- Restore from checkpoint X (recommended).
- Export diagnostics bundle (sanitized log tail + integrity report).
- Start fresh workspace (keeps files in `ws:/files`, resets state and log).
