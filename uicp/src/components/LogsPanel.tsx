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
