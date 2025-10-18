import { type Batch, type Envelope, computeBatchHash, type ApplyOptions, type ApplyOutcome } from "./schemas";
import { createId } from "../../utils";
import { emitTelemetryEvent } from "../../telemetry";
import { useAppStore } from "../../../state/app";
import {
  addWorkspaceResetHandler,
  persistCommand,
  recordStateCheckpoint,
  runJobsInFrame,
  type ApplyContext,
} from "./adapter.lifecycle";
import { applyBatch as applyBatchV2 } from "./lifecycle";

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

const createAuditEmitter = () => {
  return (env: Envelope, outcome: "applied" | "error", ms: number, error?: string) => {
    try {
      const traceId = env.traceId ?? "batch";
      useAppStore.getState().upsertTelemetry(traceId, {
        summary: `${env.op} ${outcome}`,
        status: outcome === "applied" ? "applying" : "error",
        applyMs: ms,
        ...(error ? { error } : {}),
        updatedAt: Date.now(),
      });
    } catch {
      // best effort only
    }
  };
};

const deriveCommandContext = (env: Envelope, opts: ApplyOptions): ApplyContext => {
  const runId = opts.runId ?? env.traceId ?? env.id ?? createId("cmd");
  return { runId: typeof runId === "string" ? runId : String(runId) };
};

export const applyBatch = async (batch: Batch, opts: ApplyOptions = {}): Promise<ApplyOutcome> => {
  const now = Date.now();
  cleanupExpired(now);

  const opsHash = opts.opsHash ?? computeBatchHash(batch);
  const batchId = opts.batchId ?? createId("batch");

  const duplicate = findDuplicate(opts.batchId, opsHash, now);
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

  const plannedJobs: Array<() => Promise<void>> = [];
  const errors: string[] = [];
  let applied = 0;
  const emitAudit = createAuditEmitter();

  batch.forEach((command, index) => {
    plannedJobs.push(async () => {
      try {
        const t0 = performance.now();
        const context = deriveCommandContext(command, {
          runId: opts.runId ? `${opts.runId}:${index}` : opts.runId,
        });
        const result = await applyBatchV2([command], { runId: context.runId });
        const ms = Math.max(0, performance.now() - t0);
        if (result.success && result.applied > 0) {
          applied += result.applied;
          emitAudit(command, "applied", ms);
          void persistCommand(command);
          return;
        }
        const firstError = result.errors?.[0] ?? "Unknown error";
        emitAudit(command, "error", ms, firstError);
        errors.push(`${command.op}: ${firstError}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitAudit(command, "error", 0, message);
        errors.push(`${command.op}: ${message}`);
      }
    });
  });

  if (plannedJobs.length === 0) {
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

  try {
    await runJobsInFrame(plannedJobs);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  if (errors.length === 0 && applied > 0) {
    recordHistory({ batchId, opsHash, timestamp: now, applied });
  }

  if (errors.length === 0) {
    await recordStateCheckpoint();
  }

  const success = errors.length === 0 || (opts.allowPartial === true && applied > 0);
  return {
    success,
    applied,
    skippedDuplicates: 0,
    deniedByPolicy: 0,
    errors,
    batchId,
    opsHash,
  };
};
