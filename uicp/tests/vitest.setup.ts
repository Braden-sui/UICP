// Extend Vitest expect with Testing Library matchers.
import "@testing-library/jest-dom/vitest";
import { beforeEach, vi } from "vitest";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class FakePointerEvent extends MouseEvent {
    public pointerId: number;
    public pointerType: string;

    constructor(type: string, options: PointerEventInit = {}) {
      super(type, options);
      this.pointerId = options.pointerId ?? 0;
      this.pointerType = options.pointerType ?? "mouse";
    }
  }
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    writable: true,
    value: FakePointerEvent as unknown as typeof PointerEvent,
  });
}

const tauriMocks = vi.hoisted(() => ({
  invokeMock: vi.fn(async () => undefined),
  listenMock: vi.fn(async () => () => undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriMocks.invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: tauriMocks.listenMock,
}));

(globalThis as Record<string, unknown>).__TAURI_MOCKS__ = tauriMocks;

beforeEach(() => {
  tauriMocks.invokeMock.mockClear();
  tauriMocks.listenMock.mockClear();
  if (typeof window !== "undefined") {
    // WHY: Tests run in jsdom where the Tauri bridge is absent; provide a minimal stub so runtime guards pass.
    (window as typeof window & {
      __TAURI__?: { core?: { invoke?: unknown } };
    }).__TAURI__ = { core: { invoke: tauriMocks.invokeMock } };

    const dynamicAttr = "data-uicp-dynamic-styles";
    if (!document.querySelector(`[${dynamicAttr}]`)) {
      const styleEl = document.createElement("style");
      styleEl.setAttribute(dynamicAttr, "");
      document.head.appendChild(styleEl);
    }
  }
});

// Note: We do not mock the tauri bridge module here; instead we mock @tauri-apps
// and provide window.__TAURI__ so hasTauriBridge() returns true during tests.
