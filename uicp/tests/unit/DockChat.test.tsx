import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import DockChat from "../../src/components/DockChat";
import { useAppStore } from "../../src/state/app";
import { useChatStore } from "../../src/state/chat";

const mocks = vi.hoisted(() => ({
  streamMock: vi.fn(() => (async function* () {
    yield { type: "done" as const };
  })()),
}));

vi.mock("../../src/lib/llm/ollama", () => ({
  streamOllamaCompletion: mocks.streamMock,
}));

const streamMock = mocks.streamMock;

const ensureCrypto = () => {
  if (!globalThis.crypto) {
    // Minimal stub so pushToast can mint IDs during tests.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    globalThis.crypto = {};
  }
  if (!globalThis.crypto.randomUUID) {
    globalThis.crypto.randomUUID = () => "00000000-0000-0000-0000-000000000000";
  }
};

const resetStores = () => {
  useAppStore.setState({
    chatOpen: false,
    streaming: false,
    fullControl: false,
    fullControlLocked: false,
    suppressAutoApply: false,
    agentStatus: {
      phase: "idle",
      traceId: undefined,
      planMs: null,
      actMs: null,
      applyMs: null,
      startedAt: null,
      lastUpdatedAt: null,
      error: undefined,
    },
    toasts: [],
  });
  useChatStore.setState({
    messages: [],
    pendingPlan: undefined,
    sending: false,
    error: undefined,
  });
};

describe("<DockChat /> hotkeys", () => {
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancelRaf = globalThis.cancelAnimationFrame;

  beforeEach(() => {
    ensureCrypto();
    resetStores();
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {
      // No-op stub keeps Vitest happy while DockChat schedules focus.
    }) as typeof globalThis.cancelAnimationFrame;
  });

  afterEach(() => {
    if (originalRaf) {
      globalThis.requestAnimationFrame = originalRaf;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (globalThis as { requestAnimationFrame?: typeof globalThis.requestAnimationFrame }).requestAnimationFrame;
    }
    if (originalCancelRaf) {
      globalThis.cancelAnimationFrame = originalCancelRaf;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (globalThis as { cancelAnimationFrame?: typeof globalThis.cancelAnimationFrame }).cancelAnimationFrame;
    }
    vi.clearAllMocks();
  });

  it("opens the dock and focuses the textarea when '/' is pressed", async () => {
    render(<DockChat />);
    const input = screen.getByPlaceholderText("Describe what you want to build...") as HTMLTextAreaElement;

    expect(useAppStore.getState().chatOpen).toBe(false);
    expect(document.activeElement).not.toBe(input);

    fireEvent.keyDown(window, { key: "/", code: "Slash" });

    await waitFor(() => {
      expect(useAppStore.getState().chatOpen).toBe(true);
      expect(document.activeElement).toBe(input);
    });
    await waitFor(() => expect(streamMock).toHaveBeenCalled());
  });

  it("re-focuses the textarea when '/' is pressed while the dock is already open", async () => {
    useAppStore.setState({ chatOpen: true });
    render(<DockChat />);
    const input = screen.getByPlaceholderText("Describe what you want to build...") as HTMLTextAreaElement;

    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });

    input.blur();
    expect(document.activeElement).not.toBe(input);

    fireEvent.keyDown(window, { key: "/", code: "Slash" });

    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
    await waitFor(() => expect(streamMock).toHaveBeenCalled());
  });
});
