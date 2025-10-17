import type { StreamEvent } from './ollama';
import type { CollectedToolArgs } from './collectToolArgs';

export type CollectionResult = {
  toolResult?: CollectedToolArgs;
  textContent: string;
};

const looksLikeEnvelope = (value: unknown): boolean => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const op = typeof record.op === 'string' ? record.op : typeof record.method === 'string' ? record.method : undefined;
  return Boolean(op && op.trim().length > 0);
};

const detectToolPayload = (
  value: unknown,
  fallbackName: string,
): { name: string; payload: Record<string, unknown> } | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const batch = record.batch;
  if (!Array.isArray(batch)) return null;
  const batchLooksValid = batch.length === 0 || batch.every((entry) => looksLikeEnvelope(entry));
  if (!batchLooksValid) return null;
  const hasPlanSignals =
    typeof record.summary === 'string' ||
    Array.isArray(record.actor_hints) ||
    Array.isArray(record.actorHints) ||
    record.risks !== undefined;
  return { name: hasPlanSignals ? 'emit_plan' : fallbackName, payload: record };
};

const splitConcatenatedJson = (input: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let inString = false;
  let escape = false;
  let start = -1;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      if (start === -1) start = i;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        out.push(input.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out.length ? out : [input];
};

const extractToolFromText = (text: string, fallbackName: string): { name: string; payload: Record<string, unknown> } | null => {
  const segments = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap(splitConcatenatedJson);
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const detected = detectToolPayload(parsed, fallbackName);
      if (detected) {
        return detected;
      }
    } catch {
      // Ignore parse errors; fall back to next segment.
    }
  }
  return null;
};

/**
 * Collects both tool call arguments AND text content from a single stream pass.
 * This solves the problem where trying tool collection first consumes the stream,
 * leaving nothing for text fallback.
 *
 * @param stream - Async iterable of StreamEvent
 * @param targetToolName - Tool name to collect (e.g., 'emit_plan', 'emit_batch')
 * @param timeoutMs - Timeout in milliseconds
 * @returns Both tool result (if found) and accumulated text content
 */
export async function collectWithFallback(
  stream: AsyncIterable<StreamEvent>,
  targetToolName: string,
  timeoutMs: number,
): Promise<CollectionResult> {
  type ToolAccumulator = {
    index: number;
    id?: string;
    name?: string;
    parts: string[];
    objectArg?: unknown;
  };

  const accumulators = new Map<number, ToolAccumulator>();
  const textParts: string[] = [];

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`E-UICP-0105: Collection timeout after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    await Promise.race([
      (async () => {
        for await (const event of stream) {
          if (event.type === 'done') break;

          if (event.type === 'tool_call') {
            const { index, id, name, arguments: args } = event;

            const acc =
              accumulators.get(index) ??
              ({
                index,
                parts: [],
              } as ToolAccumulator);

            if (id) acc.id = id;
            if (typeof name === 'string' && name.trim().length > 0) {
              acc.name = name;
            }

            if (typeof args === 'string') {
              acc.parts.push(args);
            } else if (args !== undefined && args !== null) {
              acc.objectArg = args;
            }

            accumulators.set(index, acc);
          } else if (event.type === 'content') {
            // Accumulate text content for fallback
            textParts.push(event.text);
          } else if (event.type === 'return') {
            if (typeof event.result === 'string') {
              textParts.push(event.result);
            }
          }
        }
      })(),
      timeoutPromise,
    ]);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('E-UICP-0105')) {
      throw err;
    }
    throw new Error(`E-UICP-0106: Collection failed: ${err}`);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }

  const textContent = textParts.join('');

  // Parse tool args if we collected any
  let toolResult: CollectedToolArgs | undefined;
  const candidates = [...accumulators.values()].sort((a, b) => a.index - b.index);
  if (candidates.length > 0) {
    const match = candidates.find((acc) => acc.name === targetToolName) ?? (candidates.length === 1 ? candidates[0] : undefined);

    if (match) {
      let parsedArgs: unknown | undefined;
      if (match.objectArg !== undefined) {
        parsedArgs = match.objectArg;
      } else if (match.parts.length > 0) {
        const buffer = match.parts.join('');
        try {
          parsedArgs = JSON.parse(buffer);
        } catch (err) {
          console.warn(`Failed to parse tool args for ${targetToolName}:`, err);
        }
      }

      if (parsedArgs !== undefined) {
        toolResult = {
          index: match.index,
          id: match.id,
          name: match.name ?? targetToolName,
          args: parsedArgs,
        };
      }
    }
  }

  if (!toolResult && candidates.length > 1) {
    try {
      const summary = candidates.map(({ index, id, name }) => ({ index, id, name }));
      console.debug(`[collectWithFallback] No matching tool ${targetToolName} found; candidates: ${JSON.stringify(summary)}`);
    } catch {
      // Safe to ignore debug serialization errors
    }
  }

  if (!toolResult) {
    const maybeTool = extractToolFromText(textContent, targetToolName);
    if (maybeTool) {
      toolResult = {
        index: candidates[0]?.index ?? 0,
        id: candidates[0]?.id,
        name: maybeTool.name,
        args: maybeTool.payload,
      };
    }
  }

  return { toolResult, textContent };
}
