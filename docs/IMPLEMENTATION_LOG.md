# Implementation Log

This document consolidates significant implementation milestones and fixes completed in October 2025. For current status, see `STATUS.md` and `MVP checklist.md`.

---

## 2025-10-17: Quick Wins Batch

**Status**: All Complete ✅

### 1. Standardized `inv<T>` Helper
- Created `uicp/src/lib/bridge/result.ts` with `Result<T, UICPError>` type
- Added `inv<T>` wrapper that returns Result instead of throwing
- All errors tagged with E-UICP-xxx codes (1xx=bridge, 3xx=sanitization, 4xx=adapter, 5xx=compute)

### 2. Immer Middleware for Zustand
- Added `immer` dependency
- Wrapped `useAppStore` with immer middleware for cleaner state updates

### 3. Telemetry ID Tracking (COMPLETE)
- Extended `IntentTelemetry` with `batchId` and `runId` fields
- All 6 telemetry emission points in `chat.ts` now track batch and run IDs
- UI updated: MetricsPanel shows Trace/Batch/Run column, LogsPanel displays IDs
- Enables full plan→act→apply→batch correlation for debugging
- Documentation: `docs/telemetry-id-tracking.md`

### 4. Generated JSON Audit
- Documented procedure for identifying build artifacts
- Recommendation: move to `.gitignore`, generate at build time

**Files Modified**:
- `uicp/src/lib/bridge/result.ts`, `tauri.ts`
- `uicp/src/state/app.ts`, `chat.ts`
- `uicp/src/components/MetricsPanel.tsx`, `LogsPanel.tsx`

---

## 2025-10-15: JSON Tool Calling Production Pilot

**Status**: ACTIVE - Production Default

### Summary
JSON tool calling enabled for GLM 4.6. System now operates as structured agent platform with WIL fallback.

### Architecture Flow
```
User Intent → Planner (GLM + supportsTools=true)
  → tools=[EMIT_PLAN], toolChoice={emit_plan}
  → Model emits: tool_call events with JSON args
  → collectWithFallback: tool calls + text in parallel
  → Plan with channelUsed='tool'
  → Actor (GLM + supportsTools=true)
  → tools=[EMIT_BATCH]
  → Streaming aggregator: tool call → json → final → commentary (4-level fallback)
  → Queue validates and applies
```

### Key Changes

**Streaming Aggregator** (`stream.ts`):
- 4-level cascading fallback:
  1. Tool call (`emit_batch`) → parse JSON → validate
  2. JSON channel content → parse → validate  
  3. Final channel (WIL) → parse
  4. Commentary buffer (WIL) → parse

**Configuration**:
```typescript
// profiles.ts - GLM enabled for tools
glm: { capabilities: { channels: ['json'], supportsTools: true } }

// config.ts - JSON-first by default
wilOnly: readBooleanEnv('VITE_WIL_ONLY', false)
```

### Observability
- `channelUsed` field: 'tool' (success), 'json' (content fallback), 'text' (WIL fallback)
- Expected: Tool success >90%, JSON fallback <5%, WIL <1%

### Rollback Options
- **Immediate**: `VITE_WIL_ONLY=true` in `.env`
- **Code**: Set `supportsTools: false` in `profiles.ts`

**Files Modified**: `stream.ts`, `profiles.ts`, `config.ts`, `planner.txt`, `actor.txt`

---

## 2025-10-14: Core Stability Improvements

### Error Handling Refactor

**Status**: Complete ✅

Eliminated silent error paths across UI lifecycle and bridge.

**Changes**:
- Window lifecycle: `emitWindowEvent` aggregates errors and throws
- Deterministic serialization: `stableStringify` removed lossy fallback
- Pointer capture: Removed try/catch wrappers in `DesktopWindow.tsx`, `DesktopIcon.tsx`
- Compute bridge: Explicit `console.error` on cancellation/debug failures
- LLM streaming: Abort/timeout handlers log backend failures

**Deviations** (Documented):
- JSON recovery helpers kept for planner artifact cleanup (strips stray brackets before Zod validation)
- Recovery runs before validation; still throws `E-UICP-301` on failure

**References**: Global Rules #14 (no silent exceptions)

---

### Workspace Registration Race Condition Guard

**Status**: Complete ✅

**Problem**: Batches arriving before `Desktop.tsx` registers workspace root caused "Workspace root not registered" errors.

**Solution**:
- Added `workspaceReady` flag and `pendingBatches` queue in `adapter.ts`
- `deferBatchIfNotReady()` queues early batches, returns Promise
- `registerWorkspaceRoot()` flushes pending batches on mount
- Zero overhead after workspace registers (null check short-circuits)

**Timeline Fixed**:
```
Before: Events arrive → ensureRoot() ❌ throws
After:  Events arrive → queue → Desktop mounts → flush → apply ✓
```

**Tests**: 5/5 passing in `adapter.workspace-registration.test.ts`

---

### WIL Size Parameter Fix

**Status**: Complete ✅

Fixed `size` parameter handling in WIL parser for window operations.

**Changes**:
- `lexicon.ts`: Updated `window.create` and `window.update` templates to accept `size` parameter
- `parse.ts`: Added size parsing with validation (format: "WxH" e.g., "800x600")
- Schema alignment: Ensured WIL output matches Zod schema expectations

**Testing**: Unit tests verify size parsing and validation

---

## 2025-10-13: Batch Idempotency System

**Status**: Production ✅

**Summary**: Comprehensive batch-level idempotency prevents duplicate batch application (network retries, race conditions).

### Components

**Batch Hashing** (`schemas.ts`):
- `computeBatchHash()`: FNV-1a hash of operation signatures (op + params + windowId)
- `BatchMetadata` type: carries batchId, opsHash, timestamp

**Deduplication Store** (`adapter.ts`):
- In-memory LRU with 15-minute TTL (configurable: `BATCH_DEDUPE_TTL_MS`)
- Max 500 entries (configurable: `BATCH_DEDUPE_MAX_SIZE`)
- Cleared on `resetWorkspace()`

**ApplyOutcome Extended**:
- `skippedDuplicates: number` - count of skipped operations
- `batchId?: string` - stable batch identifier
- Duplicate detection returns original batchId for continuity

**Transaction Boundary** in `applyBatch()`:
- Computes opsHash at entry
- Checks dedupe store before applying
- Returns early with `{ applied: 0, skippedDuplicates: batch.length }` if duplicate
- Records successful batches with timestamp
- Emits `batch_duplicate_skipped` telemetry event

**Queue Integration** (`queue.ts`):
- `mergeOutcomes()` aggregates skippedDuplicates
- Telemetry includes batchId and skippedDuplicates

### Telemetry Events
- New: `batch_duplicate_skipped` (span: batch, status: skipped)
- Payload: batchId, opsHash, originalBatchId, skippedCount, ageMs

### Design Decisions
1. Batch-level (not operation-level) for transaction semantics
2. Original batchId preserved on duplicate for tracking continuity
3. In-memory store (no persistence needed; TTL handles transient retries)
4. Stable hash: FNV-1a ignores idempotencyKey to focus on operations

**Tests**: 11/11 passing in `batch-idempotency.test.ts`

**Win**: Prevents "stacking the same femur twice" - duplicates caught with full observability.

---

## 2025-10-13: Stream Cancellation System

**Status**: Production ✅

**Summary**: Explicit cancellation support prevents ghost echoes when streams are superseded.

### Components

**Stream Aggregator** (`stream.ts`):
- Added `cancelled` flag and `cancel()` method to `createOllamaAggregator`
- `processDelta()` short-circuits if cancelled
- `flush()` returns `{ cancelled: boolean }` status
- INVARIANT: Once cancelled, all delta processing becomes no-op

**Stream Lifecycle** (`tauri.ts`):
- Emit `stream.closed` event with reason ('user_cancel' | 'normal')
- Cancel superseded streams when new stream starts
- Generational counter + cancel flag = double-defense against stale deltas

**Comprehensive Testing** (`stream-cancel.test.ts`):
- 12 tests covering all scenarios
- **Soak test 1**: 20 iterations rapid start/stop (50-150ms delays) - zero batch leaks
- **Soak test 2**: 10 concurrent streams, half cancelled - correct isolation
- **Soak test 3**: 50 trials measuring post-cancel deltas - max=0, avg=0.00 (perfect cancellation)

### Proof Points
- Ghost echo boundary: 0 post-cancel deltas in controlled conditions
- AutoApply disabled: Cancelled streams never reach `onBatch` callback
- Race safety: Rapid start/stop shows zero batch leaks
- Concurrent safety: Mixed cancellation shows correct isolation

**Win**: Quantitative proof of correctness. No ghost echoes in galleries.

---

## Circuit Breaker Enhancements

**Status**: Production ✅

**Summary**: Configurable thresholds, runtime visibility, and comprehensive telemetry for production observability.

### Configuration (Environment Variables)
- `UICP_CIRCUIT_MAX_FAILURES`: Max consecutive failures before opening (default: 3)
- `UICP_CIRCUIT_OPEN_MS`: Duration to keep circuit open (default: 15000ms)
- `UICP_CIRCUIT_HALF_OPEN_PROB`: Probability for half-open requests (default: 0.1)

### Circuit Module (`circuit.rs`)
- `circuit_is_open()`: Fast-path read with lazy cleanup
- `circuit_record_success()`: Resets state, emits `circuit-close` event
- `circuit_record_failure()`: Increments failures, opens circuit, emits `circuit-open` event
- `get_circuit_debug_info()`: Returns per-host state for debugging

### Debug Command
- `debug_circuits`: Returns `Vec<CircuitDebugInfo>` with per-host state
- Fields: host, consecutive_failures, opened_until_ms, last_failure_ms_ago, state ("open"|"degraded"|"healthy")

### Telemetry Events
- `circuit-open`: host, consecutiveFailures, openDurationMs, totalFailures
- `circuit-close`: host, totalFailures, totalSuccesses

**Win**: Circuit breaker now has "signage" - operators can see what's happening and tune thresholds without recompilation.

---

## SQLite Maintenance & Schema Versioning

**Status**: Production ✅

**Summary**: Comprehensive maintenance prevents fragmentation and ensures reliable migrations.

### Schema Version Table
- Tracks migrations per component
- Current version: `SCHEMA_VERSION = 1`
- Functions: `ensure_schema_version_table()`, `record_schema_version()`, `get_schema_version()`

### Periodic Maintenance (`main.rs::spawn_db_maintenance()`)
- Runs every 24 hours (configurable: `UICP_DB_MAINTENANCE_INTERVAL_HOURS`)
- Operations:
  - WAL checkpoint (TRUNCATE) - prevents unbounded growth
  - PRAGMA optimize - updates query planner statistics  
  - VACUUM every 7 days (configurable: `UICP_DB_VACUUM_INTERVAL_DAYS`)
- Skips during Safe Mode
- Emits `db-maintenance-error` on failure

### Migration Error Handling
- Clear recovery instructions in error messages
- Version-based guards prevent re-runs
- Transaction-based with rollback on failure

**Documentation**: `docs/compute/cache-maintenance.md`

**Win**: Prevents slow fragmentation, unbounded WAL growth, and unclear migration failures.

---

## Summary of October 2025 Work

All implementations verified against current codebase:
- ✅ Batch idempotency system (`computeBatchHash`, dedupe store)
- ✅ Stream cancellation (`cancel()` method, zero ghost echoes)
- ✅ Workspace registration guard (`deferBatchIfNotReady`)
- ✅ Telemetry ID tracking (`batchId`, `runId` in UI)
- ✅ JSON tool calling (production default with WIL fallback)
- ✅ Error handling refactor (fail-loud culture)
- ✅ Circuit breaker observability
- ✅ SQLite maintenance automation

**Testing Status**: 224 tests passing, comprehensive coverage across all systems.
