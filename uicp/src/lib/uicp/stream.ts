import { extractEventsFromChunk } from '../llm/ollama';
import { enqueueBatch } from './adapters/queue';
import { normalizeBatchJson } from '../llm/jsonParsing';
import { parseWilToBatch } from '../wil/batch';
import type { Batch, ApplyOutcome } from './adapters/schemas';

// Streaming aggregator for Ollama/OpenAI-like SSE chunks.
// Collects structured tool-call payloads (emit_batch) and applies them on flush.

type ToolCallAccumulator = {
  index: number;
  id?: string;
  name?: string;
  argsBuffer: string;
  payload?: unknown;
};

export const createOllamaAggregator = (onBatch?: (batch: Batch) => Promise<ApplyOutcome | void> | ApplyOutcome | void) => {
  let jsonBuffer = '';
  let wilBuffer = '';
  const toolCallAccumulators = new Map<number, ToolCallAccumulator>();
  let cancelled = false;

  const processDelta = async (raw: string) => {
    // WHY: Short-circuit if stream was cancelled to avoid processing stale deltas
    if (cancelled) return;
    let chunk: unknown = raw;
    if (typeof raw === 'string') {
      try {
        chunk = JSON.parse(raw);
      } catch {
        chunk = raw;
      }
    }
    const events = extractEventsFromChunk(chunk);

    for (const event of events) {
      // Handle tool calls (JSON-first mode)
      if (event.type === 'tool_call') {
        const { index, id, name, arguments: args } = event;
        // Only accumulate emit_batch tool calls
        if (name === 'emit_batch') {
          let acc = toolCallAccumulators.get(index);
          if (!acc) {
            acc = { index, id, name, argsBuffer: '' };
            toolCallAccumulators.set(index, acc);
          }
          if (id) acc.id = id;
          if (name) acc.name = name;
          if (typeof args === 'string') {
            acc.argsBuffer += args;
          } else if (args !== undefined && args !== null) {
            // Complete object received (non-delta mode)
            acc.payload = args;
            acc.argsBuffer = '';
          }
        }
        continue;
      }

      if (event.type !== 'content') continue;
      const channel = event.channel?.toLowerCase();

      if (channel === 'json') {
        // JSON channel for structured responses
        jsonBuffer += event.text;
        continue;
      }

      if (!channel || channel === 'commentary' || channel === 'text' || channel === 'default') {
        // Commentary/plain text fallback for legacy WIL batches
        wilBuffer += event.text;
        if (!event.text.endsWith('\n')) {
          wilBuffer += '\n';
        }
      }
    }
  };

  const flush = async (): Promise<{ cancelled: boolean }> => {
    // WHY: Return early if cancelled, no batch application
    if (cancelled) {
      return { cancelled: true };
    }
    const jsonText = jsonBuffer.trim();
    const wilText = wilBuffer.trim();

    jsonBuffer = '';
    wilBuffer = '';

    let batch: Batch | undefined;

    // Priority 1: Tool call result (emit_batch)
    if (toolCallAccumulators.size > 0) {
      for (const acc of toolCallAccumulators.values()) {
        if (acc.name === 'emit_batch') {
          try {
            const payload = acc.payload ?? (acc.argsBuffer.length > 0 ? acc.argsBuffer : undefined);
            if (payload === undefined) continue;
            batch = normalizeBatchJson(payload);
            break; // Use first valid tool call
          } catch (err) {
            console.warn('E-UICP-0421 tool call normalization failed', err);
          }
        }
      }
      toolCallAccumulators.clear();
    }

    // Priority 2: JSON channel content (structured payloads without tool_call wrapper)
    if (!batch && jsonText) {
      try {
        batch = normalizeBatchJson(jsonText);
      } catch {
        batch = undefined;
      }
    }

    // Priority 3: Plain-text WIL fallback
    if (!batch && wilText) {
      const wilBatch = parseWilToBatch(wilText);
      if (wilBatch && wilBatch.length > 0) {
        batch = wilBatch;
      }
    }

    if (!batch || !Array.isArray(batch) || batch.length === 0) {
      return { cancelled: false };
    }

    try {
      const outcome = onBatch ? await onBatch(batch) : await enqueueBatch(batch);
      const applied = outcome ?? { success: true, applied: batch.length, errors: [], skippedDupes: 0 };
      if (!applied.success) {
        const details = applied.errors.join('; ');
        throw new Error(details || 'enqueueBatch reported failure');
      }
      return { cancelled: false };
    } catch (err) {
      console.error('enqueueBatch failed', err);
      throw err instanceof Error ? err : new Error(String(err));
    }
  };

  const cancel = () => {
    // WHY: Mark stream as cancelled to prevent further delta processing
    // INVARIANT: Once cancelled, processDelta and flush become no-ops
    cancelled = true;
    jsonBuffer = '';
    wilBuffer = '';
    toolCallAccumulators.clear();
  };

  return { processDelta, flush, cancel, isCancelled: () => cancelled };
};
