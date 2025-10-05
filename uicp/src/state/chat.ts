import { create } from "zustand";
import { applyBatch } from "../lib/uicp/adapter";
import { mockPlanner } from "../lib/mock";
import type { Batch } from "../lib/uicp/schemas";
import { UICPValidationError, validateBatch } from "../lib/uicp/schemas";
import { createId } from "../lib/utils";
import { useAppStore } from "./app";

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
        summary = mock.summary;
        batch = validateBatch(mock.batch);
      } else {
        const plannerUrl = import.meta.env.VITE_PLANNER_URL as string | undefined;
        if (!plannerUrl) {
          throw new Error("Planner URL missing.");
        }
        const response = await fetch(plannerUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prompt }),
        });
        if (!response.ok) {
          throw new Error(`Planner responded ${response.status}`);
        }
        const payload = await response.json();
        summary = typeof payload.summary === "string" ? payload.summary : "Planner result";
        batch = validateBatch(payload.batch);
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
          ? `${error.message} (${error.pointer})`
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

useAppStore.subscribe((state) => {
  if (!state.fullControl || state.fullControlLocked) {
    return;
  }
  const { pendingPlan, applyPendingPlan } = useChatStore.getState();
  if (pendingPlan) {
    void applyPendingPlan();
  }
});

