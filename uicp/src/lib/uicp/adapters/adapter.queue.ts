import { type Batch, computeBatchHash, type ApplyOptions, type ApplyOutcome } from "./schemas";
import { createId } from "../../utils";
import { emitTelemetryEvent } from "../../telemetry";
import { persistCommand, recordStateCheckpoint } from "./adapter.persistence";
import { addWorkspaceResetHandler, applyBatch as applyBatchV2 } from "./lifecycle";

const DEDUPE_TTL_MS = 10 * 60 * 1000; // 10 minute window for duplicate detection
const DEDUPE_MAX_ENTRIES = 500;

type BatchRecord = {
  batchId: string;
  opsHash: string;
  timestamp: number;
  applied: number;
};

const dedupeByBatchId = new Map<string, BatchRecord>();
const dedupeByOpsHash = new Map<string, BatchRecord>();
const dedupeHistory: BatchRecord[] = [];

const cleanupExpired = (now: number) => {
  while (dedupeHistory.length > 0) {
    const head = dedupeHistory[0];
    if (now - head.timestamp <= DEDUPE_TTL_MS) break;
    dedupeHistory.shift();
    if (dedupeByBatchId.get(head.batchId) === head) {
      dedupeByBatchId.delete(head.batchId);
    }
    if (dedupeByOpsHash.get(head.opsHash) === head) {
      dedupeByOpsHash.delete(head.opsHash);
    }
  }
};

const recordHistory = (entry: BatchRecord) => {
  dedupeByBatchId.set(entry.batchId, entry);
  dedupeByOpsHash.set(entry.opsHash, entry);
  dedupeHistory.push(entry);
  if (dedupeHistory.length > DEDUPE_MAX_ENTRIES) {
    const overflow = dedupeHistory.splice(0, dedupeHistory.length - DEDUPE_MAX_ENTRIES);
    for (const item of overflow) {
      if (dedupeByBatchId.get(item.batchId) === item) {
        dedupeByBatchId.delete(item.batchId);
      }
      if (dedupeByOpsHash.get(item.opsHash) === item) {
        dedupeByOpsHash.delete(item.opsHash);
      }
    }
  }
};

const findDuplicate = (batchId: string | undefined, opsHash: string, now: number): BatchRecord | null => {
  if (batchId) {
    const entry = dedupeByBatchId.get(batchId);
    if (entry && now - entry.timestamp <= DEDUPE_TTL_MS) {
      return entry;
    }
  }
  const entry = dedupeByOpsHash.get(opsHash);
  if (entry && now - entry.timestamp <= DEDUPE_TTL_MS) {
    return entry;
  }
  return null;
};

export const resetBatchHistory = () => {
  dedupeByBatchId.clear();
  dedupeByOpsHash.clear();
  dedupeHistory.length = 0;
};

// Register reset handler if available (may be mocked in tests)
if (typeof addWorkspaceResetHandler === 'function') {
  addWorkspaceResetHandler(resetBatchHistory);
}

const emitDuplicateTelemetry = (batch: Batch, record: BatchRecord, opsHash: string, now: number) => {
  const traceIds = new Set<string>();
  for (const env of batch) {
    if (env.traceId) {
      traceIds.add(env.traceId);
    }
  }
  for (const traceId of traceIds) {
    emitTelemetryEvent("batch_duplicate_skipped", {
      traceId,
      span: "batch",
      status: "skipped",
      data: {
        batchId: record.batchId,
        originalBatchId: record.batchId,
        opsHash,
        skippedCount: batch.length,
        ageMs: now - record.timestamp,
      },
    });
  }
};

export const applyBatch = async (batch: Batch, opts: ApplyOptions = {}): Promise<ApplyOutcome> => {
  const now = Date.now();
  cleanupExpired(now);

  const opsHash = opts.opsHash ?? computeBatchHash(batch);
  const batchId = opts.batchId ?? createId("batch");

  // Check for duplicate using the computed batchId (not opts.batchId which may be undefined)
  const duplicate = findDuplicate(batchId, opsHash, now);
  if (duplicate) {
    emitDuplicateTelemetry(batch, duplicate, opsHash, now);
    const skipped = batch.length;
    return {
      success: true,
      applied: 0,
      skippedDuplicates: skipped,
      deniedByPolicy: 0,
      errors: [],
      batchId: duplicate.batchId,
      opsHash: duplicate.opsHash,
    };
  }

  if (batch.length === 0) {
    return {
      success: true,
      applied: 0,
      skippedDuplicates: 0,
      deniedByPolicy: 0,
      errors: [],
      batchId,
      opsHash,
    };
  }

  // Route the entire batch to V2 orchestrator
  const contextRunId = opts.runId ?? batch[0]?.traceId ?? createId("run");
  const result = await applyBatchV2(batch, { ...opts, batchId, opsHash, runId: contextRunId });

  // Persist each command on success
  if (result.success && result.applied > 0) {
    for (const command of batch) {
      void persistCommand(command);
    }
    // Use our computed batchId/opsHash for history (V2 might not return them)
    recordHistory({ batchId, opsHash, timestamp: now, applied: result.applied });
    await recordStateCheckpoint();
  }

  return {
    success: result.success,
    applied: result.applied,
    skippedDuplicates: result.skippedDuplicates ?? 0,
    deniedByPolicy: result.deniedByPolicy ?? 0,
    errors: result.errors ?? [],
    batchId: result.batchId ?? batchId,
    opsHash: result.opsHash ?? opsHash,
  };
};
