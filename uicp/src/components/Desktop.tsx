import { useEffect, useRef } from 'react';
import { registerWorkspaceRoot } from '../lib/uicp/adapter';

// Desktop hosts the empty canvas the agent mutates via the adapter.
export const Desktop = () => {
  const rootRef = useRef<HTMLDivElement | null>(null);

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
    </div>
  );
};

export default Desktop;
