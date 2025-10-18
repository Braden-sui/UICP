import { getPlannerClient } from './provider';
import { getPlannerProfile, type PlannerProfileKey } from './profiles';
import { collectWithFallback } from './collectWithFallback';
import { taskSpecSchema, buildTaskSpecStub, type TaskSpec } from './schemas';
import { getToolRegistrySummary } from './registry';
import { emitTelemetryEvent } from '../telemetry';
import { readNumberEnv } from '../env/values';

const DEFAULT_TASKSPEC_TIMEOUT_MS = readNumberEnv('VITE_TASK_SPEC_TIMEOUT_MS', 60_000, { min: 1_000 });

const toError = (input: unknown): Error => (input instanceof Error ? input : new Error(String(input)));

/**
 * Phase 1: Generate comprehensive TaskSpec from raw user intent.
 *
 * The TaskSpec Architect performs deep technical analysis including:
 * - Requirements analysis (goals, constraints, artifacts, acceptance criteria)
 * - Edge case and error scenario identification
 * - Data model design (state keys, data structures, data flow)
 * - UI/UX specification (window, layout, interactions, accessibility)
 * - Dependency and blocker analysis
 * - Implementation complexity assessment and phasing
 * - Assumption and ambiguity identification
 *
 * Returns a TaskSpec that serves as the SINGLE SOURCE OF TRUTH for planning.
 * Falls back to a minimal stub on failure.
 */
export async function generateTaskSpec(
  intent: string,
  options?: { timeoutMs?: number; profileKey?: PlannerProfileKey; traceId?: string },
): Promise<{ taskSpec: TaskSpec; channelUsed?: string; error?: string }> {
  const client = getPlannerClient();
  const profile = getPlannerProfile(options?.profileKey);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TASKSPEC_TIMEOUT_MS;
  const traceId = options?.traceId;

  // WIL profile doesn't support TaskSpec generation - return stub
  if (profile.key === 'wil') {
    return { taskSpec: buildTaskSpecStub(intent), channelUsed: 'stub' };
  }

  // Skip if profile doesn't implement formatTaskSpecMessages
  if (typeof profile.formatTaskSpecMessages !== 'function') {
    return { taskSpec: buildTaskSpecStub(intent), channelUsed: 'stub' };
  }

  const toolSummary = getToolRegistrySummary();

  try {
    const stream = client.streamIntent(intent, {
      profileKey: profile.key,
      mode: 'taskSpec',
      toolSummary,
      meta: { traceId, intent, mode: 'taskSpec' },
    });

    const { textContent } = await collectWithFallback(stream, 'emit_task_spec', timeoutMs, {
      traceId,
      phase: 'taskSpec',
    });

    if (!textContent || textContent.trim().length === 0) {
      return {
        taskSpec: buildTaskSpecStub(intent),
        channelUsed: 'stub',
        error: 'taskspec_empty',
      };
    }

    // Try to parse JSON from text content
    const parsed = tryParseTaskSpec(textContent);
    if (parsed) {
      if (traceId) {
        emitTelemetryEvent('tool_args_parsed', {
          traceId,
          span: 'planner',
          data: {
            phase: 'taskSpec',
            channel: 'json',
            goalCount: parsed.goals?.length ?? 0,
            actionCount: parsed.actions?.length ?? 0,
            edgeCaseCount: parsed.edge_cases?.length ?? 0,
            errorScenarioCount: parsed.error_scenarios?.length ?? 0,
            stateKeyCount: parsed.data_model?.state_keys?.length ?? 0,
            interactionCount: parsed.ui_specification?.interactions?.length ?? 0,
            blockerCount: parsed.dependencies?.blockers?.length ?? 0,
            openQuestionCount: parsed.open_questions?.length ?? 0,
            hasPhases: (parsed.implementation_phases?.length ?? 0) > 0,
          },
        });
      }
      return { taskSpec: parsed, channelUsed: 'json' };
    }

    // Parsing failed - return stub
    return {
      taskSpec: buildTaskSpecStub(intent),
      channelUsed: 'stub',
      error: 'taskspec_parse_failed',
    };
  } catch (err) {
    const error = toError(err);
    console.warn('[generateTaskSpec] failed, falling back to stub', { traceId, error: error.message });
    return {
      taskSpec: buildTaskSpecStub(intent),
      channelUsed: 'stub',
      error: error.message,
    };
  }
}

function tryParseTaskSpec(text: string): TaskSpec | null {
  const extractBalancedJsonObject = (input: string): string | null => {
    let depth = 0;
    let inStr = false;
    let esc = false;
    let start = -1;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (inStr) {
        if (esc) {
          esc = false;
          continue;
        }
        if (ch === '\\') {
          esc = true;
          continue;
        }
        if (ch === '"') {
          inStr = false;
        }
        continue;
      }
      if (ch === '"') {
        inStr = true;
        if (start === -1) start = i;
        continue;
      }
      if (ch === '{') {
        if (depth === 0) start = i;
        depth++;
        continue;
      }
      if (ch === '}') {
        depth--;
        if (depth === 0 && start !== -1) return input.slice(start, i + 1);
      }
    }
    return null;
  };

  const attempt = (s: string): TaskSpec | null => {
    try {
      const obj = JSON.parse(s);
      const result = taskSpecSchema.safeParse(obj);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  };

  // Try direct parse
  const direct = attempt(text);
  if (direct) return direct;

  // Try removing fences
  let s = text.trim();
  if (s.startsWith('```')) {
    const nl = s.indexOf('\n');
    if (nl !== -1) s = s.slice(nl + 1);
    if (s.endsWith('```')) s = s.slice(0, s.lastIndexOf('```'));
  }

  const fenced = attempt(s);
  if (fenced) return fenced;

  // Try extracting first balanced JSON object
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
