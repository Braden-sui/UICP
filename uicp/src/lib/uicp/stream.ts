import { enqueueBatch } from './queue';
import type { Batch } from './schemas';

// Minimal streaming aggregator for Ollama Cloud/OpenAI SSE chunks.
// It collects commentary-channel text until [DONE], then tries to parse a UICP batch from the buffer.
// If a valid batch is found, it enqueues it for application via the per-window queue.

export type OllamaChunk = {
  choices?: Array<{
    message?: {
      channel?: string;
      content?: string;
      thinking?: string;
    };
    delta?: {
      channel?: string;
      content?: string;
      thinking?: string;
    };
  }>;
};

const tryParseJson = (s: string): unknown | undefined => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

const tryExtractBatch = (data: unknown): Batch | undefined => {
  if (Array.isArray(data)) {
    // Possibly an array of envelopes
    return data as Batch;
  }
  if (data && typeof data === 'object' && 'batch' in (data as Record<string, unknown>)) {
    const b = (data as { batch?: unknown }).batch;
    if (Array.isArray(b)) return b as Batch;
  }
  return undefined;
};

const extractChannelContent = (payload: OllamaChunk): { channel?: string; content?: string } | undefined => {
  const first = payload.choices?.[0];
  if (!first) return undefined;
  const node = first.delta ?? first.message;
  if (!node) return undefined;
  const channel = node.channel;
  const content = (node.content ?? node.thinking) as string | undefined;
  return { channel, content };
};

// Optional onBatch allows the caller to gate application (e.g., Full Control)
export const createOllamaAggregator = (onBatch?: (batch: Batch) => Promise<void> | void) => {
  let commentaryBuffer = '';
  let finalBuffer = '';

  const processDelta = async (raw: string) => {
    // Each delta should be a JSON object string, but chunks may be partial. Try to parse; if not, treat as plain text.
    const parsed = tryParseJson(raw) as OllamaChunk | undefined;
    if (parsed && typeof parsed === 'object') {
      const info = extractChannelContent(parsed);
      if (!info) return;
      const channel = info.channel ? info.channel.toLowerCase() : undefined;
      if (info.content) {
        if (!channel || channel === 'commentary') {
          commentaryBuffer += info.content;
        } else if (channel === 'final') {
          finalBuffer += info.content;
        }
      }
      return;
    }

    // Fallback: treat raw as plain text snippet for commentary
    commentaryBuffer += raw;
  };

  const flush = async () => {
    const primary = finalBuffer.trim();
    const secondary = commentaryBuffer.trim();
    finalBuffer = '';
    commentaryBuffer = '';
    if (!primary && !secondary) return;

    // Try full parse first
    let candidate = primary ? tryParseJson(primary) : undefined;

    // If that fails, try to locate the first JSON array in the buffer
    if (candidate === undefined) {
      const target = primary || secondary;
      const start = target.indexOf('[');
      const end = target.lastIndexOf(']');
      if (start >= 0 && end > start) {
        const slice = target.slice(start, end + 1);
        candidate = tryParseJson(slice);
      }
    }

    const batch = tryExtractBatch(candidate as unknown);
    if (batch && Array.isArray(batch) && batch.length > 0) {
      try {
        if (onBatch) {
          await onBatch(batch);
        } else {
          await enqueueBatch(batch);
        }
      } catch (err) {
        console.error('enqueueBatch failed', err);
      }
    }
  };

  return { processDelta, flush };
};
