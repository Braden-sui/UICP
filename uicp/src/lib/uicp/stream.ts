import { extractEventsFromChunk } from '../llm/ollama';
import { enqueueBatch } from './queue';
import { cfg } from '../config';
import type { ApplyOutcome } from './adapter';
import { validateBatch, type Batch } from './schemas';
import { parseWILBatch } from '../orchestrator/parseWILBatch';
import { tryParseBatchFromJson } from '../llm/orchestrator';

// Streaming aggregator for Ollama/OpenAI-like SSE chunks.
// Supports JSON-first (tool calls + json channel) with WIL fallback.
// Tracks per-channel content and tool call deltas, on flush applies the batch.

const parseBatchFromText = (buffer: string): Batch | undefined => {
  const items = parseWILBatch(buffer);
  const ops = items.filter((i): i is { op: string; params: unknown } => 'op' in i);
  if (ops.length === 0) return undefined;
  return validateBatch(ops);
};

type ToolCallAccumulator = {
  index: number;
  id?: string;
  name?: string;
  argsBuffer: string;
};

export const createOllamaAggregator = (onBatch?: (batch: Batch) => Promise<ApplyOutcome | void> | ApplyOutcome | void) => {
  let commentaryBuffer = '';
  let finalBuffer = '';
  let jsonBuffer = '';
  const toolCallAccumulators = new Map<number, ToolCallAccumulator>();

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
            acc.argsBuffer = JSON.stringify(args);
          }
        }
        continue;
      }

      if (event.type !== 'content') continue;
      const channel = event.channel?.toLowerCase();
      
      if (!channel || channel === 'commentary' || channel === 'assistant' || channel === 'text') {
        commentaryBuffer += event.text;
        // Backpressure guard: trim commentary buffer to last N KB
        const limit = Math.max(16, cfg.wilMaxBufferKb) * 1024;
        if (commentaryBuffer.length > limit) {
          commentaryBuffer = commentaryBuffer.slice(-limit);
        }
      } else if (channel === 'final') {
        finalBuffer += event.text;
      } else if (channel === 'json') {
        // JSON channel for structured responses
        jsonBuffer += event.text;
      } else if (channel === 'analysis' || channel === 'thought' || channel === 'reasoning') {
        commentaryBuffer += event.text;
        const limit = Math.max(16, cfg.wilMaxBufferKb) * 1024;
        if (commentaryBuffer.length > limit) {
          commentaryBuffer = commentaryBuffer.slice(-limit);
        }
      } else {
        commentaryBuffer += event.text;
        const limit = Math.max(16, cfg.wilMaxBufferKb) * 1024;
        if (commentaryBuffer.length > limit) {
          commentaryBuffer = commentaryBuffer.slice(-limit);
        }
      }
    }
  };

  const flush = async () => {
    const finalText = finalBuffer.trim();
    const jsonText = jsonBuffer.trim();
    const commentaryText = commentaryBuffer.trim();
    
    finalBuffer = '';
    jsonBuffer = '';
    commentaryBuffer = '';

    let batch: Batch | undefined;

    // Priority 1: Tool call result (emit_batch)
    if (toolCallAccumulators.size > 0) {
      for (const acc of toolCallAccumulators.values()) {
        if (acc.name === 'emit_batch' && acc.argsBuffer.length > 0) {
          try {
            const args = JSON.parse(acc.argsBuffer);
            const batchData = args as { batch?: unknown };
            if (Array.isArray(batchData.batch)) {
              batch = validateBatch(batchData.batch);
              break; // Use first valid tool call
            }
          } catch (err) {
            console.warn('Tool call parse failed, trying text fallback', err);
          }
        }
      }
      toolCallAccumulators.clear();
    }

    // Priority 2: JSON channel content
    if (!batch && jsonText) {
      batch = tryParseBatchFromJson(jsonText) || undefined;
    }

    // Priority 3: Final channel (WIL)
    if (!batch && finalText) {
      batch = parseBatchFromText(finalText);
    }

    // Priority 4: Commentary fallback (WIL)
    if (!batch && commentaryText) {
      batch = parseBatchFromText(commentaryText);
    }

    if (!batch || !Array.isArray(batch) || batch.length === 0) {
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
