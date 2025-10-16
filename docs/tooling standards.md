You want “works every time.” Reality check: networks flake, disks fill, clocks skew, and entropy is a gremlin. What we can guarantee is this: **every tool call either succeeds, or fails fast with a precise, machine‑actionable error, within a bounded deadline, and is safe to retry without corrupting state.** That is the only kind of “every time” that stands up in production.

Below is a drop‑in, repo‑agnostic contract for uicp. It defines exactly what the **system** must provide and what the **agent** must do so tool calls are deterministic, observable, and either complete or fail loudly with zero ambiguity.

Copy this into `docs/tool_contract.md` (or `tools.md`) and enforce it in CI. ASCII only, no smart quotes.

---

# tool_contract.md

Last updated: 2025-10-16

Scope
This spec defines the universal contract for tools and tool calls in this repo. It is transport‑agnostic (local call, IPC, HTTP, gRPC). Follow it verbatim. No silent skips. No best‑effort magic. Green is earned.

Design goal
A tool call must always resolve in one of four outcomes within its deadline:

1. `success` with typed outputs,
2. `retryable_error` with a backoff hint,
3. `terminal_error` with a corrective action hint, or
4. `invalid_request` with schema violations listed.

There are no other outcomes.

## 0) Non‑negotiables

* Deterministic envelope in and out. No ad hoc shapes.
* Idempotency for any operation that can be retried.
* Bounded time. Every call has a deadline. No infinite waits.
* Typed, structured errors. No generic “something went wrong”.
* Observability by default. Each call emits logs + trace + metrics.
* Least privilege. Tools declare and receive only capabilities they need.
* No TODOs, FIXMEs, or “temporary” hacks in tool code or docs.

## 1) Tool manifest (required per tool)

Each tool ships a manifest at `tools/<tool_id>/tool.yaml`.

```yaml
tool_id: "search.web"
semver: "1.4.2"
digest: "sha256:abcdef..."         # container or artifact digest
owner: "@team-search"
description: "Web search with source extraction and rate limiting."
determinism: "idempotent"          # one of: pure | idempotent | side_effectful
capabilities:
  fs: []                           # preopened dirs if any
  net_allowlist:
    - "https://api.example.com"
    - "https://*.wikipedia.org"
  env: ["HTTP_PROXY"]              # env vars explicitly allowed
limits:
  timeout_ms_default: 15000
  timeout_ms_max: 60000
  memory_mb_max: 512
  concurrency_max: 32
slo:
  success_rate_min: 0.995
  p95_latency_ms_max: 2000
health:
  readiness: "cmd:./bin/health --readiness"
  liveness:  "cmd:./bin/health --liveness"
errorspec: "errors.md"             # maps error codes to meaning and fixes
schema:
  request: "schema/request.json"
  response: "schema/response.json"
```

Rules

* `tool_id` is stable forever. Breaking changes bump major semver.
* `determinism` states retry semantics. If `side_effectful`, the tool must implement commit tokens (see 6.3).

## 2) Call envelope (transport‑agnostic)

All invocations and responses must conform to these shapes (JSON shown; protobuf or Rust types must be isomorphic).

### 2.1 Request envelope

```json
{
  "call_id": "uuid-v4",
  "tool_id": "search.web",
  "tool_version": "1.x",                 // semver range or exact
  "fn": "query",                         // function within the tool
  "input": { /* validated by tool schema */ },
  "context": {
    "actor_id": "agent://uicp/primary",
    "scopes": ["read:web"],
    "trace_id": "uuid-v4",
    "parent_span_id": "uuid-v4",
    "locale": "en-US",
    "timezone": "UTC",
    "clock": "monotonic",                // monotonic or wall
    "env": "prod"                        // prod|staging|dev
  },
  "constraints": {
    "timeout_ms": 15000,
    "deadline_unix_ms": 1734378895123,
    "idempotency_key": "hash(input+fn+version)",
    "memory_mb_limit": 512,
    "net_allowlist": ["https://*.wikipedia.org"],
    "retry_policy": { "max_attempts": 3, "base_ms": 200, "cap_ms": 2000, "jitter": "full" }
  },
  "provenance": {
    "agent_version": "uicp-agent@2.7.0",
    "commit": "git:abc123",
    "container": "sha256:agentimage..."
  },
  "dry_run": false
}
```

### 2.2 Response envelope

```json
{
  "call_id": "uuid-v4",
  "status": "success",                   // success | retryable_error | terminal_error | invalid_request
  "output": { /* typed on success */ },
  "error": {
    "code": "R-HTTP-429",                // see error taxonomy
    "message": "Rate limited by upstream",
    "details": { "retry_after_ms": 500 }
  },
  "side_effects": [
    { "kind": "write", "target": "file:///cache/index", "bytes": 4096 }
  ],
  "metrics": {
    "duration_ms": 612,
    "cpu_ms": 211,
    "memory_peak_mb": 74
  },
  "provenance": {
    "tool_id": "search.web",
    "tool_version": "1.4.2",
    "digest": "sha256:abcdef..."
  },
  "warnings": ["upstream returned partial content"],
  "commit_token": null                  // used for two-phase commit if side_effectful
}
```

Rules

* `status` is definitive. No mixing partial success with error.
* `error.code` is mandatory for non‑success. Use the taxonomy in section 5.
* `metrics` are always present. Zero values are valid.

## 3) System responsibilities (must)

The system (runtime + scheduler + infra) guarantees:

1. **Schema enforcement**
   Validate request envelope and `input` against the tool’s JSON Schema before dispatch. Reject with `invalid_request` listing all violations.

2. **Version pinning**
   Resolve `tool_version` semver to an exact build. Pass the digest to execution. Refuse to run if resolution is ambiguous.

3. **Resource isolation**
   Sandbox with limits matching `constraints`. Enforce CPU, memory, file system scope, and network allowlist.

4. **Deadlines**
   Enforce `timeout_ms` and `deadline_unix_ms`. Kill on overrun. Return `retryable_error` with `R-TIMEOUT-001`.

5. **Idempotent transport**
   Deduplicate in‑flight calls by `idempotency_key`. If a duplicate arrives, return the prior outcome.

6. **Observability**
   Inject `trace_id` and `parent_span_id`. Emit spans and structured logs. Export metrics: success rate, error rate by code, p50/p95/p99 latency.

7. **Secrets**
   Mount secrets through a scoped provider. Never print values. Rotate per policy. Tools must not read undeclared secrets.

8. **Health checks**
   Poll `readiness` and `liveness`. Remove unhealthy instances from routing. Fail fast with `S-TOOL-UNAVAILABLE`.

9. **Rollout safety**
   Blue‑green or canary for new `tool_version`. Auto‑rollback on SLO breach.

10. **Replay safety**
    On retry, prefer the same version and environment to avoid heisenbugs unless the error code dictates upgrading.

## 4) Agent responsibilities (must)

The calling agent guarantees:

1. **Evidence first**
   Construct `input` only from validated state. If confidence < 0.9 or external data is referenced, verify using available tools and cite in logs or PR notes.

2. **Pre‑flight**

   * Ensure `tool_id` exists and is ready.
   * Ensure the semver range is compatible with the repo’s policy.
   * Compute `idempotency_key` as a stable hash over `tool_id|fn|input|version_range`.

3. **Constraints**
   Set realistic `timeout_ms` and memory limits. Never use defaults blindly. Honor tool `limits`.

4. **Retries**
   Retry only on `retryable_error` classes using the tool’s recommended backoff. Never retry on `invalid_request` or `terminal_error` without human intervention.

5. **Output validation**
   Validate `response.output` against the tool’s response schema. For critical paths, apply domain sanity checks (e.g., monotonic timestamps, non‑negative counts).

6. **Side effects**
   If `commit_token` is present, execute the second phase atomically or discard within the same deadline window. Never replay a consumed token.

7. **Logging**
   Log at INFO: `tool_id`, `fn`, `status`, `duration_ms`, `error.code` if any. At DEBUG include an input summary, never secrets.

8. **No silent skips**
   If a call is skipped due to policy or confidence, emit a `SKIPPED` audit record with reason.

9. **Documentation**
   If you discover a new invariant or upstream quirk, update the tool’s `errors.md` and request/response schema in place. Do not create new docs for the same subject.

## 5) Error taxonomy (codes and meaning)

Codes are stable. Prefix indicates class. Tools may add subcodes but must not redefine classes.

* `I-REQ-*` invalid request. Schema violations, missing fields, bad types. Terminal.
* `A-AUTH-*` authn/authz failures. Terminal until credentials fixed.
* `P-PRECOND-*` precondition not met (e.g., missing resource). Terminal unless condition can change externally.
* `R-TIMEOUT-*` execution timed out. Retryable if tool is idempotent.
* `R-UPSTREAM-*` upstream transient (HTTP 429/503, connection reset, DNS). Retryable with backoff.
* `R-CAP-*` capacity or rate limit exceeded. Retryable with `retry_after_ms`.
* `S-TOOL-*` tool internal fault. Retryable once; report to owner on repeat.
* `C-CONTRACT-*` contract mismatch between agent and tool versions. Terminal until versions align.
* `D-DATA-*` data quality violation (e.g., checksum mismatch). Terminal until data repaired.

Each code MUST provide:

* human message (short),
* machine details payload,
* fix hint (“refresh token”, “increase timeout to N ms”, “upgrade to 2.x”).

## 6) Determinism and side effects

### 6.1 `pure`

Outputs depend only on inputs and tool version. Safe to retry freely.

### 6.2 `idempotent`

May touch state but repeated calls with same `idempotency_key` yield the same committed result. Provide `idempotency_key` requirements in schema.

### 6.3 `side_effectful` (two‑phase)

For non‑idempotent actions, the tool must implement:

* Phase 1: return `commit_token` and `status: success_prep`.
* Phase 2: agent calls `commit(commit_token)` to finalize.
  If commit is not called before the deadline, the tool MUST roll back.

## 7) JSON Schemas (templates)

Place under `tools/<tool_id>/schema/`.

`request.json`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["call_id","tool_id","tool_version","fn","input","context","constraints"],
  "properties": {
    "call_id": {"type":"string","format":"uuid"},
    "tool_id": {"type":"string","pattern":"^[a-z0-9._-]+$"},
    "tool_version": {"type":"string"},
    "fn": {"type":"string"},
    "input": {"$ref":"input.json#"},
    "context": {
      "type":"object",
      "required":["actor_id","trace_id","timezone","env"],
      "properties":{
        "actor_id":{"type":"string"},
        "scopes":{"type":"array","items":{"type":"string"}},
        "trace_id":{"type":"string","format":"uuid"},
        "parent_span_id":{"type":"string"},
        "locale":{"type":"string"},
        "timezone":{"type":"string"},
        "clock":{"type":"string","enum":["monotonic","wall"]},
        "env":{"type":"string","enum":["prod","staging","dev"]}
      }
    },
    "constraints": {
      "type":"object",
      "required":["timeout_ms","deadline_unix_ms","idempotency_key"],
      "properties":{
        "timeout_ms":{"type":"integer","minimum":1,"maximum":600000},
        "deadline_unix_ms":{"type":"integer","minimum":0},
        "idempotency_key":{"type":"string","minLength":16},
        "memory_mb_limit":{"type":"integer","minimum":16},
        "net_allowlist":{"type":"array","items":{"type":"string"}},
        "retry_policy":{"type":"object"}
      }
    },
    "provenance":{"type":"object"},
    "dry_run":{"type":"boolean"}
  },
  "additionalProperties": false
}
```

`response.json`

```json
{
  "$schema":"https://json-schema.org/draft/2020-12/schema",
  "type":"object",
  "required":["call_id","status","metrics","provenance"],
  "properties":{
    "call_id":{"type":"string","format":"uuid"},
    "status":{"type":"string","enum":["success","retryable_error","terminal_error","invalid_request"]},
    "output":{"$ref":"output.json#"},
    "error":{"type":"object"},
    "side_effects":{"type":"array","items":{"type":"object"}},
    "metrics":{"type":"object","required":["duration_ms"],"properties":{"duration_ms":{"type":"integer"}}},
    "provenance":{"type":"object","required":["tool_id","tool_version"]},
    "warnings":{"type":"array","items":{"type":"string"}},
    "commit_token":{"type":["string","null"]}
  },
  "additionalProperties": false
}
```

## 8) Type bindings (uicp)

### 8.1 TypeScript interfaces

Place in `uicp/packages/toolkit/src/types.ts`.

```ts
export type Status = "success" | "retryable_error" | "terminal_error" | "invalid_request";

export interface RetryPolicy {
  max_attempts: number;
  base_ms: number;
  cap_ms: number;
  jitter: "none" | "full";
}

export interface CallConstraints {
  timeout_ms: number;
  deadline_unix_ms: number;
  idempotency_key: string;
  memory_mb_limit?: number;
  net_allowlist?: string[];
  retry_policy?: RetryPolicy;
}

export interface CallContext {
  actor_id: string;
  scopes?: string[];
  trace_id: string;
  parent_span_id?: string;
  locale?: string;
  timezone: string;
  clock?: "monotonic" | "wall";
  env: "prod" | "staging" | "dev";
}

export interface ToolRequest<I = unknown> {
  call_id: string;
  tool_id: string;
  tool_version: string; // semver or range
  fn: string;
  input: I;
  context: CallContext;
  constraints: CallConstraints;
  provenance?: Record<string, unknown>;
  dry_run?: boolean;
}

export interface ToolError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ToolResponse<O = unknown> {
  call_id: string;
  status: Status;
  output?: O;
  error?: ToolError;
  side_effects?: Array<Record<string, unknown>>;
  metrics: { duration_ms: number; cpu_ms?: number; memory_peak_mb?: number };
  provenance: { tool_id: string; tool_version: string; digest?: string };
  warnings?: string[];
  commit_token?: string | null;
}
```

### 8.2 Rust trait

Place in `uicp/crates/toolkit/src/lib.rs`.

```rust
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct CallConstraints {
    pub timeout_ms: u64,
    pub deadline_unix_ms: u64,
    pub idempotency_key: String,
    pub memory_mb_limit: Option<u64>,
}

#[derive(Serialize, Deserialize)]
pub struct CallContext {
    pub actor_id: String,
    pub trace_id: String,
    pub timezone: String,
    pub env: String,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "status")]
pub enum ToolResult<O> {
    #[serde(rename = "success")]
    Success {
        call_id: String,
        output: O,
        metrics: Metrics,
        provenance: Provenance,
        warnings: Option<Vec<String>>,
        side_effects: Option<serde_json::Value>,
        commit_token: Option<String>,
    },
    #[serde(rename = "retryable_error")]
    RetryableError {
        call_id: String,
        error: ToolError,
        metrics: Metrics,
        provenance: Provenance,
    },
    #[serde(rename = "terminal_error")]
    TerminalError {
        call_id: String,
        error: ToolError,
        metrics: Metrics,
        provenance: Provenance,
    },
    #[serde(rename = "invalid_request")]
    InvalidRequest {
        call_id: String,
        error: ToolError,
        metrics: Metrics,
        provenance: Provenance,
    },
}

#[derive(Serialize, Deserialize)]
pub struct Provenance { pub tool_id: String, pub tool_version: String }

#[derive(Serialize, Deserialize)]
pub struct Metrics { pub duration_ms: u64, pub cpu_ms: Option<u64>, pub memory_peak_mb: Option<u64> }

#[derive(Serialize, Deserialize)]
pub struct ToolError { pub code: String, pub message: String, pub details: Option<serde_json::Value> }

#[async_trait::async_trait]
pub trait Tool<I, O> {
    fn tool_id(&self) -> &'static str;
    fn tool_version(&self) -> &'static str;

    /// Validate input shape and preconditions. Return InvalidRequest on failure.
    fn validate(&self, input: &I, ctx: &CallContext) -> Result<(), ToolError>;

    /// Execute with the given constraints. Must honor deadlines, return within timeout, and never panic.
    async fn execute(&self, input: I, ctx: CallContext, constraints: CallConstraints)
        -> ToolResult<O>;
}
```

## 9) Observability requirements

* **Logs**: structured, include `tool_id`, `fn`, `call_id`, `status`, `duration_ms`, and `error.code` if present.
* **Traces**: one span per call; annotate with `determinism`, `timeout_ms`, `idempotency_key_prefix`.
* **Metrics**: per tool and version, export success rate, error rate by class, p50/p95/p99 latency, in‑flight gauge.
* **Dashboards**: for T2+ tools, maintain a dashboard that shows last 7 days SLOs. For T3/T4, include alerting.

## 10) Testing and CI gates

* **Contract tests**: golden request→response for each fn, including error paths.
* **Schema tests**: fuzz invalid requests; ensure `invalid_request` is returned with field‑level violations.
* **Idempotency tests**: same call multiple times under injected timeouts must produce a single committed effect.
* **Chaos tests**: inject `R-UPSTREAM-` and `R-TIMEOUT-` faults; verify retries and backoff.
* **Compatibility tests**: N and N‑1 versions accept the same valid request; if not, major bump required.
* CI must fail on any warning. Coverage floors per module. No flake masking.

## 11) Change control

* Breaking change → major version bump.
* Deprecations live one minor version with warnings, then removed.
* Update docs in place. Do not create parallel files.

## 12) Security

* Auth required for all calls. Short‑lived credentials bound to `actor_id` and `scopes`.
* Data minimization. Only pass fields required by schema.
* PII redaction in logs.
* Secrets accessed only via declared capability. Never read process env ad hoc.

## 13) Quick checklists

### System preflight (must be true before any call)

* [ ] Tool manifest found and valid.
* [ ] Exact version resolved to a pinned digest.
* [ ] Sandbox created with declared limits and allowlists.
* [ ] Health checks passing.
* [ ] Secrets mounted for declared scopes only.
* [ ] Observability wiring active.

### Agent preflight (must be done before dispatch)

* [ ] Confidence >= 0.9 or external verification attached.
* [ ] Inputs validated against request schema.
* [ ] Idempotency key computed.
* [ ] Realistic timeout and memory set.
* [ ] Net allowlist aligned with tool manifest.
* [ ] Trace ids set.

### Post‑call verification

* [ ] Response schema validated.
* [ ] Status is one of four allowed values.
* [ ] If retryable, backoff applied as hinted.
* [ ] Side effects either committed with token or rolled back.
* [ ] Logs, traces, metrics emitted.

---

## Why this works (and when it fails loudly)

You cannot promise success on hostile networks or flaky upstreams. You can promise **deterministic resolution**: the call either returns correct outputs or a specific error that tells the agent what to do next. With idempotency, deadlines, and explicit error classes, every failure mode is legible and safe to retry. That is as close to “every time” as physics allows.

---

### Opinionated extras for uicp (optional but recommended)

* Pin tool containers by digest in a lockfile: `tools/lock.yaml`.
* Generate a small SDK from each tool’s schemas (ts + rust) during CI.
* Enforce the envelope with a runtime guard: reject any tool or agent that deviates from the schema at runtime.