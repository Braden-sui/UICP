// Verifies the dock reveal helpers collapse after blur and respect streaming lock.
import { renderHook, act } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { useDockReveal } from "../../src/hooks/useDockReveal";
import { useAppStore } from "../../src/state/app";

describe("useDockReveal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState({ chatOpen: false, streaming: false });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("collapses after blur when streaming has stopped", () => {
    const { result } = renderHook(() => useDockReveal(50));

    act(() => {
      result.current.onFocus();
      result.current.setChatOpen(true);
      result.current.onBlur();
      vi.runOnlyPendingTimers();
    });

    expect(useAppStore.getState().chatOpen).toBe(false);
  });

  it("stays open while streaming is true", () => {
    const { result } = renderHook(() => useDockReveal(50));

    act(() => {
      useAppStore.getState().setStreaming(true);
      result.current.onFocus();
      result.current.setChatOpen(true);
      result.current.onBlur();
      vi.runOnlyPendingTimers();
    });

    expect(useAppStore.getState().chatOpen).toBe(true);
    act(() => {
      useAppStore.getState().setStreaming(false);
    });
  });
});
