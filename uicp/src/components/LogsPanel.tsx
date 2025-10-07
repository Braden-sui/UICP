import { useEffect, useState } from 'react';
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
  const metrics = telemetry.slice(0, 3);
  const [debugEntries, setDebugEntries] = useState<Array<{ ts: number; event: string; requestId?: string; status?: number; len?: number; count?: number }>>([]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    const sub = async () => {
      try {
        const off = await listen('debug-log', (e) => {
          const payload = e.payload as Record<string, unknown>;
          const ts = Number(payload.ts ?? Date.now());
          const event = String(payload.event ?? 'unknown');
          const entry = {
            ts,
            event,
            requestId: typeof payload.requestId === 'string' ? (payload.requestId as string) : undefined,
            status: typeof payload.status === 'number' ? (payload.status as number) : undefined,
            len: typeof payload.len === 'number' ? (payload.len as number) : undefined,
          };
          setDebugEntries((prev) => {
            // Streaming deltas can fire hundreds of times; collapse them per request to avoid flooding the log.
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
                };
                const reordered = [updated, ...prev.slice(0, matchIdx), ...prev.slice(matchIdx + 1)];
                return reordered.slice(0, 200);
              }
              return [{ ...entry, count: 1, len: chunkLen }, ...prev].slice(0, 200);
            }

            return [entry, ...prev].slice(0, 200);
          });
        });
        unlisten = off;
      } catch {
        // ignore
      }
    };
    void sub();
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  return (
    <>
      {/* Logs live inside a movable DesktopWindow so they respect the new OS-style chrome. */}
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
                <span className="text-[10px] font-mono lowercase text-amber-600">{debugEntries.length} entries</span>
              </div>
              <ul className="max-h-40 space-y-1 overflow-auto">
                {debugEntries.slice(0, 40).map((d, i) => (
                  <li key={`dbg-${d.ts}-${i}`} className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[10px] text-amber-600">{new Date(d.ts).toLocaleTimeString()}</span>
                    <span className="flex-1 truncate px-2">
                      {d.event}
                      {d.count && d.count > 1 ? ` x${d.count}` : ''}
                      {d.status != null ? ` ${d.status}` : ''}
                      {d.len != null ? ` len=${d.len}` : ''}
                    </span>
                    {d.requestId && <span className="font-mono text-[10px] text-amber-600">{d.requestId}</span>}
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
