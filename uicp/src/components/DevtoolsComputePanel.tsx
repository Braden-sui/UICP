import { useEffect, useState } from 'react';
import { useComputeStore } from '../state/compute';

const DevtoolsComputePanel = () => {
  const jobs = useComputeStore((s) => s.jobs);
  const [open, setOpen] = useState<boolean>(false);

  useEffect(() => {
    if (import.meta.env.DEV) setOpen(true);
  }, []);

  if (!open) return null;
  const entries = Object.values(jobs).sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <div className="pointer-events-auto fixed bottom-4 left-4 z-50 max-h-[40vh] w-[min(500px,90vw)] overflow-auto rounded-lg border border-slate-200 bg-white/95 p-3 text-sm shadow-lg">
      <div className="mb-2 flex items-center justify-between">
        <div className="font-semibold">Compute Jobs</div>
        <button className="rounded border px-2 py-1 text-xs" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
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
                    {j.cacheHit ? <span className="text-[10px] text-slate-600">cache: hit</span> : null}
                    {j.durationMs != null ? (
                      <span className="text-[10px] text-slate-600">t={Math.round(j.durationMs)}ms</span>
                    ) : null}
                    {j.memPeakMb != null ? (
                      <span className="text-[10px] text-slate-600">mem={Math.round(j.memPeakMb)}MB</span>
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

