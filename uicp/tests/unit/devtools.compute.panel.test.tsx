import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import DevtoolsComputePanel from '../../src/components/DevtoolsComputePanel';

const fireUiDebug = (detail: Record<string, unknown>) => {
  window.dispatchEvent(new CustomEvent('ui-debug-log', { detail: { ts: Date.now(), ...detail } }));
};

describe('DevtoolsComputePanel logs', () => {
  beforeEach(() => {
    // jsdom starts with empty DOM; no cleanup needed between tests for this component
  });

  it('renders compute logs emitted on ui-debug-log bus', async () => {
    render(<DevtoolsComputePanel defaultOpen={true} />);
    // Emit two compute_log events
    fireUiDebug({ event: 'compute_log', jobId: 'job-1', seq: 1, stream: 'wasi-logging', level: 'info', message: 'hello from guest' });
    fireUiDebug({ event: 'compute_log', jobId: 'job-1', seq: 2, stream: 'stdout', message: 'line two' });

    // Validate panel picked them up
    const header = await screen.findByText(/Compute logs/i);
    expect(header).toBeTruthy();
    // A preview message should be present
    expect(await screen.findByText(/hello from guest/i)).toBeTruthy();
    expect(await screen.findByText(/line two/i)).toBeTruthy();
  });

  it('filters by jobId and level, and clears logs', async () => {
    render(<DevtoolsComputePanel defaultOpen={true} />);
    fireUiDebug({ event: 'compute_log', jobId: 'job-1', seq: 1, stream: 'wasi-logging', level: 'info', message: 'alpha' });
    fireUiDebug({ event: 'compute_log', jobId: 'job-1', seq: 2, stream: 'wasi-logging', level: 'warn', message: 'beta' });
    fireUiDebug({ event: 'compute_log', jobId: 'job-2', seq: 1, stream: 'stdout', level: 'info', message: 'gamma' });

    // Filter by jobId
    const jobInput = await screen.findByLabelText(/Filter jobId/i);
    (jobInput as HTMLInputElement).value = 'job-1';
    jobInput.dispatchEvent(new Event('input', { bubbles: true }));
    expect(await screen.findByText(/alpha/i)).toBeTruthy();
    expect(await screen.findByText(/beta/i)).toBeTruthy();

    // Filter by level
    const levelSelect = await screen.findByLabelText(/Filter level/i);
    (levelSelect as HTMLSelectElement).value = 'info';
    levelSelect.dispatchEvent(new Event('change', { bubbles: true }));
    expect(await screen.findByText(/alpha/i)).toBeTruthy();
    // 'beta' is warn; should be filtered out now
    const beta = screen.queryByText(/beta/i);
    expect(beta).toBeNull();

    // Clear logs
    const clearBtn = await screen.findByRole('button', { name: /Clear logs/i });
    clearBtn.click();
    // header still exists
    expect(await screen.findByText(/Compute logs/i)).toBeTruthy();
    // no entries visible
    expect(screen.queryByText(/alpha/i)).toBeNull();
  });
});
