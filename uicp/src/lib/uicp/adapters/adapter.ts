/**
 * Adapter public API.
 * 
 * Feature flag UICP_ADAPTER_V2 controls which implementation is used:
 * - false (default): Legacy monolithic adapter.lifecycle.ts
 * - true: New modular implementation (lifecycle.ts orchestrator + specialized modules)
 * 
 * Both paths maintain identical behavior and API surface.
 */

// Re-export legacy implementation (will be replaced with v2 fork in subsequent PRs)
export {
  registerWindowLifecycle,
  registerWorkspaceRoot,
  registerUIEventCallback,
  deferBatchIfNotReady,
  resetWorkspace,
  replayWorkspace,
  listWorkspaceWindows,
  closeWorkspaceWindow,
} from "./adapter.lifecycle";

export { applyBatch } from "./adapter.queue";
export type { ApplyOutcome, ApplyOptions } from "./schemas";

export { buildComponentMarkupForTest } from "./adapter.testkit";

// Feature flag accessor (added in PR 0)
export { ADAPTER_V2_ENABLED, getAdapterVersion } from "./adapter.featureFlags";
