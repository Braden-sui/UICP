import { readBooleanEnv } from '../../env/values';

/**
 * Feature flags for adapter refactor.
 * 
 * UICP_ADAPTER_V2: Enable the new modular adapter implementation.
 * Default: false (legacy path)
 * 
 * When enabled, the adapter uses a thin lifecycle orchestrator that delegates
 * to single-purpose modules (windowManager, domApplier, componentRenderer, etc.)
 * instead of the monolithic adapter.lifecycle.ts implementation.
 */
export const ADAPTER_V2_ENABLED = readBooleanEnv('UICP_ADAPTER_V2', false);

/**
 * Returns the current adapter version for telemetry.
 * Legacy: 1
 * New modular: 2
 */
export const getAdapterVersion = (): number => (ADAPTER_V2_ENABLED ? 2 : 1);
