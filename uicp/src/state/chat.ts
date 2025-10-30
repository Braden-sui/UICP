import { create } from "zustand";
import type { StoreApi } from "zustand";
import { applyBatch } from "../lib/uicp/adapters/adapter";
import type { Batch, Envelope } from "../lib/uicp/adapters/schemas";
import { UICPValidationError, validateBatch, validatePlan } from "../lib/uicp/adapters/schemas";
import type { ProblemDetail } from "../lib/llm/protocol/errors";
import { LLMError, LLMErrorCode } from "../lib/llm/errors";
import { createId } from "../lib/utils";
import { useAppStore } from "./app";
import { runIntent } from "../lib/llm/orchestrator";
import { OrchestratorEvent } from "../lib/orchestrator/state-machine";

/**
 * Convert an LLM error to a ProblemDetail for banner display
 */
const llmErrorToProblemDetail = (error: unknown): ProblemDetail | null => {
  if (error instanceof LLMError) {
    // Map LLM error codes to categories
    const category = (() => {
      switch (error.code) {
        case LLMErrorCode.PlannerModelMissing:
        case LLMErrorCode.ActorModelMissing:
          return 'policy';
        case LLMErrorCode.StreamTimeout:
        case LLMErrorCode.ToolCollectionTimeout:
        case LLMErrorCode.CollectionTimeout:
          return 'rate_limit';
        case LLMErrorCode.StreamUpstreamError:
        case LLMErrorCode.StreamBridgeUnavailable:
          return 'transport';
        default:
          return 'policy';
      }
    })();

    return {
      code: error.code,
      category,
      detail: error.message,
      hint: getErrorHint(error.code),
      retryable: isRetryableError(error.code),
    };
  }

  if (error instanceof UICPValidationError) {
    return {
      code: 'validation_error',
      category: 'schema',
      detail: error.message,
      hint: 'Check your input format and try again.',
      retryable: false,
    };
  }

  return null;
};

/**
 * Get remediation hints for common error codes
 */
const getErrorHint = (code: string): string => {
  switch (code) {
    case LLMErrorCode.PlannerModelMissing:
    case LLMErrorCode.ActorModelMissing:
      return 'Choose a model in Agent Settings or provide a model via environment variables.';
    case LLMErrorCode.StreamTimeout:
      return 'Try again with a shorter request or check your network connection.';
    case LLMErrorCode.StreamUpstreamError:
      return 'Check your internet connection and API keys, then try again.';
    case LLMErrorCode.PlannerEmpty:
    case LLMErrorCode.ActorEmpty:
      return 'The AI model produced no response. Try rephrasing your request.';
    default:
      return 'Try again or contact support if the problem persists.';
  }
};

/**
 * Determine if an error is retryable
 */
const isRetryableError = (code: string): boolean => {
  switch (code) {
    case LLMErrorCode.StreamTimeout:
    case LLMErrorCode.StreamUpstreamError:
    case LLMErrorCode.PlannerEmpty:
    case LLMErrorCode.ActorEmpty:
    case LLMErrorCode.ToolCollectionTimeout:
      return true;
    default:
      return false;
  }
};

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

type ChatStoreApi = StoreApi<ChatState>;

type ChatStoreSet = ChatStoreApi["setState"];

type ChatStoreGet = ChatStoreApi["getState"];

type SendSession = {
  prompt: string;
  messageId: string;
  startedAt: number;
  traceId?: string;
  planDuration: number | null;
  actDuration: number | null;
};

type PlanRunResult = {
  plan: PlanPreview;
  needsPreview: boolean;
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

const handleFullControlLocked = (app: ReturnType<typeof useAppStore.getState>, set: ChatStoreSet) => {
  if (!app.fullControlLocked) {
    return false;
  }
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
  return true;
};

const beginSendSession = ({
  app,
  set,
  prompt,
}: {
  app: ReturnType<typeof useAppStore.getState>;
  set: ChatStoreSet;
  prompt: string;
}): SendSession => {
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
  return {
    prompt,
    messageId,
    startedAt,
    traceId: undefined,
    planDuration: null,
    actDuration: null,
  };
};

const executePlanGeneration = async ({
  app,
  set,
  get,
  session,
}: {
  app: ReturnType<typeof useAppStore.getState>;
  set: ChatStoreSet;
  get: ChatStoreGet;
  session: SendSession;
}): Promise<PlanRunResult> => {
  let summary: string;
  let notice: "planner_fallback" | "actor_fallback" | undefined;
  let needsPreview = true;

  // Orchestrator path: DeepSeek (planner) -> Qwen (actor) via streaming transport.
  app.setSuppressAutoApply(true);
  try {
    app.setLastModels(undefined);
    const result = await runIntent(
      session.prompt,
      /* applyNow */ false,
      {
        onPhaseChange: (detail) => {
          if (detail.phase === "planning") {
            session.traceId = detail.traceId;
            app.transitionAgentPhase("planning", {
              startedAt: session.startedAt,
              traceId: session.traceId,
              planMs: null,
              actMs: null,
              applyMs: null,
              error: undefined,
            });
          } else {
            session.traceId = detail.traceId;
            session.planDuration = detail.planMs;
            app.transitionAgentPhase("acting", {
              traceId: session.traceId,
              planMs: session.planDuration,
              actMs: null,
            });
            app.transitionOrchestrator(OrchestratorEvent.PlannerCompleted, {
              traceId: session.traceId,
              planMs: detail.planMs,
            });
          }
        },
      },
      {
        plannerProfileKey: app.plannerProfileKey,
        actorProfileKey: app.actorProfileKey,
        plannerTwoPhaseEnabled: app.plannerTwoPhaseEnabled,
      },
    );
    app.setLastModels(result.models);
    notice = result.notice;
    const plannerFailure = result.failures?.planner;
    const actorFailure = result.failures?.actor;
    const safePlan = validatePlan({ summary: result.plan.summary, risks: result.plan.risks, batch: result.plan.batch });
    const safeBatch = validateBatch(result.batch);
    summary = safePlan.summary;
    session.planDuration = result.timings.planMs;
    session.actDuration = result.timings.actMs;
    const autoApply = Boolean(result.autoApply);
    needsPreview = !autoApply;
    const stamped = ensureBatchMetadata(safeBatch, result.traceId);
    const batch = stamped.batch;
    session.traceId = stamped.traceId;
    app.transitionAgentPhase("acting", {
      traceId: session.traceId,
      planMs: session.planDuration,
      actMs: session.actDuration,
    });
    const orchestratorAfterPlan = useAppStore.getState().orchestratorContext.state;
    if (orchestratorAfterPlan === "planning") {
      app.transitionOrchestrator(OrchestratorEvent.PlannerCompleted, {
        traceId: session.traceId,
        planMs: session.planDuration,
      });
    }
    const telemetryPatch: Parameters<typeof app.upsertTelemetry>[1] = {
      summary,
      startedAt: session.startedAt,
      planMs: session.planDuration,
      actMs: session.actDuration,
      batchSize: batch.length,
      status: needsPreview ? "previewing" : "applying",
    };
    const failureMessages = [plannerFailure, actorFailure].filter((msg): msg is string => Boolean(msg));
    if (failureMessages.length > 0) {
      telemetryPatch.error = failureMessages.join("; ");
    }
    if (session.traceId) {
      app.upsertTelemetry(session.traceId, telemetryPatch);
    }
    if (notice === "planner_fallback" && actorFailure) {
      get().pushSystemMessage(`Clarifier needed: ${actorFailure}`, "clarifier_needed");
    }
    const plannerRisks = (safePlan.risks ?? []).filter((risk: string) => !risk.trim().toLowerCase().startsWith("clarifier:"));
    if (plannerRisks.length > 0) {
      const lines = plannerRisks.map((r: string) => (r.startsWith("gui:") ? r : `risk: ${r}`)).join("\n");
      get().pushSystemMessage(`Planner hints${session.traceId ? ` [${session.traceId}]` : ""}:\n${lines}`, "planner_hints");
    }
    if (notice === "planner_fallback") {
      const message = plannerFailure
        ? `Planner degraded: ${plannerFailure}`
        : "Planner degraded: using actor-only fallback for this intent.";
      get().pushSystemMessage(message, "planner_fallback");
    } else if (notice === "actor_fallback") {
      const message = actorFailure
        ? `Actor failed to produce a batch: ${actorFailure}`
        : "Actor failed to produce a batch. Showing a safe error window.";
      get().pushSystemMessage(message, "actor_fallback");
    }
    if (plannerFailure && notice !== "planner_fallback") {
      get().pushSystemMessage(
        `Planner error${session.traceId ? ` [${session.traceId}]` : ""}: ${plannerFailure}`,
        "planner_error",
      );
    }
    if (actorFailure && notice !== "actor_fallback") {
      get().pushSystemMessage(
        `Actor error${session.traceId ? ` [${session.traceId}]` : ""}: ${actorFailure}`,
        "actor_error",
      );
    }
    const plan: PlanPreview = {
      id: createId("plan"),
      summary,
      batch,
      traceId: session.traceId,
      timings: {
        planMs: session.planDuration,
        actMs: session.actDuration,
      },
      autoApply,
    };
    if (session.traceId) {
      const metrics: string[] = [];
      if (session.planDuration !== null) metrics.push(`plan ${session.planDuration} ms`);
      if (session.actDuration !== null) metrics.push(`act ${session.actDuration} ms`);
      metrics.push(`${plan.batch.length} command${plan.batch.length === 1 ? "" : "s"}`);
      get().pushSystemMessage(`Trace ${session.traceId}: ${metrics.join(" - ")}`, "telemetry_metrics");
    }
    // Surface the planner summary as an assistant message before we consider auto-apply.
    const summaryContent = needsPreview ? `${summary}\nReview the plan and press Apply when ready.` : summary;
    set((state) => ({
      messages: [
        ...state.messages,
        {
          id: createId("msg"),
          role: "assistant",
          content: summaryContent,
          createdAt: Date.now(),
          planId: plan.id,
        },
      ],
    }));
    return { plan, needsPreview };
  } finally {
    app.setSuppressAutoApply(false);
  }
};

const handlePlanOutcome = async ({
  app,
  set,
  plan,
  needsPreview,
  session,
}: {
  app: ReturnType<typeof useAppStore.getState>;
  set: ChatStoreSet;
  plan: PlanPreview;
  needsPreview: boolean;
  session: SendSession;
}) => {
  const traceId = session.traceId;
  const planDuration = session.planDuration;
  const actDuration = session.actDuration;
  const fullControlEnabled = app.fullControl && !app.fullControlLocked;
  if (!needsPreview) {
    const applyStarted = nowMs();
    app.transitionAgentPhase("applying", {
      traceId,
      planMs: planDuration,
      actMs: actDuration,
    });
    app.transitionOrchestrator(OrchestratorEvent.AutoApply, {
      traceId,
      planMs: planDuration,
      actMs: actDuration,
      source: "clarifier",
    });
    if (traceId) {
      app.upsertTelemetry(traceId, {
        status: "applying",
      });
    }
    const outcome = await applyBatch(plan.batch);
    const applyDuration = Math.max(0, Math.round(nowMs() - applyStarted));
    if (!outcome.success) {
      const errorMessage = outcome.errors.join("; ") || "Clarifier apply failed";
      set((state) => ({
        messages: [
          ...state.messages,
          {
            id: createId("msg"),
            role: "system",
            content: `Failed to launch clarifier form: ${errorMessage}`,
            createdAt: Date.now(),
            errorCode: "clarifier_apply_failed",
          },
        ],
      }));
      app.pushToast({ variant: "error", message: "Unable to render clarifier form." });
      app.transitionAgentPhase("idle", {
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
          status: "error",
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
      app.transitionAgentPhase("idle", {
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
          status: "applied",
          error: undefined,
        });
      }
      set({ pendingPlan: undefined });
    }
    return;
  }
  if (fullControlEnabled) {
    await delay(120);
    const applyStarted = nowMs();
    app.transitionAgentPhase("applying", {
      traceId,
      planMs: planDuration,
      actMs: actDuration,
    });
    if (traceId) {
      app.upsertTelemetry(traceId, {
        status: "applying",
      });
    }
    const outcome = await applyBatch(plan.batch);
    const applyDuration = Math.max(0, Math.round(nowMs() - applyStarted));
    if (!outcome.success) {
      const errorMessage = outcome.errors.join("; ");
      set((state) => ({
        messages: [
          ...state.messages,
          {
            id: createId("msg"),
            role: "system",
            content: `Apply completed with errors: ${errorMessage}`,
            createdAt: Date.now(),
            errorCode: "apply_errors",
          },
        ],
      }));
      app.pushToast({ variant: "error", message: "Some commands failed during apply." });
      app.transitionAgentPhase("idle", {
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
          status: "error",
          error: errorMessage,
        });
      }
    } else {
      const appliedMessage = `Applied ${outcome.applied} commands in ${applyDuration} ms${traceId ? ` [${traceId}]` : ""}.`;
      set((state) => ({
        messages: [
          ...state.messages,
          {
            id: createId("msg"),
            role: "system",
            content: appliedMessage,
            createdAt: Date.now(),
          },
        ],
      }));
      app.pushToast({ variant: "success", message: "Plan applied." });
      app.transitionAgentPhase("idle", {
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
          status: "applied",
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
    return;
  }
  app.transitionAgentPhase("previewing", {
    traceId,
    planMs: planDuration,
    actMs: actDuration,
  });
  app.transitionOrchestrator(OrchestratorEvent.RequirePreview, {
    traceId,
    reason: fullControlEnabled ? "auto_apply_ready" : "user_review",
  });
  set({ pendingPlan: plan });
};

const handleSendError = ({
  error,
  app,
  set,
  session,
}: {
  error: unknown;
  app: ReturnType<typeof useAppStore.getState>;
  set: ChatStoreSet;
  session: SendSession;
}) => {
  const code = error instanceof UICPValidationError ? "validation_error" : "planner_error";
  const message =
    error instanceof UICPValidationError
      ? formatValidationErrorMessage(error)
      : error instanceof Error
        ? error.message
        : String(error);
  
  // Try to convert to ProblemDetail and show banner if applicable
  const problemDetail = llmErrorToProblemDetail(error);
  if (problemDetail) {
    app.showProblemDetail(session.traceId || 'send-error', problemDetail);
  }
  
  set((state) => ({
    error: message,
    messages: [
      ...state.messages,
      {
        id: createId("msg"),
        role: "system",
        content: `Planner failed: ${message}`,
        createdAt: Date.now(),
        errorCode: code,
      },
    ],
  }));
  app.transitionAgentPhase("idle", {
    traceId: session.traceId,
    planMs: session.planDuration,
    actMs: session.actDuration,
    applyMs: null,
    error: message,
  });
  if (session.traceId) {
    app.upsertTelemetry(session.traceId, {
      planMs: session.planDuration,
      actMs: session.actDuration,
      status: "error",
      error: message,
    });
  }
  const orchestratorState = useAppStore.getState().orchestratorContext.state;
  if (orchestratorState === "planning") {
    app.transitionOrchestrator(OrchestratorEvent.PlannerFailed, {
      traceId: session.traceId,
      error: message,
    });
  } else if (orchestratorState === "acting" || orchestratorState === "previewing") {
    app.transitionOrchestrator(OrchestratorEvent.Cancel, {
      traceId: session.traceId,
      error: message,
    });
  } else if (orchestratorState === "applying") {
    app.transitionOrchestrator(OrchestratorEvent.ApplyFailed, {
      traceId: session.traceId,
      error: message,
    });
  }
  app.startNewOrchestratorRun();
  useAppStore.getState().pushToast({ variant: "error", message: "Planner failed. Check system message for details." });
};

const finalizeSend = ({
  app,
  set,
}: {
  app: ReturnType<typeof useAppStore.getState>;
  set: ChatStoreSet;
}) => {
  app.setStreaming(false);
  set({ sending: false });
};

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  pendingPlan: undefined,
  sending: false,
  error: undefined,
  async sendMessage(content: string) {
    const prompt = content.trim();
    if (!prompt) return;

    // Guard against double-submit: if already sending, ignore
    if (get().sending) {
      console.warn('[chat] sendMessage ignored: already sending');
      return;
    }

    const app = useAppStore.getState();
    if (handleFullControlLocked(app, set)) {
      return;
    }

    const session = beginSendSession({ app, set, prompt });

    app.setStreaming(true);

    try {
      const { plan, needsPreview } = await executePlanGeneration({ app, set, get, session });
      await handlePlanOutcome({ app, set, plan, needsPreview, session });
    } catch (error) {
      handleSendError({ error, app, set, session });
    } finally {
      finalizeSend({ app, set });
    }
  },
  async applyPendingPlan() {
    const plan = get().pendingPlan;
    if (!plan) return;

    // Guard against double-apply: check if already applying
    const currentStreaming = useAppStore.getState().streaming;
    if (currentStreaming) {
      console.warn('[chat] applyPendingPlan ignored: already applying');
      return;
    }

    const app = useAppStore.getState();
    if (!app.fullControl || app.fullControlLocked) {
      app.pushToast({ variant: "error", message: "Enable full control before applying." });
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
      sending: false, // Reset sending state so send button becomes enabled again
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

