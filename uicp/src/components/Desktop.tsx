import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { registerWorkspaceRoot, registerWindowLifecycle, listWorkspaceWindows, closeWorkspaceWindow, replayWorkspace } from '../lib/uicp/adapter';
import LogsPanel from './LogsPanel';
import DesktopIcon from './DesktopIcon';
import DesktopMenuBar, { type DesktopMenu } from './DesktopMenuBar';
import NotepadWindow from './NotepadWindow';
import MetricsPanel from './MetricsPanel';
import { LogsIcon, NotepadIcon, GaugeIcon, GearIcon } from '../icons';
import { useAppStore, type DesktopShortcutPosition } from '../state/app';
import AgentSettingsWindow from './AgentSettingsWindow';

const LOGS_SHORTCUT_ID = 'logs';
const LOGS_SHORTCUT_DEFAULT = { x: 32, y: 32 } as const;
const NOTEPAD_SHORTCUT_ID = 'notepad';
const NOTEPAD_SHORTCUT_DEFAULT = { x: 32, y: 128 } as const;
const METRICS_SHORTCUT_ID = 'metrics';
const METRICS_SHORTCUT_DEFAULT = { x: 32, y: 224 } as const;
const AGENT_SETTINGS_SHORTCUT_ID = 'agent-settings';
const AGENT_SETTINGS_SHORTCUT_DEFAULT = { x: 32, y: 320 } as const;

// Desktop hosts the empty canvas the agent mutates via the adapter and surfaces shortcuts for manual control.
export const Desktop = () => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [showImg, setShowImg] = useState(true);
  const logsOpen = useAppStore((s) => s.logsOpen);
  const setLogsOpen = useAppStore((s) => s.setLogsOpen);
  const metricsOpen = useAppStore((s) => s.metricsOpen);
  const setMetricsOpen = useAppStore((s) => s.setMetricsOpen);
  const notepadOpen = useAppStore((s) => s.notepadOpen);
  const setNotepadOpen = useAppStore((s) => s.setNotepadOpen);
  const agentSettingsOpen = useAppStore((s) => s.agentSettingsOpen);
  const setAgentSettingsOpen = useAppStore((s) => s.setAgentSettingsOpen);
  const openLogs = useCallback(() => setLogsOpen(true), [setLogsOpen]);
  const hideLogs = useCallback(() => setLogsOpen(false), [setLogsOpen]);
  const openMetrics = useCallback(() => setMetricsOpen(true), [setMetricsOpen]);
  const hideMetrics = useCallback(() => setMetricsOpen(false), [setMetricsOpen]);
  const openNotepad = useCallback(() => setNotepadOpen(true), [setNotepadOpen]);
  const hideNotepad = useCallback(() => setNotepadOpen(false), [setNotepadOpen]);
  const ensureShortcut = useAppStore((s) => s.ensureDesktopShortcut);
  const setShortcutPosition = useAppStore((s) => s.setDesktopShortcutPosition);
  const shortcutPositions = useAppStore((s) => s.desktopShortcuts);
  const workspaceWindows = useAppStore((s) => s.workspaceWindows);
  const upsertWorkspaceWindow = useAppStore((s) => s.upsertWorkspaceWindow);
  const removeWorkspaceWindow = useAppStore((s) => s.removeWorkspaceWindow);

  useEffect(() => {
    if (!rootRef.current) return;
    registerWorkspaceRoot(rootRef.current);

    // Replay persisted commands to restore workspace state
    void replayWorkspace().then(({ applied, errors }) => {
      if (applied > 0) {
        console.log(`Replayed ${applied} command(s) from workspace`);
      }
      if (errors.length > 0) {
        console.warn('Replay errors:', errors);
      }
    });
  }, []);

  // Register defaults so the built-in shortcuts render even on first run.
  useEffect(() => {
    ensureShortcut(LOGS_SHORTCUT_ID, { ...LOGS_SHORTCUT_DEFAULT });
    ensureShortcut(NOTEPAD_SHORTCUT_ID, { ...NOTEPAD_SHORTCUT_DEFAULT });
    ensureShortcut(METRICS_SHORTCUT_ID, { ...METRICS_SHORTCUT_DEFAULT });
    ensureShortcut(AGENT_SETTINGS_SHORTCUT_ID, { ...AGENT_SETTINGS_SHORTCUT_DEFAULT });
    upsertWorkspaceWindow({ id: 'logs', title: 'Logs', kind: 'local' });
    upsertWorkspaceWindow({ id: 'notepad', title: 'Notepad', kind: 'local' });
    upsertWorkspaceWindow({ id: 'metrics', title: 'Metrics', kind: 'local' });
    upsertWorkspaceWindow({ id: 'agent-settings', title: 'Agent Settings', kind: 'local' });
    return () => {
      removeWorkspaceWindow('logs');
      removeWorkspaceWindow('notepad');
      removeWorkspaceWindow('metrics');
      removeWorkspaceWindow('agent-settings');
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
  const notepadPosition = shortcutPositions[NOTEPAD_SHORTCUT_ID] ?? NOTEPAD_SHORTCUT_DEFAULT;
  const metricsPosition = shortcutPositions[METRICS_SHORTCUT_ID] ?? METRICS_SHORTCUT_DEFAULT;
  const agentSettingsPosition = shortcutPositions[AGENT_SETTINGS_SHORTCUT_ID] ?? AGENT_SETTINGS_SHORTCUT_DEFAULT;

  const handleOpenLogs = useCallback(() => {
    openLogs();
  }, [openLogs]);

  const handleOpenNotepad = useCallback(() => {
    openNotepad();
  }, [openNotepad]);

  const handleLogsPosition = useCallback(
    (position: DesktopShortcutPosition) => {
      setShortcutPosition(LOGS_SHORTCUT_ID, position);
    },
    [setShortcutPosition],
  );

  const handleNotepadPosition = useCallback(
    (position: DesktopShortcutPosition) => {
      setShortcutPosition(NOTEPAD_SHORTCUT_ID, position);
    },
    [setShortcutPosition],
  );

  const handleMetricsPosition = useCallback(
    (position: DesktopShortcutPosition) => {
      setShortcutPosition(METRICS_SHORTCUT_ID, position);
    },
    [setShortcutPosition],
  );

  const handleAgentSettingsPosition = useCallback(
    (position: DesktopShortcutPosition) => {
      setShortcutPosition(AGENT_SETTINGS_SHORTCUT_ID, position);
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

  const notepadIconVisual = useMemo(() => <NotepadIcon className="h-8 w-8" />, []);

  const closeWindow = useCallback((id: string) => {
    closeWorkspaceWindow(id);
  }, []);

  const menus = useMemo<DesktopMenu[]>(() => {
    const entries = Object.values(workspaceWindows)
      // Hide ephemeral or system windows from the menu bar
      .filter((meta) => {
        if (meta.kind !== 'workspace') return true;
        const title = meta.title.toLowerCase();
        if (title === 'action failed') return false;
        if (title === 'browser') return false;
        return true;
      });
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
        if (meta.id === 'metrics') {
          return {
            id: meta.id,
            label: meta.title,
            actions: [
              { id: 'open', label: 'Open Metrics', onSelect: openMetrics, disabled: metricsOpen },
              { id: 'hide', label: 'Hide Metrics', onSelect: hideMetrics, disabled: !metricsOpen },
            ],
          } satisfies DesktopMenu;
        }
        if (meta.id === NOTEPAD_SHORTCUT_ID) {
          return {
            id: meta.id,
            label: meta.title,
            actions: [
              { id: 'open', label: 'Open Notepad', onSelect: openNotepad, disabled: notepadOpen },
              { id: 'hide', label: 'Hide Notepad', onSelect: hideNotepad, disabled: !notepadOpen },
            ],
          } satisfies DesktopMenu;
        }
        if (meta.id === AGENT_SETTINGS_SHORTCUT_ID) {
          return {
            id: meta.id,
            label: meta.title,
            actions: [
              { id: 'open', label: 'Open Agent Settings', onSelect: () => setAgentSettingsOpen(true), disabled: agentSettingsOpen },
              { id: 'hide', label: 'Hide Agent Settings', onSelect: () => setAgentSettingsOpen(false), disabled: !agentSettingsOpen },
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
  }, [closeWindow, hideLogs, hideMetrics, hideNotepad, logsOpen, metricsOpen, notepadOpen, openLogs, openMetrics, openNotepad, workspaceWindows]);

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
        <DesktopIcon
          id="metrics-shortcut"
          label="Metrics"
          position={metricsPosition}
          containerRef={overlayRef}
          onOpen={openMetrics}
          onPositionChange={handleMetricsPosition}
          icon={<GaugeIcon className="h-8 w-8" />}
          active={metricsOpen}
        />
        <DesktopIcon
          id="agent-settings-shortcut"
          label="Agent Settings"
          position={agentSettingsPosition}
          containerRef={overlayRef}
          onOpen={() => setAgentSettingsOpen(true)}
          onPositionChange={handleAgentSettingsPosition}
          icon={<GearIcon className="h-8 w-8" />}
          active={agentSettingsOpen}
        />
        {/* Notepad shortcut surfaces the manual scratchpad utility. */}
        <DesktopIcon
          id="notepad-shortcut"
          label="Notepad"
          position={notepadPosition}
          containerRef={overlayRef}
          onOpen={handleOpenNotepad}
          onPositionChange={handleNotepadPosition}
          icon={notepadIconVisual}
          active={notepadOpen}
        />
      </div>
      <NotepadWindow />
      <MetricsPanel />
      <LogsPanel />
      <AgentSettingsWindow />
    </div>
  );
};

export default Desktop;
