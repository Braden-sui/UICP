agents.md

Last updated: 2025-10-15

Purpose
Define how autonomous engineering agents operate in any repository here. The goal is simple: ship correct changes fast, with proof. Agents act, validate, and leave the codebase healthier than they found it. No silent skips. No sloppy work. Green only when it is earned.

Applies to
All languages, stacks, docs, tests, CI, and infra in this repo.

Repo prefix for error codes
Use E-<REPO>-#### where <REPO> is this repo name in caps without spaces. Example: E-UICP-0123.

0) Precedence and stop conditions

This file overrides other style or workflow docs when there is conflict.

If /.haltagent exists at repo root, stop work immediately, report why, and wait for direction.

Default mode is Autonomous. Do not defer started work.

1) Operating principles

Validate first, then modify. Reproduce the issue, isolate the cause, add a minimal repro test, then patch.

Make zero assumptions without evidence. If confidence is below 0.9, gather proof.

Be liberal in verification, conservative in speculation. Use all available tools to validate: code search, static analysis, local runs, sandboxed execution, and web API calls with your network access.

Never perform silent skips. Every deviation or fallback is explicit, logged, and justified.

No TODO, FIXME, or placeholders in code. Follow ups belong in issues or PR notes, not in source files.

Senior grade only. Clear structure, explicit invariants, typed errors, and disciplined naming.

2) Decision protocol

Ask at most two concise clarifying questions only if required for correctness. If ambiguity remains, proceed with the best documented assumption and record it in the PLAN. Once a task starts, complete it in this session or present the single blocking item.

3) Autonomy tiers and risk gates

Compute R = (impact x irreversibility) / confidence.

Impact: 1 docs to 5 legal or compliance
Irreversibility: 1 trivial revert to 5 restore required
Confidence: 1 weak to 5 strong (tests + observability + dry runs)

Mapping:
0 to 2 -> T0 Open

2 to 4 -> T1 Caution
4 to 7 -> T2 Extreme
7 to 10 -> T3 Critical
10 -> T4 Catastrophic

Tier table

Tier	Scope examples	Allowed	Required gates
T0	Docs, comments, internal non-hot code	Edit, add, delete, self-merge on green	Build + lint + tests
T1	Public APIs, CLI behavior, DB reads or writes without schema change	Full edits	Contract tests + smoke e2e for affected flows
T2	Schema or migrations, privacy, auth, background jobs moving or deleting data	Full edits	Migration dry run on fixtures, backup or snapshot point, dual-write or shadow-read when practical, logs + metrics + traces, staged canary + kill switch, attach proofs
T3	Secrets, CI or CD, IaC, network policy, encryption	Full edits	Policy token or explicit approval, plan in sandbox, blue-green or canary 1 to 10 to 100 percent, guard metrics and alerts, auto-rollback script
T4	Irreversible data purge, retention policy change, crypto invalidation	Proceed only if reversibility proven	Full T3 plus restore rehearsal in prod-like clone; else propose-only
4) Required outputs for non-trivial work

Provide these sections in the PR description or work log.

PLAN

Goal and why now

Key assumptions and their current confidence

Approach and alternatives considered

Selected Tier and rationale

Risk class and rollback plan

DIFF SUMMARY

What changed, why, and where

Deleted code inventory if any

VALIDATION

Tests added or updated and what they prove

Manual steps if any

Observability added (logs, metrics, traces, dashboards)

Links to dashboards or artifacts

5) Validation workflow

Recon

Map entry points, data flow, and external effects.

Detect multiple linters or conflicting configs, duplicate defaults, unused flags, dead code behind switches. Propose a crisp choice.

Reproduce

Create a minimal failing test or script. Capture inputs, environment, and seed where relevant.

Inspect

Use static analysis, type checks, and local runs. Instrument with temporary structured logs or trace spans.

Verify with web sources when claims are external

Cross check at least two independent high quality sources. Cite in docs or PR notes. Summarize evidence, do not paste walls of text.

Patch

Prefer the smallest correct change. Escalate to refactor only if the small change harms correctness or clarity.

Prove

Run full CI, enforce warnings as errors. Show failure modes are handled and surfaced.

Clean

Remove temporary instrumentation, dead paths, and unused flags in the same PR or paired cleanup PR linked in PLAN.

6) Code quality rules

No broad catches or empty error handlers. Fail loud with typed or structured errors.

No unwrap or expect outside initialization in Rust. No floating promises in TypeScript. Always await or rethrow.

Strict type settings. Treat lints as errors.

Pure functions where practical. Side effects live at boundaries. Clear module boundaries.

Explicit invariants in code comments at decision points. Use tags: WHY, INVARIANT, SAFETY, ERROR.

No duplicated logic. Extract helpers with tests.

No feature flags that linger. Temporary gates are removed before merge to main unless policy states otherwise.

Language notes
TypeScript: strict, eslint on, no implicit any, no misused promises, sanitize HTML before DOM.
Rust: anyhow or typed error enums, tracing for logs, Tokio for async, avoid panics in runtime paths.
Go: check every error, wrap with context, panic only on fatal startup config.
Python: type hints required, mypy strict where used, no bare except, use exceptions for control flow sparingly.

7) Testing policy

Every behavioral change carries tests. No feel good tests. Tests must verify actual logic and failure handling.

Minimums by layer

Unit: pure logic, property tests for parsers or algorithms.

Contract: public APIs and function shapes; golden or snapshot for serializers or renderers.

Integration: service boundaries, DB, queues. Prefer real lightweight dependencies, thin fakes if heavy.

E2E: only for critical user journeys; keep few and stable.

Migration: apply forward on fixtures, verify counts and invariants, show idempotency if claimed.

Negative: invalid inputs, timeouts, partial failures. Assert loud failure and error codes.

Differential: when replacing a path, run old vs new under the same inputs and compare outputs.

Coverage floors per module are allowed but not a substitute for quality. Do not drop floors on main without explicit approval.

8) Observability

Add trace spans around new or changed paths.

Structured logs with request id or trace id, actor if allowed, input summary, outcome, and duration.

Metrics for success and error rate, p50 p95 p99 latency, queue depth where relevant.

T2 and higher require dashboards and at least one alert. T3 and T4 require SLOs and an error budget check.

9) Security and supply chain

Never commit secrets. Use .env and secret scanners in CI.

Pin lockfiles. Update dependencies intentionally with risk notes.

Sanitize logs. No sensitive payloads.

For T3 and T4, verify secret age and rotation. Do not print secret values.

Generate or update SBOM when dependencies change. Run SAST and dependency scans.

Network policy scope (repo-wide)

- UI process: in-app Network Guard enforces process-level egress policy (default-deny for sensitive endpoints; configurable via `VITE_NET_GUARD_*`). Supports monitor-only mode for diagnostics.
- Providers: outbound network is disabled unless `UICP_ALLOW_NET=1`; when enabled, provider requests remain constrained by httpjail allowlists (override path via `UICP_HTTPJAIL_ALLOWLIST`).
- Host firewall: any scripts/configs under `ops/code/network/` are ops-only (operators/CI). The desktop app does not execute host OS firewall changes by default.

10) Performance budgets

If a path is hot, set a target and measure. Example: p95 latency delta less than or equal to 5 percent against baseline under representative load.

Avoid algorithmic regressions. Add microbenchmarks for critical loops where useful.

11) Docs and knowledge hygiene

Update existing docs in place. Do not create duplicate files. If a new document is necessary, integrate and retire the old one in the same PR.

Keep docs plain ASCII. No smart quotes. No em dashes.

When docs include technical or factual claims, cite sources or code references. For internal references, link to files or tests.

Changelogs and READMEs reflect the current truth after each merge. No stale sections.

12) Memory and context discipline

Agents load prior decisions and context before editing. Summarize key constraints and invariants at the top of the PLAN.

Refresh memories when the ground truth changes. Outdated agent notes must be corrected in the same PR that changes behavior.

Do not invent context. When missing, ask once or derive from code and tests, then proceed.

13) PR protocol

Title: imperative and concise.
Context Summary: goal, why now, invariants to preserve.
Scope: files or subsystems touched, small vs large and why.
Autonomy Tier: tier number, rubric values, and links to proofs.
Risks: correctness, data, performance, security, and mitigations.
Tests: list by layer and what they prove; coverage summary.
Observability: logs, metrics, traces, dashboards.
Migration: steps, runtime estimate, backfill notes.
Rollback: revert steps or kill switch.
Cleanup: deleted code list and any follow ups recorded as issues, not code comments.

CI gates must pass: build, type, lint, format, tests, coverage floors, security scans, secret scan, tier jobs such as migration dry run or IaC plan. No warnings.

14) Deletion protocol

Inventory symbols or routes and all callers, including dynamic entry points.

Prove new path coverage or non-usage. Tests enforce absence of old path.

Remove and verify: compile or build, run full tests, grep for remnants.

Post delete checks: smoke key flows and update docs or examples.

15) Tool usage policy

Always choose tools that increase certainty. Use liberally for verification.

Local

Grep or ripgrep, ctags or symbol index, static analyzers, linters, formatters, type checkers, unit and integration test runners, profilers.

Sandboxed execution for risky steps.

External

Web search and reference checks when claims are external. Prefer primary sources and current official docs. Record sources in PR notes or docs.

Calculators or notebooks for data checks. Export results when they inform code or tests.

Rule: if confidence is below 0.9 or the claim is time sensitive, verify externally and cite.

16) Interface and data change strategy

Interfaces: branch by abstraction, swap implementation, remove indirection before merge.

Data or API: expand, backfill, switch, contract. No big bang swaps without a gate.

Feature flags are temporary and must be removed before merge or in a paired cleanup PR within the same release window.

17) Error handling and codes

Use structured error types and unique error codes. Include enough context to debug without leaking sensitive data.

Process exits non-zero on misconfig, schema mismatch, or missing env.

Document expected failures and codes in code comments and contract tests.

18) Style and hygiene

ASCII only. No hidden Unicode.

No generated or vendored artifacts in diffs.

Consistent naming, small focused commits, and clean diffs.

19) Quick start checklist

Context summary and Tier selected.

Patch plan written.

Core tests written or failing repro added.

Focused commits applied.

Observability added.

Dead code removed and coverage proved.

Full CI and tier gates green.

PR opened with PLAN, DIFF SUMMARY, and VALIDATION.

Post merge housekeeping done: docs, dashboards, issues for follow up if any.

20) Minimal code comment templates

TypeScript

// WHY: Keep renderer pure; IO happens in the command layer.
// INVARIANT: node.children are normalized before render.
// ERROR: E-<REPO>-0001 invalid AST: children missing
export function renderNode(node: AstNode): VNode {
  if (!node || !Array.isArray(node.children)) {
    throw new Error("E-<REPO>-0001 invalid AST: children missing");
  }
  return h("div", {}, node.children.map(renderNode));
}


Rust

// WHY: Stream DB rows to UI; avoid unbounded allocations.
// INVARIANT: Each chunk <= 1_000 rows; caller must drain the stream.
// ERROR: E-<REPO>-0201 query_stream failed; E-<REPO>-0202 row decode failure.
pub async fn stream_rows(db: &Db, q: Query) -> anyhow::Result<impl Stream<Item = Row>> {
    use futures::TryStreamExt;
    let s = db.query_stream(q).await
        .context("E-<REPO>-0201 query_stream failed")?
        .map_err(|e| anyhow::anyhow!("E-<REPO>-0202 row decode: {e}"));
    Ok(s)
}


Go

// WHY: Validate payload then persist atomically.
// INVARIANT: idempotency key uniqueness per 24h window.
// ERROR: E-<REPO>-0301 invalid payload, E-<REPO>-0302 db write.
func Handle(w http.ResponseWriter, r *http.Request) error {
  p, err := decode(r.Body)
  if err != nil { return fmt.Errorf("E-<REPO>-0301: %w", err) }
  if err := repo.Save(r.Context(), p); err != nil { return fmt.Errorf("E-<REPO>-0302: %w", err) }
  return nil
}

21) Anti-patterns

Catch and ignore exceptions.

New behavior without tests.

Feature flags that linger.

Dead code left after refactor.

Regex-only sweeps for structural changes. Prefer codemods or AST transforms.

Docs that claim without sources.

Any TODO or FIXME left in code.

Default stance
Autonomy with proof. If there is doubt, pick the higher tier and show it is safe. Finish what you start, validate aggressively, and keep the tree clean.