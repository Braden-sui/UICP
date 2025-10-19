# WIL: Words → Intent → LEXICON

## Summary
Deterministic, typed mapping from constrained natural language to UICP operations. Words are the contract. Templates and slots bind directly to `operationSchemas` (frozen in `uicp/src/lib/schema/index.ts`, re-exported via `uicp/src/lib/uicp/schemas.ts`).

## Key Files
- `uicp/src/lib/wil/lexicon.ts` — typed lexicon, exhaustive over `OperationNameT`.
- `uicp/src/lib/wil/parse.ts` — deterministic template matcher and slot post‑processing.
- `uicp/src/lib/wil/map.ts` — slot → Zod schema validation via `operationSchemas`.
- Tests: `uicp/tests/unit/wil/lexicon_and_parse.test.ts`.

## Usage
Feed the model a single line that follows a template (e.g., `open url https://example.com`). Call `parseUtterance(text)` then `toOp(parsed)` to get `{ op, params }` validated by Zod.

## CI Gates
The lexicon uses `satisfies` and a type test to enforce full coverage of `OperationNameT`. Any new op added to the schema package (`uicp/src/lib/schema/index.ts`) must be reflected in `lexicon.ts` or the TS/type test will fail.

## Notes
Parser removes lightweight "polite" prefixes (e.g., `please`) and supports common variations. URL, numbers, and JSON-typed fields are coerced before final Zod validation.

---

## Quick Reference

### Actor Contract
Output WIL only. One command per line. No commentary. Stop on first `nop:`.

### Window Operations

**window.create**
```
create window title "Notes" width 1200 height 800
create window title "Notes" size 1200x800
create window title "Notes" at 80,120
```

**window.update**
```
update window win-notes title "Notes v2"
update window win-notes width 800 height 600
move window win-notes to 120,80
resize window win-notes to 1200x800
```

### DOM Operations

**dom.set / dom.replace / dom.append**
```
set html in "#root" of window win-notes to "<div>Ready</div>"
replace html in "#root" of window win-notes with "<div>Fresh</div>"
append html in "#list" of window win-notes with "<li>Item</li>"
```

### Component Operations

**component.render**
```
render component panel in window win-notes at "#root"
mount panel in "#root"
```

### State Operations

**state.set / state.get / state.watch / state.unwatch**
```
set state key user to {"name":"Ada"} in window
get state key user in window
watch state key user in window
unwatch state key user in window
```

### HTTP/URL Operations

**open.url / api.request**
```
open url https://example.com
visit https://example.com
go to https://example.com
api GET https://api.example.com/v1/status
```

### Nop Lines (Stop Batch)
```
nop: missing <slot>
nop: invalid <slot>
nop: blocked <capability>
nop: budget exhausted
nop: batch capped
nop: invalid WIL line
```

### Constraints
Default: 50 lines (hard cap: 200). Truncation appends `nop: batch capped`.
