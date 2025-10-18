/**
 * Adapter Public API (V2-only)
 * 
 * V2 modular adapter is permanently enabled. This module exposes the stable
 * public API while delegating implementation to v2 orchestrator and modules.
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

// Export workspace root from lifecycle that applyCommand uses
export { registerWorkspaceRoot } from "./adapter.lifecycle";

// Keep queue wrapper for apply semantics (idempotency, batching)
export { applyBatch } from "./adapter.queue";

// WHY: Re-export types (same for both implementations)
export type { ApplyOutcome, ApplyOptions } from "./schemas";

// WHY: Test utilities (v1 only, not performance-critical)
export { buildComponentMarkupForTest } from "./adapter.testkit";
