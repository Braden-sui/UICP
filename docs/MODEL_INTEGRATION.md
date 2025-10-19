# Model Integration

Last updated: 2025-01-19

Purpose
- Single place to capture model/provider integration notes and validation.

Tool Calling Verification (Ollama)
- See consolidated guidance here; the detailed walkthrough previously lived under `docs/compute/OLLAMA_TOOL_CALLING_VERIFICATION.md`.
- Checklist:
  - Validate JSON/tool‑call shapes against `uicp/src/lib/llm/tools.ts` and `collectToolArgs.ts`
  - Verify planner/actor profiles and fallbacks (`uicp/src/lib/llm/profiles.ts`, `collectWithFallback.ts`)
  - Ensure error surfaces propagate to chat system messages with actionable codes
  - Add or update tests under `uicp/tests/unit/ollama/*`

Notes
- Keep provider‑specific, deep dives in provider‑named sections here instead of scattering under compute.

