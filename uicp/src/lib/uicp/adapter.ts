import type { Batch, Envelope, OperationParamMap } from "./schemas";
import { createFrameCoalescer, createId, sanitizeHtml } from "../utils";

const coalescer = createFrameCoalescer();

type WindowRecord = {
  id: string;
  wrapper: HTMLElement;
  content: HTMLElement;
  title: HTMLElement;
};

type ComponentRecord = {
  id: string;
  element: HTMLElement;
};

type StateScope = "window" | "workspace" | "global";

const windows = new Map<string, WindowRecord>();
const components = new Map<string, ComponentRecord>();
const stateStore = new Map<StateScope, Map<string, unknown>>([
  ["window", new Map()],
  ["workspace", new Map()],
  ["global", new Map()],
]);

let workspaceRoot: HTMLElement | null = null;

type CommandResult<T = unknown> =
  | { success: true; value: T }
  | { success: false; error: string };

const toFailure = (error: unknown): { success: false; error: string } => ({
  success: false,
  error: error instanceof Error ? error.message : String(error),
});

// Event delegation callback for UI events
type UIEventCallback = (event: Event, payload: Record<string, unknown>) => void;
let uiEventCallback: UIEventCallback | null = null;

// Adapter mutates the isolated workspace DOM so commands remain pure data.
export const registerWorkspaceRoot = (element: HTMLElement) => {
  workspaceRoot = element;

  // Set up event delegation at the root
  element.addEventListener('click', handleDelegatedEvent, true);
  element.addEventListener('input', handleDelegatedEvent, true);
  element.addEventListener('submit', handleDelegatedEvent, true);
  element.addEventListener('change', handleDelegatedEvent, true);
};

// Register callback for UI events
export const registerUIEventCallback = (callback: UIEventCallback) => {
  uiEventCallback = callback;
};

// Handle delegated events and emit ui_event
const handleDelegatedEvent = (event: Event) => {
  const target = event.target as HTMLElement;

  // Extract window and component IDs from the DOM hierarchy
  let windowId: string | undefined;
  let componentId: string | undefined;

  let current: HTMLElement | null = target;
  while (current && current !== workspaceRoot) {
    if (current.dataset.windowId) {
      windowId = current.dataset.windowId;
    }
    if (current.dataset.componentId) {
      componentId = current.dataset.componentId;
    }
    current = current.parentElement;
  }

  // Build event payload
  const payload: Record<string, unknown> = {
    type: event.type,
    windowId,
    componentId,
    targetTag: target.tagName.toLowerCase(),
  };

  // Add event-specific data
  if (event.type === 'input' || event.type === 'change') {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      payload.value = target.value;
      payload.name = target.name;
    }
  } else if (event.type === 'submit') {
    event.preventDefault(); // Prevent default form submission
    if (target instanceof HTMLFormElement) {
      const formData = new FormData(target);
      payload.formData = Object.fromEntries(formData.entries());
    }
  } else if (event.type === 'click') {
    if (target instanceof HTMLButtonElement) {
      payload.buttonText = target.textContent?.trim();
      payload.name = target.name;
    }
  }

  // Invoke callback if registered
  if (uiEventCallback) {
    uiEventCallback(event, payload);
  }
};

export const resetWorkspace = () => {
  windows.clear();
  components.clear();
  for (const scope of stateStore.values()) scope.clear();
  if (workspaceRoot) {
    workspaceRoot.innerHTML = "";
  }
};

const ensureRoot = () => {
  if (!workspaceRoot) {
    throw new Error("Workspace root not registered.");
  }
  return workspaceRoot;
};

const applyWindowGeometry = (
  record: WindowRecord,
  params: OperationParamMap["window.create"] | OperationParamMap["window.update"],
) => {
  const style = record.wrapper.style;
  if (params.x !== undefined) style.left = `${params.x}px`;
  if (params.y !== undefined) style.top = `${params.y}px`;
  if (params.width !== undefined) style.width = `${params.width}px`;
  if (params.height !== undefined) style.height = `${params.height}px`;
  if ("zIndex" in params && params.zIndex !== undefined) style.zIndex = String(params.zIndex);
};

// Core command executors emit structured success so the queue can surface rich errors without throwing.
const executeWindowCreate = (
  params: OperationParamMap["window.create"],
): CommandResult<string> => {
  try {
    const root = ensureRoot();
    const id = params.id ?? createId("window");
    const existing = windows.get(id);

    if (existing) {
      applyWindowGeometry(existing, params);
      existing.title.textContent = params.title;
      return { success: true, value: id };
    }

    const wrapper = document.createElement("div");
    wrapper.dataset.windowId = id;
    wrapper.className = "workspace-window pointer-events-auto";
    wrapper.style.position = "absolute";
    wrapper.style.backdropFilter = "blur(12px)";
    wrapper.style.background = "rgba(255,255,255,0.78)";
    wrapper.style.border = "1px solid rgba(15,23,42,0.08)";
    wrapper.style.borderRadius = "16px";
    wrapper.style.boxShadow = "0 18px 38px rgba(15,23,42,0.18)";
    wrapper.style.padding = "0";
    wrapper.style.display = "flex";
    wrapper.style.flexDirection = "column";
    wrapper.style.overflow = "hidden";

    const header = document.createElement("div");
    header.className = "window-title flex items-center justify-between bg-white/70 px-4 py-3 text-sm font-medium text-slate-700";
    header.textContent = params.title;

    const content = document.createElement("div");
    content.className = "window-content flex-1 overflow-auto bg-white/40 px-4 py-3 backdrop-blur";
    const rootNode = document.createElement("div");
    rootNode.id = "root";
    content.appendChild(rootNode);

    wrapper.appendChild(header);
    wrapper.appendChild(content);
    root.appendChild(wrapper);

    const record: WindowRecord = { id, wrapper, content, title: header };
    windows.set(id, record);
    applyWindowGeometry(record, params);
    return { success: true, value: id };
  } catch (error) {
    return toFailure(error);
  }
};

// Replaces the target node contents while re-sanitising as a last line of defence.
const executeDomSet = (params: OperationParamMap["dom.set"]): CommandResult<string> => {
  try {
    const record = windows.get(params.windowId);
    if (!record) {
      return { success: false, error: `Unknown window ${params.windowId}` };
    }
    const target = record.content.querySelector(params.target);
    if (!target) {
      return { success: false, error: `Target ${params.target} missing in window ${params.windowId}` };
    }
    target.innerHTML = sanitizeHtml(params.html);
    return { success: true, value: params.windowId };
  } catch (error) {
    return toFailure(error);
  }
};

// Produces a lightweight mock component shell so MOCK mode mirrors planner output.
const executeComponentRender = (
  params: OperationParamMap["component.render"],
): CommandResult<string> => {
  try {
    const id = params.id ?? createId("component");
    const hostWindow = windows.get(params.windowId);
    if (!hostWindow) {
      return { success: false, error: `Unknown window ${params.windowId}` };
    }
    const target = hostWindow.content.querySelector(params.target);
    if (!target) {
      return { success: false, error: `Target ${params.target} missing in window ${params.windowId}` };
    }

    const node = document.createElement("div");
    node.dataset.componentId = id;
    node.className = "component-block";
    node.innerHTML = buildComponentMarkup(params);

    target.appendChild(node);
    const record: ComponentRecord = { id, element: node };
    components.set(id, record);
    return { success: true, value: id };
  } catch (error) {
    return toFailure(error);
  }
};

const buildComponentMarkup = (params: OperationParamMap["component.render"]): string => {
  const type = params.type.toLowerCase();
  if (type.includes("form")) {
    return '<form class="flex flex-col gap-2"><input class="rounded border border-slate-300 px-3 py-2" placeholder="Field" /><button type="submit" class="self-start rounded bg-slate-900 px-3 py-2 text-white">Submit</button></form>';
  }
  if (type.includes("table")) {
    return '<div class="rounded border border-slate-200 bg-white/90 shadow-sm"><div class="border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase">Table</div><table class="w-full divide-y divide-slate-200 text-sm"><tbody><tr><td class="px-3 py-2">Sample row</td></tr></tbody></table></div>';
  }
  if (type.includes("modal")) {
    const title = typeof params.props === "object" && params.props && "title" in params.props
      ? String((params.props as Record<string, unknown>).title)
      : "Modal";
    return `<div class="rounded-lg border border-slate-200 bg-white/95 p-4 shadow-lg"><h2 class="text-lg font-semibold">${title}</h2><p class="text-sm text-slate-600">Mock modal content.</p></div>`;
  }
  return '<div class="rounded border border-dashed border-slate-300 p-4 text-sm text-slate-500">Component placeholder</div>';
};

const updateComponent = (params: OperationParamMap["component.update"]) => {
  const record = components.get(params.id);
  if (!record) throw new Error(`Component ${params.id} missing`);
  if (params.props && typeof params.props === "object") {
    record.element.setAttribute("data-props", JSON.stringify(params.props));
  }
};

const destroyComponent = (params: OperationParamMap["component.destroy"]) => {
  const record = components.get(params.id);
  if (!record) return;
  record.element.remove();
  components.delete(params.id);
};

const setStateValue = (params: OperationParamMap["state.set"]) => {
  const scopeStore = stateStore.get(params.scope);
  if (!scopeStore) return;
  const key = params.scope === "window" && params.windowId ? `${params.windowId}:${params.key}` : params.key;
  scopeStore.set(key, params.value);
};

const getStateValue = (params: OperationParamMap["state.get"]) => {
  const scopeStore = stateStore.get(params.scope);
  if (!scopeStore) return undefined;
  const key = params.scope === "window" && params.windowId ? `${params.windowId}:${params.key}` : params.key;
  return scopeStore.get(key);
};

const applyCommand = (command: Envelope): CommandResult => {
  switch (command.op) {
    case "window.create": {
      const params = command.params as OperationParamMap["window.create"];
      return executeWindowCreate(params);
    }
    case "dom.set": {
      const params = command.params as OperationParamMap["dom.set"];
      return executeDomSet(params);
    }
    case "window.update": {
      try {
        const params = command.params as OperationParamMap["window.update"];
        const record = windows.get(params.id);
        if (!record) {
          return { success: false, error: `Unknown window ${params.id}` };
        }
        if (params.title) record.title.textContent = params.title;
        applyWindowGeometry(record, params);
        return { success: true, value: params.id };
      } catch (error) {
        return toFailure(error);
      }
    }
    case "window.close": {
      try {
        const params = command.params as OperationParamMap["window.close"];
        const record = windows.get(params.id);
        if (!record) {
          return { success: true, value: params.id };
        }
        record.wrapper.remove();
        windows.delete(params.id);
        return { success: true, value: params.id };
      } catch (error) {
        return toFailure(error);
      }
    }
    case "dom.replace": {
      const params = command.params as OperationParamMap["dom.replace"];
      return executeDomSet({
        windowId: params.windowId,
        target: params.target,
        html: params.html,
        sanitize: params.sanitize,
      });
    }
    case "dom.append": {
      try {
        const params = command.params as OperationParamMap["dom.append"];
        const record = windows.get(params.windowId);
        if (!record) {
          return { success: false, error: `Unknown window ${params.windowId}` };
        }
        const target = record.content.querySelector(params.target);
        if (!target) {
          return { success: false, error: `Target ${params.target} missing in window ${params.windowId}` };
        }
        target.insertAdjacentHTML("beforeend", sanitizeHtml(params.html));
        return { success: true, value: params.windowId };
      } catch (error) {
        return toFailure(error);
      }
    }
    case "component.render": {
      const params = command.params as OperationParamMap["component.render"];
      return executeComponentRender(params);
    }
    case "component.update": {
      try {
        const params = command.params as OperationParamMap["component.update"];
        updateComponent(params);
        return { success: true, value: params.id };
      } catch (error) {
        return toFailure(error);
      }
    }
    case "component.destroy": {
      try {
        const params = command.params as OperationParamMap["component.destroy"];
        destroyComponent(params);
        return { success: true, value: params.id };
      } catch (error) {
        return toFailure(error);
      }
    }
    case "state.set": {
      try {
        const params = command.params as OperationParamMap["state.set"];
        setStateValue(params);
        return { success: true, value: params.key };
      } catch (error) {
        return toFailure(error);
      }
    }
    case "state.get": {
      try {
        const params = command.params as OperationParamMap["state.get"];
        return { success: true, value: getStateValue(params) };
      } catch (error) {
        return toFailure(error);
      }
    }
    case "state.watch":
    case "state.unwatch": {
      try {
        const params = command.params as OperationParamMap["state.watch"];
        return { success: true, value: params.key };
      } catch (error) {
        return toFailure(error);
      }
    }
    case "api.call": {
      try {
        const params = command.params as OperationParamMap["api.call"];
        return { success: true, value: params.idempotencyKey ?? command.id ?? createId("api") };
      } catch (error) {
        return toFailure(error);
      }
    }
    case "txn.cancel": {
      try {
        const params = command.params as OperationParamMap["txn.cancel"];
        components.clear();
        return { success: true, value: params.id ?? "txn" };
      } catch (error) {
        return toFailure(error);
      }
    }
    default:
      return { success: false, error: `Unsupported op ${(command as Envelope).op}` };
  }
};

export type ApplyOutcome = {
  success: boolean;
  applied: number;
  errors: string[];
};

export const applyBatch = async (batch: Batch): Promise<ApplyOutcome> => {
  const plannedJobs: Array<() => void> = [];
  const errors: string[] = [];
  let applied = 0;

  for (const command of batch) {
    plannedJobs.push(() => {
      const result = applyCommand(command);
      if (result.success) {
        applied += 1;
        return;
      }
      errors.push(`${command.op}: ${result.error}`);
    });
  }

  if (!plannedJobs.length) {
    return { success: true, applied: 0, errors: [] };
  }

  await new Promise<void>((resolve) => {
    coalescer.schedule(() => {
      for (const job of plannedJobs) job();
      resolve();
    });
  });

  return {
    success: errors.length === 0,
    applied,
    errors,
  };
};
