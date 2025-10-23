# UICP WASM Plane Refactor

Policy-enforced, first-class provider integration. This turns the WASM plane from a utility into a production provider with clear security, performance, and DX.

## Executive summary

* The WASM plane becomes a routable provider alongside LLM and local.
* Provider selection is policy-owned, not model-owned.
* Capability tokens are minted and verified by the host.
* Caching moves to explicit input manifests with determinism tagging.
* Observability, failure taxonomy, and backpressure are wired end to end.
* Two production workloads migrate first: patch.summarize and metrics.aggregate.

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
- [~] Phase 3: Cache v2 + determinism (groundwork landed; see details)
- [ ] Phase 4: WIT world finalize + hostcall gating
- [ ] Phase 5: Registry enforcement + trust store
- [ ] Phase 6: Observability (failure taxonomy, SLOs) + Backpressure UI
- [ ] Phase 7: Fair scheduling
- [ ] Phase 8: DX CLI
- [ ] Phase 9: Migrate modules (patch-tools, metrics-agg)
- [ ] Phase 10: CI gating + rollout
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

Tokens v1 (implemented):

* Host mints an HMAC-SHA256 token over `{jobId, task, workspaceId, envHash}`.
* Token travels with the `JobSpec` and is verified before execution when enforcement is enabled.
* Enforcement is disabled by default; opt-in via `UICP_REQUIRE_TOKENS=1`.

Planned for v2 (future):

* Expand token payload to include `capabilities`, `limits`, `policyVersion`, and a short-lived `exp`, then enforce strict match on host.

## Cache v2 and determinism

Implemented (initial v2):

* Replace implicit workspace hashing with explicit input manifests (ws:/files traversal).
* Cache key: `v2|task|env|input_json_canonical|manifest(ws:/files blake3)`.
* Env flag: `UICP_CACHE_V2=1` toggles both lookup and store to v2 keys.

Planned extensions (future):

* Add `module_sha`, `module_ver`, `policy_ver`, `host_abi`, `wit_world`, `wasmtime_major` into v2 key.

Determinism rules:

  * Using time or net or unseeded random flips deterministic=false.
  * deterministic=false forces cache bypass unless policy allows.
* Result metrics carry `outputHash` and (when golden expected) `goldenHash`, `goldenMatched`.

Golden cache:

* On first successful run with `goldenKey`, store `outputHash`.
* On subsequent runs, verify equality; mismatch flips `goldenMatched=false` and emits a `replay-issue` event; UI may enter Safe Mode.

## Environment flags

* `UICP_REQUIRE_TOKENS=1` — enforce job token verification.
* `UICP_JOB_TOKEN_KEY_HEX=<64 hex>` — fixed 32-byte HMAC key; random if unset.
* `UICP_CACHE_V2=1` — use v2 cache key for lookup and store.

## Backpressure and log quotas

* Bounded queues for logs and events.
* When full, drop with rate-limited "logs dropped" events.
* UI shows a red "backpressure active" banner.

## Failure taxonomy and SLOs

* Reasons: ExecTimeout, FuelExhausted, MemLimit, CapabilityDenied, HostPanic, ModulePanic, BackpressureDrop, SignatureRequired, SignatureInvalid.
* SLOs: latency p50 and p95, failure rate, cache hit ratio, determinism ratio.

## Fair scheduling

* Weighted fair queue per provider and per tenant.
* Concurrency caps per provider. Prevents head of line blocking.

## Registry enforcement

* Signatures required in non-dev. Trust store with key ids and rotation.
* Dev mode can allow unsigned; host emits a `registry-warning` event that is surfaced as a toast.
* Env flags:
  * `STRICT_MODULES_VERIFY=1` — require Verified signature for all modules.
  * `UICP_MODULES_PUBKEY` — single Ed25519 pubkey (base64 or hex) for signature verification.
  * `UICP_TRUST_STORE` — path to JSON object of `{ keyid: pubkey }` (base64 or hex).
  * `UICP_TRUST_STORE_JSON` — inline JSON object for trust store (overrides file).
* When `keyid` is present in manifest entry, trust store is used; otherwise fallback to `UICP_MODULES_PUBKEY`.

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

* `uicp mod init` creates a Rust or AssemblyScript template with the WIT world and a stub `run`.
* `uicp mod build` uses a containerized builder for stable outputs across platforms. Emits module `.wasm` plus manifest with sha256 and limits.
* `uicp mod run` runs a module locally via the host using a JSON file.
* `uicp mod publish` writes into the local registry directory with signature.

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

* Refuse unsigned modules in non-dev builds. CI fails if unsigned.
* Run golden tests for each module with deterministic outputs.
* Mutation tests for policyDecide mapping.
* Wasmtime version pin with SBOM and license checks.

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

## Rollout plan

* Feature flag WASM_PROVIDER in dev first. Kill switch present.
* Canary to 10 percent of sessions. Watch failure rate and cache hit ratio.
* Enable for all dev. Wait 2 days. Enable for prod if SLOs hold.

## Fire drills

* Log flood: verify drops and UI banner.
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
* Key extensions (host_abi, wit_world, wasmtime_major) — pending.

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
  "signature": "ed25519:...",
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
