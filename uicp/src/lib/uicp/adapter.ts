import type { Batch, Envelope, OperationParamMap } from "./schemas";
import { createFrameCoalescer, createId, sanitizeHtml } from "../utils";
import { enqueueBatch, clearAllQueues } from "./queue";
import { writeTextFile, BaseDirectory } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";

const coalescer = createFrameCoalescer();
// Derive options type from fetch so lint rules do not expect a RequestInit global at runtime.
type FetchRequestInit = NonNullable<Parameters<typeof fetch>[1]>;

type WindowLifecycleEvent =
  | { type: 'created'; id: string; title: string }
  | { type: 'updated'; id: string; title: string }
  | { type: 'destroyed'; id: string; title?: string };

const windowListeners = new Set<(event: WindowLifecycleEvent) => void>();

export const registerWindowLifecycle = (listener: (event: WindowLifecycleEvent) => void) => {
  windowListeners.add(listener);
  return () => windowListeners.delete(listener);
};

const emitWindowEvent = (event: WindowLifecycleEvent) => {
  for (const listener of windowListeners) {
    try {
      listener(event);
    } catch (error) {
      console.error('window lifecycle listener error', error);
    }
  }
};

type WindowRecord = {
  id: string;
  wrapper: HTMLElement;
  content: HTMLElement;
  titleText: HTMLElement;
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

// Track per-window drag cleanup so we can detach listeners on destroy.
const windowDragCleanup = new WeakMap<HTMLElement, () => void>();

let workspaceRoot: HTMLElement | null = null;

type CommandResult<T = unknown> =
  | { success: true; value: T }
  | { success: false; error: string };

const toFailure = (error: unknown): { success: false; error: string } => ({
  success: false,
  error: error instanceof Error ? error.message : String(error),
});

// Persist command to database for replay on restart
// Skip ephemeral operations that shouldn't be replayed
const persistCommand = async (command: Envelope): Promise<void> => {
  // Skip ephemeral operations
  const ephemeralOps = ['txn.cancel', 'state.get', 'state.watch', 'state.unwatch'];
  if (ephemeralOps.includes(command.op)) {
    return;
  }

  try {
    await invoke('persist_command', {
      cmd: {
        id: command.idempotencyKey ?? command.id ?? createId('cmd'),
        tool: command.op,
        args: command.params,
      },
    });
  } catch (error) {
    // Log but don't throw - persistence failures shouldn't break command execution
    console.error('Failed to persist command', command.op, error);
  }
};

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

// Shallow template evaluation for JSON command attributes
// Replaces string values like "{{value}}" or "{{form.field}}" using the event payload.
const evalTemplates = (input: unknown, ctx: Record<string, unknown>): unknown => {
  if (typeof input === 'string') {
    return input.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, path) => {
      const parts = String(path).split('.');
      let cur: unknown = ctx;
      for (const p of parts) {
        if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
          cur = (cur as Record<string, unknown>)[p];
        } else {
          return '';
        }
      }
      return cur == null ? '' : String(cur);
    });
  }
  if (Array.isArray(input)) return input.map((v) => evalTemplates(v, ctx));
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) out[k] = evalTemplates(v, ctx);
    return out;
  }
  return input;
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

  // Auto bind state updates when data-state-scope/key are present on inputs
  if ((event.type === 'input' || event.type === 'change') && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
    const scopeAttr = target.getAttribute('data-state-scope') as StateScope | null;
    const keyAttr = target.getAttribute('data-state-key');
    if (scopeAttr && keyAttr) {
      try {
        setStateValue({ scope: scopeAttr, key: keyAttr, value: target.value, windowId });
      } catch (err) {
        console.error('state.set from data-state-* failed', err);
      }
    }
  }

  // Execute data-command JSON on click/submit when present
  if (event.type === 'click' || event.type === 'submit') {
    let cmdHost: HTMLElement | null = target;
    let commandJson: string | null = null;
    while (cmdHost && cmdHost !== workspaceRoot) {
      commandJson = cmdHost.getAttribute('data-command');
      if (commandJson) break;
      cmdHost = cmdHost.parentElement;
    }
    if (commandJson) {
      try {
        const raw = JSON.parse(commandJson) as unknown;
        const evaluated = evalTemplates(raw, {
          ...payload,
          value: (target as HTMLInputElement | HTMLTextAreaElement).value,
          form: (payload.formData as Record<string, unknown> | undefined) ?? {},
        });
        const batch = Array.isArray(evaluated) ? (evaluated as Batch) : ((evaluated as { batch?: unknown })?.batch as Batch);
        if (batch && Array.isArray(batch) && batch.length > 0) {
          // Fire and forget; queue validates internally
          void enqueueBatch(batch);
        }
      } catch (err) {
        console.error('Failed to process data-command JSON', err);
      }
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
  clearAllQueues();
  if (workspaceRoot) {
    workspaceRoot.innerHTML = "";
  }
  // Clear persisted commands so they don't replay on next startup
  void invoke('clear_workspace_commands').catch((error) => {
    console.error('Failed to clear workspace commands', error);
  });
};

// Replay persisted commands from database to restore workspace state
export const replayWorkspace = async (): Promise<{ applied: number; errors: string[] }> => {
  try {
    const commands = await invoke<Array<{ id: string; tool: string; args: unknown }>>('get_workspace_commands');
    const errors: string[] = [];
    let applied = 0;

    for (const cmd of commands) {
      try {
        // Reconstruct envelope from persisted command
        const envelope: Envelope = {
          op: cmd.tool as Envelope['op'],
          params: cmd.args as OperationParamMap[Envelope['op']],
          idempotencyKey: cmd.id,
        };

        const result = applyCommand(envelope);
        if (result.success) {
          applied += 1;
        } else {
          errors.push(`${cmd.tool}: ${result.error}`);
        }
      } catch (error) {
        errors.push(`${cmd.tool}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return { applied, errors };
  } catch (error) {
    console.error('Failed to replay workspace', error);
    return { applied: 0, errors: [error instanceof Error ? error.message : String(error)] };
  }
};

// Allows shared teardown from commands and UI controls.
function destroyWindow(id: string) {
  const record = windows.get(id);
  if (!record) return;
  // Detach drag listeners if present
  try {
    const off = windowDragCleanup.get(record.wrapper);
    if (off) off();
    windowDragCleanup.delete(record.wrapper);
  } catch {
    // ignore
  }
  record.wrapper.remove();
  windows.delete(id);
  emitWindowEvent({ type: 'destroyed', id, title: record.titleText.textContent ?? id });

  // Delete persisted commands for this window so it doesn't reappear on restart
  void invoke('delete_window_commands', { windowId: id }).catch((error) => {
    console.error('Failed to delete window commands', id, error);
  });
}

export const listWorkspaceWindows = (): Array<{ id: string; title: string }> => {
  return Array.from(windows.values()).map((record) => ({
    id: record.id,
    title: record.titleText.textContent ?? record.id,
  }));
};

export const closeWorkspaceWindow = (id: string) => {
  destroyWindow(id);
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
      existing.titleText.textContent = params.title;
      emitWindowEvent({ type: 'updated', id, title: params.title });
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

    const chrome = document.createElement("div");
    chrome.className = "window-title flex items-center justify-between bg-white/70 px-4 py-3 text-sm font-semibold text-slate-700 backdrop-blur select-none cursor-grab";

    const titleText = document.createElement("span");
    titleText.className = "truncate";
    titleText.textContent = params.title;
    chrome.appendChild(titleText);

    const controls = document.createElement("div");
    controls.className = "ml-3 flex items-center gap-2";

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Close window");
    closeButton.textContent = "×";
    closeButton.className = "flex h-6 w-6 items-center justify-center rounded-full border border-slate-300 bg-white text-xs text-slate-500 transition hover:bg-slate-100 hover:text-slate-900";
    const stopPointerPropagation = (event: Event) => {
      event.stopPropagation();
    };
    closeButton.addEventListener('pointerdown', stopPointerPropagation);
    closeButton.addEventListener('pointerup', stopPointerPropagation);
    closeButton.addEventListener('mousedown', stopPointerPropagation);
    closeButton.addEventListener('mouseup', stopPointerPropagation);
    closeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      destroyWindow(id);
    });

    controls.appendChild(closeButton);
    chrome.appendChild(controls);

    const content = document.createElement("div");
    content.className = "window-content flex-1 overflow-auto bg-white/40 px-4 py-3 backdrop-blur";
    const rootNode = document.createElement("div");
    rootNode.id = "root";
    content.appendChild(rootNode);

    wrapper.appendChild(chrome);
    wrapper.appendChild(content);
    root.appendChild(wrapper);

    const record: WindowRecord = { id, wrapper, content, titleText };
    windows.set(id, record);
    applyWindowGeometry(record, params);
    emitWindowEvent({ type: 'created', id, title: params.title });

    // Install lightweight pointer-drag on the chrome to move the window
    let pointerId: number | null = null;
    let offsetX = 0;
    let offsetY = 0;
    let originX = 0;
    let originY = 0;
    let moved = false;

    const clamp = (value: number, max: number) => {
      if (Number.isNaN(value)) return 0;
      if (!Number.isFinite(max) || max <= 0) return 0;
      return Math.min(Math.max(0, value), max);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      pointerId = event.pointerId;
      const rect = wrapper.getBoundingClientRect();
      offsetX = event.clientX - rect.left;
      offsetY = event.clientY - rect.top;
      originX = event.clientX;
      originY = event.clientY;
      moved = false;
      chrome.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (pointerId === null || event.pointerId !== pointerId) return;
      const boundsWidth = wrapper.offsetWidth;
      const boundsHeight = wrapper.offsetHeight;
      const maxX = window.innerWidth - boundsWidth - 16;
      const maxY = window.innerHeight - boundsHeight - 16;
      const nextX = clamp(event.clientX - offsetX, maxX);
      const nextY = clamp(event.clientY - offsetY, maxY);

      if (!moved) {
        const dx = Math.abs(event.clientX - originX);
        const dy = Math.abs(event.clientY - originY);
        if (dx > 2 || dy > 2) moved = true;
      }
      if (!moved) {
        event.preventDefault();
        return;
      }
      wrapper.style.left = `${Math.round(nextX)}px`;
      wrapper.style.top = `${Math.round(nextY)}px`;
      originX = event.clientX;
      originY = event.clientY;
      event.preventDefault();
    };

    const endPointerTracking = (event: PointerEvent) => {
      if (pointerId === null || event.pointerId !== pointerId) return;
      pointerId = null;
      try {
        chrome.releasePointerCapture?.(event.pointerId);
      } catch {
        // ignore
      }
    };

    chrome.addEventListener('pointerdown', onPointerDown);
    chrome.addEventListener('pointermove', onPointerMove);
    chrome.addEventListener('pointerup', endPointerTracking);
    chrome.addEventListener('pointercancel', endPointerTracking);

    windowDragCleanup.set(wrapper, () => {
      chrome.removeEventListener('pointerdown', onPointerDown);
      chrome.removeEventListener('pointermove', onPointerMove);
      chrome.removeEventListener('pointerup', endPointerTracking);
      chrome.removeEventListener('pointercancel', endPointerTracking);
    });
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
        if (params.title) {
          record.titleText.textContent = params.title;
          emitWindowEvent({ type: 'updated', id: params.id, title: params.title });
        }
        applyWindowGeometry(record, params);
        return { success: true, value: params.id };
      } catch (error) {
        return toFailure(error);
      }
    }
    case "window.close": {
      try {
        const params = command.params as OperationParamMap["window.close"];
        destroyWindow(params.id);
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
        const url = params.url;
        // Tauri FS special-case
        if (url.startsWith('tauri://fs/writeTextFile')) {
          // Expect body: { path: string, contents: string, directory?: 'Desktop' | 'Document' | ... }
          const body = (params.body ?? {}) as Record<string, unknown>;
          const path = String(body.path ?? 'uicp.txt');
          const contents = String(body.contents ?? '');
          const dirToken = String(body.directory ?? 'Desktop');
          const dir = (BaseDirectory as unknown as Record<string, BaseDirectory>)[dirToken] ?? BaseDirectory.Desktop;
          void writeTextFile(path, contents, { baseDir: dir }).catch((err: unknown) => {
            console.error('tauri fs write failed', err);
          });
          return { success: true, value: params.idempotencyKey ?? command.id ?? createId('api') };
        }
        // UICP intent dispatch: hand off to app chat pipeline
        if (url.startsWith('uicp://intent')) {
          try {
            const body = (params.body ?? {}) as Record<string, unknown>;
            const text = typeof body.text === 'string' ? body.text : '';
            const meta = { windowId: (body.windowId as string | undefined) ?? command.windowId };
            if (text.trim()) {
              const evt = new CustomEvent('uicp-intent', { detail: { text, ...meta } });
              window.dispatchEvent(evt);
            }
          } catch (err) {
            console.error('uicp://intent dispatch failed', err);
          }
          return { success: true, value: params.idempotencyKey ?? command.id ?? createId('api') };
        }
        // Basic fetch for http(s)
        if (url.startsWith('http://') || url.startsWith('https://')) {
          const init: FetchRequestInit = { method: params.method ?? 'GET', headers: params.headers };
          if (params.body !== undefined) {
            init.body = typeof params.body === 'string' ? params.body : JSON.stringify(params.body);
            init.headers = { 'content-type': 'application/json', ...(params.headers ?? {}) };
          }
          void fetch(url, init).catch((err) => console.error('api.call fetch failed', err));
          return { success: true, value: params.idempotencyKey ?? command.id ?? createId('api') };
        }
        // Unknown scheme: treat as no-op success for now
        return { success: true, value: params.idempotencyKey ?? command.id ?? createId('api') };
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
        // Persist command for replay on restart (async, fire-and-forget)
        void persistCommand(command);
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
