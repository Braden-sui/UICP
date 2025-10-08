import type { Mock } from "vitest";

type TauriMockBundle = {
  invokeMock: Mock;
  listenMock: Mock;
};

export const getTauriMocks = (): TauriMockBundle => {
  const bundle = (globalThis as Record<string, unknown>).__TAURI_MOCKS__ as TauriMockBundle | undefined;
  if (!bundle) {
    throw new Error("Tauri mocks have not been initialised. Ensure vitest.setup.ts is registered.");
  }
  return bundle;
};
