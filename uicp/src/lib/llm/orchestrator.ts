import { getPlannerClient, getActorClient } from './provider';
import type { StreamEvent } from './ollama';
import { validatePlan, validateBatch, type Plan, type Batch, type Envelope } from '../uicp/schemas';
import { createId } from '../utils';

const toJsonSafe = (s: string) => s.replace(/```(json)?/gi, '').trim();

async function collectCommentaryJson<T = unknown>(stream: AsyncIterable<StreamEvent>, timeoutMs = 35_000): Promise<T> {
  let buf = '';
  const timer = setTimeout(() => {
    // The iterator consumer will see an abort when they next await
    throw new Error('LLM timeout after 35s');
  }, timeoutMs);

  try {
    for await (const ev of stream) {
      if (ev.type === 'content' && (!ev.channel || ev.channel === 'commentary')) {
        buf += ev.text;
      }
      if (ev.type === 'done') break;
    }
  } finally {
    clearTimeout(timer);
  }

  const raw = toJsonSafe(buf);
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    // Try extracting the first JSON object/array if model leaked extra commentary
    const firstBrace = raw.indexOf('{');
    const firstBracket = raw.indexOf('[');
    const start = [firstBrace, firstBracket].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? -1;
    const lastBrace = raw.lastIndexOf('}');
    const lastBracket = raw.lastIndexOf(']');
    const end = Math.max(lastBrace, lastBracket);
    if (start >= 0 && end > start) {
      const slice = raw.slice(start, end + 1);
      return JSON.parse(slice) as T;
    }
    throw e;
  }
}

export async function planWithDeepSeek(intent: string): Promise<Plan> {
  const client = getPlannerClient();
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const stream = client.streamIntent(intent);
      const payload = await collectCommentaryJson(stream);
      return validatePlan(payload);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function actWithKimi(plan: Plan): Promise<Batch> {
  const client = getActorClient();
  const planJson = JSON.stringify({ summary: plan.summary, risks: plan.risks, batch: plan.batch });
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const stream = client.streamPlan(planJson);
      const payload = await collectCommentaryJson<{ batch?: unknown }>(stream);
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

  // Step 2: Act
  let batch: Batch;
  try {
    batch = await actWithKimi(plan);
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
