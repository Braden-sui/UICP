import { getPlannerClient, getActorClient } from './provider';
import { getPlannerProfile, getActorProfile, type PlannerProfileKey, type ActorProfileKey } from './profiles';
import type { StreamEvent } from './ollama';
import { validatePlan, validateBatch, type Plan, type Batch, type Envelope, type OperationParamMap } from '../uicp/schemas';
import { createId } from '../utils';

const toJsonSafe = (s: string) =>
  s
    // Strip UTF-8 BOM if present
    .replace(/\uFEFF/g, '')
    // Remove common prefaces some models prepend in JSON mode
    .replace(/^\s*(?:json|assistant|commentary)\s*:?[\t\s-]*\n?/i, '')
    // Remove code fences
    .replace(/```(?:json)?/gi, '')
    .trim();

const readEnvMs = (key: string, fallback: number): number => {
  // Vite exposes env via import.meta.env; coerce string → number if valid
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (import.meta as any)?.env?.[key] as unknown;
  const n = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : undefined;
  return Number.isFinite(n) && (n as number) > 0 ? (n as number) : fallback;
};

const DEFAULT_PLANNER_TIMEOUT_MS = readEnvMs('VITE_PLANNER_TIMEOUT_MS', 120_000);
const DEFAULT_ACTOR_TIMEOUT_MS = readEnvMs('VITE_ACTOR_TIMEOUT_MS', 180_000);

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const toError = (input: unknown): Error => (input instanceof Error ? input : new Error(String(input)));
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export type RunIntentPhaseDetail =
  | { phase: 'planning'; traceId: string }
  | { phase: 'acting'; traceId: string; planMs: number };

export type RunIntentHooks = {
  onPhaseChange?: (detail: RunIntentPhaseDetail) => void;
};

export type RunIntentResult = {
  plan: Plan;
  batch: Batch;
  notice?: 'planner_fallback' | 'actor_fallback';
  traceId: string;
  timings: { planMs: number; actMs: number };
  channels?: { planner?: string; actor?: string };
  autoApply?: boolean;
  failures?: { planner?: string; actor?: string };
};

async function collectJsonFromChannels<T = unknown>(
  stream: AsyncIterable<StreamEvent>,
  options?: { timeoutMs?: number; primaryChannels?: string[]; fallbackChannels?: string[] },
): Promise<{ data: T; channelUsed?: string }> {
  const iterator = stream[Symbol.asyncIterator]();
  const primaryChannels =
    options?.primaryChannels?.map((c) => c.toLowerCase()) ?? ['json', 'assistant', 'commentary', 'final'];
  // Treat provider-tagged "text" and reasoning channels as fallback inputs. Some
  // upstreams still emit Harmony-era channel names like "analysis" or "final".
  // Accumulate them and salvage parse at flush time so valid JSON isn’t dropped.
  const fallbackChannels =
    options?.fallbackChannels?.map((c) => c.toLowerCase()) ?? ['text', 'analysis', 'thought', 'reasoning'];
  const primarySet = new Set(primaryChannels);
  const fallbackSet = new Set(fallbackChannels);
  let primaryBuf = '';
  let fallbackBuf = '';
  let primaryChannelUsed: string | undefined;
  let fallbackChannelUsed: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutMs = options?.timeoutMs ?? 35_000;
  const timeoutError = new Error(`LLM timeout after ${timeoutMs}ms`);

  const parseBuffer = (input: string) => {
    const raw = toJsonSafe(input);
    // First attempt: direct parse
    try {
      const first = JSON.parse(raw) as unknown;
      if (typeof first === 'string') {
        // Some providers wrap JSON as a string; attempt to parse again
        try {
          return JSON.parse(first) as T;
        } catch {
          // fall through to slicing salvage below
        }
      } else {
        return first as T;
      }
    } catch {
      // continue to salvage
    }

    // Salvage: take the first balanced JSON object/array from the buffer
    const firstBrace = raw.indexOf('{');
    const firstBracket = raw.indexOf('[');
    const startIndex = [firstBrace, firstBracket].filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? -1;
    const lastBrace = raw.lastIndexOf('}');
    const lastBracket = raw.lastIndexOf(']');
    const endIndex = Math.max(lastBrace, lastBracket);
    if (startIndex >= 0 && endIndex > startIndex) {
      const slice = raw.slice(startIndex, endIndex + 1).trim();
      try {
        const second = JSON.parse(slice) as unknown;
        if (typeof second === 'string') {
          // Double-encoded JSON: parse inner string
          return JSON.parse(second) as T;
        }
        return second as T;
      } catch (e2) {
        // Last-ditch: if slice is a quoted JSON string, parse as string then parse inner
        if ((slice.startsWith('"') && slice.endsWith('"')) || (slice.startsWith("'") && slice.endsWith("'"))) {
          try {
            const unquoted = JSON.parse(slice) as unknown;
            if (typeof unquoted === 'string') {
              return JSON.parse(unquoted) as T;
            }
          } catch {
            // give up
          }
        }
        throw e2;
      }
    }
    throw new Error('No JSON payload found in stream');
  };

  const consume = (async () => {
    try {
      while (true) {
        const { value, done } = await iterator.next();
        if (done) break;
        const event = value as StreamEvent;
        if (event.type === 'done') break;
        if (event.type === 'return') {
          const channel = (event.channel ?? 'return').toLowerCase();
          if (typeof iterator.return === 'function') {
            try {
              await iterator.return();
            } catch {
              // ignore iterator return errors
            }
          }
          return { data: event.result as T, channelUsed: channel };
        }
        if (event.type !== 'content') continue;
        const channel = event.channel?.toLowerCase();
        const isPrimary = !channel || primarySet.has(channel);
        const isFallback = channel ? fallbackSet.has(channel) : false;
        if (isPrimary) {
          primaryBuf += event.text;
          primaryChannelUsed = channel ?? primaryChannels[0] ?? 'commentary';
          try {
            const parsed = parseBuffer(primaryBuf);
            if (typeof iterator.return === 'function') {
              try {
                await iterator.return();
              } catch {
                // ignore iterator return errors
              }
            }
            return { data: parsed as T, channelUsed: primaryChannelUsed };
          } catch {
            // continue accumulating until buffer parses
          }
        } else if (isFallback) {
          fallbackBuf += event.text;
          fallbackChannelUsed = channel;
        }
      }
      if (primaryBuf.trim().length) {
        return {
          data: parseBuffer(primaryBuf),
          channelUsed: primaryChannelUsed ?? primaryChannels[0] ?? 'commentary',
        };
      }
      if (fallbackBuf.trim().length) {
        return {
          data: parseBuffer(fallbackBuf),
          channelUsed: fallbackChannelUsed ?? fallbackChannels[0] ?? 'commentary',
        };
      }
      throw new Error('Model did not emit parsable JSON on expected channels');
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

export async function planWithProfile(
  intent: string,
  options?: { timeoutMs?: number; profileKey?: PlannerProfileKey },
): Promise<{ plan: Plan; channelUsed?: string }> {
  const client = getPlannerClient();
  const profile = getPlannerProfile(options?.profileKey);
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const stream = client.streamIntent(intent, { profileKey: profile.key });
      const { data, channelUsed } = await collectJsonFromChannels(stream, {
        timeoutMs: options?.timeoutMs ?? DEFAULT_PLANNER_TIMEOUT_MS,
      });
      return { plan: validatePlan(data), channelUsed };
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
  const hasDeclarativeEvents = risks.some((r) => /data-command|no\s*event\.addlistener/i.test(r));
  const slug = input.summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'app';
  if (!hasReuseId) risks.push(`gui: reuse window id win-${slug}`);
  if (!hasStatus) risks.push('gui: include small aria-live status region updated via dom.set');
  if (!hasDeclarativeEvents) risks.push('gui: wire events via data-command only; NEVER emit event.addListener');
  return {
    summary: input.summary,
    risks,
    batch: input.batch,
    actorHints: input.actorHints,
  };
}

const CLARIFIER_TOKEN = 'clarifier:structured';

function isStructuredClarifierPlan(plan: Plan): boolean {
  const summary = (plan.summary ?? '').trim();
  if (!summary || !summary.endsWith('?')) return false;
  const risks = Array.isArray(plan.risks) ? plan.risks : [];
  const hasClarifierRisk = risks.some((risk) => risk.trim().toLowerCase().startsWith(CLARIFIER_TOKEN));
  if (!hasClarifierRisk) return false;
  if (!Array.isArray(plan.batch) || plan.batch.length !== 1) return false;
  const [entry] = plan.batch;
  if (entry.op !== 'api.call') return false;
  const params = entry.params as OperationParamMap['api.call'];
  if (!params || typeof params !== 'object') return false;
  if (typeof params.url !== 'string' || !params.url.toLowerCase().startsWith('uicp://intent')) return false;
  const body = params.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') return false;
  if (typeof (body as Record<string, unknown>).text === 'string') return false;
  const hasPrompt = typeof (body as Record<string, unknown>).textPrompt === 'string';
  const fields = (body as Record<string, unknown>).fields as unknown;
  const hasFields = Array.isArray(fields);
  if (!hasPrompt && !hasFields) return false;
  return true;
}

export async function actWithProfile(
  plan: Plan,
  options?: { timeoutMs?: number; profileKey?: ActorProfileKey },
): Promise<{ batch: Batch; channelUsed?: string }> {
  const client = getActorClient();
  const profile = getActorProfile(options?.profileKey);
  const planJson = JSON.stringify({ summary: plan.summary, risks: plan.risks, batch: plan.batch });
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const stream = client.streamPlan(planJson, { profileKey: profile.key });
      const { data, channelUsed } = await collectJsonFromChannels<{ batch?: unknown }>(stream, {
        timeoutMs: options?.timeoutMs ?? DEFAULT_ACTOR_TIMEOUT_MS,
      });
      const payload = Array.isArray(data) ? data : (data as { batch?: unknown })?.batch;
      return { batch: validateBatch(payload as unknown), channelUsed };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// Legacy aliases (default to configured profiles).
export const planWithDeepSeek = async (intent: string, options?: { timeoutMs?: number }) =>
  (await planWithProfile(intent, options)).plan;

export const actWithGui = async (plan: Plan, options?: { timeoutMs?: number }) =>
  (await actWithProfile(plan, options)).batch;

export async function runIntent(
  text: string,
  applyNow: boolean,
  hooks?: RunIntentHooks,
  options?: { plannerProfileKey?: PlannerProfileKey; actorProfileKey?: ActorProfileKey },
): Promise<RunIntentResult> {
  // applyNow will be handled by the UI layer; reference here to satisfy strict noUnusedParameters
  void applyNow;

  let notice: 'planner_fallback' | 'actor_fallback' | undefined;
  const traceId = createId('trace');
  const txnId = createId('txn');
  const failures: RunIntentResult['failures'] = {};

  hooks?.onPhaseChange?.({ phase: 'planning', traceId });

  const planningStarted = now();

  // Step 1: Plan
  let plan: Plan;
  let plannerChannelUsed: string | undefined;
  try {
    const out = await planWithProfile(text, { profileKey: options?.plannerProfileKey });
    plan = out.plan;
    plannerChannelUsed = out.channelUsed;
  } catch (err) {
    const failure = toError(err);
    // Planner degraded: proceed with actor-only fallback using the raw intent as summary
    notice = 'planner_fallback';
    failures.planner = failure.message;
    console.error('planner failed', { traceId, error: failure });
    const fallback = validatePlan({
      summary: `Planner degraded: using actor-only`,
      batch: [],
      risks: [`planner_error: ${failure.message}`],
    });
    plan = fallback;
  }
  const isClarifier = isStructuredClarifierPlan(plan);
  if (!isClarifier) {
    // Deterministically augment plan with light hints for the actor
    plan = augmentPlan(plan);
  }

  const planMs = Math.max(0, Math.round(now() - planningStarted));
  hooks?.onPhaseChange?.({ phase: 'acting', traceId, planMs });

  if (isClarifier) {
    const clarifiedBatch = validateBatch(plan.batch);
    return {
      plan,
      batch: clarifiedBatch,
      notice,
      traceId,
      timings: { planMs, actMs: 0 },
      channels: { planner: plannerChannelUsed },
      autoApply: true,
    };
  }

  const actingStarted = now();

  // Step 2: Act
  let batch: Batch;
  let actorChannelUsed: string | undefined;
  try {
    const out = await actWithProfile(plan, { profileKey: options?.actorProfileKey });
    batch = out.batch;
    actorChannelUsed = out.channelUsed;
  } catch (err) {
    const failure = toError(err);
    // Actor failed: return a safe error window batch to surface failure without partial apply
    notice = 'actor_fallback';
    failures.actor = failure.message;
    console.error('actor failed', { traceId, error: failure });
    const errorWin: Envelope<'window.create'> = {
      op: 'window.create',
      idempotencyKey: createId('idemp'),
      traceId,
      txnId,
      params: { id: createId('window'), title: 'Action Failed', width: 520, height: 320, x: 80, y: 80 },
    };
    const safeMessage = escapeHtml(failure.message);
    const errorDom: Envelope<'dom.set'> = {
      op: 'dom.set',
      idempotencyKey: createId('idemp'),
      traceId,
      txnId,
      params: {
        windowId: errorWin.params.id!,
        target: '#root',
        html: `<div class="space-y-2"><h2 class="text-base font-semibold text-slate-800">Unable to apply plan</h2><p class="text-sm text-slate-600">The actor failed to produce a valid batch for this intent.</p><pre class="rounded bg-slate-100 p-2 text-xs text-slate-700">${safeMessage}</pre></div>`,
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
  const actMs = Math.max(0, Math.round(now() - actingStarted));
  return {
    plan,
    batch: stamped,
    notice,
    traceId,
    timings: { planMs, actMs },
    channels: { planner: plannerChannelUsed, actor: actorChannelUsed },
    failures: Object.keys(failures).length > 0 ? failures : undefined,
  };
}
