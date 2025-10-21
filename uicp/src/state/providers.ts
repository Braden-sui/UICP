import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

export type ProviderName = 'codex' | 'claude';
export type ProviderPreference = 'auto' | ProviderName;

type ProviderPhase = 'unknown' | 'connecting' | 'checking' | 'connected' | 'error';

export type ProviderStatus = {
  state: ProviderPhase;
  version?: string;
  detail?: string;
  updatedAt: number | null;
};

export type ProviderLoginPayload = {
  ok: boolean;
  detail?: string | null;
};

export type ProviderHealthPayload = {
  ok: boolean;
  version?: string | null;
  detail?: string | null;
};

type ProviderSettings = {
  defaultProvider: ProviderPreference;
  enableBoth: boolean;
};

type ProviderState = {
  settings: ProviderSettings;
  statuses: Record<ProviderName, ProviderStatus>;
  beginConnect: (provider: ProviderName) => void;
  completeConnect: (provider: ProviderName, payload: ProviderLoginPayload) => void;
  beginHealthCheck: (provider: ProviderName) => void;
  completeHealthCheck: (provider: ProviderName, payload: ProviderHealthPayload) => void;
  fail: (provider: ProviderName, detail: string) => void;
  setDefaultProvider: (preference: ProviderPreference) => void;
  setEnableBoth: (value: boolean) => void;
  resetStatus: (provider: ProviderName) => void;
  resetAll: () => void;
};

const defaultStatus = (): ProviderStatus => ({
  state: 'unknown',
  version: undefined,
  detail: undefined,
  updatedAt: null,
});

export const useProviderStore = create<ProviderState>()(
  persist(
    immer<ProviderState>((set) => ({
      settings: {
        defaultProvider: 'auto',
        enableBoth: true,
      },
      statuses: {
        codex: defaultStatus(),
        claude: defaultStatus(),
      },
      beginConnect: (provider) =>
        set((state) => {
          state.statuses[provider] = {
            state: 'connecting',
            version: undefined,
            detail: undefined,
            updatedAt: Date.now(),
          };
        }),
      completeConnect: (provider, payload) =>
        set((state) => {
          const status = state.statuses[provider];
          status.state = payload.ok ? 'connected' : 'error';
          status.detail = payload.detail ?? undefined;
          if (!payload.ok) {
            status.version = undefined;
          }
          status.updatedAt = Date.now();
        }),
      beginHealthCheck: (provider) =>
        set((state) => {
          const status = state.statuses[provider];
          status.state = 'checking';
          status.detail = undefined;
          status.version = undefined;
          status.updatedAt = Date.now();
        }),
      completeHealthCheck: (provider, payload) =>
        set((state) => {
          const status = state.statuses[provider];
          status.state = payload.ok ? 'connected' : 'error';
          status.version = payload.version ?? undefined;
          status.detail = payload.detail ?? undefined;
          status.updatedAt = Date.now();
        }),
      fail: (provider, detail) =>
        set((state) => {
          state.statuses[provider] = {
            state: 'error',
            version: undefined,
            detail,
            updatedAt: Date.now(),
          };
        }),
      setDefaultProvider: (preference) =>
        set((state) => {
          state.settings.defaultProvider = preference;
        }),
      setEnableBoth: (value) =>
        set((state) => {
          state.settings.enableBoth = value;
        }),
      resetStatus: (provider) =>
        set((state) => {
          state.statuses[provider] = defaultStatus();
        }),
      resetAll: () =>
        set((state) => {
          state.statuses.codex = defaultStatus();
          state.statuses.claude = defaultStatus();
        }),
    })),
    {
      name: 'uicp-provider-settings',
      partialize: (state) => ({
        settings: state.settings,
      }),
    },
  ),
);

export const useProviderSelector = <T>(selector: (state: ProviderState) => T): T =>
  useProviderStore(selector);

export const getProviderSettingsSnapshot = (): ProviderSettings =>
  useProviderStore.getState().settings;

export const getProviderStatusSnapshot = (provider: ProviderName): ProviderStatus =>
  useProviderStore.getState().statuses[provider];
