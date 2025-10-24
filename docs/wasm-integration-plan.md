# UICP WASM Plane Refactor

Policy-enforced, first-class provider integration. This turns the WASM plane from a utility into a production provider with clear security, performance, and DX.

## Executive summary

* The WASM plane becomes a routable provider alongside LLM and local.
* Provider selection is policy-owned, not model-owned.
* Capability tokens are minted and verified by the host.
* Caching moves to explicit input manifests with determinism tagging.
* Observability, failure taxonomy, and backpressure are wired end to end.
* Two production workloads migrate first: patch.summarize and metrics.aggregate.

## Terminology and normative keywords

- MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are as defined in RFC 2119 and RFC 8174.
- Provider: execution backend selected by the router (llm, local, wasm).
- Module: a versioned WebAssembly component implementing `uicp:compute/job`.
- Deterministic: fixed inputs and environment produce identical outputs and side effects.
- Golden: expected output hash recorded for a given `goldenKey`.

## Objectives and non-negotiables

* Respect WASI isolation and Component Model contracts at all times.
* Host decides capabilities. Models provide hints only.
* No network, no time, no random by default.
* Deterministic results are cacheable. Non-deterministic results are not unless policy says so.
* Single function in, single function out. JSON payloads. No side channels.

## Scope

In scope:

* Router changes, host tokens, cache v2, determinism, backpressure, metrics, registry enforcement, DX CLI, two module migrations, UI surfacing.
  Out of scope right now:
* Cross-tenant remote module registry sync, WASM debugging UI, distributed sandboxes.

## Master execution checklist

- [x] Phase 0: Recon and anchors
- [x] Phase 1: Provider router and policy (TS)
- [x] Phase 2: Capability tokens (Rust+TS)
- [x] Phase 3: Cache v2 + determinism (v2_plus with modsha/modver/world/abi/policy invariants wired; wasmtime_major pending)
- [x] Phase 4: WIT world finalize + hostcall gating (time/random denied by policy; RNG deterministic; net not exposed; preflight import policy enforced)
- [x] Phase 5: Registry enforcement + trust store (trust store + keyid support; strict mode + UI surfacing; CI signature gate)
- [~] Phase 6: Observability (failure taxonomy, SLOs) + Backpressure UI (banner + determinism/backpressure chips in place)
- [x] Phase 7: Fair scheduling (wasm_sem separate from compute_sem; UICP_WASM_CONCURRENCY env cap)
- [ ] Phase 8: DX CLI
- [ ] Phase 9: Migrate modules (patch-tools, metrics-agg)
- [~] Phase 10: CI gating + rollout (verify-modules: import-policy + signature gating landed; staged rollout pending)
- [ ] Documentation updates

## Current state snapshot

* Wasmtime host with WIT bindings, quotas, timeouts, fuel, and provenance.
* Registry with sha256 and optional Ed25519 signatures.
* Compute cache v1: `v1|task|env|input_json_canonical`.
* Compute cache v2 (initial, gated): `v2|task|env|input_json_canonical|manifest(ws:/files blake3)`.
* Job lifecycle with queue and metrics.
* UI stubs: ComputeDemoWindow, ModuleRegistryWindow.

## What landed in this pass

* Router wired on the frontend (operation-style tasks without `@` route to WASM modules); moduleId tasks remain unchanged.
* `provider_decision` telemetry emits before dispatch to aid rollout and audits.
* Capability tokens v1 (HMAC) minted in Tauri and optionally enforced by the host (env-gated).
* Cache v2 groundwork (input manifest with ws:/files content hashing) + env switch for lookup/store.
* Determinism metrics: `outputHash`, optional `goldenHash`, `goldenMatched` on success payloads; golden cache stored/verified when `goldenKey` is provided.
* Tauri Cargo defaults now include `wasm_compute` and `uicp_wasi_enable` features so the WASM provider ships in prod by default.
* New CI workflow step runs `wit-component wit` to enforce import-surface policy: forbid `wasi:http` and `wasi:sockets`; require `wasi:logging` for observability.
* Module verification script upgraded to verify Ed25519 signatures using a trust store (`UICP_TRUST_STORE_JSON`) when `STRICT_MODULES_VERIFY=1`.
* `verify-modules.yml` sets `STRICT_MODULES_VERIFY=1` and enforces signatures (single-key or trust store) on every PR touching modules.
* `.env.example` updated with secure-compute flags: `UICP_CACHE_V2`, `UICP_REQUIRE_TOKENS`, `STRICT_MODULES_VERIFY`, `UICP_TRUST_STORE_JSON`, `UICP_WASM_CONCURRENCY`.
* Blocking backpressure quotas implemented for guest stdout/stderr, partial events, and wasi logging; no drops. Streams block in ~10 ms intervals until tokens are available; throttle counters are recorded. Defaults: stdout+stderr 256 KiB/s (burst 1 MiB), logger 64 KiB/s, partial events 30/s.

## Phase 0 - Recon anchors (done)

- Compute host: uicp/src-tauri/src/compute.rs. Wasmtime host, quotas, backpressure, partial/log streams, rate limiters.
- Dispatch and cache: uicp/src-tauri/src/commands.rs. Policy gate, cache lookup (readwrite/readonly), concurrency semaphore, spawn job.
- Cache API: uicp/src-tauri/src/compute_cache.rs. Canonicalization, v1 key. Target: cache v2 with input manifests, determinism.
- Registry: uicp/src-tauri/src/registry.rs. Modules dir, bundled install, digest verification, signature enforcement, preflight and contract verification.
- Policy types: uicp/src-tauri/src/policy.rs. ComputeJobSpec, capabilities, provenance. Extend with token and determinism metrics.
- UI surfaces: AgentTraceWindow.tsx, MetricsPanel.tsx, ModuleRegistryWindow.tsx. Add provider column, wasm metrics, backpressure banner.
- LLM orchestration: uicp/src/lib/llm/orchestrator.ts (LLM path). WASM routing will be host-owned via router, not model-owned.

## Target architecture at a glance

```
Planner (hint) -> Router policy -> Provider decision -> Executor
                                      |                |
                                 LLM provider      WASM provider
                                                       |
                                             Wasmtime host + WIT
                                                       |
                                            FS jail + quotas + tokens
```

## Standards and compliance

- WebAssembly Component Model and WASI Preview 2 compliant modules.
- Wasmtime pinned and recorded with SBOM; pooling allocator and memory limits enabled.
- Import-surface policy enforced in CI: forbid `wasi:http` and `wasi:sockets`; require `wasi:logging`.
- Network access, if allowed, occurs only via the host `http_fetch` shim and is controlled by capability tokens and the in-app network guard (loopback allowed by default; private ranges blocked unless allow-listed).
- Supply chain: Ed25519 signatures required outside dev; trust store with key IDs; optional Sigstore/cosign attestations accepted when provided.
- Reproducible builds: containerized builder image digest recorded; deterministic outputs required for cacheable modules.

## Provider policy gate

* New router that accepts an operation and parameters and produces a ProviderDecision.
* Decisions are host-owned. The model can suggest a provider but cannot mint power.
* Decisions include moduleId, explicit capabilities, limits, inputs, cache mode, workspaceId, policyVersion.

### Typescript shapes (authoritative interface)

```ts
export type ProviderHint = "local" | "llm" | "wasm";

export type ProviderDecision =
  | { kind: "local" }
  | { kind: "llm"; model: string }
  | {
      kind: "wasm";
      moduleId: string;
      capabilities: CapabilitySet;
      limits: ResourceLimits;
      inputs: string[];
      cacheMode: "readwrite" | "readonly" | "bypass";
      workspaceId: string;
      policyVersion: string;
    };

export type CapabilitySet = {
  fsRead?: string[];
  fsWrite?: string[];
  net?: string[];
  env?: string[];
  time?: boolean;
  random?: boolean;
};

export type ResourceLimits = {
  memLimitMb?: number;
  timeoutMs?: number;
  fuel?: number;
};
```

## Host capability tokens

Tokens v1 (implemented, operator-managed):

* Host mints an HMAC-SHA256 token over `{jobId, task, workspaceId, envHash}`.
* Token travels with the `JobSpec` and is verified before execution when enforcement is enabled.
* Enforcement is disabled by default and is operator-managed. Enable via `UICP_REQUIRE_TOKENS=1` in production deployments. Packaging does not auto-enable this.
* Operators should set a stable 32-byte hex key via `UICP_JOB_TOKEN_KEY_HEX` for continuity across restarts. If unset, the host generates an ephemeral random key at boot (tokens from previous runs will not verify).

Planned for v2 (future):

* Expand token payload to include `capabilities`, `limits`, `policyVersion`, and a short-lived `exp`, then enforce strict match on host.

## Cache v2 and determinism

Implemented (initial v2):

* Replace implicit workspace hashing with explicit input manifests (ws:/files traversal).
* Cache key: `v2|task|env|input_json_canonical|manifest(ws:/files blake3)`.
* Env flag: `UICP_CACHE_V2=1` toggles both lookup and store to v2 keys.

Implemented extensions (current):

* Cache key now uses `compute_key_v2_plus(spec, input, invariants)` where invariants = `modsha=<digest>|modver=<version>` when task resolves to a module.
* Lookup and store paths consistent (main.rs + compute.rs).

Planned extensions (future):

* Add `policy_ver`, `host_abi`, `wit_world`, `wasmtime_major` into invariants string.

Determinism rules:

  * Using time or net or unseeded random flips deterministic=false.
  * deterministic=false forces cache bypass unless policy allows.
* Result metrics carry `outputHash` and (when golden expected) `goldenHash`, `goldenMatched`.

Golden cache:

* On first successful run with `goldenKey`, store `outputHash`.
* On subsequent runs, verify equality; mismatch flips `goldenMatched=false` and emits a `replay-issue` event; UI may enter Safe Mode.

## Environment flags

* `UICP_REQUIRE_TOKENS=1` — enforce job token verification (operator-managed; recommended for production).
* `UICP_JOB_TOKEN_KEY_HEX=<64 hex>` — operator-managed fixed 32-byte HMAC key; if unset, a random ephemeral key is generated at boot.
* `UICP_CACHE_V2=1` — use v2 cache key (with invariants) for lookup and store.
* `UICP_WASM_CONCURRENCY=<1..64>` — WASM provider concurrency cap (default 2); separate from generic compute_sem.
* `UICP_WASM_PROVIDER=0|1` — runtime kill switch for routing to the WASM provider. Defaults to 1 in production builds; set to 0 to disable and route to alternative providers.

Notes:

- Flags are read at startup; changing them requires an app restart to take effect.
- Security posture defaults: tokens are operator-managed and may be disabled in dev; signatures are required when `STRICT_MODULES_VERIFY=1`.

## Backpressure and log quotas

* Blocking token-bucket quotas for logs and events (guest stdout/stderr, partial events, wasi logging).
* Streams block in small (~10 ms) intervals until tokens are available; no drops. Throttle counters increment for observability.
* Defaults (tunable): stdout+stderr 256 KiB/s with 1 MiB burst; logger 64 KiB/s; partial events 30/s.
* UI shows a red "backpressure active" banner.

## Failure taxonomy and SLOs

* Reasons: ExecTimeout, FuelExhausted, MemLimit, CapabilityDenied, HostPanic, ModulePanic, BackpressureDrop, SignatureRequired, SignatureInvalid.
* SLOs: latency p50 and p95, failure rate, cache hit ratio, determinism ratio.

## Fair scheduling

* Weighted fair queue per provider and per tenant.
* Concurrency caps per provider. Prevents head of line blocking.
* Implemented: `wasm_sem` separate from `compute_sem`; module tasks route to `wasm_sem` (env: `UICP_WASM_CONCURRENCY`, default 2).

## Registry enforcement

* Signatures required in non-dev. Trust store with key ids and rotation.
* Dev mode can allow unsigned; host emits a `registry-warning` event that is surfaced as a toast.
* Env flags:
  * `STRICT_MODULES_VERIFY=1` — require Verified signature for all modules.
  * `UICP_MODULES_PUBKEY` — single Ed25519 pubkey (base64 or hex) for signature verification.
  * `UICP_TRUST_STORE` — path to JSON object of `{ keyid: pubkey }` (base64 or hex).
  * `UICP_TRUST_STORE_JSON` — inline JSON object for trust store (overrides file).
* When `keyid` is present in manifest entry, trust store is used; otherwise fallback to `UICP_MODULES_PUBKEY`.
* UI: ModuleRegistryWindow displays strict mode and trust store source (inline/file/single_key/none) as header chips.

## WIT world for compute jobs

```wit
package uicp:compute

interface host {
  log: func(level: string, msg: string)
  read_file: func(path: string) -> result<list<u8>, string>
  write_file: func(path: string, data: list<u8>) -> result<(), string>
  list_dir: func(path: string) -> result<list<string>, string>
  monotonic_millis: func() -> u64
  http_fetch: func(url: string, method: string, body: list<u8>) -> result<list<u8>, string>
}

world job {
  import host
  export run: func(spec_json: string) -> result<string, string>
}
```

* Minimal surface. JSON in, JSON out.
* Capability tokens gate host calls (future v2). Default denies net and write; time-of-day and unseeded random are not exposed.
* RNG host is deterministic (seeded from job+env) and considered safe; true random/time APIs remain absent until explicitly introduced and gated.

## UI updates

* AgentTraceWindow shows provider column with values local, llm, wasm.
* MetricsPanel shows provider wasm stats and cache hit rate.
* ComputeDemoWindow replaced by a generic Module Runner that can run any installed module with JSON input and show logs and metrics.
* ModuleRegistryWindow: list, enable, disable, verify signatures, show provenance.

## DX CLI

* `uicp mod init --lang rust --name uicp/patch-tools` — create a template with `uicp:compute/job` world and stub `run`.
* `uicp mod build --platform wasi-preview2 --wit uicp:compute/job --out dist/ --sbom spdx-2.3.json --provenance attest.json` — containerized, reproducible build. Outputs `.wasm` and manifest (sha256, limits).
* `uicp mod run --module dist/patch-tools.wasm --input input.json` — execute locally via the host; prints result JSON and `outputHash`.
* `uicp mod publish --registry ws:/modules --sign key.pem --keyid dev-2025` — sign and publish to the local registry with key id recorded.

Example build output (truncated):

```text
✓ Built uicp/patch-tools@1
sha256: 2f5c...9a
limits: { memoryMb: 64, timeoutMs: 5000 }
sbom: dist/spdx-2.3.json
provenance: dist/attest.json
```

## Migration targets and payoffs

1. patch.summarize and patch.normalize - high frequency, deterministic, tiny runtime.
2. metrics.aggregate - deterministic post processing of event streams.
3. js.validate - AST checks without giving the renderer Node access.
4. manifest.build - assemble QuickJS and related script manifests in sandbox.

## Router policy map

* Map operations to provider decisions inside trusted code. Planner hints are advisory only.
* Default is local. LLM is only for natural language tasks. WASM is for deterministic transforms and validations.

## Windows path hygiene

* Normalize to POSIX form in inputs. Lowercase where appropriate.
* Reserved names list: CON, PRN, AUX, NUL, COM1..COM9, LPT1..LPT9.
* CI check to reject reserved names in module inputs and outputs.

## CI and gating

* Refuse unsigned modules in non-dev builds. CI fails if unsigned or signature invalid (Node verifier with Ed25519 trust store).
* Enforce import-surface policy in CI using `wit-component` for all shipped components:
  * Forbid `wasi:http` and `wasi:sockets`.
  * Require `wasi:logging` import for baseline observability.
* Run golden tests for each module with deterministic outputs.
* Mutation tests for policyDecide mapping.
* Wasmtime version pin with SBOM and license checks.

## Validation and testing

- Unit: `policyDecide` mapping, cache key invariants, token mint/verify.
- Integration: sandboxing (FS jail), quotas, capability denials, fair scheduling.
- Golden: per-module vectors with `outputHash` verification and `goldenMatched`.
- Property: determinism under input reordering and repeated runs.
- Fuzzing (optional): WIT JSON inputs and boundary behaviors.
- Performance: enforce p50/p95 latency and resource budgets in CI.

## Security model

* FS jail at a per-job workspace root only.
* No absolute paths, no symlinks outside the jail.
* Network egress denied by default. If allowed, only whitelisted domains.
* Time API denies by default or returns a fixed epoch for deterministic mode.
* Random must be seeded when allowed. Otherwise denied.

## Observability and metrics

* Counters: wasm.jobs.started, completed, failed, timeout, killed.
* Timers: wasm.exec.ms p50, p95, p99.
* Resources: wasm.mem.peak_mb, wasm.fuel.used.
* Cache: wasm.cache.hit_ratio, wasm.cache.evictions.
* Security: wasm.modules.unsigned_runs, wasm.capability.denials.
* Determinism: wasm.results.deterministic_ratio.

### Structured logs (NDJSON)

Fields: `ts`, `level`, `code`, `jobId`, `module`, `provider`, `span`, `msg`, `ctx`.

Example:

```json
{"ts":"2025-01-23T18:42:01.234Z","level":"ERROR","code":"E-UICP-0203","jobId":"j_abc","provider":"wasm","module":"uicp/patch-tools@1","span":"exec","msg":"Exec timeout","ctx":{"timeoutMs":5000}}
```

### Error codes

Use repo-wide prefix `E-UICP-####`. Map to failure taxonomy:

- E-UICP-0201 CapabilityDenied
- E-UICP-0202 MemLimit
- E-UICP-0203 ExecTimeout
- E-UICP-0204 FuelExhausted
- E-UICP-0205 BackpressureDrop
- E-UICP-0206 SignatureRequired / SignatureInvalid

### Tracing

OpenTelemetry spans around `policyDecide`, `cache.lookup`, `exec`, and `cache.store`. Propagate `traceId` into module logs via the `log` capability.

## Rollout plan

* Phase 0 (dev only): behind `UICP_WASM_PROVIDER=1`. Observe for 48–72 hours.
* Canary (10% sessions): promote when all hold for 48 hours:
  * Failure rate (non-cancel) < 1.0% overall and < 0.5% for deterministic jobs
  * Determinism ratio ≥ 95%
  * Cache hit ratio ≥ 60% for eligible jobs
  * p95 latency ≤ 1.5x baseline local provider
  * Backpressure banner occurrence < 0.5% of jobs
* Ramp: 10% → 50% → 100% with the same gates at each step.
* Rollback: set `UICP_WASM_PROVIDER=0` and restart. Cache can be bypassed via `cacheMode: "bypass"` in `ProviderDecision` for emergency runs.

## Fire drills

* Log flood: verify blocking behavior (no drops), throttle counters increment, and UI banner.
* Capability denial: verify reason and metric.
* Timeout: verify kill and cleanup.
* Memory blowup: verify termination and no leaks.

## 7 day sprint plan

Day 1 - Router and tokens (done)

* policyDecide and routing (operation → WASM) implemented; telemetry added.
* HMAC job tokens and host-side enforcement (env-gated) implemented.
* policyVersion tracking deferred to token v2.

Day 2 - Cache v2 and determinism (in progress)

* Input manifests and file hashing implemented in v2 key (env-gated).
* Determinism tracking (outputHash + golden verification) implemented.
* Key extensions: modsha/modver wired in compute_key_v2_plus; host_abi, wit_world, wasmtime_major — pending.
* UI: Determinism ratio, golden verification, and backpressure chips in MetricsPanel.

Day 3 - First module

* Port patch.summarize to uicp/patch-tools@1 with golden tests.
* Policy maps patch operations to this module.

Day 4 - UI and metrics

* Provider column in AgentTraceWindow.
* MetricsPanel for wasm. Backpressure banner.

Day 5 - Second module

* Port metrics.aggregate to uicp/metrics-agg@1. Add tests.
* Enforce signatures outside dev. Add registry trust store.

Day 6 - DX and perf

* Containerized builder. `uicp mod init|build|run|publish`.
* Wasmtime pooling allocator on. AOT cache by sha.
* Pre-instantiate pool for hot modules.

Day 7 - Policy hardening and drills

* Fair scheduling per tenant and provider.
* Kill switch. Fire drills. Write ADR and runbook.

## Definition of done

* Router sends real work to provider wasm for at least two production paths.
* Removing the WASM plane breaks patch summaries and metrics aggregation.
* Determinism and cache hit ratio visible in MetricsPanel.
* Capability tokens enforced by host. Unsigned modules rejected in non-dev.
* Backpressure visible in UI. Failure taxonomy present in logs and metrics.
* DX CLI builds a template module and runs it end to end.

## Remaining checks before full rollout

- Observability completeness
  - Wire SLO thresholds (failure rate, determinism ratio, cache hit ratio, p95 latency) into dashboards.
  - Ensure tracing spans cover policyDecide, cache.lookup/store, exec, and surface `traceId` in module logs.
- Cache v2 invariants
  - Extend invariants to include `policy_ver`, `host_abi`, `wit_world`, `wasmtime_major`; validate key stability across releases.
- Token enforcement
  - Enable `UICP_REQUIRE_TOKENS=1` via operator environment (do not auto-enable in packaging); verify denial paths and metrics. Provide `UICP_JOB_TOKEN_KEY_HEX` for stable HMAC.
- Module golden tests
  - Add golden vectors for `uicp/patch-tools@1` and `uicp/metrics-agg@1`; validate determinism and mismatch surfacing.
- Module migrations
  - Port `patch.summarize`/`patch.normalize` and `metrics.aggregate` to WASM components with tests.
- Fair scheduling validation
  - Load-test `wasm_sem` vs `compute_sem` isolation; confirm head-of-line protection.
- CI gating and staged rollout
  - Keep import-surface checks via `wit-component`; finalize canary gates and promotion criteria in CI.
- DX CLI
  - Ship `uicp mod init|build|run|publish` with containerized, reproducible builds and provenance SBOMs.
- Documentation
  - Update README/architecture docs to reflect provider router, tokens, cache v2, and module lifecycle.

## PR breakdown and checklist

PR 1 - Router and policy

* routeStep with wasm branch
* policyDecide mapping
* StepResult carries provider and reason
* Tests for deny by default

PR 2 - Host tokens and cache v2

* HMAC token mint and verify
* Cache key v2 with inputs and versions
* Determinism tracking
* Tests for cache misses and bypass

PR 3 - patch-tools module

* WIT interface and Rust module
* Golden tests
* Policy mapping

PR 4 - UI and metrics

* Provider column in AgentTraceWindow
* MetricsPanel wasm stats
* Backpressure banner

PR 5 - metrics-agg module

* Module with tests
* Signature enforcement
* Trust store

PR 6 - DX and performance

* Containerized builder and CLI
* Wasmtime pooling, AOT cache, pre-instantiate pool

## ADR template

Title: Make WASM a first-class, policy-enforced provider
Context: Model-chosen providers allowed capability escalation. Caching was coarse. Isolation claims were not enforced end to end.
Decision: Router owns provider selection. Host mints and verifies capability tokens. Cache v2 with input manifests and determinism tagging. Signatures enforced outside dev.
Consequences: Deterministic, cacheable compute with clear boundaries and metrics. Slight complexity increase in router and host. DX improves with templates and builder.

## Operational runbook

Rollback

- Set `UICP_WASM_PROVIDER=0` and restart the app to route away from WASM.
- For a single job, set `cacheMode: "bypass"` in `ProviderDecision` to avoid cache effects.

Incident triage

- Check MetricsPanel for spikes in failure rate, determinism ratio, backpressure.
- Inspect logs filtered by `provider=wasm` and error codes `E-UICP-02xx`.
- Verify registry strict mode and trust store health; reject unsigned modules.
- Kill runaway jobs via host timeout; inspect memory/fuel counters.

Safety checks

- Disable `http_fetch` in host if data exfiltration is suspected; validate in-app network guard allow-list.
- Switch cache to v1 or disable via `UICP_CACHE_V2=0` if cache-related incidents occur.

## Appendix A - Failure reasons

ExecTimeout, FuelExhausted, MemLimit, CapabilityDenied, HostPanic, ModulePanic, BackpressureDrop, SignatureRequired, SignatureInvalid.

## Appendix B - Metrics list

wasm.jobs.started, wasm.jobs.completed, wasm.jobs.failed, wasm.jobs.timeout, wasm.jobs.killed, wasm.exec.ms, wasm.mem.peak_mb, wasm.fuel.used, wasm.cache.hit_ratio, wasm.cache.evictions, wasm.modules.unsigned_runs, wasm.capability.denials, wasm.results.deterministic_ratio.

## Appendix C - Module manifest example

```json
{
  "name": "uicp/patch-tools",
  "version": "1.0.0",
  "wit_world": "uicp:compute/job",
  "capabilities": ["log"],
  "limits": { "memoryMb": 64, "timeoutMs": 5000 },
  "sha256": "...",
  "signatures": [
    { "alg": "ed25519", "keyid": "dev-2025", "sig": "..." }
  ],
  "sbom": "spdx-2.3.json",
  "licenses": ["Apache-2.0"],
  "provenance": {
    "builder_image": "ghcr.io/uicp/builder@sha256:...",
    "built_at": "2025-01-23T18:40:00Z",
    "reproducible": true
  },
  "tests": [
    { "input": { "diff": "..." }, "expect": { "files_changed": 3 } }
  ]
}
```

## Appendix D - Path normalization

* Normalize to forward slashes.
* Reject reserved Windows device names.
* Reject absolute paths and path traversal.

## Appendix E - Threat model summary

* Threat: LLM escalates privileges. Mitigation: policyDecide and host tokens.
* Threat: Cache poisoning. Mitigation: input manifests, versioned keys, determinism tag.
* Threat: Data exfil via net. Mitigation: net cap off by default, whitelist domains only.
* Threat: Resource exhaustion. Mitigation: quotas, fuel, timeouts, fair scheduling, backpressure.
* Threat: Supply chain. Mitigation: signatures required, trust store, provenance.

Ship the router and the first module, then lock the rest behind the flag. After two weeks of clean metrics, remove the flag and call the WASM plane done.
