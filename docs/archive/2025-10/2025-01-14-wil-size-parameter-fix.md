# WIL Size Parameter Contract Fix

**Date**: 2025-01-14  
**Status**: Completed  
**Type**: Bug Fix

## Problem

Contract mismatch between WIL documentation, parser templates, and Zod validator caused agent-generated "create window" commands to fail silently.

### Root Cause

1. **Documentation** (`docs/compute/WIL_QUICKSTART.md`) showed:
   ```
   create window title "Notes" size 1200x800
   ```

2. **Lexicon** (`uicp/src/lib/wil/lexicon.ts`) accepted it:
   ```typescript
   "create window title {title} size {size}"
   ```

3. **Parser** (`uicp/src/lib/wil/parse.ts`) had partial handling in postProcess that converted "1200x800" to width/height

4. **Schema** (`uicp/src/lib/uicp/schemas.ts` → re-exports from `uicp/src/lib/schema/index.ts`) only accepted preset tokens:
   ```typescript
   size: z.enum(['xs','sm','md','lg','xl']).optional()
   ```

**Result**: Agents generated valid-looking WIL, parser extracted slots, but Zod validation rejected anything that wasn't a preset token. Windows weren't created.

## Solution

Implemented defense-in-depth approach with three layers:

### 1. Mapper-Level Size Splitting (map.ts)

Added size dimension string parsing in `coerceFor()`:
```typescript
if (typeof result.size === 'string') {
  const match = /^(\d+)\s*x\s*(\d+)$/i.exec(result.size);
  if (match) {
    result.width = Number(match[1]);
    result.height = Number(match[2]);
    delete result.size; // Avoid schema clash
  }
}
```

This complements existing postProcess logic and catches edge cases.

### 2. Dimension Clamping (map.ts)

Added `clampDimension()` to enforce schema minimum:
```typescript
function clampDimension(n: number | undefined): number | undefined {
  return typeof n === 'number' ? Math.max(120, n) : undefined;
}
```

Applied to width/height to prevent `min(120)` Zod failures when agents suggest small dimensions.

### 3. Extended Verb Support (lexicon.ts)

Added "new" to window.create verbs and expanded templates:
```typescript
verbs: ["create", "make", "open", "new"]
templates: [
  // ... existing create templates
  "new window title {title} width {width} height {height}",
  "new window title {title} size {size}",
  "new window title {title} at {x},{y}",
  "new window title {title}",
  "make window title {title} width {width} height {height}",
  // ...
]
```

Agents often say "new window" instead of "create window".

## Testing

Added comprehensive test suite: `tests/unit/wil/window-create-size.test.ts`

Covers:
- Size WxH format parsing and validation
- New verb variations
- Whitespace handling in size strings
- Dimension clamping (80x60 -> 120x120)
- Preset size values (xs, sm, md, lg, xl)
- Mixed explicit dimensions
- Position parameters
- Invalid size format rejection

All tests pass. Existing WIL tests remain green.

## Files Changed

- `uicp/src/lib/wil/map.ts`: Added size splitting and dimension clamping
- `uicp/src/lib/wil/lexicon.ts`: Added "new" verb and additional templates
- `uicp/tests/unit/wil/window-create-size.test.ts`: Comprehensive test coverage

## Backward Compatibility

Fully backward compatible:
- Existing width/height syntax unchanged
- Preset size values (xs, sm, md, lg, xl) still work
- Size WxH format now works end-to-end
- Invalid formats fail fast with clear errors (no silent failures)

## Follow-up Considerations

1. **Workspace Registration Timing**: Already handled by `ensureWindowExists()` in adapter.ts, which auto-creates shells for missing windows. No additional guard needed.

2. **Schema Evolution**: The `size` enum field could be removed in a future simplification pass if only dimensional values are used in practice. Current approach keeps both presets and WxH for maximum flexibility.

3. **Agent Prompting**: Update agent system prompts to prefer the now-validated "size WxH" format for consistency.

## Rationale

Per global rules #14 and #15: No silent errors, extensive testing. This fix surfaces validation failures explicitly while providing defensive coercion to make valid agent output succeed.
