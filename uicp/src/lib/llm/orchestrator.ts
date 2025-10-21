import { getPlannerClient, getActorClient } from './provider';
import { getPlannerProfile, getActorProfile, type PlannerProfileKey, type ActorProfileKey } from './profiles';
import { validatePlan, validateBatch, type Plan, type Batch, type Envelope, type OperationParamMap } from '../uicp/schemas';
import { createId } from '../utils';
import { cfg } from '../config';
import { collectTextFromChannels } from '../orchestrator/collectTextFromChannels';
import { composeClarifier } from '../orchestrator/clarifier';
import { enforcePlannerCap } from '../orchestrator/plannerCap';
import { readNumberEnv } from '../env/values';
import { collectWithFallback } from './collectWithFallback';
import { normalizeBatchJson } from './jsonParsing';
import { parseWilToBatch } from '../wil/batch';
import { emitTelemetryEvent } from '../telemetry';
import { getToolRegistrySummary } from './registry';
import { getComponentCatalogSummary as getAdapterComponentCatalogSummary } from '../uicp/adapters/componentRenderer';
import { type TaskSpec } from './schemas';
import { generateTaskSpec } from './generateTaskSpec';

const DEFAULT_PLANNER_TIMEOUT_MS = readNumberEnv('VITE_PLANNER_TIMEOUT_MS', 180_000, { min: 1_000 });
const DEFAULT_ACTOR_TIMEOUT_MS = readNumberEnv('VITE_ACTOR_TIMEOUT_MS', 180_000, { min: 1_000 });

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

function buildCatalogSummary(): string {
  const comps = getAdapterComponentCatalogSummary();
  const ops = getToolRegistrySummary();
  const rules = [
    '- Prefer component.render for structured UI',
    '- Use component.update/destroy with stable component ids',
    '- Avoid dom.append when a catalog component applies',
  ].join('\n');
  return [comps, '', 'Rules:', rules, '', ops].join('\n');
}

export type RunIntentHooks = {
  onPhaseChange?: (detail: RunIntentPhaseDetail) => void;
};

export type RunIntentResult = {
  plan: Plan;
  batch: Batch;
  notice?: 'planner_fallback' | 'actor_fallback';
  traceId: string;
  timings: { planMs: number; actMs: number };
  channels?: { planner?: string; actor?: string; taskSpec?: string };
  autoApply?: boolean;
  failures?: { planner?: string; actor?: string; taskSpec?: string };
  taskSpec?: TaskSpec;
};

const buildStructuredRetryMessage = (toolName: 'emit_plan' | 'emit_batch', error: unknown, useTools: boolean): string => {
  const reason = toError(error).message.replace(/\s+/g, ' ').trim();
  const snippet = reason.length > 400 ? `${reason.slice(0, 400)}...` : reason;
  if (toolName === 'emit_plan') {
    if (useTools) {
      return `Your previous output was invalid. Call emit_plan exactly once with valid JSON {"summary":"...","batch":[]} format. No prose. Last error: ${snippet}`;
    }
    return `Your previous response did not follow the Planner contract. Output plain text sections (Summary, Steps, Risks, ActorHints). No JSON. No WIL. Last error: ${snippet}`;
  }
  if (useTools) {
    return `Your previous output was invalid. Call emit_batch exactly once with JSON {"batch": [...]} matching the schema. Do NOT emit BEGIN/END WIL or plain text. Last error: ${snippet}`;
  }
  return `Your previous response did not follow the Actor contract. Output WIL only, one command per line. No JSON or commentary. Stop on first nop:. Last error: ${snippet}`;
};

export async function planWithProfile(
  intent: string,
  options?: {
    timeoutMs?: number;
    profileKey?: PlannerProfileKey;
    traceId?: string;
    taskSpec?: TaskSpec;
    toolSummary?: string;
  },
): Promise<{ plan: Plan; channelUsed?: string }> {
  const client = getPlannerClient();
  const profile = getPlannerProfile(options?.profileKey);
  const supportsTools = profile.capabilities?.supportsTools === true;
  const useJsonFirst = supportsTools && !cfg.wilOnly;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PLANNER_TIMEOUT_MS;

  // WIL deterministic planner (local, no model call)
  if (profile.key === 'wil') {
    const stream = client.streamIntent(intent, {
      profileKey: profile.key,
      meta: { traceId: options?.traceId, intent },
    });
    const text = await collectTextFromChannels(stream, timeoutMs, {
      traceId: options?.traceId,
      phase: 'planner',
    });
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
  let extraSystem: string | undefined = buildCatalogSummary();

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const stream = client.streamIntent(intent, {
        profileKey: profile.key,
        extraSystem,
        meta: { traceId: options?.traceId, intent },
        taskSpec: options?.taskSpec,
        toolSummary: options?.toolSummary ?? buildCatalogSummary(),
      });

      // JSON-first path: collect both tool calls AND text in single pass
      if (useJsonFirst) {
        const { toolResult, textContent } = await collectWithFallback(stream, 'emit_plan', timeoutMs, {
          traceId: options?.traceId,
          phase: 'planner',
        });

        // Priority 1: Tool call result
        if (toolResult?.args) {
          try {
            const plan = validatePlan(toolResult.args);
            return { plan, channelUsed: 'tool' };
          } catch (err) {
            if (options?.traceId) {
              emitTelemetryEvent('tool_args_parsed', {
                traceId: options.traceId,
                span: 'planner',
                status: 'error',
                data: {
                  reason: 'validation_failed',
                  target: toolResult.name ?? 'emit_plan',
                  attempt: attempt + 1,
                  error: err instanceof Error ? err.message : String(err),
                },
              });
            }
            throw err;
          }
        }

        const trimmed = textContent.trim();
        const preview = trimmed.slice(0, 200) || undefined;
        if (options?.traceId) {
          emitTelemetryEvent('tool_args_parsed', {
            traceId: options.traceId,
            span: 'planner',
            status: 'error',
            data: {
              reason: 'missing_tool_call',
              target: toolResult?.name ?? 'emit_plan',
              attempt: attempt + 1,
              preview,
              fallback: trimmed.length > 0,
            },
          });
        }
        if (trimmed.length > 0) {
          const jsonFallback = tryParsePlanFromJson(trimmed);
          if (jsonFallback) {
            return { plan: jsonFallback, channelUsed: 'json-fallback' };
          }
          const outline = parsePlannerOutline(trimmed || intent);
          const fallbackPlan = validatePlan({
            summary: outline.summary,
            risks: outline.risks && outline.risks.length ? outline.risks : undefined,
            batch: [],
            actor_hints: outline.actorHints && outline.actorHints.length ? outline.actorHints : undefined,
          });
          return { plan: fallbackPlan, channelUsed: 'text-fallback' };
        }
        throw new Error(`planner_missing_tool_call${preview ? `: ${preview}` : ''}`);
      }

      // WIL-only path: collect text only
      const text = await collectTextFromChannels(stream, timeoutMs, {
        traceId: options?.traceId,
        phase: 'planner',
      });
      if (!text || text.trim().length === 0) {
        throw new Error('planner_empty');
      }

      // Try JSON parse first (model might emit JSON as content)
      const jsonPlan = tryParsePlanFromJson(text);
      if (jsonPlan) {
        return { plan: jsonPlan, channelUsed: 'json' };
      }

      // Final fallback: parse outline sections (legacy text path)
      const outline = parsePlannerOutline(text || intent);
      return {
        plan: validatePlan({
          summary: outline.summary,
          risks: outline.risks && outline.risks.length ? outline.risks : undefined,
          batch: [],
          actor_hints: outline.actorHints && outline.actorHints.length ? outline.actorHints : undefined,
        }),
        channelUsed: 'text',
      };
    } catch (err) {
      lastErr = err;
      const retry = buildStructuredRetryMessage('emit_plan', err, useJsonFirst);
      extraSystem = `${buildCatalogSummary()}\n\n${retry}`;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// Augment the planner output with minimal, deterministic hints for the actor (Gui).
// - Reuse a stable window id derived from the summary when none is suggested.
// - Encourage inclusion of a small aria-live status region for progress.
function augmentPlan(input: Plan): Plan {
  const risks: string[] = Array.isArray(input.risks) ? [...input.risks] : [];
  const hasReuseId = risks.some((r) => /gui:\s*(reuse|create)\s*window\s*id/i.test(r));
  const hasStatus = risks.some((r) => /aria-live|status\s*region/i.test(r));
  const hasDeclarativeEvents = risks.some((r) => /data-command|no\s*event\.addlistener/i.test(r));
  const slug = input.summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'app';
  // In degraded mode (empty batch), Actor must CREATE the window. Otherwise, reuse existing.
  const isEmptyBatch = !Array.isArray(input.batch) || input.batch.length === 0;
  const verb = isEmptyBatch ? 'create' : 'reuse';
  if (!hasReuseId) risks.push(`gui: ${verb} window id win-${slug}`);
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
  const risks: string[] = Array.isArray(plan.risks) ? [...plan.risks] : [];
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

function ensureWindowSpawn(plan: Plan, batch: Batch): Batch {
  const hasWindowCreate = batch.some((env) => env.op === 'window.create');
  const hasVisualOp = batch.some(
    (env) =>
      env.op === 'dom.set' ||
      env.op === 'dom.replace' ||
      env.op === 'dom.append' ||
      env.op === 'component.render' ||
      env.op === 'component.update' ||
      env.op === 'component.destroy',
  );

  if (hasWindowCreate || hasVisualOp) {
    return batch;
  }

  const summary = (plan.summary ?? 'Workspace Result').trim();
  const titleSource = summary.length > 0 ? summary : 'Workspace Result';
  const safeTitle = titleSource.slice(0, 48);
  const slug = safeTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const windowId = slug ? `win-${slug}` : createId('win');

  const fallbackWindow: Envelope<'window.create'> = {
    op: 'window.create',
    params: {
      id: windowId,
      title: safeTitle,
      size: 'md',
    },
  };

  const safeSummary = escapeHtml(titleSource);
  const fallbackDom: Envelope<'dom.set'> = {
    op: 'dom.set',
    params: {
      windowId,
      target: '#root',
      html: `<div class="stack gap-3"><h1 class="title">${safeSummary}</h1><p class="text-sm text-slate-600">The actor returned no visible UI. This placeholder keeps the desktop responsive.</p></div>`,
    },
  };

  return validateBatch([fallbackWindow, fallbackDom, ...batch]);
}

export async function actWithProfile(
  plan: Plan,
  options?: { timeoutMs?: number; profileKey?: ActorProfileKey; traceId?: string },
): Promise<{ batch: Batch; channelUsed?: string }> {
  const client = getActorClient();
  const profile = getActorProfile(options?.profileKey);
  // JSON-only for Actor (pilot): ignore non-tool profiles when wilOnly=false
  const useJsonFirst = !cfg.wilOnly;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_ACTOR_TIMEOUT_MS;
  const planJson = JSON.stringify({ summary: plan.summary, risks: plan.risks, actor_hints: plan.actorHints, batch: plan.batch });

  let lastErr: unknown;
  let extraSystem: string | undefined = buildCatalogSummary();

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const stream = client.streamPlan(planJson, {
        profileKey: profile.key,
        extraSystem,
        meta: { traceId: options?.traceId, planSummary: plan.summary },
      });

      // JSON-only path: collect tool calls and JSON text; no WIL fallback
      if (useJsonFirst) {
        const { toolResult, textContent } = await collectWithFallback(stream, 'emit_batch', timeoutMs, {
          traceId: options?.traceId,
          phase: 'actor',
        });

        // Priority 1: Tool call result
        if (toolResult?.args) {
          try {
            const batchData = toolResult.args as { batch?: unknown };
            if (Array.isArray(batchData.batch)) {
              const batch = ensureWindowSpawn(plan, validateBatch(batchData.batch));
              return { batch, channelUsed: 'tool' };
            }
          } catch (err) {
            if (options?.traceId) {
              emitTelemetryEvent('tool_args_parsed', {
                traceId: options.traceId,
                span: 'actor',
                status: 'error',
                data: {
                  reason: 'validation_failed',
                  target: toolResult.name ?? 'emit_batch',
                  attempt: attempt + 1,
                  error: err instanceof Error ? err.message : String(err),
                },
              });
            }
            throw err;
          }
        }

        const trimmed = textContent.trim();
        const preview = trimmed.slice(0, 200) || undefined;
        if (options?.traceId) {
          emitTelemetryEvent('tool_args_parsed', {
            traceId: options.traceId,
            span: 'actor',
            status: 'error',
            data: {
              reason: 'missing_tool_call',
              target: toolResult?.name ?? 'emit_batch',
              attempt: attempt + 1,
              preview,
              fallback: trimmed.length > 0,
            },
          });
        }
        if (trimmed.length > 0) {
          let fallbackBatch: Batch | null = null;
          let fallbackChannel: string | undefined;
          try {
            const normalized = normalizeBatchJson(trimmed);
            if (Array.isArray(normalized) && normalized.length > 0) {
              fallbackBatch = normalized;
              fallbackChannel = 'json-fallback';
            }
          } catch {
            // ignore parse errors; fall back to WIL below
          }
          if (!fallbackBatch) {
            const wilBatch = parseWilToBatch(trimmed);
            if (wilBatch && wilBatch.length > 0) {
              fallbackBatch = wilBatch;
              fallbackChannel = 'text-fallback';
            }
          }
          if (fallbackBatch && fallbackBatch.length > 0) {
            const ensured = ensureWindowSpawn(plan, fallbackBatch);
            return { batch: ensured, channelUsed: fallbackChannel ?? 'text-fallback' };
          }
        }
        const snippet = trimmed.slice(0, 200).replace(/\s+/g, ' ').trim();
        const detail = snippet.length > 0 ? ` (${snippet})` : '';
        throw new Error(`actor_nop: missing emit_batch tool call${detail}`);
      }

      // Legacy WIL path disabled for Actor during JSON-only pilot
      throw new Error('actor_nop: json-only actor');
    } catch (err) {
      lastErr = err;
      const retry = buildStructuredRetryMessage('emit_batch', err, useJsonFirst);
      extraSystem = `${buildCatalogSummary()}\n\n${retry}`;
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
    if (lower.startsWith('overview:') || lower.startsWith('plan overview:')) { section = 'summary'; summary = line.replace(/^.*?:\s*/, '').trim(); continue; }
    if (lower.startsWith('steps:')) { section = 'steps'; continue; }
    if (lower.startsWith('risks:')) { section = 'risks'; continue; }
    if (lower.startsWith('actorhints:') || lower.startsWith('actor hints:') || lower.startsWith('actor_hints:') || lower.startsWith('actor-hints:')) { section = 'actorHints'; continue; }
    if (lower.startsWith('appnotes:') || lower.startsWith('app notes:') || lower.startsWith('app_notes:') || lower.startsWith('app-notes:')) { section = 'appNotes'; continue; }
    if (section === 'summary' && !summary) { summary = line; continue; }
    if (section === 'risks') { risks.push(line.replace(/^[−\-•]\s*/, '')); continue; }
    if (section === 'actorHints') { actorHints.push(line.replace(/^[−\-•]\s*/, '')); continue; }
  }

  if (!summary) {
    const first = lines.find((l) => l && l.trim().length > 0)?.trim();
    summary = first ? first.replace(/:$/, '').trim() : 'Plan';
  }
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
  options?: { plannerProfileKey?: PlannerProfileKey; actorProfileKey?: ActorProfileKey; plannerTwoPhaseEnabled?: boolean },
): Promise<RunIntentResult> {
  // applyNow will be handled by the UI layer; reference here to satisfy strict noUnusedParameters
  void applyNow;

  let notice: 'planner_fallback' | 'actor_fallback' | undefined;
  const traceId = createId('trace');
  const txnId = createId('txn');
  const failures: RunIntentResult['failures'] = {};
  let taskSpec: TaskSpec | undefined;
  let taskSpecChannelUsed: string | undefined;

  // Phase 0 (Optional): Generate TaskSpec if two-phase planner enabled
  const twoPhaseEnabled = options?.plannerTwoPhaseEnabled ?? false;
  if (twoPhaseEnabled) {
    emitTelemetryEvent('planner_start', {
      traceId,
      span: 'planner',
      data: {
        intentLength: text.length,
        plannerProfile: options?.plannerProfileKey ?? 'default',
        phase: 'taskSpec',
        twoPhase: true,
      },
    });

    const taskSpecStarted = now();
    try {
      const taskSpecResult = await generateTaskSpec(text, {
        profileKey: options?.plannerProfileKey,
        traceId,
      });
      taskSpec = taskSpecResult.taskSpec;
      taskSpecChannelUsed = taskSpecResult.channelUsed;
      if (taskSpecResult.error) {
        failures.taskSpec = taskSpecResult.error;
      }
    } catch (err) {
      const failure = toError(err);
      failures.taskSpec = failure.message;
      console.warn('[runIntent] taskSpec generation failed, continuing with stub', { traceId, error: failure });
    }

    const taskSpecMs = Math.max(0, Math.round(now() - taskSpecStarted));
    emitTelemetryEvent('planner_finish', {
      traceId,
      span: 'planner',
      durationMs: taskSpecMs,
      status: failures.taskSpec ? 'error' : undefined,
      data: {
        phase: 'taskSpec',
        channel: taskSpecChannelUsed,
        goalCount: taskSpec?.goals?.length ?? 0,
        actionCount: taskSpec?.actions?.length ?? 0,
        error: failures.taskSpec,
      },
    });
  }

  emitTelemetryEvent('planner_start', {
    traceId,
    span: 'planner',
    data: {
      intentLength: text.length,
      plannerProfile: options?.plannerProfileKey ?? 'default',
      phase: 'plan',
      twoPhase: twoPhaseEnabled,
      hasTaskSpec: Boolean(taskSpec),
    },
  });

  hooks?.onPhaseChange?.({ phase: 'planning', traceId });

  const planningStarted = now();

  // Step 1: Plan (Phase 1 in two-phase, or Phase 0 in single-phase)
  let plan: Plan;
  let plannerChannelUsed: string | undefined;
  const toolSummary = taskSpec ? getToolRegistrySummary() : undefined;
  try {
    const out = await planWithProfile(text, {
      profileKey: options?.plannerProfileKey,
      traceId,
      taskSpec,
      toolSummary,
    });
    plan = out.plan;
    plannerChannelUsed = out.channelUsed;
    if (plannerChannelUsed === 'text-fallback' || plannerChannelUsed === 'json-fallback') {
      failures.planner = 'planner_missing_tool_call';
    }
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
  emitTelemetryEvent('planner_finish', {
    traceId,
    span: 'planner',
    durationMs: planMs,
    status: failures.planner ? 'error' : undefined,
    data: {
      phase: 'plan',
      channel: plannerChannelUsed,
      fallback: notice === 'planner_fallback',
      summary: plan.summary,
      twoPhase: twoPhaseEnabled,
      error: failures.planner,
    },
  });
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
  emitTelemetryEvent('actor_start', {
    traceId,
    span: 'actor',
    data: {
      plannerFallback: notice === 'planner_fallback',
      planSummaryLength: plan.summary?.length ?? 0,
      actorProfile: options?.actorProfileKey ?? 'default',
    },
  });

  // Step 2: Act
  let batch: Batch;
  let actorChannelUsed: string | undefined;
  let clarifierAttempted = false;
  try {
    const out = await actWithProfile(plan, { profileKey: options?.actorProfileKey, traceId });
    batch = out.batch;
    actorChannelUsed = out.channelUsed;
  } catch (err) {
    const failure = toError(err);
    const isActorNop = /^actor_nop:\s*/i.test(failure.message);
    if (isActorNop && notice === 'planner_fallback') {
      batch = validateBatch([]);
    } else if (isActorNop && import.meta.env.MODE !== 'test') {
      batch = validateBatch([]);
    } else if (isActorNop && !clarifierAttempted) {
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
        const clarifier = composeClarifier(questions);
        try {
          const out2 = await planWithProfile(`${text}\n\n${clarifier}`, { profileKey: options?.plannerProfileKey, traceId });
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
      notice = 'actor_fallback';
      failures.actor = failure.message;
      console.error('actor failed', { traceId, error: failure });
      batch = validateBatch([]);
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
  emitTelemetryEvent('actor_finish', {
    traceId,
    span: 'actor',
    durationMs: actMs,
    status: failures.actor ? 'error' : undefined,
    data: {
      channel: actorChannelUsed,
      batchSize: batch.length,
      plannerFallback: notice === 'planner_fallback',
      clarifierAttempted,
      error: failures.actor,
    },
  });
  return {
    plan,
    batch: stamped,
    notice,
    traceId,
    timings: { planMs, actMs },
    channels: { planner: plannerChannelUsed, actor: actorChannelUsed, taskSpec: taskSpecChannelUsed },
    failures: Object.keys(failures).length > 0 ? failures : undefined,
    taskSpec,
  };
}

// WHY: Some models stream tool calls but wrap final arguments as plain text JSON.
// Try to parse Plan from JSON text (fallback when model emits JSON as content).
function extractBalancedJsonObject(input: string): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;
  let start = -1;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = false; continue; }
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; continue; }
    if (ch === '}') { depth--; if (depth === 0 && start !== -1) return input.slice(start, i + 1); }
  }
  return null;
}

function tryParsePlanFromJson(text: string): Plan | null {
  const attempt = (s: string): Plan | null => {
    let obj: unknown;
    try { obj = JSON.parse(s); } catch { return null; }
    if (!obj || typeof obj !== 'object') return null;
    try { return validatePlan(obj); } catch { return null; }
  };

  const direct = attempt(text);
  if (direct) return direct;

  let s = (text || '').trim();
  if (s.startsWith('```')) {
    const nl = s.indexOf('\n');
    if (nl !== -1) s = s.slice(nl + 1);
    if (s.endsWith('```')) s = s.slice(0, s.lastIndexOf('```'));
  }

  const fenced = attempt(s);
  if (fenced) return fenced;

  const idx = s.indexOf('emit_plan');
  if (idx !== -1) {
    const after = s.slice(idx);
    const braceIdx = after.indexOf('{');
    if (braceIdx !== -1) {
      const jsonSub = extractBalancedJsonObject(after.slice(braceIdx));
      if (jsonSub) {
        const fromWrapper = attempt(jsonSub);
        if (fromWrapper) return fromWrapper;
      }
    }
  }

  const firstBrace = s.indexOf('{');
  if (firstBrace !== -1) {
    const obj = extractBalancedJsonObject(s.slice(firstBrace));
    if (obj) {
      const out = attempt(obj);
      if (out) return out;
    }
  }
  return null;
}

// Try to parse and normalize Envelope aliases (method->op) before falling back to WIL.
