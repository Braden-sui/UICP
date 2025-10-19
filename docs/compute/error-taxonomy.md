UICP Compute Error Taxonomy (v1)

See also: docs/error-appendix.md for the full E-UICP-#### catalog used across frontend, host, and tests.

Terminal classes (surface to Adapter/UI; non-fatal to app):

- Compute.Timeout — wall-clock deadline exceeded (epoch interruption). Include deadline and elapsed ms.
- Compute.Cancelled — user/system cancellation. Include initiator and timestamp.
- Compute.CapabilityDenied — attempted hostcall or config outside allowed capabilities (e.g., net requested without policy, fs outside workspace, timeout/mem out of range).
- Compute.Input.Invalid — failed validation against WIT-reflected schema (include path + reason).
- Task.NotFound — unknown `task@version` or module digest mismatch.
- Runtime.Fault — trap or panic within guest (include trap code/context; redact payloads).
- Compute.Resource.Limit — fuel/memory/table limits exceeded (include configured limits + observed peak where safe).
- IO.Denied — denied filesystem or network operation (policy-level denial distinct from CapabilityDenied when applicable).
- Nondeterministic — replay mismatch (hash mismatch for same `(task,input,moduleVersion,envHash)`). Hard-fail and quarantine module.

Mapping guidelines

- Prefer specific class; fall back to Runtime.Fault if trap reason is not recognized.
- Propagate typed error codes across layers; attach `jobId`, `task`, `version`, `inputHash`.
- Never suppress. Log structured error with a unique code. Keep payloads minimal and sanitized.
