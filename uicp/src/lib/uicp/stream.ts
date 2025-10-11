import { extractEventsFromChunk } from '../llm/ollama';
import { parseJsonLoose } from '../llm/json';
import { enqueueBatch } from './queue';
import type { ApplyOutcome } from './adapter';
import type { Batch } from './schemas';

// Minimal streaming aggregator for Ollama Cloud/OpenAI SSE chunks.
// It tracks per-channel content plus tool_call deltas and, on flush, prefers
// structured tool arguments before falling back to the textual buffers.

const extractBatch = (data: unknown): Batch | undefined => {
  if (Array.isArray(data)) {
    return data as Batch;
  }
  if (data && typeof data === 'object') {
    const candidate = (data as { batch?: unknown }).batch;
    if (Array.isArray(candidate)) {
      return candidate as Batch;
    }
  }
  return undefined;
};

const parseBatchFromBuffer = (buffer: string): Batch | undefined => {
  if (!buffer.trim()) return undefined;
  try {
    const parsed = parseJsonLoose<unknown>(buffer);
    return extractBatch(parsed);
  } catch {
    return undefined;
  }
};

export const createOllamaAggregator = (onBatch?: (batch: Batch) => Promise<ApplyOutcome | void> | ApplyOutcome | void) => {
  let commentaryBuffer = '';
  let finalBuffer = '';
  const toolBuffers = new Map<string, string>();
  const toolOrder: string[] = [];
  let lastToolError: unknown;

  const appendToolArguments = (rawName: string | undefined, chunk: string) => {
    if (!rawName || !chunk) return;
    const name = rawName.toLowerCase();
    if (!toolBuffers.has(name)) {
      toolBuffers.set(name, chunk);
      toolOrder.push(name);
    } else {
      toolBuffers.set(name, `${toolBuffers.get(name)!}${chunk}`);
    }
  };

  const processDelta = async (raw: string) => {
    let chunk: unknown = raw;
    if (typeof raw === 'string') {
      try {
        chunk = JSON.parse(raw);
      } catch {
        chunk = raw;
      }
    }
    const events = extractEventsFromChunk(chunk);
    if (events.length === 0 && typeof raw === 'string') {
      commentaryBuffer += raw;
      return;
    }

    for (const event of events) {
      if (event.type === 'tool_call') {
        appendToolArguments(event.name, event.arguments);
        continue;
      }
      if (event.type !== 'content') continue;
      const channel = event.channel?.toLowerCase();
      if (!channel || channel === 'commentary' || channel === 'assistant' || channel === 'text') {
        commentaryBuffer += event.text;
      } else if (channel === 'final' || channel === 'json') {
        finalBuffer += event.text;
      } else if (channel === 'analysis' || channel === 'thought' || channel === 'reasoning') {
        commentaryBuffer += event.text;
      } else {
        commentaryBuffer += event.text;
      }
    }
  };

  const flush = async () => {
    const primary = finalBuffer.trim();
    const secondary = commentaryBuffer.trim();
    finalBuffer = '';
    commentaryBuffer = '';

    const parseTool = (): Batch | undefined => {
      if (toolBuffers.size === 0) return undefined;
      const preferred = ['emit_batch', 'emit_plan'];
      const ordered = [...preferred, ...toolOrder.filter((name) => !preferred.includes(name))];
      for (const name of ordered) {
        const payload = toolBuffers.get(name);
        if (!payload || !payload.trim()) continue;
        try {
          const parsed = parseJsonLoose<unknown>(payload);
          const batch = extractBatch(parsed);
          if (batch) {
            return batch;
          }
        } catch (err) {
          lastToolError = err;
        }
      }
      return undefined;
    };

    const toolBatch = parseTool();
    const toolError = lastToolError;
    toolBuffers.clear();
    toolOrder.length = 0;
    lastToolError = undefined;

    if (!toolBatch && !primary && !secondary) {
      return;
    }

    const batch =
      toolBatch ??
      parseBatchFromBuffer(primary) ??
      parseBatchFromBuffer(secondary);

    if (!batch) {
      if (toolError) {
        throw toolError instanceof Error ? toolError : new Error(String(toolError));
      }
      return;
    }

    if (!Array.isArray(batch) || batch.length === 0) {
      return;
    }

    try {
      const outcome = onBatch ? await onBatch(batch) : await enqueueBatch(batch);
      const applied = outcome ?? { success: true, applied: batch.length, errors: [] };
      if (!applied.success) {
        const details = applied.errors.join('; ');
        throw new Error(details || 'enqueueBatch reported failure');
      }
    } catch (err) {
      console.error('enqueueBatch failed', err);
      throw err instanceof Error ? err : new Error(String(err));
    }
  };

  return { processDelta, flush };
};
