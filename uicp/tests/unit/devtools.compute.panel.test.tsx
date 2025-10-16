import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import DevtoolsComputePanel from '../../src/components/DevtoolsComputePanel';
import { useComputeStore } from '../../src/state/compute';

const fireUiDebug = async (detail: Record<string, unknown>) => {
  await act(async () => {
    window.dispatchEvent(new CustomEvent('ui-debug-log', { detail: { ts: Date.now(), ...detail } }));
  });
};

describe('DevtoolsComputePanel logs', () => {
  beforeEach(() => {
    // jsdom starts with empty DOM; no cleanup needed between tests for this component
    useComputeStore.getState().reset();
  });

  it('renders compute logs emitted on ui-debug-log bus', async () => {
    await act(async () => {
      render(<DevtoolsComputePanel defaultOpen={true} />);
    });
    // Emit two compute_log events
    await fireUiDebug({ event: 'compute_log', jobId: 'job-1', seq: 1, stream: 'wasi-logging', level: 'info', message: 'hello from guest' });
    await fireUiDebug({ event: 'compute_log', jobId: 'job-1', seq: 2, stream: 'stdout', message: 'line two' });

    // Validate panel picked them up
    const header = await screen.findByText(/Compute logs/i);
    expect(header).toBeTruthy();
    // A preview message should be present
    expect(await screen.findByText(/hello from guest/i)).toBeTruthy();
    expect(await screen.findByText(/line two/i)).toBeTruthy();
  });

  it('filters by jobId and level, and clears logs', async () => {
    await act(async () => {
      render(<DevtoolsComputePanel defaultOpen={true} />);
    });
    await fireUiDebug({ event: 'compute_log', jobId: 'job-1', seq: 1, stream: 'wasi-logging', level: 'info', message: 'alpha' });
    await fireUiDebug({ event: 'compute_log', jobId: 'job-1', seq: 2, stream: 'wasi-logging', level: 'warn', message: 'beta' });
    await fireUiDebug({ event: 'compute_log', jobId: 'job-2', seq: 1, stream: 'stdout', level: 'info', message: 'gamma' });

    // Filter by jobId
    const jobInput = await screen.findByLabelText(/Filter jobId/i);
    expect(jobInput).toHaveAttribute('id', 'compute-log-filter-job');
    expect(jobInput).toHaveAttribute('name', 'filterJobId');
    await act(async () => {
      (jobInput as HTMLInputElement).value = 'job-1';
      jobInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(await screen.findByText(/alpha/i)).toBeTruthy();
    expect(await screen.findByText(/beta/i)).toBeTruthy();

    // Filter by level
    const levelSelect = await screen.findByLabelText(/Filter level/i);
    await act(async () => {
      (levelSelect as HTMLSelectElement).value = 'info';
      levelSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(await screen.findByText(/alpha/i)).toBeTruthy();
    // 'beta' is warn; should be filtered out now
    const beta = screen.queryByText(/beta/i);
    expect(beta).toBeNull();

    // Clear logs
    const clearBtn = await screen.findByRole('button', { name: /Clear logs/i });
    await act(async () => {
      clearBtn.click();
    });
    // header still exists
    expect(await screen.findByText(/Compute logs/i)).toBeTruthy();
    // no entries visible
    expect(screen.queryByText(/alpha/i)).toBeNull();
  });

  it('surfaces per-job backpressure and log counters', async () => {
    useComputeStore.getState().upsertJob({
      jobId: 'job-1',
      task: 'csv.parse@1.2.0',
      status: 'done',
      partials: 2,
      durationMs: 2400,
      deadlineMs: 3000,
      remainingMsAtFinish: 600,
      logCount: 5,
      emittedLogBytes: 4096,
      logThrottleWaits: 2,
      loggerThrottleWaits: 1,
      partialThrottleWaits: 4,
    });

    await act(async () => {
      render(<DevtoolsComputePanel defaultOpen={true} />);
    });

    expect(screen.getByText(/5 records/i)).toBeTruthy();
    expect(screen.getByText(/~4\.00 KB/i)).toBeTruthy();
    expect(screen.getByText(/stdout: 2/i)).toBeTruthy();
    expect(screen.getByText(/logger: 1/i)).toBeTruthy();
    expect(screen.getByText(/partial: 4/i)).toBeTruthy();
    expect(screen.getByText(/target: 3000 ms/i)).toBeTruthy();
    expect(screen.getByText(/ran: 2400 ms/i)).toBeTruthy();
    expect(screen.getByText(/remaining: 600 ms/i)).toBeTruthy();
  });
});
