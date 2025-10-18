import { type Batch, type Envelope, type OperationParamMap } from "./schemas";
import { createFrameCoalescer, createId } from "../../utils";
import { enqueueBatch, clearAllQueues } from "./queue";
import { hasTauriBridge, tauriInvoke } from "../../bridge/tauri";
// Removed: tryRecoverJsonFromAttribute - strict JSON parsing only
import { getBridgeWindow, getComputeBridge } from "../../bridge/globals";
import { checkPermission, sanitizeHtmlStrict, escapeHtml } from "./adapter.security";
import { safeWrite, BaseDirectory } from "./adapter.fs";
import { emitTelemetryEvent } from "../../telemetry";
import {
  applyDynamicStyleRule,
  removeDynamicStyleRule,
  escapeForSelector,
  type DynamicStyleDeclarations,
} from "../../css/dynamicStyles";
import type { ApplyOutcome } from "./schemas";
import type { JobSpec } from "../../../compute/types";

const coalescer = createFrameCoalescer();

export const runJobsInFrame = (jobs: Array<() => Promise<void>>): Promise<void> => {
  if (jobs.length === 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    coalescer.schedule(() => {
      (async () => {
        for (const job of jobs) {
          await job();
        }
        resolve();
      })().catch(reject);
    });
  });
};
// Derive options type from fetch so lint rules do not expect a RequestInit global at runtime.
type FetchRequestInit = NonNullable<Parameters<typeof fetch>[1]>;

const ALLOWED_BASE_DIRECTORIES: Record<string, BaseDirectory> = {
  AppConfig: BaseDirectory.AppConfig,
  AppData: BaseDirectory.AppData,
  AppLocalData: BaseDirectory.AppLocalData,
  Document: BaseDirectory.Document,
  Desktop: BaseDirectory.Desktop,
  Download: BaseDirectory.Download,
};

const DEFAULT_EXPORT_DIRECTORY = BaseDirectory.AppData;
const ALLOWED_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PATCH']);

// Safety caps for data-command attributes
const MAX_DATA_COMMAND_LEN = 32768; // 32KB serialized JSON
const MAX_TEMPLATE_TOKENS = 16; // maximum {{token}} substitutions per element

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
  const errors: Array<{ listener: number; error: unknown }> = [];
  let index = 0;
  for (const listener of windowListeners) {
    try {
      listener(event);
    } catch (error) {
      errors.push({ listener: index, error });
    }
    index++;
  }
  if (errors.length > 0) {
    const details = errors.map(e => `listener ${e.listener}: ${e.error instanceof Error ? e.error.message : String(e.error)}`).join('; ');
    throw new Error(`Window lifecycle event failed for ${event.type}: ${details}`);
  }
};

type WindowRecord = {
  id: string;
  wrapper: HTMLElement;
  content: HTMLElement;
  titleText: HTMLElement;
  styleSelector: string;
};

// Deterministic stringify (sorted object keys; preserves array order) for stable op-hash.
const stableStringify = (input: unknown): string => {
  const seen = new WeakSet<object>();
  const walk = (value: unknown): unknown => {
    if (value === null) return null;
    const t = typeof value;
    if (t === 'undefined' || t === 'function' || t === 'symbol') return null;
    if (t !== 'object') return value;
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return null;
    seen.add(obj);
    if (Array.isArray(obj)) {
      return obj.map((v) => walk(v));
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = walk(obj[key]);
    }
    return out;
  };
  // Strict: fail fast on unstringifiable input instead of silently degrading
  return JSON.stringify(walk(input));
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

export const recordStateCheckpoint = async (): Promise<void> => {
  try {
    const stable = (obj: unknown): string => {
      if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
      if (Array.isArray(obj)) return `[${obj.map(stable).join(",")}]`;
      const o = obj as Record<string, unknown>;
      const keys = Object.keys(o).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
    };
    const snapshot = {
      window: Object.fromEntries(stateStore.get("window")!),
      workspace: Object.fromEntries(stateStore.get("workspace")!),
      global: Object.fromEntries(stateStore.get("global")!),
    };
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(snapshot)));
    const hex = Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (hasTauriBridge()) {
      await tauriInvoke("save_checkpoint", { hash: hex });
    }
  } catch (err) {
    console.error("recordStateCheckpoint failed", err);
  }
};

const bridgeWindow = getBridgeWindow();
if (bridgeWindow && !bridgeWindow.__UICP_STATE_STORE__) {
  Object.defineProperty(bridgeWindow, "__UICP_STATE_STORE__", {
    value: stateStore,
    configurable: true,
    writable: false,
  });
}

// Track per-window drag cleanup so we can detach listeners on destroy.
const windowDragCleanup = new WeakMap<HTMLElement, () => void>();

let workspaceRoot: HTMLElement | null = null;
// Guard against race: bridge may enqueue batches before Desktop.tsx registers the root.
let workspaceReady = false;
type PendingBatchEntry = { batch: Batch; resolve: (outcome: ApplyOutcome) => void; reject: (error: unknown) => void };
const pendingBatches: PendingBatchEntry[] = [];
const resetHandlers = new Set<() => void>();

export const addWorkspaceResetHandler = (handler: () => void): (() => void) => {
  resetHandlers.add(handler);
  return () => resetHandlers.delete(handler);
};

const REPLAY_PROGRESS_EVENT = 'workspace-replay-progress';
const REPLAY_COMPLETE_EVENT = 'workspace-replay-complete';
const REPLAY_BATCH_SIZE = 20;

type ReplayProgressDetail = {
  total: number;
  processed: number;
  applied: number;
  errors: number;
  done?: boolean;
};

const emitReplayProgress = (detail: ReplayProgressDetail) => {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new CustomEvent(REPLAY_PROGRESS_EVENT, { detail }));
  if (detail.done) {
    window.dispatchEvent(new CustomEvent(REPLAY_COMPLETE_EVENT, { detail }));
  }
};

const yieldReplay = () =>
  new Promise<void>((resolve) => {
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => resolve(), { timeout: 32 });
      return;
    }
    setTimeout(resolve, 16);
  });

type CommandResult<T = unknown> =
  | { success: true; value: T }
  | { success: false; error: string };

const toFailure = (error: unknown): { success: false; error: string } => ({
  success: false,
  error: error instanceof Error ? error.message : String(error),
});

export type ApplyContext = {
  runId?: string;
};

// Persist command to database for replay on restart
// Skip ephemeral operations that shouldn't be replayed
export const persistCommand = async (command: Envelope): Promise<void> => {
  // Skip ephemeral operations
  const ephemeralOps = ['txn.cancel', 'state.get', 'state.watch', 'state.unwatch'];
  if (ephemeralOps.includes(command.op)) {
    return;
  }
  if (command.op === 'api.call') {
    const params = command.params;
    if (typeof params?.url === 'string' && params.url.startsWith('uicp://intent')) {
      return;
    }
  }

  if (!hasTauriBridge()) {
    if (import.meta.env.DEV) {
      console.info('[adapter] skipping persist_command; tauri bridge unavailable');
    }
    return;
  }
  try {
    await tauriInvoke('persist_command', {
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

type StructuredClarifierOption = {
  label?: string;
  value: string;
};

type StructuredClarifierFieldSpec = {
  name?: string;
  label?: string;
  placeholder?: string;
  description?: string;
  type?: string;
  options?: StructuredClarifierOption[];
  multiline?: boolean;
  required?: boolean;
  defaultValue?: string;
};

type StructuredClarifierBody = {
  title?: string;
  textPrompt?: string;
  description?: string;
  submit?: string;
  cancel?: string | false;
  windowId?: string;
  width?: number;
  height?: number;
  fields?: StructuredClarifierFieldSpec[];
  label?: string;
  placeholder?: string;
  multiline?: boolean;
};

type NormalizedClarifierField = {
  name: string;
  label: string;
  placeholder?: string;
  description?: string;
  type: 'text' | 'textarea' | 'select';
  options?: Array<{ label: string; value: string }>;
  required: boolean;
  defaultValue?: string;
};

const isStructuredClarifierBody = (input: Record<string, unknown>): input is StructuredClarifierBody => {
  if (typeof input !== 'object' || input === null) return false;
  if (typeof (input as { text?: unknown }).text === 'string') return false;
  if (typeof (input as { textPrompt?: unknown }).textPrompt === 'string' && (input as { textPrompt: string }).textPrompt.trim()) {
    return true;
  }
  if (Array.isArray((input as { fields?: unknown }).fields) && (input as { fields: unknown[] }).fields.length > 0) {
    return true;
  }
  if (typeof (input as { placeholder?: unknown }).placeholder === 'string') return true;
  if (typeof (input as { label?: unknown }).label === 'string') return true;
  return false;
};

const normalizeClarifierFields = (body: StructuredClarifierBody): NormalizedClarifierField[] => {
  const candidates = Array.isArray(body.fields) ? body.fields : undefined;
  const fallbackField: StructuredClarifierFieldSpec = {
    name: 'answer',
    label: typeof body.label === 'string' && body.label.trim() ? body.label.trim() : 'Answer',
    placeholder: typeof body.placeholder === 'string' ? body.placeholder : undefined,
    multiline: Boolean(body.multiline),
  };
  const source = candidates && candidates.length > 0 ? candidates : [fallbackField];
  return source
    .map((field, index) => {
      const name = typeof field?.name === 'string' && field.name.trim() ? field.name.trim() : `field_${index + 1}`;
      const label = typeof field?.label === 'string' && field.label.trim() ? field.label.trim() : name;
      const placeholder = typeof field?.placeholder === 'string' ? field.placeholder : undefined;
      const description = typeof field?.description === 'string' ? field.description : undefined;
      const required = field?.required === undefined ? true : Boolean(field.required);
      const defaultValue = typeof field?.defaultValue === 'string' ? field.defaultValue : undefined;
      const options = Array.isArray(field?.options)
        ? field.options
            .map((option) => {
              if (!option) return null;
              const value = typeof option.value === 'string' ? option.value : undefined;
              if (!value) return null;
              const optionLabel = typeof option.label === 'string' && option.label.trim() ? option.label : value;
              return { label: optionLabel, value };
            })
            .filter((option): option is { label: string; value: string } => Boolean(option))
        : undefined;
      const inferredType = typeof field?.type === 'string' ? field.type.toLowerCase() : undefined;
      let type: 'text' | 'textarea' | 'select' = 'text';
      if (inferredType === 'textarea' || field?.multiline) {
        type = 'textarea';
      } else if (inferredType === 'select' && options && options.length) {
        type = 'select';
      }
      return {
        name,
        label,
        placeholder,
        description,
        type,
        options: type === 'select' ? options : undefined,
        required,
        defaultValue,
      };
    })
    .filter((field) => field != null);
};

const renderStructuredClarifierForm = (body: StructuredClarifierBody, command: Envelope): CommandResult<string> => {
  try {
    const fields = normalizeClarifierFields(body);
    if (fields.length === 0) {
      return { success: false, error: 'Clarifier fields missing' };
    }
    const prompt = typeof body.textPrompt === 'string' && body.textPrompt.trim()
      ? body.textPrompt.trim()
      : 'Please provide additional detail.';
    const bodyWindowId =
      typeof body.windowId === 'string' && body.windowId.trim().length ? body.windowId.trim() : undefined;
    const commandWindowId =
      typeof command.windowId === 'string' && command.windowId.trim().length ? command.windowId.trim() : undefined;
    const windowId = bodyWindowId ?? commandWindowId ?? createId('clarify');
    const title =
      (typeof body.title === 'string' && body.title.trim()) || `Clarify`;
    const width = typeof body.width === 'number' && body.width >= 320 ? body.width : 520;
    const height = typeof body.height === 'number' && body.height >= 200 ? body.height : 280;
    const createResult = executeWindowCreate({ id: windowId, title, width, height });
    if (!createResult.success) {
      return createResult;
    }
    const record = windows.get(windowId);
    if (!record) {
      return { success: false, error: `Window ${windowId} not registered` };
    }
    const root = record.content.querySelector('#root');
    if (!root) {
      return { success: false, error: `Root container missing for ${windowId}` };
    }
    // WHY: innerHTML='' is safe for clearing (no injection risk); only assignment of external data is dangerous.
    // INVARIANT: Subsequent content is built via DOM APIs (createElement, textContent) to avoid XSS.
    root.innerHTML = '';
    const form = document.createElement('form');
    form.className = 'flex flex-col gap-3 p-4';
    form.setAttribute('data-structured-clarifier', 'true');

    const question = document.createElement('p');
    question.className = 'text-sm text-slate-700';
    question.textContent = prompt;
    form.appendChild(question);

    if (typeof body.description === 'string' && body.description.trim()) {
      const description = document.createElement('p');
      description.className = 'text-xs text-slate-500';
      description.textContent = body.description.trim();
      form.appendChild(description);
    }

    fields.forEach((field, index) => {
      const wrapper = document.createElement('label');
      wrapper.className = 'flex flex-col gap-1 text-sm text-slate-600';

      const fieldLabel = document.createElement('span');
      fieldLabel.className = 'font-semibold text-slate-700';
      fieldLabel.textContent = field.label;
      wrapper.appendChild(fieldLabel);

      let control;
      if (field.type === 'textarea') {
        const textarea = document.createElement('textarea');
        textarea.name = field.name;
        textarea.rows = 4;
        textarea.className = 'rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-400';
        if (field.placeholder) textarea.placeholder = field.placeholder;
        if (field.required) textarea.required = true;
        if (field.defaultValue) textarea.value = field.defaultValue;
        control = textarea;
      } else if (field.type === 'select') {
        const select = document.createElement('select');
        select.name = field.name;
        select.className = 'rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-400';
        if (field.required) select.required = true;
        if (field.options) {
          field.options.forEach((option) => {
            const opt = document.createElement('option');
            opt.value = option.value;
            opt.textContent = option.label;
            if (field.defaultValue && field.defaultValue === option.value) {
              opt.selected = true;
            }
            select.appendChild(opt);
          });
        }
        control = select;
      } else {
        const input = document.createElement('input');
        input.name = field.name;
        input.type = 'text';
        input.className = 'rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-400';
        if (field.placeholder) input.placeholder = field.placeholder;
        if (field.required) input.required = true;
        if (field.defaultValue) input.value = field.defaultValue;
        control = input;
      }
      control.setAttribute('aria-label', field.label);
      wrapper.appendChild(control);

      if (field.description) {
        const help = document.createElement('span');
        help.className = 'text-xs text-slate-500';
        help.textContent = field.description;
        wrapper.appendChild(help);
      }

      form.appendChild(wrapper);

      if (index === 0) {
        queueMicrotask(() => {
          (control as HTMLElement).focus();
        });
      }
    });

    const controls = document.createElement('div');
    controls.className = 'mt-1 flex items-center gap-2';

    const statusId = `${windowId}-clarifier-status`;

    const textTemplate = fields
      .map((field) => `${field.label}: {{form.${field.name}}}`)
      .join('\n')
      .trim();

    const commandPayload = {
      question: prompt,
      windowId,
      text: textTemplate || `{{form.${fields[0]?.name}}}`,
      fields: fields.map((field) => ({
        name: field.name,
        label: field.label,
        value: `{{form.${field.name}}}`,
      })),
    };

    const submitButton = document.createElement('button');
    submitButton.type = 'submit';
    submitButton.className = 'rounded bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700';
    submitButton.textContent = typeof body.submit === 'string' && body.submit.trim() ? body.submit.trim() : 'Continue';

    const submitCommands: Batch = [
      {
        op: 'api.call',
        params: {
          method: 'POST',
          url: 'uicp://intent',
          body: commandPayload,
        },
      },
      {
        op: 'dom.set',
        params: {
          windowId,
          target: `#${statusId}`,
          html: '<span class="text-xs text-slate-500">Processing...</span>',
        },
      },
      {
        op: 'window.close',
        params: { id: windowId },
      },
    ];
    submitButton.setAttribute('data-command', JSON.stringify(submitCommands));
    controls.appendChild(submitButton);

    if (body.cancel !== false) {
      const cancelButton = document.createElement('button');
      cancelButton.type = 'button';
      cancelButton.className = 'rounded border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-100';
      cancelButton.textContent =
        typeof body.cancel === 'string' && body.cancel.trim() ? body.cancel.trim() : 'Cancel';
      const cancelCommands: Batch = [
        {
          op: 'window.close',
          params: { id: windowId },
        },
      ];
      cancelButton.setAttribute('data-command', JSON.stringify(cancelCommands));
      controls.appendChild(cancelButton);
    }

    form.appendChild(controls);

    const status = document.createElement('div');
    status.id = statusId;
    status.className = 'text-xs text-slate-500';
    status.setAttribute('aria-live', 'polite');
    form.appendChild(status);

    root.appendChild(form);

    return { success: true, value: windowId };
  } catch (error) {
    return toFailure(error);
  }
};

// Event delegation callback for UI events
type UIEventCallback = (event: Event, payload: Record<string, unknown>) => void;
let uiEventCallback: UIEventCallback | null = null;

/**
 * Guard to defer batch application until workspace root is registered.
 * Returns a Promise if the batch is queued, otherwise returns null to signal immediate processing.
 * 
 * CONTEXT: initializeTauriBridge() runs before Desktop.tsx mounts, so streaming/compute events
 * may call enqueueBatch() before registerWorkspaceRoot() is called. This prevents the
 * "Workspace root not registered" error.
 */
export const deferBatchIfNotReady = (batch: Batch): Promise<ApplyOutcome> | null => {
  if (workspaceReady) return null; // Workspace is ready, proceed normally
  
  console.debug(`[adapter] workspace not ready, queuing batch with ${batch.length} op(s)`);
  return new Promise((resolve, reject) => {
    pendingBatches.push({ batch, resolve, reject });
  });
};

// Adapter mutates the isolated workspace DOM so commands remain pure data.
export const registerWorkspaceRoot = (element: HTMLElement) => {
  workspaceRoot = element;
  workspaceReady = true;

  // Set up event delegation at the root
  element.addEventListener('click', handleDelegatedEvent, true);
  element.addEventListener('input', handleDelegatedEvent, true);
  element.addEventListener('submit', handleDelegatedEvent, true);
  element.addEventListener('change', handleDelegatedEvent, true);

  // Process any batches that arrived before workspace was ready
  if (pendingBatches.length > 0) {
    console.debug(`[adapter] flushing ${pendingBatches.length} pending batch(es)`);
    const toProcess = pendingBatches.splice(0); // Drain the queue
    for (const entry of toProcess) {
      enqueueBatch(entry.batch)
        .then(entry.resolve)
        .catch(entry.reject);
    }
  }
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
    event: {
      target: {
        id: target.id || '',
        dataset: { ...target.dataset },
      },
    },
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
      // WHY: Hard fail on malformed or empty data-command payloads so UI inconsistencies never go unnoticed.
      // INVARIANT: Every data-command must parse into a non-empty Batch; template evaluation cannot silently drop commands.
      if (commandJson.length > MAX_DATA_COMMAND_LEN) {
        throw new Error(`E-UICP-300: data-command exceeds size cap: ${commandJson.length} > ${MAX_DATA_COMMAND_LEN}`);
      }
      try {
        const tokenMatches = commandJson.match(/\{\{\s*[^}]+\s*\}\}/g);
        const tokenCount = tokenMatches ? tokenMatches.length : 0;
        if (tokenCount > MAX_TEMPLATE_TOKENS) {
          throw new Error(`E-UICP-300: data-command contains too many template tokens: ${tokenCount} > ${MAX_TEMPLATE_TOKENS}`);
        }
        const raw = JSON.parse(commandJson) as unknown;
        const evaluated = evalTemplates(raw, {
          ...payload,
          value: (target as HTMLInputElement | HTMLTextAreaElement).value,
          form: (payload.formData as Record<string, unknown> | undefined) ?? {},
        });
        const batchCandidate = Array.isArray(evaluated)
          ? (evaluated as Batch)
          : ((evaluated as { batch?: unknown })?.batch as Batch | undefined);
        if (!batchCandidate || !Array.isArray(batchCandidate) || batchCandidate.length === 0) {
          throw new Error('E-UICP-301: data-command evaluated to an empty or invalid batch');
        }
        void enqueueBatch(batchCandidate);
      } catch (err) {
        const original = err instanceof Error ? err : new Error(String(err));
        console.error('E-UICP-301: failed to process data-command JSON', original);
        throw new Error(`E-UICP-301: data-command parsing failed — ${original.message}`, {
          cause: original,
        });
      }
    }
  }

  // Invoke callback if registered
  if (uiEventCallback) {
    uiEventCallback(event, payload);
  }
};

export const resetWorkspace = (options?: { deleteFiles?: boolean }) => {
  windows.clear();
  components.clear();
  for (const scope of stateStore.values()) scope.clear();
  clearAllQueues();
  for (const handler of resetHandlers) {
    try {
      handler();
    } catch (error) {
      console.error('workspace reset handler failed', error);
    }
  }
  if (workspaceRoot) {
    // WHY: innerHTML='' clears all children atomically without parsing HTML.
    // INVARIANT: Safe clearing only; no dynamic content assignment.
    workspaceRoot.innerHTML = "";
  }
  if (hasTauriBridge()) {
    // Clear persisted commands so they don't replay on next startup
    void tauriInvoke('clear_workspace_commands').catch((error) => {
      console.error('Failed to clear workspace commands', error);
    });
    // Clear compute cache entries for this workspace
    void tauriInvoke('clear_compute_cache', { workspace_id: 'default' }).catch((error) => {
      console.error('Failed to clear compute cache', error);
    });
  }
  if (options?.deleteFiles) {
    // Intentionally not implemented in v1 to avoid accidental deletion.
    console.warn('deleteFiles=true requested, but deletion of ws:/files is not implemented in v1.');
  }
};

// Replay persisted commands from database to restore workspace state
export const replayWorkspace = async (): Promise<{ applied: number; errors: string[] }> => {
  // WHY: Allow replay under Vitest where __TAURI__ is absent but mocks are installed.
  // INVARIANT: Proceed when either Tauri is present or test mocks are registered; otherwise, no-op.
  const tauriWindow = getBridgeWindow();
  const hasMocks = typeof (globalThis as { __TAURI_MOCKS__?: unknown }).__TAURI_MOCKS__ !== 'undefined';
  const hasTauri = typeof tauriWindow?.__TAURI__ !== 'undefined' || hasMocks;

  if (!hasTauri) {
    return { applied: 0, errors: [] };
  }

  let commands: Array<{ id: string; tool: string; args: unknown }> = [];
  let processed = 0;
  let applied = 0;
  let errors: string[] = [];
  try {
    commands = await tauriInvoke<Array<{ id: string; tool: string; args: unknown }>>('get_workspace_commands');
    errors = [];
    applied = 0;
    processed = 0;
    const dedup = new Set<string>();
    // Discard transient in-memory state before replay so replayed ops fully define the state.
    for (const scope of stateStore.values()) scope.clear();

    const total = commands.length;
    emitReplayProgress({ total, processed, applied, errors: 0 });

    // Preserve original creation order to avoid inverting
    // window lifecycle (e.g., a prior close followed by a create
    // for the same id). Hoisting all creates caused a regression
    // where a later replayed close would immediately remove a
    // newly created window. We intentionally replay in-order and
    // fail loud on any invalid sequence.
    for (const cmd of commands) {
      try {
        // Skip exact duplicate tool+args pairs within this replay session.
        // This mitigates double-persistence or accidental duplicate rows without risking reordering.
        const key = `${cmd.tool}:${stableStringify(cmd.args)}`;
        if (dedup.has(key)) {
          processed += 1;
          if (processed % REPLAY_BATCH_SIZE === 0 || processed === total) {
            emitReplayProgress({ total, processed, applied, errors: errors.length });
            await yieldReplay();
          }
          continue;
        }
        dedup.add(key);
        const envelope = {
          op: cmd.tool,
          params: cmd.args,
          idempotencyKey: cmd.id,
        } as Envelope;
        const result = await applyCommand(envelope, { runId: cmd.id });
        if (result.success) {
          applied += 1;
        } else {
          errors.push(`${cmd.tool}: ${result.error}`);
        }
      } catch (error) {
        errors.push(`${cmd.tool}: ${error instanceof Error ? error.message : String(error)}`);
      }
      processed += 1;
      if (processed % REPLAY_BATCH_SIZE === 0 || processed === total) {
        emitReplayProgress({ total, processed, applied, errors: errors.length });
        // Yield to the browser so first paint and interactivity aren't blocked.
        // WHY: Heavy workspaces can contain hundreds of commands; chunking keeps the UI responsive.
        // INVARIANT: Replay preserves original ordering even when yielding between batches.
        await yieldReplay();
      }
    }

      emitReplayProgress({ total, processed, applied, errors: errors.length, done: true });
      return { applied, errors };
  } catch (error) {
    console.error('Failed to replay workspace', error);
    const message = error instanceof Error ? error.message : String(error);
    const total = commands?.length ?? 0;
    emitReplayProgress({
      total,
      processed,
      applied,
      errors: errors.length + 1,
      done: true,
    });
    return { applied, errors: [...errors, message] };
  }
  };

// Allows shared teardown from commands and UI controls.
function destroyWindow(id: string) {
  const record = windows.get(id);
  if (!record) return;
  // Detach drag listeners if present
  const off = windowDragCleanup.get(record.wrapper);
  if (off) {
    try {
      off();
    } catch (error) {
      console.error(`Failed to cleanup drag listeners for window ${id}:`, error instanceof Error ? error.message : String(error));
    }
  }
  windowDragCleanup.delete(record.wrapper);
  removeDynamicStyleRule(record.styleSelector);
  record.wrapper.remove();
  windows.delete(id);
  emitWindowEvent({ type: 'destroyed', id, title: record.titleText.textContent ?? id });

  if (hasTauriBridge()) {
    // Delete persisted commands for this window so it doesn't reappear on restart
    void tauriInvoke('delete_window_commands', { windowId: id }).catch((error) => {
      console.error('Failed to delete window commands', id, error);
    });
  }
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

// Friendly title from a stable id like "win-ascii-gallery" -> "Ascii Gallery"
const titleizeWindowId = (id: string): string => {
  try {
    const raw = id.replace(/^win[-_]?/i, "");
    const parts = raw.split(/[-_\s]+/).filter(Boolean);
    if (parts.length === 0) return id;
    return parts
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(" ");
  } catch {
    return id;
  }
};

type WindowGeometryParams = Partial<
  Pick<OperationParamMap["window.create"], "x" | "y" | "width" | "height" | "zIndex">
>;

const applyWindowGeometry = (record: WindowRecord, params: WindowGeometryParams) => {
  const declarations: DynamicStyleDeclarations = {};
  if (typeof params.x === "number") declarations.left = `${params.x}px`;
  if (typeof params.y === "number") declarations.top = `${params.y}px`;
  if (typeof params.width === "number") declarations.width = `${params.width}px`;
  if (typeof params.height === "number") declarations.height = `${params.height}px`;
  if (typeof params.zIndex === "number") declarations["z-index"] = String(params.zIndex);
  if (Object.keys(declarations).length === 0) return;
  applyDynamicStyleRule(record.styleSelector, declarations);
};

// Core command executors emit structured success so the queue can surface rich errors without throwing.
const executeWindowCreate = (
  params: OperationParamMap["window.create"],
): CommandResult<string> => {
  try {
    const root = ensureRoot();
    const id = params.id ?? createId("window");
    const existing = windows.get(id);

    console.debug(
      `[adapter] window.create id=${id} title="${params.title}" w=${String(params.width ?? "")} h=${String(params.height ?? "")}`
    );

    if (existing) {
      applyWindowGeometry(existing, {
        x: params.x,
        y: params.y,
        width: params.width,
        height: params.height,
        zIndex: params.zIndex,
      });
      existing.titleText.textContent = params.title;
      emitWindowEvent({ type: 'updated', id, title: params.title });
      return { success: true, value: id };
    }

    const wrapper = document.createElement("div");
    wrapper.dataset.windowId = id;
    const styleSelector = `[data-window-id="${escapeForSelector(id)}"]`;
    wrapper.className = "workspace-window pointer-events-auto";

    const chrome = document.createElement("div");
    chrome.className = "window-title flex items-center justify-between bg-gradient-to-r from-white/80 to-white/70 px-4 py-3 text-sm font-semibold text-slate-700 backdrop-blur-sm select-none cursor-grab border-b border-slate-200/40";

    const titleText = document.createElement("span");
    titleText.className = "truncate";
    titleText.textContent = params.title;
    chrome.appendChild(titleText);

    const controls = document.createElement("div");
    controls.className = "ml-3 flex items-center gap-2";

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Close window");
    // Use a proper multiplication sign for close (avoid mojibake)
    closeButton.textContent = "×";
    closeButton.className = "flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 bg-white/90 text-base text-slate-500 shadow-sm backdrop-blur-sm transition-all duration-200 hover:bg-red-50 hover:border-red-200 hover:text-red-600 hover:scale-110 active:scale-95";
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
    content.className = "window-content flex-1 overflow-auto bg-gradient-to-b from-white/50 to-white/30 px-4 py-3 backdrop-blur-sm";
    const rootNode = document.createElement("div");
    rootNode.id = "root";
    content.appendChild(rootNode);

    wrapper.appendChild(chrome);
    wrapper.appendChild(content);

    const clampRange = (value: number, min: number, max: number) => {
      if (Number.isNaN(value)) return min;
      if (!Number.isFinite(max) || max <= min) return min;
      return Math.min(Math.max(min, value), max);
    };

    type ResizeDirection = 'east' | 'south' | 'southeast';
    const resizeCleanup: Array<() => void> = [];
    let resizeState: {
      pointerId: number;
      direction: ResizeDirection;
      startX: number;
      startY: number;
      baseWidth: number;
      baseHeight: number;
      maxWidth: number;
      maxHeight: number;
    } | null = null;

    const initialWidth = typeof params.width === "number" ? params.width : 640;
    const initialHeight = typeof params.height === "number" ? params.height : 480;
    const MIN_WIDTH = Math.max(240, Math.floor(initialWidth * 0.6));
    const MIN_HEIGHT = Math.max(220, Math.floor(initialHeight * 0.6));
    const EDGE_PADDING = 16;

    wrapper.style.minWidth = `${MIN_WIDTH}px`;
    wrapper.style.minHeight = `${MIN_HEIGHT}px`;

    const handleResizePointerMove = (event: PointerEvent) => {
      const state = resizeState;
      if (!state || state.pointerId !== event.pointerId) {
        return;
      }

      let nextWidth: number | undefined;
      let nextHeight: number | undefined;

      if (state.direction === 'east' || state.direction === 'southeast') {
        const rawWidth = state.baseWidth + (event.clientX - state.startX);
        nextWidth = Math.round(clampRange(rawWidth, MIN_WIDTH, state.maxWidth));
      }
      if (state.direction === 'south' || state.direction === 'southeast') {
        const rawHeight = state.baseHeight + (event.clientY - state.startY);
        nextHeight = Math.round(clampRange(rawHeight, MIN_HEIGHT, state.maxHeight));
      }

      if (typeof nextWidth === 'undefined' && typeof nextHeight === 'undefined') {
        event.preventDefault();
        return;
      }

      const geometry: WindowGeometryParams = {};
      if (typeof nextWidth === 'number') {
        geometry.width = nextWidth;
      }
      if (typeof nextHeight === 'number') {
        geometry.height = nextHeight;
      }
      applyWindowGeometry(record, geometry);
      event.preventDefault();
    };

    const endResizeTracking = (event: PointerEvent) => {
      const state = resizeState;
      if (!state || state.pointerId !== event.pointerId) return;
      resizeState = null;
      wrapper.classList.remove('resizing');
      const target = event.currentTarget as HTMLElement;
      target.releasePointerCapture?.(event.pointerId);
      event.preventDefault();
    };

    const registerResizeHandle = (direction: ResizeDirection, className: string) => {
      const handle = document.createElement("div");
      handle.dataset.resizeHandle = direction;
      handle.className = className;

      const onPointerDown = (event: PointerEvent) => {
        if (event.button !== 0) return;
        const rect = wrapper.getBoundingClientRect();
        const measuredWidth = rect.width > 0 ? rect.width : initialWidth;
        const measuredHeight = rect.height > 0 ? rect.height : initialHeight;
        const maxWidth = Math.max(MIN_WIDTH, Math.floor(window.innerWidth - rect.left - EDGE_PADDING));
        const maxHeight = Math.max(MIN_HEIGHT, Math.floor(window.innerHeight - rect.top - EDGE_PADDING));
        resizeState = {
          pointerId: event.pointerId,
          direction,
          startX: event.clientX,
          startY: event.clientY,
          baseWidth: measuredWidth,
          baseHeight: measuredHeight,
          maxWidth,
          maxHeight,
        };
        wrapper.classList.add('resizing');
        handle.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      };

      handle.addEventListener('pointerdown', onPointerDown);
      handle.addEventListener('pointermove', handleResizePointerMove);
      handle.addEventListener('pointerup', endResizeTracking);
      handle.addEventListener('pointercancel', endResizeTracking);
      resizeCleanup.push(() => {
        handle.removeEventListener('pointerdown', onPointerDown);
        handle.removeEventListener('pointermove', handleResizePointerMove);
        handle.removeEventListener('pointerup', endResizeTracking);
        handle.removeEventListener('pointercancel', endResizeTracking);
      });
      wrapper.appendChild(handle);
    };

    registerResizeHandle(
      'east',
      "absolute inset-y-2 right-0 w-2 cursor-ew-resize rounded-full bg-transparent",
    );
    registerResizeHandle(
      'south',
      "absolute bottom-0 left-2 right-6 h-2 cursor-ns-resize rounded-full bg-transparent",
    );
    registerResizeHandle(
      'southeast',
      "absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize rounded-br-2xl bg-transparent",
    );

    root.appendChild(wrapper);

    const record: WindowRecord = { id, wrapper, content, titleText, styleSelector };
    windows.set(id, record);
    applyWindowGeometry(record, {
      x: params.x,
      y: params.y,
      width: params.width,
      height: params.height,
      zIndex: params.zIndex,
    });
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
      applyWindowGeometry(record, {
        x: Math.round(nextX),
        y: Math.round(nextY),
      });
      originX = event.clientX;
      originY = event.clientY;
      event.preventDefault();
    };

    const endPointerTracking = (event: PointerEvent) => {
      if (pointerId === null || event.pointerId !== pointerId) return;
      pointerId = null;
      if (typeof chrome.releasePointerCapture === 'function') {
        chrome.releasePointerCapture(event.pointerId);
      }
    };

    chrome.addEventListener('pointerdown', onPointerDown);
    chrome.addEventListener('pointermove', onPointerMove);
    chrome.addEventListener('pointerup', endPointerTracking);
    chrome.addEventListener('pointercancel', endPointerTracking);

    const detachDragListeners = () => {
      chrome.removeEventListener('pointerdown', onPointerDown);
      chrome.removeEventListener('pointermove', onPointerMove);
      chrome.removeEventListener('pointerup', endPointerTracking);
      chrome.removeEventListener('pointercancel', endPointerTracking);
    };

    windowDragCleanup.set(wrapper, () => {
      detachDragListeners();
      if (resizeCleanup.length > 0) {
        resizeCleanup.forEach((fn) => {
          try {
            fn();
          } catch (error) {
            console.error('resize cleanup failed', error);
          }
        });
      }
      wrapper.classList.remove('resizing');
    });
    return { success: true, value: id };
  } catch (error) {
    return toFailure(error);
  }
};

// Ensure a host window exists for commands that target a window id.
// When absent, auto-create a sensible shell and persist the synthetic create so replay stays consistent.
const ensureWindowExists = async (
  id: string,
  hint?: Partial<OperationParamMap["window.create"]>,
): Promise<CommandResult<string>> => {
  try {
    if (windows.has(id)) return { success: true, value: id };
    const title = hint?.title && typeof hint.title === 'string' && hint.title.trim() ? hint.title : titleizeWindowId(id);
    const params: OperationParamMap["window.create"] = {
      id,
      title,
      x: hint?.x,
      y: hint?.y,
      width: hint?.width ?? 640,
      height: hint?.height ?? 480,
      zIndex: hint?.zIndex,
      size: hint?.size,
    };
    const created = executeWindowCreate(params);
    if (!created.success) return created;
    // Persist the synthetic create so the workspace can be restored.
    const envelope: Envelope<'window.create'> = { op: 'window.create', params };
    await persistCommand(envelope);
    return created;
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
    const safeHtml = sanitizeHtmlStrict(String(params.html));
    // WHY: Final DOM insertion must use the DOMPurify-cleansed payload, even if upstream validation passed.
    // eslint-disable-next-line no-restricted-syntax
    target.innerHTML = safeHtml as unknown as string;
    return { success: true, value: params.windowId };
  } catch (error) {
    return toFailure(error);
  }
};

// Produces a lightweight prototype component shell to enable rapid UI composition.
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
    // WHY: buildComponentMarkup now uses escapeHtml for all interpolation; safe from XSS.
    // eslint-disable-next-line no-restricted-syntax
    node.innerHTML = buildComponentMarkup(params);

    target.appendChild(node);
    const record: ComponentRecord = { id, element: node };
    components.set(id, record);
    return { success: true, value: id };
  } catch (error) {
    return toFailure(error);
  }
};

// WHY: HTML entity encoding prevents XSS when interpolating user data into markup.
// INVARIANT: All dynamic content in buildComponentMarkup MUST pass through escapeHtml.
export const buildComponentMarkup = (params: OperationParamMap["component.render"]): string => {
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
    // WHY: Escape title to prevent XSS via modal title injection.
    return `<div class="rounded-lg border border-slate-200 bg-white/95 p-4 shadow-lg"><h2 class="text-lg font-semibold">${escapeHtml(title)}</h2><p class="text-sm text-slate-600">Placeholder modal content.</p></div>`;
  }
  if (type.includes("button")) {
    const label = typeof params.props === "object" && params.props && "label" in params.props
      ? String((params.props as Record<string, unknown>).label)
      : "Button";
    const cmd = typeof params.props === "object" && params.props && "command" in params.props
      ? String((params.props as Record<string, unknown>).command)
      : undefined;
    // WHY: Escape both attribute and text content to prevent XSS.
    const dataAttr = cmd ? ` data-command="${escapeHtml(cmd)}"` : '';
    return `<button class="button-primary rounded px-3 py-2"${dataAttr}>${escapeHtml(label)}</button>`;
  }
  if (type.includes("cell")) {
    const text = typeof params.props === "object" && params.props && "text" in params.props
      ? String((params.props as Record<string, unknown>).text)
      : "";
    // WHY: Escape cell text to prevent XSS via component props.
    return `<div class="flex h-20 w-20 items-center justify-center rounded border border-slate-300 bg-white text-xl font-semibold">${escapeHtml(text)}</div>`;
  }
  if (type.includes("grid")) {
    return '<div class="grid grid-cols-3 gap-2">' +
      Array.from({ length: 9 }, () => '<div class="flex h-20 w-20 items-center justify-center rounded border border-slate-300 bg-white text-xl font-semibold"></div>').join('') +
      '</div>';
  }
  // Default prototype shell when component type is unknown; avoid placeholder language in visible text.
  return '<div class="rounded border border-dashed border-slate-300 p-4 text-sm text-slate-500">Prototype component</div>';
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

export const applyCommand = async (command: Envelope, ctx: ApplyContext = {}): Promise<CommandResult> => {
  // Permission gate for risky operations (e.g., api.call). Low-risk ops are allow-listed.
  try {
    const decision = await checkPermission(command);
    if (decision === 'deny') {
      return { success: false, error: 'Denied by policy' };
    }
  } catch (err) {
    return toFailure(err);
  }
  switch (command.op) {
    case "window.create": {
      const params = command.params;
      return executeWindowCreate(params);
    }
    case "dom.set": {
      const params = command.params;
      if (!windows.has(params.windowId)) {
        const ensured = await ensureWindowExists(params.windowId);
        if (!ensured.success) return ensured;
      }
      return executeDomSet(params);
    }
    case "window.update": {
      try {
        const params = command.params;
        let record = windows.get(params.id);
        if (!record) {
          const ensured = await ensureWindowExists(params.id, {
            title: params.title ?? titleizeWindowId(params.id),
            x: params.x,
            y: params.y,
            width: params.width,
            height: params.height,
            zIndex: params.zIndex,
          });
          if (!ensured.success) return ensured;
          record = windows.get(params.id)!;
        }
        if (params.title) {
          record.titleText.textContent = params.title;
          emitWindowEvent({ type: 'updated', id: params.id, title: params.title });
        }
        applyWindowGeometry(record, {
          x: params.x,
          y: params.y,
          width: params.width,
          height: params.height,
          zIndex: params.zIndex,
        });
        return { success: true, value: params.id };
      } catch (error) {
        return toFailure(error);
      }
    }
    case "window.close": {
      try {
        const params = command.params;
        destroyWindow(params.id);
        return { success: true, value: params.id };
      } catch (error) {
        return toFailure(error);
      }
    }
    case "dom.replace": {
      const params = command.params;
      if (!windows.has(params.windowId)) {
        const ensured = await ensureWindowExists(params.windowId);
        if (!ensured.success) return ensured;
      }
      return executeDomSet({
        windowId: params.windowId,
        target: params.target,
        html: params.html,
        sanitize: params.sanitize,
      });
    }
    case "dom.append": {
      try {
        const params = command.params;
        let record = windows.get(params.windowId);
        if (!record) {
          const ensured = await ensureWindowExists(params.windowId);
          if (!ensured.success) return ensured;
          record = windows.get(params.windowId)!;
        }
        const target = record.content.querySelector(params.target);
        if (!target) {
          return { success: false, error: `Target ${params.target} missing in window ${params.windowId}` };
        }
        const safeHtml = sanitizeHtmlStrict(String(params.html));
        // WHY: Append path also routes through sanitizer to stop partial bypass via later queue mutations.
        target.insertAdjacentHTML("beforeend", safeHtml as unknown as string);
        return { success: true, value: params.windowId };
      } catch (error) {
        return toFailure(error);
      }
    }
    case "component.render": {
      const params = command.params;
      if (!windows.has(params.windowId)) {
        const ensured = await ensureWindowExists(params.windowId);
        if (!ensured.success) return ensured;
      }
      return executeComponentRender(params);
    }
    case "component.update": {
      try {
        const params = command.params;
        updateComponent(params);
        return { success: true, value: params.id };
      } catch (error) {
        return toFailure(error);
      }
    }
    case "component.destroy": {
      try {
        const params = command.params;
        destroyComponent(params);
        return { success: true, value: params.id };
      } catch (error) {
        return toFailure(error);
      }
    }
    case "state.set": {
      try {
        const params = command.params;
        setStateValue(params);
        return { success: true, value: params.key };
      } catch (error) {
        return toFailure(error);
      }
    }
    case "state.get": {
      try {
        const params = command.params;
        return { success: true, value: getStateValue(params) };
      } catch (error) {
        return toFailure(error);
      }
    }
    case "state.watch":
    case "state.unwatch": {
      try {
        const params = command.params;
        return { success: true, value: params.key };
      } catch (error) {
        return toFailure(error);
      }
    }
    case "api.call": {
      try {
        const params = command.params;
        const url = params.url;
        // UICP compute plane submission: uicp://compute.call (body = JobSpec)
        if (url.startsWith('uicp://compute.call')) {
          try {
            const computeCall = getComputeBridge();
            if (!computeCall) throw new Error('compute bridge not initialized');
            const body = (params.body ?? {}) as Partial<JobSpec>;
            const jobId = body.jobId;
            const task = body.task;
            if (!jobId || !task) {
              throw new Error('compute.call payload missing jobId or task');
            }
            const spec = {
              ...body,
              jobId,
              task,
              workspaceId: body.workspaceId ?? 'default',
            } as JobSpec;
            await computeCall(spec);
          } catch (error) {
            console.error('compute.call failed', error);
            return toFailure(error);
          }
          return { success: true, value: params.idempotencyKey ?? command.id ?? createId('api') };
        }
        // Tauri FS special-case
        if (url.startsWith('tauri://fs/writeTextFile')) {
          // Expect body: { path: string, contents: string, directory?: 'AppData' | 'Desktop' | ... }
          const body = (params.body ?? {}) as Record<string, unknown>;
          const path = String(body.path ?? 'uicp.txt');
          const contents = String(body.contents ?? '');
          const dirToken =
            typeof body.directory === 'string' && body.directory.trim().length > 0
              ? body.directory.trim()
              : undefined;
          const dir = (dirToken ? ALLOWED_BASE_DIRECTORIES[dirToken] : undefined) ?? DEFAULT_EXPORT_DIRECTORY;
          const safeResult = await safeWrite(path, contents, {
            base: dir,
            devDesktopWrite: dir === BaseDirectory.Desktop,
            runId: ctx.runId ?? command.traceId,
          });
          if (!safeResult.ok) {
            const logPayload = { path, directory: dirToken, errorCode: safeResult.errorCode };
            if (dir === BaseDirectory.Desktop) {
              console.warn('desktop export blocked', logPayload);
            } else {
              console.error('tauri fs write failed', logPayload);
            }
            return { success: false, error: safeResult.message };
          }
          return { success: true, value: params.idempotencyKey ?? command.id ?? createId('api') };
        }
        // UICP intent dispatch: hand off to app chat pipeline
        if (url.startsWith('uicp://intent')) {
          const rawBody = (params.body ?? {}) as Record<string, unknown>;
          if (isStructuredClarifierBody(rawBody)) {
            return renderStructuredClarifierForm(rawBody, command);
          }
          try {
            const text = typeof rawBody.text === 'string' ? rawBody.text : '';
            const meta = { windowId: (rawBody.windowId as string | undefined) ?? command.windowId };
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
          const method = (params.method ?? 'GET').toUpperCase();
          const traceId = command.traceId;
          const urlObj = new URL(url);

          if (!ALLOWED_HTTP_METHODS.has(method)) {
            if (traceId) {
              emitTelemetryEvent('api_call', {
                traceId,
                span: 'api',
                status: 'error',
                data: { reason: 'method_not_allowed', method, origin: urlObj.origin },
              });
            }
            return { success: false, error: `Method ${method} not allowed` };
          }

          const init: FetchRequestInit = { method, headers: params.headers };
          if (params.body !== undefined) {
            try {
              init.body = typeof params.body === 'string' ? params.body : JSON.stringify(params.body);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (traceId) {
                emitTelemetryEvent('api_call', {
                  traceId,
                  span: 'api',
                  status: 'error',
                  data: { reason: 'body_serialization_failed', method, origin: urlObj.origin, error: message },
                });
              }
              return { success: false, error: 'Body serialization failed' };
            }
            init.headers = { 'content-type': 'application/json', ...(params.headers ?? {}) };
          }

          const startedAt = performance.now();
          try {
            const response = await fetch(url, init);
            const duration = Math.round(performance.now() - startedAt);
            if (traceId) {
              emitTelemetryEvent('api_call', {
                traceId,
                span: 'api',
                durationMs: duration,
                status: response.ok ? 'ok' : 'error',
                data: {
                  method,
                  origin: urlObj.origin,
                  pathname: urlObj.pathname,
                  status: response.status,
                },
              });
            }
            if (!response.ok) {
              const statusText = response.statusText?.trim();
              const label = statusText ? `${response.status} ${statusText}` : `${response.status}`;
              return { success: false, error: `HTTP ${label}` };
            }
          } catch (error) {
            const duration = Math.round(performance.now() - startedAt);
            const message = error instanceof Error ? error.message : String(error);
            if (traceId) {
              emitTelemetryEvent('api_call', {
                traceId,
                span: 'api',
                durationMs: duration,
                status: 'error',
                data: {
                  method,
                  origin: urlObj.origin,
                  pathname: urlObj.pathname,
                  error: message,
                },
              });
            }
            console.error('api.call fetch failed', { traceId, url, error: message });
            return toFailure(error);
          }
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
        const params = command.params;
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

