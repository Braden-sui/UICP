# How to Add a WIL Operation (Superseded)

NOTE: This document is consolidated into `docs/compute/WIL.md`.

## Goal

- Add or extend a WIL op so models can express it with words and the system maps it to typed ops deterministically.

## Steps

1. **Define or confirm the op schema (typed params)**
   - Edit `uicp/src/lib/schema/index.ts` (frozen schema package). `uicp/src/lib/uicp/schemas.ts` re-exports from this package for backward compatibility.
   - Keep params minimal and explicit; prefer enums for closed sets.

2. **Add lexicon templates**
   - Edit `uicp/src/lib/wil/lexicon.ts` under the matching op key.
   - Add verbs (canonical + synonyms) and templates with `{slot}` placeholders.
   - Prefer specific templates first (e.g., WxH) to avoid over-capture.
   - Add `skip` words for polite noise.

3. **Handle slot post-processing (if needed)**
   - Edit `uicp/src/lib/wil/parse.ts` to coerce special cases (e.g., `size WxH` → width/height).
   - Avoid heavy logic; Zod schemas remain the final guard.

4. **Validate and map**
   - `toOp` in `uicp/src/lib/wil/map.ts` already validates via `operationSchemas`.
   - Only add light coercion in `coerceFor` if necessary.

5. **Add tests**
   - Add unit tests under `uicp/tests/unit/wil/*.test.ts` with example utterances → op params.
   - For ranges (numbers), add a small table or property-like loop.

6. **Update docs and prompts (optional)**
   - Add examples to `docs/compute/WIL.md` (Quick Reference section).
   - If helpful, reference common patterns in `uicp/src/prompts/actor.txt` (Actor only).

## Notes

- Planner never emits WIL; only the Actor uses it. The Orchestrator parses WIL → typed ops.
- Keep templates concise; avoid ambiguity. Add synonyms when they add clarity.
