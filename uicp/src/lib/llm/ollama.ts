import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

// Streamed event union returned by the async iterator
export type StreamEvent =
  | { type: 'content'; channel?: string; text: string }
  | { type: 'tool_call'; index: number; id?: string; name?: string; arguments: string; isDelta: boolean }
  | { type: 'done' };

export type ChatMessage = { role: string; content: string };
export type ToolSpec = unknown; // pass-through JSON (e.g., OpenAI-compatible tool schema)

// Extracts content/tool-call deltas from a single OpenAI/Ollama-compatible chunk object
export function extractEventsFromChunk(input: unknown): StreamEvent[] {
  if (!input || typeof input !== 'object') return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj: any = input;
  const out: StreamEvent[] = [];

  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  for (const ch of choices) {
    const delta = ch?.delta ?? ch?.message ?? ch?.update ?? null;
    if (!delta || typeof delta !== 'object') continue;

    // Harmony-style channels
    const channel: string | undefined = typeof delta.channel === 'string' ? delta.channel : undefined;
    const content: string | undefined =
      typeof delta.content === 'string' ? delta.content : typeof delta.thinking === 'string' ? delta.thinking : undefined;

    if (typeof content === 'string' && content.length > 0) {
      out.push({ type: 'content', channel, text: content });
    }

    // OpenAI-style tool calls (can arrive incrementally)
    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (let i = 0; i < toolCalls.length; i++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tc: any = toolCalls[i];
      const idx = typeof tc.index === 'number' ? tc.index : i;
      const id = typeof tc.id === 'string' ? tc.id : undefined;
      const name = typeof tc?.function?.name === 'string' ? tc.function.name : undefined;
      const args = typeof tc?.function?.arguments === 'string' ? tc.function.arguments : '';
      if (name || args || id) {
        out.push({ type: 'tool_call', index: idx, id, name, arguments: args, isDelta: true });
      }
    }
  }

  return out;
}

// Minimal async queue to bridge event callbacks into an async iterator
class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: (T | Error | symbol)[] = [];
  private resolvers: Array<(v: IteratorResult<T>) => void> = [];
  private readonly END = Symbol('end');

  push(value: T) {
    if (this.resolvers.length) {
      const res = this.resolvers.shift()!;
      res({ value, done: false });
    } else {
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
