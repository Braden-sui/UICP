/**
 * Event Delegation & Template Evaluation
 * 
 * WHY: Handles all DOM event delegation and template token substitution.
 * INVARIANT: Event handlers must remain pure; side effects live at boundaries.
 * SAFETY: All template evaluation preserves context isolation.
 */

import type { Batch } from "./schemas";
import { enqueueBatch } from "./queue";
import type { StateScope } from "./adapter.types";

// Safety caps for data-command attributes
const MAX_DATA_COMMAND_LEN = 32768; // 32KB serialized JSON
const MAX_TEMPLATE_TOKENS = 16; // maximum {{token}} substitutions per element

type UIEventCallback = (event: Event, payload: Record<string, unknown>) => void;
let uiEventCallback: UIEventCallback | null = null;

// Generic opaque command handler registry
type CommandHandler = (command: string, ctx: Record<string, unknown>) => Promise<void> | void;
const commandHandlers = new Map<string, CommandHandler>();

export const registerCommandHandler = (prefix: string, handler: CommandHandler): void => {
  commandHandlers.set(prefix, handler);
};

export const registerUIEventCallback = (callback: UIEventCallback) => {
  uiEventCallback = callback;
};

/**
 * Template evaluation for JSON command attributes.
 * Replaces string values like "{{value}}" or "{{form.field}}" using the event payload.
 * 
 * WHY: Enables data-command templates to reference dynamic form/state values.
 * INVARIANT: Only evaluates {{...}} patterns; rest of structure preserved.
 */
export const evalTemplates = (input: unknown, ctx: Record<string, unknown>): unknown => {
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

/**
 * Central dispatcher for data-command payloads.
 * Accepts a JSON string representing a Batch or a pre-parsed value.
 * 
 * WHY: Single entry point for all UI command execution ensures consistent error handling.
 * INVARIANT: All commands routed through queue for serialization + telemetry.
 */
export const handleCommand = async (
  command: string | unknown,
  ctx: Record<string, unknown>,
): Promise<void> => {
  if (typeof command === 'string') {
    if (command.length > MAX_DATA_COMMAND_LEN) {
      throw new Error(`E-UICP-300: data-command exceeds size cap: ${command.length} > ${MAX_DATA_COMMAND_LEN}`);
    }
    const trimmed = command.trim();
    const first = trimmed[0];
    const looksJson = first === '[' || first === '{';
    if (looksJson) {
      const tokenMatches = trimmed.match(/\{\{\s*[^}]+\s*\}\}/g);
      const tokenCount = tokenMatches ? tokenMatches.length : 0;
      if (tokenCount > MAX_TEMPLATE_TOKENS) {
        throw new Error(`E-UICP-300: data-command contains too many template tokens: ${tokenCount} > ${MAX_TEMPLATE_TOKENS}`);
      }
      const raw = JSON.parse(trimmed) as unknown;
      const evaluated = evalTemplates(raw, ctx);
      const batchCandidate = Array.isArray(evaluated)
        ? (evaluated as Batch)
        : ((evaluated as { batch?: unknown })?.batch as Batch | undefined);
      if (!batchCandidate || !Array.isArray(batchCandidate) || batchCandidate.length === 0) {
        throw new Error('E-UICP-301: data-command evaluated to an empty or invalid batch');
      }
      void enqueueBatch(batchCandidate);
      return;
    }

    // Opaque command path: namespace.action[:payload]
    const colonIdx = trimmed.indexOf(':');
    const spaceIdx = trimmed.indexOf(' ');
    const splitIdx = colonIdx >= 0 ? colonIdx : spaceIdx >= 0 ? spaceIdx : trimmed.length;
    const prefix = trimmed.slice(0, splitIdx);
    const handler = commandHandlers.get(prefix);
    if (handler) {
      await handler(trimmed, ctx);
      return;
    }
    // Default: emit as intent back to orchestrator
    const windowId = (ctx as { windowId?: string }).windowId;
    const defaultBatch: Batch = [
      {
        op: 'api.call',
        params: {
          method: 'POST',
          url: 'uicp://intent',
          body: {
            text: `ui command: ${trimmed}`,
            windowId,
            command: trimmed,
          },
        },
      },
    ];
    void enqueueBatch(defaultBatch);
    return;
  }

  const evaluated = evalTemplates(command, ctx);
  const batchCandidate = Array.isArray(evaluated)
    ? (evaluated as Batch)
    : ((evaluated as { batch?: unknown })?.batch as Batch | undefined);
  if (!batchCandidate || !Array.isArray(batchCandidate) || batchCandidate.length === 0) {
    throw new Error('E-UICP-301: data-command evaluated to an empty or invalid batch');
  }
  void enqueueBatch(batchCandidate);
};

/**
 * Creates event delegation handler for workspace root.
 * 
 * WHY: Single root listener handles all descendant events (click, input, submit, change).
 * INVARIANT: Must be attached with capture=true to intercept before React handlers.
 * 
 * @param workspaceRoot - Root element for event delegation
 * @param setStateValue - State mutation function for data-state-* binding
 */
export const createDelegatedEventHandler = (
  workspaceRoot: HTMLElement,
  setStateValue: (params: { scope: StateScope; key: string; value: unknown; windowId?: string }) => void,
) => {
  return (event: Event) => {
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
        void handleCommand(commandJson, {
          ...payload,
          value: (target as HTMLInputElement | HTMLTextAreaElement).value,
          form: (payload.formData as Record<string, unknown> | undefined) ?? {},
        }).catch((err) => {
          const original = err instanceof Error ? err : new Error(String(err));
          console.error('E-UICP-301: failed to process data-command JSON', original);
        });
      }
    }

    // Invoke callback if registered
    if (uiEventCallback) {
      uiEventCallback(event, payload);
    }
  };
};
