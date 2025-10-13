import type { JobSpec } from '../compute/types';

declare global {
  interface Window {
    __TAURI__?: unknown;
    __UICP_TEST_COMPUTE__?: (spec: JobSpec) => Promise<unknown>;
    __UICP_TEST_COMPUTE_CANCEL__?: (jobId: string) => void;
    __UICP_COMPUTE_STORE__?: typeof import('../state/compute')['useComputeStore'];
    __UICP_APP_STORE__?: typeof import('../state/app')['useAppStore'];
    __UICP_STATE_STORE__?: Map<'window' | 'workspace' | 'global', Map<string, unknown>>;
    uicpComputeCall?: (spec: JobSpec) => Promise<void>;
    uicpComputeCancel?: (jobId: string) => Promise<void>;
  }
}

export {};
