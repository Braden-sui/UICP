How to Add a WIL Operation

Goal
- Add or extend a WIL op so models can express it with words and the system maps it to typed ops deterministically.

Steps
1) Define/confirm the op schema (typed params)
   - Edit `uicp/src/lib/uicp/schemas.ts` if it’s a new op (or confirm existing shape).
   - Keep params minimal and explicit; prefer enums for closed sets.

2) Add lexicon templates
   - Edit `uicp/src/lib/wil/lexicon.ts` under the matching op key.
   - Add verbs (canonical + synonyms) and templates with `{slot}` placeholders.
   - Prefer specific templates first (e.g., WxH) to avoid over‑capture.
   - Add `skip` words for polite noise.

3) Slot post‑processing (if needed)
   - Edit `uicp/src/lib/wil/parse.ts` to coerce special cases (e.g., `size WxH` → width/height).
   - Avoid heavy logic; Zod schemas remain the final guard.

4) Validate and map
   - `toOp` in `uicp/src/lib/wil/map.ts` already validates via `operationSchemas`.
   - Only add light coercion in `coerceFor` if necessary.

5) Tests
   - Add unit tests under `uicp/tests/unit/wil/*.test.ts` with example utterances → op params.
   - For ranges (numbers), add a small table or property-like loop.

6) Docs & prompts (optional)
   - Add examples to `docs/compute/WIL_QUICKSTART.md`.
   - If helpful, reference common patterns in `uicp/src/prompts/actor.txt` (Actor only).

Notes
- Planner never emits WIL; only the Actor uses it. The Orchestrator parses WIL → typed ops.
- Keep templates concise; avoid ambiguity. Add synonyms when they add clarity.

