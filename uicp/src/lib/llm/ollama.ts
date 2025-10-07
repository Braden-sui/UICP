import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

// Streamed event union returned by the async iterator
export type StreamEvent =
  | { type: 'content'; channel?: string; text: string }
  | { type: 'tool_call'; index: number; id?: string; name?: string; arguments: string; isDelta: boolean }
  | { type: 'done' };

export type ChatMessage = { role: string; content: string | Record<string, unknown> };
export type ToolSpec = unknown; // pass-through JSON (e.g., OpenAI-compatible tool schema)

// Extracts content/tool-call deltas from a single OpenAI/Ollama-compatible chunk object
export function extractEventsFromChunk(input: unknown): StreamEvent[] {
  const asRecord = (value: unknown): Record<string, unknown> | null => {
    if (!value || typeof value !== 'object') return null;
    return value as Record<string, unknown>;
  };

  const root = asRecord(input);
  if (!root) return [];
  const out: StreamEvent[] = [];

  const pushContent = (channel: string | undefined, text: unknown) => {
    if (typeof text !== 'string' || text.trim().length === 0) return;
    out.push({ type: 'content', channel, text });
  };

  const pushToolCall = (call: unknown, indexFallback = 0) => {
    const record = asRecord(call);
    if (!record) return;
    const fnRecord = asRecord(record.function);
    const name = typeof record.name === 'string' ? record.name : typeof fnRecord?.name === 'string' ? fnRecord.name : undefined;
    const args = typeof record.arguments === 'string'
      ? record.arguments
      : typeof fnRecord?.arguments === 'string'
        ? fnRecord.arguments
        : typeof record.arguments === 'object'
          ? JSON.stringify(record.arguments)
          : '';
    const id = typeof record.id === 'string' ? record.id : undefined;
    const index = typeof record.index === 'number' ? record.index : indexFallback;
    if (!name && !args && !id) return;
    out.push({ type: 'tool_call', index, id, name, arguments: args, isDelta: true });
  };

  const stringifyBlock = (block: unknown): string | undefined => {
    if (typeof block === 'string') return block;
    if (!block || typeof block !== 'object') return undefined;
    if (typeof (block as { text?: unknown }).text === 'string') return (block as { text: string }).text;
    if (typeof (block as { output_text?: unknown }).output_text === 'string') {
      return (block as { output_text: string }).output_text;
    }
    if (typeof (block as { content?: unknown }).content === 'string') return (block as { content: string }).content;
    return undefined;
  };

  const extractChannel = (message: unknown): string | undefined => {
    const record = asRecord(message);
    if (!record) return undefined;
    if (typeof record.channel === 'string') return record.channel;
    const metadata = asRecord(record.metadata);
    if (typeof metadata?.channel === 'string') return metadata.channel;
    if (typeof record.role === 'string' && ['analysis', 'commentary', 'final'].includes(record.role)) {
      return record.role;
    }
    return undefined;
  };

  const handleMessage = (message: unknown) => {
    const record = asRecord(message);
    if (!record) return;
    const channel = extractChannel(record);

    const content = record.content ?? record.output_text ?? record.thinking;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && 'tool_call' in block) {
          pushToolCall((block as { tool_call?: unknown }).tool_call);
          continue;
        }
        if (block && typeof block === 'object' && 'toolCall' in block) {
          pushToolCall((block as { toolCall?: unknown }).toolCall);
          continue;
        }
        const text = stringifyBlock(block);
        if (text) pushContent(channel, text);
      }
    } else {
      const text = stringifyBlock(content) ?? (typeof content === 'string' ? content : undefined);
      if (text) pushContent(channel, text);
    }

    const toolCalls = record.tool_calls ?? record.toolCalls ?? record.tool_call;
    if (Array.isArray(toolCalls)) {
      toolCalls.forEach((tc: unknown, index: number) => pushToolCall(tc, index));
    } else if (toolCalls) {
      pushToolCall(toolCalls);
    }
  };

  const choicesRaw = root['choices'];
  const choices = Array.isArray(choicesRaw) ? choicesRaw : [];
  for (const ch of choices) {
    const record = asRecord(ch);
    const deltaRecord = asRecord(record?.delta) ?? asRecord(record?.message) ?? asRecord(record?.update);
    if (!deltaRecord) continue;

    // Harmony-style channels
    const channelValue = deltaRecord.channel;
    const channel: string | undefined = typeof channelValue === 'string' ? channelValue : undefined;
    const contentValue = deltaRecord.content ?? deltaRecord.thinking;
    const content: string | undefined = typeof contentValue === 'string' ? contentValue : undefined;

    if (typeof content === 'string' && content.length > 0) {
      pushContent(channel, content);
    }

    // OpenAI-style tool calls (can arrive incrementally)
    const deltaToolCalls = Array.isArray(deltaRecord.tool_calls) ? deltaRecord.tool_calls : [];
    deltaToolCalls.forEach((tc, index) => pushToolCall(tc, index));
    const deltaToolCall = deltaRecord.tool_call;
    if (deltaToolCall) {
      pushToolCall(deltaToolCall);
    }
  }

  // Harmony Responses: delta.messages / messages arrays
  const harmonyMessages = (() => {
    const delta = asRecord(root['delta']);
    const response = asRecord(root['response']);
    const message = asRecord(root['message']);
    if (Array.isArray(delta?.messages)) return delta.messages;
    if (Array.isArray(root['messages'])) return root['messages'] as unknown[];
    if (Array.isArray(response?.messages)) return response.messages;
    if (Array.isArray(message?.content)) return message?.content as unknown[];
    return [];
  })();
  for (const msg of harmonyMessages) {
    handleMessage(msg);
  }

  // Harmony-specific direct text fields
  const responseRecord = asRecord(root['response']);
  if (
    typeof responseRecord?.channel === 'string' &&
    typeof responseRecord?.output_text === 'string'
  ) {
    pushContent(responseRecord.channel, responseRecord.output_text);
  }

  const deltaRecord = asRecord(root['delta']);
  if (Array.isArray(deltaRecord?.tool_calls)) {
    deltaRecord.tool_calls.forEach((tc: unknown, index: number) => pushToolCall(tc, index));
  }

  if (Array.isArray(root['tool_calls'])) {
    (root['tool_calls'] as unknown[]).forEach((tc: unknown, index: number) => pushToolCall(tc, index));
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
export function streamOllamaCompletion(
  messages: ChatMessage[],
  model?: string,
  tools?: ToolSpec[],
  options?: { requestId?: string; signal?: AbortSignal }
): AsyncIterable<StreamEvent> {
  const queue = new AsyncQueue<StreamEvent>();
  let unlisten: UnlistenFn | null = null;
  let started = false;
  const requestId = options?.requestId ?? (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

  // Attach the event listener first to avoid missing early chunks
  void listen('ollama-completion', (event) => {
    const payload = event.payload as { done?: boolean; delta?: unknown } | undefined;
    if (!payload) return;
    if (payload.done) {
      queue.push({ type: 'done' });
      if (unlisten) {
        try {
          unlisten();
        } catch (err) {
          // ignore teardown errors
          void err;
        }
        unlisten = null;
      }
      queue.end();
      return;
    }
    if (payload.delta !== undefined) {
      try {
        const chunkObj = typeof payload.delta === 'string' ? JSON.parse(payload.delta) : payload.delta;
        const events = extractEventsFromChunk(chunkObj);
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
      void invoke('chat_completion', {
        requestId,
        request: { model, messages, stream: true, tools },
      }).catch((err) => {
        queue.fail(err instanceof Error ? err : new Error(String(err)));
        queue.end();
      });
    }
  }).catch((err) => {
    queue.fail(err instanceof Error ? err : new Error(String(err)));
    queue.end();
  });

  // Ensure we cleanup when consumer stops early
  const iterable: AsyncIterable<StreamEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
      return {
        next: () => queue.next(),
        return: async () => {
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
          queue.end();
          return { value: undefined as unknown as StreamEvent, done: true };
        },
      } as AsyncIterator<StreamEvent>;
    },
  };

  return iterable;
}
