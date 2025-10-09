import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import MetricsPanel from '../../src/components/MetricsPanel';
import { useAppStore } from '../../src/state/app';
import { useComputeStore } from '../../src/state/compute';

describe('MetricsPanel compute health', () => {
  beforeEach(() => {
    useAppStore.setState({ metricsOpen: true });
    const now = Date.now();
    useComputeStore.setState({
      jobs: {
        a: {
          jobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          task: 'csv.parse@1.2.0',
          status: 'done',
          partials: 2,
          durationMs: 100,
          updatedAt: now - 1000,
        } as any,
        b: {
          jobId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          task: 'table.query@0.1.0',
          status: 'done',
          partials: 1,
          durationMs: 300,
          cacheHit: true,
          updatedAt: now - 500,
        } as any,
        c: {
          jobId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          task: 'csv.parse@1.2.0',
          status: 'error',
          partials: 0,
          lastError: 'CapabilityDenied',
          updatedAt: now,
        } as any,
      },
    });
  });

  it('shows p50/p95 and recent jobs list', () => {
    render(<MetricsPanel />);
    expect(screen.getByText(/Compute health/i)).toBeInTheDocument();
    // durations are [100,300] -> p50=100, p95=300
    expect(screen.getByText(/p50: 100 ms/i)).toBeInTheDocument();
    expect(screen.getByText(/p95: 300 ms/i)).toBeInTheDocument();
    // cache ratio: 1/2 done => 50%
    expect(screen.getByText(/cache hits: 1 \(50%\)/i)).toBeInTheDocument();
    // recent jobs section lists job ids and statuses
    expect(screen.getByText(/Recent jobs/i)).toBeInTheDocument();
    expect(screen.getByText(/CapabilityDenied/)).toBeInTheDocument();
  });
});

