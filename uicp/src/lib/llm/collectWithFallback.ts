import type { StreamEvent } from './ollama';
import type { CollectedToolArgs } from './collectToolArgs';
import { emitTelemetryEvent } from '../telemetry';
import type { TelemetryEventPayload, TraceSpan } from '../telemetry/types';

export type CollectionResult = {
  toolResult?: CollectedToolArgs;
  textContent: string;
};

export type CollectionContext = {
  traceId?: string;
  span?: TraceSpan;
  phase?: 'planner' | 'actor' | 'taskSpec';
};

const resolveSpan = (context?: CollectionContext): TraceSpan | undefined => {
  if (!context) return undefined;
  if (context.span) return context.span;
  if (context.phase === 'planner' || context.phase === 'taskSpec') return 'planner';
  if (context.phase === 'actor') return 'actor';
  return undefined;
};

/**
 * Collects tool call arguments and raw text from a single stream pass.
 * This avoids double-iterating the stream while still capturing textual payloads
 * for telemetry or debugging when the model malfunctions.
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
  context?: CollectionContext,
): Promise<CollectionResult> {
  type ToolAccumulator = {
    index: number;
    id?: string;
    name?: string;
    parts: string[];
    objectArg?: unknown;
  };

  const traceId = context?.traceId;
  const span = resolveSpan(context);
  const emit = (
    name: Parameters<typeof emitTelemetryEvent>[0],
    payload?: Omit<TelemetryEventPayload, 'traceId'>,
  ) => {
    if (!traceId) return;
    emitTelemetryEvent(name, {
      traceId,
      span,
      ...(payload ?? {}),
    });
  };

  const accumulators = new Map<number, ToolAccumulator>();
  const textParts: string[] = [];

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      reject(new Error(`E-UICP-0105: Collection timeout after ${timeoutMs}ms`));
    }, timeoutMs);
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
            // WHY: keep original text for diagnostics when tooling fails
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
    if (timeoutId) clearTimeout(timeoutId);
    if (timedOut) {
      emit('collect_timeout', {
        status: 'timeout',
        data: { targetToolName, timeoutMs },
      });
      throw err instanceof Error ? err : new Error(String(err));
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
          emit('tool_args_parsed', {
            status: 'error',
            data: {
              reason: 'json_parse_failed',
              target: targetToolName,
              index: match.index,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }

      if (parsedArgs !== undefined) {
        toolResult = {
          index: match.index,
          id: match.id,
          name: match.name ?? targetToolName,
          args: parsedArgs,
        };
        emit('tool_args_parsed', {
          data: {
            index: toolResult.index,
            name: toolResult.name ?? targetToolName,
            source: 'stream',
          },
        });
      }
    }
  }

  if (!toolResult && candidates.length > 1) {
    emit('tool_args_parsed', {
      status: 'error',
      data: {
        reason: 'no_match',
        target: targetToolName,
        candidates: candidates.map(({ index, name }) => ({ index, name })),
      },
    });
  }

  return { toolResult, textContent };
}
