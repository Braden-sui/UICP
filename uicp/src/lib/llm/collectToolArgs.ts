import type { StreamEvent } from './ollama';
import { LLMError, LLMErrorCode } from './errors';

/**
 * Accumulates tool_call arguments from a stream of events.
 * Tool calls may arrive as deltas (incremental JSON strings) or complete payloads.
 * Aggregates by tool call index and returns the final JSON-parsed arguments.
 */
export type ToolCallAccumulator = {
  index: number;
  id?: string;
  name?: string;
  argsBuffer: string;
};

export type CollectedToolArgs = {
  index: number;
  id?: string;
  name?: string;
  args: unknown;
};

/**
 * Collects tool call arguments from a stream for a specific tool name.
 * Returns the first matching tool call's parsed arguments, or null if none found.
 *
 * @param stream - Async iterable of StreamEvent
 * @param targetName - Tool name to collect (e.g., 'emit_plan', 'emit_batch')
 * @param timeoutMs - Timeout in milliseconds
 * @returns Parsed tool arguments or null
 */
export async function collectToolArgs(
  stream: AsyncIterable<StreamEvent>,
  targetName: string,
  timeoutMs: number,
): Promise<CollectedToolArgs | null> {
  const accumulators = new Map<number, ToolCallAccumulator>();

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new LLMError(LLMErrorCode.ToolCollectionTimeout, `Tool collection timeout after ${timeoutMs}ms`)),
      timeoutMs,
    ),
  );

  try {
    const result = await Promise.race([
      (async (): Promise<CollectedToolArgs | null> => {
        for await (const event of stream) {
          if (event.type === 'done') break;
          if (event.type !== 'tool_call') continue;

          const { index, id, name, arguments: args } = event;

          // Get or create accumulator for this index
          let acc = accumulators.get(index);
          if (!acc) {
            acc = { index, id, name, argsBuffer: '' };
            accumulators.set(index, acc);
          }

          // Update metadata if provided
          if (id) acc.id = id;
          if (name) acc.name = name;

          // Accumulate arguments (may be delta strings or complete objects)
          if (typeof args === 'string') {
            acc.argsBuffer += args;
          } else if (args !== undefined && args !== null) {
            // Complete object received (non-delta mode)
            return { index, id: acc.id, name: acc.name, args };
          }
        }

        // Stream ended, parse accumulated buffers
        for (const acc of accumulators.values()) {
          if (acc.name === targetName && acc.argsBuffer.length > 0) {
            try {
              const args = JSON.parse(acc.argsBuffer);
              return { index: acc.index, id: acc.id, name: acc.name, args };
            } catch (err) {
              throw new LLMError(
                LLMErrorCode.ToolArgsParseFailed,
                `Failed to parse tool args for ${targetName}`,
                undefined,
                err,
              );
            }
          }
        }

        return null;
      })(),
      timeoutPromise,
    ]);
    return result;
  } catch (err) {
    if (err instanceof LLMError && err.code === LLMErrorCode.ToolCollectionTimeout) {
      throw err;
    }
    throw new LLMError(LLMErrorCode.ToolCollectionFailed, 'Tool collection failed', undefined, err);
  }
}

/**
 * Collects all tool calls from a stream, regardless of name.
 * Useful for debugging or multi-tool scenarios.
 */
export async function collectAllToolCalls(
  stream: AsyncIterable<StreamEvent>,
  timeoutMs: number,
): Promise<CollectedToolArgs[]> {
  const accumulators = new Map<number, ToolCallAccumulator>();

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new LLMError(LLMErrorCode.ToolCollectionAllTimeout, `Tool collection timeout after ${timeoutMs}ms`)),
      timeoutMs,
    ),
  );

  try {
    await Promise.race([
      (async () => {
        for await (const event of stream) {
          if (event.type === 'done') break;
          if (event.type !== 'tool_call') continue;

          const { index, id, name, arguments: args } = event;

          let acc = accumulators.get(index);
          if (!acc) {
            acc = { index, id, name, argsBuffer: '' };
            accumulators.set(index, acc);
          }

          if (id) acc.id = id;
          if (name) acc.name = name;

          if (typeof args === 'string') {
            acc.argsBuffer += args;
          } else if (args !== undefined && args !== null) {
            // Complete object, finalize immediately
            acc.argsBuffer = JSON.stringify(args);
          }
        }
      })(),
      timeoutPromise,
    ]);
  } catch (err) {
    if (err instanceof LLMError && err.code === LLMErrorCode.ToolCollectionAllTimeout) {
      throw err;
    }
    throw new LLMError(LLMErrorCode.ToolCollectionAllFailed, 'Tool collection failed', undefined, err);
  }

  // Parse all accumulated buffers
  const results: CollectedToolArgs[] = [];
  for (const acc of accumulators.values()) {
    if (acc.argsBuffer.length === 0) continue;
    try {
      const args = JSON.parse(acc.argsBuffer);
      results.push({ index: acc.index, id: acc.id, name: acc.name, args });
    } catch (err) {
      console.error(`Failed to parse tool call index ${acc.index}:`, err);
    }
  }

  return results;
}
