import { useCallback, useMemo, useState } from 'react';
import DesktopWindow from './DesktopWindow';
import { useAppSelector } from '../state/app';
import { newUuid } from '../lib/utils';
import { useComputeStore } from '../state/compute';
import { hasTauriBridge, tauriInvoke } from '../lib/bridge/tauri';
import { getComputeBridge } from '../lib/bridge/globals';
import type { JobSpec } from '../compute/types';

// Try to use Tauri dialog plugin if available; otherwise fail gracefully.
const openDialog = async (opts: { multiple?: boolean }): Promise<string | null> => {
  try {
    // Dynamically import so browser-only builds don’t fail.
    const mod = await import('@tauri-apps/plugin-dialog');
    const sel = await mod.open({ multiple: !!opts.multiple, directory: false });
    if (typeof sel === 'string') return sel;
    if (Array.isArray(sel) && sel.length > 0 && typeof sel[0] === 'string') return sel[0] as string;
    return null;
  } catch {
    throw new Error('Dialog plugin unavailable');
  }
};

type DemoResult = { ok: boolean; message: string };

const ComputeDemoWindow = () => {
  const isOpen = useAppSelector((s) => s.computeDemoOpen);
  const setOpen = useAppSelector((s) => s.setComputeDemoOpen);
  const pushToast = useAppSelector((s) => s.pushToast);
  const copyToClipboard = useCallback(
    async (value: string) => {
      try {
        await navigator.clipboard.writeText(value);
        pushToast({ variant: 'success', message: `Copied ${value}` });
      } catch (err) {
        pushToast({ variant: 'error', message: `Copy failed: ${(err as Error)?.message ?? String(err)}` });
      }
    },
    [pushToast],
  );
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<DemoResult | null>(null);
  const [lastJobId, setLastJobId] = useState<string | null>(null);
  const jobs = useComputeStore((s) => s.jobs);
  const lastJob = lastJobId ? jobs[lastJobId] : undefined;
  const [wsPath, setWsPath] = useState('ws:/files/demo.csv');

  const canRun = useMemo(() => !busy, [busy]);

  const runCsvParse = useCallback(async () => {
    if (!canRun) return;
    setBusy(true);
    setLast(null);
    try {
      const computeCall = getComputeBridge();
      if (typeof computeCall !== 'function') {
        pushToast({ variant: 'error', message: 'Tauri bridge not ready' });
        setLast({ ok: false, message: 'Bridge unavailable' });
        return;
      }
      const csv = 'name,qty\nalpha,1\nbravo,2\ncharlie,3\n';
      const jobId = newUuid();
      setLastJobId(jobId);
      const spec: JobSpec = {
        jobId,
        task: 'csv.parse@1.2.0',
        input: { source: csv, hasHeader: true },
        bind: [{ toStatePath: '/tables/demoCsv' }],
        timeoutMs: 30000,
        capabilities: {},
        replayable: true,
        cache: 'readwrite',
        provenance: { envHash: 'dev' },
        workspaceId: 'default',
      };
      await computeCall(spec);
      setLast({ ok: true, message: 'Submitted csv.parse@1.2.0 to /tables/demoCsv' });
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
      const computeCall = getComputeBridge();
      if (typeof computeCall !== 'function') {
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
      const jobId = newUuid();
      setLastJobId(jobId);
      const spec: JobSpec = {
        jobId,
        task: 'table.query@0.1.0',
        input: { rows, select: [0], where_contains: { col: 1, needle: 'bo' } },
        bind: [{ toStatePath: '/tables/demoQuery' }],
        timeoutMs: 30000,
        capabilities: {},
        replayable: true,
        cache: 'readwrite',
        provenance: { envHash: 'dev' },
        workspaceId: 'default',
      };
      await computeCall(spec);
      setLast({ ok: true, message: 'Submitted table.query@0.1.0 to /tables/demoQuery' });
    } catch (err) {
      setLast({ ok: false, message: (err as Error)?.message ?? String(err) });
    } finally {
      setBusy(false);
    }
  }, [canRun, pushToast]);

  const runCsvParseFromWs = useCallback(async () => {
    if (!canRun) return;
    setBusy(true);
    setLast(null);
    try {
      const computeCall = getComputeBridge();
      if (typeof computeCall !== 'function') {
        pushToast({ variant: 'error', message: 'Tauri bridge not ready' });
        setLast({ ok: false, message: 'Bridge unavailable' });
        return;
      }
      const jobId = newUuid();
      setLastJobId(jobId);
      const spec: JobSpec = {
        jobId,
        task: 'csv.parse@1.2.0',
        input: { source: wsPath, hasHeader: true },
        bind: [{ toStatePath: '/tables/demoCsv' }],
        timeoutMs: 30000,
        capabilities: { fsRead: ['ws:/files/**'] },
        replayable: true,
        cache: 'readwrite',
        provenance: { envHash: 'dev' },
        workspaceId: 'default',
      };
      await computeCall(spec);
      setLast({ ok: true, message: `Submitted csv.parse from ${wsPath}` });
    } catch (err) {
      setLast({ ok: false, message: (err as Error)?.message ?? String(err) });
    } finally {
      setBusy(false);
    }
  }, [canRun, pushToast, wsPath]);

  const openFilesFolder = useCallback(async () => {
    try {
      if (!hasTauriBridge()) {
        pushToast({ variant: 'error', message: 'File actions require the Tauri runtime' });
        return;
      }
      const info = await tauriInvoke<{ filesDir?: string }>('get_paths');
      if (info?.filesDir) await tauriInvoke('open_path', { path: info.filesDir });
    } catch (err) {
      pushToast({ variant: 'error', message: `Open folder failed: ${(err as Error)?.message ?? String(err)}` });
    }
  }, [pushToast]);

  const importFileIntoWorkspace = useCallback(async () => {
    try {
      const selected = await openDialog({ multiple: false });
      if (!selected || Array.isArray(selected)) return;
      const srcPath = String(selected);
      if (!hasTauriBridge()) {
        // Fallback: if no Tauri, just show a hint path (does not actually import)
        setWsPath(srcPath.startsWith('ws:') ? srcPath : `ws:/files/${srcPath.split(/[\\/]/).pop()}`);
        pushToast({ variant: 'info', message: 'Bridge unavailable: path set but file not imported' });
        return;
      }
      const wsRef = await tauriInvoke<string>('copy_into_files', { srcPath });
      if (typeof wsRef === 'string' && wsRef.startsWith('ws:/')) {
        setWsPath(wsRef);
        pushToast({ variant: 'success', message: `Imported to ${wsRef}` });
      } else {
        pushToast({ variant: 'error', message: 'Import failed: invalid response' });
      }
    } catch (err) {
      pushToast({ variant: 'error', message: `Import failed: ${(err as Error)?.message ?? String(err)}` });
    }
  }, [setWsPath, pushToast]);

  const exportWorkspaceFile = useCallback(async () => {
    try {
      if (!wsPath || !wsPath.startsWith('ws:/files/')) {
        pushToast({ variant: 'error', message: 'Set a ws:/files path first' });
        return;
      }
      // Pick a destination path using save dialog
      const dlg = await import('@tauri-apps/plugin-dialog');
      const baseName = wsPath.split('/').pop() ?? 'export.dat';
      const destPath = await dlg.save({ defaultPath: baseName });
      if (!destPath || Array.isArray(destPath)) return;
      if (!hasTauriBridge()) {
        pushToast({ variant: 'error', message: 'Export requires the Tauri runtime' });
        return;
      }
      const finalPath = await tauriInvoke<string>('export_from_files', { wsPath, destPath });
      pushToast({ variant: 'success', message: `Exported to ${finalPath}` });
    } catch (err) {
      pushToast({ variant: 'error', message: `Export failed: ${(err as Error)?.message ?? String(err)}` });
    }
  }, [wsPath, pushToast]);

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
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="compute-demo-workspace-path" className="sr-only">
            Workspace file path
          </label>
          <input
            id="compute-demo-workspace-path"
            name="workspacePath"
            value={wsPath}
            onChange={(e) => setWsPath(e.target.value)}
            className="min-w-[220px] flex-1 rounded border border-slate-300 bg-white/90 px-2 py-1 text-xs text-slate-800 shadow-inner focus:border-slate-400 focus:outline-none"
            placeholder="ws:/files/demo.csv"
            aria-label="Workspace file path"
          />
          <button
            type="button"
            className="rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-100 disabled:opacity-50"
            onClick={importFileIntoWorkspace}
          >
            Import File…
          </button>
          <button
            type="button"
            className="rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-100 disabled:opacity-50"
            onClick={openFilesFolder}
          >
            Open Files Folder
          </button>
          <button
            type="button"
            className="rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-100 disabled:opacity-50"
            onClick={exportWorkspaceFile}
          >
            Export ws:/ file…
          </button>
          <button
            type="button"
            className="rounded bg-slate-900 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-white shadow hover:bg-slate-700 disabled:opacity-50"
            onClick={runCsvParseFromWs}
            disabled={!canRun}
          >
            Run csv.parse (ws:/files)
          </button>
        </div>
        {lastJob && (
          <div className="flex flex-wrap items-center gap-2 rounded border border-slate-200 bg-slate-50 p-2 text-[11px] text-slate-600">
            <span className="font-mono text-slate-500">{lastJob.jobId}</span>
            <span>• {lastJob.task}</span>
            <span>• status: <strong>{lastJob.status}</strong></span>
            {typeof lastJob.durationMs === 'number' && <span>• {lastJob.durationMs} ms</span>}
            {lastJob.cacheHit != null && (
              <span
                className={`rounded px-2 py-0.5 text-[10px] ${
                  lastJob.cacheHit ? 'bg-cyan-100 text-cyan-700' : 'bg-slate-200 text-slate-600'
                }`}
              >
                cache {lastJob.cacheHit ? 'hit' : 'miss'}
              </span>
            )}
            {lastJob.partials > 0 && (
              <span className="rounded bg-sky-100 px-2 py-0.5 text-[10px] text-sky-700">
                {lastJob.partials} partial{lastJob.partials === 1 ? '' : 's'}
              </span>
            )}
            {typeof lastJob.partialFrames === 'number' && (
              <span className="rounded bg-sky-50 px-2 py-0.5 text-[10px] text-sky-600">
                {lastJob.partialFrames} frame{lastJob.partialFrames === 1 ? '' : 's'}
              </span>
            )}
            {typeof lastJob.invalidPartialsDropped === 'number' && lastJob.invalidPartialsDropped > 0 && (
              <span className="rounded bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700">
                {lastJob.invalidPartialsDropped} invalid
              </span>
            )}
            {typeof lastJob.logCount === 'number' && lastJob.logCount > 0 && (
              <span className="rounded bg-indigo-50 px-2 py-0.5 text-[10px] text-indigo-700">
                {lastJob.logCount} log{lastJob.logCount === 1 ? '' : 's'}
              </span>
            )}
            {typeof lastJob.fuelUsed === 'number' && lastJob.fuelUsed > 0 && (
              <span className="rounded bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700">
                {lastJob.fuelUsed} fuel
              </span>
            )}
            {typeof lastJob.memPeakMb === 'number' && (
              <span className="rounded bg-rose-50 px-2 py-0.5 text-[10px] text-rose-700">
                mem {Math.round(lastJob.memPeakMb)} MB
              </span>
            )}
            {lastJob.lastError && (
              <span className="rounded bg-red-50 px-2 py-0.5 text-red-600">{lastJob.lastError}</span>
            )}
            <button
              type="button"
              className="ml-auto rounded border border-slate-300 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-100 disabled:opacity-50"
              disabled={!lastJob || (lastJob.status !== 'running' && lastJob.status !== 'partial')}
              onClick={async () => {
                if (!lastJob) return;
                if (!hasTauriBridge()) {
                  pushToast({ variant: 'error', message: 'Cancel requires the Tauri runtime' });
                  return;
                }
                try {
                  await tauriInvoke('compute_cancel', { jobId: lastJob.jobId });
                } catch (err) {
                  pushToast({ variant: 'error', message: `Cancel failed: ${(err as Error)?.message ?? String(err)}` });
                }
              }}
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
            onClick={() => copyToClipboard('/tables/demoCsv')}
            title="Copy /tables/demoCsv"
          >
            /tables/demoCsv
          </button>
          ,
          <button
            type="button"
            className="ml-1 rounded px-1 text-[11px] underline decoration-dotted underline-offset-2 hover:text-slate-700"
            onClick={() => copyToClipboard('/tables/demoQuery')}
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
