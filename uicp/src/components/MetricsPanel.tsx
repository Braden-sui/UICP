import { useMemo } from 'react';
import DesktopWindow from './DesktopWindow';
import { useAppStore, type DevtoolsAnalyticsEvent, type IntentTelemetry } from '../state/app';
import { summarizeComputeJobs, useComputeStore } from '../state/compute';

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
  const computeJobs = useComputeStore((s) => s.jobs);

  const telemetryRows = useMemo(() => telemetry.slice(0, 12), [telemetry]);
  const devtoolsRows = useMemo(() => devtoolsEvents.slice(0, 12), [devtoolsEvents]);
  const computeSummary = useMemo(() => summarizeComputeJobs(computeJobs), [computeJobs]);

  const computeIndicators = useMemo(() => {
    if (computeSummary.total === 0) return [];
    const chips: Array<{ key: string; label: string; value: string; className: string; title?: string }> = [
      {
        key: 'active',
        label: 'Active',
        value: String(computeSummary.active),
        className:
          computeSummary.active > 0
            ? 'bg-emerald-100 text-emerald-700'
            : 'bg-slate-100 text-slate-500',
        title: 'Jobs currently queued, running, or streaming partials',
      },
      {
        key: 'cache',
        label: 'Cache',
        value: `${computeSummary.cacheHits} (${computeSummary.cacheRatio}%)`,
        className: 'bg-cyan-100 text-cyan-700',
        title: 'Completed jobs served from compute cache',
      },
    ];
    if (computeSummary.partialsSeen > 0) {
      chips.push({
        key: 'partials',
        label: 'Partials',
        value: String(computeSummary.partialsSeen),
        className: 'bg-sky-100 text-sky-700',
        title: 'Streaming frames observed across active jobs',
      });
    }
    if (computeSummary.partialFrames > 0) {
      chips.push({
        key: 'frames',
        label: 'Frames',
        value: String(computeSummary.partialFrames),
        className: 'bg-sky-50 text-sky-600',
        title: 'Partial frames persisted by host metrics',
      });
    }
    if (computeSummary.invalidPartialsDropped > 0) {
      chips.push({
        key: 'invalid',
        label: 'Invalid frames',
        value: String(computeSummary.invalidPartialsDropped),
        className: 'bg-amber-100 text-amber-700',
        title: 'Host reported partial frames dropped as invalid',
      });
    }
    if (computeSummary.logCount > 0) {
      chips.push({
        key: 'logs',
        label: 'Logs',
        value: String(computeSummary.logCount),
        className: 'bg-indigo-100 text-indigo-700',
        title: 'Guest log records captured for recent jobs',
      });
    }
    if (computeSummary.logThrottleWaits > 0) {
      chips.push({
        key: 'log-waits',
        label: 'stdout/err waits',
        value: String(computeSummary.logThrottleWaits),
        className: 'bg-slate-100 text-slate-700',
        title: 'Number of stdout/stderr backpressure waits across jobs',
      });
    }
    if (computeSummary.loggerThrottleWaits > 0) {
      chips.push({
        key: 'logger-waits',
        label: 'logger waits',
        value: String(computeSummary.loggerThrottleWaits),
        className: 'bg-slate-100 text-slate-700',
        title: 'Number of wasi:logging backpressure waits across jobs',
      });
    }
    if (computeSummary.partialThrottleWaits > 0) {
      chips.push({
        key: 'partial-waits',
        label: 'partial waits',
        value: String(computeSummary.partialThrottleWaits),
        className: 'bg-slate-100 text-slate-700',
        title: 'Number of partial event backpressure waits across jobs',
      });
    }
    if (computeSummary.fuelUsed > 0) {
      chips.push({
        key: 'fuel',
        label: 'Fuel',
        value: String(computeSummary.fuelUsed),
        className: 'bg-amber-50 text-amber-700',
        title: 'Total guest fuel consumed across jobs',
      });
    }
    if (computeSummary.memPeakP95 != null) {
      chips.push({
        key: 'mem',
        label: 'mem p95',
        value: `${Math.round(computeSummary.memPeakP95)} MB`,
        className: 'bg-rose-100 text-rose-700',
        title: '95th percentile peak memory across jobs',
      });
    }
    return chips;
  }, [
    computeSummary.active,
    computeSummary.cacheHits,
    computeSummary.cacheRatio,
    computeSummary.fuelUsed,
    computeSummary.invalidPartialsDropped,
    computeSummary.logCount,
    computeSummary.logThrottleWaits,
    computeSummary.loggerThrottleWaits,
    computeSummary.partialThrottleWaits,
    computeSummary.memPeakP95,
    computeSummary.partialFrames,
    computeSummary.partialsSeen,
    computeSummary.total,
  ]);

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
        <section className="rounded border border-emerald-200 bg-emerald-50 p-3 text-emerald-800">
          <header className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wide">
            <span>Compute health</span>
            <span className="text-[10px] font-mono lowercase text-emerald-700">{computeSummary.total} job(s)</span>
          </header>
          {computeSummary.total === 0 ? (
            <p className="rounded border border-dashed border-emerald-300 bg-white/80 p-3 text-center text-emerald-400">
              No compute jobs yet. Use the Compute Demo to run a sample.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
            <span className="rounded bg-emerald-100 px-2 py-0.5 text-[10px]">running: {computeSummary.running}</span>
              <span className="rounded bg-sky-100 px-2 py-0.5 text-[10px]">partial: {computeSummary.partial}</span>
              <span className="rounded bg-slate-200 px-2 py-0.5 text-[10px]">queued: {computeSummary.queued}</span>
              <span className="rounded bg-emerald-100 px-2 py-0.5 text-[10px]">done: {computeSummary.done}</span>
              <span className="rounded bg-amber-100 px-2 py-0.5 text-[10px]">timeout: {computeSummary.timeout}</span>
              <span className="rounded bg-slate-200 px-2 py-0.5 text-[10px]">cancelled: {computeSummary.cancelled}</span>
              <span className="rounded bg-red-100 px-2 py-0.5 text-[10px]">error: {computeSummary.error}</span>
              <span className="rounded bg-white px-2 py-0.5 text-[10px]">
                p50: {formatDuration(computeSummary.durationP50)}
              </span>
              <span className="rounded bg-white px-2 py-0.5 text-[10px]">
                p95: {formatDuration(computeSummary.durationP95)}
              </span>
              {computeIndicators.length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                  {computeIndicators.map((chip) => (
                    <span
                      key={chip.key}
                      className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${chip.className}`}
                      title={chip.title}
                    >
                      {chip.label}: {chip.value}
                    </span>
                  ))}
                </div>
              )}
              <button
                type="button"
                className="ml-auto rounded border border-slate-300 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600 hover:bg-white"
                onClick={() => {
                  try {
                    const blob = new Blob([JSON.stringify(computeJobs, null, 2)], { type: 'application/json' });
                    const link = document.createElement('a');
                    link.href = URL.createObjectURL(blob);
                    link.download = `compute-jobs-${Date.now()}.json`;
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                    URL.revokeObjectURL(link.href);
                  } catch {
                    // ignore
                  }
                }}
                title="Export compute job telemetry"
              >
                Export JSON
              </button>
            </div>
          )}
        </section>
        {computeSummary.recent && computeSummary.recent.length > 0 && (
          <section className="rounded border border-slate-200 bg-white/90 p-3 text-[11px] text-slate-700">
            <header className="mb-2 flex items-center justify-between text-[10px] uppercase tracking-wide text-slate-500">
              <span>Recent jobs</span>
              <span className="text-[10px] font-mono lowercase text-slate-400">{computeSummary.recent.length} shown</span>
            </header>
            <ul className="space-y-1">
              {computeSummary.recent.map((j) => (
                <li key={j.jobId} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[10px] text-slate-500">{j.jobId}</span>
                  <span>• {j.task}</span>
                  <span>
                    •
                    <span
                      className={`ml-1 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                        j.status === 'done'
                          ? 'bg-emerald-50 text-emerald-700'
                          : j.status === 'error'
                            ? 'bg-red-50 text-red-600'
                            : j.status === 'timeout'
                              ? 'bg-amber-100 text-amber-700'
                              : j.status === 'cancelled'
                                ? 'bg-slate-100 text-slate-600'
                                : 'bg-sky-50 text-sky-700'
                      }`}
                    >
                      {j.status}
                    </span>
                  </span>
                  {typeof j.durationMs === 'number' && <span>• {j.durationMs} ms</span>}
                  {j.cacheHit != null && (
                    <span
                      className={`rounded px-2 py-0.5 text-[10px] ${
                        j.cacheHit ? 'bg-cyan-50 text-cyan-700' : 'bg-slate-100 text-slate-500'
                      }`}
                    >
                      cache {j.cacheHit ? 'hit' : 'miss'}
                    </span>
                  )}
                  {j.lastError && <span className="rounded bg-red-50 px-2 py-0.5 text-red-600">{j.lastError}</span>}
                  {j.partials > 0 && <span className="rounded bg-sky-50 px-2 py-0.5 text-sky-700">{j.partials} partials</span>}
                  {typeof j.partialFrames === 'number' && (
                    <span className="rounded bg-sky-50 px-2 py-0.5 text-sky-600">{j.partialFrames} frames</span>
                  )}
                  {typeof j.invalidPartialsDropped === 'number' && j.invalidPartialsDropped > 0 && (
                    <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-700">
                      {j.invalidPartialsDropped} invalid
                    </span>
                  )}
                  {typeof j.logCount === 'number' && j.logCount > 0 && (
                    <span className="rounded bg-indigo-50 px-2 py-0.5 text-indigo-700">{j.logCount} logs</span>
                  )}
                  {typeof j.fuelUsed === 'number' && j.fuelUsed > 0 && (
                    <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-700">{j.fuelUsed} fuel</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        <header className="flex items-center justify-between text-[11px] uppercase tracking-wide text-slate-500">
          <span>Recent traces</span>
          <span className="text-[10px] font-mono lowercase text-slate-400">
            {telemetryRows.length} entries
          </span>
        </header>
        {telemetryRows.length === 0 ? (
          <p className="rounded border border-dashed border-slate-300 bg-slate-50 p-4 text-center text-slate-400">
            No telemetry captured yet. Send an intent to populate metrics.
          </p>
        ) : (
          <table className="w-full table-fixed divide-y divide-slate-200 rounded border border-slate-200 bg-white/90 shadow-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Trace / Batch / Run</th>
                <th className="px-3 py-2 text-left">Summary</th>
                <th className="px-3 py-2">Plan</th>
                <th className="px-3 py-2">Act</th>
                <th className="px-3 py-2">Apply</th>
                <th className="px-3 py-2">Status</th>
              </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {telemetryRows.map((entry) => (
                <tr key={entry.traceId} className="text-xs">
                  <td className="px-3 py-2 align-top font-mono text-[10px] text-slate-500">
                    <div>{entry.traceId}</div>
                    {entry.batchId && (
                      <div className="text-[9px] text-slate-400">batch: {entry.batchId}</div>
                    )}
                    {entry.runId != null && (
                      <div className="text-[9px] text-slate-400">run: #{entry.runId}</div>
                    )}
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
