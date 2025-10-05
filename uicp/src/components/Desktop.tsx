import { useEffect, useRef, useState } from 'react';
import { registerWorkspaceRoot } from '../lib/uicp/adapter';
import LogsPanel from './LogsPanel';
import { LogsIcon } from '../icons';
import { useAppStore } from '../state/app';

// Desktop hosts the empty canvas the agent mutates via the adapter.
export const Desktop = () => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const setLogsOpen = useAppStore((s) => s.setLogsOpen);
  const [showImg, setShowImg] = useState(true);

  useEffect(() => {
    if (!rootRef.current) return;
    registerWorkspaceRoot(rootRef.current);
  }, []);

  return (
    <div className="relative flex min-h-screen w-full flex-col items-center justify-center">
      <div
        id="workspace-root"
        ref={rootRef}
        className="relative h-full w-full"
        aria-live="polite"
      />
      {/* Desktop shortcuts overlay */}
      <div className="pointer-events-none absolute left-4 top-4 z-30 grid grid-cols-1 gap-4">
        <button
          type="button"
          onClick={() => setLogsOpen(true)}
          className="pointer-events-auto flex w-24 flex-col items-center gap-2 rounded-lg border border-slate-200 bg-white/90 p-3 text-slate-700 shadow hover:bg-white"
          aria-label="Open logs"
        >
          {showImg ? (
            <img
              src="/logs.png"
              alt="Logs"
              className="h-8 w-8"
              onError={() => setShowImg(false)}
            />
          ) : (
            <LogsIcon className="h-8 w-8" />
          )}
          <span className="text-xs font-semibold">Logs</span>
        </button>
      </div>
      <LogsPanel />
    </div>
  );
};

export default Desktop;