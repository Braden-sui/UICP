import { getPlannerClient, getActorClient } from './provider';
import { getPlannerProfile, getActorProfile, type PlannerProfileKey, type ActorProfileKey } from './profiles';
import type { StreamEvent } from './ollama';
// JSON parsing removed for WIL-only mode
import { validatePlan, validateBatch, type Plan, type Batch, type Envelope, type OperationParamMap } from '../uicp/schemas';
import { createId } from '../utils';
import { parseUtterance } from '../wil/parse';
import { toOp } from '../wil/map';
import { cfg } from '../config';
import { collectTextFromChannels } from '../orchestrator/collectTextFromChannels';
import { parseWILBatch } from '../orchestrator/parseWILBatch';
import { composeClarifier } from '../orchestrator/clarifier';
import { enforcePlannerCap } from '../orchestrator/plannerCap';
import { composeClarifier } from '../orchestrator/clarifier';

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

const buildStructuredRetryMessage = (toolName: 'emit_plan' | 'emit_batch', error: unknown): string => {
  const reason = toError(error).message.replace(/\s+/g, ' ').trim();
  const snippet = reason.length > 400 ? `${reason.slice(0, 400)}...` : reason;
  if (toolName === 'emit_plan') {
    return `Your previous response did not follow the Planner contract. Output plain text sections (Summary, Steps, Risks, ActorHints). No JSON. No WIL. Last error: ${snippet}`;
  }
  return `Your previous response did not follow the Actor contract. Output WIL only, one command per line. No JSON or commentary. Stop on first nop:. Last error: ${snippet}`;
};

// JSON collectors removed in WIL-only mode.

export async function planWithProfile(
  intent: string,
  options?: { timeoutMs?: number; profileKey?: PlannerProfileKey },
): Promise<{ plan: Plan; channelUsed?: string }> {
  const client = getPlannerClient();
  const profile = getPlannerProfile(options?.profileKey);
  // WIL planner: collect plain text outline and emit empty-batch plan
  if (cfg.wilOnly || profile.key === 'wil') {
    const stream = client.streamIntent(intent, { profileKey: profile.key });
    const text = await collectTextFromChannels(stream, options?.timeoutMs ?? DEFAULT_PLANNER_TIMEOUT_MS);
    if (!text || text.trim().length === 0) {
      throw new Error('planner_empty');
    }
    const outline = parsePlannerOutline(text || intent);
    const plan = validatePlan({
      summary: outline.summary,
      risks: outline.risks && outline.risks.length ? outline.risks : undefined,
      batch: [],
      actor_hints: outline.actorHints && outline.actorHints.length ? outline.actorHints : undefined,
    });
    return { plan, channelUsed: 'text' };
  }
  let lastErr: unknown;
  let extraSystem: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const stream = client.streamIntent(intent, { profileKey: profile.key, extraSystem });
      const { data, channelUsed } = await collectJsonFromChannels(stream, {
        timeoutMs: options?.timeoutMs ?? DEFAULT_PLANNER_TIMEOUT_MS,
      });
      return { plan: validatePlan(data), channelUsed };
    } catch (err) {
      lastErr = err;
      extraSystem = buildStructuredRetryMessage('emit_plan', err);
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
  let extraSystem: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (cfg.wilOnly || profile.key === 'wil') {
        const stream = client.streamPlan(planJson, { profileKey: profile.key, extraSystem });
        const text = await collectTextFromChannels(stream, options?.timeoutMs ?? DEFAULT_ACTOR_TIMEOUT_MS);
        if (!text || text.trim().length === 0) {
          throw new Error('actor_nop: invalid WIL line');
        }
        const items = parseWILBatch(text);
        const nop = items.find((i) => 'nop' in i) as { nop: string } | undefined;
        if (nop) throw new Error(`actor_nop: ${nop.nop}`);
        const ops = items.filter((i): i is { op: string; params: unknown } => 'op' in i);
        return { batch: validateBatch(ops), channelUsed: 'text' };
      }

      const stream = client.streamPlan(planJson, { profileKey: profile.key, extraSystem });
      const { data, channelUsed } = await collectJsonFromChannels<{ batch?: unknown }>(stream, {
        timeoutMs: options?.timeoutMs ?? DEFAULT_ACTOR_TIMEOUT_MS,
      });
      const payload = Array.isArray(data) ? data : (data as { batch?: unknown })?.batch;
      if (!Array.isArray(payload)) {
        const summary = data && typeof data === 'object' ? `keys=${Object.keys(data as Record<string, unknown>).join(',')}` : String(data);
        throw new Error(`emit_batch must return an object with a batch array. Received ${summary || 'empty payload'}.`);
      }
      return { batch: validateBatch(payload as unknown), channelUsed };
    } catch (err) {
      lastErr = err;
      extraSystem = buildStructuredRetryMessage('emit_batch', err);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function parsePlannerOutline(text: string): { summary: string; risks?: string[]; actorHints?: string[] } {
  const lines = (text || '').split(/\r?\n/);
  let section: 'summary' | 'steps' | 'risks' | 'actorHints' | 'appNotes' | null = null;
  let summary = '';
  const risks: string[] = [];
  const actorHints: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const lower = line.toLowerCase();
    if (lower.startsWith('summary:')) { section = 'summary'; summary = line.slice(8).trim(); continue; }
    if (lower.startsWith('steps:')) { section = 'steps'; continue; }
    if (lower.startsWith('risks:')) { section = 'risks'; continue; }
    if (lower.startsWith('actorhints:')) { section = 'actorHints'; continue; }
    if (lower.startsWith('appnotes:')) { section = 'appNotes'; continue; }
    if (section === 'summary' && !summary) { summary = line; continue; }
    if (section === 'risks') { risks.push(line.replace(/^[-•]\s*/, '')); continue; }
    if (section === 'actorHints') { actorHints.push(line.replace(/^[-•]\s*/, '')); continue; }
  }

  if (!summary) summary = 'Plan';
  return { summary, risks, actorHints };
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
  let clarifierAttempted = false;
  try {
    const out = await actWithProfile(plan, { profileKey: options?.actorProfileKey });
    batch = out.batch;
    actorChannelUsed = out.channelUsed;
  } catch (err) {
    const failure = toError(err);
    const isActorNop = /^actor_nop:\s*/i.test(failure.message);
    if (isActorNop && !clarifierAttempted) {
      const reason = failure.message.replace(/^actor_nop:\s*/i, '').trim() || 'missing details';
      // Propose multiple-choice defaults for common cases
      const choicesByReason: Record<string, string[]> = {
        'missing window id': ['win-notes', 'win-app', 'win-main'],
        'invalid url': ['https://example.com', 'https://uicp.local/ready'],
      };
      const lower = reason.toLowerCase();
      const opts =
        lower.includes('missing window id') ? choicesByReason['missing window id'] : lower.includes('invalid url') ? choicesByReason['invalid url'] : undefined;
      const questions = [{ key: 'missing', prompt: `Provide missing details to continue (${reason})`, options: opts, defaultIndex: opts ? 0 : undefined }];
      const caps = enforcePlannerCap(clarifierAttempted ? 1 : 0, questions.length);
      notice = 'planner_fallback';
      failures.actor = reason;
      clarifierAttempted = true;
      if (!caps.ok) {
        // Over caps: return with empty batch; UI surfaces reason
        batch = validateBatch([]);
      } else {
        const clarifier = composeClarifier(questions as any);
        try {
          const out2 = await planWithProfile(`${text}\n\n${clarifier}`, { profileKey: options?.plannerProfileKey });
          plan = out2.plan;
          plannerChannelUsed = out2.channelUsed ?? plannerChannelUsed;
        } catch (replanErr) {
          console.error('clarifier replan failed', replanErr);
        }
        batch = validateBatch([]);
      }
    } else if (isActorNop) {
      notice = 'planner_fallback';
      failures.actor = failure.message.replace(/^actor_nop:\s*/i, '').trim();
      console.error('actor emitted nop; routing back to planner', { traceId, error: failure });
      batch = validateBatch([]);
    } else {
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
