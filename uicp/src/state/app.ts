import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  getDefaultPlannerProfileKey,
  getDefaultActorProfileKey,
  type PlannerProfileKey,
  type ActorProfileKey,
} from '../lib/llm/profiles';
import { createId } from '../lib/utils';

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

export type AgentPhase = 'idle' | 'planning' | 'acting' | 'applying';

export type AgentStatus = {
  phase: AgentPhase;
  traceId?: string;
  planMs: number | null;
  actMs: number | null;
  applyMs: number | null;
  startedAt: number | null;
  lastUpdatedAt: number | null;
  error?: string;
};

export type IntentTelemetryStatus = 'planning' | 'acting' | 'applying' | 'applied' | 'error' | 'cancelled';

export type IntentTelemetry = {
  traceId: string;
  summary: string;
  startedAt: number;
  planMs: number | null;
  actMs: number | null;
  applyMs: number | null;
  batchSize: number | null;
  status: IntentTelemetryStatus;
  error?: string;
  updatedAt: number;
};

export type DevtoolsAnalyticsContext = {
  agentPhase: AgentPhase;
  traceId?: string;
  streaming: boolean;
  logsOpen: boolean;
  metricsOpen: boolean;
  notepadOpen: boolean;
  agentSettingsOpen: boolean;
  computeDemoOpen: boolean;
  workspaceWindows: number;
  devMode: boolean;
  agentMode: AgentMode;
  fullControl: boolean;
  fullControlLocked: boolean;
  platform: string;
};

export type DevtoolsAnalyticsEvent = {
  id: string;
  timestamp: number;
  trigger: 'keyboard' | 'menu' | 'api';
  combo: string;
  direction: 'open' | 'close' | 'unknown';
  context: DevtoolsAnalyticsContext;
};

export type DevtoolsAnalyticsPayload = {
  trigger: DevtoolsAnalyticsEvent['trigger'];
  combo: string;
  direction?: DevtoolsAnalyticsEvent['direction'];
  context: DevtoolsAnalyticsContext;
  timestamp?: number;
};

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
  agentStatus: AgentStatus;
  // When true, aggregator will not auto-apply or preview parsed batches.
  // Used to prevent duplicate application while orchestrator-driven flows run.
  suppressAutoApply: boolean;
  grantModalOpen: boolean;
  // Controls visibility of the LogsPanel.
  logsOpen: boolean;
  metricsOpen: boolean;
  // Keep a dedicated flag for the built-in Notepad utility window so local UI can toggle it.
  notepadOpen: boolean;
  agentSettingsOpen: boolean;
  plannerProfileKey: PlannerProfileKey;
  actorProfileKey: ActorProfileKey;
  // Tracks user-placement of desktop shortcuts so the layout feels persistent.
  desktopShortcuts: Record<string, DesktopShortcutPosition>;
  // Mirrors workspace windows produced via adapter so the desktop menu stays in sync.
  workspaceWindows: Record<string, WorkspaceWindowMeta>;
  telemetry: IntentTelemetry[];
  devtoolsAnalytics: DevtoolsAnalyticsEvent[];
  devtoolsAssumedOpen: boolean;
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
  setMetricsOpen: (value: boolean) => void;
  setNotepadOpen: (value: boolean) => void;
  setAgentSettingsOpen: (value: boolean) => void;
  setComputeDemoOpen: (value: boolean) => void;
  setPlannerProfileKey: (key: PlannerProfileKey) => void;
  setActorProfileKey: (key: ActorProfileKey) => void;
  ensureDesktopShortcut: (id: string, fallback: DesktopShortcutPosition) => void;
  setDesktopShortcutPosition: (id: string, position: DesktopShortcutPosition) => void;
  upsertWorkspaceWindow: (meta: WorkspaceWindowMeta) => void;
  removeWorkspaceWindow: (id: string) => void;
  pushToast: (toast: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;
  transitionAgentPhase: (phase: AgentPhase, patch?: Partial<Omit<AgentStatus, 'phase'>>) => void;
  upsertTelemetry: (traceId: string, patch: Partial<Omit<IntentTelemetry, 'traceId'>>) => void;
  clearTelemetry: () => void;
  recordDevtoolsAnalytics: (payload: DevtoolsAnalyticsPayload) => void;
  clearDevtoolsAnalytics: () => void;
  setDevtoolsAssumedOpen: (value: boolean) => void;
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
      agentStatus: {
        phase: 'idle',
        traceId: undefined,
        planMs: null,
        actMs: null,
        applyMs: null,
        startedAt: null,
        lastUpdatedAt: null,
        error: undefined,
      },
      suppressAutoApply: false,
      grantModalOpen: false,
      logsOpen: false,
      metricsOpen: false,
      notepadOpen: false,
      agentSettingsOpen: false,
      computeDemoOpen: false,
      plannerProfileKey: getDefaultPlannerProfileKey(),
      actorProfileKey: getDefaultActorProfileKey(),
      desktopShortcuts: {},
      workspaceWindows: {},
      telemetry: [],
      devtoolsAnalytics: [],
      devtoolsAssumedOpen: false,
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
      setMetricsOpen: (value) => set({ metricsOpen: value }),
      setNotepadOpen: (value) => set({ notepadOpen: value }),
      setAgentSettingsOpen: (value) => set({ agentSettingsOpen: value }),
      setComputeDemoOpen: (value) => set({ computeDemoOpen: value }),
      setPlannerProfileKey: (key) => set({ plannerProfileKey: key }),
      setActorProfileKey: (key) => set({ actorProfileKey: key }),
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
      transitionAgentPhase: (phase, patch) =>
        set((state) => {
          const now = Date.now();
          if (phase === 'planning') {
            return {
              agentStatus: {
                phase,
                traceId: patch?.traceId,
                planMs: patch?.planMs ?? null,
                actMs: patch?.actMs ?? null,
                applyMs: patch?.applyMs ?? null,
                startedAt: patch?.startedAt ?? now,
                lastUpdatedAt: now,
                error: patch?.error,
              },
            };
          }

          const next: AgentStatus = {
            ...state.agentStatus,
            phase,
            lastUpdatedAt: now,
          };

          if (patch) {
            if (patch.traceId !== undefined) next.traceId = patch.traceId;
            if (patch.planMs !== undefined) next.planMs = patch.planMs;
            if (patch.actMs !== undefined) next.actMs = patch.actMs;
            if (patch.applyMs !== undefined) next.applyMs = patch.applyMs;
            if (patch.startedAt !== undefined) next.startedAt = patch.startedAt;
            if (patch.error !== undefined) {
              next.error = patch.error;
            } else if (phase !== 'idle') {
              next.error = undefined;
            }
          } else if (phase !== 'idle') {
            next.error = undefined;
          }

          return { agentStatus: next };
        }),
      upsertTelemetry: (traceId, patch) =>
        set((state) => {
          if (!traceId) {
            return {};
          }
          const now = Date.now();
          const existingIndex = state.telemetry.findIndex((entry) => entry.traceId === traceId);
          const draft: IntentTelemetry = existingIndex >= 0
            ? { ...state.telemetry[existingIndex] }
            : {
                traceId,
                summary: patch.summary ?? '',
                startedAt: patch.startedAt ?? now,
                planMs: patch.planMs ?? null,
                actMs: patch.actMs ?? null,
                applyMs: patch.applyMs ?? null,
                batchSize: patch.batchSize ?? null,
                status: patch.status ?? 'planning',
                error: patch.error,
                updatedAt: now,
              };

          if (patch.summary !== undefined) draft.summary = patch.summary;
          if (patch.startedAt !== undefined) draft.startedAt = patch.startedAt;
          if (patch.planMs !== undefined) draft.planMs = patch.planMs;
          if (patch.actMs !== undefined) draft.actMs = patch.actMs;
          if (patch.applyMs !== undefined) draft.applyMs = patch.applyMs;
          if (patch.batchSize !== undefined) draft.batchSize = patch.batchSize;
          if (patch.status !== undefined) draft.status = patch.status;
          if (patch.error !== undefined) {
            draft.error = patch.error;
          }
          draft.updatedAt = now;
          const next = [...state.telemetry];
          if (existingIndex >= 0) {
            next[existingIndex] = draft;
          } else {
            next.unshift(draft);
          }
          const MAX_ENTRIES = 25;
          if (next.length > MAX_ENTRIES) {
            next.length = MAX_ENTRIES;
          }
          return { telemetry: next };
        }),
      clearTelemetry: () => set({ telemetry: [] }),
      recordDevtoolsAnalytics: (payload) =>
        set((state) => {
          if (!payload) return {};
          const now = payload.timestamp ?? Date.now();
          const direction =
            payload.direction && payload.direction !== 'unknown'
              ? payload.direction
              : state.devtoolsAssumedOpen
                ? 'close'
                : 'open';
          const entry: DevtoolsAnalyticsEvent = {
            id: createId('devtools'),
            timestamp: now,
            trigger: payload.trigger,
            combo: payload.combo,
            direction,
            context: payload.context,
          };
          const next = [entry, ...state.devtoolsAnalytics];
          const MAX_ENTRIES = 100;
          if (next.length > MAX_ENTRIES) {
            next.length = MAX_ENTRIES;
          }
          const assumedOpen = direction === 'open' ? true : direction === 'close' ? false : state.devtoolsAssumedOpen;
          return { devtoolsAnalytics: next, devtoolsAssumedOpen: assumedOpen };
        }),
      clearDevtoolsAnalytics: () => set({ devtoolsAnalytics: [] }),
      setDevtoolsAssumedOpen: (value) => set({ devtoolsAssumedOpen: value }),
    }),
    {
      name: 'uicp-app',
      partialize: (state) => ({
        fullControl: state.fullControl,
        chatOpen: state.chatOpen,
        desktopShortcuts: state.desktopShortcuts,
        workspaceWindows: state.workspaceWindows,
        notepadOpen: state.notepadOpen,
        agentMode: state.agentMode,
        plannerProfileKey: state.plannerProfileKey,
        actorProfileKey: state.actorProfileKey,
        agentSettingsOpen: state.agentSettingsOpen,
        computeDemoOpen: (state as any).computeDemoOpen,
      }),
    },
  ),
);
