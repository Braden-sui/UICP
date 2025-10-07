import { useMemo } from 'react';
import DesktopWindow from './DesktopWindow';
import { useAppStore, type DevtoolsAnalyticsEvent, type IntentTelemetry } from '../state/app';

const formatDuration = (value: number | null) => {
  if (value == null) return '—';
  return `${value} ms`;
};

const formatTimestamp = (value: number) => {
  try {
    return new Date(value).toLocaleTimeString();
  } catch {
    return '';
  }
};

const STATUS_LABEL: Record<IntentTelemetry['status'], string> = {
  planning: 'Planning',
  acting: 'Acting',
  applying: 'Applying',
  applied: 'Applied',
  error: 'Error',
  cancelled: 'Cancelled',
};

// MetricsPanel surfaces recent intent telemetry so the desktop has a lightweight dashboard beyond the DockChat tooltip.
const MetricsPanel = () => {
  const metricsOpen = useAppStore((state) => state.metricsOpen);
  const setMetricsOpen = useAppStore((state) => state.setMetricsOpen);
  const telemetry = useAppStore((state) => state.telemetry);
  const devtoolsEvents = useAppStore((state) => state.devtoolsAnalytics);

  const rows = useMemo(() => telemetry.slice(0, 12), [telemetry]);
  const devtoolsRows = useMemo(() => devtoolsEvents.slice(0, 12), [devtoolsEvents]);

  const formatDirection = (direction: DevtoolsAnalyticsEvent['direction']) => {
    if (direction === 'open') return 'Opened';
    if (direction === 'close') return 'Closed';
    return 'Toggled';
  };

  return (
    <DesktopWindow
      id="metrics"
      title="Intent Metrics"
      isOpen={metricsOpen}
      onClose={() => setMetricsOpen(false)}
      initialPosition={{ x: 420, y: 180 }}
      width={520}
      minHeight={280}
    >
      <div className="flex flex-col gap-3 text-xs text-slate-600">
        <header className="flex items-center justify-between text-[11px] uppercase tracking-wide text-slate-500">
          <span>Recent traces</span>
          <span className="text-[10px] font-mono lowercase text-slate-400">{rows.length} entries</span>
        </header>
        {rows.length === 0 ? (
          <p className="rounded border border-dashed border-slate-300 bg-slate-50 p-4 text-center text-slate-400">
            No telemetry captured yet. Send an intent to populate metrics.
          </p>
        ) : (
          <table className="w-full table-fixed divide-y divide-slate-200 rounded border border-slate-200 bg-white/90 shadow-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Trace</th>
                <th className="px-3 py-2 text-left">Summary</th>
                <th className="px-3 py-2">Plan</th>
                <th className="px-3 py-2">Act</th>
                <th className="px-3 py-2">Apply</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((entry) => (
                <tr key={entry.traceId} className="text-xs">
                  <td className="px-3 py-2 align-top font-mono text-[10px] text-slate-500">
                    <div>{entry.traceId}</div>
                    <div className="text-[9px] uppercase tracking-wide text-slate-400">{formatTimestamp(entry.startedAt)}</div>
                  </td>
                  <td className="px-3 py-2 align-top text-slate-700">
                    <div className="line-clamp-3 whitespace-pre-wrap">{entry.summary || '—'}</div>
                    {entry.batchSize != null && (
                      <div className="text-[10px] text-slate-400">{entry.batchSize} command{entry.batchSize === 1 ? '' : 's'}</div>
                    )}
                    {entry.error && (
                      <div className="mt-1 text-[10px] font-mono uppercase text-red-500">{entry.error}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-center font-mono text-[11px] text-slate-600">{formatDuration(entry.planMs)}</td>
                  <td className="px-3 py-2 text-center font-mono text-[11px] text-slate-600">{formatDuration(entry.actMs)}</td>
                  <td className="px-3 py-2 text-center font-mono text-[11px] text-slate-600">{formatDuration(entry.applyMs)}</td>
                  <td className="px-3 py-2 text-center">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                        entry.status === 'applied'
                          ? 'bg-emerald-50 text-emerald-600'
                          : entry.status === 'error'
                            ? 'bg-red-50 text-red-600'
                            : entry.status === 'cancelled'
                              ? 'bg-slate-100 text-slate-500'
                              : 'bg-sky-50 text-sky-600'
                      }`}
                    >
                      {STATUS_LABEL[entry.status]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {/* Surface devtools shortcut analytics so operators can correlate debugging with agent phases. */}
        <section className="rounded border border-indigo-200 bg-indigo-50 p-3 text-[11px] text-indigo-700">
          <header className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wide">
            <span>Devtools shortcut activity</span>
            <span className="text-[10px] font-mono lowercase text-indigo-600">{devtoolsRows.length} events</span>
          </header>
          {devtoolsRows.length === 0 ? (
            <p className="rounded border border-dashed border-indigo-300 bg-white/80 p-3 text-center text-indigo-400">
              Trigger the devtools shortcut to populate analytics.
            </p>
          ) : (
            <table className="w-full table-fixed divide-y divide-indigo-200 rounded border border-indigo-200 bg-white/90 shadow-sm">
              <thead className="bg-indigo-100 text-[10px] uppercase tracking-wide text-indigo-600">
                <tr>
                  <th className="px-2 py-2 text-left">Time</th>
                  <th className="px-2 py-2 text-left">Direction</th>
                  <th className="px-2 py-2 text-left">Combo</th>
                  <th className="px-2 py-2 text-left">Phase</th>
                  <th className="px-2 py-2 text-center">Streaming</th>
                  <th className="px-2 py-2 text-center">Windows</th>
                  <th className="px-2 py-2 text-center">Full Control</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-indigo-100">
                {devtoolsRows.map((entry) => (
                  <tr key={entry.id} className="text-[11px] text-indigo-700">
                    <td className="px-2 py-2 font-mono text-[10px] text-indigo-500">{formatTimestamp(entry.timestamp)}</td>
                    <td className="px-2 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                          entry.direction === 'open'
                            ? 'bg-emerald-100 text-emerald-700'
                            : entry.direction === 'close'
                              ? 'bg-slate-200 text-slate-700'
                              : 'bg-indigo-200 text-indigo-700'
                        }`}
                      >
                        {formatDirection(entry.direction)}
                      </span>
                    </td>
                    <td className="px-2 py-2 font-mono text-[10px] text-indigo-600">{entry.combo}</td>
                    <td className="px-2 py-2 text-sm font-semibold capitalize text-indigo-700">{entry.context.agentPhase}</td>
                    <td className="px-2 py-2 text-center text-sm font-semibold">
                      {entry.context.streaming ? 'Yes' : 'No'}
                    </td>
                    <td className="px-2 py-2 text-center text-sm font-semibold">{entry.context.workspaceWindows}</td>
                    <td className="px-2 py-2 text-center text-sm font-semibold">
                      {entry.context.fullControl && !entry.context.fullControlLocked ? 'Enabled' : 'Disabled'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </DesktopWindow>
  );
};

export default MetricsPanel;
