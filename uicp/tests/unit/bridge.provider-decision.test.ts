import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initializeTauriBridge, teardownTauriBridge } from '../../src/lib/bridge/tauri';
import { useAppStore } from '../../src/state/app';

// Helper to access mocked tauri event API from vitest.setup.ts
function tauriMocks() {
  return (globalThis as Record<string, any>).__TAURI_MOCKS__ as {
    listenMock: ReturnType<typeof vi.fn> & { mockImplementation: any };
    invokeMock: ReturnType<typeof vi.fn>;
  };
}

describe('provider-decision bridge wiring', () => {
  beforeEach(() => {
    teardownTauriBridge();
    useAppStore.setState({ traceProviders: {}, traceEvents: {}, traceOrder: [], traceEventVersion: 0 });
  });

  it('stores provider by traceId when provider-decision arrives', async () => {
    const mocks = tauriMocks();
    const captured: Record<string, (event: { payload: unknown }) => void> = {};
    mocks.listenMock.mockImplementation(async (name: string, cb: (e: any) => void) => {
      captured[name] = cb;
      return () => {};
    });

    await initializeTauriBridge();

    const traceId = 'trace-123';
    const payload = { traceId, provider: 'wasm' };
    expect(typeof captured['provider-decision']).toBe('function');
    captured['provider-decision']({ payload });

    const provider = useAppStore.getState().traceProviders[traceId];
    expect(provider).toBe('wasm');
  });
});
