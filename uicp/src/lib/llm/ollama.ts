import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { hasTauriBridge, tauriInvoke } from '../bridge/tauri';

// Streamed event union returned by the async iterator
export type StreamEvent =
  | { type: 'content'; channel?: string; text: string }
  | { type: 'tool_call'; index: number; id?: string; name?: string; arguments: unknown; isDelta: boolean }
  | { type: 'return'; channel?: string; name?: string; result: unknown }
  | { type: 'done' };

export type ChatMessage = { role: string; content: string | Record<string, unknown> };
export type ToolSpec = unknown; // pass-through JSON (e.g., OpenAI-compatible tool schema)

export type StreamMeta = {
  role?: 'planner' | 'actor' | 'clarifier';
  profileKey?: string;
  traceId?: string;
  intent?: string;
  planSummary?: string;
  mode?: 'plan' | 'taskSpec';
};

const getLogWindow = (): Window | undefined => {
  if (typeof window === 'undefined') return undefined;
  return window;
};

const emitUiDebug = (event: string, extra?: Record<string, unknown>) => {
  const target = getLogWindow();
  if (!target) return;
  try {
    target.dispatchEvent(
      new CustomEvent('ui-debug-log', {
        detail: { ts: Date.now(), event, ...(extra ?? {}) },
      }),
    );
  } catch (error) {
    console.error(`Failed to emit ui-debug-log ${event}`, error);
  }
};

const truncateForLog = (value: string, max = 4000): string => {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
};

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
          const entryRecord = entry as Record<string, unknown>;
          const entryType = typeof entryRecord.type === 'string' ? entryRecord.type.toLowerCase() : undefined;
          if (entryType === 'tool_call' || entryType === 'tool_call_delta') {
            const deltaRecord = asRecord(entryRecord.delta) ?? {};
            const functionCall =
              asRecord(entryRecord.function) ??
              asRecord(deltaRecord.function_call ?? deltaRecord.function);
            const argumentsValue =
              entryRecord.arguments !== undefined
                ? entryRecord.arguments
                : deltaRecord.arguments !== undefined
                  ? deltaRecord.arguments
                  : functionCall?.arguments;
            const nameValue =
              typeof entryRecord.name === 'string'
                ? entryRecord.name
                : typeof functionCall?.name === 'string'
                  ? functionCall.name
                  : undefined;
            const synthesized = {
              id: typeof entryRecord.id === 'string' ? entryRecord.id : typeof entryRecord.tool_call_id === 'string' ? entryRecord.tool_call_id : undefined,
              name: nameValue,
              arguments: argumentsValue,
              function: functionCall,
            };
            pushToolCall(synthesized);
            return;
          }

          const maybeText =
            typeof entryRecord.text === 'string'
              ? entryRecord.text
              : typeof entryRecord.value === 'string'
                ? entryRecord.value
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
    // WHY: GLM and other providers emit complete tool_calls in the final message object when using tool mode.
    // INVARIANT: We must check message.tool_calls in addition to delta.tool_calls and root.tool_calls.
    if (Array.isArray(msgRecord['tool_calls'])) {
      msgRecord['tool_calls'].forEach((tc: unknown, index: number) => pushToolCall(tc, index));
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
  meta?: StreamMeta;
  reasoning?: { effort: 'low' | 'medium' | 'high' };
  ollamaOptions?: Record<string, unknown>;
};

export function streamOllamaCompletion(
  messages: ChatMessage[],
  model?: string,
  tools?: ToolSpec[],
  options?: StreamRequestOptions,
): AsyncIterable<StreamEvent> {
  const queue = new AsyncQueue<StreamEvent>();
  if (!hasTauriBridge()) {
    emitUiDebug('llm_error', {
      event: 'bridge_unavailable',
      model,
      message: 'Tauri bridge unavailable for streamOllamaCompletion',
      meta: options?.meta,
    });
    queue.fail(new Error('Tauri runtime unavailable for streamOllamaCompletion'));
    queue.end();
    return queue;
  }
  let unlisten: UnlistenFn | null = null;
  let started = false;
  const requestId = options?.requestId ?? (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
  const startedAt = Date.now();
  const meta: StreamMeta = { ...(options?.meta ?? {}) };
  const transcripts = new Map<string, string>();
  const toolCallMap = new Map<number, { index: number; id?: string; name?: string; chunks: unknown[] }>();
  let firstDeltaAt: number | null = null;
  let contentDeltaCount = 0;
  // WHY: Avoid `any` while not relying on global DOM types that may not be present in ESLint scope.
  // INVARIANT: `abortHandler` is only set when `options.signal` supports add/removeEventListener; it performs a best-effort cancel then ends the queue.
  let abortHandler: (() => void) | undefined;
  const readMs = (key: string, fallback: number): number => {
    try {
      // SAFETY: `ImportMetaEnv` is declared in types/env.d.ts with an index signature.
      const raw = import.meta?.env?.[key];
      const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : undefined;
      return Number.isFinite(n) && (n as number) > 0 ? (n as number) : fallback;
    } catch {
      return fallback;
    }
  };
  const DEFAULT_CHAT_TIMEOUT_MS = readMs('VITE_CHAT_DEFAULT_TIMEOUT_MS', 180_000);
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const logCtx = () => ({
    requestId,
    role: meta.role,
    profileKey: meta.profileKey,
    traceId: meta.traceId,
  });

  const logError = (stage: string, error: unknown) => {
    emitUiDebug('llm_error', {
      ...logCtx(),
      stage,
      model,
      message: error instanceof Error ? error.message : String(error),
    });
  };

  const emitDeltaLog = (channel: string | undefined, text: string) => {
    emitUiDebug('llm_delta', {
      ...logCtx(),
      model,
      channel: channel ?? 'text',
      text,
      textLength: text.length,
      totalDeltaCount: contentDeltaCount,
    });
  };

  const truncatedIntent = meta.intent ? truncateForLog(meta.intent, 4000) : undefined;
  emitUiDebug('llm_request_started', {
    ...logCtx(),
    model,
    messagesCount: messages.length,
    toolsCount: Array.isArray(tools) ? tools.length : 0,
    timeoutMs: options?.signal ? null : DEFAULT_CHAT_TIMEOUT_MS,
    intent: truncatedIntent,
  });

  // Attach the event listener first to avoid missing early chunks
  void listen('ollama-completion', (event) => {
    // WHY: The backend may terminate a stream with an error payload
    // (e.g., HTTP 404/429/503) and `done: true`. Previously we treated
    // this as a normal completion which caused upstream callers to see
    // an empty transcript ("planner_empty"). Surface these as failures
    // so orchestrator fallbacks can include the real reason.
    // INVARIANT: If `payload.error` is present, we fail the queue with
    // a structured Error and end the stream exactly once.
    const payload = event.payload as { done?: boolean; delta?: unknown; kind?: string; error?: Record<string, unknown> } | undefined;
    if (!payload) return;
    if (payload.done) {
      if (payload.error) {
        try {
          const status = typeof payload.error['status'] === 'number' ? payload.error['status'] : undefined;
          const code = typeof payload.error['code'] === 'string' ? (payload.error['code'] as string) : 'UpstreamFailure';
          const detail = typeof payload.error['detail'] === 'string' ? (payload.error['detail'] as string) : 'Request failed';
          const rid = typeof payload.error['requestId'] === 'string' ? (payload.error['requestId'] as string) : undefined;
          const retry = typeof payload.error['retryAfterMs'] === 'number' ? payload.error['retryAfterMs'] : undefined;
          const msg = `[${code}] ${detail}${status ? ` (status=${status})` : ''}${rid ? ` req=${rid}` : ''}${retry ? ` retryIn=${Math.round(retry)}ms` : ''}`;
          logError('upstream_error', new Error(msg));
          queue.fail(new Error(msg));
        } catch (e) {
          logError('upstream_error_parse', e);
          queue.fail(new Error('Upstream error'));
        }
        // Ensure we clear timers/listeners and end the queue
        const durationMs = Date.now() - startedAt;
        const transcriptsObject = Object.fromEntries(transcripts.entries());
        const toolCalls = [...toolCallMap.values()].map((call) => ({
          index: call.index,
          id: call.id,
          name: call.name,
          chunks: call.chunks,
        }));
        emitUiDebug('llm_complete', {
          ...logCtx(),
          model,
          durationMs,
          firstDeltaMs: firstDeltaAt ? firstDeltaAt - startedAt : null,
          contentDeltaCount,
          transcripts: transcriptsObject,
          toolCalls,
        });
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }
        if (unlisten) {
          try { unlisten(); } catch (err) { console.error(`E-UICP-401: failed to unregister ollama listener for request ${requestId}`, err instanceof Error ? err : new Error(String(err))); }
          unlisten = null;
        }
        if (activeRequestId === requestId) {
          activeRequestId = null;
        }
        queue.end();
        return;
      }
      const durationMs = Date.now() - startedAt;
      const transcriptsObject = Object.fromEntries(transcripts.entries());
      const toolCalls = [...toolCallMap.values()].map((call) => ({
        index: call.index,
        id: call.id,
        name: call.name,
        chunks: call.chunks,
      }));
      emitUiDebug('llm_complete', {
        ...logCtx(),
        model,
        durationMs,
        firstDeltaMs: firstDeltaAt ? firstDeltaAt - startedAt : null,
        contentDeltaCount,
        transcripts: transcriptsObject,
        toolCalls,
      });
      queue.push({ type: 'done' });
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
      if (unlisten) {
        try {
          unlisten();
        } catch (err) {
          // WHY: Listener teardown must be observable; log with dedicated code so CI can grep for regressions.
          const original = err instanceof Error ? err : new Error(String(err));
          console.error(`E-UICP-401: failed to unregister ollama listener for request ${requestId}`, original);
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
      // Debug: Log what we receive
      if (import.meta.env.DEV) {
        console.debug('[ollama] received delta:', { delta: payload.delta, kind: payload.kind, type: typeof payload.delta });
      }
      // Some providers stream raw text segments or concatenated NDJSON; parse each chunk separately.
      const chunks: unknown[] = [];
      if (typeof payload.delta === 'string') {
        // Helper: split concatenated JSON objects without delimiters by brace counting.
        const splitConcatenatedJson = (s: string): string[] => {
          const out: string[] = [];
          let depth = 0;
          let inStr = false;
          let esc = false;
          let start = -1;
          for (let i = 0; i < s.length; i++) {
            const ch = s[i]!;
            if (inStr) {
              if (esc) { esc = false; continue; }
              if (ch === '\\') { esc = true; continue; }
              if (ch === '"') inStr = false;
              continue;
            }
            if (ch === '"') { inStr = true; if (start === -1) start = i; continue; }
            if (ch === '{') { if (depth === 0) start = i; depth++; continue; }
            if (ch === '}') { depth--; if (depth === 0 && start !== -1) { out.push(s.slice(start, i + 1)); start = -1; } continue; }
          }
          return out.length ? out : [s];
        };
        // First split by newlines (NDJSON-friendly), then split any concatenated objects inside each line.
        const lines = payload.delta.split('\n').filter(l => l.trim().length > 0);
        const segments = lines.flatMap(splitConcatenatedJson);
        for (const seg of segments) {
          const trimmed = seg.trim();
          if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
            try {
              chunks.push(JSON.parse(trimmed));
              continue;
            } catch { /* fallthrough to raw */ }
          }
          // Not JSON - treat as raw text chunk
          chunks.push(seg);
        }
      } else {
        chunks.push(payload.delta);
      }
      
      try {
        const kind = payload.kind ? String(payload.kind).toLowerCase() : undefined;
        for (const chunk of chunks) {
          let events = extractEventsFromChunk(chunk);
          if (kind === 'json') {
            // Structured JSON lines tagged by backend
            events = events.map((e) => (e.type === 'content' ? { ...e, channel: 'json' } : e));
          } else if (kind === 'text') {
            // Non-JSON lines (status, prose) — keep them off primary JSON channels
            events = events.map((e) => (e.type === 'content' ? { ...e, channel: 'text' } : e));
          }
          // Debug: Log what we're emitting
          if (import.meta.env.DEV && events.length > 0) {
            console.debug('[ollama] extracted events:', events);
          }
          for (const e of events) {
            if (e.type === 'content') {
              const channel = e.channel ?? 'text';
              const existing = transcripts.get(channel) ?? '';
              transcripts.set(channel, existing + e.text);
              contentDeltaCount += 1;
              if (!firstDeltaAt) {
                firstDeltaAt = Date.now();
              }
              emitDeltaLog(e.channel, e.text);
            } else if (e.type === 'tool_call') {
              const existing = toolCallMap.get(e.index) ?? { index: e.index, id: undefined as string | undefined, name: undefined as string | undefined, chunks: [] as unknown[] };
              if (e.id) existing.id = e.id;
              if (e.name) existing.name = e.name;
              existing.chunks.push(e.arguments);
              toolCallMap.set(e.index, existing);
              emitUiDebug('llm_tool_call_delta', {
                ...logCtx(),
                model,
                index: e.index,
                id: e.id,
                name: e.name,
              });
            }
            queue.push(e);
          }
        }
      } catch (err) {
        logError('chunk_parse', err);
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
      if (options?.reasoning !== undefined) {
        requestPayload.reasoning = options.reasoning;
      }
      if (options?.ollamaOptions !== undefined) {
        requestPayload.options = options.ollamaOptions;
      }

      // Mark this requestId as the active in-flight chat stream
      activeRequestId = requestId;

      if (!hasTauriBridge()) {
        queue.fail(new Error('Tauri runtime unavailable for chat completion'));
        queue.end();
        activeRequestId = null;
      } else {
        void tauriInvoke('chat_completion', {
          requestId,
          request: requestPayload,
        }).catch((err) => {
          logError('invoke', err);
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
    }
    // If caller supplied an AbortSignal, wire it to backend cancel
    if (options?.signal && typeof options.signal.addEventListener === 'function') {
      abortHandler = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }
        if (hasTauriBridge()) {
          void tauriInvoke('cancel_chat', { requestId }).catch((error) => {
            logError('abort_cancel', error);
          });
        } else {
          console.warn(`[ollama] abort cancel skipped for ${requestId}; tauri bridge unavailable`);
        }
        if (unlisten) {
          try {
            unlisten();
          } catch (error) {
            logError('abort_unlisten', error);
          }
          unlisten = null;
        }
        // Clear active marker when aborted
        if (activeRequestId === requestId) {
          activeRequestId = null;
        }
        queue.end();
      };
      // Avoid referencing global `AddEventListenerOptions` type to satisfy eslint/no-undef.
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }
    // Default timeout when no AbortSignal provided: best-effort cancel
    if (!options?.signal) {
      timeoutId = setTimeout(() => {
        if (hasTauriBridge()) {
          void tauriInvoke('cancel_chat', { requestId }).catch((error) => {
            logError('timeout_cancel', error);
          });
        } else {
          console.warn(`[ollama] timeout cancel skipped for ${requestId}; tauri bridge unavailable`);
        }
        if (unlisten) {
          try {
            unlisten();
          } catch (error) {
            logError('timeout_unlisten', error);
          }
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
    logError('listener_attach', err);
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
            clearTimeout(timeoutId);
            timeoutId = undefined;
          }
          if (unlisten) {
            try {
              unlisten();
            } catch (err) {
              // WHY: Iterator return errors often indicate leaking listeners; surface them loudly instead of ignoring.
              logError('iterator_return_unlisten', err);
            }
            unlisten = null;
          }
          if (hasTauriBridge()) {
            try {
              // Best-effort backend cancel to stop network usage
              await tauriInvoke('cancel_chat', { requestId });
            } catch (error) {
              logError('iterator_return_cancel', error);
            }
          } else {
            console.warn(`[ollama] return cancel skipped for ${requestId}; tauri bridge unavailable`);
          }
          // Clear active marker on consumer return
          if (activeRequestId === requestId) {
            activeRequestId = null;
          }
          if (options?.signal && abortHandler && typeof options.signal.removeEventListener === 'function') {
            try {
              options.signal.removeEventListener('abort', abortHandler);
            } catch (error) {
              console.error(`Failed to remove abort listener for request ${requestId}:`, error instanceof Error ? error.message : String(error));
            }
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

export async function cancelChat(rid: string | null) {
  if (!rid) return;
  if (!hasTauriBridge()) {
    console.warn(`[ollama] cancel_chat skipped for ${rid}; tauri bridge unavailable`);
    return;
  }
  try {
    await tauriInvoke('cancel_chat', { requestId: rid });
  } catch (error) {
    console.error(`Failed to cancel chat request ${rid}:`, error instanceof Error ? error.message : String(error));
  }
}

// WHY: DockChat STOP button cancels the latest in-flight request without tracking the id directly.
export async function cancelActiveChat() {
  await cancelChat(activeRequestId);
}
