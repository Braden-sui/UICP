import { useCallback, useMemo, useState } from 'react';
import DesktopWindow from './DesktopWindow';
import { useAppStore } from '../state/app';
import { createId } from '../lib/utils';
import { useComputeStore } from '../state/compute';
import { invoke } from '@tauri-apps/api/core';

type DemoResult = { ok: boolean; message: string };

const ComputeDemoWindow = () => {
  const isOpen = useAppStore((s) => (s as any).computeDemoOpen as boolean | undefined) ?? false;
  const setOpen = useAppStore((s) => (s as any).setComputeDemoOpen as (v: boolean) => void);
  const pushToast = useAppStore((s) => s.pushToast);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<DemoResult | null>(null);
  const [lastJobId, setLastJobId] = useState<string | null>(null);
  const jobs = useComputeStore((s) => s.jobs);
  const lastJob = lastJobId ? jobs[lastJobId] : undefined;

  const canRun = useMemo(() => !busy, [busy]);

  const runCsvParse = useCallback(async () => {
    if (!canRun) return;
    setBusy(true);
    setLast(null);
    try {
      const anyWin = window as any;
      if (typeof anyWin.uicpComputeCall !== 'function') {
        pushToast({ variant: 'error', message: 'Tauri bridge not ready' });
        setLast({ ok: false, message: 'Bridge unavailable' });
        return;
      }
      const csv = 'name,qty\nalpha,1\nbravo,2\ncharlie,3\n';
      const jobId = createId('job');
      setLastJobId(jobId);
      await anyWin.uicpComputeCall({
        jobId,
        task: 'csv.parse@1.2.0',
        input: { source: csv, hasHeader: true },
        bind: [{ toStatePath: '/tables/demoCsv' }],
        timeoutMs: 30000,
        capabilities: {},
        replayable: true,
        cache: 'readwrite',
        provenance: { envHash: 'dev' },
      });
      setLast({ ok: true, message: 'Submitted csv.parse@1.2.0 → /tables/demoCsv' });
    } catch (err) {
      setLast({ ok: false, message: (err as Error)?.message ?? String(err) });
    } finally {
      setBusy(false);
    }
  }, [canRun, pushToast]);

  const runTableQuery = useCallback(async () => {
    if (!canRun) return;
    setBusy(true);
    setLast(null);
    try {
      const anyWin = window as any;
      if (typeof anyWin.uicpComputeCall !== 'function') {
        pushToast({ variant: 'error', message: 'Tauri bridge not ready' });
        setLast({ ok: false, message: 'Bridge unavailable' });
        return;
      }
      const rows = [
        ['name', 'city'],
        ['alice', 'austin'],
        ['bob', 'boston'],
        ['carol', 'chicago'],
      ];
      const jobId = createId('job');
      setLastJobId(jobId);
      await anyWin.uicpComputeCall({
        jobId,
        task: 'table.query@0.1.0',
        input: { rows, select: [0], where_contains: { col: 1, needle: 'bo' } },
        bind: [{ toStatePath: '/tables/demoQuery' }],
        timeoutMs: 30000,
        capabilities: {},
        replayable: true,
        cache: 'readwrite',
        provenance: { envHash: 'dev' },
      });
      setLast({ ok: true, message: 'Submitted table.query@0.1.0 → /tables/demoQuery' });
    } catch (err) {
      setLast({ ok: false, message: (err as Error)?.message ?? String(err) });
    } finally {
      setBusy(false);
    }
  }, [canRun, pushToast]);

  return (
    <DesktopWindow
      id="compute-demo"
      title="Compute Demo"
      isOpen={isOpen}
      onClose={() => setOpen(false)}
      initialPosition={{ x: 580, y: 180 }}
      width={520}
      minHeight={240}
    >
      <div className="flex flex-col gap-3">
        <div className="text-sm text-slate-600">Run the sample typed tasks and bind results into workspace state.</div>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded bg-slate-900 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-white shadow hover:bg-slate-700 disabled:opacity-50"
            onClick={runCsvParse}
            disabled={!canRun}
          >
            Run csv.parse
          </button>
          <button
            type="button"
            className="rounded border border-slate-300 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-100 disabled:opacity-50"
            onClick={runTableQuery}
            disabled={!canRun}
          >
            Run table.query
          </button>
        </div>
        {lastJob && (
          <div className="flex flex-wrap items-center gap-2 rounded border border-slate-200 bg-slate-50 p-2 text-[11px] text-slate-600">
            <span className="font-mono text-slate-500">{lastJob.jobId}</span>
            <span>• {lastJob.task}</span>
            <span>• status: <strong>{lastJob.status}</strong></span>
            {typeof lastJob.durationMs === 'number' && <span>• {lastJob.durationMs} ms</span>}
            {lastJob.lastError && (
              <span className="rounded bg-red-50 px-2 py-0.5 text-red-600">{lastJob.lastError}</span>
            )}
            <button
              type="button"
              className="ml-auto rounded border border-slate-300 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-100 disabled:opacity-50"
              disabled={!lastJob || (lastJob.status !== 'running' && lastJob.status !== 'partial')}
              onClick={() => lastJob && invoke('compute_cancel', { jobId: lastJob.jobId }).catch(() => {/* ignore */})}
              title="Cancel current job"
            >
              Cancel
            </button>
          </div>
        )}
        {last ? (
          <div className={`text-xs ${last.ok ? 'text-green-700' : 'text-red-700'}`}>{last.message}</div>
        ) : null}
        <div className="text-[11px] text-slate-500">
          Note: build modules + publish manifest first. Bound state paths:
          <button
            type="button"
            className="ml-2 rounded px-1 text-[11px] underline decoration-dotted underline-offset-2 hover:text-slate-700"
            onClick={async () => { try { await navigator.clipboard.writeText('/tables/demoCsv'); } catch {} }}
            title="Copy /tables/demoCsv"
          >
            /tables/demoCsv
          </button>
          ,
          <button
            type="button"
            className="ml-1 rounded px-1 text-[11px] underline decoration-dotted underline-offset-2 hover:text-slate-700"
            onClick={async () => { try { await navigator.clipboard.writeText('/tables/demoQuery'); } catch {} }}
            title="Copy /tables/demoQuery"
          >
            /tables/demoQuery
          </button>
        </div>
      </div>
    </DesktopWindow>
  );
};

export default ComputeDemoWindow;
