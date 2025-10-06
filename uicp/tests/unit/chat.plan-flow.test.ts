import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const applyBatchMock = vi.fn(async (batch: any[]) => ({ success: true, applied: batch.length, errors: [] }));

vi.mock('../../src/lib/uicp/adapter', () => ({
  applyBatch: (batch: any) => applyBatchMock(batch),
}));

import { useAppStore } from '../../src/state/app';
import { useChatStore } from '../../src/state/chat';

describe('chat.plan-flow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    applyBatchMock.mockClear();
    applyBatchMock.mockResolvedValue({ success: true, applied: 2, errors: [] });

    useAppStore.setState({
      connectionStatus: 'disconnected',
      devMode: true,
      fullControl: false,
      fullControlLocked: false,
      chatOpen: false,
      streaming: false,
      suppressAutoApply: false,
      grantModalOpen: false,
      logsOpen: false,
      metricsOpen: false,
      notepadOpen: false,
      toasts: [],
      telemetry: [],
      agentMode: 'mock',
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds planner summary before auto apply and records apply telemetry', async () => {
    useAppStore.setState({ fullControl: true });
    const { sendMessage } = useChatStore.getState();
    const sendPromise = sendMessage('create a notepad');
    await vi.advanceTimersByTimeAsync(200);
    await sendPromise;

    const messages = useChatStore.getState().messages;
    expect(messages).toHaveLength(4);
    expect(messages[0]?.role).toBe('user');
    expect(messages[1]?.role).toBe('system');
    expect(messages[1]?.errorCode).toBe('telemetry_metrics');
    expect(messages[2]?.role).toBe('assistant');
    expect(messages[2]?.content).toMatch(/notepad/i);
    expect(messages[3]?.role).toBe('system');
    expect(messages[3]?.content).toMatch(/Applied 2 commands in [0-9]+ ms/);

    const status = useAppStore.getState().agentStatus;
    expect(status.phase).toBe('idle');
    expect(status.traceId).toBeTruthy();
    expect(status.applyMs).not.toBeNull();
    expect(applyBatchMock).toHaveBeenCalledTimes(1);

    const telemetry = useAppStore.getState().telemetry;
    expect(telemetry.length).toBeGreaterThanOrEqual(1);
    expect(telemetry[0]?.status).toBe('applied');
    expect(telemetry[0]?.planMs).toBe(0);
    expect(telemetry[0]?.actMs).toBe(0);
    expect(telemetry[0]?.applyMs).not.toBeNull();
  });

  it('stores plan preview and leaves status in acting when full control is disabled', async () => {
    const { sendMessage } = useChatStore.getState();
    const sendPromise = sendMessage('assemble a dashboard');
    await vi.advanceTimersByTimeAsync(200);
    await sendPromise;

    expect(applyBatchMock).not.toHaveBeenCalled();
    const messages = useChatStore.getState().messages;
    expect(messages).toHaveLength(3);
    expect(messages[1]?.errorCode).toBe('telemetry_metrics');
    expect(messages[2]?.content).toMatch(/Review the plan/i);

    const pending = useChatStore.getState().pendingPlan;
    expect(pending).toBeDefined();
    expect(pending?.traceId).toBeTruthy();

    const status = useAppStore.getState().agentStatus;
    expect(status.phase).toBe('acting');

    const telemetry = useAppStore.getState().telemetry;
    expect(telemetry[0]?.status).toBe('acting');
    expect(telemetry[0]?.batchSize).toBe(2);
  });

  it('applies pending plan when full control is enabled later', async () => {
    const { sendMessage } = useChatStore.getState();
    const sendPromise = sendMessage('create a notepad');
    await vi.advanceTimersByTimeAsync(200);
    await sendPromise;

    expect(useChatStore.getState().pendingPlan).toBeDefined();

    useAppStore.setState({ fullControl: true });
    await vi.advanceTimersByTimeAsync(200);
    await Promise.resolve();

    const messages = useChatStore.getState().messages;
    const last = messages[messages.length - 1];
    expect(last.role).toBe('system');
    expect(last.content).toMatch(/Applied 2 commands in [0-9]+ ms/);
    expect(useChatStore.getState().pendingPlan).toBeUndefined();

    const status = useAppStore.getState().agentStatus;
    expect(status.phase).toBe('idle');
    expect(status.applyMs).not.toBeNull();
    expect(status.traceId).toBeTruthy();
    expect(applyBatchMock).toHaveBeenCalledTimes(1);

    const telemetry = useAppStore.getState().telemetry;
    expect(telemetry[0]?.status).toBe('applied');
    expect(telemetry[0]?.applyMs).not.toBeNull();
    expect(telemetry[0]?.summary).toMatch(/notepad/i);
  });
});
