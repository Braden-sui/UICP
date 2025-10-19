// Re-export from adapters folder for backward compatibility
export {
  // V2 lifecycle helpers
  registerWindowLifecycle,
  listWorkspaceWindows,
  closeWorkspaceWindow,
  clearWorkspaceRoot,
} from "./adapters/lifecycle";

export {
  // V1 workspace registration and utilities (bridged to V2)
  registerWorkspaceRoot,
  deferBatchIfNotReady,
  resetWorkspace,
  replayWorkspace,
  addWorkspaceResetHandler,
} from "./adapters/lifecycle";

// Keep exports aligned with adapters/adapter.ts
export { applyBatch } from "./adapters/adapter.queue";
export type { ApplyOutcome, ApplyOptions } from "./adapters/schemas";

export { buildComponentMarkupForTest } from "./adapters/adapter.testkit";
