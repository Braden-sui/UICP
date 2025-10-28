import type { FormEvent, KeyboardEvent } from 'react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { useDockReveal } from '../hooks/useDockReveal';
import { useChatStore } from '../state/chat';
import { useAppStore, type AgentPhase } from '../state/app';
import { PaperclipIcon, SendIcon, StopIcon, ClarifierIcon } from '../icons';
import { getPlannerProfile, getActorProfile } from '../lib/llm/profiles';
import { strings } from '../strings';
import { LiquidGlass } from '@liquidglass/react';
import { cancelActiveChat } from '../lib/llm/llm.stream';
import type { Batch } from '../lib/schema';

const STATUS_PHASE_SEQUENCE: AgentPhase[] = ['planning', 'acting', 'previewing', 'applying'];
const STATUS_PHASE_LABEL: Record<AgentPhase, string> = {
  idle: 'Idle',
  planning: 'Planning',
  acting: 'Acting',
  previewing: 'Previewing',
  applying: 'Applying',
  complete: 'Complete',
  cancelled: 'Cancelled',
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
  const plannerProfileKey = useAppStore((state) => state.plannerProfileKey);
  const actorProfileKey = useAppStore((state) => state.actorProfileKey);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const autoApplyPlanRef = useRef<string | null>(null);

  const systemMessages = useMemo(() => messages.filter((msg) => msg.role === 'system'), [messages]);

  const fullControlEnabled = useAppStore((state) => state.fullControl && !state.fullControlLocked);
  const statusSequence = useMemo<AgentPhase[]>(
    () => (fullControlEnabled ? (['planning', 'acting', 'applying'] as AgentPhase[]) : STATUS_PHASE_SEQUENCE),
    [fullControlEnabled],
  );

  const currentPhaseIndex = useMemo(() => {
    if (agentStatus.phase === 'idle') return -1;
    return statusSequence.indexOf(agentStatus.phase);
  }, [agentStatus.phase, statusSequence]);

  const statusTooltip = useMemo(() => {
    const parts: string[] = [];
    if (agentStatus.traceId) parts.push(`Trace ${agentStatus.traceId}`);
    if (agentStatus.planMs !== null) parts.push(`plan ${agentStatus.planMs} ms`);
    if (agentStatus.actMs !== null) parts.push(`act ${agentStatus.actMs} ms`);
    if (agentStatus.applyMs !== null) parts.push(`apply ${agentStatus.applyMs} ms`);
    if (agentStatus.error) parts.push(`last error: ${agentStatus.error}`);
    return parts.length ? parts.join(' - ') : 'No trace yet';
  }, [agentStatus]);

  const phaseBadgeLabel = useMemo(() => STATUS_PHASE_LABEL[agentStatus.phase], [agentStatus.phase]);
  const plannerLabel = useMemo(() => getPlannerProfile(plannerProfileKey).label, [plannerProfileKey]);
  const actorLabel = useMemo(() => getActorProfile(actorProfileKey).label, [actorProfileKey]);
  const lastModels = useAppStore((state) => state.lastModels);
  const plannerDisplay = useMemo(() => {
    const m = lastModels?.planner;
    if (m?.model && typeof m.model === 'string') {
      const prov = m.provider ? `${m.provider}: ` : '';
      const alias = m.alias ? ` (${m.alias})` : '';
      return `${prov}${m.model}${alias}`;
    }
    return plannerLabel;
  }, [lastModels, plannerLabel]);
  const actorDisplay = useMemo(() => {
    const m = lastModels?.actor;
    if (m?.model && typeof m.model === 'string') {
      const prov = m.provider ? `${m.provider}: ` : '';
      const alias = m.alias ? ` (${m.alias})` : '';
      return `${prov}${m.model}${alias}`;
    }
    return actorLabel;
  }, [lastModels, actorLabel]);

  useEffect(() => {
    if (!chatOpen) return;
    inputRef.current?.focus();
  }, [chatOpen]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, pendingPlan]);

  useEffect(() => {
    if (!pendingPlan) {
      autoApplyPlanRef.current = null;
      return;
    }
    if (!fullControlEnabled) return;
    if (streaming) return;
    if (autoApplyPlanRef.current === pendingPlan.id) return;
    autoApplyPlanRef.current = pendingPlan.id;
    void applyPendingPlan().finally(() => {
      if (autoApplyPlanRef.current === pendingPlan.id) {
        autoApplyPlanRef.current = null;
      }
    });
  }, [pendingPlan, fullControlEnabled, streaming, applyPendingPlan]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim()) return;
    await sendMessage(value);
    setValue('');
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      handleSubmit(event as unknown as FormEvent);
    }
  };

  return (
    <div
      className={`pointer-events-none fixed inset-x-0 sm:inset-x-[10%] md:inset-x-[15%] bottom-0 z-40 flex justify-center transition-transform duration-200 ${
        chatOpen ? 'translate-y-0' : 'translate-y-[calc(100%_-_32px)]'
      }`}
    >
      <LiquidGlass
        borderRadius={32}
        blur={0.6}
        contrast={1.2}
        brightness={1.12}
        saturation={1.15}
        // Reduce or eliminate base shelf/drop shadow from the glass container
        shadowIntensity={0.08}
        elasticity={0.8}
        className="pointer-events-auto mb-4 w-full"
      >
        <div className={clsx(
          'relative overflow-hidden flex flex-col gap-3 rounded-[32px] border border-white/20 p-4',
          'bg-white/15 backdrop-blur-2xl backdrop-saturate-150',
          agentStatus.phase !== 'idle' && 'dock-thinking',
        )}>
          {/* Subtle top highlight to emulate liquid-glass sheen; no background shelf */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 -z-10 rounded-[32px]"
            style={{
              background:
                'radial-gradient(120% 80% at 50% -20%, rgba(255,255,255,0.6), rgba(255,255,255,0.18) 45%, rgba(255,255,255,0) 70%)',
            }}
          />
          <header className="flex items-center justify-between text-xs font-medium text-slate-900">
          <div className="flex flex-col gap-1 text-left">
            <span className="drop-shadow-sm">
              {fullControl ? 'Full control enabled' : 'Full control disabled'}
              {fullControlLocked && ' (locked)'}
            </span>
            <span className="text-[11px] uppercase tracking-wide text-slate-700 drop-shadow-sm">
              {plannerDisplay} → {actorDisplay}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {!fullControl && (
              <button
                type="button"
                onClick={openGrantModal}
                className="rounded bg-slate-900 px-3 py-1 text-xs font-semibold text-white transition-all duration-200 hover:bg-slate-700 hover:scale-105 active:scale-95"
              >
                Grant full control
              </button>
            )}
            <button
              type="button"
              onClick={() => setChatOpen(false)}
              className="rounded px-2 py-1 text-xs text-slate-500 transition-all duration-200 hover:text-slate-800 hover:bg-slate-100 active:scale-95"
            >
              Hide
            </button>
          </div>
        </header>

        {/* Status line surfaces orchestrator progress and trace metadata. */}
        <div
          className="flex items-center justify-between rounded-2xl border border-white/20 bg-white/15 backdrop-blur-sm px-3 py-2 text-[11px] uppercase tracking-wide text-slate-800 drop-shadow-sm"
          title={statusTooltip}
        >
          <span>Status</span>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 text-[10px]">
              {statusSequence.map((phaseKey, index) => {
                const phaseClass =
                  currentPhaseIndex === -1
                    ? 'text-slate-500'
                    : currentPhaseIndex === index
                      ? 'text-slate-900 font-semibold drop-shadow-sm'
                      : currentPhaseIndex > index
                        ? 'text-slate-700'
                        : 'text-slate-500';
                return (
                  <Fragment key={phaseKey}>
                    <span className={phaseClass}>{STATUS_PHASE_LABEL[phaseKey]}</span>
                    {index < STATUS_PHASE_SEQUENCE.length - 1 && <span className="text-slate-400">{'→'}</span>}
                  </Fragment>
                );
              })}
            </div>
            <span className="rounded-xl bg-white/25 backdrop-blur-sm px-2 py-0.5 text-[10px] font-semibold text-slate-900 drop-shadow-sm">
              {phaseBadgeLabel}
            </span>
          </div>
        </div>

        <div className="max-h-64 overflow-y-auto rounded-2xl border border-white/20 bg-white/15 backdrop-blur-sm p-3" ref={listRef}>
          <ul className="space-y-3 text-sm">
            {messages.map((message) => (
              <li
                key={message.id}
                className={clsx(
                  // Use calmer blue for non-error system notices (planner hints, telemetry)
                  // to avoid implying failure where there is none. Keep red for error codes.
                  message.role === 'user'
                    ? 'text-slate-900 font-medium drop-shadow-sm'
                    : message.role === 'assistant'
                      ? 'text-slate-800 drop-shadow-sm'
                      : (message.errorCode && (
                          message.errorCode.includes('error') ||
                          message.errorCode === 'apply_errors' ||
                          message.errorCode === 'clarifier_apply_failed' ||
                          message.errorCode === 'ollama_stream_error'
                        ))
                        ? 'text-red-700 font-medium drop-shadow-sm'
                        : message.errorCode === 'clarifier_needed'
                          ? 'text-amber-800 drop-shadow-sm'
                          : 'text-sky-800 drop-shadow-sm',
                  message.errorCode === 'clarifier_needed' && 'rounded-xl border border-amber-300/50 bg-amber-100/30 backdrop-blur-sm px-2 py-1'
                )}
              >
                <span className="block text-xs uppercase tracking-wide text-slate-600 drop-shadow-sm">
                  {message.role}
                  {message.errorCode ? ` - ${message.errorCode}` : ''}
                </span>
                <span>
                  {message.errorCode === 'clarifier_needed' && (
                    <ClarifierIcon
                      className="mr-1 inline h-4 w-4 text-amber-600 align-[-2px]"
                      aria-hidden="true"
                    />
                  )}
                  {message.content}
                </span>
              </li>
            ))}
          </ul>
          {pendingPlan && (
            <div className="mt-4 rounded-2xl border border-white/20 bg-white/15 backdrop-blur-sm p-3">
              <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-700 drop-shadow-sm">
                <span>Plan preview</span>
                <span>{pendingPlan.batch.length} steps</span>
              </div>
              <p className="mt-2 text-sm text-slate-900 drop-shadow-sm">{pendingPlan.summary}</p>
              <ol className="mt-3 space-y-1 text-xs text-slate-700 drop-shadow-sm">
                {pendingPlan.batch.map((command: Batch[number], index: number) => (
                  <li key={`${pendingPlan.id}-${index}`}>
                    <span className="font-mono text-[11px]">{command.op}</span>
                    {command.windowId ? ` - ${command.windowId}` : ''}
                  </li>
                ))}
              </ol>
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={applyPendingPlan}
                  className="rounded bg-slate-900 px-3 py-2 text-xs font-semibold text-white transition-all duration-200 hover:bg-slate-700 hover:scale-105 active:scale-95"
                >
                  Apply plan
                </button>
                <button
                  type="button"
                  onClick={() => useChatStore.setState({ pendingPlan: undefined })}
                  className="rounded border border-slate-300 px-3 py-2 text-xs text-slate-600 transition-all duration-200 hover:bg-slate-100 active:scale-95"
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
              className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition-all duration-200 hover:text-slate-800 hover:bg-slate-50 active:scale-95"
              aria-label="Attach"
            >
              <PaperclipIcon className="h-4 w-4" />
            </button>
            <div className="relative flex-1">
              <label htmlFor="dockchat-input" className="sr-only">
                Chat message
              </label>
              <textarea
                data-dock-chat-input
                data-testid="dockchat-input"
                id="dockchat-input"
                name="message"
                ref={inputRef}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                onFocus={onFocus}
                onBlur={onBlur}
                onKeyDown={handleKeyDown}
                placeholder={strings.chatInputPlaceholder}
                className="h-20 w-full resize-none rounded-2xl border border-white/30 bg-white/20 backdrop-blur-md px-4 py-3 text-sm text-slate-900 placeholder:text-slate-600 shadow-inner transition-all duration-200 focus:border-white/50 focus:bg-white/25"
              />
            </div>
            <button
              type="submit"
              disabled={sending || streaming}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-900 text-white transition-all duration-200 hover:bg-slate-700 hover:scale-110 active:scale-95 disabled:cursor-not-allowed disabled:bg-slate-300"
              aria-label="Send"
            >
              <SendIcon className="h-4 w-4" />
            </button>
            {streaming && (
              <button
                type="button"
                onClick={() => { cancelActiveChat(); cancelStreaming(); }}
                className="flex h-9 items-center gap-1 rounded-full border border-red-400 bg-red-50 px-3 text-xs font-semibold text-red-700 transition-all duration-200 hover:bg-red-100 hover:scale-105 active:scale-95"
              >
                <StopIcon className="h-4 w-4" />
                Stop
              </button>
            )}
          </div>
          <div className="text-[11px] uppercase tracking-wide text-slate-700 drop-shadow-sm">
            Press / to focus - Ctrl/Cmd + Enter to send - Esc collapses when idle
          </div>
        </form>
        <div aria-live="polite" className="visually-hidden">
          {systemMessages.map((message) => (
            <span key={`live-${message.id}`}>{message.content}</span>
          ))}
        </div>
      </div>
    </LiquidGlass>
  </div>
  );
};
export default DockChat;

