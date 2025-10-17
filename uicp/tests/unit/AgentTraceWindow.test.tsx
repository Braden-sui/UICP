import { act, render, screen } from '@testing-library/react';
import AgentTraceWindow from '../../src/components/AgentTraceWindow';
import { useAppStore } from '../../src/state/app';
import { emitTelemetryEvent } from '../../src/lib/telemetry';

describe('AgentTraceWindow', () => {
  beforeEach(() => {
    const store = useAppStore.getState();
    act(() => {
      store.clearTraceEvents();
      store.setAgentTraceOpen(true);
      store.setDevMode(true);
    });
  });

  afterEach(() => {
    const store = useAppStore.getState();
    act(() => {
      store.clearTraceEvents();
      store.setAgentTraceOpen(false);
      store.setDevMode(true);
    });
  });

  it('renders grouped trace spans when open', () => {
    act(() => {
      emitTelemetryEvent('planner_start', { traceId: 'trace-ui', data: { intentLength: 3 } });
      emitTelemetryEvent('planner_finish', { traceId: 'trace-ui', durationMs: 42, data: { summary: 'demo' } });
    });

    render(<AgentTraceWindow />);

    expect(screen.getAllByText('Trace trace-ui')).not.toHaveLength(0);
    expect(screen.getByText('planner_finish')).toBeInTheDocument();
    expect(screen.getByText(/42 ms/)).toBeInTheDocument();
  });

  it('hides when window is closed', () => {
    const store = useAppStore.getState();
    act(() => {
      store.setAgentTraceOpen(false);
    });
    render(<AgentTraceWindow />);
    expect(screen.queryByText(/Trace trace-ui/)).not.toBeInTheDocument();
  });
});
