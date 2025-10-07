import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { useAppStore } from '../../src/state/app';
import { useChatStore } from '../../src/state/chat';

const debugListeners: Array<(event: { payload: unknown }) => void> = [];

vi.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, handler: (ev: { payload: unknown }) => void) => {
    if (name === 'debug-log') {
      debugListeners.push(handler);
    }
    return Promise.resolve(() => {
      if (name === 'debug-log') {
        const idx = debugListeners.indexOf(handler);
        if (idx !== -1) {
          debugListeners.splice(idx, 1);
        }
      }
    });
  },
  emit: vi.fn(),
}));

import LogsPanel from '../../src/components/LogsPanel';

describe('LogsPanel telemetry summary', () => {
  beforeEach(() => {
    debugListeners.length = 0;
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

  it('batches streaming delta_json debug events per request', async () => {
    render(<LogsPanel />);

    await waitFor(() => expect(debugListeners.length).toBeGreaterThan(0));

    const emitDebug = (payload: Record<string, unknown>) => {
      debugListeners.forEach((handler) => handler({ payload }));
    };

    act(() => {
      emitDebug({ ts: Date.now(), event: 'delta_json', requestId: 'req-123', len: 12 });
    });

    await screen.findByText(/delta_json/);

    act(() => {
      emitDebug({ ts: Date.now(), event: 'delta_json', requestId: 'req-123', len: 8 });
      emitDebug({ ts: Date.now(), event: 'delta_json', requestId: 'req-123', len: 10 });
    });

    await waitFor(() => expect(screen.getByText(/delta_json x3/)).toBeInTheDocument());
    expect(screen.getByText(/len=30/)).toBeInTheDocument();
  });
});
