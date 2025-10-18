import { useEffect } from 'react';
import { emit } from '@tauri-apps/api/event';
import { useAppStore, type DevtoolsAnalyticsContext } from '../state/app';

const getPlatformTag = () => {
  if (typeof navigator === 'undefined') return 'unknown';
  const platform = navigator.platform?.toLowerCase() ?? '';
  if (platform.includes('mac')) return 'mac';
  if (platform.includes('win')) return 'windows';
  if (platform.includes('linux')) return 'linux';
  return platform || 'unknown';
};

type ShortcutMatch = { combo: string; platform: string } | null;

const detectDevtoolsShortcut = (event: KeyboardEvent): ShortcutMatch => {
  const key = event.key?.toLowerCase();
  if (key !== 'i') return null;

  const platform = getPlatformTag();
  if (platform === 'mac') {
    if (event.metaKey && event.altKey) {
      return { combo: 'Cmd+Opt+I', platform };
    }
    return null;
  }

  if (event.ctrlKey && event.shiftKey) {
    return { combo: 'Ctrl+Shift+I', platform };
  }

  return null;
};

// DevtoolsAnalyticsListener observes ctrl+shift+I / cmd+opt+I to record richer analytics and emit a debug log.
const DevtoolsAnalyticsListener = () => {
  useEffect(() => {
    const handler = async (event: KeyboardEvent) => {
      const result = detectDevtoolsShortcut(event);
      if (!result) return;

      const store = useAppStore.getState();
      const direction = store.devtoolsAssumedOpen ? 'close' : 'open';
      const context: DevtoolsAnalyticsContext = {
        agentPhase: store.agentStatus.phase,
        traceId: store.agentStatus.traceId,
        streaming: store.streaming,
        logsOpen: store.logsOpen,
        metricsOpen: store.metricsOpen,
        notepadOpen: store.notepadOpen,
        agentSettingsOpen: store.agentSettingsOpen,
        computeDemoOpen: store.computeDemoOpen,
        moduleRegistryOpen: store.moduleRegistryOpen,
        workspaceWindows: Object.keys(store.workspaceWindows).length,
        devMode: store.devMode,
        fullControl: store.fullControl,
        fullControlLocked: store.fullControlLocked,
        platform: result.platform,
      };

      store.recordDevtoolsAnalytics({
        trigger: 'keyboard',
        combo: result.combo,
        direction,
        context,
      });

      try {
        await emit('debug-log', {
          ts: Date.now(),
          event: 'devtools_shortcut',
          direction,
          combo: result.combo,
          platform: result.platform,
          agentPhase: context.agentPhase,
          streaming: context.streaming,
          traceId: context.traceId,
          workspaceWindows: context.workspaceWindows,
          devMode: context.devMode,
          fullControl: context.fullControl,
          fullControlLocked: context.fullControlLocked,
          moduleRegistryOpen: context.moduleRegistryOpen,
        });
      } catch (error) {
        console.error('Failed to emit devtools_shortcut debug event', error);
      }
    };

    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  return null;
};

export default DevtoolsAnalyticsListener;
