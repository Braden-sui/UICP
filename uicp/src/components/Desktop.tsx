import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  applyEnvelope,
  closeWorkspaceWindow,
  listWorkspaceWindows,
  registerWindowLifecycle,
  registerWorkspaceRoot,
  replayWorkspace,
  setPinnedWindowPredicate,
} from '../lib/uicp/adapters/lifecycle';
import LogsPanel from './LogsPanel';
import DesktopIcon from './DesktopIcon';
import DesktopMenuBar, { type DesktopMenu } from './DesktopMenuBar';
import NotepadWindow from './NotepadWindow';
import MetricsPanel from './MetricsPanel';
import { LogsIcon, NotepadIcon, GaugeIcon, GearIcon, SlidersIcon } from '../icons';
import ComputeDemoWindow from './ComputeDemoWindow';
import ModuleRegistryWindow from './ModuleRegistryWindow';
import AgentTraceWindow from './AgentTraceWindow';
import { useAppSelector, type DesktopShortcutPosition } from '../state/app';
import AgentSettingsWindow from './AgentSettingsWindow';
import PreferencesWindow from './PreferencesWindow';
import DevtoolsAnalyticsListener from './DevtoolsAnalyticsListener';
import KeystoreHotkeysListener from './KeystoreHotkeysListener';
import { installWorkspaceArtifactCleanup } from '../lib/uicp/cleanup';
import { inv } from '../lib/bridge/tauri';

import DesktopClock from './DesktopClock';
import PolicyViewer from './PolicyViewer';
import NetworkInspector from './NetworkInspector';
import FirstRunPermissionsSheet from './FirstRunPermissionsSheet';
import FilesystemScopesWindow from './FilesystemScopesWindow';

const LOGS_SHORTCUT_ID = 'logs';
const LOGS_SHORTCUT_DEFAULT = { x: 32, y: 32 } as const;
const NOTEPAD_SHORTCUT_ID = 'notepad';
const NOTEPAD_SHORTCUT_DEFAULT = { x: 32, y: 128 } as const;
const METRICS_SHORTCUT_ID = 'metrics';
const METRICS_SHORTCUT_DEFAULT = { x: 32, y: 224 } as const;
const AGENT_SETTINGS_SHORTCUT_ID = 'agent-settings';
const AGENT_SETTINGS_SHORTCUT_DEFAULT = { x: 32, y: 320 } as const;
const PREFERENCES_SHORTCUT_ID = 'preferences';
const PREFERENCES_SHORTCUT_DEFAULT = { x: 32, y: 416 } as const;
const COMPUTE_DEMO_SHORTCUT_ID = 'compute-demo';
const COMPUTE_DEMO_SHORTCUT_DEFAULT = { x: 32, y: 512 } as const;
const AGENT_TRACE_SHORTCUT_ID = 'agent-trace';
const AGENT_TRACE_SHORTCUT_DEFAULT = { x: 32, y: 608 } as const;
const POLICY_VIEWER_SHORTCUT_ID = 'policy-viewer';
const POLICY_VIEWER_SHORTCUT_DEFAULT = { x: 200, y: 32 } as const;
const NETWORK_INSPECTOR_SHORTCUT_ID = 'network-inspector';
const NETWORK_INSPECTOR_SHORTCUT_DEFAULT = { x: 200, y: 128 } as const;
const FILESYSTEM_SCOPES_SHORTCUT_ID = 'filesystem-scopes';
const FILESYSTEM_SCOPES_SHORTCUT_DEFAULT = { x: 200, y: 224 } as const;

// Desktop hosts the empty canvas the agent mutates via the adapter and surfaces shortcuts for manual control.
export const Desktop = () => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [showImg, setShowImg] = useState(true);
  const logsOpen = useAppSelector((s) => s.logsOpen);
  const setLogsOpen = useAppSelector((s) => s.setLogsOpen);
  const metricsOpen = useAppSelector((s) => s.metricsOpen);
  const setMetricsOpen = useAppSelector((s) => s.setMetricsOpen);
  const notepadOpen = useAppSelector((s) => s.notepadOpen);
  const setNotepadOpen = useAppSelector((s) => s.setNotepadOpen);
  const agentSettingsOpen = useAppSelector((s) => s.agentSettingsOpen);
  const setAgentSettingsOpen = useAppSelector((s) => s.setAgentSettingsOpen);
  const preferencesOpen = useAppSelector((s) => s.preferencesOpen);
  const setPreferencesOpen = useAppSelector((s) => s.setPreferencesOpen);
  const computeDemoOpen = useAppSelector((s) => s.computeDemoOpen);
  const setComputeDemoOpen = useAppSelector((s) => s.setComputeDemoOpen);
  const agentTraceOpen = useAppSelector((s) => s.agentTraceOpen);
  const setAgentTraceOpen = useAppSelector((s) => s.setAgentTraceOpen);
  const policyViewerOpen = useAppSelector((s) => s.policyViewerOpen);
  const setPolicyViewerOpen = useAppSelector((s) => s.setPolicyViewerOpen);
  const networkInspectorOpen = useAppSelector((s) => s.networkInspectorOpen);
  const setNetworkInspectorOpen = useAppSelector((s) => s.setNetworkInspectorOpen);
  const filesystemScopesOpen = useAppSelector((s) => s.filesystemScopesOpen);
  const setFilesystemScopesOpen = useAppSelector((s) => s.setFilesystemScopesOpen);
  const devMode = useAppSelector((s) => s.devMode);
  const streaming = useAppSelector((s) => s.streaming);
  const openLogs = useCallback(() => setLogsOpen(true), [setLogsOpen]);
  const hideLogs = useCallback(() => setLogsOpen(false), [setLogsOpen]);
  const openMetrics = useCallback(() => setMetricsOpen(true), [setMetricsOpen]);
  const hideMetrics = useCallback(() => setMetricsOpen(false), [setMetricsOpen]);
  const openNotepad = useCallback(() => setNotepadOpen(true), [setNotepadOpen]);
  const hideNotepad = useCallback(() => setNotepadOpen(false), [setNotepadOpen]);
  const openPreferences = useCallback(() => setPreferencesOpen(true), [setPreferencesOpen]);
  const hidePreferences = useCallback(() => setPreferencesOpen(false), [setPreferencesOpen]);
  const openComputeDemo = useCallback(() => setComputeDemoOpen(true), [setComputeDemoOpen]);
  const hideComputeDemo = useCallback(() => setComputeDemoOpen(false), [setComputeDemoOpen]);
  const openAgentTrace = useCallback(() => setAgentTraceOpen(true), [setAgentTraceOpen]);
  const hideAgentTrace = useCallback(() => setAgentTraceOpen(false), [setAgentTraceOpen]);
  const ensureShortcut = useAppSelector((s) => s.ensureDesktopShortcut);
  const setShortcutPosition = useAppSelector((s) => s.setDesktopShortcutPosition);
  const shortcutPositions = useAppSelector((s) => s.desktopShortcuts);
  const workspaceWindows = useAppSelector((s) => s.workspaceWindows);
  const upsertWorkspaceWindow = useAppSelector((s) => s.upsertWorkspaceWindow);
  const removeWorkspaceWindow = useAppSelector((s) => s.removeWorkspaceWindow);
  const pinnedWindows = useAppSelector((s) => s.pinnedWindows);
  const pinWindow = useAppSelector((s) => s.pinWindow);
  const unpinWindow = useAppSelector((s) => s.unpinWindow);
  const removeDesktopShortcut = useAppSelector((s) => s.removeDesktopShortcut);
  
  useEffect(() => {
    if (!rootRef.current) return;
    registerWorkspaceRoot(rootRef.current);
    const teardownArtifacts = installWorkspaceArtifactCleanup(rootRef.current);

    // Replay persisted commands to restore workspace state
    void replayWorkspace().then(({ applied, errors }) => {
      if (applied > 0) {
        console.log(`Replayed ${applied} command(s) from workspace`);
      }
      if (errors.length > 0) {
        console.warn('Replay errors:', errors);
      }
    });
    return () => {
      try {
        teardownArtifacts?.();
      } catch {
        // ignore
      }
    };
  }, []);

  // Auto-lock on tab visibility loss; if streaming, defer until stream completes
  useEffect(() => {
    let defer = false;
    const onVis = async () => {
      try {
        if (document.visibilityState === 'hidden') {
          if (streaming) {
            defer = true;
          } else {
            // Fire-and-forget; backend enforces state
            await inv('keystore_lock');
          }
        }
      } catch (err) {
        // ignore UI-level errors; backend is source of truth
      }
    };
    const onStreamClosed = async () => {
      if (!defer) return;
      defer = false;
      try {
        await inv('keystore_lock');
      } catch {
        // ignore
      }
    };
    document.addEventListener('visibilitychange', onVis);
    const uiHandler = ((e: Event) => {
      const detail = (e as CustomEvent).detail as Record<string, unknown> | undefined;
      if (!detail || typeof detail.event !== 'string') return;
      if (detail.event === 'stream_closed') {
        void onStreamClosed();
      }
    }) as EventListener;
    window.addEventListener('ui-debug-log', uiHandler);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('ui-debug-log', uiHandler);
    };
  }, [streaming]);

  // Register defaults so the built-in shortcuts render even on first run.
  useEffect(() => {
    ensureShortcut(LOGS_SHORTCUT_ID, { ...LOGS_SHORTCUT_DEFAULT });
    ensureShortcut(NOTEPAD_SHORTCUT_ID, { ...NOTEPAD_SHORTCUT_DEFAULT });
    ensureShortcut(METRICS_SHORTCUT_ID, { ...METRICS_SHORTCUT_DEFAULT });
    ensureShortcut(AGENT_SETTINGS_SHORTCUT_ID, { ...AGENT_SETTINGS_SHORTCUT_DEFAULT });
    ensureShortcut(PREFERENCES_SHORTCUT_ID, { ...PREFERENCES_SHORTCUT_DEFAULT });
    ensureShortcut(COMPUTE_DEMO_SHORTCUT_ID, { ...COMPUTE_DEMO_SHORTCUT_DEFAULT });
    ensureShortcut(POLICY_VIEWER_SHORTCUT_ID, { ...POLICY_VIEWER_SHORTCUT_DEFAULT });
    ensureShortcut(NETWORK_INSPECTOR_SHORTCUT_ID, { ...NETWORK_INSPECTOR_SHORTCUT_DEFAULT });
    ensureShortcut(FILESYSTEM_SCOPES_SHORTCUT_ID, { ...FILESYSTEM_SCOPES_SHORTCUT_DEFAULT });
    const shouldShowAgentTrace = devMode || import.meta.env.DEV;
    if (shouldShowAgentTrace) {
      ensureShortcut(AGENT_TRACE_SHORTCUT_ID, { ...AGENT_TRACE_SHORTCUT_DEFAULT });
    }
    upsertWorkspaceWindow({ id: 'logs', title: 'Logs', kind: 'local' });
    upsertWorkspaceWindow({ id: 'notepad', title: 'Notepad', kind: 'local' });
    upsertWorkspaceWindow({ id: 'metrics', title: 'Metrics', kind: 'local' });
    upsertWorkspaceWindow({ id: 'agent-settings', title: 'Agent Settings', kind: 'local' });
    upsertWorkspaceWindow({ id: 'preferences', title: 'Preferences', kind: 'local' });
    upsertWorkspaceWindow({ id: 'compute-demo', title: 'Compute Demo', kind: 'local' });
    upsertWorkspaceWindow({ id: 'policy-viewer', title: 'Policy Viewer', kind: 'local' });
    upsertWorkspaceWindow({ id: 'network-inspector', title: 'Network Inspector', kind: 'local' });
    upsertWorkspaceWindow({ id: 'filesystem-scopes', title: 'Filesystem Scopes', kind: 'local' });
    if (shouldShowAgentTrace) {
      upsertWorkspaceWindow({ id: 'agent-trace', title: 'Agent Trace', kind: 'local' });
    }
    // Cleanup: Use captured value to ensure we clean up what we created
    return () => {
      removeWorkspaceWindow('logs');
      removeWorkspaceWindow('notepad');
      removeWorkspaceWindow('metrics');
      removeWorkspaceWindow('agent-settings');
      removeWorkspaceWindow('preferences');
      removeWorkspaceWindow('compute-demo');
      removeWorkspaceWindow('policy-viewer');
      removeWorkspaceWindow('network-inspector');
      removeWorkspaceWindow('filesystem-scopes');
      if (shouldShowAgentTrace) {
        removeWorkspaceWindow('agent-trace');
      }
    };
  }, [devMode, ensureShortcut, removeWorkspaceWindow, upsertWorkspaceWindow]);

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
  const preferencesPosition = shortcutPositions[PREFERENCES_SHORTCUT_ID] ?? PREFERENCES_SHORTCUT_DEFAULT;
  const computeDemoPosition = shortcutPositions[COMPUTE_DEMO_SHORTCUT_ID] ?? COMPUTE_DEMO_SHORTCUT_DEFAULT;
  const agentTracePosition = shortcutPositions[AGENT_TRACE_SHORTCUT_ID] ?? AGENT_TRACE_SHORTCUT_DEFAULT;
  const policyViewerPosition = shortcutPositions[POLICY_VIEWER_SHORTCUT_ID] ?? POLICY_VIEWER_SHORTCUT_DEFAULT;
  const networkInspectorPosition = shortcutPositions[NETWORK_INSPECTOR_SHORTCUT_ID] ?? NETWORK_INSPECTOR_SHORTCUT_DEFAULT;
  const filesystemScopesPosition = shortcutPositions[FILESYSTEM_SCOPES_SHORTCUT_ID] ?? FILESYSTEM_SCOPES_SHORTCUT_DEFAULT;

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

  

  const handleAgentTracePosition = useCallback(
    (position: DesktopShortcutPosition) => {
      setShortcutPosition(AGENT_TRACE_SHORTCUT_ID, position);
    },
    [setShortcutPosition],
  );

  const handlePreferencesPosition = useCallback(
    (position: DesktopShortcutPosition) => {
      setShortcutPosition(PREFERENCES_SHORTCUT_ID, position);
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
    // Ask adapter to destroy the window and purge persisted commands.
    closeWorkspaceWindow(id);
    // UI fallback: optimistically remove from local store in case lifecycle
    // events are delayed or suppressed so the menu updates immediately.
    removeWorkspaceWindow(id);
  }, [removeWorkspaceWindow]);

  // Open a pinned window: ensure present via replay, then focus it
  const openPinned = useCallback(async (windowId: string) => {
    try {
      const isOpen = Boolean(workspaceWindows[windowId]);
      if (!isOpen) {
        await replayWorkspace();
      }
      await applyEnvelope({ op: 'window.focus', params: { id: windowId } });
    } catch (err) {
      console.error('failed to open pinned window', windowId, err);
    }
  }, [workspaceWindows]);

  const confirmDeletePinnedApp = useCallback(async (windowId: string) => {
    try {
      const title = pinnedWindows[windowId]?.title || windowId;
      const ok = window.confirm(`Delete pinned app "${title}"? This will permanently remove the app and ALL stored data, including its build.`);
      if (!ok) return;
      unpinWindow(windowId);
      removeDesktopShortcut(`pinned:${windowId}`);
      try {
        await closeWorkspaceWindow(windowId);
      } catch (closeError) {
        console.warn('closeWorkspaceWindow failed during pinned app cleanup', { windowId, error: closeError });
      }
      removeWorkspaceWindow(windowId);
      const result = await inv<void>('delete_window_commands', { windowId });
      if (!result.ok) {
        console.error('delete_window_commands failed', result.error);
      }
    } catch (err) {
      console.error('Failed to delete pinned app', windowId, err);
    }
  }, [pinnedWindows, removeDesktopShortcut, removeWorkspaceWindow, unpinWindow]);

  // Keep adapter aware of pinned windows so close() preserves their persisted commands
  useEffect(() => {
    setPinnedWindowPredicate((id) => Boolean(pinnedWindows[id]));
    return () => {
      setPinnedWindowPredicate(null);
    };
  }, [pinnedWindows]);

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
        if (meta.id === PREFERENCES_SHORTCUT_ID) {
          return {
            id: meta.id,
            label: meta.title,
            actions: [
              { id: 'open', label: 'Open Preferences', onSelect: openPreferences, disabled: preferencesOpen },
              { id: 'hide', label: 'Hide Preferences', onSelect: hidePreferences, disabled: !preferencesOpen },
            ],
          } satisfies DesktopMenu;
        }
        if (meta.id === AGENT_TRACE_SHORTCUT_ID) {
          return {
            id: meta.id,
            label: meta.title,
            actions: [
              { id: 'open', label: 'Open Agent Trace', onSelect: openAgentTrace, disabled: agentTraceOpen },
              { id: 'hide', label: 'Hide Agent Trace', onSelect: hideAgentTrace, disabled: !agentTraceOpen },
            ],
          } satisfies DesktopMenu;
        }
        if (meta.id === 'policy-viewer') {
          return {
            id: meta.id,
            label: meta.title,
            actions: [
              { id: 'open', label: 'Open Policy Viewer', onSelect: () => setPolicyViewerOpen(true), disabled: policyViewerOpen },
              { id: 'hide', label: 'Hide Policy Viewer', onSelect: () => setPolicyViewerOpen(false), disabled: !policyViewerOpen },
            ],
          } satisfies DesktopMenu;
        }
        if (meta.id === 'network-inspector') {
          return {
            id: meta.id,
            label: meta.title,
            actions: [
              { id: 'open', label: 'Open Network Inspector', onSelect: () => setNetworkInspectorOpen(true), disabled: networkInspectorOpen },
              { id: 'hide', label: 'Hide Network Inspector', onSelect: () => setNetworkInspectorOpen(false), disabled: !networkInspectorOpen },
            ],
          } satisfies DesktopMenu;
        }
        if (meta.id === 'filesystem-scopes') {
          return {
            id: meta.id,
            label: meta.title,
            actions: [
              { id: 'open', label: 'Open Filesystem Scopes', onSelect: () => setFilesystemScopesOpen(true), disabled: filesystemScopesOpen },
              { id: 'hide', label: 'Hide Filesystem Scopes', onSelect: () => setFilesystemScopesOpen(false), disabled: !filesystemScopesOpen },
            ],
          } satisfies DesktopMenu;
        }
        if (meta.id === 'compute-demo') {
          return {
            id: meta.id,
            label: meta.title,
            actions: [
              { id: 'open', label: 'Open Compute Demo', onSelect: openComputeDemo, disabled: !!computeDemoOpen },
              { id: 'hide', label: 'Hide Compute Demo', onSelect: hideComputeDemo, disabled: !computeDemoOpen },
            ],
          } satisfies DesktopMenu;
        }
        const isPinned = Boolean(pinnedWindows[meta.id]);
        const actions: DesktopMenu['actions'] = [
          { id: 'focus', label: 'Focus', onSelect: () => void applyEnvelope({ op: 'window.focus', params: { id: meta.id } }) },
          isPinned
            ? { id: 'unpin', label: 'Unpin from Desktop', onSelect: () => unpinWindow(meta.id) }
            : { id: 'pin', label: 'Pin to Desktop', onSelect: () => {
                pinWindow(meta.id, meta.title);
                const shortcutId = `pinned:${meta.id}`;
                if (!shortcutPositions[shortcutId]) {
                  const count = Object.keys(pinnedWindows).length;
                  const fallback = { x: 128, y: 96 * count + 64 } as DesktopShortcutPosition;
                  ensureShortcut(shortcutId, fallback);
                }
              } },
          { id: 'close', label: 'Close', onSelect: () => closeWindow(meta.id) },
        ];
        return { id: meta.id, label: meta.title, actions } satisfies DesktopMenu;
      });
  }, [
    agentSettingsOpen,
    agentTraceOpen,
    closeWindow,
    computeDemoOpen,
    filesystemScopesOpen,
    hideComputeDemo,
    hideAgentTrace,
    hideLogs,
    hideMetrics,
    hideNotepad,
    hidePreferences,
    setFilesystemScopesOpen,
    logsOpen,
    metricsOpen,
    notepadOpen,
    openComputeDemo,
    openAgentTrace,
    openLogs,
    openMetrics,
    openNotepad,
    openPreferences,
    preferencesOpen,
    policyViewerOpen,
    setPolicyViewerOpen,
    networkInspectorOpen,
    setNetworkInspectorOpen,
    setAgentSettingsOpen,
    workspaceWindows,
    pinnedWindows,
    pinWindow,
    unpinWindow,
    shortcutPositions,
    ensureShortcut,
  ]);

  return (
    <div className="relative flex min-h-screen w-full flex-col items-stretch">
      <DevtoolsAnalyticsListener />
      <DesktopClock />
      <KeystoreHotkeysListener />
      <DesktopMenuBar menus={menus} />
      {/* WHY: Provide a full-viewport canvas so agent windows and shortcuts share a single coordinate space.
          INVARIANT: workspace-root and the overlay must share this positioned ancestor so drag math stays correct. */}
      <div className="relative flex-1 w-full">
        <div
          id="workspace-root"
          ref={rootRef}
          className="absolute inset-0 z-40 pointer-events-none"
          aria-live="polite"
        />
        <div
          ref={overlayRef}
          className="pointer-events-none absolute inset-0 z-20"
          data-shortcut-layer="true"
        >
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
          {(devMode || import.meta.env.DEV) && (
            <DesktopIcon
              id="agent-trace-shortcut"
              label="Agent Trace"
              position={agentTracePosition}
              containerRef={overlayRef}
              onOpen={openAgentTrace}
              onPositionChange={handleAgentTracePosition}
              icon={<GaugeIcon className="h-8 w-8" />}
              active={agentTraceOpen}
            />
          )}
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
          <DesktopIcon
            id="policy-viewer-shortcut"
            label="Policy Viewer"
            position={policyViewerPosition}
            containerRef={overlayRef}
            onOpen={() => setPolicyViewerOpen(true)}
            onPositionChange={(pos) => setShortcutPosition(POLICY_VIEWER_SHORTCUT_ID, pos)}
            icon={<SlidersIcon className="h-8 w-8" />}
            active={policyViewerOpen}
          />
          <DesktopIcon
            id="network-inspector-shortcut"
            label="Network Inspector"
            position={networkInspectorPosition}
            containerRef={overlayRef}
            onOpen={() => setNetworkInspectorOpen(true)}
            onPositionChange={(pos) => setShortcutPosition(NETWORK_INSPECTOR_SHORTCUT_ID, pos)}
            icon={<GaugeIcon className="h-8 w-8" />}
            active={networkInspectorOpen}
          />
          <DesktopIcon
            id="filesystem-scopes-shortcut"
            label="Filesystem Scopes"
            position={filesystemScopesPosition}
            containerRef={overlayRef}
            onOpen={() => setFilesystemScopesOpen(true)}
            onPositionChange={(pos) => setShortcutPosition(FILESYSTEM_SCOPES_SHORTCUT_ID, pos)}
            icon={<SlidersIcon className="h-8 w-8" />}
            active={filesystemScopesOpen}
          />
          <DesktopIcon
            id="preferences-shortcut"
            label="Preferences"
            position={preferencesPosition}
            containerRef={overlayRef}
            onOpen={openPreferences}
            onPositionChange={handlePreferencesPosition}
            icon={<SlidersIcon className="h-8 w-8" />}
            active={preferencesOpen}
          />
          <DesktopIcon
            id="compute-demo-shortcut"
            label="Compute Demo"
            position={computeDemoPosition}
            containerRef={overlayRef}
            onOpen={openComputeDemo}
            onPositionChange={(pos) => setShortcutPosition(COMPUTE_DEMO_SHORTCUT_ID, pos)}
            icon={<GaugeIcon className="h-8 w-8" />}
            active={!!computeDemoOpen}
          />
          {/* Dynamically pinned workspace window shortcuts */}
          {Object.entries(pinnedWindows).map(([winId, meta]) => {
            const shortcutId = `pinned:${winId}`;
            const pos = shortcutPositions[shortcutId] ?? { x: 128, y: 64 };
            const isActive = Boolean(workspaceWindows[winId]);
            return (
              <DesktopIcon
                key={shortcutId}
                id={shortcutId}
                label={meta.title}
                position={pos}
                containerRef={overlayRef}
                onOpen={() => void openPinned(winId)}
                onPositionChange={(p) => setShortcutPosition(shortcutId, p)}
                icon={<GaugeIcon className="h-8 w-8" />}
                active={isActive}
                onContextMenu={() => void confirmDeletePinnedApp(winId)}
              />
            );
          })}
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
      </div>
      <NotepadWindow />
      <MetricsPanel />
      <LogsPanel />
      <AgentSettingsWindow />
      <PreferencesWindow />
      <ComputeDemoWindow />
      <ModuleRegistryWindow />
      <AgentTraceWindow />
      <PolicyViewer />
      <NetworkInspector />
      <FirstRunPermissionsSheet />
      <FilesystemScopesWindow />
    </div>
  );
};

export default Desktop;
