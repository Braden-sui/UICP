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

/**
 * Motion Animation System
 *
 * Feature flag for Motion-powered interactive animations.
 * When enabled, windows/panels/icons use Motion for presence animations,
 * spring physics, and micro-interactions instead of pure CSS.
 *
 * Default: true (enabled)
 *
 * Kill switch: Set motionEnabled to false in app state to revert to CSS-only animations.
 *
 * Note: Ambient background effects (gradients, orbs, particles) remain CSS-driven
 * for performance and are not affected by this flag.
 */
