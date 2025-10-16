import { useEffect, useMemo, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useChatStore } from '../state/chat';
import { useAppStore } from '../state/app';
import DesktopWindow from './DesktopWindow';

const formatTimestamp = (value: number) => {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return '';
  }
};

const formatDuration = (value: number | null) => {
  if (value == null) return '—';
  return `${value} ms`;
};

export const LogsPanel = () => {
  const messages = useChatStore((state) => state.messages);
  const logsOpen = useAppStore((s) => s.logsOpen);
  const setLogsOpen = useAppStore((s) => s.setLogsOpen);
  const setMetricsOpen = useAppStore((s) => s.setMetricsOpen);
  const telemetry = useAppStore((s) => s.telemetry);
  const metrics = useMemo(() => telemetry.slice(0, 3), [telemetry]);
  type DebugEntry = {
    ts: number;
    event: string;
    requestId?: string;
    status?: number;
    len?: number;
    count?: number;
    // UI debug extras
    gen?: number;
    traceId?: string;
    windowId?: string;
    applied?: number;
    ms?: number;
    jobId?: string;
    ageMs?: number;
    message?: string;
    inFlight?: number;
    // Compute log extras
    seq?: number;
    stream?: string;
    level?: string;
    truncated?: boolean;
    // LLM diagnostics
    model?: string;
    channel?: string;
    text?: string;
    textLength?: number;
    totalDeltaCount?: number;
    transcripts?: Record<string, unknown>;
    toolCalls?: unknown;
    firstDeltaMs?: number | null;
    durationMs?: number;
    role?: string;
    profileKey?: string;
    messagesCount?: number;
    toolsCount?: number;
    timeoutMs?: number | null;
    intent?: string;
    planSummary?: string;
    stage?: string;
    toolCallIndex?: number;
    toolCallId?: string;
    toolCallName?: string;
  };
  const [debugEntries, setDebugEntries] = useState<Array<DebugEntry>>([]);
  const [showLlm, setShowLlm] = useState(true);
  const [showComputeLogs, setShowComputeLogs] = useState(true);
  const [showOtherDebug, setShowOtherDebug] = useState(true);
  const filteredDebugEntries = useMemo(() => {
    const categorize = (entry: DebugEntry): 'llm' | 'compute' | 'other' => {
      if (entry.event.startsWith('llm_')) return 'llm';
      if (entry.event.startsWith('compute_')) return 'compute';
      return 'other';
    };
    return debugEntries.filter((entry) => {
      const category = categorize(entry);
      if (category === 'llm' && !showLlm) return false;
      if (category === 'compute' && !showComputeLogs) return false;
      if (category === 'other' && !showOtherDebug) return false;
      return true;
    });
  }, [debugEntries, showLlm, showComputeLogs, showOtherDebug]);

  useEffect(() => {
    let unlistenTauri: (() => void) | null = null;
    let unlistenUi: (() => void) | null = null;
    const sub = async () => {
      try {
        // Backend debug logs
        const off = await listen('debug-log', (e) => {
          const payload = e.payload as Record<string, unknown>;
          const ts = Number(payload.ts ?? Date.now());
          const event = String(payload.event ?? 'unknown');
          const entry: DebugEntry = {
            ts,
            event,
            requestId: typeof payload.requestId === 'string' ? (payload.requestId as string) : undefined,
            status: typeof payload.status === 'number' ? (payload.status as number) : undefined,
            len: typeof payload.len === 'number' ? (payload.len as number) : undefined,
          };
          setDebugEntries((prev) => {
            if (event === 'delta_json') {
              const matchIdx = prev.findIndex((item) => item.event === event && item.requestId === entry.requestId);
              const chunkLen = entry.len ?? 0;
              if (matchIdx !== -1) {
                const existing = prev[matchIdx];
                const updated = {
                  ...existing,
                  ts,
                  len: (existing.len ?? 0) + chunkLen,
                  count: (existing.count ?? 1) + 1,
                } as DebugEntry;
                const reorder = [updated, ...prev.slice(0, matchIdx), ...prev.slice(matchIdx + 1)];
                return reorder.slice(0, 200);
              }
              return [{ ...entry, count: 1, len: chunkLen } as DebugEntry, ...prev].slice(0, 200);
            }
            return [entry, ...prev].slice(0, 200);
          });
        });
        unlistenTauri = off;
      } catch {
        // ignore
      }

      // UI-side debug logs
      const onUiDebug = (evt: Event) => {
        const detail = (evt as CustomEvent<Record<string, unknown>>).detail;
        if (!detail || typeof detail !== 'object') return;
        const ts = Number(detail.ts ?? Date.now());
        const event = String(detail.event ?? 'ui-debug-log');
        const entry: DebugEntry = {
          ts,
          event,
          traceId: typeof detail.traceId === 'string' ? (detail.traceId as string) : undefined,
          gen: typeof detail.gen === 'number' ? (detail.gen as number) : undefined,
          windowId: typeof detail.windowId === 'string' ? (detail.windowId as string) : undefined,
          applied: typeof detail.applied === 'number' ? (detail.applied as number) : undefined,
          ms: typeof detail.ms === 'number' ? (detail.ms as number) : undefined,
          jobId: typeof detail.jobId === 'string' ? (detail.jobId as string) : undefined,
          ageMs: typeof detail.ageMs === 'number' ? (detail.ageMs as number) : undefined,
          requestId: typeof detail.requestId === 'string' ? (detail.requestId as string) : undefined,
          model: typeof detail.model === 'string' ? (detail.model as string) : undefined,
          channel: typeof detail.channel === 'string' ? (detail.channel as string) : undefined,
          text: typeof detail.text === 'string' ? (detail.text as string) : undefined,
          textLength: typeof detail.textLength === 'number' ? (detail.textLength as number) : undefined,
          totalDeltaCount: typeof detail.totalDeltaCount === 'number' ? (detail.totalDeltaCount as number) : undefined,
          transcripts: detail.transcripts && typeof detail.transcripts === 'object' ? (detail.transcripts as Record<string, unknown>) : undefined,
          toolCalls: detail.toolCalls,
          firstDeltaMs: typeof detail.firstDeltaMs === 'number' ? (detail.firstDeltaMs as number) : null,
          durationMs: typeof detail.durationMs === 'number' ? (detail.durationMs as number) : undefined,
          role: typeof detail.role === 'string' ? (detail.role as string) : undefined,
          profileKey: typeof detail.profileKey === 'string' ? (detail.profileKey as string) : undefined,
          messagesCount: typeof detail.messagesCount === 'number' ? (detail.messagesCount as number) : undefined,
          toolsCount: typeof detail.toolsCount === 'number' ? (detail.toolsCount as number) : undefined,
          timeoutMs: typeof detail.timeoutMs === 'number' || detail.timeoutMs === null ? (detail.timeoutMs as number | null) : undefined,
          intent: typeof detail.intent === 'string' ? (detail.intent as string) : undefined,
          planSummary: typeof detail.planSummary === 'string' ? (detail.planSummary as string) : undefined,
          stage: typeof detail.stage === 'string' ? (detail.stage as string) : undefined,
          toolCallIndex: typeof detail.toolCallIndex === 'number' ? (detail.toolCallIndex as number) : undefined,
          toolCallId: typeof detail.toolCallId === 'string' ? (detail.toolCallId as string) : undefined,
          toolCallName: typeof detail.toolCallName === 'string' ? (detail.toolCallName as string) : undefined,
        };
        setDebugEntries((prev) => [entry, ...prev].slice(0, 200));
      };
      window.addEventListener('ui-debug-log', onUiDebug);
      unlistenUi = () => window.removeEventListener('ui-debug-log', onUiDebug);
    };
    void sub();
    return () => {
      if (unlistenTauri) unlistenTauri();
      if (unlistenUi) unlistenUi();
    };
  }, []);

  return (
    <>
      <DesktopWindow
        id="logs"
        title="Logs"
        isOpen={logsOpen}
        onClose={() => setLogsOpen(false)}
        initialPosition={{ x: 560, y: 160 }}
        width={420}
      >
        <div className="flex flex-col gap-3 text-xs">
          <header className="flex items-center justify-between text-[11px] uppercase tracking-wide text-slate-500">
            <span>Conversation Logs</span>
            <span className="text-[10px] font-mono lowercase text-slate-400">{messages.length} entries</span>
          </header>
          {metrics.length > 0 && (
            <section className="rounded border border-slate-200 bg-slate-50 p-3 text-[11px] text-slate-500">
              <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wide">
                <span>Recent metrics</span>
                <button
                  type="button"
                  onClick={() => setMetricsOpen(true)}
                  className="rounded px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 hover:bg-slate-100"
                >
                  Open dashboard
                </button>
              </div>
              <ul className="space-y-2">
                {metrics.map((entry) => (
                  <li key={`metric-${entry.traceId}`} className="flex flex-col gap-1 rounded border border-slate-200 bg-white/90 px-2 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] font-mono uppercase tracking-wide text-slate-400">
                      <span>{entry.traceId}</span>
                      <span>{formatTimestamp(entry.startedAt)}</span>
                    </div>
                    <div className="text-[11px] font-semibold text-slate-600">{entry.summary || '—'}</div>
                    <div className="flex flex-wrap items-center gap-3 text-[10px] text-slate-500">
                      <span>plan {formatDuration(entry.planMs)}</span>
                      <span>act {formatDuration(entry.actMs)}</span>
                      <span>apply {formatDuration(entry.applyMs)}</span>
                      {entry.batchSize != null && <span>{entry.batchSize} cmd</span>}
                      <span
                        className={`rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                          entry.status === 'applied'
                            ? 'bg-emerald-50 text-emerald-600'
                            : entry.status === 'error'
                              ? 'bg-red-50 text-red-600'
                              : entry.status === 'cancelled'
                                ? 'bg-slate-100 text-slate-500'
                                : 'bg-sky-50 text-sky-600'
                        }`}
                      >
                        {entry.status}
                      </span>
                    </div>
                    {entry.error && (
                      <div className="text-[10px] font-mono uppercase text-red-500">{entry.error}</div>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {debugEntries.length > 0 && (
            <section className="rounded border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-700">
              <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wide">
                <span>Debug events</span>
                <div className="flex items-center gap-1 text-[10px]">
                  <button
                    type="button"
                    onClick={() => setShowLlm((value) => !value)}
                    className={`rounded px-1.5 py-0.5 font-semibold uppercase tracking-wide ${showLlm ? 'bg-amber-600 text-white' : 'bg-amber-200 text-amber-700'}`}
                    aria-pressed={showLlm}
                  >
                    LLM
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowComputeLogs((value) => !value)}
                    className={`rounded px-1.5 py-0.5 font-semibold uppercase tracking-wide ${showComputeLogs ? 'bg-amber-600 text-white' : 'bg-amber-200 text-amber-700'}`}
                    aria-pressed={showComputeLogs}
                  >
                    Compute
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowOtherDebug((value) => !value)}
                    className={`rounded px-1.5 py-0.5 font-semibold uppercase tracking-wide ${showOtherDebug ? 'bg-amber-600 text-white' : 'bg-amber-200 text-amber-700'}`}
                    aria-pressed={showOtherDebug}
                  >
                    Other
                  </button>
                </div>
              </div>
              <ul className="max-h-48 space-y-1 overflow-auto">
                {filteredDebugEntries.slice(0, 60).map((entry, index) => {
                  const timeLabel = new Date(entry.ts).toLocaleTimeString();
                  if (entry.event === 'llm_request_started') {
                    return (
                      <li key={`llm-start-${entry.ts}-${index}`} className="flex flex-col gap-0.5 rounded border border-sky-200 bg-sky-50 p-2">
                        <div className="flex items-center justify-between text-[10px] font-mono text-sky-700">
                          <span>{timeLabel}</span>
                          <span>{entry.requestId ?? entry.traceId ?? ''}</span>
                        </div>
                        <div className="text-[10px] uppercase tracking-wide text-sky-600">
                          Start • {entry.model ?? 'model'} • {entry.role ?? 'planner'} • msgs {entry.messagesCount ?? 0} • tools {entry.toolsCount ?? 0}
                        </div>
                        {entry.timeoutMs !== undefined && (
                          <div className="text-[10px] text-sky-500">Timeout {entry.timeoutMs === null ? 'signal' : `${entry.timeoutMs}ms`}</div>
                        )}
                        {entry.intent && (
                          <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words bg-white/80 p-2 text-[11px] text-sky-800">{entry.intent}</pre>
                        )}
                        {entry.planSummary && (
                          <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words bg-white/80 p-2 text-[11px] text-sky-800">{entry.planSummary}</pre>
                        )}
                      </li>
                    );
                  }
                  if (entry.event === 'llm_delta') {
                    return (
                      <li key={`llm-delta-${entry.ts}-${index}`} className="flex flex-col gap-0.5 rounded border border-amber-200 bg-amber-100 p-2">
                        <div className="flex items-center justify-between text-[10px] font-mono text-amber-700">
                          <span>{timeLabel}</span>
                          <span>{entry.requestId ?? entry.traceId ?? ''}</span>
                        </div>
                        <div className="text-[10px] uppercase tracking-wide text-amber-600">
                          Delta • {entry.channel ?? 'text'} • {entry.model ?? 'model'} • #{entry.totalDeltaCount ?? 0} • len {entry.textLength ?? 0}
                        </div>
                        {entry.text && (
                          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words bg-white/80 p-2 text-[11px] text-amber-800">{entry.text}</pre>
                        )}
                      </li>
                    );
                  }
                  if (entry.event === 'llm_tool_call_delta') {
                    return (
                      <li key={`llm-tool-${entry.ts}-${index}`} className="flex flex-col gap-0.5 rounded border border-purple-200 bg-purple-50 p-2">
                        <div className="flex items-center justify-between text-[10px] font-mono text-purple-700">
                          <span>{timeLabel}</span>
                          <span>{entry.requestId ?? entry.traceId ?? ''}</span>
                        </div>
                        <div className="text-[10px] uppercase tracking-wide text-purple-600">
                          Tool • {entry.toolCallName ?? 'function'} • #{entry.toolCallIndex ?? 0}
                        </div>
                        {entry.toolCallId && <div className="text-[10px] text-purple-500">id: {entry.toolCallId}</div>}
                      </li>
                    );
                  }
                  if (entry.event === 'llm_complete') {
                    const transcripts = entry.transcripts && typeof entry.transcripts === 'object' ? (entry.transcripts as Record<string, unknown>) : undefined;
                    const toolCalls = Array.isArray(entry.toolCalls) ? (entry.toolCalls as unknown[]) : undefined;
                    return (
                      <li key={`llm-complete-${entry.ts}-${index}`} className="flex flex-col gap-1 rounded border border-emerald-200 bg-emerald-50 p-2">
                        <div className="flex items-center justify-between text-[10px] font-mono text-emerald-700">
                          <span>{timeLabel}</span>
                          <span>{entry.requestId ?? entry.traceId ?? ''}</span>
                        </div>
                        <div className="text-[10px] uppercase tracking-wide text-emerald-600">
                          Complete • {entry.model ?? 'model'} • {entry.role ?? 'planner'} • {entry.durationMs != null ? `${entry.durationMs}ms` : '—'} • first delta {entry.firstDeltaMs != null ? `${entry.firstDeltaMs}ms` : '—'}
                        </div>
                        {transcripts && Object.keys(transcripts).length > 0 && (
                          <details className="rounded border border-emerald-200 bg-white/80 p-2 text-[11px] text-emerald-800">
                            <summary className="cursor-pointer pb-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-600">Transcripts</summary>
                            <div className="flex flex-col gap-2">
                              {Object.entries(transcripts).map(([key, value]) => (
                                <div key={key} className="flex flex-col gap-1">
                                  <span className="text-[10px] uppercase tracking-wide text-emerald-500">{key}</span>
                                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words bg-emerald-50 p-2">{String(value ?? '')}</pre>
                                </div>
                              ))}
                            </div>
                          </details>
                        )}
                        {toolCalls && toolCalls.length > 0 && (
                          <details className="rounded border border-emerald-200 bg-white/80 p-2 text-[11px] text-emerald-800">
                            <summary className="cursor-pointer pb-1 text-[10px] font-semibold uppercase tracking-wide text-emerald-600">Tool Calls</summary>
                            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words bg-emerald-50 p-2">{JSON.stringify(toolCalls, null, 2)}</pre>
                          </details>
                        )}
                      </li>
                    );
                  }
                  if (entry.event === 'llm_error') {
                    return (
                      <li key={`llm-error-${entry.ts}-${index}`} className="flex flex-col gap-0.5 rounded border border-rose-200 bg-rose-50 p-2">
                        <div className="flex items-center justify-between text-[10px] font-mono text-rose-700">
                          <span>{timeLabel}</span>
                          <span>{entry.requestId ?? entry.traceId ?? ''}</span>
                        </div>
                        <div className="text-[10px] uppercase tracking-wide text-rose-600">
                          Error • {entry.stage ?? 'unknown'} • {entry.model ?? 'model'}
                        </div>
                        {entry.message && <div className="text-[11px] text-rose-700">{entry.message}</div>}
                      </li>
                    );
                  }
                  return (
                    <li key={`dbg-${entry.ts}-${index}`} className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[10px] text-amber-600">{timeLabel}</span>
                      <span className="flex-1 truncate px-2">
                        {entry.event}
                        {entry.count && entry.count > 1 ? ` x${entry.count}` : ''}
                        {entry.status != null ? ` ${entry.status}` : ''}
                        {entry.len != null ? ` len=${entry.len}` : ''}
                        {entry.applied != null ? ` applied=${entry.applied}` : ''}
                        {entry.ms != null ? ` ms=${entry.ms}` : ''}
                        {entry.inFlight != null ? ` inFlight=${entry.inFlight}` : ''}
                        {entry.gen != null ? ` gen=${entry.gen}` : ''}
                      </span>
                      <span className="font-mono text-[10px] text-amber-600">
                        {entry.requestId ?? entry.traceId ?? entry.windowId ?? entry.jobId ?? ''}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {/* Compute logs (previews) */}
          {debugEntries.some((d) => d.event === 'compute_log') && (
            <section className="rounded border border-slate-200 bg-white p-3 text-[11px] text-slate-700">
              <div className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wide text-slate-500">
                <span>Compute logs</span>
                <span className="text-[10px] font-mono lowercase text-slate-400">
                  {debugEntries.filter((d) => d.event === 'compute_log').length} entries
                </span>
              </div>
              <ul className="max-h-48 space-y-1 overflow-auto">
                {debugEntries
                  .filter((d) => d.event === 'compute_log')
                  .slice(0, 100)
                  .map((d, i) => (
                    <li key={`clog-${d.ts}-${i}`} className="flex flex-col gap-0.5 rounded border border-slate-200 bg-slate-50 px-2 py-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[10px] text-slate-500">{new Date(d.ts).toLocaleTimeString()}</span>
                        <span className="font-mono text-[10px] text-slate-400">
                          {d.jobId ?? ''}#{d.seq ?? 0}
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wide text-slate-500">
                        <span className="rounded bg-slate-100 px-1.5 py-0.5">{d.stream ?? 'stdout'}</span>
                        {d.level && <span className="rounded bg-slate-100 px-1.5 py-0.5">{d.level}</span>}
                        {d.truncated && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-700">truncated</span>}
                      </div>
                      {d.message && <div className="whitespace-pre-wrap break-words text-[11px] text-slate-700">{d.message}</div>}
                    </li>
                  ))}
              </ul>
            </section>
          )}
          <ul className="flex flex-col gap-2 text-slate-700">
            {messages.length === 0 && <li className="text-slate-400">No messages yet.</li>}
            {messages.map((message) => (
              <li key={message.id} className="rounded border border-slate-200 bg-slate-50 px-2 py-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold uppercase tracking-wide text-slate-500">{message.role}</span>
                  <span className="text-[10px] text-slate-400">{formatTimestamp(message.createdAt)}</span>
                </div>
                {message.errorCode && (
                  <div className="mt-1 text-[10px] font-mono uppercase text-red-500">{message.errorCode}</div>
                )}
                <p className="mt-1 whitespace-pre-wrap text-slate-700">{message.content}</p>
              </li>
            ))}
          </ul>
        </div>
      </DesktopWindow>
      <div className="pointer-events-none absolute bottom-4 right-4 z-40 flex flex-col items-end gap-2 text-sm">
        <button
          type="button"
          onClick={() => setLogsOpen(!logsOpen)}
          className="pointer-events-auto rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white shadow hover:bg-slate-700"
          aria-expanded={logsOpen}
        >
          {logsOpen ? 'Hide Logs' : 'Open Logs'}
        </button>
      </div>
    </>
  );
};

export default LogsPanel;
