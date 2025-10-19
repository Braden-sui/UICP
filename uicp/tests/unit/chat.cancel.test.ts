import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock adapter.applyBatch so we can inspect the cancel batch
const applyBatchMock = vi.fn(async (batch: any[]) => ({
  success: true,
  applied: batch.length,
  errors: [],
  skippedDupes: 0,
  skippedDuplicates: 0,
}));

// Mock lifecycle to avoid workspace registration requirement
vi.mock('../../src/lib/uicp/adapters/lifecycle', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/uicp/adapters/lifecycle')>(
    '../../src/lib/uicp/adapters/lifecycle',
  );
  return {
    ...actual,
    applyCommand: vi.fn(async () => ({ success: true, value: 'ok' })),
    persistCommand: vi.fn(async () => {}),
    recordStateCheckpoint: vi.fn(async () => {}),
    deferBatchIfNotReady: () => null,
  };
});

vi.mock('../../src/lib/uicp/adapters/adapter', () => ({
  applyBatch: (batch: any) => applyBatchMock(batch),
}));

import { useAppStore } from '../../src/state/app';
import { useChatStore } from '../../src/state/chat';

describe('chat.cancelStreaming', () => {
  beforeEach(() => {
    applyBatchMock.mockClear();
    // Reset stores
    useAppStore.setState({
      connectionStatus: 'disconnected',
      devMode: true,
      fullControl: true,
      fullControlLocked: false,
      chatOpen: false,
      streaming: true,
      suppressAutoApply: false,
      grantModalOpen: false,
      logsOpen: false,
      metricsOpen: false,
      notepadOpen: false,
      toasts: [],
      telemetry: [],
      desktopShortcuts: {},
      workspaceWindows: {},
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
    useChatStore.setState({ messages: [], pendingPlan: undefined, sending: false, error: undefined });
  });

  it('enqueues txn.cancel, locks full control, appends system message', async () => {
    const { cancelStreaming } = useChatStore.getState();
    cancelStreaming();

    expect(applyBatchMock).toHaveBeenCalledTimes(1);
    const passed = applyBatchMock.mock.calls[0][0];
    expect(Array.isArray(passed)).toBe(true);
    expect(passed[0].op).toBe('txn.cancel');

    const app = useAppStore.getState();
    expect(app.fullControl).toBe(false);
    expect(app.fullControlLocked).toBe(true);
    expect(app.streaming).toBe(false);

    const status = useAppStore.getState().agentStatus;
    expect(status.phase).toBe('idle');
    expect(status.error).toBe('cancelled');

    const { messages } = useChatStore.getState();
    expect(messages[messages.length - 1]?.errorCode).toBe('txn_cancelled');
  });
});
