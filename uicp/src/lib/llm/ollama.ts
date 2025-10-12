import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

// Streamed event union returned by the async iterator
export type StreamEvent =
  | { type: 'content'; channel?: string; text: string }
  | { type: 'tool_call'; index: number; id?: string; name?: string; arguments: unknown; isDelta: boolean }
  | { type: 'return'; channel?: string; name?: string; result: unknown }
  | { type: 'done' };

export type ChatMessage = { role: string; content: string | Record<string, unknown> };
export type ToolSpec = unknown; // pass-through JSON (e.g., OpenAI-compatible tool schema)

// Extracts content/tool-call deltas from a single OpenAI/Ollama-compatible chunk object
export function extractEventsFromChunk(input: unknown): StreamEvent[] {
  if (typeof input === 'string') {
    return input.length > 0 ? [{ type: 'content', text: input }] : [];
  }
  const asRecord = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== 'object') return null;
    return value as Record<string, unknown>;
  };

  const root = asRecord(input);
  if (!root) return [];
  const out: StreamEvent[] = [];

  const pushContent = (channel: string | undefined, text: string) => {
    if (text.trim().length === 0) return;
    out.push({ type: 'content', channel, text });
  };

  const emitContentValue = (channel: string | undefined, value: unknown) => {
    if (typeof value === 'string') {
      pushContent(channel, value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry) => {
        if (typeof entry === 'string') {
          pushContent(channel, entry);
          return;
        }
        if (entry && typeof entry === 'object') {
          const maybeText =
            typeof (entry as Record<string, unknown>).text === 'string'
              ? ((entry as Record<string, unknown>).text as string)
              : typeof (entry as Record<string, unknown>).value === 'string'
                ? ((entry as Record<string, unknown>).value as string)
                : undefined;
          if (maybeText) {
            pushContent(channel, maybeText);
          }
        }
      });
      return;
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const maybeText =
        typeof record.text === 'string'
          ? record.text
          : typeof record.value === 'string'
            ? record.value
            : undefined;
      if (maybeText) {
        pushContent(channel, maybeText);
      }
    }
  };

  const pushToolCall = (call: unknown, indexFallback = 0) => {
    const record = asRecord(call);
    if (!record) return;
    const fnRecord = asRecord(record.function);
    const name = typeof record.name === 'string' ? record.name : typeof fnRecord?.name === 'string' ? fnRecord.name : undefined;
    const args = record.arguments !== undefined
      ? record.arguments
      : fnRecord?.arguments !== undefined
        ? fnRecord.arguments
        : undefined;
    const id = typeof record.id === 'string' ? record.id : undefined;
    const index = typeof record.index === 'number' ? record.index : indexFallback;
    if (!name && args === undefined && !id) return;
    out.push({ type: 'tool_call', index, id, name, arguments: args, isDelta: true });
  };

  const choicesRaw = root['choices'];
  const choices = Array.isArray(choicesRaw) ? choicesRaw : [];
  for (const ch of choices) {
    const record = asRecord(ch);
    const deltaRecord = asRecord(record?.delta) ?? asRecord(record?.message) ?? asRecord(record?.update);
    if (!deltaRecord) continue;

    const channelValue = deltaRecord.channel;
    const channel: string | undefined = typeof channelValue === 'string' ? channelValue : undefined;
    const contentValue = deltaRecord.content;
    emitContentValue(channel, contentValue);

    // OpenAI-style tool calls (can arrive incrementally)
    const deltaToolCalls = Array.isArray(deltaRecord.tool_calls) ? deltaRecord.tool_calls : [];
    deltaToolCalls.forEach((tc, index) => pushToolCall(tc, index));
    const deltaToolCall = deltaRecord.tool_call;
    if (deltaToolCall) {
      pushToolCall(deltaToolCall);
    }
  }

  const deltaRecord = asRecord(root['delta']);
  if (Array.isArray(deltaRecord?.tool_calls)) {
    deltaRecord.tool_calls.forEach((tc: unknown, index: number) => pushToolCall(tc, index));
  }

  if (Array.isArray(root['tool_calls'])) {
    (root['tool_calls'] as unknown[]).forEach((tc: unknown, index: number) => pushToolCall(tc, index));
  }

  if (root['content'] !== undefined) {
    emitContentValue(undefined, root['content']);
  }

  if (root['message'] && typeof root['message'] === 'object') {
    const msgRecord = root['message'] as Record<string, unknown>;
    if (msgRecord['content'] !== undefined) {
      emitContentValue(undefined, msgRecord['content']);
    }
  }

  return out;
}

// Minimal async queue to bridge event callbacks into an async iterator
class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: (T | Error | symbol)[] = [];
  private resolvers: Array<(v: IteratorResult<T>) => void> = [];
  private readonly END = Symbol('end');
  private readonly MAX_BUFFER_SIZE = 2000;

  push(value: T) {
    if (this.resolvers.length) {
      const res = this.resolvers.shift()!;
      res({ value, done: false });
    } else {
      // Drop oldest event if buffer is full to prevent OOM
      if (this.buffer.length >= this.MAX_BUFFER_SIZE) {
        this.buffer.shift();
      }
      this.buffer.push(value);
    }
  }

  fail(err: Error) {
    if (this.resolvers.length) {
      const res = this.resolvers.shift()!;
      // surface the error to the consumer on next()
      res(Promise.reject(err) as unknown as IteratorResult<T>);
    } else {
      this.buffer.push(err);
    }
  }

  end() {
    if (this.resolvers.length) {
      const res = this.resolvers.shift()!;
      res({ value: undefined as unknown as T, done: true });
    } else {
      this.buffer.push(this.END);
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.buffer.length) {
      const item = this.buffer.shift()!;
      if (item === this.END) return { value: undefined as unknown as T, done: true };
      if (item instanceof Error) throw item;
      return { value: item as T, done: false };
    }

    return new Promise<IteratorResult<T>>((resolve) => this.resolvers.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
    };
  }
}

// Primary streaming function. Returns an async iterator of StreamEvent.
type StreamRequestOptions = {
  requestId?: string;
  signal?: AbortSignal;
  format?: 'json' | string;
  responseFormat?: unknown;
  toolChoice?: unknown;
};

export function streamOllamaCompletion(
  messages: ChatMessage[],
  model?: string,
  tools?: ToolSpec[],
  options?: StreamRequestOptions,
): AsyncIterable<StreamEvent> {
  const queue = new AsyncQueue<StreamEvent>();
  let unlisten: UnlistenFn | null = null;
  let started = false;
  const requestId = options?.requestId ?? (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
  let abortHandler: ((this: AbortSignal, ev: Event) => any) | undefined;
  const readMs = (key: string, fallback: number): number => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw = (import.meta as any)?.env?.[key] as unknown;
      const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : undefined;
      return Number.isFinite(n) && (n as number) > 0 ? (n as number) : fallback;
    } catch {
      return fallback;
    }
  };
  const DEFAULT_CHAT_TIMEOUT_MS = readMs('VITE_CHAT_DEFAULT_TIMEOUT_MS', 35_000);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  // Attach the event listener first to avoid missing early chunks
  void listen('ollama-completion', (event) => {
    const payload = event.payload as { done?: boolean; delta?: unknown; kind?: string } | undefined;
    if (!payload) return;
    if (payload.done) {
      queue.push({ type: 'done' });
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      if (unlisten) {
        try {
          unlisten();
        } catch (err) {
          // ignore teardown errors
          void err;
        }
        unlisten = null;
      }
      // Clear active request marker on normal completion
      if (activeRequestId === requestId) {
        activeRequestId = null;
      }
      queue.end();
      return;
    }
    if (payload.delta !== undefined) {
      // Some providers stream raw text segments; attempt JSON parse but gracefully fall back to text.
      let chunk: unknown = payload.delta;
      if (typeof payload.delta === 'string') {
        try {
          chunk = JSON.parse(payload.delta);
        } catch {
          // Fallback to raw text chunk when not JSON
          chunk = payload.delta;
        }
      }
      try {
        let events = extractEventsFromChunk(chunk);
        const kind = payload.kind ? String(payload.kind).toLowerCase() : undefined;
        if (kind === 'json') {
          // Structured JSON lines tagged by backend
          events = events.map((e) => (e.type === 'content' ? { ...e, channel: 'json' } : e));
        } else if (kind === 'text') {
          // Non-JSON lines (status, prose) — keep them off primary JSON channels
          events = events.map((e) => (e.type === 'content' ? { ...e, channel: 'text' } : e));
        }
        for (const e of events) queue.push(e);
      } catch (err) {
        queue.fail(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }).then((off) => {
    unlisten = off;
    // Fire the backend request after listener is ready
    if (!started) {
      started = true;
      // Do not await: the command resolves after the stream finishes
      // Normalize roles for Ollama Cloud: 'developer' is not a valid chat role, map to 'system'.
      const normalizedMessages = messages.map((m) =>
        typeof m?.role === 'string' && m.role.toLowerCase() === 'developer' ? { ...m, role: 'system' } : m,
      );
      const requestPayload: Record<string, unknown> = {
        messages: normalizedMessages,
        stream: true,
      };
      if (typeof model === 'string' && model.trim().length > 0) {
        requestPayload.model = model.trim();
      }
      if (tools !== undefined) {
        requestPayload.tools = tools;
      }
      if (options?.format !== undefined) {
        requestPayload.format = options.format;
      }
      if (options?.responseFormat !== undefined) {
        requestPayload.response_format = options.responseFormat;
      }
      if (options?.toolChoice !== undefined) {
        requestPayload.tool_choice = options.toolChoice;
      }

      // Mark this requestId as the active in-flight chat stream
      activeRequestId = requestId;

      void invoke('chat_completion', {
        requestId,
        request: requestPayload,
      }).catch((err) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }
        queue.fail(err instanceof Error ? err : new Error(String(err)));
        queue.end();
        // Clear active marker on error as well
        if (activeRequestId === requestId) {
          activeRequestId = null;
        }
      });
    }
    // If caller supplied an AbortSignal, wire it to backend cancel
    if (options?.signal && typeof options.signal.addEventListener === 'function') {
      abortHandler = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }
        try {
          void invoke('cancel_chat', { requestId });
        } catch {
          // ignore
        }
        if (unlisten) {
          try { unlisten(); } catch { /* ignore */ }
          unlisten = null;
        }
        // Clear active marker when aborted
        if (activeRequestId === requestId) {
          activeRequestId = null;
        }
        queue.end();
      };
      options.signal.addEventListener('abort', abortHandler, { once: true } as AddEventListenerOptions);
    }
    // Default timeout when no AbortSignal provided: best-effort cancel
    if (!options?.signal) {
      timeoutId = setTimeout(() => {
        try {
          void invoke('cancel_chat', { requestId });
        } catch {
          // ignore
        }
        if (unlisten) {
          try { unlisten(); } catch { /* ignore */ }
          unlisten = null;
        }
        if (activeRequestId === requestId) {
          activeRequestId = null;
        }
        queue.fail(new Error(`LLM timeout after ${DEFAULT_CHAT_TIMEOUT_MS}ms`));
        queue.end();
      }, DEFAULT_CHAT_TIMEOUT_MS);
    }
  }).catch((err) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
    queue.fail(err instanceof Error ? err : new Error(String(err)));
    queue.end();
  });

  // Ensure we cleanup when consumer stops early
  const iterable: AsyncIterable<StreamEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
      return {
        next: () => queue.next(),
        return: async () => {
          if (timeoutId) {
            try { clearTimeout(timeoutId); } catch { /* ignore */ }
            timeoutId = undefined;
          }
          if (unlisten) {
            try {
              unlisten();
            } catch (err) {
              // ignore teardown errors
              void err;
            }
            unlisten = null;
          }
          try {
            // Best-effort backend cancel to stop network usage
            await invoke('cancel_chat', { requestId });
          } catch {
            // ignore
          }
          // Clear active marker on consumer return
          if (activeRequestId === requestId) {
            activeRequestId = null;
          }
          if (options?.signal && abortHandler && typeof options.signal.removeEventListener === 'function') {
            try { options.signal.removeEventListener('abort', abortHandler as any); } catch { /* ignore */ }
          }
          queue.end();
          return { value: undefined as unknown as StreamEvent, done: true };
        },
      } as AsyncIterator<StreamEvent>;
    },
  };

  return iterable;
}

// Track the most recent in-flight chat request id so STOP can cancel promptly.
let activeRequestId: string | null = null;

export async function cancelActiveChat(): Promise<void> {
  const rid = activeRequestId;
  if (!rid) return;
  try {
    await invoke('cancel_chat', { requestId: rid });
  } catch {
    // ignore
  }
}
