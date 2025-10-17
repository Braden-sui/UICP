Type Fidelity at the Boundary (2025-10-17)

Summary
- Frozen schema package extracted to avoid import cycles and to strengthen type guarantees.
- Adapter switched to discriminated unions on `Envelope.op` for precise params without `as any`.
- Lint guard added: forbid `as any` in `uicp/src/lib/uicp/**`.
- Sanitizer moved out of the schema package to keep DOM dependencies separate.

What changed
- Schemas:
  - New: `uicp/src/lib/schema/index.ts` holds `OperationName`, `operationSchemas`, `envelopeSchema`, `batchSchema`, `validateBatch`, `validatePlan`, `computeBatchHash`, and related types (`Envelope`, `Batch`, `OperationParamMap`, etc.).
  - Compatibility: `uicp/src/lib/uicp/schemas.ts` now re-exports from the frozen package. Existing imports continue to work.
- Sanitizer:
  - `sanitizeHtmlStrict` now lives in `uicp/src/lib/sanitizer.ts` and wraps the DOMPurify-based utility in `uicp/src/lib/utils.ts`.
  - Adapter continues to sanitize at insertion time; schema still rejects dangerous HTML patterns early.
- Adapter:
  - `applyCommand()` narrows `command.params` via the `op` discriminant; removed explicit casts like `as OperationParamMap['dom.set']`.
  - Mocks detection replaced `(globalThis as any)` with a typed shape.
- Lint:
  - `uicp/eslint.config.js` enforces no `as any` within `src/lib/uicp/**` using `no-restricted-syntax`.

Why
- Prevent type erosion at the UI/compute boundary and make the op surface auditable.
- Eliminate import cycles by separating DOM-aware helpers from pure schemas.

How to import
- Preferred (frozen package):
  - `import { validateBatch, OperationName, type Envelope, type Batch } from 'uicp/src/lib/schema/index'`
- Back-compat (re-export):
  - `import { validateBatch, type Envelope, type Batch } from 'uicp/src/lib/uicp/schemas'`
- Sanitizer:
  - `import { sanitizeHtmlStrict } from 'uicp/src/lib/sanitizer'`

Developer notes
- Adding a new op: edit `uicp/src/lib/schema/index.ts` and update any WIL mappings. The re-export layer will pick it up.
- Tests referencing `sanitizeHtmlStrict` can import from `uicp/src/lib/uicp/schemas` (re-export) or directly from `uicp/src/lib/sanitizer`.
- The adapter switch over `command.op` is the single source of apply behavior; keep param usage aligned with `OperationParamMap`.

Policy link
- Enforces AGENTS.MD 7) Type fidelity at the boundary.

