/**
 * Adapter Public API (V2-only)
 * 
 * V2 modular adapter is permanently enabled. This module exposes the stable
 * public API while delegating implementation to v2 orchestrator and modules.
 */

// WHY: Import flag for conditional logic (not directly used in exports, but consumers can check it)
export { ADAPTER_V2_ENABLED, getAdapterVersion } from "./adapter.featureFlags";

// V2 lifecycle helpers (window management)
export {
  registerWindowLifecycle,
  listWorkspaceWindows,
  closeWorkspaceWindow,
  clearWorkspaceRoot,
} from "./lifecycle";

// Event delegation and command routing
export {
  registerUIEventCallback,
  handleCommand,
  registerCommandHandler,
} from "./adapter.events";

// V2 workspace management (includes event delegation, reset handlers, replay)
export {
  registerWorkspaceRoot,
  deferBatchIfNotReady,
  resetWorkspace,
  replayWorkspace,
  addWorkspaceResetHandler,
} from "./lifecycle";

// Keep queue wrapper for apply semantics (idempotency, batching)
export { applyBatch } from "./adapter.queue";

// WHY: Re-export types (same for both implementations)
export type { ApplyOutcome, ApplyOptions } from "./schemas";

// WHY: Re-export persistence functions (used by adapter.queue)
export { persistCommand, recordStateCheckpoint } from "./adapter.persistence";
