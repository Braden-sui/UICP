# Adapter.Lifecycle.ts Refactor Plan

## Status: PR 0 Complete ✅

**Objective**: Replace `adapter.lifecycle.ts` monolith (1736 lines) with thin orchestrator + specialized modules.

**Constraint**: Zero behavior change. Identical outcomes behind feature flag until test parity proven.

## Non-Negotiable Invariants

1. **Security**: No inline JS. Only sanitized HTML via `sanitizeHtmlStrict`. URL allowlist: https and mailto only.
2. **Permission**: Default deny. Human approval required for gated ops unless policy allows.
3. **Idempotency**: Applying same batch twice changes nothing the second time.
4. **Determinism**: Given same envelopes, windows and DOM end state are identical.
5. **Type Safety**: No untyped `any`. Strict TS config. No eslint disable blocks without file-level justification.
6. **Telemetry**: Preserve existing fields. New fields only behind versioned schema key (`adapter_version: 2`).
7. **No Placeholders**: Unknown component types render neutral invisible frame, never visible text.

## Repository Layout (Target State)

```
src/lib/uicp/adapters/
  adapter.ts                  // Public API (re-exports)
  adapter.featureFlags.ts     // ✅ PR 0: Feature flag logic
  adapter.lifecycle.ts        // Legacy monolith (kept for fallback)
  
  # New modular implementation:
  lifecycle.ts                // PR 7: Thin orchestrator
  adapter.types.ts            // PR 1: Shared types and enums
  adapter.schema.ts           // PR 1: Zod validation schemas
  adapter.errors.ts           // PR 1: Error classes and codes
  windowManager.ts            // PR 2: Window lifecycle
  domApplier.ts               // PR 3: DOM operations
  componentRenderer.ts        // PR 4: Component factory
  permissionGate.ts           // PR 5: Permission checks
  adapter.telemetry.ts        // PR 6: Telemetry helpers
```

## PR Sequence

### ✅ PR 0: Prep (COMPLETE)

**Goal**: Add feature flag without behavior change.

**Changes**:
- Created `adapter.featureFlags.ts` with `UICP_ADAPTER_V2` flag (default: false)
- Documented flag in `adapter.ts` with re-export
- Added `getAdapterVersion()` helper for telemetry

**Acceptance Criteria**:
- ✅ Flag defaults to false (legacy path active)
- ✅ Exported from public API
- ✅ CI green (no behavior change)

---

### PR 1: Types and Schemas

**Goal**: Extract all type definitions and validation logic.

**Files to Create**:

#### `adapter.types.ts`
```typescript
export type WindowId = string;
export type ComponentId = string;
export type OperationKind = 
  | 'window.create' | 'window.move' | 'window.resize' 
  | 'window.focus' | 'window.close'
  | 'dom.apply' | 'component.render';

export interface Envelope {
  id: string;
  op: OperationKind;
  params: unknown;
  timestamp: number;
  idempotencyKey?: string;
  traceId?: string;
  txnId?: string;
}

export interface ApplyOutcome {
  envelopeId: string;
  batchId?: string;
  applied: number;
  skippedDuplicates: number;  // Renamed from skippedDupes
  deniedByPolicy: number;
  errors: AdapterErrorReport[];
}

export interface AdapterErrorReport {
  opIndex: number;
  code: AdapterErrorCode;
  message: string;
}

// Extract all param types from current OperationParamMap
export interface CreateWindowParams { /* ... */ }
export interface MoveWindowParams { /* ... */ }
export interface ResizeWindowParams { /* ... */ }
export interface FocusWindowParams { /* ... */ }
export interface CloseWindowParams { /* ... */ }
export interface DomApplyParams { /* ... */ }
export interface ComponentRenderParams { /* ... */ }
```

#### `adapter.errors.ts`
```typescript
export type AdapterErrorCode =
  | 'Adapter.InvalidEnvelope'
  | 'Adapter.ValidationFailed'
  | 'Adapter.PermissionDenied'
  | 'Adapter.WindowNotFound'
  | 'Adapter.DomApplyFailed'
  | 'Adapter.ComponentUnknown'
  | 'Adapter.Internal';

export class AdapterError extends Error {
  constructor(
    public code: AdapterErrorCode,
    message: string,
    public context?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

export const createErrorReport = (
  opIndex: number,
  code: AdapterErrorCode,
  error: unknown
): AdapterErrorReport => ({
  opIndex,
  code,
  message: error instanceof Error ? error.message : String(error),
});
```

#### `adapter.schema.ts`
```typescript
import { z } from 'zod';
import type { Envelope, Operation } from './adapter.types';

export const EnvelopeSchema = z.object({
  id: z.string(),
  op: z.string(),
  params: z.unknown(),
  timestamp: z.number(),
  idempotencyKey: z.string().optional(),
  traceId: z.string().optional(),
  txnId: z.string().optional(),
});

export const CreateWindowParamsSchema = z.object({
  id: z.string().optional(),
  title: z.string(),
  size: z.enum(['sm', 'md', 'lg', 'xl', 'full']).optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  zIndex: z.number().optional(),
});

// ... schemas for all operation params

export const validateEnvelope = (input: unknown): Envelope => {
  const result = EnvelopeSchema.safeParse(input);
  if (!result.success) {
    throw new AdapterError('Adapter.InvalidEnvelope', result.error.message);
  }
  return result.data as Envelope;
};
```

**Tests Required**:
- ✅ Valid envelope passes validation
- ✅ Invalid envelope throws `Adapter.InvalidEnvelope`
- ✅ All param schemas tested with valid + invalid samples
- ✅ 100% branch coverage in validation logic
- ✅ Error report factory produces correct structure

**Acceptance Criteria**:
- All types extracted from legacy code
- Zod schemas validate every field
- No `any` types in module
- CI gates enforce no `any` in `adapters/` folder
- Coverage: 100% for schema files

---

### PR 2: WindowManager

**Goal**: Extract window lifecycle logic into isolated module.

**File**: `windowManager.ts`

```typescript
export interface WindowManager {
  create(p: CreateWindowParams): Promise<WindowId>;
  move(p: MoveWindowParams): Promise<void>;
  resize(p: ResizeWindowParams): Promise<void>;
  focus(p: FocusWindowParams): Promise<void>;
  close(p: CloseWindowParams): Promise<void>;
  exists(id: WindowId): boolean;
  list(): Array<{ id: string; title: string }>;
}

export const createWindowManager = (root: HTMLElement): WindowManager => {
  const windows = new Map<WindowId, WindowRecord>();
  
  return {
    async create(params) {
      // Clamp coordinates to desktop bounds
      // Register window
      // Emit lifecycle event
      // Return window ID
    },
    
    async move(params) {
      // Validate window exists
      // Clamp coordinates
      // Apply if different (idempotent)
    },
    
    // ... other methods
  };
};
```

**Tests Required**:
- ✅ `create()` with valid params succeeds
- ✅ `create()` with negative coordinates clamps to 0
- ✅ `create()` with overflow coordinates clamps to desktop bounds
- ✅ `move()` on same position is idempotent (returns 0 changes)
- ✅ `move()` on nonexistent window throws `Adapter.WindowNotFound`
- ✅ `resize()` clamps min/max dimensions
- ✅ `focus()` updates z-index deterministically
- ✅ `close()` removes window and emits lifecycle event
- ✅ `exists()` returns correct boolean
- ✅ Concurrent create + move resolves deterministically

**Acceptance Criteria**:
- No HTML/sanitization logic in module
- All coordinates clamped
- Operations idempotent
- Coverage ≥90% lines, ≥80% branches

---

### PR 3: DomApplier

**Goal**: Extract DOM mutation logic with security guarantees.

**File**: `domApplier.ts`

```typescript
export interface DomApplier {
  apply(params: DomApplyParams): Promise<{ applied: number; skippedDuplicates: number }>;
}

export const createDomApplier = (windowManager: WindowManager): DomApplier => {
  const opHashes = new Map<string, string>(); // For deduplication
  
  return {
    async apply(params) {
      // 1. Validate window exists
      // 2. Sanitize HTML via sanitizeHtmlStrict
      // 3. Compute content hash
      // 4. Check dedupe (return skippedDuplicates if identical)
      // 5. Apply DOM mutation
      // 6. Store hash
      // 7. Return { applied: 1, skippedDuplicates: 0 }
    },
  };
};
```

**Security Tests Required** (Mandatory):
- ✅ `<script>alert('xss')</script>` → stripped
- ✅ `<img src=x onerror=alert('xss')>` → onerror removed
- ✅ `<a href="javascript:alert('xss')">` → href removed
- ✅ `<a href="data:text/html,<script>">` → href removed
- ✅ `<a href="mailto:user@example.com">` → allowed
- ✅ `<a href="https://example.com">` → allowed
- ✅ `<style>body { background: url('javascript:...') }</style>` → stripped
- ✅ CSS `expression()` IE exploit → stripped
- ✅ Duplicate DOM op increments `skippedDuplicates`

**Property Tests** (Minimum 1000 cases):
- Random HTML strings through sanitizer
- Assert: No `<script`, `onerror=`, `javascript:`, or `data:` in output
- Assert: All `href` and `src` match `/^(https:|mailto:)/`

**Acceptance Criteria**:
- All strings sanitized via `sanitizeHtmlStrict`
- Duplicate detection via stable hash
- Property tests pass 1000+ seeds
- Coverage ≥90% lines, ≥80% branches

---

### PR 4: ComponentRenderer

**Goal**: Extract component factory. Remove visible placeholders.

**File**: `componentRenderer.ts`

```typescript
type ComponentFactory = (params: ComponentRenderParams) => string;

export interface ComponentRenderer {
  render(params: ComponentRenderParams): Promise<void>;
}

export const createComponentRenderer = (
  domApplier: DomApplier,
  telemetry: AdapterTelemetry
): ComponentRenderer => {
  const registry: Record<string, ComponentFactory> = {
    'button': renderButton,
    'form': renderForm,
    'table': renderTable,
    'chart': renderChart,
    // ... all known types
  };
  
  return {
    async render(params) {
      const factory = registry[params.type.toLowerCase()];
      
      if (!factory) {
        // Unknown type: render neutral invisible frame
        telemetry.event('adapter.component.unknown', { type: params.type });
        const neutralHtml = '<div data-component-unknown="true" style="display:none"></div>';
        await domApplier.apply({ ...params, html: neutralHtml });
        return;
      }
      
      const html = factory(params);
      await domApplier.apply({ ...params, html });
    },
  };
};
```

**Tests Required**:
- ✅ Known component types render without error
- ✅ Unknown type renders neutral frame (invisible, no text)
- ✅ Unknown type emits `adapter.component.unknown` telemetry
- ✅ Unknown type does NOT contain visible placeholder text
- ✅ Registry lookup is case-insensitive

**Acceptance Criteria**:
- No visible "Prototype component" or similar text
- Unknown components log telemetry
- Coverage ≥90% lines

---

### PR 5: PermissionGate

**Goal**: Centralize permission checks.

**File**: `permissionGate.ts`

```typescript
export type PermissionScope = 
  | 'api.call'
  | 'fs.write'
  | 'compute.execute'
  | 'window.create';

export interface PermissionContext {
  operation: OperationKind;
  params: unknown;
  traceId?: string;
}

export interface PermissionGate {
  require(scope: PermissionScope, context: PermissionContext): Promise<'granted' | 'denied'>;
}

export const createPermissionGate = (): PermissionGate => {
  return {
    async require(scope, context) {
      // Call existing checkPermission logic
      // Orchestrate GrantModal if needed
      // Return 'granted' or 'denied'
    },
  };
};
```

**Tests Required** (Table-Driven):
- ✅ All scopes default to deny without user approval
- ✅ User grants permission → 'granted'
- ✅ User denies permission → 'denied'
- ✅ Session policy (temporary grant) works
- ✅ Forever policy (permanent grant) persists

**Acceptance Criteria**:
- Table test iterates all scopes
- Default deny verified
- Coverage ≥90% lines

---

### PR 6: AdapterTelemetry

**Goal**: Centralize telemetry emission.

**File**: `adapter.telemetry.ts`

```typescript
export interface AdapterTelemetry {
  time<T>(name: string, f: () => Promise<T>, fields?: Record<string, unknown>): Promise<T>;
  event(name: string, fields?: Record<string, unknown>): void;
  error(name: string, err: unknown, fields?: Record<string, unknown>): void;
}

export const createAdapterTelemetry = (): AdapterTelemetry => {
  return {
    async time(name, f, fields) {
      const start = performance.now();
      try {
        const result = await f();
        const durationMs = Math.round(performance.now() - start);
        emitTelemetryEvent(name, { ...fields, durationMs, adapter_version: 2 });
        return result;
      } catch (error) {
        const durationMs = Math.round(performance.now() - start);
        this.error(name, error, { ...fields, durationMs });
        throw error;
      }
    },
    
    event(name, fields) {
      emitTelemetryEvent(name, { ...fields, adapter_version: 2 });
    },
    
    error(name, err, fields) {
      const message = err instanceof Error ? err.message : String(err);
      emitTelemetryEvent(name, { ...fields, error: message, adapter_version: 2 });
    },
  };
};
```

**Tests Required**:
- ✅ `time()` measures duration correctly
- ✅ `time()` includes `adapter_version: 2`
- ✅ `event()` emits with correct fields
- ✅ `error()` captures error message
- ✅ Snapshot tests for payload shapes

**Acceptance Criteria**:
- All events include `adapter_version: 2`
- Existing field names preserved
- Coverage ≥90% lines

---

### PR 7: Lifecycle Orchestrator

**Goal**: Wire all modules into thin orchestrator.

**File**: `lifecycle.ts` (NEW, not replacing legacy)

```typescript
import type { Envelope, ApplyOutcome } from './adapter.types';
import { validateEnvelope } from './adapter.schema';
import { createWindowManager } from './windowManager';
import { createDomApplier } from './domApplier';
import { createComponentRenderer } from './componentRenderer';
import { createPermissionGate } from './permissionGate';
import { createAdapterTelemetry } from './adapter.telemetry';

export const applyEnvelope = async (envelope: unknown): Promise<ApplyOutcome> => {
  const telemetry = createAdapterTelemetry();
  
  return telemetry.time('adapter.apply', async () => {
    // 1. Validate envelope
    const validated = validateEnvelope(envelope);
    
    // 2. Initialize modules
    const windowManager = createWindowManager(workspaceRoot!);
    const domApplier = createDomApplier(windowManager);
    const componentRenderer = createComponentRenderer(domApplier, telemetry);
    const permissionGate = createPermissionGate();
    
    // 3. Route operation to correct module
    const outcome: ApplyOutcome = {
      envelopeId: validated.id,
      applied: 0,
      skippedDuplicates: 0,
      deniedByPolicy: 0,
      errors: [],
    };
    
    switch (validated.op) {
      case 'window.create':
        // Check permission
        // Call windowManager.create()
        // Update outcome
        break;
      
      case 'dom.apply':
        // Call domApplier.apply()
        // Update outcome
        break;
      
      case 'component.render':
        // Call componentRenderer.render()
        // Update outcome
        break;
      
      // ... other operations
    }
    
    return outcome;
  });
};
```

**Tests Required**:
- ✅ Small envelope with 1 window.create → correct outcome
- ✅ Envelope with unknown op → error in outcome
- ✅ Permission denied → deniedByPolicy incremented
- ✅ Duplicate op → skippedDuplicates incremented
- ✅ No direct DOM/window API calls in lifecycle.ts
- ✅ All operations route to correct module

**Acceptance Criteria**:
- No direct DOM manipulation
- Only calls WindowManager, DomApplier, ComponentRenderer, PermissionGate
- Coverage ≥90% lines

---

### PR 8: Integration Parity

**Goal**: Prove v1 and v2 produce identical outcomes.

**Tests Required**:
- ✅ Run known scenario through v1 (flag off)
- ✅ Run same scenario through v2 (flag on)
- ✅ Assert identical:
  - Window count
  - Window positions and sizes
  - Window z-orders
  - DOM snapshots (normalized)
  - Telemetry counter values (modulo `adapter_version`)
- ✅ Race test: Concurrent batches → deterministic outcome
- ✅ Performance test: v2 within 10% of v1 (fail if >20% slower)

**Acceptance Criteria**:
- Integration tests pass for both flag states
- Outcomes match exactly
- Performance delta ≤10%

---

### PR 9: Flip Default

**Goal**: Enable v2 by default after proving parity.

**Changes**:
- Set `ADAPTER_V2_ENABLED` default to `true` in `adapter.featureFlags.ts`
- Update README with architecture diagram
- Document rollback procedure

**Acceptance Criteria**:
- All tests green with flag on
- Manual smoke test green
- Rollback plan documented

---

## Testing Matrix

### Unit Tests (Per Module)
- Happy paths for all public methods
- Error cases (invalid input, not found, denied)
- Idempotency verification
- Boundary conditions (negative coords, overflow, empty strings)

### Property Tests
- `domApplier`: 1000+ random HTML strings, assert sanitizer never leaks unsafe content
- `adapter.schema`: Fuzz envelopes with extra fields, assert strict validation

### Integration Tests
- End-to-end: create windows, apply DOM, render components, resize, close
- Replay: apply same envelope twice, assert `skippedDuplicates` increments
- Flag toggle: compare v1 and v2 outcomes
- Concurrency: race two batches, assert deterministic winner

### Security Tests (Mandatory)
- Script injection attempts (blocked)
- Event handler attributes (stripped)
- `javascript:` and `data:` URLs (blocked)
- `https:` and `mailto:` URLs (allowed)
- CSS `expression()` and `url('javascript:...')` (stripped)

### Performance Tests
- 100 sequential batches: v2 ≤ 110% of v1 time (fail if >120%)

---

## CI Gates

1. **No `any` types** in `src/lib/uicp/adapters/*.ts`
2. **Coverage thresholds**: ≥90% lines, ≥80% branches
3. **Property tests**: Minimum 1000 seeds
4. **Lint rule**: No importing UI components from `lifecycle.ts`
5. **Danger check**: Prevent adding visible placeholder strings

---

## Rollback Plan

1. Feature flag `UICP_ADAPTER_V2` stays for ≥2 releases
2. If red metrics appear, flip flag to `false` (legacy path)
3. Open incident issue linking failing tests/logs
4. Keep both codepaths until 2 incident-free production releases

---

## Documentation Updates

### README.md
Add diagram: `Message → Plan → Batch → Apply`
Label: Planner, Actor, Adapter

### USER_GUIDE.md
Glossary entries:
- Envelope: Single operation unit
- Batch: Collection of envelopes
- Operation: Typed action (window.create, dom.apply, etc.)
- Idempotency: Applying same batch twice = no change
- Permission scope: Category requiring user approval

### SECURITY.md
Document:
- Sanitizer rules (`sanitizeHtmlStrict`)
- URL allowlist (https, mailto only)
- Default-deny permission model

---

## Current Status

**✅ PR 0 Complete**: Feature flag wiring added without behavior change.

**Next Step**: PR 1 - Extract types, schemas, and error classes.
