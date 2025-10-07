import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import DevtoolsAnalyticsListener from '../../src/components/DevtoolsAnalyticsListener';
import { useAppStore } from '../../src/state/app';

const emitMock = vi.fn();

vi.mock('@tauri-apps/api/event', () => ({
  emit: (...args: unknown[]) => emitMock(...args),
  listen: vi.fn(),
}));

describe('DevtoolsAnalyticsListener', () => {
  beforeEach(() => {
    emitMock.mockReset();
    useAppStore.setState({
      devtoolsAnalytics: [],
      devtoolsAssumedOpen: false,
      logsOpen: false,
      metricsOpen: false,
      notepadOpen: false,
      agentSettingsOpen: false,
      workspaceWindows: {},
      devMode: false,
      agentMode: 'mock',
      fullControl: true,
      fullControlLocked: false,
      streaming: false,
      agentStatus: {
        phase: 'idle',
        traceId: undefined,
        planMs: null,
        actMs: null,
        applyMs: null,
        startedAt: null,
        lastUpdatedAt: null,
        error: undefined,
      },
    });
  });

  afterEach(() => {
    emitMock.mockReset();
  });

  it('records analytics and emits debug event for Ctrl+Shift+I', () => {
    render(<DevtoolsAnalyticsListener />);

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'I', ctrlKey: true, shiftKey: true }),
    );

    const events = useAppStore.getState().devtoolsAnalytics;
    expect(events).toHaveLength(1);
    expect(events[0]?.direction).toBe('open');
    expect(events[0]?.combo).toBe('Ctrl+Shift+I');

    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'I', ctrlKey: true, shiftKey: true }),
    );

    const toggledEvents = useAppStore.getState().devtoolsAnalytics;
    expect(toggledEvents).toHaveLength(2);
    expect(toggledEvents[0]?.direction).toBe('close');

    expect(emitMock).toHaveBeenCalled();
    const payload = emitMock.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload?.event).toBe('devtools_shortcut');
    expect(payload?.direction).toBe('open');
  });

  it('detects macOS combo Cmd+Opt+I', () => {
    const platformGetter = vi.spyOn(window.navigator, 'platform', 'get');
    platformGetter.mockReturnValue('MacIntel');

    try {
      render(<DevtoolsAnalyticsListener />);

      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'I', metaKey: true, altKey: true }),
      );

      const events = useAppStore.getState().devtoolsAnalytics;
      expect(events).toHaveLength(1);
      expect(events[0]?.combo).toBe('Cmd+Opt+I');
      expect(events[0]?.context.platform).toBe('mac');
    } finally {
      platformGetter.mockRestore();
    }
  });
});
