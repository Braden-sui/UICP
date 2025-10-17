# Workspace Registration Race Condition Guard

**Date**: 2025-01-14  
**Status**: Completed  
**Type**: Bug Fix (Race Condition)

## Problem

Race condition where batches could arrive before Desktop.tsx registers the workspace root, causing "Workspace root not registered" errors.

### Timeline of Race

```
1. main.tsx: initializeTauriBridge() runs
2. Bridge: listen('ollama-completion'), listen('compute-result-final'), etc.
3. Events arrive → enqueueBatch() → executeWindowCreate() → ensureRoot() ❌ throws
4. Desktop.tsx mounts (later) → registerWorkspaceRoot() ✓
```

**Result**: Streaming completions or compute results that arrive during app startup fail with "Workspace root not registered."

## Root Cause

`initializeTauriBridge()` sets up event listeners immediately on app load (main.tsx), but `Desktop.tsx` doesn't mount and call `registerWorkspaceRoot()` until React renders the component tree. Any batches arriving in this window hit `ensureRoot()` which throws.

**Affected Flows**:
- Streaming LLM completions (`ollama-completion` events)
- Compute final events (`compute-result-final` events)
- Any early `enqueueBatch()` calls before Desktop mounts

## Solution

Added workspace-ready guard with pending batch queue:

### 1. Workspace-Ready Flag (adapter.ts)

```typescript
let workspaceReady = false;
type PendingBatchEntry = { 
  batch: Batch; 
  resolve: (outcome: ApplyOutcome) => void; 
  reject: (error: unknown) => void 
};
const pendingBatches: PendingBatchEntry[] = [];
```

### 2. Defer Helper (adapter.ts)

```typescript
export const deferBatchIfNotReady = (batch: Batch): Promise<ApplyOutcome> | null => {
  if (workspaceReady) return null; // Workspace ready, proceed normally
  
  console.debug(`[adapter] workspace not ready, queuing batch with ${batch.length} op(s)`);
  return new Promise((resolve, reject) => {
    pendingBatches.push({ batch, resolve, reject });
  });
};
```

Returns:
- `null` if workspace is ready → proceed with normal flow
- `Promise<ApplyOutcome>` if not ready → batch is queued, resolved when workspace registers

### 3. Guard in Queue (queue.ts)

```typescript
export const enqueueBatch = async (input: Batch | unknown): Promise<ApplyOutcome> => {
  const batch = Array.isArray(input) ? validateBatch(input) : validateBatch(input as unknown);

  // Guard: defer batch if workspace root is not yet registered
  const deferred = deferBatchIfNotReady(batch);
  if (deferred) return deferred;

  // ... normal queue processing
};
```

### 4. Flush on Registration (adapter.ts)

```typescript
export const registerWorkspaceRoot = (element: HTMLElement) => {
  workspaceRoot = element;
  workspaceReady = true;

  // ... event listeners setup

  // Process any batches that arrived before workspace was ready
  if (pendingBatches.length > 0) {
    console.debug(`[adapter] flushing ${pendingBatches.length} pending batch(es)`);
    const toProcess = pendingBatches.splice(0);
    for (const entry of toProcess) {
      enqueueBatch(entry.batch)
        .then(entry.resolve)
        .catch(entry.reject);
    }
  }
};
```

## Testing

Added comprehensive test suite: `tests/unit/adapter.workspace-registration.test.ts`

**Tests**:
- ✓ Defers batch when workspace is not ready
- ✓ Processes batch immediately after workspace is registered
- ✓ Flushes pending batches when workspace is registered
- ✓ Preserves batch order when flushing
- ✓ Handles errors in pending batches gracefully

**Logs confirm behavior**:
```
[adapter] workspace not ready, queuing batch with 1 op(s)
[adapter] flushing 1 pending batch(es)
```

## Files Changed

- `uicp/src/lib/uicp/adapter.ts`: Added workspaceReady flag, pendingBatches queue, deferBatchIfNotReady() helper, flush logic in registerWorkspaceRoot()
- `uicp/src/lib/uicp/queue.ts`: Added defer guard at start of enqueueBatch()
- `uicp/tests/unit/adapter.workspace-registration.test.ts`: New test suite (5 tests)
- `uicp/tests/unit/uicp.queue.test.ts`: Updated mock to include deferBatchIfNotReady

## Validation

All tests pass:
- ✓ 5/5 workspace registration tests pass
- ✓ 16/16 adapter tests pass
- ✓ 3/3 queue tests pass

No breaking changes. Existing behavior preserved - batches that arrive after workspace is ready process immediately with zero overhead.

## Behavior

**Before workspace registration**:
```
enqueueBatch() → deferBatchIfNotReady() → Promise (queued)
                                             ↓
registerWorkspaceRoot() → flush → enqueueBatch() → apply
```

**After workspace registration**:
```
enqueueBatch() → deferBatchIfNotReady() → null (bypass) → apply immediately
```

## Follow-up

No additional work needed. The guard is:
- **Zero-overhead** after workspace registers (null check short-circuits)
- **Transparent** to callers (Promise API unchanged)
- **Safe** against errors (each pending batch has isolated reject handler)

## Rationale

Per global rules #14: No silent errors. This fix prevents the race condition while surfacing any batch application errors explicitly through the returned Promise, maintaining the fail-fast principle.
