import type { ChangeEvent, FormEvent, KeyboardEvent } from 'react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useDockReveal } from '../hooks/useDockReveal';
import { useChatStore } from '../state/chat';
import { useAppStore, type AgentMode, type AgentPhase } from '../state/app';
import { PaperclipIcon, SendIcon, StopIcon } from '../icons';
import { streamOllamaCompletion } from '../lib/llm/ollama';

const STATUS_PHASE_SEQUENCE: AgentPhase[] = ['planning', 'acting', 'applying'];
const STATUS_PHASE_LABEL: Record<AgentPhase, string> = {
  idle: 'Idle',
  planning: 'Planning',
  acting: 'Acting',
  applying: 'Applying',
};

// DockChat is the single control surface for the agent. It handles proximity reveal, input, plan review, and actions.
export const DockChat = () => {
  const { chatOpen, onFocus, onBlur, setChatOpen } = useDockReveal();
  const { messages, pendingPlan, sending, sendMessage, applyPendingPlan, cancelStreaming } = useChatStore();
  const streaming = useAppStore((state) => state.streaming);
  const agentStatus = useAppStore((state) => state.agentStatus);
  const openGrantModal = useAppStore((state) => state.openGrantModal);
  const fullControl = useAppStore((state) => state.fullControl);
  const fullControlLocked = useAppStore((state) => state.fullControlLocked);
  const agentMode = useAppStore((state) => state.agentMode);
  const setAgentMode = useAppStore((state) => state.setAgentMode);
  const pushToast = useAppStore((state) => state.pushToast);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const systemMessages = useMemo(() => messages.filter((msg) => msg.role === 'system'), [messages]);

  const currentPhaseIndex = useMemo(() => {
    if (agentStatus.phase === 'idle') return -1;
    return STATUS_PHASE_SEQUENCE.indexOf(agentStatus.phase);
  }, [agentStatus.phase]);

  const statusTooltip = useMemo(() => {
    const parts: string[] = [];
    if (agentStatus.traceId) parts.push(`Trace ${agentStatus.traceId}`);
    if (agentStatus.planMs !== null) parts.push(`plan ${agentStatus.planMs} ms`);
    if (agentStatus.actMs !== null) parts.push(`act ${agentStatus.actMs} ms`);
    if (agentStatus.applyMs !== null) parts.push(`apply ${agentStatus.applyMs} ms`);
    if (agentStatus.error) parts.push(`last error: ${agentStatus.error}`);
    return parts.length ? parts.join(' • ') : 'No trace yet';
  }, [agentStatus]);

  const phaseBadgeLabel = useMemo(() => STATUS_PHASE_LABEL[agentStatus.phase], [agentStatus.phase]);

  useEffect(() => {
    if (!chatOpen) return;
    inputRef.current?.focus();
  }, [chatOpen]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, pendingPlan]);

  // DEV-only smoke test for Ollama streaming and tool-call parsing.
  // Remove after verification.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    // Only run inside the Tauri WebView (not in a plain browser tab)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hasTauri = typeof (window as any).__TAURI__ !== 'undefined';
    if (!hasTauri) return;
    let cancelled = false;

    const run = async () => {
      try {
        const messages = [
          { role: 'system', content: 'You are a function-calling assistant. Always use the provided function when applicable.' },
          { role: 'user', content: 'Add 2 and 3 using the add function. Only call the tool.' },
        ];
        const tools = [
          {
            type: 'function',
            function: {
              name: 'add',
              description: 'Add two numbers',
              parameters: {
                type: 'object',
                properties: { a: { type: 'number' }, b: { type: 'number' } },
                required: ['a', 'b'],
              },
            },
          },
        ];

        for await (const ev of streamOllamaCompletion(messages, 'gpt-oss:120b-cloud', tools)) {
          if (cancelled) break;
          console.log('[SMOKE]', ev);
          if (ev.type === 'done') break;
        }
      } catch (err) {
        console.error('[SMOKE] stream error', err);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim()) return;
    await sendMessage(value);
    setValue('');
  };

  const handleAgentModeChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value as AgentMode;
    if (next === agentMode) return;
    setAgentMode(next);
    pushToast({
      variant: 'info',
      message: next === 'live' ? 'Live agents enabled. Mock mode disabled.' : 'Mock mode enabled for testing.',
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      handleSubmit(event as unknown as FormEvent);
    }
  };

  return (
    <div
      className={`pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center transition-transform duration-200 ${
        chatOpen ? 'translate-y-0' : 'translate-y-[calc(100%_-_32px)]'
      }`}
    >
      <div className="pointer-events-auto mb-4 flex w-[min(640px,90vw)] flex-col gap-3 rounded-t-3xl border border-slate-200 bg-white/85 p-4 shadow-2xl backdrop-blur">
        <header className="flex items-center justify-between text-xs font-medium text-slate-600">
          <div className="flex flex-col gap-1 text-left">
            <span>
              {fullControl ? 'Full control enabled' : 'Full control disabled'}
              {fullControlLocked && ' (locked)'}
            </span>
            <span className="text-[11px] uppercase tracking-wide text-slate-400">
              Agent mode: {agentMode === 'mock' ? 'Mock (testing)' : 'Live (DeepSeek → Qwen)'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 rounded border border-slate-200 bg-white px-2 py-1 text-[11px] uppercase tracking-wide text-slate-500">
              <span>Mode</span>
              <select
                value={agentMode}
                onChange={handleAgentModeChange}
                className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px] text-slate-600 focus:outline-none"
              >
                <option value="live">Live</option>
                <option value="mock">Mock</option>
              </select>
            </label>
            {!fullControl && (
              <button
                type="button"
                onClick={openGrantModal}
                className="rounded bg-slate-900 px-3 py-1 text-xs font-semibold text-white hover:bg-slate-700"
              >
                Grant full control
              </button>
            )}
            <button
              type="button"
              onClick={() => setChatOpen(false)}
              className="rounded px-2 py-1 text-xs text-slate-500 hover:text-slate-800"
            >
              Hide
            </button>
          </div>
        </header>

        {/* Status line surfaces orchestrator progress and trace metadata. */}
        <div
          className="flex items-center justify-between rounded-lg border border-slate-200 bg-white/70 px-3 py-2 text-[11px] uppercase tracking-wide text-slate-500"
          title={statusTooltip}
        >
          <span>Status</span>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 text-[10px]">
              {STATUS_PHASE_SEQUENCE.map((phaseKey, index) => {
                const phaseClass =
                  currentPhaseIndex === -1
                    ? 'text-slate-400'
                    : currentPhaseIndex === index
                      ? 'text-slate-900 font-semibold'
                      : currentPhaseIndex > index
                        ? 'text-slate-600'
                        : 'text-slate-400';
                return (
                  <Fragment key={phaseKey}>
                    <span className={phaseClass}>{STATUS_PHASE_LABEL[phaseKey]}</span>
                    {index < STATUS_PHASE_SEQUENCE.length - 1 && <span className="text-slate-300">→</span>}
                  </Fragment>
                );
              })}
            </div>
            <span className="rounded bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
              {phaseBadgeLabel}
            </span>
          </div>
        </div>

        <div className="max-h-64 overflow-y-auto rounded-lg border border-slate-200 bg-white/80 p-3" ref={listRef}>
          <ul className="space-y-3 text-sm">
            {messages.map((message) => (
              <li
                key={message.id}
                className={
                  message.role === 'user'
                    ? 'text-slate-800'
                    : message.role === 'assistant'
                      ? 'text-slate-600'
                      : 'text-red-600'
                }
              >
                <span className="block text-xs uppercase tracking-wide text-slate-400">
                  {message.role}
                  {message.errorCode ? ` • ${message.errorCode}` : ''}
                </span>
                <span>{message.content}</span>
              </li>
            ))}
          </ul>
          {pendingPlan && (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-500">
                <span>Plan preview</span>
                <span>{pendingPlan.batch.length} steps</span>
              </div>
              <p className="mt-2 text-sm text-slate-600">{pendingPlan.summary}</p>
              <ol className="mt-3 space-y-1 text-xs text-slate-500">
                {pendingPlan.batch.map((command, index) => (
                  <li key={`${pendingPlan.id}-${index}`}>
                    <span className="font-mono text-[11px]">{command.op}</span>
                    {command.windowId ? ` • ${command.windowId}` : ''}
                  </li>
                ))}
              </ol>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={applyPendingPlan}
                  className="rounded bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-700"
                >
                  Apply plan
                </button>
                <button
                  type="button"
                  onClick={() => useChatStore.setState({ pendingPlan: undefined })}
                  className="rounded border border-slate-300 px-3 py-2 text-xs text-slate-600 hover:bg-slate-100"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 text-slate-500 hover:text-slate-800"
              aria-label="Attach"
            >
              <PaperclipIcon className="h-4 w-4" />
            </button>
            <div className="relative flex-1">
              <textarea
                ref={inputRef}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onFocus={onFocus}
                onBlur={onBlur}
                onKeyDown={handleKeyDown}
                placeholder="Describe what you want to build..."
                className="h-20 w-full resize-none rounded-2xl border border-slate-200 bg-white/90 px-4 py-3 text-sm text-slate-800 shadow-inner focus:border-slate-400"
              />
            </div>
            <button
              type="submit"
              disabled={sending || streaming}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-900 text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              aria-label="Send"
            >
              <SendIcon className="h-4 w-4" />
            </button>
            {streaming && (
              <button
                type="button"
                onClick={cancelStreaming}
                className="flex h-9 items-center gap-1 rounded-full border border-red-400 bg-red-50 px-3 text-xs font-semibold text-red-700 hover:bg-red-100"
              >
                <StopIcon className="h-4 w-4" />
                Stop
              </button>
            )}
          </div>
          <div className="text-[11px] uppercase tracking-wide text-slate-400">
            Press / to focus • Ctrl/Cmd + Enter to send • Esc collapses when idle
          </div>
        </form>

        <div aria-live="polite" className="visually-hidden">
          {systemMessages.map((message) => (
            <span key={`live-${message.id}`}>{message.content}</span>
          ))}
        </div>
      </div>
    </div>
  );
};

export default DockChat;



