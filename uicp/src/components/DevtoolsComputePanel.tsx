import { useEffect, useMemo, useRef, useState } from 'react';
import { summarizeComputeJobs, useComputeStore } from '../state/compute';
import { hasTauriBridge, inv } from '../lib/bridge/tauri';

type DevtoolsComputePanelProps = {
  /**
   * Optional default open state for tests or embeds.
   * In dev builds, the panel auto-opens unless explicitly overridden.
   */
  defaultOpen?: boolean;
};

type ActionLogStats = {
  backpressureEvents: number;
  enqueueFailures: number;
  replyFailures: number;
  droppedAppends: number;
};

const formatBytes = (value?: number | null) => {
  // WHY: Reduce cognitive load in the devtools panel when guests flood stdout.
  if (value == null) return 'n/a';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let next = value / 1024;
  let unitIdx = 0;
  while (next >= 1024 && unitIdx < units.length - 1) {
    next /= 1024;
    unitIdx += 1;
  }
  const precision = next >= 100 ? 0 : next >= 10 ? 1 : 2;
  return `${next.toFixed(precision)} ${units[unitIdx]}`;
};

const formatMs = (value?: number | null) => (value == null ? 'n/a' : `${Math.round(value)} ms`);

// Devtools panel for compute job visibility during development.
// Accessibility: treat as a lightweight dialog with ESC to close and focus management.
const DevtoolsComputePanel = ({ defaultOpen }: DevtoolsComputePanelProps) => {
  const jobs = useComputeStore((s) => s.jobs);
  const [open, setOpen] = useState<boolean>(defaultOpen ?? false);
  const rootRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  type LogEntry = {
    ts: number;
    jobId?: string;
    task?: string;
    seq?: number;
    stream?: string;
    level?: string;
    truncated?: boolean;
    message?: string;
  };
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filterJobId, setFilterJobId] = useState<string>('');
  const [filterLevel, setFilterLevel] = useState<string>('');
  const [actionLogStats, setActionLogStats] = useState<ActionLogStats | null>(null);

  useEffect(() => {
    // Preserve existing behavior: auto-open in dev when caller did not specify.
    if (defaultOpen == null && import.meta.env.DEV) setOpen(true);
  }, [defaultOpen]);

  // Close on Escape for keyboard users.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Move focus to the panel when it opens for assistive tech. Restore by letting user control subsequent focus.
  useEffect(() => {
    if (open) {
      // Prefer focusing the close button for immediate keyboard accessibility.
      closeBtnRef.current?.focus();
    }
  }, [open]);

  // Subscribe to UI debug bus for compute logs (emitted by Tauri bridge)
  useEffect(() => {
    const onUiDebug = (evt: Event) => {
      const detail = (evt as CustomEvent<Record<string, unknown>>).detail;
      if (!detail || typeof detail !== 'object') return;
      const event = String(detail.event ?? '');
      if (event !== 'compute_log') return;
      const entry: LogEntry = {
        ts: Number(detail.ts ?? Date.now()),
        jobId: typeof detail.jobId === 'string' ? (detail.jobId as string) : undefined,
        task: typeof detail.task === 'string' ? (detail.task as string) : undefined,
        seq: typeof detail.seq === 'number' ? (detail.seq as number) : undefined,
        stream: typeof detail.stream === 'string' ? (detail.stream as string) : undefined,
        level: typeof detail.level === 'string' ? (detail.level as string) : undefined,
        truncated: typeof detail.truncated === 'boolean' ? (detail.truncated as boolean) : undefined,
        message: typeof detail.message === 'string' ? (detail.message as string) : undefined,
      };
      setLogs((prev) => [entry, ...prev].slice(0, 200));
    };
    window.addEventListener('ui-debug-log', onUiDebug);
    return () => window.removeEventListener('ui-debug-log', onUiDebug);
  }, []);

  useEffect(() => {
    if (!open) {
      setActionLogStats(null);
      return;
    }
    if (!hasTauriBridge()) return;
    let cancelled = false;
    const loadStats = async () => {
      const result = await inv<ActionLogStats>('get_action_log_stats');
      if (!result.ok || cancelled) return;
      setActionLogStats(result.value);
    };
    void loadStats();
    const id = window.setInterval(loadStats, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [open]);

  // Compute hooks unconditionally before early return to satisfy Rules of Hooks
  const entries = Object.values(jobs).sort((a, b) => b.updatedAt - a.updatedAt);
  const summary = useMemo(() => summarizeComputeJobs(jobs), [jobs]);
  const indicatorChips = useMemo(() => {
    if (summary.total === 0) return [];
    const chips: Array<{ label: string; value: string; tone: string; title?: string }> = [
      {
        label: 'Active',
        value: String(summary.active),
        tone: summary.active > 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500',
        title: 'Queued + running + streaming partial jobs',
      },
      {
        label: 'Cache hits',
        value: `${summary.cacheHits} (${summary.cacheRatio}%)`,
        tone: 'bg-cyan-100 text-cyan-700',
        title: 'Completed jobs served from cache',
      },
    ];
    if (summary.partialsSeen > 0) {
      chips.push({
        label: 'Partials',
        value: String(summary.partialsSeen),
        tone: 'bg-sky-100 text-sky-700',
        title: 'Partial envelopes observed',
      });
    }
    if (summary.partialFrames > 0) {
      chips.push({
        label: 'Frames',
        value: String(summary.partialFrames),
        tone: 'bg-sky-50 text-sky-600',
        title: 'Frames recorded in compute metrics',
      });
    }
    if (summary.invalidPartialsDropped > 0) {
      chips.push({
        label: 'Invalid frames',
        value: String(summary.invalidPartialsDropped),
        tone: 'bg-amber-100 text-amber-700',
      });
    }
    if (summary.logCount > 0) {
      chips.push({
        label: 'Logs',
        value: String(summary.logCount),
        tone: 'bg-indigo-100 text-indigo-700',
        title: 'Guest log records captured for recent jobs',
      });
    }
    if (summary.emittedLogBytes > 0) {
      chips.push({
        label: 'Log bytes',
        value: formatBytes(summary.emittedLogBytes),
        tone: 'bg-indigo-50 text-indigo-700',
        title: 'Total stdout/stderr bytes emitted across jobs',
      });
    }
    if (summary.logThrottleWaits > 0) {
      chips.push({
        label: 'stdout/err waits',
        value: String(summary.logThrottleWaits),
        tone: 'bg-slate-100 text-slate-700',
        title: 'Number of stdout/stderr backpressure waits across jobs',
      });
    }
    if (summary.loggerThrottleWaits > 0) {
      chips.push({
        label: 'logger waits',
        value: String(summary.loggerThrottleWaits),
        tone: 'bg-slate-100 text-slate-700',
        title: 'Number of wasi:logging throttles across jobs',
      });
    }
    if (summary.partialThrottleWaits > 0) {
      chips.push({
        label: 'partial waits',
        value: String(summary.partialThrottleWaits),
        tone: 'bg-slate-100 text-slate-700',
        title: 'Partial stream backpressure counts across jobs',
      });
    }
    if (summary.fuelUsed > 0) {
      chips.push({
        label: 'Fuel',
        value: String(summary.fuelUsed),
        tone: 'bg-amber-50 text-amber-700',
      });
    }
    if (summary.memPeakP95 != null) {
      chips.push({
        label: 'mem p95',
        value: `${Math.round(summary.memPeakP95)} MB`,
        tone: 'bg-rose-100 text-rose-700',
      });
    }
    return chips;
  }, [
    summary.active,
    summary.cacheHits,
    summary.cacheRatio,
    summary.fuelUsed,
    summary.invalidPartialsDropped,
    summary.emittedLogBytes,
    summary.logCount,
    summary.logThrottleWaits,
    summary.loggerThrottleWaits,
    summary.partialThrottleWaits,
    summary.memPeakP95,
    summary.partialFrames,
    summary.partialsSeen,
    summary.total,
  ]);

  if (!open) return null;

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="compute-jobs-title"
      tabIndex={-1}
      className="pointer-events-auto fixed bottom-4 left-4 z-50 max-h-[40vh] w-[min(500px,90vw)] overflow-auto rounded-lg border border-slate-200 bg-white/95 p-3 text-sm shadow-lg"
    >
      <div className="mb-2 flex items-center justify-between">
        <div id="compute-jobs-title" className="font-semibold">
          Compute Jobs
        </div>
        <button
          ref={closeBtnRef}
          className="rounded border px-2 py-1 text-xs"
          aria-label="Close compute jobs panel"
          onClick={() => setOpen(false)}
        >
          Close
        </button>
      </div>
      {indicatorChips.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px]">
          {indicatorChips.map((chip) => (
            <span
              key={`${chip.label}-${chip.value}`}
              className={`rounded px-2 py-0.5 font-semibold uppercase tracking-wide ${chip.tone}`}
              title={chip.title}
            >
              {chip.label}: {chip.value}
            </span>
          ))}
        </div>
      )}
      {actionLogStats && (
        <div className="mb-3 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-4">
          <div className="rounded border border-slate-200 bg-slate-50/80 p-2">
            <div className="text-[9px] uppercase tracking-wide text-slate-500">Backpressure</div>
            <div className="font-mono text-[11px] text-slate-700">{actionLogStats.backpressureEvents}</div>
          </div>
          <div className="rounded border border-slate-200 bg-slate-50/80 p-2">
            <div className="text-[9px] uppercase tracking-wide text-slate-500">Enqueue failures</div>
            <div className="font-mono text-[11px] text-slate-700">{actionLogStats.enqueueFailures}</div>
          </div>
          <div className="rounded border border-slate-200 bg-slate-50/80 p-2">
            <div className="text-[9px] uppercase tracking-wide text-slate-500">Reply failures</div>
            <div className="font-mono text-[11px] text-slate-700">{actionLogStats.replyFailures}</div>
          </div>
          <div
            className={`rounded border p-2 ${
              actionLogStats.droppedAppends > 0
                ? 'border-amber-400 bg-amber-50/80 text-amber-700'
                : 'border-slate-200 bg-slate-50/80 text-slate-700'
            }`}
          >
            <div className="text-[9px] uppercase tracking-wide">Dropped appends</div>
            <div className="font-mono text-[11px]">{actionLogStats.droppedAppends}</div>
          </div>
        </div>
      )}
      {entries.length === 0 ? (
        <div className="text-xs text-slate-500">No jobs yet.</div>
      ) : (
        <table className="w-full table-fixed border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-200 text-left">
              <th className="w-[38%] px-2 py-1">jobId</th>
              <th className="w-[22%] px-2 py-1">task</th>
              <th className="w-[12%] px-2 py-1">status</th>
              <th className="w-[8%] px-2 py-1">partials</th>
              <th className="w-[20%] px-2 py-1">meta</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((j) => {
              const logRecords = j.logCount ?? 0;
              const emittedBytesLabel = formatBytes(j.emittedLogBytes);
              const stdoutWaits = j.logThrottleWaits ?? 0;
              const loggerWaits = j.loggerThrottleWaits ?? 0;
              const partialWaits = j.partialThrottleWaits ?? 0;
              const durationLabel = formatMs(j.durationMs);
              const deadlineLabel = formatMs(j.deadlineMs);
              const remainingLabel = formatMs(j.remainingMsAtFinish);
              // INVARIANT: Wait counters default to zero so the panel never hides an overloaded channel.
              return (
                <tr key={j.jobId} className="border-b border-slate-100">
                  <td className="truncate px-2 py-1 font-mono text-[11px]">{j.jobId}</td>
                  <td className="truncate px-2 py-1">{j.task}</td>
                  <td className="px-2 py-1">
                    <span
                      className={`rounded px-2 py-0.5 text-[10px] ${
                        j.status === 'done'
                          ? 'bg-green-50 text-green-700'
                          : j.status === 'error' || j.status === 'timeout'
                            ? 'bg-red-50 text-red-700'
                            : j.status === 'cancelled'
                              ? 'bg-amber-50 text-amber-700'
                              : 'bg-slate-50 text-slate-700'
                      }`}
                    >
                      {j.status}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-right">{j.partials}</td>
                  <td className="px-2 py-1">
                    <div className="flex flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2 text-[10px] text-slate-600">
                        {j.cacheHit != null ? (
                          <span className={j.cacheHit ? 'text-cyan-700' : 'text-slate-500'}>
                            cache:{' '}
                            <span className="font-semibold">
                              {j.cacheHit ? 'hit' : 'miss'}
                            </span>
                          </span>
                        ) : null}
                        {j.partialFrames != null ? (
                          <span className="text-sky-700">frames={j.partialFrames}</span>
                        ) : null}
                        {j.invalidPartialsDropped ? (
                          <span className="text-amber-700">invalid={j.invalidPartialsDropped}</span>
                        ) : null}
                        {j.fuelUsed != null ? (
                          <span className="text-amber-700">fuel={j.fuelUsed}</span>
                        ) : null}
                        {j.memPeakMb != null ? (
                          <span className="text-slate-600">mem={Math.round(j.memPeakMb)}MB</span>
                        ) : null}
                        {j.lastError ? <span className="text-red-700">{j.lastError}</span> : null}
                      </div>
                      <div className="grid grid-cols-1 gap-1 text-[10px] text-slate-600 sm:grid-cols-3">
                        <div className="rounded border border-indigo-200 bg-indigo-50/60 p-1">
                          <div className="text-[9px] uppercase tracking-wide text-indigo-600">Logs</div>
                          <div className="font-mono text-[10px] text-indigo-700">
                            {logRecords} records
                          </div>
                          <div className="font-mono text-[10px] text-indigo-600">~{emittedBytesLabel}</div>
                        </div>
                        <div className="rounded border border-slate-200 bg-slate-50/80 p-1">
                          <div className="text-[9px] uppercase tracking-wide text-slate-500">Backpressure waits</div>
                          <div className="font-mono text-[10px] text-slate-700">stdout: {stdoutWaits}</div>
                          <div className="font-mono text-[10px] text-slate-700">logger: {loggerWaits}</div>
                          <div className="font-mono text-[10px] text-slate-700">partial: {partialWaits}</div>
                        </div>
                        <div className="rounded border border-amber-200 bg-amber-50/70 p-1">
                          <div className="text-[9px] uppercase tracking-wide text-amber-600">Deadline</div>
                          <div className="font-mono text-[10px] text-amber-700">target: {deadlineLabel}</div>
                          <div className="font-mono text-[10px] text-amber-700">ran: {durationLabel}</div>
                          <div className="font-mono text-[10px] text-amber-700">remaining: {remainingLabel}</div>
                        </div>
                      </div>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {(
        logs.length > 0 || filterJobId || filterLevel
      ) && (
        <div className="mt-3 rounded border border-slate-200 bg-white">
          <div className="mb-2 flex items-center justify-between border-b border-slate-100 px-2 py-1 text-[10px] uppercase tracking-wide text-slate-500">
            <span>Compute logs</span>
            <span className="font-mono lowercase text-slate-400">{logs.length} entries</span>
          </div>
          <div className="flex items-center gap-2 border-b border-slate-100 px-2 py-1">
            <label htmlFor="compute-log-filter-job" className="sr-only">
              Filter jobId
            </label>
            <input
              id="compute-log-filter-job"
              name="filterJobId"
              aria-label="Filter jobId"
              placeholder="job id"
              className="w-36 rounded border border-slate-200 px-2 py-1 text-[11px]"
              value={filterJobId}
              onChange={(e) => setFilterJobId(e.target.value)}
            />
            <select
              aria-label="Filter level"
              className="w-28 rounded border border-slate-200 px-2 py-1 text-[11px]"
              value={filterLevel}
              onChange={(e) => setFilterLevel(e.target.value)}
            >
              <option value="">all levels</option>
              <option value="trace">trace</option>
              <option value="debug">debug</option>
              <option value="info">info</option>
              <option value="warn">warn</option>
              <option value="error">error</option>
              <option value="critical">critical</option>
            </select>
            <button
              type="button"
              className="ml-auto rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50"
              onClick={() => setLogs([])}
              aria-label="Clear logs"
            >
              Clear logs
            </button>
          </div>
          <ul className="max-h-40 space-y-1 overflow-auto p-2">
            {logs
              .filter((d) => (filterJobId ? d.jobId?.includes(filterJobId) : true))
              .filter((d) => (filterLevel ? d.level === filterLevel : true))
              .slice(0, 60)
              .map((d, i) => (
              <li key={`devtools-clog-${d.ts}-${i}`} className="flex flex-col gap-0.5 rounded border border-slate-200 bg-slate-50 px-2 py-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] text-slate-500">{new Date(d.ts).toLocaleTimeString()}</span>
                  <span className="font-mono text-[10px] text-slate-400">{d.jobId ?? ''}#{d.seq ?? 0}</span>
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
        </div>
      )}
    </div>
  );
};

export default DevtoolsComputePanel;
