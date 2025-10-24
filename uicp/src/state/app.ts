import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import {
  getDefaultPlannerProfileKey,
  getDefaultActorProfileKey,
  setSelectedPlannerProfileKey,
  setSelectedActorProfileKey,
  type PlannerProfileKey,
  type ActorProfileKey,
  type ReasoningEffort,
} from '../lib/llm/profiles';
import { createId } from '../lib/utils';
import { readBooleanEnv } from '../lib/env/values';
import { getAppMode, getModeDefaults } from '../lib/mode';
import type { TraceEvent } from '../lib/telemetry/types';
import {
  type OrchestratorContext,
  type StateTransition,
  type OrchestratorEventName,
  create_initial_context,
  increment_run_id,
  execute_transition,
  can_auto_apply,
 

} from '../lib/orchestrator/state-machine';

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

export type AgentPhase = 'idle' | 'planning' | 'acting' | 'previewing' | 'applying' | 'complete' | 'cancelled';

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

export type IntentTelemetryStatus =
  | 'planning'
  | 'acting'
  | 'previewing'
  | 'applying'
  | 'applied'
  | 'error'
  | 'cancelled';

export type IntentTelemetry = {
  traceId: string;
  batchId?: string; // Stable batch identifier from ApplyOutcome for deduplication tracking
  runId?: number; // Orchestrator run counter for correlating plan→act→apply cycles
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

export type TelemetryBuffer = {
  capacity: number;
  data: Array<IntentTelemetry | undefined>;
  head: number;
  size: number;
  version: number;
};

const TELEMETRY_CAPACITY = 25;
const TRACE_EVENTS_PER_TRACE = 80;
const TRACE_TRACE_CAPACITY = 25;

const createTelemetryBuffer = (capacity = TELEMETRY_CAPACITY): TelemetryBuffer => ({
  capacity,
  data: new Array<IntentTelemetry | undefined>(capacity),
  head: 0,
  size: 0,
  version: 0,
});

const telemetryBufferFindIndex = (buffer: TelemetryBuffer, traceId: string): number => {
  const { size, capacity, head, data } = buffer;
  for (let i = 0; i < size; i += 1) {
    const idx = (head - 1 - i + capacity) % capacity;
    const entry = data[idx];
    if (entry && entry.traceId === traceId) {
      return idx;
    }
  }
  return -1;
};

export const telemetryBufferToArray = (buffer: TelemetryBuffer, limit?: number): IntentTelemetry[] => {
  const { size, capacity, head, data } = buffer;
  const result: IntentTelemetry[] = [];
  const count = Math.min(limit ?? size, size);
  for (let i = 0; i < count; i += 1) {
    const idx = (head - 1 - i + capacity) % capacity;
    const entry = data[idx];
    if (entry) {
      result.push(entry);
    }
  }
  return result;
};

const markTelemetry = (event: string) => {
  if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
    performance.mark(event);
  }
};

export type DevtoolsAnalyticsContext = {
  agentPhase: AgentPhase;
  traceId?: string;
  streaming: boolean;
  logsOpen: boolean;
  metricsOpen: boolean;
  notepadOpen: boolean;
  agentSettingsOpen: boolean;
  preferencesOpen: boolean;
  computeDemoOpen: boolean;
  moduleRegistryOpen: boolean;
  workspaceWindows: number;
  devMode: boolean;
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

export type AppState = {
  connectionStatus: ConnectionStatus;
  devMode: boolean;
  fullControl: boolean;
  fullControlLocked: boolean;
  chatOpen: boolean;
  streaming: boolean;
  agentStatus: AgentStatus;
  safeMode: boolean;
  safeReason?: string;
  // When true, aggregator will not auto-apply or preview parsed batches.
  // Used to prevent duplicate application while orchestrator-driven flows run.
  suppressAutoApply: boolean;
  // Orchestrator state machine context - tracks current state, run ID, and transitions
  orchestratorContext: OrchestratorContext;
  grantModalOpen: boolean;
  // Controls visibility of the LogsPanel.
  logsOpen: boolean;
  metricsOpen: boolean;
  // Keep a dedicated flag for the built-in Notepad utility window so local UI can toggle it.
  notepadOpen: boolean;
  agentSettingsOpen: boolean;
  preferencesOpen: boolean;
  computeDemoOpen: boolean;
  moduleRegistryOpen: boolean;
  agentTraceOpen: boolean;
  policyViewerOpen: boolean;
  networkInspectorOpen: boolean;
  firstRunPermissionsReviewed: boolean;
  plannerProfileKey: PlannerProfileKey;
  actorProfileKey: ActorProfileKey;
  plannerReasoningEffort: ReasoningEffort;
  actorReasoningEffort: ReasoningEffort;
  plannerTwoPhaseEnabled: boolean;
  // Feature flag: Enable Motion-powered animations for windows/panels/icons
  motionEnabled: boolean;
  // Tracks user-placement of desktop shortcuts so the layout feels persistent.
  desktopShortcuts: Record<string, DesktopShortcutPosition>;
  // Pinned workspace windows exposed as desktop shortcuts by windowId -> meta
  pinnedWindows: Record<string, { title: string }>;
  // Mirrors workspace windows produced via adapter so the desktop menu stays in sync.
  workspaceWindows: Record<string, WorkspaceWindowMeta>;
  telemetryBuffer: TelemetryBuffer;
  telemetry: IntentTelemetry[];
  traceEvents: Record<string, TraceEvent[]>;
  traceOrder: string[];
  traceEventVersion: number;
  traceProviders: Record<string, string>;
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
  setSafeMode: (enabled: boolean, reason?: string) => void;
  openGrantModal: () => void;
  closeGrantModal: () => void;
  setLogsOpen: (value: boolean) => void;
  setMetricsOpen: (value: boolean) => void;
  setNotepadOpen: (value: boolean) => void;
  setAgentSettingsOpen: (value: boolean) => void;
  setPreferencesOpen: (value: boolean) => void;
  setComputeDemoOpen: (value: boolean) => void;
  setModuleRegistryOpen: (value: boolean) => void;
  setAgentTraceOpen: (value: boolean) => void;
  setPolicyViewerOpen: (value: boolean) => void;
  setNetworkInspectorOpen: (value: boolean) => void;
  setFirstRunPermissionsReviewed: (value: boolean) => void;
  setPlannerProfileKey: (key: PlannerProfileKey) => void;
  setActorProfileKey: (key: ActorProfileKey) => void;
  setPlannerReasoningEffort: (effort: ReasoningEffort) => void;
  setActorReasoningEffort: (effort: ReasoningEffort) => void;
  setPlannerTwoPhaseEnabled: (value: boolean) => void;
  setMotionEnabled: (value: boolean) => void;
  ensureDesktopShortcut: (id: string, fallback: DesktopShortcutPosition) => void;
  setDesktopShortcutPosition: (id: string, position: DesktopShortcutPosition) => void;
  removeDesktopShortcut: (id: string) => void;
  pinWindow: (windowId: string, title: string) => void;
  unpinWindow: (windowId: string) => void;
  upsertWorkspaceWindow: (meta: WorkspaceWindowMeta) => void;
  removeWorkspaceWindow: (id: string) => void;
  pushToast: (toast: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;
  transitionAgentPhase: (phase: AgentPhase, patch?: Partial<Omit<AgentStatus, 'phase'>>) => void;
  upsertTelemetry: (traceId: string, patch: Partial<Omit<IntentTelemetry, 'traceId'>>) => void;
  clearTelemetry: () => void;
  recordTraceEvent: (event: TraceEvent) => void;
  clearTraceEvents: (traceId?: string) => void;
  setTraceProvider: (traceId: string, provider: string) => void;
  clearTraceProvider: (traceId: string) => void;
  recordDevtoolsAnalytics: (payload: DevtoolsAnalyticsPayload) => void;
  clearDevtoolsAnalytics: () => void;
  setDevtoolsAssumedOpen: (value: boolean) => void;
  // Orchestrator state machine methods
  transitionOrchestrator: (event: OrchestratorEventName, metadata?: Record<string, unknown>) => StateTransition | null;
  startNewOrchestratorRun: () => void;
  canAutoApply: () => boolean;
};

export const useAppStore = create<AppState>()(
  persist(
    immer((set, get) => ({
      connectionStatus: 'disconnected',
      devMode: readBooleanEnv('VITE_DEV_MODE', getModeDefaults(getAppMode()).devMode),
      fullControl: false,
      fullControlLocked: false,
      chatOpen: false,
      streaming: false,
      agentStatus: {
        phase: 'idle',
        planMs: null,
        actMs: null,
        applyMs: null,
        startedAt: null,
        lastUpdatedAt: null,
      },
      safeMode: false,
      safeReason: undefined,
      suppressAutoApply: false,
      orchestratorContext: create_initial_context({ fullControl: false, fullControlLocked: false }),
      grantModalOpen: false,
      logsOpen: false,
      metricsOpen: false,
      notepadOpen: false,
      agentSettingsOpen: false,
      preferencesOpen: false,
      computeDemoOpen: false,
      moduleRegistryOpen: false,
      agentTraceOpen: false,
      policyViewerOpen: false,
      networkInspectorOpen: false,
      firstRunPermissionsReviewed: false,
      plannerProfileKey: getDefaultPlannerProfileKey(),
      actorProfileKey: getDefaultActorProfileKey(),
      plannerReasoningEffort: 'high',
      actorReasoningEffort: 'high',
      plannerTwoPhaseEnabled: readBooleanEnv('VITE_PLANNER_TWO_PHASE', getModeDefaults(getAppMode()).plannerTwoPhase),
      motionEnabled: true, // Start with Motion enabled by default
      desktopShortcuts: {},
      pinnedWindows: {},
      workspaceWindows: {},
      telemetryBuffer: createTelemetryBuffer(),
      telemetry: [],
      traceEvents: {},
      traceOrder: [],
      traceEventVersion: 0,
      traceProviders: {},
      devtoolsAnalytics: [],
      devtoolsAssumedOpen: false,
      toasts: [],
      setConnectionStatus: (status) => set({ connectionStatus: status }),
      setDevMode: (devMode) => set({ devMode }),
      setFullControl: (value) =>
        set((state) => ({
          fullControl: value,
          fullControlLocked: false,
          orchestratorContext: {
            ...state.orchestratorContext,
            fullControl: value,
            fullControlLocked: false,
          },
        })),
      lockFullControl: () =>
        set((state) => ({
          fullControl: false,
          fullControlLocked: true,
          orchestratorContext: {
            ...state.orchestratorContext,
            fullControl: false,
            fullControlLocked: true,
          },
        })),
      unlockFullControl: () =>
        set((state) => ({
          fullControlLocked: false,
          orchestratorContext: {
            ...state.orchestratorContext,
            fullControlLocked: false,
          },
        })),
      setChatOpen: (value) => set({ chatOpen: value }),
      setStreaming: (value) => set({ streaming: value }),
      setSuppressAutoApply: (value) => set({ suppressAutoApply: value }),
      setSafeMode: (enabled, reason) =>
        set({ safeMode: enabled, safeReason: enabled ? reason : undefined }),
      openGrantModal: () => set({ grantModalOpen: true }),
      closeGrantModal: () => set({ grantModalOpen: false }),
      setLogsOpen: (value) => set({ logsOpen: value }),
      setMetricsOpen: (value) => set({ metricsOpen: value }),
      setNotepadOpen: (value) => set({ notepadOpen: value }),
      setAgentSettingsOpen: (value) => set({ agentSettingsOpen: value }),
      setPreferencesOpen: (value) => set({ preferencesOpen: value }),
      setComputeDemoOpen: (value) => set({ computeDemoOpen: value }),
      setModuleRegistryOpen: (value) => set({ moduleRegistryOpen: value }),
      setAgentTraceOpen: (value) => set({ agentTraceOpen: value }),
      setPolicyViewerOpen: (value) => set({ policyViewerOpen: value }),
      setNetworkInspectorOpen: (value) => set({ networkInspectorOpen: value }),
      setFirstRunPermissionsReviewed: (value) => set({ firstRunPermissionsReviewed: value }),
      setPlannerProfileKey: (key) => {
        setSelectedPlannerProfileKey(key);
        set({ plannerProfileKey: key });
      },
      setActorProfileKey: (key) => {
        setSelectedActorProfileKey(key);
        set({ actorProfileKey: key });
      },
      setPlannerReasoningEffort: (effort) => set({ plannerReasoningEffort: effort }),
      setActorReasoningEffort: (effort) => set({ actorReasoningEffort: effort }),
      setPlannerTwoPhaseEnabled: (value) => set({ plannerTwoPhaseEnabled: value }),
      setMotionEnabled: (value) => set({ motionEnabled: value }),
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
      removeDesktopShortcut: (id) =>
        set((state) => {
          if (!(id in state.desktopShortcuts)) return {};
          const next = { ...state.desktopShortcuts };
          delete next[id];
          return { desktopShortcuts: next };
        }),
      pinWindow: (windowId, title) =>
        set((state) => {
          if (state.pinnedWindows[windowId]?.title === title) return {};
          return {
            pinnedWindows: {
              ...state.pinnedWindows,
              [windowId]: { title },
            },
          };
        }),
      unpinWindow: (windowId) =>
        set((state) => {
          if (!state.pinnedWindows[windowId]) return {};
          const next = { ...state.pinnedWindows };
          delete next[windowId];
          return { pinnedWindows: next };
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
          markTelemetry('intent-telemetry-upsert');
          const now = Date.now();
          const buffer = state.telemetryBuffer;
          const index = telemetryBufferFindIndex(buffer, traceId);
          const data = buffer.data.slice();
          let head = buffer.head;
          let size = buffer.size;

          const baseEntry: IntentTelemetry =
            index >= 0 && data[index]
              ? { ...data[index]! }
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

          if (patch.summary !== undefined) baseEntry.summary = patch.summary;
          if (patch.startedAt !== undefined) baseEntry.startedAt = patch.startedAt;
          if (patch.planMs !== undefined) baseEntry.planMs = patch.planMs;
          if (patch.actMs !== undefined) baseEntry.actMs = patch.actMs;
          if (patch.applyMs !== undefined) baseEntry.applyMs = patch.applyMs;
          if (patch.batchSize !== undefined) baseEntry.batchSize = patch.batchSize;
          if (patch.status !== undefined) baseEntry.status = patch.status;
          if (patch.error !== undefined) {
            baseEntry.error = patch.error;
          }
          baseEntry.updatedAt = now;

          if (index >= 0) {
            data[index] = baseEntry;
          } else {
            data[head] = baseEntry;
            head = (head + 1) % buffer.capacity;
            if (size < buffer.capacity) {
              size += 1;
            }
          }

            const nextBuffer: TelemetryBuffer = {
              capacity: buffer.capacity,
              data,
              head,
              size,
              version: buffer.version + 1,
            };
            return {
              telemetryBuffer: nextBuffer,
              telemetry: telemetryBufferToArray(nextBuffer),
            };
          }),
      clearTelemetry: () =>
        set((state) => {
          markTelemetry('intent-telemetry-clear');
          return {
            telemetryBuffer: createTelemetryBuffer(state.telemetryBuffer.capacity),
            telemetry: [],
          };
        }),
      recordTraceEvent: (event) =>
        set((state) => {
          if (!event?.traceId) return {};

          const existing = state.traceEvents[event.traceId] ?? [];
          const appended = [...existing, event];
          if (appended.length > TRACE_EVENTS_PER_TRACE) {
            appended.splice(0, appended.length - TRACE_EVENTS_PER_TRACE);
          }

          const nextTraceEvents = {
            ...state.traceEvents,
            [event.traceId]: appended,
          };

          const updatedOrder = [event.traceId, ...state.traceOrder.filter((id) => id !== event.traceId)];
          let trimmedOrder = updatedOrder;
          let trimmedEvents = nextTraceEvents;

          let trimmedProviders = state.traceProviders;
          if (updatedOrder.length > TRACE_TRACE_CAPACITY) {
            const keep = updatedOrder.slice(0, TRACE_TRACE_CAPACITY);
            trimmedOrder = keep;
            trimmedEvents = {};
            trimmedProviders = {};
            for (const id of keep) {
              trimmedEvents[id] = nextTraceEvents[id] ?? [];
              const provider = state.traceProviders[id];
              if (provider) {
                trimmedProviders[id] = provider;
              }
            }
          }

          // Capture provider decisions into map for quick lookup
          const providerNext = (() => {
            if (event.name !== 'provider_decision') return trimmedProviders;
            const data = (event.data ?? {}) as Record<string, unknown>;
            const direct = typeof data['provider'] === 'string' ? (data['provider'] as string) : undefined;
            const decision = data['decision'] as Record<string, unknown> | undefined;
            const kind = typeof decision?.kind === 'string' ? (decision.kind as string) : undefined;
            const provider = direct ?? kind;
            if (!provider) return trimmedProviders;
            if (trimmedProviders[event.traceId] === provider) return trimmedProviders;
            return {
              ...trimmedProviders,
              [event.traceId]: provider,
            };
          })();

          return {
            traceEvents: trimmedEvents,
            traceOrder: trimmedOrder,
            traceEventVersion: state.traceEventVersion + 1,
            traceProviders: providerNext,
          };
        }),
      clearTraceEvents: (traceId) =>
        set((state) => {
          if (!traceId) {
            if (state.traceOrder.length === 0) return {};
            return {
              traceEvents: {},
              traceOrder: [],
              traceEventVersion: state.traceEventVersion + 1,
              traceProviders: {},
            };
          }
          if (!state.traceEvents[traceId]) {
            return {};
          }
          const next = { ...state.traceEvents };
          delete next[traceId];
          const nextProviders = { ...state.traceProviders };
          delete nextProviders[traceId];
          return {
            traceEvents: next,
            traceOrder: state.traceOrder.filter((id) => id !== traceId),
            traceEventVersion: state.traceEventVersion + 1,
            traceProviders: nextProviders,
          };
        }),
      setTraceProvider: (traceId, provider) =>
        set((state) => {
          if (!traceId || !provider) return {};
          const prev = state.traceProviders[traceId];
          if (prev === provider) return {};
          return {
            traceProviders: {
              ...state.traceProviders,
              [traceId]: provider,
            },
          };
        }),
      clearTraceProvider: (traceId) =>
        set((state) => {
          if (!traceId || !state.traceProviders[traceId]) return {};
          const next = { ...state.traceProviders };
          delete next[traceId];
          return { traceProviders: next };
        }),
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
      // Orchestrator state machine methods
      transitionOrchestrator: (event, metadata) => {
        let transition: StateTransition | null = null;
        set((state) => {
          try {
            const result = execute_transition(state.orchestratorContext, event, metadata);
            transition = result.transition;

            // WHY: Log state transitions for debugging and audit trail
            if (import.meta.env.DEV) {
              console.debug('[orchestrator] state transition', {
                from: transition.from,
                to: transition.to,
                event: transition.event,
                runId: transition.runId,
                metadata: transition.metadata,
              });
            }

            return { orchestratorContext: result.context };
          } catch (error) {
            // WHY: Invalid transitions should be logged but not crash the app
            console.error('[orchestrator] invalid transition', {
              currentState: state.orchestratorContext.state,
              event,
              error: error instanceof Error ? error.message : String(error),
            });
            return {};
          }
        });
        return transition;
      },
      startNewOrchestratorRun: () =>
        set((state) => {
          const newContext = increment_run_id(state.orchestratorContext);
          if (import.meta.env.DEV) {
            console.debug('[orchestrator] starting new run', { runId: newContext.runId });
          }
          return { orchestratorContext: newContext };
        }),
      canAutoApply: () => can_auto_apply(get().orchestratorContext),
    })),
    {
      name: 'uicp-app',
      partialize: (state) => ({
        fullControl: state.fullControl,
        chatOpen: state.chatOpen,
        desktopShortcuts: state.desktopShortcuts,
        pinnedWindows: state.pinnedWindows,
        workspaceWindows: state.workspaceWindows,
        notepadOpen: state.notepadOpen,
        plannerProfileKey: state.plannerProfileKey,
        actorProfileKey: state.actorProfileKey,
        plannerReasoningEffort: state.plannerReasoningEffort,
        actorReasoningEffort: state.actorReasoningEffort,
        plannerTwoPhaseEnabled: state.plannerTwoPhaseEnabled,
        motionEnabled: state.motionEnabled,
        agentSettingsOpen: state.agentSettingsOpen,
        computeDemoOpen: state.computeDemoOpen,
        moduleRegistryOpen: state.moduleRegistryOpen,
        safeMode: state.safeMode,
        safeReason: state.safeReason,
        firstRunPermissionsReviewed: state.firstRunPermissionsReviewed,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        if (state.plannerProfileKey) {
          setSelectedPlannerProfileKey(state.plannerProfileKey);
        }
        if (state.actorProfileKey) {
          setSelectedActorProfileKey(state.actorProfileKey);
        }
      },
    },
  ),
);

export const useAppSelector = <T>(selector: (state: AppState) => T): T => useAppStore(selector);

export const selectComputeDemoOpen = (state: AppState) => state.computeDemoOpen;
export const selectSetComputeDemoOpen = (state: AppState) => state.setComputeDemoOpen;
export const selectModuleRegistryOpen = (state: AppState) => state.moduleRegistryOpen;
export const selectSetModuleRegistryOpen = (state: AppState) => state.setModuleRegistryOpen;
export const selectSafeMode = (state: AppState) => state.safeMode;
export const selectSafeReason = (state: AppState) => state.safeReason;
export const selectSetSafeMode = (state: AppState) => state.setSafeMode;
