# Goal

Ship correct code fast, with proofs. Be autonomous by default; switch to propose-only only when required gates cannot be met. Leave clear notes in code for future humans/agents.

Applies to: Entire repo (uicp TypeScript/React/Tauri + Rust backend, docs, tests, CI).

## 0) Non-negotiables

No silent failure. No empty/broad catches; no “log and continue” on errors.

Fail loud. Treat warnings as errors in CI. Assert invariants.

Every change has tests. New behavior without tests is rejected.

Delete dead code only after proving replacement coverage.

Leave code notes. Explain why and invariants, not just what (format below).

No long-lived shims/flags. Temporary compatibility is removed before merge to main.

## 1) Operating Modes

Small Steps (default): Minimal diffs, fast feedback, reversible.

Large Refactor (when warranted): If the small path harms correctness or simplicity. Plan → codemod → migrate → verify → delete old path in same PR or paired cleanup PR with a dated follow-up.

## 2) Autonomy Tiers (condensed)

Choose the highest tier touched by the change. If you can’t satisfy gates, switch to propose-only for the failing step.

Risk score R = (impact × irreversibility) / confidence

Impact: 1 minor → 5 legal/compliance

Irreversibility: 1 trivial revert → 5 restore required

Confidence: 1 weak → 5 strong (tests + obs + dry runs)

Mapping:
0-2 → T0, >2-4 → T1, >4-7 → T2, >7-10 → T3, >10 → T4

| Tier | Scope (examples) | Allowed | Required gates (must have) |
| ---- | ---------------- | ------- | -------------------------- |
| T0 Open | Docs, comments, non-hot internal code | Edit/add/delete; self-merge on green | Build + lint + tests |
| T1 Caution | Public functions, CLI behavior, DB reads/writes w/o schema change | Full edits/deletes; self-merge on green | Contract tests + minimal e2e smoke for touched flows |
| T2 Extreme | Schema/migrations, auth, privacy, background jobs moving/deleting data | Full edits/deletes | Migration dry run on fixtures; backup/restore point; dual-write or shadow-read when practical; metrics + logs + traces; staged canary + kill switch; attach proofs |
| T3 Critical | Secrets, CI/CD, IaC, network policies, encryption | Full edits/deletes | Policy token pre-authorization; IaC/CI "plan" in sandbox; blue-green/canary (1%→10%→100%); guard metrics/alerts; auto-rollback script + trigger |
| T4 Catastrophic | Irreversible data purge, retention changes, crypto invalidation | Proceed only if reversibility proven | Full T3 + timed restore rehearsal in prod-like clone; dark launch OK; else propose-only |

Policy tokens (T3/T4): Signed JSON in-repo that pre-authorizes the exact action class (scope, limits, proofs required). If missing, propose-only.

## 3) Context Summary (build before editing)

Write a short artifact (commit note or PR section):

Touched modules & why

Invariants to preserve

Risks & blast radius

Selected Tier & rationale

Observability to add (logs/metrics/traces)

Rollback plan (revert steps or kill switch)

## 4) Change Strategy

Isolate → Improve → Prove. Keep commits coherent by topic.

Interfaces: Branch by abstraction in-branch; swap impl; remove indirection before merge.

Data/API: Expand → backfill → switch → contract (contract before merge; no residual compat).

Deletions: inventory symbols/routes → remove → run full tests → grep for remnants → smoke key flows.

## 5) Testing Policy (minimums)

For any change, include tests from the layers you touch:

Unit: pure logic, property tests for parsers/algos.

Contract: public functions/API shapes; golden/snapshot for serializers/renderers.

Integration: service boundaries, DB, queues (real if lightweight, thin fakes if heavy).

E2E: critical user journeys impacted. Keep few & stable.

Migration: forward apply on fixtures; verify counts/invariants; idempotency when claimed.

Negative: invalid inputs, timeouts, partial failures; verify loud failure.

Coverage: enforce per-module floors; do not drop on main without explicit approval. No flake masking.

Tier adds: T2 needs differential tests if replacing a path. T3 needs rollback/recovery smoke. T4 needs restore rehearsal proofs.

## 6) Fail-Loud Patterns

Never broad-catch without rethrow + context.

Structured errors with unique codes; include request/trace id.

Process exits non-zero on misconfig, schema mismatch, missing env.

TypeScript: strict; no floating promises; always await or rethrow; @typescript-eslint enforced.
Rust: use anyhow/typed errors + ?; prefer tracing for logs; avoid unwrap() outside initialization; async via Tokio.
Go (if present): check every err; wrap with context; panic only on fatal startup config.

## 7) Observability

Add trace spans around new/changed paths.

Logs: structured; include actor (if allowed), request id, op, input summary, outcome, duration.

Metrics: success/error rate, latency p50/p95/p99, queue depth where relevant.

Dashboards/alerts when touching critical paths.

Tier adds: T2+ require dashboards + at least one alert. T3/4 require SLOs.

## 8) Security & Supply Chain

Never commit secrets. Use .env; run secret scanner in CI.

Pinned lockfiles; intentional updates with risk notes.

Sanitize logs; no sensitive payloads.

For T3/4 secret handling, use managed stores & verify rotation age; never print values.

## 9) Performance Budgets

If the path is hot or perf-sensitive: set/observe a target (e.g., ≤ +5% p95 latency delta under baseline load). Avoid algorithmic regressions; add micro-benchmarks for critical loops.

## 10) Code Notes (required)

Leave short, high-signal notes at decision points. Prefer these tags:

WHY: rationale / trade-offs

INVARIANT: must always hold

SAFETY: why this is sound (Rust) / safe to ignore (TS)

ERROR: expected failures & codes

TODO(yyyy-mm-dd): short-lived follow-up with date

### TypeScript example

// WHY: Keep renderer pure; IO happens in the Tauri command layer.
// INVARIANT: `node.children` are normalized before render.
export function renderNode(node: AstNode): VNode {
  if (!node || !Array.isArray(node.children)) {
    // ERROR: E-UICP-001 Invalid AST shape — fail loud for upstream fix.
    throw new Error("E-UICP-001: invalid AST: children missing");
  }
  // SAFETY: `children` are normalized by `normalizeAst()` in adapter.ts.
  return h("div", {}, node.children.map(renderNode));
}

### Rust example

// WHY: Stream DB rows to UI; avoid unbounded allocations.
// INVARIANT: Each chunk <= 1_000 rows; caller must drain stream.
pub async fn stream_rows(db: &Db, q: Query) -> anyhow::Result<impl Stream<Item = Row>> {
    use futures::TryStreamExt;
    let s = db.query_stream(q).await
        .context("E-UICP-201: query_stream failed")? // ERROR code + context
        .map_err(|e| anyhow::anyhow!("E-UICP-202: row decode: {e}"));
    Ok(s)
}

Error code prefix: E-UICP-#### for this repo.

## 11) PR Protocol (one page)

Title: imperative, concise.
Context Summary: goal, why now, invariants.
Scope: files/subsystems; small vs large and why.
Autonomy Tier: number + rubric + links to proofs (migrations, plans, dashboards).
Risks: correctness/data/perf/security; mitigations.
Tests: list by layer + what they prove; coverage summary.
Observability: logs/metrics/traces/dashboards.
Migration (if any): steps, runtime estimate, backfill notes.
Rollback: revert steps or kill switch.
Cleanup: deleted code list; dated follow-ups if any.

CI gates must pass: build, type, lint, format; tests + coverage floors; security/secret scans; no warnings; tier jobs (e.g., migration dry run, IaC plan, canary health).

## 12) Quick Start Checklist (for any task)

- **Context summary** Build context summary; select Tier.
- **Patch plan** Write a patch plan (small first; escalate if smaller is worse).
- **Tests first** Write core tests first (or differential tests for replacements).
- **Focused commits** Implement in focused commits.
- **Observability** Add logs/metrics/traces.
- **Coverage** Delete dead code; prove replacement coverage.
- **CI** Run full CI + tier gates; fix all failures (no warnings).
- **PR** Open PR with required sections + proofs.
- **Post-merge** Post-merge housekeeping (docs, dashboards, tickets).

## 13) Deletion Protocol (short)

Inventory: symbols/routes & all callers (static + dynamic entry points).

Prove coverage: new path covers old; tests enforce absence of old path.

Remove & verify: compile/build; run full tests; grep names.

Post-delete checks: smoke critical flows; update docs/examples.

## 14) Repo-specific guardrails (uicp)

TypeScript strict; React 18; Rust async (Tokio).

Run locally:

cd uicp && npm run dev (Vite + Tauri)

npm run build (typecheck + bundle)

npm run test (Vitest) / npm run test:e2e (Playwright)

npm run lint && npm run format (ESLint + Prettier)

Security: never commit secrets; use .env (e.g., OLLAMA_API_KEY).

Sanitize HTML before DOM. No inline JS from models; use data-* hooks.

## 15) Minimal Tier Annotations (optional)

.agent-policy.yml example:

```yaml
patterns:
  - path: "docs/**"         # T0
    default_tier: 0
  - path: "uicp/src/**"     # T1
    default_tier: 1
  - path: "migrations/**"   # T2
    default_tier: 2
  - path: "infra/**"        # T3
    default_tier: 3
  - path: "scripts/purge/**"# T4
    default_tier: 4
```

## 16) Optional Appendix — Wasm/Component-Model Agents (keep it short)

If you introduce Wasm agents/components:

Contract first: define WIT packages/worlds with versions (package ns:name@x.y.z;).

Least privilege: import only required capabilities (preopened dirs, http, clocks, random).

Determinism: gate wall-clock/random; canonicalize NaNs; prefer epoch or fuel limits.

Streams not blobs: use wasi:io/streams and pollables; avoid unbounded `list<u8>`.

Distribution: compose with wasm-tools; sign artifacts (cosign); verify on pull.

## 17) Anti-patterns (reject)

Catch and ignore exceptions; log without failing.

New code without tests.

Feature flags that linger in main.

Dead code left post‑refactor.

Regex‑only sweeps for structural changes (use codemods).

“Back‑compat forever” layers after the migration is done.

Default stance: Autonomy with proof. If there’s doubt, pick the higher tier and show it’s safe.