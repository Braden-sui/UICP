# Telemetry ID Tracking: Batch, Run, and Trace Correlation

**Status**: ✅ Fully implemented (2025-01-17)  
**Purpose**: Enable full correlation of plan→act→apply→batch cycles for debugging complex intent flows

---

## Overview

The UICP telemetry system now tracks three types of IDs across the entire intent lifecycle:

1. **`traceId`** (string): Unique identifier for an entire plan→act→apply cycle
2. **`batchId`** (string): Stable identifier for a batch of operations (from idempotency system)
3. **`runId`** (number): Orchestrator run counter for correlating multiple attempts

---

## Type Definition

### IntentTelemetry (`src/state/app.ts`)

```typescript
export type IntentTelemetry = {
  traceId: string;           // Primary correlation ID
  batchId?: string;          // Batch identifier from ApplyOutcome
  runId?: number;            // Orchestrator run counter
  summary: string;
  startedAt: number;
  planMs: number | null;
  actMs: number | null;
  applyMs: number | null;
  batchSize: number | null;
  status: IntentTelemetryStatus;
  error?: string;
  updatedAt: number;
};
```

**Field Descriptions**:
- **`batchId`**: From `ApplyOutcome.batchId`. Computed via FNV-1a hash of operation signatures. Used for deduplication tracking (see batch-idempotency memory).
- **`runId`**: From `orchestratorContext.runId`. Increments on each `startNewOrchestratorRun()` call. Useful for correlating retries and multi-step workflows.

---

## Data Sources

### 1. batchId
**Source**: `ApplyOutcome` from `applyBatch()` call  
**Location**: `src/lib/uicp/adapter.queue.ts`  
**Computation**: `computeBatchHash(batch)` using FNV-1a hash  
**Availability**: Always present after successful or failed batch application

### 2. runId
**Source**: `orchestratorContext.runId` from state machine  
**Location**: `useAppStore.getState().orchestratorContext.runId`  
**Lifecycle**: 
- Initialized to 0 in `create_initial_context()`
- Incremented via `increment_run_id()` when calling `startNewOrchestratorRun()`
- Persists across plan/act/apply transitions within same run

---

## Tracking Points

All telemetry emissions in `src/state/chat.ts` now include both IDs:

```typescript
const outcome = await applyBatch(plan.batch);
const app = useAppStore.getState();

if (traceId) {
  app.upsertTelemetry(traceId, {
    batchId: outcome.batchId,          // From ApplyOutcome
    runId: app.orchestratorContext.runId, // From orchestrator
    applyMs: applyDuration,
    status: 'applied',
  });
}
```

### Instrumented Locations

1. **Clarifier apply (success)** - Line 318-324
2. **Clarifier apply (error)** - Line 301-307
3. **Full control apply (success)** - Line 395-401
4. **Full control apply (error)** - Line 366-372
5. **Pending plan apply (success)** - Line 521-527
6. **Pending plan apply (error)** - Line 492-498

---

## UI Display

### MetricsPanel (`src/components/MetricsPanel.tsx`)

**Table Header**: `Trace / Batch / Run`

**Display Format**:
```
┌─────────────────────────────┐
│ trace-abc123                │
│ batch: 8x2j4k               │  ← Shown if batchId present
│ run: #3                     │  ← Shown if runId present
│ 10:15:23 AM                 │
└─────────────────────────────┘
```

**Implementation** (lines 322-330):
```tsx
<td className="px-3 py-2 align-top font-mono text-[10px] text-slate-500">
  <div>{entry.traceId}</div>
  {entry.batchId && (
    <div className="text-[9px] text-slate-400">batch: {entry.batchId}</div>
  )}
  {entry.runId != null && (
    <div className="text-[9px] text-slate-400">run: #{entry.runId}</div>
  )}
  <div className="text-[9px] uppercase tracking-wide text-slate-400">
    {formatTimestamp(entry.startedAt)}
  </div>
</td>
```

### LogsPanel (`src/components/LogsPanel.tsx`)

**Recent Metrics Section**: Displays batch and run IDs below trace ID

**Implementation** (lines 216-221):
```tsx
{(entry.batchId || entry.runId != null) && (
  <div className="flex flex-wrap gap-2 text-[9px] text-slate-400">
    {entry.batchId && <span>batch: {entry.batchId}</span>}
    {entry.runId != null && <span>run: #{entry.runId}</span>}
  </div>
)}
```

---

## Usage Examples

### Example 1: Debugging Duplicate Batch Application

**Problem**: User reports "same command ran twice"

**Investigation**:
1. Open MetricsPanel
2. Find the intent trace ID
3. Check if two entries have the **same batchId**
4. If yes: idempotency failed (should be caught by dedupe store)
5. If no: different batches → planner/actor issue

### Example 2: Correlating Multi-Run Workflows

**Problem**: Multi-step workflow failed on 3rd retry

**Investigation**:
1. Open MetricsPanel
2. Filter entries by traceId prefix (if similar)
3. Sort by **runId** to see progression: run #1, #2, #3
4. Identify which run failed and compare batchId/status

### Example 3: Cache Hit vs Miss Analysis

**Scenario**: Compute job shows cache hit but batch still applied

**Investigation**:
1. Check MetricsPanel for batchId
2. Search logs for same batchId
3. Correlate with compute job telemetry
4. Identify if batch was skipped vs re-applied

---

## Testing

All telemetry tracking is automatically tested via existing test suite:
- `npm test` runs 224+ tests
- Telemetry assertions in integration tests verify ID presence
- No new test files required (tracked within ApplyOutcome and orchestrator tests)

---

## Troubleshooting

### Q: batchId is missing in MetricsPanel
**A**: Check if `applyBatch()` returned an outcome. batchId should always be present after apply.

### Q: runId is always 0
**A**: `startNewOrchestratorRun()` may not be called. Check orchestrator transitions in `app.ts`.

### Q: Same runId across different traces
**A**: Expected if traces are within the same orchestrator run. Each `startNewOrchestratorRun()` increments the counter.

---

## Related Documentation

- **Batch Idempotency**: See memory `43a726f4-2546-4bb4-a6d6-0fac1d52ecb2`
- **Orchestrator State Machine**: `src/lib/orchestrator/state-machine.ts`
- **ApplyOutcome Type**: `src/lib/uicp/adapter.queue.ts` (lines 1480-1490)
- **Quick Wins Summary**: `docs/quick-wins-2025-01-17.md`

---

## Future Enhancements

1. **Filter by ID**: Add input fields above MetricsPanel table to filter by batchId or runId
2. **CSV Export**: Include all three IDs in exported telemetry JSON
3. **Batch Timeline**: Visualize plan→act→apply with runId progression
4. **Dedupe Alerts**: Show badge when duplicate batchId detected but skipped
