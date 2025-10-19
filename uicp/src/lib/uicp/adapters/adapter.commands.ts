/**
 * Command Execution Table (v2)
 * 
 * WHY: Provides modular command dispatch table for v2 adapter.
 * INVARIANT: Each executor returns CommandResult for consistent error handling.
 * SAFETY: Permission checks enforced at adapter boundary before dispatch.
 */

import type { Envelope, OperationParamMap } from "./schemas";
import { routeApiCall } from "./adapter.api";
import type { StructuredClarifierBody } from "./adapter.clarifier";

export type CommandResult<T = unknown> =
  | { success: true; value: T }
  | { success: false; error: string };

export const toFailure = (error: unknown): { success: false; error: string } => ({
  success: false,
  error: error instanceof Error ? error.message : String(error),
});

export type ApplyContext = {
  runId?: string;
};

/**
 * Command executor registry for v2 adapter.
 * 
 * WHY: Exec-table pattern enables clean testing and modular command implementation.
 * INVARIANT: All executors receive full envelope + context, return CommandResult.
 * 
 * DESIGN NOTES:
 * - v1 adapter.lifecycle.ts will call into this table when ADAPTER_V2_ENABLED=true
 * - Each executor is independently testable
 * - Executors can be composed or replaced for different environments (test/prod)
 */
export interface CommandExecutor {
  /**
   * Execute a single command envelope.
   * 
   * @param command - Full command envelope
   * @param ctx - Apply context with runId
   * @param deps - Injectable dependencies (for testing)
   * @returns CommandResult with success/error
   */
  execute: (
    command: Envelope,
    ctx: ApplyContext,
    deps: CommandExecutorDeps,
  ) => Promise<CommandResult>;
}

/**
 * Injectable dependencies for command executors.
 * 
 * WHY: Allows v1 lifecycle to inject its existing implementations.
 * INVARIANT: All dependencies must remain backward compatible.
 */
export interface CommandExecutorDeps {
  // Window operations
  executeWindowCreate?: (params: OperationParamMap["window.create"]) => CommandResult<string>;
  executeWindowUpdate?: (params: OperationParamMap["window.update"], ensureExists: boolean) => Promise<CommandResult<string>>;
  destroyWindow?: (id: string) => void;
  ensureWindowExists?: (id: string, hint?: Partial<OperationParamMap["window.create"]>) => Promise<CommandResult<string>>;
  
  // DOM operations
  executeDomSet?: (params: OperationParamMap["dom.set"]) => CommandResult<string>;
  
  // Component operations
  executeComponentRender?: (params: OperationParamMap["component.render"]) => CommandResult<string>;
  updateComponent?: (params: OperationParamMap["component.update"]) => void;
  destroyComponent?: (params: OperationParamMap["component.destroy"]) => void;
  
  // State operations
  setStateValue?: (params: OperationParamMap["state.set"]) => void;
  getStateValue?: (params: OperationParamMap["state.get"]) => unknown;
  
  // API rendering
  renderStructuredClarifierForm?: (body: StructuredClarifierBody, command: Envelope) => CommandResult<string>;
  
  // Window registry
  windows?: Map<string, { id: string; wrapper: HTMLElement; content: HTMLElement; titleText: HTMLElement; styleSelector: string }>;
  
  // Component registry
  components?: Map<string, { id: string; element: HTMLElement }>;
}

/**
 * Creates command executor for api.call operations.
 */
const createApiCallExecutor = (): CommandExecutor => ({
  async execute(command: Envelope, ctx: ApplyContext, deps: CommandExecutorDeps): Promise<CommandResult> {
    const params = command.params as OperationParamMap["api.call"];
    if (!deps.renderStructuredClarifierForm) {
      return { success: false, error: 'renderStructuredClarifierForm dependency missing' };
    }
    return await routeApiCall(params, command, ctx, deps.renderStructuredClarifierForm);
  },
});

/**
 * Creates command executor for window.create operations.
 */
const createWindowCreateExecutor = (): CommandExecutor => ({
  async execute(command: Envelope, _ctx: ApplyContext, deps: CommandExecutorDeps): Promise<CommandResult> {
    if (!deps.executeWindowCreate) {
      return { success: false, error: 'executeWindowCreate dependency missing' };
    }
    const params = command.params as OperationParamMap["window.create"];
    return deps.executeWindowCreate(params);
  },
});

/**
 * Creates command executor for window.update operations.
 */
const createWindowUpdateExecutor = (): CommandExecutor => ({
  async execute(command: Envelope, _ctx: ApplyContext, deps: CommandExecutorDeps): Promise<CommandResult> {
    if (!deps.executeWindowUpdate) {
      return { success: false, error: 'executeWindowUpdate dependency missing' };
    }
    const params = command.params as OperationParamMap["window.update"];
    return await deps.executeWindowUpdate(params, true);
  },
});

/**
 * Creates command executor for window.close operations.
 */
const createWindowCloseExecutor = (): CommandExecutor => ({
  async execute(command: Envelope, _ctx: ApplyContext, deps: CommandExecutorDeps): Promise<CommandResult> {
    try {
      if (!deps.destroyWindow) {
        return { success: false, error: 'destroyWindow dependency missing' };
      }
      const params = command.params as OperationParamMap["window.close"];
      deps.destroyWindow(params.id);
      return { success: true, value: params.id };
    } catch (error) {
      return toFailure(error);
    }
  },
});

/**
 * Creates command executor for dom.set operations.
 */
const createDomSetExecutor = (): CommandExecutor => ({
  async execute(command: Envelope, _ctx: ApplyContext, deps: CommandExecutorDeps): Promise<CommandResult> {
    const params = command.params as OperationParamMap["dom.set"];
    if (!deps.windows?.has(params.windowId)) {
      if (!deps.ensureWindowExists) {
        return { success: false, error: 'ensureWindowExists dependency missing' };
      }
      const ensured = await deps.ensureWindowExists(params.windowId);
      if (!ensured.success) return ensured;
    }
    if (!deps.executeDomSet) {
      return { success: false, error: 'executeDomSet dependency missing' };
    }
    return deps.executeDomSet(params);
  },
});

/**
 * Creates command executor for dom.replace operations.
 */
const createDomReplaceExecutor = (): CommandExecutor => ({
  async execute(command: Envelope, _ctx: ApplyContext, deps: CommandExecutorDeps): Promise<CommandResult> {
    const params = command.params as OperationParamMap["dom.replace"];
    if (!deps.windows?.has(params.windowId)) {
      if (!deps.ensureWindowExists) {
        return { success: false, error: 'ensureWindowExists dependency missing' };
      }
      const ensured = await deps.ensureWindowExists(params.windowId);
      if (!ensured.success) return ensured;
    }
    if (!deps.executeDomSet) {
      return { success: false, error: 'executeDomSet dependency missing' };
    }
    return deps.executeDomSet({
      windowId: params.windowId,
      target: params.target,
      html: params.html,
      sanitize: params.sanitize,
    });
  },
});

/**
 * Creates command executor for dom.append operations.
 */
const createDomAppendExecutor = (): CommandExecutor => ({
  async execute(command: Envelope, _ctx: ApplyContext, deps: CommandExecutorDeps): Promise<CommandResult> {
    try {
      const params = command.params as OperationParamMap["dom.append"];
      let record = deps.windows?.get(params.windowId);
      if (!record) {
        if (!deps.ensureWindowExists) {
          return { success: false, error: 'ensureWindowExists dependency missing' };
        }
        const ensured = await deps.ensureWindowExists(params.windowId);
        if (!ensured.success) return ensured;
        record = deps.windows?.get(params.windowId);
        if (!record) {
          return { success: false, error: `Window ${params.windowId} not found after ensure` };
        }
      }
      const target = record.content.querySelector(params.target);
      if (!target) {
        return { success: false, error: `Target ${params.target} missing in window ${params.windowId}` };
      }
      // Import sanitizer at point of use to avoid circular deps
      const { sanitizeHtmlStrict } = await import("./adapter.security");
      const safeHtml = sanitizeHtmlStrict(String(params.html));
      target.insertAdjacentHTML("beforeend", safeHtml as unknown as string);
      return { success: true, value: params.windowId };
    } catch (error) {
      return toFailure(error);
    }
  },
});

/**
 * Creates command executor for component operations.
 */
const createComponentExecutors = () => ({
  render: {
    async execute(command: Envelope, _ctx: ApplyContext, deps: CommandExecutorDeps): Promise<CommandResult> {
      const params = command.params as OperationParamMap["component.render"];
      if (!deps.windows?.has(params.windowId)) {
        if (!deps.ensureWindowExists) {
          return { success: false, error: 'ensureWindowExists dependency missing' };
        }
        const ensured = await deps.ensureWindowExists(params.windowId);
        if (!ensured.success) return ensured;
      }
      if (!deps.executeComponentRender) {
        return { success: false, error: 'executeComponentRender dependency missing' };
      }
      return deps.executeComponentRender(params);
    },
  },
  update: {
    async execute(command: Envelope, _ctx: ApplyContext, deps: CommandExecutorDeps): Promise<CommandResult> {
      try {
        if (!deps.updateComponent) {
          return { success: false, error: 'updateComponent dependency missing' };
        }
        const params = command.params as OperationParamMap["component.update"];
        deps.updateComponent(params);
        return { success: true, value: params.id };
      } catch (error) {
        return toFailure(error);
      }
    },
  },
  destroy: {
    async execute(command: Envelope, _ctx: ApplyContext, deps: CommandExecutorDeps): Promise<CommandResult> {
      try {
        if (!deps.destroyComponent) {
          return { success: false, error: 'destroyComponent dependency missing' };
        }
        const params = command.params as OperationParamMap["component.destroy"];
        deps.destroyComponent(params);
        return { success: true, value: params.id };
      } catch (error) {
        return toFailure(error);
      }
    },
  },
});

/**
 * Creates command executor for state operations.
 */
const createStateExecutors = () => ({
  set: {
    async execute(command: Envelope, _ctx: ApplyContext, deps: CommandExecutorDeps): Promise<CommandResult> {
      try {
        if (!deps.setStateValue) {
          return { success: false, error: 'setStateValue dependency missing' };
        }
        const params = command.params as OperationParamMap["state.set"];
        deps.setStateValue(params);
        return { success: true, value: `${params.scope}:${params.key}` };
      } catch (error) {
        return toFailure(error);
      }
    },
  },
  get: {
    async execute(command: Envelope, _ctx: ApplyContext, deps: CommandExecutorDeps): Promise<CommandResult> {
      try {
        if (!deps.getStateValue) {
          return { success: false, error: 'getStateValue dependency missing' };
        }
        const params = command.params as OperationParamMap["state.get"];
        const value = deps.getStateValue(params);
        return { success: true, value };
      } catch (error) {
        return toFailure(error);
      }
    },
  },
});

/**
 * Creates command executor for txn.cancel operations.
 */
const createTxnCancelExecutor = (): CommandExecutor => ({
  async execute(command: Envelope, _ctx: ApplyContext, deps: CommandExecutorDeps): Promise<CommandResult> {
    try {
      const params = command.params as OperationParamMap["txn.cancel"];
      deps.components?.clear();
      return { success: true, value: params.id ?? "txn" };
    } catch (error) {
      return toFailure(error);
    }
  },
});

/**
 * Master command execution table.
 * 
 * WHY: Single dispatch table for all operations enables easy testing and composition.
 * INVARIANT: Table structure mirrors OperationParamMap keys.
 */
export const createCommandTable = () => {
  const componentExecutors = createComponentExecutors();
  const stateExecutors = createStateExecutors();
  
  return {
    "api.call": createApiCallExecutor(),
    "window.create": createWindowCreateExecutor(),
    "window.update": createWindowUpdateExecutor(),
    "window.close": createWindowCloseExecutor(),
    "dom.set": createDomSetExecutor(),
    "dom.replace": createDomReplaceExecutor(),
    "dom.append": createDomAppendExecutor(),
    "component.render": componentExecutors.render,
    "component.update": componentExecutors.update,
    "component.destroy": componentExecutors.destroy,
    "state.set": stateExecutors.set,
    "state.get": stateExecutors.get,
    "txn.cancel": createTxnCancelExecutor(),
  };
};

/**
 * Dispatches command to appropriate executor.
 * 
 * WHY: Central dispatch ensures consistent error handling and telemetry.
 * INVARIANT: Returns CommandResult; never throws.
 * 
 * @param command - Command envelope to execute
 * @param ctx - Apply context
 * @param deps - Injectable dependencies
 * @returns CommandResult
 */
export const dispatchCommand = async (
  command: Envelope,
  ctx: ApplyContext,
  deps: CommandExecutorDeps,
): Promise<CommandResult> => {
  const table = createCommandTable();
  const executor = table[command.op as keyof typeof table];
  
  if (!executor) {
    return { success: false, error: `Unsupported op ${command.op}` };
  }
  
  return await executor.execute(command, ctx, deps);
};
