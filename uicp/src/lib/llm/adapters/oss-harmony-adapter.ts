import { HarmonyDecoder, coerceJson, type HarmonyEvent } from '../parsers/oss-harmony';
import type { ChatRequest, ModelAdapter } from './types';
import { streamOllamaCompletion, type StreamEvent } from '../ollama';

type AdapterConfig = {
  endpoint: string;
  apiKey?: string;
  debug?: (frame: string) => void;
};

const DONE_TOKEN = '[DONE]';

const toToolEvent = (name: string, args: unknown, index: number): StreamEvent => {
  const serialisedArgs =
    typeof args === 'string'
      ? args
      : args === undefined
      ? ''
      : (() => {
          try {
            return JSON.stringify(args);
          } catch {
            return '';
          }
        })();
  return {
    type: 'tool_call',
    id: undefined,
    index,
    name,
    arguments: serialisedArgs,
    isDelta: false,
  };
};

export class OssHarmonyAdapter implements ModelAdapter {
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly debug?: (frame: string) => void;

  constructor(config: AdapterConfig) {
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey;
    this.debug = config.debug;
  }

  async *chat(input: ChatRequest): AsyncGenerator<StreamEvent> {
    const isTauri =
      typeof window !== 'undefined' &&
      (typeof (window as { __TAURI__?: unknown }).__TAURI__ !== 'undefined' ||
        typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== 'undefined' ||
        typeof (window as { __TAURI_METADATA__?: unknown }).__TAURI_METADATA__ !== 'undefined' ||
        (typeof navigator !== 'undefined' && navigator.userAgent?.includes('Tauri')));
    if (isTauri) {
      const rawOptions = input.options as { requestId?: unknown } | undefined;
      const requestId = rawOptions && typeof rawOptions.requestId === 'string' ? rawOptions.requestId : undefined;
      const stream = streamOllamaCompletion(input.messages, input.model, input.tools, requestId ? { requestId } : undefined);
      for await (const event of stream) {
        yield event;
      }
      return;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const body = {
      model: input.model,
      messages: input.messages,
      tools: input.tools ?? [],
      stream: true,
      ...(input.options ?? {}),
    };

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok || !response.body) {
      throw new Error(`OSS Harmony HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const textDecoder = new TextDecoder();
    const harmony = new HarmonyDecoder();

    let toolIndex = 0;
    let finalBuffer = '';
    let finalResult: unknown;

    const emitHarmonyEvent = (event: HarmonyEvent): StreamEvent[] => {
      const out: StreamEvent[] = [];
      switch (event.type) {
        case 'text': {
          if (event.channel === 'analysis') return out;
          if (event.channel === 'final') {
            finalBuffer += event.delta;
            return out;
          }
          out.push({ type: 'content', channel: event.channel, text: event.delta } satisfies StreamEvent);
          return out;
        }
        case 'tool': {
          out.push(toToolEvent(event.name, event.args, toolIndex++));
          return out;
        }
        case 'return': {
          finalResult = event.result;
          out.push({ type: 'return', channel: 'final', result: event.result, name: event.name } satisfies StreamEvent);
          return out;
        }
        default:
          return out;
      }
    };

    const debug = this.debug;

    const processFrame = async function* (frame: string): AsyncGenerator<StreamEvent> {
      if (!frame || frame === DONE_TOKEN) {
        return;
      }

      let handled = false;
      try {
        const parsed = JSON.parse(frame);
        if (parsed && typeof parsed === 'object') {
          const delta = (parsed as Record<string, unknown>).delta ?? (parsed as Record<string, unknown>).message ?? parsed;
          if (typeof delta === 'string' && delta.includes('<|start|>')) {
            handled = true;
            for (const event of harmony.push(delta)) {
              for (const emitted of emitHarmonyEvent(event)) {
                yield emitted;
              }
            }
          } else if (typeof delta === 'string') {
            yield { type: 'content', channel: 'commentary', text: delta } satisfies StreamEvent;
            handled = true;
          }
          const choices = Array.isArray((parsed as { choices?: unknown }).choices) ? (parsed as { choices: unknown[] }).choices : [];
          for (const choice of choices) {
            const item = choice as { delta?: { content?: string; channel?: string } };
            const content = item?.delta?.content;
            if (typeof content === 'string') {
              handled = true;
              for (const event of harmony.push(content)) {
                for (const emitted of emitHarmonyEvent(event)) {
                  yield emitted;
                }
              }
            }
          }
        }
      } catch {
        // Fall back to raw Harmony processing when payload is plain text containing protocol tokens.
      }

      if (!handled) {
        debug?.(frame);
        for (const event of harmony.push(frame)) {
          for (const emitted of emitHarmonyEvent(event)) {
            yield emitted;
          }
        }
      }
    };

    let pending = '';

    while (true) {
      const { done: readerDone, value } = await reader.read();
      if (readerDone) break;
      const chunk = textDecoder.decode(value, { stream: true });
      pending += chunk;
      while (true) {
        const marker = pending.indexOf('\n\n');
        if (marker === -1) break;
        const rawFrame = pending.slice(0, marker);
        pending = pending.slice(marker + 2);
        const frame = rawFrame
          .split('\n')
          .map((line) => (line.startsWith('data:') ? line.slice(5).trimStart() : line.trim()))
          .join('\n')
          .trim();
        if (!frame) continue;
        for await (const event of processFrame(frame)) {
          yield event;
        }
      }
    }

    if (pending.trim().length > 0) {
      const frame = pending
        .split('\n')
        .map((line) => (line.startsWith('data:') ? line.slice(5).trimStart() : line.trim()))
        .join('\n')
        .trim();
      if (frame) {
        for await (const event of processFrame(frame)) {
          yield event;
        }
      }
    }

    for (const trailing of harmony.flush()) {
      for (const emitted of emitHarmonyEvent(trailing)) {
        yield emitted;
      }
    }

    if (finalResult === undefined && finalBuffer.trim().length > 0) {
      try {
        finalResult = coerceJson(finalBuffer.trim());
        yield { type: 'return', channel: 'final', result: finalResult } satisfies StreamEvent;
      } catch {
        // Unable to coerce trailing final buffer; surface as commentary so caller can inspect failures.
        yield { type: 'content', channel: 'final', text: finalBuffer.trim() } satisfies StreamEvent;
      }
    }

    yield { type: 'done' } satisfies StreamEvent;
  }
}
