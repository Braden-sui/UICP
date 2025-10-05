import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { registerWorkspaceRoot, registerWindowLifecycle, listWorkspaceWindows, closeWorkspaceWindow } from '../lib/uicp/adapter';
import LogsPanel from './LogsPanel';
import DesktopIcon from './DesktopIcon';
import DesktopMenuBar, { type DesktopMenu } from './DesktopMenuBar';
import { LogsIcon } from '../icons';
import { useAppStore, type DesktopShortcutPosition } from '../state/app';

const LOGS_SHORTCUT_ID = 'logs';
const LOGS_SHORTCUT_DEFAULT = { x: 32, y: 32 } as const;

// Desktop hosts the empty canvas the agent mutates via the adapter and surfaces shortcuts for manual control.
export const Desktop = () => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [showImg, setShowImg] = useState(true);
  const logsOpen = useAppStore((s) => s.logsOpen);
  const setLogsOpen = useAppStore((s) => s.setLogsOpen);
  const openLogs = useCallback(() => setLogsOpen(true), [setLogsOpen]);
  const hideLogs = useCallback(() => setLogsOpen(false), [setLogsOpen]);
  const ensureShortcut = useAppStore((s) => s.ensureDesktopShortcut);
  const setShortcutPosition = useAppStore((s) => s.setDesktopShortcutPosition);
  const shortcutPositions = useAppStore((s) => s.desktopShortcuts);
  const workspaceWindows = useAppStore((s) => s.workspaceWindows);
  const upsertWorkspaceWindow = useAppStore((s) => s.upsertWorkspaceWindow);
  const removeWorkspaceWindow = useAppStore((s) => s.removeWorkspaceWindow);

  useEffect(() => {
    if (!rootRef.current) return;
    registerWorkspaceRoot(rootRef.current);
  }, []);

  // Register a default so the logs shortcut renders even on first run.
  useEffect(() => {
    ensureShortcut(LOGS_SHORTCUT_ID, { ...LOGS_SHORTCUT_DEFAULT });
    upsertWorkspaceWindow({ id: 'logs', title: 'Logs', kind: 'local' });
    return () => {
      removeWorkspaceWindow('logs');
    };
  }, [ensureShortcut, removeWorkspaceWindow, upsertWorkspaceWindow]);

  useEffect(() => {
    const applyMeta = (meta: Array<{ id: string; title: string }>) => {
      for (const record of meta) {
        upsertWorkspaceWindow({ ...record, kind: 'workspace' });
      }
    };
    applyMeta(listWorkspaceWindows());
    const unsubscribe = registerWindowLifecycle((event) => {
      if (event.type === 'destroyed') {
        removeWorkspaceWindow(event.id);
        return;
      }
      const title = event.title ?? event.id;
      upsertWorkspaceWindow({ id: event.id, title, kind: 'workspace' });
    });
    return () => {
      // Ensure the lifecycle handler is removed; discard unsubscribe status.
      unsubscribe();
    };
  }, [removeWorkspaceWindow, upsertWorkspaceWindow]);

  const logsPosition = shortcutPositions[LOGS_SHORTCUT_ID] ?? LOGS_SHORTCUT_DEFAULT;

  const handleOpenLogs = useCallback(() => {
    openLogs();
  }, [openLogs]);

  const handleLogsPosition = useCallback(
    (position: DesktopShortcutPosition) => {
      setShortcutPosition(LOGS_SHORTCUT_ID, position);
    },
    [setShortcutPosition],
  );

  const iconVisual = useMemo(() => (
    showImg ? (
      <img src="/logs.png" alt="Logs" className="h-8 w-8" onError={() => setShowImg(false)} />
    ) : (
      <LogsIcon className="h-8 w-8" />
    )
  ), [showImg]);

  const closeWindow = useCallback((id: string) => {
    closeWorkspaceWindow(id);
  }, [closeWorkspaceWindow]);

  const menus = useMemo<DesktopMenu[]>(() => {
    const entries = Object.values(workspaceWindows);
    if (!entries.length) return [];
    return entries
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((meta) => {
        if (meta.id === 'logs') {
          return {
            id: meta.id,
            label: meta.title,
            actions: [
              { id: 'open', label: 'Open Logs', onSelect: openLogs, disabled: logsOpen },
              { id: 'hide', label: 'Hide Logs', onSelect: hideLogs, disabled: !logsOpen },
            ],
          } satisfies DesktopMenu;
        }
        return {
          id: meta.id,
          label: meta.title,
          actions: [
            { id: 'close', label: 'Close', onSelect: () => closeWindow(meta.id) },
          ],
        } satisfies DesktopMenu;
      });
  }, [closeWindow, hideLogs, logsOpen, openLogs, workspaceWindows]);

  return (
    <div className="relative flex min-h-screen w-full flex-col items-center justify-center">
      <DesktopMenuBar menus={menus} />
      <div
        id="workspace-root"
        ref={rootRef}
        className="relative h-full w-full"
        aria-live="polite"
      />
      <div ref={overlayRef} className="pointer-events-none absolute inset-0 z-30">
        <DesktopIcon
          id="logs-shortcut"
          label="Logs"
          position={logsPosition}
          containerRef={overlayRef}
          onOpen={handleOpenLogs}
          onPositionChange={handleLogsPosition}
          icon={iconVisual}
          active={logsOpen}
        />
      </div>
      <LogsPanel />
    </div>
  );
};

export default Desktop;
