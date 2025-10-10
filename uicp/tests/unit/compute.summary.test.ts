import { describe, expect, it } from 'vitest';
import { summarizeComputeJobs, type ComputeJob } from '../../src/state/compute';

const makeJob = (overrides: Partial<ComputeJob>): ComputeJob => {
  if (!overrides.jobId) {
    throw new Error('jobId is required for test helpers');
  }
  return {
    jobId: overrides.jobId,
    task: overrides.task ?? 'sample@1.0.0',
    status: overrides.status ?? 'running',
    partials: overrides.partials ?? 0,
    updatedAt: overrides.updatedAt ?? Date.now(),
    cacheHit: overrides.cacheHit,
    durationMs: overrides.durationMs,
    memPeakMb: overrides.memPeakMb,
    fuelUsed: overrides.fuelUsed,
    deadlineMs: overrides.deadlineMs,
    remainingMsAtFinish: overrides.remainingMsAtFinish,
    logCount: overrides.logCount,
    partialFrames: overrides.partialFrames,
    invalidPartialsDropped: overrides.invalidPartialsDropped,
    lastError: overrides.lastError,
  };
};

describe('summarizeComputeJobs', () => {
  it('aggregates counts and metrics', () => {
    const now = 1_700_000_000_000;
    const jobs: Record<string, ComputeJob> = {
      queued: makeJob({
        jobId: 'queued',
        task: 'csv.parse@1.2.0',
        status: 'queued',
        updatedAt: now - 300,
      }),
      running: makeJob({
        jobId: 'running',
        task: 'table.query@0.1.0',
        status: 'running',
        partials: 2,
        fuelUsed: 2,
        logCount: 1,
        updatedAt: now,
      }),
      partial: makeJob({
        jobId: 'partial',
        task: 'table.query@0.1.0',
        status: 'partial',
        partials: 4,
        fuelUsed: 1,
        logCount: 2,
        partialFrames: 4,
        updatedAt: now - 20,
      }),
      doneHit: makeJob({
        jobId: 'done-hit',
        task: 'csv.parse@1.2.0',
        status: 'done',
        partials: 3,
        cacheHit: true,
        durationMs: 120,
        memPeakMb: 32,
        fuelUsed: 5,
        logCount: 7,
        partialFrames: 3,
        invalidPartialsDropped: 1,
        updatedAt: now - 100,
      }),
      doneMiss: makeJob({
        jobId: 'done-miss',
        task: 'csv.parse@1.2.0',
        status: 'done',
        partials: 1,
        cacheHit: false,
        durationMs: 200,
        memPeakMb: 64,
        updatedAt: now - 150,
      }),
      timeout: makeJob({
        jobId: 'timeout',
        task: 'csv.parse@1.2.0',
        status: 'timeout',
        partials: 0,
        durationMs: 400,
        updatedAt: now - 200,
      }),
    };

    const summary = summarizeComputeJobs(jobs);

    expect(summary.total).toBe(6);
    expect(summary.queued).toBe(1);
    expect(summary.running).toBe(1);
    expect(summary.partial).toBe(1);
    expect(summary.active).toBe(3);
    expect(summary.done).toBe(2);
    expect(summary.timeout).toBe(1);
    expect(summary.error).toBe(0);
    expect(summary.cancelled).toBe(0);
    expect(summary.cacheHits).toBe(1);
    expect(summary.cacheRatio).toBe(50);
    expect(summary.partialsSeen).toBe(10);
    expect(summary.partialFrames).toBe(7);
    expect(summary.invalidPartialsDropped).toBe(1);
    expect(summary.logCount).toBe(10);
    expect(summary.fuelUsed).toBe(8);
    expect(summary.durationP50).toBe(200);
    expect(summary.durationP95).toBe(400);
    expect(summary.memPeakP95).toBe(64);
    expect(summary.recent[0]!.jobId).toBe('running');
    expect(summary.recent[summary.recent.length - 1]!.jobId).toBe('queued');
  });

  it('returns zero-ish summary when no jobs exist', () => {
    const summary = summarizeComputeJobs({});
    expect(summary.total).toBe(0);
    expect(summary.cacheRatio).toBe(0);
    expect(summary.durationP50).toBeNull();
    expect(summary.durationP95).toBeNull();
    expect(summary.memPeakP95).toBeNull();
    expect(summary.recent).toHaveLength(0);
  });
});
