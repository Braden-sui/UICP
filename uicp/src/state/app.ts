import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// AppState keeps cross-cutting UI control flags so DockChat, modal flows, and transport logic stay in sync.
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';
export type ToastVariant = 'info' | 'success' | 'error';

export type Toast = {
  id: string;
  message: string;
  variant: ToastVariant;
};

export type DesktopShortcutPosition = {
  x: number;
  y: number;
};

export type WorkspaceWindowKind = 'local' | 'workspace';

export type WorkspaceWindowMeta = {
  id: string;
  title: string;
  kind: WorkspaceWindowKind;
};

export type AgentMode = 'live' | 'mock';

const resolveDefaultAgentMode = (): AgentMode => {
  const env = import.meta.env;
  // Keep unit tests deterministic by forcing mock mode during vitest runs.
  if (env?.MODE === 'test') return 'mock';
  const flag = env?.VITE_MOCK_MODE;
  if (typeof flag === 'string') {
    const normalized = flag.toLowerCase();
    if (normalized === 'true' || normalized === '1') return 'mock';
    if (normalized === 'false' || normalized === '0') return 'live';
  }
  return 'live';
};

export type AppState = {
  connectionStatus: ConnectionStatus;
  devMode: boolean;
  fullControl: boolean;
  fullControlLocked: boolean;
  chatOpen: boolean;
  streaming: boolean;
  agentMode: AgentMode;
  // When true, aggregator will not auto-apply or preview parsed batches.
  // Used to prevent duplicate application while orchestrator-driven flows run.
  suppressAutoApply: boolean;
  grantModalOpen: boolean;
  // Controls visibility of the LogsPanel.
  logsOpen: boolean;
  // Tracks user-placement of desktop shortcuts so the layout feels persistent.
  desktopShortcuts: Record<string, DesktopShortcutPosition>;
  // Mirrors workspace windows produced via adapter so the desktop menu stays in sync.
  workspaceWindows: Record<string, WorkspaceWindowMeta>;
  toasts: Toast[];
  setConnectionStatus: (status: ConnectionStatus) => void;
  setDevMode: (devmode: boolean) => void;
  setFullControl: (value: boolean) => void;
  lockFullControl: () => void;
  unlockFullControl: () => void;
  setChatOpen: (value: boolean) => void;
  setStreaming: (value: boolean) => void;
  setSuppressAutoApply: (value: boolean) => void;
  setAgentMode: (mode: AgentMode) => void;
  openGrantModal: () => void;
  closeGrantModal: () => void;
  setLogsOpen: (value: boolean) => void;
  ensureDesktopShortcut: (id: string, fallback: DesktopShortcutPosition) => void;
  setDesktopShortcutPosition: (id: string, position: DesktopShortcutPosition) => void;
  upsertWorkspaceWindow: (meta: WorkspaceWindowMeta) => void;
  removeWorkspaceWindow: (id: string) => void;
  pushToast: (toast: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;
};

const getEnvFlag = (value: string | boolean | undefined, fallback: boolean) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value !== 'false';
  return fallback;
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      connectionStatus: 'disconnected',
      devMode: getEnvFlag(import.meta.env.VITE_DEV_MODE as unknown as string, true),
      fullControl: false,
      fullControlLocked: false,
      chatOpen: false,
      streaming: false,
      agentMode: resolveDefaultAgentMode(),
      suppressAutoApply: false,
      grantModalOpen: false,
      logsOpen: false,
      desktopShortcuts: {},
      workspaceWindows: {},
      toasts: [],
      setConnectionStatus: (status) => set({ connectionStatus: status }),
      setDevMode: (devMode) => set({ devMode }),
      setFullControl: (value) => set({ fullControl: value, fullControlLocked: false }),
      lockFullControl: () => set({ fullControl: false, fullControlLocked: true }),
      unlockFullControl: () => set({ fullControlLocked: false }),
      setChatOpen: (value) => set({ chatOpen: value }),
      setStreaming: (value) => set({ streaming: value }),
      setSuppressAutoApply: (value) => set({ suppressAutoApply: value }),
      setAgentMode: (mode) => set({ agentMode: mode }),
      openGrantModal: () => set({ grantModalOpen: true }),
      closeGrantModal: () => set({ grantModalOpen: false }),
      setLogsOpen: (value) => set({ logsOpen: value }),
      ensureDesktopShortcut: (id, fallback) =>
        set((state) => {
          if (state.desktopShortcuts[id]) {
            return {};
          }
          return {
            desktopShortcuts: {
              ...state.desktopShortcuts,
              [id]: fallback,
            },
          };
        }),
      setDesktopShortcutPosition: (id, position) =>
        set((state) => {
          const current = state.desktopShortcuts[id];
          if (current && current.x === position.x && current.y === position.y) {
            return {};
          }
          return {
            desktopShortcuts: {
              ...state.desktopShortcuts,
              [id]: position,
            },
          };
        }),
      upsertWorkspaceWindow: (meta) =>
        set((state) => ({
          workspaceWindows: {
            ...state.workspaceWindows,
            [meta.id]: meta,
          },
        })),
      removeWorkspaceWindow: (id) =>
        set((state) => {
          if (!state.workspaceWindows[id]) return {};
          const next = { ...state.workspaceWindows };
          delete next[id];
          return { workspaceWindows: next };
        }),
      pushToast: (toast) =>
        set((state) => ({
          toasts: [...state.toasts, { id: crypto.randomUUID(), ...toast }],
        })),
      dismissToast: (id) =>
        set((state) => ({
          toasts: state.toasts.filter((toast) => toast.id !== id),
        })),
    }),
    {
      name: 'uicp-app',
      partialize: (state) => ({
        fullControl: state.fullControl,
        chatOpen: state.chatOpen,
        desktopShortcuts: state.desktopShortcuts,
        workspaceWindows: state.workspaceWindows,
        agentMode: state.agentMode,
      }),
    },
  ),
);
