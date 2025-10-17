import type { StreamEvent } from "../llm/ollama";
import { emitTelemetryEvent } from "../telemetry";
import type { TraceSpan } from "../telemetry/types";

const PRIMARY = new Set(["json", "final", "assistant", "commentary", "text"]);

export type TextCollectionContext = {
  traceId?: string;
  span?: TraceSpan;
  phase?: 'planner' | 'actor';
};

const resolveSpan = (context?: TextCollectionContext): TraceSpan | undefined => {
  if (!context) return undefined;
  if (context.span) return context.span;
  if (context.phase === 'planner') return 'planner';
  if (context.phase === 'actor') return 'actor';
  return undefined;
};

// WHY: Planner and Actor need text-only responses when tools are disabled; this collects from primary channels only.
// INVARIANT: Returns trimmed string; empty string if no content received before timeout or done event.
// ERROR: E-UICP-0501 LLM timeout, E-UICP-0502 iterator cleanup failed
export async function collectTextFromChannels(
  stream: AsyncIterable<StreamEvent>,
  timeoutMs = 30_000,
  context?: TextCollectionContext,
): Promise<string> {
  const iterator = stream[Symbol.asyncIterator]();
  let out = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const traceId = context?.traceId;
  const span = resolveSpan(context);

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`E-UICP-0501 LLM timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  const consume = (async () => {
    try {
      while (true) {
        const { value, done } = await iterator.next();
        if (done) break;
        const ev = value as StreamEvent;
        if (ev.type === "done") break;
        if (ev.type === 'return') {
          // Prefer explicit return payload if textual
          const r = ev.result as unknown;
          if (typeof r === 'string') return r.trim();
          if (r && typeof r === 'object') {
            const rec = r as Record<string, unknown>;
            const maybe = typeof rec.text === 'string' ? (rec.text as string) : typeof rec.value === 'string' ? (rec.value as string) : undefined;
            if (maybe) return String(maybe).trim();
          }
          continue;
        }
        if (ev.type === "content") {
          const ch = (ev.channel ?? "text").toLowerCase();
          if (PRIMARY.has(ch)) out += ev.text;
        }
        // Ignore tool_call and return in WIL/text mode
      }
      return out.trim();
    } finally {
      if (timer) clearTimeout(timer);
    }
  })();

  try {
    return await Promise.race([consume, timeoutPromise]);
  } catch (err) {
    if (timedOut && traceId) {
      emitTelemetryEvent('collect_timeout', {
        traceId,
        span: span ?? 'collector',
        status: 'timeout',
        data: { timeoutMs },
      });
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    // WHY: Iterator cleanup must run after timeout to release backend resources; failures here are non-fatal.
    // INVARIANT: Timeout error is already thrown and returned to caller; cleanup errors are logged but not re-thrown.
    // ERROR: E-UICP-0502 iterator cleanup failed (logged only, does not block timeout error)
    if (timedOut && typeof iterator.return === "function") {
      try {
        await iterator.return();
      } catch (cleanupErr) {
        console.error('E-UICP-0502 iterator cleanup failed after timeout', {
          traceId,
          timeoutMs,
          error: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
        });
      }
    }
  }
}
