WIL: Words → Intent → LEXICON

Summary
- Deterministic, typed mapping from constrained natural language to UICP operations.
- Words are the contract. Templates and slots bind directly to `operationSchemas` in `uicp/src/lib/uicp/schemas.ts`.

Key files
- `uicp/src/lib/wil/lexicon.ts` — typed lexicon, exhaustive over `OperationNameT`.
- `uicp/src/lib/wil/parse.ts` — deterministic template matcher and slot post‑processing.
- `uicp/src/lib/wil/map.ts` — slot → Zod schema validation via `operationSchemas`.
- Tests: `uicp/tests/unit/wil/lexicon_and_parse.test.ts`.

Usage
- Feed the model a single line that follows a template (e.g., `open url https://example.com`).
- Call `parseUtterance(text)` then `toOp(parsed)` to get `{ op, params }` validated by Zod.

CI gates
- The lexicon uses `satisfies` and a type test to enforce full coverage of `OperationNameT`.
- Any new op added to `schemas.ts` must be reflected in `lexicon.ts` or the TS/type test will fail.

Notes
- Parser removes lightweight “polite” prefixes (e.g., `please`) and supports common variations.
- URL, numbers, and JSON-typed fields are coerced before final Zod validation.

