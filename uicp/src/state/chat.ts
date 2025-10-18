import { create } from "zustand";
import { applyBatch } from "../lib/uicp/adapters/adapter";
import type { Batch, Envelope } from "../lib/uicp/adapters/schemas";
import { UICPValidationError, validateBatch, validatePlan } from "../lib/uicp/adapters/schemas";
import { createId } from "../lib/utils";
import { useAppStore } from "./app";
import { runIntent } from "../lib/llm/orchestrator";
import { OrchestratorEvent } from "../lib/orchestrator/state-machine";

export type ChatRole = "user" | "assistant" | "system";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  planId?: string;
  errorCode?: string;
};

export type PlanPreview = {
  id: string;
  summary: string;
  batch: Batch;
  traceId?: string;
  timings?: {
    planMs: number | null;
    actMs: number | null;
  };
  autoApply?: boolean;
};

export type ChatState = {
  messages: ChatMessage[];
  pendingPlan?: PlanPreview;
  sending: boolean;
  error?: string;
  sendMessage: (content: string) => Promise<void>;
  applyPendingPlan: () => Promise<void>;
  cancelStreaming: () => void;
  pushSystemMessage: (content: string, errorCode?: string) => void;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const nowMs = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

const ensureBatchMetadata = (input: Batch, fallbackTraceId?: string): { batch: Batch; traceId: string } => {
  let trace = fallbackTraceId ?? input.find((env: Envelope) => env.traceId)?.traceId;
  if (!trace) {
    trace = createId("trace");
  }
  let txn = input.find((env: Envelope) => env.txnId)?.txnId ?? createId("txn");

  const stamped = input.map((env: Envelope) => ({
    ...env,
    idempotencyKey: env.idempotencyKey ?? createId("idemp"),
    traceId: env.traceId ?? trace!,
    txnId: env.txnId ?? txn,
  })) as Batch;

  return { batch: stamped, traceId: trace };
};

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  pendingPlan: undefined,
  sending: false,
  error: undefined,
  async sendMessage(content: string) {
    const prompt = content.trim();
    if (!prompt) return;

    const app = useAppStore.getState();
    if (app.fullControlLocked) {
      app.pushToast({ variant: "error", message: "Full control is locked. Re-enable it before sending." });
      set((state) => ({
        messages: [
          ...state.messages,
          {
            id: createId("msg"),
            role: "system",
            content: "Full control was previously stopped. Open the modal to re-enable before sending commands.",
            createdAt: Date.now(),
            errorCode: "full_control_locked",
          },
        ],
      }));
      return;
    }

    const messageId = createId("msg");
    app.startNewOrchestratorRun();
    app.transitionOrchestrator(OrchestratorEvent.StartPlanning, { messageId, prompt });
    set((state) => ({
      messages: [
        ...state.messages,
        { id: messageId, role: "user", content: prompt, createdAt: Date.now() },
      ],
      sending: true,
      error: undefined,
    }));

    const startedAt = Date.now();
    app.transitionAgentPhase("planning", {
      startedAt,
      traceId: undefined,
      planMs: null,
      actMs: null,
      applyMs: null,
      error: undefined,
    });

    app.setStreaming(true);

    let traceId: string | undefined;
    let planDuration: number | null = null;
    let actDuration: number | null = null;

    try {
      let batch: Batch;
      let summary: string;
      let notice: 'planner_fallback' | 'actor_fallback' | undefined;
      let planAutoApply = false;
      let needsPreview = true;

      // Orchestrator path: DeepSeek (planner) -> Qwen (actor) via streaming transport.
      app.setSuppressAutoApply(true);
      try {
        const result = await runIntent(
          prompt,
          /* applyNow */ false,
          {
            onPhaseChange: (detail) => {
              if (detail.phase === 'planning') {
                traceId = detail.traceId;
                app.transitionAgentPhase('planning', {
                  startedAt,
                  traceId,
                  planMs: null,
                  actMs: null,
                  applyMs: null,
                  error: undefined,
                });
              } else {
                traceId = detail.traceId;
                planDuration = detail.planMs;
                app.transitionAgentPhase('acting', {
                  traceId,
                  planMs: planDuration,
                  actMs: null,
                });
                app.transitionOrchestrator(OrchestratorEvent.PlannerCompleted, {
                  traceId,
                  planMs: detail.planMs,
                });
              }
            },
          },
          {
            plannerProfileKey: app.plannerProfileKey,
            actorProfileKey: app.actorProfileKey,
          },
        );
        notice = result.notice;
        const plannerFailure = result.failures?.planner;
        const actorFailure = result.failures?.actor;
        const safePlan = validatePlan({ summary: result.plan.summary, risks: result.plan.risks, batch: result.plan.batch });
        const safeBatch = validateBatch(result.batch);
        summary = safePlan.summary;
        planDuration = result.timings.planMs;
        actDuration = result.timings.actMs;
        const autoApply = Boolean(result.autoApply);
        planAutoApply = autoApply;
        needsPreview = !planAutoApply;
          const stamped = ensureBatchMetadata(safeBatch, result.traceId);
        batch = stamped.batch;
        traceId = stamped.traceId;
        app.transitionAgentPhase('acting', {
          traceId,
          planMs: planDuration,
          actMs: actDuration,
        });
        const orchestratorAfterPlan = useAppStore.getState().orchestratorContext.state;
        if (orchestratorAfterPlan === 'planning') {
          app.transitionOrchestrator(OrchestratorEvent.PlannerCompleted, {
            traceId,
            planMs: planDuration,
          });
        }
        const telemetryPatch: Parameters<typeof app.upsertTelemetry>[1] = {
          summary,
          startedAt,
          planMs: planDuration,
          actMs: actDuration,
          batchSize: batch.length,
          status: needsPreview ? 'previewing' : 'applying',
        };
        const failureMessages = [plannerFailure, actorFailure].filter((msg): msg is string => Boolean(msg));
        if (failureMessages.length > 0) {
          telemetryPatch.error = failureMessages.join('; ');
        }
        app.upsertTelemetry(traceId, telemetryPatch);
        // Surface clarifier reason when planner_fallback resulted from an actor nop
        if (notice === 'planner_fallback' && actorFailure) {
          get().pushSystemMessage(`Clarifier needed: ${actorFailure}`, 'clarifier_needed');
        }
        const plannerRisks = (safePlan.risks ?? []).filter((risk: string) => !risk.trim().toLowerCase().startsWith('clarifier:'));
        if (plannerRisks.length > 0) {
          const lines = plannerRisks.map((r: string) => (r.startsWith('gui:') ? r : `risk: ${r}`)).join('\n');
          get().pushSystemMessage(`Planner hints${traceId ? ` [${traceId}]` : ''}:\n${lines}`, 'planner_hints');
        }
        if (notice === 'planner_fallback') {
          const message = plannerFailure
            ? `Planner degraded: ${plannerFailure}`
            : 'Planner degraded: using actor-only fallback for this intent.';
          get().pushSystemMessage(message, 'planner_fallback');
        } else if (notice === 'actor_fallback') {
          const message = actorFailure
            ? `Actor failed to produce a batch: ${actorFailure}`
            : 'Actor failed to produce a batch. Showing a safe error window.';
          get().pushSystemMessage(message, 'actor_fallback');
        }
        if (plannerFailure && notice !== 'planner_fallback') {
          get().pushSystemMessage(
            `Planner error${traceId ? ` [${traceId}]` : ''}: ${plannerFailure}`,
            'planner_error',
          );
        }
        if (actorFailure && notice !== 'actor_fallback') {
          get().pushSystemMessage(
            `Actor error${traceId ? ` [${traceId}]` : ''}: ${actorFailure}`,
            'actor_error',
          );
        }
      } finally {
        app.setSuppressAutoApply(false);
      }

      const plan: PlanPreview = {
        id: createId('plan'),
        summary,
        batch,
        traceId,
        timings: {
          planMs: planDuration,
          actMs: actDuration,
        },
        autoApply: planAutoApply,
      };

      if (traceId) {
        const metrics: string[] = [];
        if (planDuration !== null) metrics.push(`plan ${planDuration} ms`);
        if (actDuration !== null) metrics.push(`act ${actDuration} ms`);
        metrics.push(`${plan.batch.length} command${plan.batch.length === 1 ? '' : 's'}`);
        get().pushSystemMessage(`Trace ${traceId}: ${metrics.join(' - ')}`, 'telemetry_metrics');
      }

      // Surface the planner summary as an assistant message before we consider auto-apply.
      const summaryContent = needsPreview ? `${summary}\nReview the plan and press Apply when ready.` : summary;

      set((state) => ({
        messages: [
          ...state.messages,
          {
            id: createId('msg'),
            role: 'assistant',
            content: summaryContent,
            createdAt: Date.now(),
            planId: plan.id,
          },
        ],
      }));

      const fullControlEnabled = app.fullControl && !app.fullControlLocked;
      if (!needsPreview) {
        const applyStarted = nowMs();
        app.transitionAgentPhase('applying', {
          traceId,
          planMs: planDuration,
          actMs: actDuration,
        });
        app.transitionOrchestrator(OrchestratorEvent.AutoApply, {
          traceId,
          planMs: planDuration,
          actMs: actDuration,
          source: 'clarifier',
        });
        if (traceId) {
          app.upsertTelemetry(traceId, {
            status: 'applying',
          });
        }
        const outcome = await applyBatch(plan.batch);
        const applyDuration = Math.max(0, Math.round(nowMs() - applyStarted));
        if (!outcome.success) {
          const errorMessage = outcome.errors.join('; ') || 'Clarifier apply failed';
          set((state) => ({
            messages: [
              ...state.messages,
              {
                id: createId('msg'),
                role: 'system',
                content: `Failed to launch clarifier form: ${errorMessage}`,
                createdAt: Date.now(),
                errorCode: 'clarifier_apply_failed',
              },
            ],
          }));
          app.pushToast({ variant: 'error', message: 'Unable to render clarifier form.' });
          app.transitionAgentPhase('idle', {
            traceId,
            planMs: planDuration,
            actMs: actDuration,
            applyMs: applyDuration,
            error: errorMessage,
          });
          if (traceId) {
            app.upsertTelemetry(traceId, {
              batchId: outcome.batchId,
              runId: app.orchestratorContext.runId,
              applyMs: applyDuration,
              status: 'error',
              error: errorMessage,
            });
          }
        app.transitionOrchestrator(OrchestratorEvent.ApplyFailed, {
          traceId,
          batchId: outcome.batchId,
          applied: outcome.applied,
          errors: outcome.errors,
        });
          set({ pendingPlan: plan });
        } else {
          app.transitionAgentPhase('idle', {
            traceId,
            planMs: planDuration,
            actMs: actDuration,
            applyMs: applyDuration,
          });
          if (traceId) {
            app.upsertTelemetry(traceId, {
              batchId: outcome.batchId,
              runId: app.orchestratorContext.runId,
              applyMs: applyDuration,
              status: 'applied',
              error: undefined,
            });
          }
          set({ pendingPlan: undefined });
        }
      } else if (fullControlEnabled) {
        await delay(120);
        const applyStarted = nowMs();
        app.transitionAgentPhase('applying', {
          traceId,
          planMs: planDuration,
          actMs: actDuration,
        });
        if (traceId) {
          app.upsertTelemetry(traceId, {
            status: 'applying',
          });
        }
        const outcome = await applyBatch(plan.batch);
        const applyDuration = Math.max(0, Math.round(nowMs() - applyStarted));
        if (!outcome.success) {
          const errorMessage = outcome.errors.join('; ');
          set((state) => ({
            messages: [
              ...state.messages,
              {
                id: createId('msg'),
                role: 'system',
                content: `Apply completed with errors: ${errorMessage}`,
                createdAt: Date.now(),
                errorCode: 'apply_errors',
              },
            ],
          }));
          app.pushToast({ variant: 'error', message: 'Some commands failed during apply.' });
          app.transitionAgentPhase('idle', {
            traceId,
            planMs: planDuration,
            actMs: actDuration,
            applyMs: applyDuration,
            error: errorMessage,
          });
          if (traceId) {
            app.upsertTelemetry(traceId, {
              batchId: outcome.batchId,
              runId: app.orchestratorContext.runId,
              applyMs: applyDuration,
              status: 'error',
              error: errorMessage,
            });
          }
        } else {
          const appliedMessage = `Applied ${outcome.applied} commands in ${applyDuration} ms${traceId ? ` [${traceId}]` : ''}.`;
          set((state) => ({
            messages: [
              ...state.messages,
              {
                id: createId('msg'),
                role: 'system',
                content: appliedMessage,
                createdAt: Date.now(),
              },
            ],
          }));
          app.pushToast({ variant: 'success', message: 'Plan applied.' });
          app.transitionAgentPhase('idle', {
            traceId,
            planMs: planDuration,
            actMs: actDuration,
            applyMs: applyDuration,
          });
          if (traceId) {
            app.upsertTelemetry(traceId, {
              batchId: outcome.batchId,
              runId: app.orchestratorContext.runId,
              applyMs: applyDuration,
              status: 'applied',
              error: undefined,
            });
          }
          app.transitionOrchestrator(OrchestratorEvent.ApplySucceeded, {
            traceId,
            batchId: outcome.batchId,
            applied: outcome.applied,
          });
          app.startNewOrchestratorRun();
        }
      } else {
        app.transitionAgentPhase('previewing', {
          traceId,
          planMs: planDuration,
          actMs: actDuration,
        });
        app.transitionOrchestrator(OrchestratorEvent.RequirePreview, {
          traceId,
          reason: fullControlEnabled ? 'auto_apply_ready' : 'user_review',
        });
        set({ pendingPlan: plan });
      }
    } catch (error) {
      const code = error instanceof UICPValidationError ? 'validation_error' : 'planner_error';
      const message =
        error instanceof UICPValidationError
          ? formatValidationErrorMessage(error)
          : error instanceof Error
            ? error.message
            : String(error);
      set((state) => ({
        error: message,
        messages: [
          ...state.messages,
          {
            id: createId('msg'),
            role: 'system',
            content: `Planner failed: ${message}`,
            createdAt: Date.now(),
            errorCode: code,
          },
        ],
      }));
      app.transitionAgentPhase('idle', {
        traceId,
        planMs: planDuration,
        actMs: actDuration,
        applyMs: null,
        error: message,
      });
      if (traceId) {
        app.upsertTelemetry(traceId, {
          planMs: planDuration,
          actMs: actDuration,
          status: 'error',
          error: message,
        });
      }
      const orchestratorState = useAppStore.getState().orchestratorContext.state;
      if (orchestratorState === 'planning') {
        app.transitionOrchestrator(OrchestratorEvent.PlannerFailed, {
          traceId,
          error: message,
        });
      } else if (orchestratorState === 'acting' || orchestratorState === 'previewing') {
        app.transitionOrchestrator(OrchestratorEvent.Cancel, {
          traceId,
          error: message,
        });
      } else if (orchestratorState === 'applying') {
        app.transitionOrchestrator(OrchestratorEvent.ApplyFailed, {
          traceId,
          error: message,
        });
      }
      app.startNewOrchestratorRun();
      useAppStore.getState().pushToast({ variant: 'error', message: 'Planner failed. Check system message for details.' });
    } finally {
      app.setStreaming(false);
      set({ sending: false });
    }
  },
  async applyPendingPlan() {
    const plan = get().pendingPlan;
    if (!plan) return;
    const app = useAppStore.getState();
    if (!app.fullControl || app.fullControlLocked) {
      app.pushToast({ variant: 'error', message: 'Enable full control before applying.' });
      return;
    }
    app.setStreaming(true);
    const currentOrchestrator = useAppStore.getState().orchestratorContext;
    if (currentOrchestrator.state !== 'previewing') {
      app.startNewOrchestratorRun();
      app.transitionOrchestrator(OrchestratorEvent.StartPlanning, {
        traceId: plan.traceId,
        resume: true,
      });
      app.transitionOrchestrator(OrchestratorEvent.PlannerCompleted, {
        traceId: plan.traceId,
        planMs: plan.timings?.planMs ?? null,
      });
      app.transitionOrchestrator(OrchestratorEvent.RequirePreview, {
        traceId: plan.traceId,
        reason: 'retry',
      });
    }
    app.transitionOrchestrator(OrchestratorEvent.PreviewAccepted, {
      traceId: plan.traceId,
      planMs: plan.timings?.planMs ?? null,
      actMs: plan.timings?.actMs ?? null,
    });
    app.transitionAgentPhase('applying', {
      traceId: plan.traceId,
      planMs: plan.timings?.planMs ?? null,
      actMs: plan.timings?.actMs ?? null,
    });
    if (plan.traceId) {
      app.upsertTelemetry(plan.traceId, {
        status: 'applying',
      });
    }
    try {
      await delay(120);
      const applyStarted = nowMs();
      const outcome = await applyBatch(plan.batch);
      const applyDuration = Math.max(0, Math.round(nowMs() - applyStarted));
      if (!outcome.success) {
        const errorMessage = outcome.errors.join('; ');
        set((state) => ({
          messages: [
            ...state.messages,
            {
              id: createId('msg'),
              role: 'system',
              content: `Apply completed with errors: ${errorMessage}`,
              createdAt: Date.now(),
              errorCode: 'apply_errors',
            },
          ],
        }));
        app.pushToast({ variant: 'error', message: 'Apply encountered errors.' });
        app.transitionAgentPhase('idle', {
          traceId: plan.traceId,
          planMs: plan.timings?.planMs ?? null,
          actMs: plan.timings?.actMs ?? null,
          applyMs: applyDuration,
          error: errorMessage,
        });
        if (plan.traceId) {
          app.upsertTelemetry(plan.traceId, {
            batchId: outcome.batchId,
            runId: app.orchestratorContext.runId,
            applyMs: applyDuration,
            status: 'error',
            error: errorMessage,
          });
        }
        app.transitionOrchestrator(OrchestratorEvent.ApplyFailed, {
          traceId: plan.traceId,
          batchId: outcome.batchId,
          applied: outcome.applied,
          errors: outcome.errors,
        });
      } else {
        const appliedMessage = `Applied ${outcome.applied} commands in ${applyDuration} ms${plan.traceId ? ` [${plan.traceId}]` : ''}.`;
        set((state) => ({
          messages: [
            ...state.messages,
            {
              id: createId('msg'),
              role: 'system',
              content: appliedMessage,
              createdAt: Date.now(),
            },
          ],
        }));
        app.pushToast({ variant: 'success', message: 'Plan applied.' });
        app.transitionAgentPhase('idle', {
          traceId: plan.traceId,
          planMs: plan.timings?.planMs ?? null,
          actMs: plan.timings?.actMs ?? null,
          applyMs: applyDuration,
        });
        if (plan.traceId) {
          app.upsertTelemetry(plan.traceId, {
            batchId: outcome.batchId,
            runId: app.orchestratorContext.runId,
            applyMs: applyDuration,
            status: 'applied',
            error: undefined,
          });
        }
        app.transitionOrchestrator(OrchestratorEvent.ApplySucceeded, {
          traceId: plan.traceId,
          batchId: outcome.batchId,
          applied: outcome.applied,
        });
        app.startNewOrchestratorRun();
      }
    } finally {
      set({ pendingPlan: undefined });
      app.setStreaming(false);
    }
  },
  cancelStreaming() {
    const app = useAppStore.getState();
    const cancelBatch = validateBatch([
      {
        op: 'txn.cancel',
        idempotencyKey: createId('txn.cancel'),
        params: { id: createId('txn') },
      },
    ]);
    void applyBatch(cancelBatch);
    app.lockFullControl();
    const lastTrace = app.agentStatus.traceId;
    app.transitionOrchestrator(OrchestratorEvent.Cancel, {
      traceId: lastTrace,
      reason: 'user_cancel',
    });
    app.transitionAgentPhase('idle', {
      traceId: undefined,
      planMs: null,
      actMs: null,
      applyMs: null,
      error: 'cancelled',
    });
    if (lastTrace) {
      app.upsertTelemetry(lastTrace, {
        status: 'cancelled',
        error: 'cancelled',
      });
    }
    app.setStreaming(false);
    set((state) => ({
      pendingPlan: undefined,
      messages: [
        ...state.messages,
        {
          id: createId('msg'),
          role: 'system',
          content: 'Streaming cancelled. Full control disabled until re-enabled.',
          createdAt: Date.now(),
          errorCode: 'txn_cancelled',
        },
      ],
    }));

    app.startNewOrchestratorRun();
  },
  pushSystemMessage(content: string, errorCode?: string) {
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id: createId("msg"),
          role: "system",
          content,
          createdAt: Date.now(),
          errorCode,
        },
      ],
    }));
  },
}));

// Helpers: Turn a validation pointer into a friendly hint for users.
export const getValidationHint = (pointer: string): string => {
  const p = pointer.toLowerCase();
  if (p.includes("/params/html")) {
    return "Provide safe HTML only; no <script>, inline event handlers, or javascript: URLs.";
  }
  if (p.includes("/params/windowid")) {
    return "windowId must be a non-empty string referencing an existing window.";
  }
  if (p.includes("/params/target")) {
    return "Target must be a valid CSS selector present in the window content.";
  }
  if (p.includes("/params/title")) {
    return "Title is required and must be a non-empty string.";
  }
  if (p.includes("/params/width") || p.includes("/params/height")) {
    return "Width/height must be numbers and at least 120.";
  }
  if (p.includes("/op")) {
    return "Unsupported operation; use documented UICP ops only.";
  }
  if (p.includes("/batch")) {
    return "Ensure plan.batch is a non-empty array of command entries.";
  }
  return "Check the field referenced by the pointer for required type and constraints.";
};

export const formatValidationErrorMessage = (err: UICPValidationError): string => {
  const hint = getValidationHint(err.pointer);
  return `${err.message} (${err.pointer}). Hint: ${hint}`;
};

useAppStore.subscribe((state) => {
  if (!state.fullControl || state.fullControlLocked) {
    return;
  }
  if (state.streaming) {
    return;
  }
  const { pendingPlan, applyPendingPlan } = useChatStore.getState();
  if (pendingPlan) {
    void applyPendingPlan();
  }
});

