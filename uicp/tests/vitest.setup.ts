// Extend Vitest expect with Testing Library matchers.
import "@testing-library/jest-dom/vitest";

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

// Provide a minimal Tauri bridge so modules importing @tauri-apps/api don't throw during tests.
if (typeof globalThis !== "undefined" && (globalThis as Record<string, unknown>).__TAURI__ === undefined) {
  (globalThis as Record<string, unknown>).__TAURI__ = {
    core: {
      invoke: async () => undefined,
    },
    event: {
      emit: async () => undefined,
      listen: async () => ({
        unlisten: () => undefined,
      }),
    },
  };
}
