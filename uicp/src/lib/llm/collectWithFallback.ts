import type { StreamEvent } from './ollama';
import type { CollectedToolArgs } from './collectToolArgs';

export type CollectionResult = {
  toolResult?: CollectedToolArgs;
  textContent: string;
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
  const toolAccumulator: { index?: number; id?: string; name?: string; argsBuffer: string } = {
    argsBuffer: '',
  };
  const textParts: string[] = [];

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`E-UICP-0105: Collection timeout after ${timeoutMs}ms`)), timeoutMs),
  );

  try {
    await Promise.race([
      (async () => {
        for await (const event of stream) {
          if (event.type === 'done') break;

          if (event.type === 'tool_call') {
            const { index, id, name, arguments: args } = event;

            // First tool_call event for target tool
            if (name === targetToolName) {
              if (toolAccumulator.index === undefined) {
                toolAccumulator.index = index;
                toolAccumulator.id = id;
                toolAccumulator.name = name;
              }

              // Accumulate arguments
              if (typeof args === 'string') {
                toolAccumulator.argsBuffer += args;
              } else if (args !== undefined && args !== null) {
                // Complete object received (non-delta mode)
                toolAccumulator.argsBuffer = JSON.stringify(args);
              }
            }
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
  }

  const textContent = textParts.join('');

  // Parse tool args if we collected any
  let toolResult: CollectedToolArgs | undefined;
  if (toolAccumulator.name && toolAccumulator.argsBuffer.length > 0) {
    try {
      const args = JSON.parse(toolAccumulator.argsBuffer);
      toolResult = {
        index: toolAccumulator.index ?? 0,
        id: toolAccumulator.id,
        name: toolAccumulator.name,
        args,
      };
    } catch (err) {
      console.warn(`Failed to parse tool args for ${targetToolName}:`, err);
      // Don't throw - just return without toolResult, text fallback will be used
    }
  }

  return { toolResult, textContent };
}
