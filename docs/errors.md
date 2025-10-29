# Error Codes and Handling

Last updated: 2025-10-26

Purpose: central reference for user-facing error codes and their sources.

Typescript (LLM and bridge)
- LLM error codes (uicp/src/lib/llm/errors.ts):
  - Tooling: E-UICP-0100..0106 (timeouts, parse failures, collection failures)
  - Planner/Actor: E-UICP-1200..1213 (missing models, empty responses, failures)
  - Streams: E-UICP-1220..1223
  - Spec parsing/normalization: E-UICP-0420..0421
  - Task spec: E-UICP-1240..1242
  - Unknown: E-UICP-1299
- Bridge errors (uicp/src/lib/bridge/result.ts):
  - E-UICP-0100 BridgeUnavailable
  - E-UICP-0101 InvokeFailed
  - E-UICP-0102 EventListenerFailed
  - E-UICP-0300..0302 Sanitization/Validation
  - E-UICP-0400..0402 Adapter/State/Component
  - E-UICP-0500..0507 Compute
  - E-UICP-0999 Unknown

Rust (Compute and Providers)
- Compute runtime error codes (uicp/src-tauri/src/compute.rs::error_codes):
  - Compute.Timeout, Compute.Cancelled, Compute.CapabilityDenied, Compute.Input.Invalid,
    Task.NotFound, Runtime.Fault, Compute.Resource.Limit, IO.Denied
- Provider CLI and code providers:
  - provider_cli.rs: E-UICP-1500..1507
  - code_provider.rs: E-UICP-1400..1406

Conventions
- All errors include a stable code and a message. Messages may include contextual detail that is safe for logs and UI.
- Codes follow the repo convention `E-<REPO>-####`.

Testing
- Unit tests assert codes for tool collection and timeouts (see uicp/src/lib/llm/collectToolArgs.test.ts).

---

## Code Ranges (canonical)

- E-UICP-0100–0199: Collector (tool collection and streaming assembly)
  - Examples: CollectionTimeout (0100), CollectionFailed (0101)
- E-UICP-0200–0299: Queue/Apply lifecycle
- E-UICP-0300–0399: Orchestrator transition/handshake
- E-UICP-0400–0499: Linter and first-render validators
  - 0401 No visible effect
  - 0402 Dangling selectors
  - 0403 Inert text-only appends
  - 0406 First render must target #root or create a window
  - 0407 Window id consistency required
- E-UICP-1200–1299: Provider mapping/transport (auth, rate limit, upstream schema)
  - AuthMissing, AuthInvalid, RateLimited, TransportTimeout
- E-UICP-1300–1399: Protocol violations (ProblemDetail v1)
  - SchemaMismatch, UnsupportedRole, UnsupportedField

Notes:
- Codes follow the repo convention `E-<REPO>-####` where `<REPO>` is UICP.
- Prefer typed errors with stable codes; messages may include safe context for UI and logs.

## ProblemDetail v1 (typed error surface)

Use this structure for UI and diagnostics when surfacing provider/protocol failures:

- `ProblemDetail { code: string; category: 'auth'|'policy'|'rate_limit'|'transport'|'schema'; http_status?; retryable?; upstream_code?; detail?; hint? }`

Helpers (frontend):
- `isProblemDetail()`: runtime guard
- `mapProviderErrorToProblemDetail()`: normalize provider-shaped errors
- `makeProblemDetailFromHttp()`: construct from HTTP status and message

See: `uicp/src/lib/llm/protocol/errors.ts`.
