/**
 * Lifecycle Orchestrator (Adapter v2)
 * 
 * Thin coordinator that routes operations to specialized modules.
 * This is the NEW modular implementation activated by UICP_ADAPTER_V2=1.
 * 
 * PR 7: Thin orchestrator that wires all modules together
 * 
 * INVARIANTS:
 * - No direct DOM/window manipulation (delegate to modules)
 * - All HTML sanitized (via DomApplier)
 * - All permissions checked (via PermissionGate)
 * - All operations idempotent (via module implementations)
 * - All events tracked (via AdapterTelemetry)
 */

import type { Envelope, Batch, OperationParamMap } from '../../schema';
import type { ApplyOutcome, ApplyOptions, PermissionScope, WindowLifecycleEvent, WindowLifecycleListener } from './adapter.types';
import { validateEnvelope } from './adapter.schema';
import { AdapterError } from './adapter.errors';
import { createWindowManager } from './windowManager';
import type { WindowManager } from './windowManager';
import { createDomApplier } from './domApplier';
import type { DomApplier } from './domApplier';
import { createComponentRenderer } from './componentRenderer';
import type { ComponentRenderer } from './componentRenderer';
import { createPermissionGate } from './permissionGate';
import { createAdapterTelemetry, AdapterEvents } from './adapter.telemetry';
import { createId } from '../../utils';
import { getComputeBridge } from '../../bridge/globals';
import type { ComputeFinalEvent, JobSpec } from '../../../compute/types';
import { routeApiCall } from './adapter.api';
import type { StructuredClarifierBody, StructuredClarifierFieldSpec, StructuredClarifierOption } from './adapter.clarifier';
import { persistCommand, replayWorkspace as replayWorkspaceImpl } from './adapter.persistence';
import { createDelegatedEventHandler, registerCommandHandler } from './adapter.events';
import { getComputeCancelBridge } from '../../bridge/globals';
import { escapeHtml } from './adapter.security';

/**
 * Workspace root element (must be registered before applying operations)
 */
let workspaceRoot: HTMLElement | null = null;
let windowManagerInstance: WindowManager | null = null;
let domApplierInstance: DomApplier | null = null;
let componentRendererInstance: ComponentRenderer | null = null;
const windowLifecycleListeners = new Set<WindowLifecycleListener>();

// V2 state store (scoped: window, workspace, global)
type StateScope = 'window' | 'workspace' | 'global';
const stateStore = new Map<StateScope, Map<string, unknown>>([
  ['window', new Map()],
  ['workspace', new Map()],
  ['global', new Map()],
]);

type StateWatcherEntry = {
  scope: StateScope;
  key: string;
  windowId?: string;
  selector: string;
  render: (value: unknown) => void;
  teardown: () => void;
};

type StateWatcherBucket = Map<string, Set<StateWatcherEntry>>;

const watcherRegistry: Map<StateScope, StateWatcherBucket> = new Map([
  ['window', new Map()],
  ['workspace', new Map()],
  ['global', new Map()],
]);

// Index by windowId if we later support mass-teardown per window
// (currently we purge from the bucket on window.close)

const stateStoreKey = (scope: StateScope, key: string, windowId?: string): string => {
  if (scope === 'window') {
    if (!windowId) {
      throw new AdapterError('Adapter.ValidationFailed', `window scope requires windowId for state key ${key}`);
    }
    return `${windowId}:${key}`;
  }
  return key;
};

const readStateValue = (scope: StateScope, key: string, windowId?: string): unknown => {
  const store = stateStore.get(scope);
  if (!store) return undefined;
  try {
    const storeKey = stateStoreKey(scope, key, windowId);
    return store.get(storeKey);
  } catch (error) {
    console.error('state read failed', { scope, key, windowId, error });
    throw error;
  }
};

type CommitStateParams = {
  scope: StateScope;
  key: string;
  value: unknown;
  windowId?: string;
};

const notifyStateWatchers = (scope: StateScope, key: string, windowId: string | undefined, value: unknown): void => {
  const bucket = watcherRegistry.get(scope);
  if (!bucket) return;
  const listeners = bucket.get(stateStoreKey(scope, key, windowId));
  if (!listeners) return;
  for (const watcher of listeners) {
    watcher.render(value);
  }
};

const commitStateValue = ({ scope, key, value, windowId }: CommitStateParams): void => {
  const store = stateStore.get(scope);
  if (!store) return;
  const storeKey = stateStoreKey(scope, key, windowId);
  store.set(storeKey, value);
  notifyStateWatchers(scope, key, windowId, value);
};

type ParsedStateReference = {
  scope: StateScope;
  windowId?: string;
  segments: string[];
};

const parseStateReference = (path: string): ParsedStateReference | null => {
  if (typeof path !== 'string') return null;
  const trimmed = path.trim();
  if (!trimmed) return null;
  const segments = trimmed.split('.').map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return null;

  let scope: StateScope = 'workspace';
  let windowId: string | undefined;

  const scopeCandidate = segments[0]?.toLowerCase();
  if (scopeCandidate === 'workspace' || scopeCandidate === 'global') {
    scope = scopeCandidate as StateScope;
    segments.shift();
  } else if (scopeCandidate === 'window') {
    scope = 'window';
    segments.shift();
    const targetWindow = segments.shift();
    if (!targetWindow) {
      return null;
    }
    windowId = targetWindow;
  }

  if (segments.length === 0) {
    return null;
  }

  return { scope, windowId, segments };
};

const resolveStateReferenceValue = (path: string): unknown => {
  const parsed = parseStateReference(path);
  if (!parsed) return undefined;
  const { scope, windowId, segments } = parsed;

  for (let i = segments.length; i >= 1; i--) {
    const keyCandidate = segments.slice(0, i).join('.');
    const candidateValue = readStateValue(scope, keyCandidate, windowId);
    if (candidateValue === undefined) {
      continue;
    }
    const remaining = segments.slice(i);
    if (remaining.length === 0) {
      return candidateValue;
    }
    let current: unknown = candidateValue;
    let failed = false;
    for (const part of remaining) {
      if (!isRecord(current)) {
        failed = true;
        break;
      }
      if (!Object.prototype.hasOwnProperty.call(current, part)) {
        failed = true;
        break;
      }
      current = (current as Record<string, unknown>)[part];
    }
    if (!failed) {
      return current;
    }
  }

  return undefined;
};

const resolveScriptSource = (
  inlineSource: string | undefined,
  sourceKey: string | undefined,
): string | undefined => {
  if (typeof inlineSource === 'string' && inlineSource.length > 0) {
    return inlineSource;
  }
  if (!sourceKey) {
    return undefined;
  }
  const resolved = resolveStateReferenceValue(sourceKey);
  if (typeof resolved === 'string') {
    return resolved;
  }
  if (isRecord(resolved) && typeof resolved.code === 'string') {
    return resolved.code;
  }
  return undefined;
};

const nextJobId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return createId('job');
};

const waitForComputeFinalEvent = (jobId: string, timeoutMs = 60_000): Promise<ComputeFinalEvent> => {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Compute final events unavailable in this environment'));
  }
  return new Promise<ComputeFinalEvent>((resolve, reject) => {
    let settled = false;
    let timer: number | undefined;
    const cleanup = () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
      window.removeEventListener('uicp-compute-final', handler);
    };
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<ComputeFinalEvent>).detail;
      if (!detail || detail.jobId !== jobId || settled) {
        return;
      }
      settled = true;
      cleanup();
      if (!detail.ok) {
        const error = new Error(detail.message ?? 'Compute job failed');
        Object.assign(error, { code: detail.code ?? 'Compute.Error' });
        reject(error);
        return;
      }
      resolve(detail);
    };
    window.addEventListener('uicp-compute-final', handler);
    timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Compute job ${jobId} timed out`));
    }, timeoutMs);
  });
};

type ScriptJobOptions = {
  source?: string;
  traceId?: string;
  timeoutMs?: number;
};

const submitScriptComputeJob = async (
  moduleId: string,
  input: Record<string, unknown>,
  options: ScriptJobOptions = {},
): Promise<ComputeFinalEvent> => {
  const compute = getComputeBridge();
  if (!compute) {
    throw new Error('Compute bridge unavailable');
  }
  const jobId = nextJobId();
  const payload: Record<string, unknown> = { ...input };
  if (options.source) {
    payload.source = options.source;
  }
  const spec: JobSpec = {
    jobId,
    task: moduleId,
    input: payload,
    timeoutMs: options.timeoutMs ?? 15_000,
    bind: [],
    cache: 'readwrite',
    capabilities: {},
    replayable: true,
    workspaceId: 'default',
    provenance: {
      envHash: `script-panel:${moduleId}`,
      agentTraceId: options.traceId,
    },
  };
  await compute(spec);
  return waitForComputeFinalEvent(jobId, options.timeoutMs ?? 60_000);
};

// Allow host UI to inject a predicate indicating whether a window is pinned as a desktop shortcut.
// When pinned, we preserve persisted commands on close so replay can restore it later.
let isPinnedWindowPredicate: ((id: string) => boolean) | null = null;

export const setPinnedWindowPredicate = (fn: ((id: string) => boolean) | null): void => {
  isPinnedWindowPredicate = fn;
};

// Workspace ready flag and pending batch queue (handles race condition where batches
// arrive before Desktop.tsx registers the workspace root)
let workspaceReady = false;
type PendingBatchEntry = {
  batch: Batch;
  resolve: (outcome: ApplyOutcome) => void;
  reject: (error: unknown) => void;
};
const pendingBatches: PendingBatchEntry[] = [];

// Reset handlers allow extensions to hook into workspace reset
const resetHandlers = new Set<() => void>();

type ClarifierField = {
  name: string;
  label: string;
  placeholder?: string;
  description?: string;
  required: boolean;
  defaultValue?: string;
  type: 'text' | 'textarea' | 'select';
  options?: Array<{ label: string; value: string }>;
};

type CommandResult<T = unknown, D = unknown> =
  | { success: true; value: T; data?: D }
  | { success: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const cloneDeep = <T>(value: T): T => {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  try {
    // structuredClone is available in modern browsers/node.
    return structuredClone(value);
  } catch {
    if (Array.isArray(value)) {
      return value.map((item) => cloneDeep(item)) as unknown as T;
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = cloneDeep(entry);
    }
    return out as unknown as T;
  }
};

const valuesEqual = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) {
    return true;
  }
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false;
  }
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

const toPatchSegments = (input?: string | string[]): string[] => {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.map((segment) => segment.trim()).filter((segment) => segment.length > 0);
  }
  return input
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
};

const isNumericKey = (segment: string): boolean => /^\d+$/.test(segment);

const getChildValue = (value: unknown, segment: string): unknown => {
  if (Array.isArray(value)) {
    if (isNumericKey(segment)) {
      return value[Number(segment)];
    }
    return (value as unknown as Record<string, unknown>)[segment];
  }
  if (isRecord(value)) {
    return value[segment];
  }
  return undefined;
};

const cloneParentForKey = (parent: unknown, segment: string): unknown => {
  if (Array.isArray(parent)) {
    return parent.slice();
  }
  if (isRecord(parent)) {
    return { ...parent };
  }
  return isNumericKey(segment) ? [] : {};
};

const setChildValue = (container: unknown, segment: string, child: unknown): void => {
  if (Array.isArray(container)) {
    if (isNumericKey(segment)) {
      (container as unknown[])[Number(segment)] = child;
    } else {
      (container as unknown as Record<string, unknown>)[segment] = child;
    }
    return;
  }
  if (isRecord(container)) {
    container[segment] = child;
    return;
  }
  throw new Error('state.patch encountered non-container parent');
};

const setValueAtPath = (
  root: unknown,
  path: string[],
  updater: (previous: unknown) => unknown,
): unknown => {
  if (path.length === 0) {
    const next = updater(root);
    return valuesEqual(root, next) ? root : next;
  }

  const parents: unknown[] = [];
  let cursor: unknown = root;
  for (const segment of path) {
    parents.push(cursor);
    cursor = getChildValue(cursor, segment);
  }

  const previousLeaf = cursor;
  let nextLeaf = updater(previousLeaf);
  if (valuesEqual(previousLeaf, nextLeaf)) {
    nextLeaf = previousLeaf;
  }
  if (Object.is(previousLeaf, nextLeaf)) {
    return root;
  }

  let child = nextLeaf;
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const parent = parents[index];
    const segment = path[index];
    const parentClone = cloneParentForKey(parent, segment);
    setChildValue(parentClone, segment, child);
    child = parentClone;
  }
  return child;
};

const applyStatePatchOps = (
  initial: unknown,
  ops: OperationParamMap['state.patch']['ops'],
): unknown => {
  let result = initial;
  for (const op of ops) {
    const segments = toPatchSegments(op.path);
    switch (op.op) {
      case 'set': {
        const valueClone = cloneDeep(op.value);
        result = setValueAtPath(result, segments, (previous) =>
          valuesEqual(previous, valueClone) ? previous : valueClone,
        );
        break;
      }
      case 'merge': {
        const additions = op.value ?? {};
        const mergeKeys = Object.keys(additions);
        if (mergeKeys.length === 0) {
          // No changes to apply; continue.
          break;
        }
        result = setValueAtPath(result, segments, (previous) => {
          const base = isRecord(previous) ? { ...previous } : {};
          let touched = false;
          for (const key of mergeKeys) {
            const nextValue = cloneDeep(additions[key]);
            if (!valuesEqual(base[key], nextValue)) {
              touched = true;
              base[key] = nextValue;
            }
          }
          if (!touched && isRecord(previous)) {
            return previous;
          }
          return base;
        });
        break;
      }
      case 'toggle': {
        result = setValueAtPath(result, segments, (previous) => {
          if (typeof previous === 'boolean') {
            return !previous;
          }
          if (previous == null) {
            return true;
          }
          return !previous;
        });
        break;
      }
      case 'setIfNull': {
        const valueClone = cloneDeep(op.value);
        result = setValueAtPath(result, segments, (previous) =>
          previous == null ? valueClone : previous,
        );
        break;
      }
      default: {
        const exhaustive: never = op;
        throw new Error(`Unsupported state.patch operation ${(exhaustive as { op: string }).op}`);
      }
    }
  }
  return result;
};

type ScriptSink = {
  status: string;
  html?: string;
  data?: unknown;
  error?: unknown;
  mode?: string;
};

const scriptSinkFromOutput = (value: unknown): ScriptSink => {
  const record = isRecord(value) ? value : {};
  const status = typeof record.status === 'string' ? record.status : 'ready';
  return {
    status,
    html: typeof record.html === 'string' ? record.html : undefined,
    data: Object.prototype.hasOwnProperty.call(record, 'data') ? record.data : undefined,
    error: Object.prototype.hasOwnProperty.call(record, 'error') ? record.error : undefined,
    mode: typeof record.mode === 'string' ? record.mode : undefined,
  };
};

const setScriptPanelViewState = (stateKey: string, sink: ScriptSink) => {
  commitStateValue({
    scope: 'workspace',
    key: stateKey,
    value: {
      status: sink.status,
      html: sink.html,
      data: sink.data ?? null,
      error: sink.error ?? null,
    },
  });
};

const renderStructuredClarifier = async (
  body: StructuredClarifierBody,
  command: Envelope,
  windowManager: WindowManager,
): Promise<void> => {
  const fallbackField: StructuredClarifierFieldSpec = {
    name: 'answer',
    label: typeof body.label === 'string' && body.label.trim() ? body.label.trim() : 'Answer',
    placeholder: typeof body.placeholder === 'string' ? body.placeholder : undefined,
    multiline: Boolean(body.multiline),
  };
  const candidateFields = Array.isArray(body.fields)
    ? body.fields.filter((field): field is StructuredClarifierFieldSpec => Boolean(field))
    : [];
  const fieldSpecs: StructuredClarifierFieldSpec[] =
    candidateFields.length > 0 ? candidateFields : [fallbackField];

  const fields: ClarifierField[] = fieldSpecs.map((spec, index) => {
    const name = typeof spec?.name === 'string' && spec.name.trim() ? spec.name.trim() : `field_${index + 1}`;
    const label = typeof spec?.label === 'string' && spec.label.trim() ? spec.label.trim() : name;
    const placeholder = typeof spec?.placeholder === 'string' ? spec.placeholder : undefined;
    const description = typeof spec?.description === 'string' ? spec.description : undefined;
    const required = spec?.required === undefined ? true : Boolean(spec.required);
    const defaultValue = typeof spec?.defaultValue === 'string' ? spec.defaultValue : undefined;
    const inferredType = typeof spec?.type === 'string' ? spec.type.toLowerCase() : undefined;
    const multiline = inferredType === 'textarea' || Boolean(spec?.multiline);
    const options: Array<{ label: string; value: string }> | undefined = Array.isArray(spec?.options)
      ? spec.options
          .map((option: StructuredClarifierOption | null | undefined) => {
            if (!option || typeof option.value !== 'string') {
              return null;
            }
            const optionLabel =
              typeof option.label === 'string' && option.label.trim() ? option.label : option.value;
            return { label: optionLabel, value: option.value };
          })
          .filter(
            (
              option: { label: string; value: string } | null,
            ): option is { label: string; value: string } => option !== null,
          )
      : undefined;

    let type: 'text' | 'textarea' | 'select' = 'text';
    if (multiline) {
      type = 'textarea';
    } else if (inferredType === 'select' && options && options.length > 0) {
      type = 'select';
    }

    return { name, label, placeholder, description, required, defaultValue, type, options };
  });

  const prompt = typeof body.textPrompt === 'string' && body.textPrompt.trim() ? body.textPrompt.trim() : 'Please provide additional detail.';
  const submitText = typeof body.submit === 'string' && body.submit.trim() ? body.submit.trim() : 'Continue';
  const cancelText = body.cancel === false ? null : typeof body.cancel === 'string' && body.cancel.trim() ? body.cancel.trim() : 'Cancel';
  const providedWindowId = typeof body.windowId === 'string' && body.windowId.trim() ? body.windowId.trim() : undefined;
  const commandWindowId = typeof command.windowId === 'string' && command.windowId.trim() ? command.windowId.trim() : undefined;
  const windowId = providedWindowId ?? commandWindowId ?? createId('clarifier');
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : windowId;
  const width = typeof body.width === 'number' && Number.isFinite(body.width) ? body.width : undefined;
  const height = typeof body.height === 'number' && Number.isFinite(body.height) ? body.height : undefined;

  if (!windowManager.exists(windowId)) {
    await windowManager.create({ id: windowId, title, width, height });
  }

  const statusId = `${windowId}-clarifier-status`;
  const commandPayload = {
    question: prompt,
    windowId,
    text: fields.map((field) => `${field.label}: {{form.${field.name}}}`).join('\n').trim() || `{{form.${fields[0]?.name}}}`,
    fields: fields.map((field) => ({ name: field.name, label: field.label, value: `{{form.${field.name}}}` })),
  };

  const submitCommands: Batch = [
    { op: 'api.call', params: { method: 'POST', url: 'uicp://intent', body: commandPayload } },
    {
      op: 'dom.set',
      params: {
        windowId,
        target: `#${statusId}`,
        html: '<span class="text-xs text-slate-500">Processing...</span>',
      },
    },
    { op: 'window.close', params: { id: windowId } },
  ];

  const cancelCommands: Batch | null = cancelText
    ? [{ op: 'window.close', params: { id: windowId } }]
    : null;

  const record = windowManager.getRecord(windowId);
  if (!record) return;
  const root = record.content.querySelector('#root');
  if (!root) return;

  const doc = root.ownerDocument ?? document;
  const container = doc.createElement('div');
  container.className = 'structured-clarifier flex flex-col gap-3 p-4';

  const promptEl = doc.createElement('p');
  promptEl.className = 'text-sm text-slate-700';
  promptEl.textContent = prompt;
  container.appendChild(promptEl);

  if (typeof body.description === 'string' && body.description.trim()) {
    const descriptionEl = doc.createElement('p');
    descriptionEl.className = 'text-xs text-slate-500';
    descriptionEl.textContent = body.description.trim();
    container.appendChild(descriptionEl);
  }

  const form = doc.createElement('form');
  form.className = 'flex flex-col gap-3';
  form.setAttribute('data-structured-clarifier', 'true');

  fields.forEach((field, index) => {
    const wrapper = doc.createElement('label');
    wrapper.className = 'flex flex-col gap-1 text-sm text-slate-600';

    const labelEl = doc.createElement('span');
    labelEl.className = 'font-semibold text-slate-700';
    labelEl.textContent = field.label;
    wrapper.appendChild(labelEl);

    let control: HTMLElement;
    if (field.type === 'textarea') {
      const textarea = doc.createElement('textarea');
      textarea.name = field.name;
      textarea.rows = 4;
      textarea.className = 'rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-400';
      if (field.placeholder) textarea.placeholder = field.placeholder;
      if (field.required) textarea.required = true;
      if (field.defaultValue) textarea.value = field.defaultValue;
      control = textarea;
    } else if (field.type === 'select') {
      const select = doc.createElement('select');
      select.name = field.name;
      select.className = 'rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-400';
      if (field.required) select.required = true;
      for (const option of field.options ?? []) {
        const optionEl = doc.createElement('option');
        optionEl.value = option.value;
        optionEl.textContent = option.label;
        if (field.defaultValue && field.defaultValue === option.value) {
          optionEl.selected = true;
        }
        select.appendChild(optionEl);
      }
      control = select;
    } else {
      const input = doc.createElement('input');
      input.type = 'text';
      input.name = field.name;
      input.className = 'rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-400';
      if (field.placeholder) input.placeholder = field.placeholder;
      if (field.required) input.required = true;
      if (field.defaultValue) input.value = field.defaultValue;
      control = input;
    }

    control.setAttribute('aria-label', field.label);
    wrapper.appendChild(control);

    if (field.description) {
      const helper = doc.createElement('span');
      helper.className = 'text-xs text-slate-500';
      helper.textContent = field.description;
      wrapper.appendChild(helper);
    }

    form.appendChild(wrapper);

    if (index === 0) {
      queueMicrotask(() => {
        (control as HTMLElement).focus();
      });
    }
  });

  const controls = doc.createElement('div');
  controls.className = 'mt-1 flex items-center gap-2';

  const submitButton = doc.createElement('button');
  submitButton.type = 'submit';
  submitButton.className = 'rounded bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700';
  submitButton.textContent = submitText;
  submitButton.setAttribute('data-command', JSON.stringify(submitCommands));
  controls.appendChild(submitButton);

  if (cancelCommands) {
    const cancelButton = doc.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'rounded border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-100';
    cancelButton.textContent = cancelText ?? '';
    cancelButton.setAttribute('data-command', JSON.stringify(cancelCommands));
    controls.appendChild(cancelButton);
  }

  form.appendChild(controls);

  const status = doc.createElement('div');
  status.id = statusId;
  status.className = 'text-xs text-slate-500';
  status.setAttribute('aria-live', 'polite');
  form.appendChild(status);

  container.appendChild(form);

  root.innerHTML = '';
  root.appendChild(container);
};

/**
 * Register workspace root element.
 * Must be called before applyBatch.
 */
export const registerWorkspaceRoot = (element: HTMLElement): void => {
  // Ensure the workspace root is attached to the document so global queries work in tests/preview
  try {
    if (!element.isConnected && typeof document !== 'undefined' && document.body) {
      document.body.appendChild(element);
    }
  } catch {
    // best-effort; if document is unavailable (SSR), continue without attaching
  }
  workspaceRoot = element;
  workspaceReady = true;
  
  // Initialize singletons bound to the new root
  windowManagerInstance = createWindowManager(element, {
    onLifecycleEvent: (event: WindowLifecycleEvent) => {
      for (const listener of windowLifecycleListeners) {
        try {
          listener(event);
        } catch (err) {
          // lifecycle listeners must not throw
          console.error('window lifecycle listener error', err);
        }
      }
    },
    shouldDeletePersistedOnClose: (id) => {
      try {
        return isPinnedWindowPredicate ? !isPinnedWindowPredicate(id) : true;
      } catch (err) {
        console.error('pinned predicate failed; defaulting to delete on close', err);
        return true;
      }
    },
  });
  domApplierInstance = createDomApplier(windowManagerInstance, {
    enableDeduplication: true,
    getWorkspaceRoot: () => workspaceRoot,
  });
  const readState = (scope: StateScope, key: string, windowId?: string): unknown => {
    const store = stateStore.get(scope);
    if (!store) return undefined;
    const k = scope === 'window' && windowId ? `${windowId}:${key}` : key;
    return store.get(k);
  };
  componentRendererInstance = createComponentRenderer(domApplierInstance, {
    onUnknownComponent: (_type) => {
      // telemetry emitted in applyBatch
    },
    readState,
  });
  
  // Set up event delegation
  const setStateValue = (params: { scope: StateScope; key: string; value: unknown; windowId?: string }) => {
    const scopeStore = stateStore.get(params.scope);
    if (scopeStore) {
      const key = params.scope === 'window' && params.windowId ? `${params.windowId}:${params.key}` : params.key;
      scopeStore.set(key, params.value);
    }
  };
  
  const handleDelegatedEvent = createDelegatedEventHandler(element, setStateValue);
  element.addEventListener('click', handleDelegatedEvent, true);
  element.addEventListener('input', handleDelegatedEvent, true);
  element.addEventListener('submit', handleDelegatedEvent, true);
  element.addEventListener('change', handleDelegatedEvent, true);
  
  // Register script.emit bridge
  registerCommandHandler('script.emit', async (_cmd, ctx) => {
    const context = isRecord(ctx) ? ctx : {};
    const panelId = typeof context.panelId === 'string' ? context.panelId : '';
    const windowId = typeof context.windowId === 'string' ? context.windowId : undefined;
    if (!panelId || !windowId) return;

    const modelKey = `panels.${panelId}.model`;
    const configKey = `panels.${panelId}.config`;
    const rawConfig = readStateValue('workspace', configKey, undefined);
    const config = isRecord(rawConfig) ? rawConfig : {};
    const moduleId = typeof config.module === 'string' && config.module.trim() ? config.module.trim() : '';
    const stateKey =
      typeof config.stateKey === 'string' && config.stateKey.trim()
        ? config.stateKey.trim()
        : `panels.${panelId}.view`;
    const inlineSource =
      typeof config.source === 'string' && config.source.trim() ? config.source : undefined;
    const sourceKeyRef =
      typeof config.sourceKey === 'string' && config.sourceKey.trim() ? config.sourceKey.trim() : undefined;
    const source = resolveScriptSource(inlineSource, sourceKeyRef);

    if (!moduleId) {
      console.warn(`script.emit ignored: panel ${panelId} missing module configuration.`);
      return;
    }

    const currentStateRaw = readStateValue('workspace', modelKey, undefined);
    const currentState = typeof currentStateRaw === 'string' ? currentStateRaw : '';
    const action =
      typeof context.action === 'string' && context.action.trim() ? context.action.trim() : '';
    let payloadString: string | undefined;
    if (typeof context.payload === 'string') {
      payloadString = context.payload;
    } else if (context.payload != null) {
      try {
        payloadString = JSON.stringify(context.payload);
      } catch {
        payloadString = String(context.payload);
      }
    }

    setScriptPanelViewState(stateKey, { status: 'loading' });

    try {
      const onEventInput: Record<string, unknown> = { mode: 'on-event', state: currentState };
      if (action) onEventInput.action = action;
      if (payloadString !== undefined) onEventInput.payload = payloadString;

      const onEventFinal = await submitScriptComputeJob(moduleId, onEventInput, {
        source,
        traceId: typeof context.traceId === 'string' ? context.traceId : undefined,
      });
      if (!onEventFinal.ok) {
        setScriptPanelViewState(stateKey, { status: 'error', error: { message: onEventFinal.message } });
        return;
      }
      const onEventSink = scriptSinkFromOutput(onEventFinal.output);

      if (onEventSink.status === 'error') {
        setScriptPanelViewState(stateKey, onEventSink);
        return;
      }

      let nextState = currentState;
      let batchPayload: unknown;
      const sinkData = onEventSink.data;
      const coerceState = (value: unknown): string => {
        if (typeof value === 'string') return value;
        if (value == null) return '';
        try {
          return JSON.stringify(value);
        } catch {
          return '';
        }
      };
      const coercePayload = (value: unknown) => {
        if (Array.isArray(value)) return value;
        return undefined;
      };

      if (typeof sinkData === 'string') {
        try {
          const parsed = JSON.parse(sinkData);
          if (isRecord(parsed)) {
            if (Object.prototype.hasOwnProperty.call(parsed, 'next_state')) {
              nextState = coerceState(parsed.next_state);
            }
            if (Object.prototype.hasOwnProperty.call(parsed, 'batch')) {
              batchPayload = coercePayload(parsed.batch);
            }
          }
        } catch {
          // ignore parse failure
        }
      } else if (isRecord(sinkData)) {
        if (Object.prototype.hasOwnProperty.call(sinkData, 'next_state')) {
          nextState = coerceState(sinkData.next_state);
        }
        if (Object.prototype.hasOwnProperty.call(sinkData, 'batch')) {
          batchPayload = coercePayload(sinkData.batch);
        }
      }

      if (nextState !== currentState) {
        commitStateValue({ scope: 'workspace', key: modelKey, value: nextState });
      }

      if (Array.isArray(batchPayload)) {
        const { enqueueScriptBatch } = await import('./queue.lazy');
        void enqueueScriptBatch(batchPayload as Batch);
      }

      const renderFinal = await submitScriptComputeJob(
        moduleId,
        { mode: 'render', state: nextState },
        {
          source,
          traceId: typeof context.traceId === 'string' ? context.traceId : undefined,
        },
      );
      if (!renderFinal.ok) {
        setScriptPanelViewState(stateKey, { status: 'error', error: { message: renderFinal.message } });
        return;
      }
      setScriptPanelViewState(stateKey, scriptSinkFromOutput(renderFinal.output));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setScriptPanelViewState(stateKey, { status: 'error', error: { message } });
      console.error('script.emit handler failed', err);
    }
  });

  registerCommandHandler('ui.agent-settings.open', async () => {
    try {
      const win = typeof window === 'undefined' ? undefined : window;
      const appStore = win?.__UICP_APP_STORE__;
      const setter = appStore?.getState?.().setAgentSettingsOpen;
      if (typeof setter === 'function') {
        setter(true);
      }
    } catch (err) {
      console.warn('[uicp] ui.agent-settings.open handler failed', err);
    }
  });

  // Register compute.cancel bridge (kill running compute job by id)
  registerCommandHandler('compute.cancel', async (cmd, _ctx) => {
    try {
      const trimmed = String(cmd).trim();
      const idx = trimmed.indexOf(':');
      const jobId = idx >= 0 ? trimmed.slice(idx + 1).trim() : '';
      if (!jobId) return;
      const cancel = getComputeCancelBridge();
      if (typeof cancel === 'function') {
        await cancel(jobId);
      }
    } catch (err) {
      console.warn('[uicp] compute.cancel handler failed', err);
    }
  });
  
  // Process any batches that arrived before workspace was ready
  if (pendingBatches.length > 0) {
    console.debug(`[adapter.v2] flushing ${pendingBatches.length} pending batch(es)`);
    const toProcess = pendingBatches.splice(0);
    for (const entry of toProcess) {
      applyBatch(entry.batch)
        .then(entry.resolve)
        .catch(entry.reject);
    }
  }
};

const ensureInitialized = () => {
  if (!workspaceRoot) return false;
  if (!windowManagerInstance) {
    windowManagerInstance = createWindowManager(workspaceRoot, {
      onLifecycleEvent: (event: WindowLifecycleEvent) => {
        for (const listener of windowLifecycleListeners) {
          try {
            listener(event);
          } catch (err) {
            console.error('window lifecycle listener error', err);
          }
        }
      },
      shouldDeletePersistedOnClose: (id) => {
        try {
          return isPinnedWindowPredicate ? !isPinnedWindowPredicate(id) : true;
        } catch (err) {
          console.error('pinned predicate failed; defaulting to delete on close', err);
          return true;
        }
      },
    });
  }
  if (!domApplierInstance) {
    domApplierInstance = createDomApplier(windowManagerInstance, {
      enableDeduplication: true,
      getWorkspaceRoot: () => workspaceRoot,
    });
  }
  if (!componentRendererInstance) {
    componentRendererInstance = createComponentRenderer(domApplierInstance);
  }
  return true;
};

/**
 * Apply a batch of operations (main entry point for adapter v2).
 * 
 * This is the thin orchestrator that:
 * 1. Validates envelopes
 * 2. Routes to appropriate modules
 * 3. Aggregates outcomes
 * 4. Emits telemetry
 */
export const applyBatch = async (
  batch: Batch,
  options?: ApplyOptions
): Promise<ApplyOutcome> => {
  const batchId = options?.batchId ?? createId('batch');
  const telemetry = createAdapterTelemetry({
    traceId: options?.runId,
    batchId,
  });

  // Ensure workspace root is registered
  if (!workspaceRoot) {
    const error = new AdapterError('Adapter.Internal', 'Workspace root not registered');
    telemetry.error(AdapterEvents.APPLY_ABORT, error, { reason: 'no_workspace_root' });
    return {
      success: false,
      applied: 0,
      skippedDuplicates: 0,
      deniedByPolicy: 0,
      errors: [error.message],
      batchId,
    };
  }

  telemetry.event(AdapterEvents.APPLY_START, {
    opCount: batch.length,
    runId: options?.runId,
  });

  // Initialize or reuse modules
  if (!ensureInitialized()) {
    const error = new AdapterError('Adapter.Internal', 'Workspace modules not initialized');
    telemetry.error(AdapterEvents.APPLY_ABORT, error, { reason: 'no_modules' });
    return {
      success: false,
      applied: 0,
      skippedDuplicates: 0,
      deniedByPolicy: 0,
      errors: [error.message],
      batchId,
    };
  }
  const windowManager = windowManagerInstance!;
  const domApplier = domApplierInstance!;
  const componentRenderer = componentRendererInstance!;
  const permissionGate = createPermissionGate();

  // Aggregate outcome
  const outcome: ApplyOutcome = {
    success: true,
    applied: 0,
    skippedDuplicates: 0,
    deniedByPolicy: 0,
    errors: [],
    batchId,
    opsHash: options?.opsHash,
  };

  // Process each envelope
  for (let i = 0; i < batch.length; i++) {
    const envelope = batch[i];
    
    try {
      // Validate envelope structure
      const validated = validateEnvelope(envelope);

      // Check permissions by scoped op
      const permission = await permissionGate.require(scopeFromOp(validated.op), {
        operation: validated.op,
        params: validated.params,
        traceId: options?.runId,
        envelopeId: validated.id,
      });

      if (permission === 'denied') {
        telemetry.event(AdapterEvents.PERMISSION_DENIED, {
          op: validated.op,
          envelopeId: validated.id,
        });
        outcome.deniedByPolicy += 1;
        outcome.errors.push(`Permission denied: ${validated.op}`);
        continue;
      }

      // Route to appropriate module
      await routeOperation(validated, {
        windowManager,
        domApplier,
        componentRenderer,
        telemetry,
        outcome,
      });

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome.errors.push(`Op ${i}: ${message}`);
      
      if (error instanceof AdapterError) {
        telemetry.error(AdapterEvents.VALIDATION_ERROR, error, { opIndex: i, op: envelope.op, errorCode: error.code });
      } else {
        telemetry.error(AdapterEvents.VALIDATION_ERROR, error, { opIndex: i, op: envelope.op });
      }

      // Default to continue after errors unless explicitly disabled
      if (options?.allowPartial === false) {
        break;
      }
    }
  }

  // Finalize outcome
  outcome.success = outcome.errors.length === 0;

  telemetry.event(AdapterEvents.APPLY_END, {
    applied: outcome.applied,
    skippedDuplicates: outcome.skippedDuplicates,
    errors: outcome.errors.length,
    success: outcome.success,
  });

  return outcome;
};

/**
 * Route operation to appropriate module.
 * This is where the thin orchestrator delegates to specialized modules.
 */
const routeOperation = async (
  envelope: Envelope,
  context: {
    windowManager: ReturnType<typeof createWindowManager>;
    domApplier: ReturnType<typeof createDomApplier>;
    componentRenderer: ReturnType<typeof createComponentRenderer>;
    telemetry: ReturnType<typeof createAdapterTelemetry>;
    outcome: ApplyOutcome;
  }
): Promise<void> => {
  const { windowManager, domApplier, componentRenderer, telemetry, outcome } = context;

  switch (envelope.op) {
    case 'window.create': {
      const params = envelope.params as Parameters<typeof windowManager.create>[0];
      const { windowId } = await windowManager.create(params);
      telemetry.event(AdapterEvents.WINDOW_CREATE, { windowId });
      // Count create as applied even if it was an idempotent no-op; batch dedupe occurs at queue level.
      outcome.applied += 1;
      break;
    }

    case 'state.set': {
      const params = envelope.params as { scope: StateScope; key: string; value: unknown; windowId?: string };
      commitStateValue({ scope: params.scope, key: params.key, value: params.value, windowId: params.windowId });
      outcome.applied += 1;
      break;
    }

    case 'state.patch': {
      const params = envelope.params as OperationParamMap['state.patch'];
      const scope = params.scope;
      const winId = params.windowId;
      if (scope === 'window' && !winId) {
        throw new AdapterError('Adapter.ValidationFailed', 'state.patch window scope requires windowId');
      }
      const currentValue = readStateValue(scope, params.key, winId);
      const nextValue = applyStatePatchOps(currentValue, params.ops);
      if (valuesEqual(currentValue, nextValue)) {
        break;
      }
      commitStateValue({ scope, key: params.key, value: nextValue, windowId: winId });
      outcome.applied += 1;
      break;
    }

    case 'state.get': {
      // Ephemeral read; does not contribute to applied count
      // Intentionally no-op in v2 lifecycle.
      break;
    }

    case 'state.watch': {
      const params = envelope.params as { scope: StateScope; key: string; selector: string; mode?: 'replace' | 'append'; windowId?: string };
      const scope = params.scope;
      const key = params.key;
      const selector = params.selector;
      const mode = params.mode ?? 'replace';
      const winId = params.windowId;

      // Enforce windowId for window scope
      if (scope === 'window' && !winId) {
        throw new AdapterError('Adapter.ValidationFailed', 'state.watch window scope requires windowId');
      }

      const bucket = watcherRegistry.get(scope)!;
      const storeKey = stateStoreKey(scope, key, winId);
      let set = bucket.get(storeKey);
      if (!set) {
        set = new Set();
        bucket.set(storeKey, set);
      }

      const render = (value: unknown) => {
        try {
          const record = winId ? windowManager.getRecord(winId) : null;
          const searchRoot = record?.content ?? workspaceRoot ?? document;
          const target = searchRoot.querySelector(selector) as HTMLElement | null;
          if (!target) return; // Target may not exist yet; render will retry on future updates

          // Helper: convert arbitrary data to safe HTML
          const toHtml = (v: unknown): string => {
            if (Array.isArray(v)) {
              if (v.length === 0) return '';
              if (v.some(isRecord)) {
                const cols = Array.from(new Set(v.flatMap((row) => (isRecord(row) ? Object.keys(row) : []))));
                const header = '<thead><tr>' + cols.map((c) => `<th class="px-2 py-1 text-left text-xs text-slate-500">${escapeHtml(c)}</th>`).join('') + '</tr></thead>';
                const body = '<tbody>' + v.map((row) => {
                  const cells = cols.map((c) => {
                    const cellValue = isRecord(row) ? row[c] : undefined;
                    return `<td class="px-2 py-1 text-sm">${escapeHtml(String(cellValue ?? ''))}</td>`;
                  });
                  return `<tr>${cells.join('')}</tr>`;
                }).join('') + '</tbody>';
                return `<table class="w-full divide-y divide-slate-200">${header}${body}</table>`;
              }
              return '<ul>' + v.map((it) => `<li>${escapeHtml(String(it))}</li>`).join('') + '</ul>';
            }
            if (isRecord(v)) {
              return `<pre class="text-xs">${escapeHtml(JSON.stringify(v, null, 2))}</pre>`;
            }
            return escapeHtml(String(v ?? ''));
          };

          // Slot-aware rendering: data-slot="loading|empty|error|ready"
          const slotLoading = target.querySelector('[data-slot="loading"]') as HTMLElement | null;
          const slotEmpty = target.querySelector('[data-slot="empty"]') as HTMLElement | null;
          const slotError = target.querySelector('[data-slot="error"]') as HTMLElement | null;
          const slotReady = target.querySelector('[data-slot="ready"]') as HTMLElement | null;

          const hasSlots = Boolean(slotLoading || slotEmpty || slotError || slotReady);

          const show = (el: HTMLElement | null, visible: boolean) => {
            if (!el) return;
            el.style.display = visible ? '' : 'none';
          };

          type SinkShape = { status?: string; data?: unknown; error?: unknown; html?: unknown };
          const shape = isRecord(value) ? (value as SinkShape) : undefined;
          const status = (shape && typeof shape.status === 'string') ? shape.status : 'ready';
          const payload = shape && 'data' in shape ? shape.data : value;
          const htmlFromSink = shape && typeof shape.html === 'string' ? shape.html : null;
          const errorRaw = shape?.error;
          const errorText = (() => {
            if (errorRaw == null) return null;
            if (isRecord(errorRaw) && typeof errorRaw.message === 'string') {
              return errorRaw.message;
            }
            return String(errorRaw);
          })();

          const isEmpty = (d: unknown): boolean => {
            if (d == null) return true;
            if (Array.isArray(d)) return d.length === 0;
            if (typeof d === 'string') return d.trim().length === 0;
            if (isRecord(d)) return Object.keys(d).length === 0;
            return false;
          };

          if (hasSlots) {
            if (status === 'loading') {
              show(slotLoading, true);
              show(slotError, false); show(slotEmpty, false); show(slotReady, false);
              return;
            }
            if (status === 'error') {
              if (slotError) {
                if (errorText) slotError.textContent = errorText;
              }
              show(slotError, true);
              show(slotLoading, false); show(slotEmpty, false); show(slotReady, false);
              return;
            }

            if (isEmpty(payload)) {
              show(slotEmpty, true);
              show(slotLoading, false); show(slotError, false); show(slotReady, false);
              return;
            }

            // Ready with data
            if (slotReady) {
              const readyTarget = `${selector} [data-slot="ready"]`;
              const windowForApply = winId ?? (record?.id ?? '');
              if (htmlFromSink) {
                // Use DomApplier to sanitize applet-provided HTML into the ready slot
                void domApplier.apply({ windowId: windowForApply, target: readyTarget, html: htmlFromSink, mode: 'set', sanitize: true });
              } else {
                const safeHtml = toHtml(payload);
                void domApplier.apply({ windowId: windowForApply, target: readyTarget, html: safeHtml, mode: 'set', sanitize: true });
              }
            }
            show(slotReady, true);
            show(slotLoading, false); show(slotEmpty, false); show(slotError, false);
            return;
          }

          // Fallback: replace target content with computed HTML
          const html = htmlFromSink ?? toHtml(payload);
          void domApplier.apply({ windowId: winId ?? (record?.id ?? ''), target: selector, html, mode: mode === 'append' ? 'append' : 'set', sanitize: true });
        } catch (err) {
          console.error('state.watch render failed', { selector, err });
        }
      };

      const teardown = () => {
        const bucketNow = watcherRegistry.get(scope)!;
        const listeners = bucketNow.get(storeKey);
        if (!listeners) return;
        listeners.forEach((w) => {
          if (w.selector === selector && w.windowId === winId) listeners.delete(w);
        });
        if (listeners.size === 0) bucketNow.delete(storeKey);
      };

      const entry: StateWatcherEntry = { scope, key, windowId: winId, selector, render, teardown };
      set.add(entry);

      // Fire immediately if a value exists
      const current = readStateValue(scope, key, winId);
      if (current !== undefined) {
        try { render(current); } catch (err) { console.error('state.watch initial render failed', err); }
      }

      outcome.applied += 1;
      break;
    }

    case 'state.unwatch': {
      const params = envelope.params as { scope: StateScope; key: string; selector: string; windowId?: string };
      const scope = params.scope;
      const winId = params.windowId;
      const storeKey = stateStoreKey(scope, params.key, winId);
      const bucket = watcherRegistry.get(scope)!;
      const listeners = bucket.get(storeKey);
      if (listeners) {
        listeners.forEach((w) => {
          if (w.selector === params.selector && w.windowId === winId) listeners.delete(w);
        });
        if (listeners.size === 0) bucket.delete(storeKey);
      }
      outcome.applied += 1;
      break;
    }

    case 'api.call': {
      const params = envelope.params as OperationParamMap['api.call'];
      try {
        const renderForm = (clarifierBody: StructuredClarifierBody, command: Envelope): CommandResult<string> => {
          void (async () => {
            try {
              await renderStructuredClarifier(clarifierBody, command, windowManager);
            } catch (error) {
              console.error('structured clarifier render failed', error);
            }
          })();
          return { success: true, value: 'clarifier-rendered' };
        };

        // Into: seed loading state before dispatch
        const into = params.into;
        const correlationId = into?.correlationId ?? envelope.idempotencyKey ?? createId('api');
        if (into) {
          commitStateValue({
            scope: into.scope,
            key: into.key,
            windowId: into.windowId,
            value: { status: 'loading', correlationId, data: null, error: null },
          });
        }

        // Execute via shared API dispatcher
        const result = await routeApiCall(params, envelope, {}, renderForm);
        if (result.success) {
          outcome.applied += 1;
          if (into) {
            const isCompute = typeof params.url === 'string' && params.url.startsWith('uicp://compute.call');
            const responseData = result.data;
            if (isCompute) {
              commitStateValue({
                scope: into.scope,
                key: into.key,
                windowId: into.windowId,
                value: {
                  status: 'ready',
                  correlationId,
                  html: typeof responseData === 'string' ? responseData : '',
                },
              });
            } else {
              commitStateValue({
                scope: into.scope,
                key: into.key,
                windowId: into.windowId,
                value: {
                  status: 'ready',
                  correlationId,
                  data: responseData ?? null,
                  error: null,
                },
              });
            }
          }
        } else {
          outcome.errors.push(`api.call failed: ${result.error}`);
          if (into) {
            commitStateValue({
              scope: into.scope,
              key: into.key,
              windowId: into.windowId,
              value: { status: 'error', correlationId, error: String(result.error) },
            });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        outcome.errors.push(`api.call error: ${message}`);
      }
      break;
    }

    case 'window.update': {
      const params = envelope.params as {
        id: string;
        title?: string;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        zIndex?: number;
      };
      // Ensure window exists (auto-create)
      if (!windowManager.exists(params.id)) {
        const title = typeof params.title === 'string' && params.title.trim() ? params.title : params.id;
        await windowManager.create({ id: params.id, title });
        telemetry.event(AdapterEvents.WINDOW_CREATE, { windowId: params.id, synthetic: true });
        // Persist synthetic window.create
        void persistCommand({ op: 'window.create', params: { id: params.id, title } });
      }
      const record = windowManager.getRecord(params.id);
      if (!record) {
        throw new AdapterError('Adapter.WindowNotFound', `Window not found: ${params.id}`);
      }
      if (typeof params.title === 'string') {
        record.titleText.textContent = params.title;
      }
      // Delegate geometry changes to existing APIs where possible
      if (typeof params.x === 'number' || typeof params.y === 'number') {
        const x = typeof params.x === 'number' ? params.x : 0;
        const y = typeof params.y === 'number' ? params.y : 0;
        await windowManager.move({ id: params.id, x, y });
      }
      if (typeof params.width === 'number' && typeof params.height === 'number') {
        await windowManager.resize({ id: params.id, width: params.width, height: params.height });
      }
      telemetry.event(AdapterEvents.WINDOW_UPDATE, { windowId: params.id });
      outcome.applied += 1;
      break;
    }

    case 'window.move': {
      const params = envelope.params as Parameters<typeof windowManager.move>[0];
      const { applied } = await windowManager.move(params);
      if (applied) outcome.applied += 1;
      break;
    }

    case 'window.resize': {
      const params = envelope.params as Parameters<typeof windowManager.resize>[0];
      const { applied } = await windowManager.resize(params);
      if (applied) outcome.applied += 1;
      break;
    }

    case 'window.focus': {
      const params = envelope.params as Parameters<typeof windowManager.focus>[0];
      const { applied } = await windowManager.focus(params);
      if (applied) outcome.applied += 1;
      break;
    }

    case 'window.close': {
      const params = envelope.params as Parameters<typeof windowManager.close>[0];
      const { applied } = await windowManager.close(params);
      telemetry.event(AdapterEvents.WINDOW_CLOSE, { windowId: params.id });
      // Purge any window-scoped watchers for this window
      const bucket = watcherRegistry.get('window');
      if (bucket) {
        for (const key of Array.from(bucket.keys())) {
          if (key.startsWith(`${params.id}:`)) {
            bucket.delete(key);
          }
        }
      }
      if (applied) outcome.applied += 1;
      break;
    }

    case 'dom.set':
    case 'dom.replace':
    case 'dom.append': {
      const base = envelope.params as Parameters<typeof domApplier.apply>[0];
      // Map op -> mode explicitly so DomApplier does not default to 'set'
      const mode: 'set' | 'replace' | 'append' =
        envelope.op === 'dom.set' ? 'set' : envelope.op === 'dom.replace' ? 'replace' : 'append';
      const params = { ...base, mode } as Parameters<typeof domApplier.apply>[0];
      // Auto-create window if it doesn't exist
      if (!windowManager.exists(params.windowId)) {
        await windowManager.create({ id: params.windowId, title: params.windowId });
        telemetry.event(AdapterEvents.WINDOW_CREATE, { windowId: params.windowId, synthetic: true });
        // Persist synthetic window.create
        void persistCommand({ op: 'window.create', params: { id: params.windowId, title: params.windowId } });
      }
      const result = await domApplier.apply(params);
      telemetry.event(AdapterEvents.DOM_APPLY, {
        windowId: params.windowId,
        target: params.target,
        mode: params.mode,
        applied: result.applied,
        skipped: result.skippedDuplicates,
      });
      outcome.applied += result.applied;
      outcome.skippedDuplicates += result.skippedDuplicates;
      break;
    }

    case 'component.render': {
      const params = envelope.params as Parameters<typeof componentRenderer.render>[0];
      if (!windowManager.exists(params.windowId)) {
        await windowManager.create({ id: params.windowId, title: params.windowId });
        telemetry.event(AdapterEvents.WINDOW_CREATE, { windowId: params.windowId, synthetic: true });
        void persistCommand({ op: 'window.create', params: { id: params.windowId, title: params.windowId } });
        outcome.applied += 1;
      }
      // Emit unknown-component telemetry if renderer doesn't recognize the type
      try {
        if (!componentRenderer.isKnownType(params.type)) {
          telemetry.event(AdapterEvents.COMPONENT_UNKNOWN, { type: params.type });
        }
      } catch {
        // best-effort; do not block on telemetry helpers
      }
      await componentRenderer.render(params);
      telemetry.event(AdapterEvents.COMPONENT_RENDER, { windowId: params.windowId, type: params.type });
      outcome.applied++;

      // Special handling for script.panel lifecycle
      if (params.type.toLowerCase() === 'script.panel') {
        const props = asRecord(params.props);
        const panelId = typeof props.id === 'string' && props.id.trim() ? props.id.trim() : createId('panel');
        const moduleId = typeof props.module === 'string' && props.module.trim() ? props.module.trim() : '';
        const stateKey =
          typeof props.stateKey === 'string' && props.stateKey.trim()
            ? props.stateKey.trim()
            : `panels.${panelId}.view`;
        const inlineSource = typeof props.source === 'string' && props.source.trim() ? props.source : undefined;
        const sourceKeyRef =
          typeof props.sourceKey === 'string' && props.sourceKey.trim() ? props.sourceKey.trim() : undefined;
        const modelKey = `panels.${panelId}.model`;
        const configKey = `panels.${panelId}.config`;
        const selector = `${params.target} .uicp-script-panel[data-script-panel-id="${panelId}"]`;

        commitStateValue({
          scope: 'workspace',
          key: configKey,
          value: { module: moduleId, source: inlineSource, sourceKey: sourceKeyRef, stateKey, windowId: params.windowId },
        });

        setScriptPanelViewState(stateKey, { status: 'loading' });

        const watchEnvelope: Envelope<'state.watch'> = {
          op: 'state.watch',
          params: { scope: 'workspace', key: stateKey, selector, windowId: params.windowId, mode: 'replace' },
          windowId: params.windowId,
        };
        await routeOperation(
          watchEnvelope,
          { windowManager, domApplier, componentRenderer, telemetry, outcome },
        );

        if (!moduleId) {
          const message = 'script.panel props.module must be a module identifier string';
          console.error(message);
          setScriptPanelViewState(stateKey, { status: 'error', error: { message } });
          break;
        }

        const toStateString = (value: unknown): string => {
          if (typeof value === 'string') return value;
          if (isRecord(value) && typeof value.state === 'string') return value.state;
          return '';
        };

        try {
          const runJob = async (
            mode: 'init' | 'render',
            extras: { state?: string } = {},
          ): Promise<ScriptSink> => {
            const input: Record<string, unknown> = { mode };
            if (extras.state !== undefined) {
              input.state = extras.state;
            }
            const sourceForJob = resolveScriptSource(inlineSource, sourceKeyRef);
            const final = await submitScriptComputeJob(moduleId, input, {
              source: sourceForJob,
              traceId: envelope.traceId ?? envelope.id,
            });
            if (!final.ok) {
              return { status: 'error', error: { message: final.message } };
            }
            return scriptSinkFromOutput(final.output);
          };

          let currentState = toStateString(readStateValue('workspace', modelKey, undefined));

          if (!currentState) {
            const initSink = await runJob('init');
            if (initSink.status === 'error') {
              setScriptPanelViewState(stateKey, initSink);
              commitStateValue({ scope: 'workspace', key: modelKey, value: null });
              break;
            }
            if (typeof initSink.data === 'string') {
              currentState = initSink.data;
            } else if (initSink.data != null) {
              try {
                currentState = JSON.stringify(initSink.data);
              } catch {
                currentState = '';
              }
            }
            commitStateValue({ scope: 'workspace', key: modelKey, value: currentState });
          }

          const renderSink = await runJob('render', { state: currentState });
          setScriptPanelViewState(stateKey, renderSink);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setScriptPanelViewState(stateKey, { status: 'error', error: { message } });
          console.error('script.panel lifecycle failed', err);
        }
      }
      break;
    }

    case 'component.update': {
      const params = envelope.params as Parameters<typeof componentRenderer.update>[0];
      await componentRenderer.update(params);
      telemetry.event(AdapterEvents.COMPONENT_RENDER, { action: 'update', id: params.id });
      outcome.applied += 1;
      break;
    }

    case 'component.destroy': {
      const params = envelope.params as Parameters<typeof componentRenderer.destroy>[0];
      await componentRenderer.destroy(params);
      telemetry.event(AdapterEvents.COMPONENT_RENDER, { action: 'destroy', id: params.id });
      outcome.applied += 1;
      break;
    }

    

    case 'txn.cancel': {
      // Reset all state stores
      for (const store of stateStore.values()) {
        store.clear();
      }
      // Close all windows if any exist
      const allWindows = windowManager.list();
      if (allWindows.length > 0) {
        for (const win of allWindows) {
          await windowManager.close({ id: win.id });
        }
      }
      // txn.cancel successfully applied even if workspace was empty
      outcome.applied += 1;
      break;
    }

    

    default:
      throw new AdapterError('Adapter.ValidationFailed', 'Unknown operation');
  }
};

/**
 * Get workspace root (for testing/debugging)
 */
export const getWorkspaceRoot = (): HTMLElement | null => {
  return workspaceRoot;
};

/**
 * Utilities for external callers
 */
export const listWorkspaceWindows = (): Array<{ id: string; title: string }> => {
  return windowManagerInstance ? windowManagerInstance.list() : [];
};

export const closeWorkspaceWindow = async (id: string): Promise<void> => {
  if (!windowManagerInstance) return;
  await windowManagerInstance.close({ id });
};

/**
 * Apply a single envelope (test-friendly wrapper).
 * Routes to applyBatch with a single-item batch.
 * Used by tests that need to mock per-envelope execution.
 */
export const applyEnvelope = async (
  envelope: Envelope,
  options?: ApplyOptions
): Promise<{ success: boolean; error?: string }> => {
  const result = await applyBatch([envelope], options);
  if (result.success && result.applied === 1) {
    return { success: true };
  }
  const error = result.errors[0] ?? 'Unknown error';
  return { success: false, error };
};

export const registerWindowLifecycle = (listener: WindowLifecycleListener): (() => void) => {
  windowLifecycleListeners.add(listener);
  return () => {
    windowLifecycleListeners.delete(listener);
  };
};

/**
 * Clear workspace root (for testing cleanup)
 */
export const clearWorkspaceRoot = (): void => {
  try {
    if (workspaceRoot && workspaceRoot.parentNode) {
      workspaceRoot.parentNode.removeChild(workspaceRoot);
    }
  } catch {
    // ignore detach errors in tests/SSR
  }
  workspaceRoot = null;
  workspaceReady = false;
  windowManagerInstance = null;
  domApplierInstance = null;
  componentRendererInstance = null;
};

/**
 * Defer batch application until workspace root is registered.
 * Returns a Promise if batch is queued, null if workspace is ready.
 * 
 * WHY: Prevents "Workspace root not registered" errors when batches arrive
 * before Desktop.tsx mounts and calls registerWorkspaceRoot().
 */
export const deferBatchIfNotReady = (batch: Batch): Promise<ApplyOutcome> | null => {
  if (workspaceReady) return null;
  
  console.debug(`[adapter.v2] workspace not ready, queuing batch with ${batch.length} op(s)`);
  return new Promise((resolve, reject) => {
    pendingBatches.push({ batch, resolve, reject });
  });
};

/**
 * Reset workspace: clear all windows, components, and state.
 * Optionally delete files (not implemented in v2 yet for safety).
 * 
 * WHY: Reset handlers execute synchronously for backward compatibility with code
 * that doesn't await resetWorkspace(). Window cleanup happens async in background.
 */
export const resetWorkspace = (options?: { deleteFiles?: boolean }): void => {
  // Clear all state stores
  for (const store of stateStore.values()) {
    store.clear();
  }
  
  // Clear workspace root DOM if exists
  if (workspaceRoot) {
    workspaceRoot.innerHTML = '';
  }
  
  // Invoke reset handlers synchronously (includes batch dedupe store reset)
  // INVARIANT: Handlers must complete before window cleanup
  for (const handler of resetHandlers) {
    try {
      handler();
    } catch (error) {
      console.error('workspace reset handler failed', error);
    }
  }
  
  // Close all windows asynchronously (don't block on this)
  if (windowManagerInstance) {
    const allWindows = windowManagerInstance.list();
    void Promise.all(allWindows.map(win => windowManagerInstance!.close({ id: win.id })));
  }
  
  if (options?.deleteFiles) {
    console.warn('deleteFiles=true requested, but file deletion is not implemented in v2 for safety.');
  }
};

/**
 * Replay workspace from persisted commands.
 * Delegates to persistence module which handles Tauri IPC.
 */
export const replayWorkspace = async (): Promise<{ applied: number; errors: string[] }> => {
  const applyCommand = async (
    command: Envelope,
    _ctx: { runId?: string },
  ): Promise<{ success: boolean; error?: string }> => {
    return await applyEnvelope(command);
  };

  return await replayWorkspaceImpl(applyCommand, stateStore);
};

/**
 * Register a handler to be called when workspace is reset.
 * Returns an unlisten function.
 */
export const addWorkspaceResetHandler = (handler: () => void): (() => void) => {
  resetHandlers.add(handler);
  return () => resetHandlers.delete(handler);
};

// Map op -> permission scope (keep in this file for now, move to schema if it grows)
function scopeFromOp(op: Envelope['op']): PermissionScope {
  switch (op) {
    case 'window.create':
    case 'window.move':
    case 'window.resize':
    case 'window.focus':
    case 'window.close':
    case 'window.update':
      return 'window';
    case 'dom.set':
    case 'dom.replace':
    case 'dom.append':
      return 'dom';
    case 'component.render':
      return 'components';
    case 'component.update':
    case 'component.destroy':
      return 'components';
    case 'state.set':
    case 'state.get':
    case 'state.patch':
    case 'txn.cancel':
    case 'api.call':
      return 'dom'; // Map new ops to dom scope (permissions always grant anyway)
    default:
      // Unknown ops never reach permission, they throw earlier
      return 'dom';
  }
}
