# Security Enhancement Plan (Q4–Q1)

Executive stance

Principle: Allow by default inside a hard sandbox; step up friction only on real risk.

Translate that to:
- Strong isolation for untrusted code so even bad code can run without breaking anything.
- Adaptive controls that add friction only when a real signal fires.
- Fast feedback loops so we can tune guardrails based on actual false positives, not vibes.

### Personal OS baseline (new default)

- **Network:** default_allow, HTTPS required only for public hosts (localhost + RFC1918 exempt), IP literals allowed, private LAN allowed, blocklists limited to metadata endpoints, generous quotas (200 rps / 2 GiB per domain).
- **Compute:** CSPRNG enabled, ~4 cores (cpu_ms_per_second 4000) and 8 GiB RAM available by default, realtime transports and workers allowed.
- **Filesystem:** prompt with pre-defined scopes (app home, Downloads, Documents, Pictures) to eliminate repetitive prompts while keeping user consent.
- **Permissions & Observability:** approvals persist, no first-run review nag once template trusted, logs default to warn, policy overlay off (users can enable via Security Center).

Non‑negotiable constraints (repo policy)
- In‑app network guard only; no OS firewall edits by default. Host‑level scripts remain ops‑only and disabled in product builds.
- Default‑allow loopback (localhost, 127.0.0.1, ::1). LAN/private ranges blocked unless explicitly allow‑listed.
- No intent‑specific hardcoded hints. Global, capability‑based controls only.

- Job token enforcement is operator‑managed. Enable via `UICP_REQUIRE_TOKENS=1` and set `UICP_JOB_TOKEN_KEY_HEX` (32‑byte hex) in production. Packaging does not auto‑enable this.

Repo touchpoints (current)
- Compute host (WASI P2, Component Model): `uicp/src-tauri/src/compute.rs`, `policy.rs`
- In-app egress guard: `uicp/src/lib/security/networkGuard.ts` (+ unit tests)
- Tauri app (CSP/capabilities): `src-tauri/` config
- Sanitization: docs + unit tests (frontend)

Quick environment flags (security-relevant)
- Compute host
  - `UICP_REQUIRE_TOKENS` (0|1) — enforce per-job MAC tokens (operator-managed)
  - `UICP_JOB_TOKEN_KEY_HEX` — 32-byte hex key for token verification
  - `UICP_WASM_CONCURRENCY` — WASM provider concurrency cap
  - `UICP_CACHE_V2` (0|1) — enable v2 cache key with input manifests and invariants
- Registry
  - `STRICT_MODULES_VERIFY` (0|1) — require signed modules outside dev
  - `UICP_TRUST_STORE_JSON` — inline trust store mapping key IDs → Ed25519 public keys
- Network guard
  - `VITE_NET_GUARD_ENABLED`, `VITE_NET_GUARD_MONITOR`, `VITE_GUARD_VERBOSE`
  - `VITE_GUARD_ALLOW_DOMAINS`, `VITE_GUARD_ALLOW_IPS`, `VITE_GUARD_ALLOW_IP_RANGES`, `VITE_GUARD_ALLOW_PATHS`
  - `VITE_GUARD_BLOCK_WORKERS`, `VITE_GUARD_BLOCK_SERVICE_WORKER`, `VITE_GUARD_BLOCK_WEBRTC`, `VITE_GUARD_BLOCK_WEBTRANSPORT`
  - Caps: `VITE_GUARD_MAX_REQUEST_BYTES`, `VITE_GUARD_MAX_RESPONSE_BYTES`, `VITE_GUARD_MAX_REDIRECTS`
  - URLHaus reputation: `VITE_URLHAUS_ENABLED`, `VITE_URLHAUS_AUTH_KEY`, `VITE_URLHAUS_MODE` (host|url), `VITE_URLHAUS_API_BASE`, `VITE_URLHAUS_TIMEOUT_MS`, `VITE_URLHAUS_CACHE_TTL_SEC`, `VITE_URLHAUS_RESPECT_ALLOWS`
- Model routing
  - `VITE_PLANNER_MODEL`, `VITE_ACTOR_MODEL` — explicit model selection

1) Compute sandbox: lock it down without killing UX

Keep Wasmtime + Component Model and tighten defaults.

Actions
- Time limiting: Use epoch-based interruption as the primary time budget. Verify every job store has `epoch_interruption(true)` and a live epoch pump. Add coverage that long-running jobs trap with `Compute.Timeout` within configured budgets.
- Resource limiting: Keep `StoreLimits` for memory/tables/instances with per-job caps. Fail cleanly with `Compute.Resource.Limit`. Record peak memory/table metrics for feedback.
- Component surface area: Only expose WIT interfaces actually needed per task. Audit vendored WIT and remove dead imports. Treat each component as capability scoped.
- WASI capabilities: No ambient authority. Preopen only `ws:/...` paths as read-only/read-write per job need. Keep time/random disabled by default unless explicitly permitted by policy.
- Version pinning + upgrade gate: Pin Wasmtime. Test upgrades on a branch with replayed workloads before promotion. Capture perf/overhead deltas for epoch checks and StoreLimits.
- Backpressure and quotas: Enforce blocking token-bucket quotas for guest stdout/stderr, partial events, and wasi logging. No drops; streams block in small intervals until tokens are available. Track throttle counters.
  - Defaults (tunable): stdout+stderr 256 KiB/s with 1 MiB burst; logger 64 KiB/s; partial events 30/s.

Validation
- Add integration tests that assert traps for: deadline exceeded, out-of-fuel (when enabled), memory growth beyond limit, missing export.
- Emit structured metrics per job: `durationMs`, `queueMs`, `memPeakMb`, `fuelConsumed`, `epochTicks`.
- Backpressure tests: saturate outputs and assert blocking behavior (no drops), throttle counters increment, and UI surfaces backpressure state.

Why users won’t hate this
- Time/memory ceilings are invisible during normal runs. Epoch checks add minimal overhead vs. fuel alone. The “it just runs” experience is preserved.
- Backpressure is transparent under normal load; only heavy emitters see throttling with a clear UI banner.

2) Outbound network guard (httpjail) that doesn’t break everything

Default‑deny egress with adaptive rollout. In‑app only.

Actions
- Strict allowlists for protocol, host, port, and path patterns. Reject IP literals by default, link-local/RFC1918/CGNAT ranges, metadata endpoints, and odd schemes. Block DoH/dot destinations by default (e.g., dns.google, port 853).
- Two modes per domain/route:
  - Monitor-only for new features/domains (7–14 days) with rich telemetry events (`net-guard-block` with reason, method, api).
  - Enforce once false-positive rate (FPR) < 0.1% over 7 consecutive days.
- Soft failure UX:
  - Do not brick the action. Return structured errors with reason, remediation, and a one-click “request access” path.
  - When throttling, prefer HTTP 429 with Retry-After and RateLimit headers where applicable.
- Payload/response caps: Cap request payload size, response body size, and redirects (<= 5 total) per request class.
- WebRTC/WebTransport/Workers/ServiceWorkers: Block by default unless explicitly needed and capability-gated per window.

Implementation (current)
- Default preset: Open (permissive) for new installs. Balanced and Locked remain available via Policy Viewer or env (UICP_POLICY). UICP_SAFE_MODE=1 forces Locked.
- Guard installed in-app at startup; default-allow loopback (localhost, 127.0.0.1, ::1); blocks DoH/dot, metadata IPs, and RFC1918/CGNAT by default.
- New constraints:
  - Path allowlist prefixes: `VITE_GUARD_ALLOW_PATHS=/api,/ok`
  - Request caps: `VITE_GUARD_MAX_REQUEST_BYTES` (fetch/xhr/beacon)
  - Response caps: `VITE_GUARD_MAX_RESPONSE_BYTES` (via Content-Length)
  - Redirect caps: `VITE_GUARD_MAX_REDIRECTS` (0 blocks redirected responses)
  - Realtime defaults: `VITE_GUARD_BLOCK_WEBRTC=1`, `VITE_GUARD_BLOCK_WEBTRANSPORT=1`, `VITE_GUARD_BLOCK_WORKERS=1`, `VITE_GUARD_BLOCK_SERVICE_WORKER=1`
- Adaptive rollout controller:
  - Stage: `VITE_GUARD_ROLLOUT_STAGE=monitor|enforce|auto` (default auto in dev, enforce in prod)
  - Monitor window: `VITE_GUARD_ROLLOUT_MINUTES_MONITOR` (default 30)
  - FPR threshold: `VITE_GUARD_FPR_THRESHOLD` (default 0.001)
  - Minimum attempts before FPR check: `VITE_GUARD_MIN_ATTEMPTS` (default 50)
  - Attempt sampling for low overhead: `VITE_GUARD_ATTEMPT_SAMPLE` (dev=1, prod=10 by default)
- Telemetry events:
  - `security.net_guard.block` with `{api, reason, blocks}`
  - `security.net_guard.rollout_state` with `{from,to,method,attempts,blocks,fpr,threshold}`

Validation
- Unit tests exist for most guards. Add coverage for URL canonicalization, path pattern allowlists, redirect count caps, and large payload rejection.
- Telemetry aggregation: weekly FPR, top blocked reasons, mean time to unblock (MTTU).
  - Attempt sampling event: `net-guard-attempt` (in-app CustomEvent) used for local FPR computation during monitor.

Why users won’t hate this
- Either the call succeeds or users get a clear, actionable message describing what was blocked and how to get it allowed. No mystery failures.

3) File and content handling: let users upload, without inviting chaos

Actions
- File uploads: Enforce extension allowlists, size limits, and server‑side content‑type validation. Randomize filenames. Store executables outside any web‑reachable paths. Add async malware scanning before use where applicable.
- HTML rendering: Keep strict sanitization; prefer output encoding + HTML sanitization. DOMPurify or equivalent if a library is needed.

Validation
- Add tests for file policy boundaries and sanitizer regression cases.

Why users won’t hate this
- Rich content works. Guardrails remain invisible unless an actual exploit payload is attempted.

4) Desktop/webview hardening (Tauri)

Actions
- CSP on and strict by default; disallow remote scripts. If remote pages must load, gate IPC exposure through Tauri Capabilities and per‑window allowlists (no broad globals).
- Capability allowlist: Expose minimal Rust APIs per window/webview. Treat each window as a distinct trust boundary.

Validation
- Add a capabilities audit per window. Ensure CSP reports/no violations in devtools.

Why users won’t hate this
- UI behaves the same. We just avoid giving untrusted content elevated hooks.

5) Authentication without UX pain: passkeys + step‑up, standards‑first

Actions
- Primary: Passkeys (WebAuthn) when sign‑in flows exist. Prefer device‑bound where possible; support synced/cross‑device for convenience.
- Step‑up only on risk: Map high‑risk actions to AAL2+ per NIST SP 800‑63‑4 and only trigger additional factors when signals warrant it.

Validation
- Risk mapping documented; tests for step‑up triggers on privileged actions.

Why users won’t hate this
- Most sessions have zero friction. Strong auth appears only when it matters.

6) Supply chain hygiene that doesn’t slow shipping

Actions
- SSDF (NIST SP 800‑218) as CI guardrails; start minimal and ratchet up.
- SLSA provenance: Generate provenance and use isolated builds for releases.
- Sign artifacts with Sigstore/cosign (keyless acceptable initially). Verify on install/load.
- SBOMs (SPDX or CycloneDX) per release.
- Memory‑safety roadmap: Prefer memory‑safe languages for host glue or isolate unsafe parts. Continue pushing untrusted code into Wasm.

Validation
- CI gates: security tests pass, SBOM attached, artifact signed, provenance generated before release tag.

Why users won’t hate this
- No UI impact. It reduces supply‑chain risk without changing workflows.

7) Policy tiers that fit repo conventions

Baseline mapping (aligns to `.agent-policy.yml`):
- T0 (docs, sandboxed edits): monitor‑only networking, wide latitude.
- T1 (core app logic): enforce egress allowlist; capped CPU/mem.
- T2 (migrations/infra): mandatory code review, signed artifacts, stricter egress, no dynamic module loading.
- T3 (privileged modules): manual approval + runtime attestation; no outbound network without explicit ticket.

Implementation
- Encode per‑path defaults in CI/policy. Attach run‑time gates (compute limits, egress guard) based on tier classification.

8) The UX contract: never “mysterious block,” always “guided fix”

When something is blocked, show:
- The specific rule that fired (e.g., domain not allow‑listed; payload too large; time budget exceeded).
- A safe local workaround (e.g., “download this file and attach it”).
- A one‑click capability request with autofilled context (domain, method, size, feature name).
- If an API call: 429 with Retry‑After and RateLimit headers for predictable client behavior.

9) Metrics that prove we hit the middle ground

Track weekly:
- False block rate < 0.1% of guarded actions.
- Mean time to unblock (rule update or workaround) < 24h.
- Crash/kill rate from resource limits < 0.05% of jobs.
- Time‑to‑patch for runtime/critical deps (Wasmtime, sanitizer libs) < 14 days.
- Security incidents from uploads or egress = 0 (detections + postmortems).

If a target is missed, tune thresholds or UX, not the principle.

10) Concrete next steps (low drama, high impact)

Compute (Wasmtime)
- Verify epoch timers + StoreLimits are applied for every job type; add tests that assert traps occur under configured budgets.
- Emit peak memory/table metrics; surface them in UI devtools.

Network guard
- Graduate to adaptive: ship monitor‑only for new domains with structured logs → auto‑promote to enforce when FPR < 0.1% for 7 days.
- Base allowlist policy on OWASP SSRF guidance; add strict URL parsing and canonicalization before checks.
- Wire capability toggles for WebRTC/WebTransport/Workers/ServiceWorkers per window.

Desktop/webview
- Enforce CSP and per‑window capabilities. No remote scripts by default.

Files/content
- Enforce upload rules and asynchronous scanning before use.

Auth
- Move to passkeys by default; add risk‑based step‑up mapping to NIST AALs.

Supply chain
- Generate SBOMs per release and sign artifacts with cosign; verify on install/load.
- Add SSDF checkpoints as CI gates pre‑tag.

Repo‑specific notes (observed)
- Good: version pinning, resource caps, network guard plumbing with monitorOnly, sanitization tests.
- Tighten:
  - Ensure guard blocks WebRTC/WebTransport/ServiceWorkers in the webview context unless explicitly needed (flags exist; gate via capabilities).
  - Use strict URL parsing + canonicalization pre‑allowlist to avoid parser differentials.
  - Keep WIT import surface minimal and audited; Component Model + capabilities is the right long‑term posture.
- Non‑negotiable: keep egress control in‑app only (no host firewall writes by default).

Policy + error taxonomy alignment
- Keep error code prefix `E-UICP-####` across surfaces. Example linter guard rules already use E‑UICP‑0401..0403.
- Map compute traps to taxonomy: `Compute.Timeout`, `Compute.Resource.Limit`, `Compute.CapabilityDenied`, `Task.NotFound`, `Runtime.Fault`.

30/60/90 rollout
- 30 days
  - Compute: add deadline/resource tests; expose peak metrics.
  - Network: ship monitor‑only for new domains; aggregate FPR + top reasons.
  - Desktop: enforce CSP; inventory per‑window capabilities.
  - Supply chain: SBOM generation + cosign signing (verify on load in dev).
- 60 days
  - Network: auto‑promote to enforce for routes with FPR < 0.1% for 7 days.
  - Compute: pin Wasmtime upgrade path with replay suite.
  - Files: enable async scan path on intake.
  - Auth: prototype passkeys + risk mapping for privileged actions.
- 90 days
  - CI: SSDF checkpoints as pre‑tag gates (tests pass, SBOM attached, artifact signed, provenance).
  - Desktop: per‑window capability allowlists enforced; workers/webrtc/webtransport gated.
  - Metrics: weekly dashboard with targets; tune thresholds/UX based on data.

References (canonical)
- Wasmtime: epoch interruption, StoreLimits, Component Model.
- WASI capability model; cap‑std.
- OWASP Cheat Sheet Series: SSRF prevention, file upload, XSS/output encoding.
- IETF HTTP WG: RateLimit headers, Retry‑After.
- Tauri docs: CSP, capabilities.
- WebAuthn (W3C). NIST SP 800‑63‑4 (AALs). SSDF SP 800‑218. SLSA.dev. Sigstore/cosign. SPDX/CycloneDX. CISA memory safety guidance.

Appendix A: Code anchors
- Compute epoch + limits: `uicp/src-tauri/src/compute.rs` (epoch pump, deadlines, `StoreLimits`), `policy.rs` (capability enforcement and error codes).
- Network guard: `uicp/src/lib/security/networkGuard.ts` (+ `uicp/tests/unit/network.guard.test.ts`).
- Desktop CSP/capabilities: `src-tauri/` configs.
- Sanitization tests: `docs/` and frontend tests.

Success criteria
- Users do not notice guardrails under normal use.
- Security gates are observable, explainable, and correctable without code changes in most cases.
- Weekly metrics hit targets; when they do not, we adjust thresholds/UX — not principles.
