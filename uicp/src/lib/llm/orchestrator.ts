import { getPlannerClient, getActorClient } from './provider';
import type { StreamEvent } from './ollama';
import { validatePlan, validateBatch, type Plan, type Batch, type Envelope } from '../uicp/schemas';
import { createId } from '../utils';

const toJsonSafe = (s: string) => s.replace(/```(json)?/gi, '').trim();

const readEnvMs = (key: string, fallback: number): number => {
  // Vite exposes env via import.meta.env; coerce string → number if valid
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (import.meta as any)?.env?.[key] as unknown;
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : undefined;
  return Number.isFinite(n) && (n as number) > 0 ? (n as number) : fallback;
};

const DEFAULT_PLANNER_TIMEOUT_MS = readEnvMs('VITE_PLANNER_TIMEOUT_MS', 120_000);
const DEFAULT_ACTOR_TIMEOUT_MS = readEnvMs('VITE_ACTOR_TIMEOUT_MS', 180_000);

async function collectCommentaryJson<T = unknown>(
  stream: AsyncIterable<StreamEvent>,
  timeoutMs = 35_000,
): Promise<T> {
  const iterator = stream[Symbol.asyncIterator]();
  let buf = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutError = new Error(`LLM timeout after ${timeoutMs}ms`);

  const parseBuffer = () => {
    const raw = toJsonSafe(buf);
    try {
      return JSON.parse(raw) as T;
    } catch (e) {
      const firstBrace = raw.indexOf('{');
      const firstBracket = raw.indexOf('[');
      const startIndex = [firstBrace, firstBracket].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? -1;
      const lastBrace = raw.lastIndexOf('}');
      const lastBracket = raw.lastIndexOf(']');
      const endIndex = Math.max(lastBrace, lastBracket);
      if (startIndex >= 0 && endIndex > startIndex) {
        const slice = raw.slice(startIndex, endIndex + 1);
        return JSON.parse(slice) as T;
      }
      throw e;
    }
  };

  const consume = (async () => {
    try {
      while (true) {
        const { value, done } = await iterator.next();
        if (done) break;
        const event = value as StreamEvent;
        if (event.type === 'done') break;
        if (event.type === 'content' && (!event.channel || event.channel === 'commentary')) {
          buf += event.text;
          // Attempt fast-path parse on each chunk: if a full JSON object/array is present, parse and stop streaming.
          try {
            const parsed = parseBuffer();
            // If parse succeeds, stop upstream stream early to cut latency and token usage.
            if (typeof iterator.return === 'function') {
              try {
                await iterator.return();
              } catch {
                // ignore iterator return errors
              }
            }
            return parsed as T;
          } catch {
            // keep accumulating until valid JSON is detected or stream ends
          }
        }
      }
      return parseBuffer();
    } finally {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    }
  })();

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([consume, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (timedOut && typeof iterator.return === 'function') {
      try {
        await iterator.return();
      } catch {
        // ignore iterator return errors
      }
    }
  }
}

export async function planWithDeepSeek(intent: string, options?: { timeoutMs?: number }): Promise<Plan> {
  const client = getPlannerClient();
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const stream = client.streamIntent(intent);
      const payload = await collectCommentaryJson(stream, options?.timeoutMs ?? DEFAULT_PLANNER_TIMEOUT_MS);
      return validatePlan(payload);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// Augment the planner output with minimal, deterministic hints for the actor (Gui).
// - Reuse a stable window id derived from the summary when none is suggested.
// - Encourage inclusion of a small aria-live status region for progress.
function augmentPlan(input: Plan): Plan {
  const risks = Array.isArray(input.risks) ? input.risks.slice() : [];
  const hasReuseId = risks.some((r) => /gui:\s*reuse\s*window\s*id/i.test(r));
  const hasStatus = risks.some((r) => /aria-live|status\s*region/i.test(r));
  const slug = input.summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'app';
  if (!hasReuseId) risks.push(`gui: reuse window id win-${slug}`);
  if (!hasStatus) risks.push('gui: include small aria-live status region updated via dom.set');
  return { summary: input.summary, risks, batch: input.batch };
}

export async function actWithGui(plan: Plan, options?: { timeoutMs?: number }): Promise<Batch> {
  const client = getActorClient();
  const planJson = JSON.stringify({ summary: plan.summary, risks: plan.risks, batch: plan.batch });
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const stream = client.streamPlan(planJson);
      const payload = await collectCommentaryJson<{ batch?: unknown }>(stream, options?.timeoutMs ?? DEFAULT_ACTOR_TIMEOUT_MS);
      return validateBatch(payload?.batch as unknown);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function runIntent(
  text: string,
  applyNow: boolean,
): Promise<{ plan: Plan; batch: Batch; notice?: 'planner_fallback' | 'actor_fallback' }> {
  // applyNow will be handled by the UI layer; reference here to satisfy strict noUnusedParameters
  void applyNow;

  let notice: 'planner_fallback' | 'actor_fallback' | undefined;
  const traceId = createId('trace');
  const txnId = createId('txn');

  // Step 1: Plan
  let plan: Plan;
  try {
    plan = await planWithDeepSeek(text);
  } catch {
    // Planner degraded: proceed with actor-only fallback using the raw intent as summary
    notice = 'planner_fallback';
    const fallback = validatePlan({ summary: `Planner degraded: using actor-only`, batch: [] });
    plan = fallback;
  }
  // Deterministically augment plan with light hints for the actor
  plan = augmentPlan(plan);

  // Step 2: Act
  let batch: Batch;
  try {
    batch = await actWithGui(plan);
  } catch {
    // Actor failed: return a safe error window batch to surface failure without partial apply
    notice = 'actor_fallback';
    const errorWin: Envelope<'window.create'> = {
      op: 'window.create',
      idempotencyKey: createId('idemp'),
      traceId,
      txnId,
      params: { id: createId('window'), title: 'Action Failed', width: 520, height: 320, x: 80, y: 80 },
    };
    const errorDom: Envelope<'dom.set'> = {
      op: 'dom.set',
      idempotencyKey: createId('idemp'),
      traceId,
      txnId,
      params: {
        windowId: errorWin.params.id!,
        target: '#root',
        html: `<div class="space-y-2"><h2 class="text-base font-semibold text-slate-800">Unable to apply plan</h2><p class="text-sm text-slate-600">The actor failed to produce a valid batch for this intent.</p></div>`,
      },
    };
    batch = validateBatch([errorWin, errorDom]);
  }

  // Step 3: Stamp idempotency keys when missing
  const stamped: Batch = batch.map((env) => ({
    ...env,
    idempotencyKey: env.idempotencyKey ?? createId('idemp'),
    traceId: env.traceId ?? traceId,
    txnId: env.txnId ?? txnId,
  }));

  // Orchestrator wiring to preview/apply is handled by chat/UI layers
  return { plan, batch: stamped, notice };
}
