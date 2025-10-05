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

// Adapter mutates the isolated workspace DOM so commands remain pure data.
export const registerWorkspaceRoot = (element: HTMLElement) => {
  workspaceRoot = element;
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

const renderComponent = (params: OperationParamMap["component.render"]): ComponentRecord => {
  const id = params.id ?? createId("component");
  const hostWindow = windows.get(params.windowId);
  if (!hostWindow) throw new Error(`Unknown window ${params.windowId}`);
  const target = hostWindow.content.querySelector(params.target);
  if (!target) throw new Error(`Target ${params.target} missing in window ${params.windowId}`);

  const node = document.createElement("div");
  node.dataset.componentId = id;
  node.className = "component-block";

  if (params.type.toLowerCase().includes("form")) {
    node.innerHTML = '<form class="flex flex-col gap-2"><input class="rounded border border-slate-300 px-3 py-2" placeholder="Field" /><button type="submit" class="self-start rounded bg-slate-900 px-3 py-2 text-white">Submit</button></form>';
  } else if (params.type.toLowerCase().includes("table")) {
    node.innerHTML = '<div class="rounded border border-slate-200 bg-white/90 shadow-sm"><div class="border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold uppercase">Table</div><table class="w-full divide-y divide-slate-200 text-sm"><tbody><tr><td class="px-3 py-2">Sample row</td></tr></tbody></table></div>';
  } else if (params.type.toLowerCase().includes("modal")) {
    const title = typeof params.props === "object" && params.props && "title" in params.props ? String((params.props as Record<string, unknown>).title) : "Modal";
    node.innerHTML = `<div class="rounded-lg border border-slate-200 bg-white/95 p-4 shadow-lg"><h2 class="text-lg font-semibold">${title}</h2><p class="text-sm text-slate-600">Mock modal content.</p></div>`;
  } else {
    node.innerHTML = '<div class="rounded border border-dashed border-slate-300 p-4 text-sm text-slate-500">Component placeholder</div>';
  }

  target.appendChild(node);
  const record: ComponentRecord = { id, element: node };
  components.set(id, record);
  return record;
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

const applyCommand = (command: Envelope) => {
  switch (command.op) {
    case "window.create": {
      const root = ensureRoot();
      const params = command.params as OperationParamMap["window.create"];
      const id = params.id ?? createId("window");
      if (windows.has(id)) {
        const record = windows.get(id)!;
        applyWindowGeometry(record, params);
        record.title.textContent = params.title;
        return id;
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
      return id;
    }
    case "window.update": {
      const params = command.params as OperationParamMap["window.update"];
      const record = windows.get(params.id);
      if (!record) throw new Error(`Unknown window ${params.id}`);
      if (params.title) record.title.textContent = params.title;
      applyWindowGeometry(record, params);
      return params.id;
    }
    case "window.close": {
      const params = command.params as OperationParamMap["window.close"];
      const record = windows.get(params.id);
      if (!record) return params.id;
      record.wrapper.remove();
      windows.delete(params.id);
      return params.id;
    }
    case "dom.replace": {
      const params = command.params as OperationParamMap["dom.replace"];
      const record = windows.get(params.windowId);
      if (!record) throw new Error(`Unknown window ${params.windowId}`);
      const target = record.content.querySelector(params.target);
      if (!target) throw new Error(`Target ${params.target} missing in window ${params.windowId}`);
      target.innerHTML = sanitizeHtml(params.html);
      return params.windowId;
    }
    case "dom.append": {
      const params = command.params as OperationParamMap["dom.append"];
      const record = windows.get(params.windowId);
      if (!record) throw new Error(`Unknown window ${params.windowId}`);
      const target = record.content.querySelector(params.target);
      if (!target) throw new Error(`Target ${params.target} missing in window ${params.windowId}`);
      target.insertAdjacentHTML("beforeend", sanitizeHtml(params.html));
      return params.windowId;
    }
    case "component.render": {
      const params = command.params as OperationParamMap["component.render"];
      renderComponent(params);
      return params.windowId;
    }
    case "component.update": {
      const params = command.params as OperationParamMap["component.update"];
      updateComponent(params);
      return params.id;
    }
    case "component.destroy": {
      const params = command.params as OperationParamMap["component.destroy"];
      destroyComponent(params);
      return params.id;
    }
    case "state.set": {
      const params = command.params as OperationParamMap["state.set"];
      setStateValue(params);
      return params.key;
    }
    case "state.get": {
      const params = command.params as OperationParamMap["state.get"];
      return getStateValue(params);
    }
    case "state.watch":
    case "state.unwatch": {
      const params = command.params as OperationParamMap["state.watch"];
      return params.key;
    }
    case "api.call": {
      const params = command.params as OperationParamMap["api.call"];
      return params.idempotencyKey ?? command.id ?? createId("api");
    }
    case "txn.cancel": {
      const params = command.params as OperationParamMap["txn.cancel"];
      components.clear();
      return params.id ?? "txn";
    }
    default:
      throw new Error(`Unsupported op ${(command as Envelope).op}`);
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
      try {
        applyCommand(command);
        applied += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${command.op}: ${message}`);
      }
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
