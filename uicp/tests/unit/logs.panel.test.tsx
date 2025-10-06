import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LogsPanel from '../../src/components/LogsPanel';
import { useAppStore } from '../../src/state/app';
import { useChatStore } from '../../src/state/chat';

describe('LogsPanel telemetry summary', () => {
  beforeEach(() => {
    useChatStore.setState({ messages: [] });
    useAppStore.setState({
      logsOpen: true,
      metricsOpen: false,
      telemetry: [
        {
          traceId: 'trace-123',
          summary: 'Create a notepad window',
          startedAt: Date.now(),
          planMs: 12,
          actMs: 34,
          applyMs: 56,
          batchSize: 2,
          status: 'applied',
          error: undefined,
          updatedAt: Date.now(),
        },
      ],
    });
  });

  it('renders recent metrics and opens dashboard on demand', () => {
    render(<LogsPanel />);

    expect(screen.getByText(/Recent metrics/i)).toBeInTheDocument();
    expect(screen.getByText(/plan 12 ms/i)).toBeInTheDocument();
    expect(screen.getByText(/act 34 ms/i)).toBeInTheDocument();
    expect(screen.getByText(/apply 56 ms/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /open dashboard/i }));
    expect(useAppStore.getState().metricsOpen).toBe(true);
  });
});
