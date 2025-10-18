/**
 * Adapter Public API
 * 
 * WHY: This module provides a stable API surface while allowing implementation switching via feature flag.
 * INVARIANT: Both v1 (legacy) and v2 (modular) must maintain identical behavior and API surface.
 * 
 * Implementation Selection (controlled by UICP_ADAPTER_V2 env var):
 * - false (default): Legacy monolithic adapter.lifecycle.ts + adapter.queue.ts wrapper
 * - true: New modular lifecycle.ts orchestrator + specialized modules
 * 
 * WHY: v2 currently only implements core apply path (applyBatch + registerWorkspaceRoot).
 * Utility functions (lifecycle events, replay, list, etc.) still use v1 until PR 9+.
 * This is safe because utilities are not in the critical apply path.
 * 
 * NOTE: To enable v2, set environment variable UICP_ADAPTER_V2=1 at build time.
 */

// WHY: Import flag for conditional logic (not directly used in exports, but consumers can check it)
export { ADAPTER_V2_ENABLED, getAdapterVersion } from "./adapter.featureFlags";

// WHY: Always use v1 for utility functions (not yet migrated to v2)
// These are safe because they don't affect core batch application behavior
export {
  registerWindowLifecycle,
  registerUIEventCallback,
  deferBatchIfNotReady,
  resetWorkspace,
  replayWorkspace,
  listWorkspaceWindows,
  closeWorkspaceWindow,
  handleCommand,
  registerCommandHandler,
} from "./adapter.lifecycle";

// WHY: Export both v1 and v2 implementations separately so consumers can choose
// or test parity. Default export below uses flag to select.
export { registerWorkspaceRoot as registerWorkspaceRootV1 } from "./adapter.lifecycle";
export { registerWorkspaceRoot as registerWorkspaceRootV2 } from "./lifecycle";
export { applyBatch as applyBatchV1 } from "./adapter.queue";
export { applyBatch as applyBatchV2 } from "./lifecycle";

// WHY: Default exports use feature flag for automatic selection
// In PR 9, we'll flip the default from v1 to v2
import { ADAPTER_V2_ENABLED } from "./adapter.featureFlags";
import { registerWorkspaceRoot as rwV1 } from "./adapter.lifecycle";
import { registerWorkspaceRoot as rwV2, applyBatch as abV2 } from "./lifecycle";
import { applyBatch as abV1Queue } from "./adapter.queue";

// WHY: Runtime selection based on feature flag
// v1 uses adapter.queue wrapper, v2 uses direct lifecycle.ts orchestrator
export const registerWorkspaceRoot = ADAPTER_V2_ENABLED ? rwV2 : rwV1;
export const applyBatch = ADAPTER_V2_ENABLED ? abV2 : abV1Queue;

// WHY: Re-export types (same for both implementations)
export type { ApplyOutcome, ApplyOptions } from "./schemas";

// WHY: Test utilities (v1 only, not performance-critical)
export { buildComponentMarkupForTest } from "./adapter.testkit";
