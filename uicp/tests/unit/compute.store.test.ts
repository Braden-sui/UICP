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

  const cases: Array<[string | undefined, boolean, ComputeStatus]> = [
    [undefined, true, 'done'],
    ['Compute.Timeout', false, 'timeout'],
    ['Timeout', false, 'timeout'],
    ['Cancelled', false, 'cancelled'],
    ['Compute.CapabilityDenied', false, 'error'],
  ];

  it.each(cases)('normalizes final status: %s => %s', (code, ok, expected) => {
    const id = `job-${expected}`;
    useComputeStore.getState().upsertJob({ jobId: id, task: 'task' });
    useComputeStore.getState().markFinal(id, ok, { durationMs: 10 }, code);
    const job = useComputeStore.getState().jobs[id];
    expect(job.status).toBe(expected);
    if (ok) {
      expect(job.lastError).toBeUndefined();
    } else {
      expect(job.lastError).toBe(code);
    }
    expect(job.durationMs).toBe(10);
  });
});

