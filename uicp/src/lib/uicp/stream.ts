import { extractEventsFromChunk } from '../llm/ollama';
import { enqueueBatch } from './queue';
import { cfg } from '../config';
import type { ApplyOutcome } from './adapter';
import { validateBatch, type Batch } from './schemas';
import { parseWILBatch } from '../orchestrator/parseWILBatch';

// Streaming aggregator for Ollama/OpenAI-like SSE chunks (WIL-only path).
// Tracks per-channel content and, on flush, parses WIL lines into a typed batch.

const parseBatchFromText = (buffer: string): Batch | undefined => {
  const items = parseWILBatch(buffer);
  const ops = items.filter((i): i is { op: string; params: unknown } => 'op' in i);
  if (ops.length === 0) return undefined;
  return validateBatch(ops);
};

export const createOllamaAggregator = (onBatch?: (batch: Batch) => Promise<ApplyOutcome | void> | ApplyOutcome | void) => {
  let commentaryBuffer = '';
  let finalBuffer = '';
  // tool_call aggregation no longer used in WIL-only path

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
      if (event.type === 'tool_call') continue;
      if (event.type !== 'content') continue;
      const channel = event.channel?.toLowerCase();
      if (!channel || channel === 'commentary' || channel === 'assistant' || channel === 'text') {
        commentaryBuffer += event.text;
        // Backpressure guard: trim commentary buffer to last N KB
        const limit = Math.max(16, cfg.wilMaxBufferKb) * 1024;
        if (commentaryBuffer.length > limit) {
          commentaryBuffer = commentaryBuffer.slice(-limit);
        }
      } else if (channel === 'final' || channel === 'json') {
        finalBuffer += event.text;
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
    const primary = finalBuffer.trim();
    const secondary = commentaryBuffer.trim();
    finalBuffer = '';
    commentaryBuffer = '';

    if (!primary && !secondary) {
      return;
    }

    const batch = parseBatchFromText(primary) ?? parseBatchFromText(secondary);

    if (!batch) {
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
