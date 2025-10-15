# Error Handling Refactor – Verification Notes

**Last Verified**: 2025-01-14  
**Reviewer**: Codex (GPT-5 agent)  
**Scope**: Cross-check documented error-handling refactor against current UICP implementation.

---

## Summary

- UI lifecycle and bridge paths now fail loud: invalid `data-command` payloads throw `E-UICP-301` errors and abort the triggering event, and iterator teardown logs `E-UICP-401` when `unlisten` fails.
- JSON recovery helpers (e.g., `tryRecoverJsonFromAttribute` in `uicp/src/lib/uicp/cleanup.ts`) remain intentionally: they repair planner artefacts before validation while still rejecting payloads that cannot be parsed after recovery. This deviation is documented below.
- With those adjustments, the shipped behaviour matches the policy: no silent catch-and-continue paths remain in adapter event handling or the LLM iterator.

---

## Confirmed Improvements

- **Window lifecycle**: `emitWindowEvent` now aggregates listener errors and throws (`uicp/src/lib/uicp/adapter.ts:24`).
- **Deterministic serialization**: `stableStringify` no longer falls back to lossy stringification (`uicp/src/lib/uicp/adapter.ts:41`).
- **Pointer capture**: UI components removed the try/catch wrappers around `releasePointerCapture`, matching the doc (`uicp/src/components/DesktopWindow.tsx:61`, `uicp/src/components/DesktopIcon.tsx:78`).
- **Compute bridge**: Cancellation and debug wiring now emit explicit `console.error` entries on failure (`uicp/src/lib/bridge/tauri.ts:209`, `uicp/src/lib/bridge/tauri.ts:596`).
- **LLM streaming**: Abort/timeout handlers log backend cancellation failures (`uicp/src/lib/llm/ollama.ts:332`, `uicp/src/lib/llm/ollama.ts:358`).

---

## Deviations (Documented)

- **JSON recovery helpers**: We keep the narrow recovery logic that strips stray bracket artefacts and restores minimalist JSON (see `uicp/tests/unit/cleanup.test.ts`). Recovery runs before Zod validation; if the payload is still invalid, the handler throws `E-UICP-301`. Rationale: the planner occasionally emits trivial quote fixes, and patching them here prevents needless UX regressions without masking deeper issues.

No other exceptions remain.

---

## References

- Global Rules: #14 "DO NOT LAZILY USE EXCEPTIONS THAT CAN SILENCE ERRORS"
- Global Rules: #1 "Zero tolerance for silent errors or hidden failures"
- Related doc: `docs/2025-01-14-workspace-registration-guard.md`
