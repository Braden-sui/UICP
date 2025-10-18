// Re-export from adapters folder for backward compatibility
export {
  registerWindowLifecycle,
  registerWorkspaceRoot,
  registerUIEventCallback,
  deferBatchIfNotReady,
  resetWorkspace,
  replayWorkspace,
  listWorkspaceWindows,
  closeWorkspaceWindow,
} from "./adapters/adapter.lifecycle";

export { applyBatch, type ApplyOutcome, type ApplyOptions } from "./adapters/adapter.queue";

export { buildComponentMarkupForTest } from "./adapters/adapter.testkit";
