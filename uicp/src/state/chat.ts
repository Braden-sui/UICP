import { create } from "zustand";
import { applyBatch } from "../lib/uicp/adapter";
import { mockPlanner } from "../lib/mock";
import type { Batch } from "../lib/uicp/schemas";
import { UICPValidationError, validateBatch, validatePlan } from "../lib/uicp/schemas";
import { createId } from "../lib/utils";
import { useAppStore } from "./app";
import { runIntent } from "../lib/llm/orchestrator";

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

const isMockMode = () => {
  const flag = import.meta.env.VITE_MOCK_MODE as string | undefined;
  return flag === undefined ? true : flag !== "false";
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
    set((state) => ({
      messages: [
        ...state.messages,
        { id: messageId, role: "user", content: prompt, createdAt: Date.now() },
      ],
      sending: true,
      error: undefined,
    }));

    app.setStreaming(true);

    try {
      let batch: Batch;
      let summary: string;

      if (isMockMode()) {
        const mock = mockPlanner(prompt);
        const plan = validatePlan({ summary: mock.summary, batch: mock.batch }, "/batch");
        summary = plan.summary;
        batch = plan.batch;
      } else {
        // Orchestrator path: DeepSeek (planner) → Kimi (actor) via streaming transport.
        // Suppress aggregator auto-apply/preview while we orchestrate to avoid duplicates.
        useAppStore.getState().setSuppressAutoApply(true);
        try {
          const { plan, batch: acted } = await runIntent(prompt, /* applyNow */ false);
          // Validate defensively before surfacing to UI
          const safePlan = validatePlan({ summary: plan.summary, batch: plan.batch });
          const safeBatch = validateBatch(acted);
          summary = safePlan.summary;
          batch = safeBatch;
        } finally {
          useAppStore.getState().setSuppressAutoApply(false);
        }
      }

      const plan: PlanPreview = {
        id: createId("plan"),
        summary,
        batch,
      };

      const fullControlEnabled = app.fullControl && !app.fullControlLocked;
      if (fullControlEnabled) {
        await delay(120);
        const outcome = await applyBatch(plan.batch);
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
        } else {
          set((state) => ({
            messages: [
              ...state.messages,
              {
                id: createId("msg"),
                role: "assistant",
                content: summary,
                createdAt: Date.now(),
              },
            ],
          }));
          app.pushToast({ variant: "success", message: "Plan applied." });
        }
      } else {
        set({ pendingPlan: plan });
        set((state) => ({
          messages: [
            ...state.messages,
            {
              id: createId("msg"),
              role: "assistant",
              content: `${summary}\nReview the plan and press Apply when ready.`,
              createdAt: Date.now(),
              planId: plan.id,
            },
          ],
        }));
      }
    } catch (error) {
      const code = error instanceof UICPValidationError ? "validation_error" : "planner_error";
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
            id: createId("msg"),
            role: "system",
            content: `Planner failed: ${message}`,
            createdAt: Date.now(),
            errorCode: code,
          },
        ],
      }));
      useAppStore.getState().pushToast({ variant: "error", message: "Planner failed. Check system message for details." });
    } finally {
      useAppStore.getState().setStreaming(false);
      set({ sending: false });
    }
  },
  async applyPendingPlan() {
    const plan = get().pendingPlan;
    if (!plan) return;
    const app = useAppStore.getState();
    if (!app.fullControl || app.fullControlLocked) {
      app.pushToast({ variant: "error", message: "Enable full control before applying." });
      return;
    }
    app.setStreaming(true);
    try {
      await delay(120);
      const outcome = await applyBatch(plan.batch);
      if (!outcome.success) {
        set((state) => ({
          messages: [
            ...state.messages,
            {
              id: createId("msg"),
              role: "system",
              content: `Apply completed with errors: ${outcome.errors.join("; ")}`,
              createdAt: Date.now(),
              errorCode: "apply_errors",
            },
          ],
        }));
        app.pushToast({ variant: "error", message: "Apply encountered errors." });
      } else {
        set((state) => ({
          messages: [
            ...state.messages,
            {
              id: createId("msg"),
              role: "assistant",
              content: plan.summary,
              createdAt: Date.now(),
            },
          ],
        }));
        app.pushToast({ variant: "success", message: "Plan applied." });
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
        op: "txn.cancel",
        idempotencyKey: createId("txn.cancel"),
        params: { id: createId("txn") },
      },
    ]);
    void applyBatch(cancelBatch);
    app.lockFullControl();
    app.setStreaming(false);
    set((state) => ({
      pendingPlan: undefined,
      messages: [
        ...state.messages,
        {
          id: createId("msg"),
          role: "system",
          content: "Streaming cancelled. Full control disabled until re-enabled.",
          createdAt: Date.now(),
          errorCode: "txn_cancelled",
        },
      ],
    }));
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
  const { pendingPlan, applyPendingPlan } = useChatStore.getState();
  if (pendingPlan) {
    void applyPendingPlan();
  }
});

