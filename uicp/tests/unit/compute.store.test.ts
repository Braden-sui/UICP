import { describe, it, expect, beforeEach } from 'vitest';
import { useComputeStore, type ComputeStatus } from '../../src/state/compute';

describe('useComputeStore', () => {
  beforeEach(() => {
    useComputeStore.getState().reset();
  });

  it('upserts a running job and marks partials', () => {
    const id = 'job-1';
    useComputeStore.getState().upsertJob({ jobId: id, task: 'csv.parse' });
    let job = useComputeStore.getState().jobs[id];
    expect(job).toBeTruthy();
    expect(job.status).toBe('running');
    expect(job.partials).toBe(0);

    useComputeStore.getState().markPartial(id);
    job = useComputeStore.getState().jobs[id];
    expect(job.status).toBe('partial');
    expect(job.partials).toBe(1);
  });

  it('preserves optional metrics on new jobs', () => {
    const id = 'job-metrics';
    useComputeStore.getState().upsertJob({
      jobId: id,
      task: 'task',
      status: 'queued',
      deadlineMs: 5_000,
      remainingMsAtFinish: 1_000,
      logCount: 2,
      partialFrames: 4,
      invalidPartialsDropped: 1,
    });
    const job = useComputeStore.getState().jobs[id];
    expect(job.status).toBe('queued');
    expect(job.deadlineMs).toBe(5_000);
    expect(job.remainingMsAtFinish).toBe(1_000);
    expect(job.logCount).toBe(2);
    expect(job.partialFrames).toBe(4);
    expect(job.invalidPartialsDropped).toBe(1);
  });

  const cases: Array<{ code?: string; message?: string; ok: boolean; expected: ComputeStatus }> = [
    { ok: true, expected: 'done' },
    { code: 'Compute.Timeout', ok: false, expected: 'timeout' },
    { message: 'Timeout: deadline exceeded', ok: false, expected: 'timeout' },
    { message: 'Cancelled by user', ok: false, expected: 'cancelled' },
    { code: 'Compute.CapabilityDenied', ok: false, expected: 'error' },
  ];

  it.each(cases)('normalizes final status %#', ({ code, message, ok, expected }) => {
    const id = `job-${expected}-${ok ? 'ok' : 'err'}`;
    useComputeStore.getState().upsertJob({ jobId: id, task: 'task' });
    useComputeStore.getState().markFinal(id, ok, { durationMs: 10 }, message, code);
    const job = useComputeStore.getState().jobs[id];
    expect(job.status).toBe(expected);
    if (ok) {
      expect(job.lastError).toBeUndefined();
    } else {
      expect(job.lastError).toBe(message ?? code);
    }
    expect(job.durationMs).toBe(10);
  });

  it('keeps active jobs regardless of terminal backlog', () => {
    const activeCount = 5;
    for (let i = 0; i < activeCount; i++) {
      const id = `active-${i}`;
      useComputeStore.getState().upsertJob({ jobId: id, task: 'task', status: 'running' });
    }
    for (let i = 0; i < 150; i++) {
      const id = `done-${i}`;
      useComputeStore.getState().upsertJob({ jobId: id, task: 'task' });
      useComputeStore.getState().markFinal(id, true);
    }
    const jobs = Object.values(useComputeStore.getState().jobs);
    const active = jobs.filter((j) => j.status === 'running');
    const terminal = jobs.filter((j) => j.status !== 'running' && j.status !== 'partial' && j.status !== 'queued');
    expect(active.length).toBe(activeCount);
    expect(terminal.length).toBeLessThanOrEqual(100);
  });

  it('transitions between queued/running and removes jobs', () => {
    const id = 'transition-job';
    useComputeStore.getState().upsertJob({ jobId: id, task: 'task', status: 'queued' });
    useComputeStore.getState().markRunning(id);
    expect(useComputeStore.getState().jobs[id].status).toBe('running');
    useComputeStore.getState().markQueued(id);
    expect(useComputeStore.getState().jobs[id].status).toBe('queued');
    useComputeStore.getState().removeJob(id);
    expect(useComputeStore.getState().jobs[id]).toBeUndefined();
  });
});
