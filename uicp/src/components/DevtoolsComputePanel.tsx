import { useEffect, useMemo, useRef, useState } from 'react';
import { summarizeComputeJobs, useComputeStore } from '../state/compute';

type DevtoolsComputePanelProps = {
  /**
   * Optional default open state for tests or embeds.
   * In dev builds, the panel auto-opens unless explicitly overridden.
   */
  defaultOpen?: boolean;
};

// Devtools panel for compute job visibility during development.
// Accessibility: treat as a lightweight dialog with ESC to close and focus management.
const DevtoolsComputePanel = ({ defaultOpen }: DevtoolsComputePanelProps) => {
  const jobs = useComputeStore((s) => s.jobs);
  const [open, setOpen] = useState<boolean>(defaultOpen ?? false);
  const rootRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

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
    summary.logCount,
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
            {entries.map((j) => (
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
                  <div className="flex flex-col gap-0.5">
                    {j.cacheHit != null ? (
                      <span
                        className={`text-[10px] ${
                          j.cacheHit ? 'text-cyan-700' : 'text-slate-500'
                        }`}
                      >
                        cache: {j.cacheHit ? 'hit' : 'miss'}
                      </span>
                    ) : null}
                    {j.durationMs != null ? (
                      <span className="text-[10px] text-slate-600">t={Math.round(j.durationMs)}ms</span>
                    ) : null}
                    {j.partialFrames != null ? (
                      <span className="text-[10px] text-sky-700">frames={j.partialFrames}</span>
                    ) : null}
                    {j.invalidPartialsDropped ? (
                      <span className="text-[10px] text-amber-700">invalid={j.invalidPartialsDropped}</span>
                    ) : null}
                    {j.logCount ? <span className="text-[10px] text-indigo-700">logs={j.logCount}</span> : null}
                    {j.fuelUsed != null ? (
                      <span className="text-[10px] text-amber-700">fuel={j.fuelUsed}</span>
                    ) : null}
                    {j.memPeakMb != null ? (
                      <span className="text-[10px] text-slate-600">mem={Math.round(j.memPeakMb)}MB</span>
                    ) : null}
                    {j.deadlineMs != null ? (
                      <span className="text-[10px] text-slate-500">deadline={j.deadlineMs}ms</span>
                    ) : null}
                    {j.remainingMsAtFinish != null ? (
                      <span className="text-[10px] text-slate-500">remaining={j.remainingMsAtFinish}ms</span>
                    ) : null}
                    {j.lastError ? <span className="text-[10px] text-red-700">{j.lastError}</span> : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

export default DevtoolsComputePanel;
