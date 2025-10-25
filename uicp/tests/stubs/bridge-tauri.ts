// Minimal Tauri bridge stub for unit tests
// Provides the API surface used by modules while avoiding real Tauri imports.

export const hasTauriBridge = (): boolean => false;

export const tauriInvoke = async <T>(_command: string, _args?: unknown): Promise<T> => {
  throw new Error('tauriInvoke unavailable in unit tests');
};

export type Result<T> = { ok: true; value: T } | { ok: false; error: { code?: string; message?: string } };

export const inv = async <T>(_command: string, _args?: unknown): Promise<Result<T>> => {
  return { ok: false, error: { code: 'E-UICP-0100', message: 'Bridge unavailable (test stub)' } };
};

export const setInvOverride = (_impl: (<T>(command: string, args?: unknown) => Promise<Result<T>>) | null): void => {
  // no-op in tests
};

export const initializeTauriBridge = async (): Promise<void> => {
  // no-op for tests
};

export const openBrowserWindow = async (_url: string, _opts?: { label?: string; safe?: boolean }) => {
  return { ok: true, label: 'Test', url: _url, safe: !!_opts?.safe } as const;
};
