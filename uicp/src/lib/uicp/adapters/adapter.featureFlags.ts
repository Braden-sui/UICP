/**
 * Adapter v2 is now permanently enabled.
 * The legacy implementation has been removed, so this constant remains `true`.
 */
export const ADAPTER_V2_ENABLED = true;

/**
 * Returns the current adapter version for telemetry.
 * Legacy: 1
 * New modular: 2 (always active)
 */
export const getAdapterVersion = (): number => 2;
