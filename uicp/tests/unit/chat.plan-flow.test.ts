import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const applyBatchMock = vi.fn(async (batch: any[]) => ({ success: true, applied: batch.length, errors: [] }));

vi.mock('../../src/lib/uicp/adapter', () => ({
  applyBatch: (batch: any) => applyBatchMock(batch),
}));

const runIntentMock = vi.fn();

vi.mock('../../src/lib/llm/orchestrator', () => ({
  runIntent: (...args: unknown[]) => runIntentMock(...args),
}));

import { useAppStore } from '../../src/state/app';
import { useChatStore } from '../../src/state/chat';
import { validateBatch, validatePlan } from '../../src/lib/uicp/schemas';

describe('chat.plan-flow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    runIntentMock.mockReset();
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
    runIntentMock.mockResolvedValue({
      plan: validatePlan({ summary: 'Create a notepad window', batch: [] }),
      batch: validateBatch([{ op: 'window.create', params: { id: 'win1', title: 'Notepad' } }, { op: 'dom.set', params: { windowId: 'win1', target: '#root', html: '<div>Notepad</div>' } }]),
      notice: undefined,
      traceId: 'trace-1',
      timings: { planMs: 0, actMs: 0 },
      channels: { planner: 'commentary' },
      autoApply: false,
    });
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
    expect(telemetry[0]?.applyMs).not.toBeNull();
  });

  it('stores plan preview and leaves status in acting when full control is disabled', async () => {
    runIntentMock.mockResolvedValue({
      plan: validatePlan({ summary: 'Assemble dashboard', batch: [] }),
      batch: validateBatch([{ op: 'window.create', params: { id: 'win2', title: 'Dashboard' } }, { op: 'dom.set', params: { windowId: 'win2', target: '#root', html: '<div>Dashboard</div>' } }]),
      notice: undefined,
      traceId: 'trace-2',
      timings: { planMs: 10, actMs: 20 },
      channels: { planner: 'commentary' },
      autoApply: false,
    });
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
    runIntentMock.mockResolvedValue({
      plan: validatePlan({ summary: 'Create a notepad', batch: [] }),
      batch: validateBatch([{ op: 'window.create', params: { id: 'win3', title: 'Notepad' } }, { op: 'dom.set', params: { windowId: 'win3', target: '#root', html: '<div>Notepad</div>' } }]),
      notice: undefined,
      traceId: 'trace-3',
      timings: { planMs: 5, actMs: 15 },
      channels: { planner: 'commentary' },
      autoApply: false,
    });
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

  it('auto applies structured clarifier batch without pending plan', async () => {
    const clarifierBatch = validateBatch([
      {
        op: 'api.call',
        params: {
          method: 'POST',
          url: 'uicp://intent',
          body: {
            textPrompt: 'Which operations should the calculator support?',
            submit: 'Continue',
            fields: [{ name: 'answer', label: 'Answer', placeholder: 'e.g., add and subtract' }],
          },
        },
      },
    ]);

    const clarifierPlan = validatePlan({
      summary: 'Which operations should the calculator support?',
      risks: ['clarifier:structured'],
      batch: clarifierBatch,
    });

    runIntentMock.mockResolvedValue({
      plan: clarifierPlan,
      batch: clarifierBatch,
      notice: undefined,
      traceId: 'trace-clarifier',
      timings: { planMs: 45, actMs: 0 },
      channels: { planner: 'commentary' },
      autoApply: true,
    });

    applyBatchMock.mockResolvedValueOnce({ success: true, applied: 1, errors: [] });

    useAppStore.setState({ fullControl: false, fullControlLocked: false });

    const { sendMessage } = useChatStore.getState();
    const promise = sendMessage('build a calculator');
    await vi.advanceTimersByTimeAsync(200);
    await promise;

    expect(runIntentMock).toHaveBeenCalledTimes(1);
    expect(applyBatchMock).toHaveBeenCalledTimes(1);

    const pending = useChatStore.getState().pendingPlan;
    expect(pending).toBeUndefined();

    const assistantMessages = useChatStore.getState().messages.filter((msg) => msg.role === 'assistant');
    expect(assistantMessages[assistantMessages.length - 1]?.content).toContain('Which operations should the calculator support?');

    const systemErrors = useChatStore.getState().messages.filter((msg) => msg.role === 'system' && msg.errorCode === 'clarifier_apply_failed');
    expect(systemErrors.length).toBe(0);

    const status = useAppStore.getState().agentStatus;
    expect(status.phase).toBe('idle');
    expect(status.applyMs).not.toBeNull();
  });

  it('surfaces planner failure details when orchestrator falls back', async () => {
    useAppStore.setState({ fullControl: false, fullControlLocked: false });
    const fallbackPlan = validatePlan({
      summary: 'Planner degraded: using actor-only',
      risks: ['planner_error: upstream offline'],
      batch: [],
    });
    runIntentMock.mockResolvedValueOnce({
      plan: fallbackPlan,
      batch: validateBatch([]),
      notice: 'planner_fallback',
      traceId: 'trace-fail',
      timings: { planMs: 12, actMs: 34 },
      channels: { planner: 'commentary' },
      autoApply: false,
      failures: { planner: 'upstream offline' },
    });

    const { sendMessage } = useChatStore.getState();
    const promise = sendMessage('trigger failure');
    await vi.advanceTimersByTimeAsync(200);
    await promise;

    const systemMessages = useChatStore.getState().messages.filter((msg) => msg.role === 'system');
    expect(systemMessages.some((msg) => msg.content.includes('upstream offline'))).toBe(true);
    const telemetry = useAppStore.getState().telemetry;
    expect(telemetry[0]?.error).toContain('upstream offline');
  });
});

