import type { Plan, Batch } from '../uicp/schemas';

export type ValidatorResult = { ok: true } | { ok: false; code: string; reason: string; hint: string };

const isDomOp = (op: string): boolean => op === 'dom.set' || op === 'dom.replace' || op === 'dom.append';

export function validateFirstRender(_plan: Plan, batch: Batch): ValidatorResult {
  const hasDomOps = batch.some((env) => isDomOp(env.op));
  const hasWindowCreate = batch.some((env) => env.op === 'window.create');
  if (!hasDomOps) return { ok: true };
  if (hasWindowCreate) return { ok: true };
  const hasRootTarget = batch.some((env) => {
    if (!isDomOp(env.op)) return false;
    const params = env.params as { target?: unknown };
    const target = typeof params?.target === 'string' ? params.target.trim() : '';
    return target === '#root';
  });
  if (!hasRootTarget) {
    return {
      ok: false,
      code: 'E-UICP-0406',
      reason: 'First render must target #root or create a window',
      hint: 'Add window.create to establish a container or target #root in an initial dom.* operation.',
    };
  }
  return { ok: true };
}

export function validateWindowIdConsistency(_plan: Plan, batch: Batch): ValidatorResult {
  const created = batch.find((env) => env.op === 'window.create');
  if (!created) return { ok: true };
  const createdId = (created.params as { id?: unknown })?.id;
  const idStr = typeof createdId === 'string' ? createdId.trim() : '';
  // Collect referenced windowIds
  const referencedIds = new Set<string>();
  for (const env of batch) {
    if (isDomOp(env.op) || env.op === 'window.update') {
      const params = env.params as { windowId?: unknown };
      const winId = typeof params?.windowId === 'string' ? params.windowId.trim() : '';
      if (winId) referencedIds.add(winId);
    }
  }
  if (referencedIds.size === 0) {
    return { ok: true };
  }
  if (!idStr) {
    return {
      ok: false,
      code: 'E-UICP-0407',
      reason: 'window.create must include explicit id when subsequent operations reference a window',
      hint: 'Include id in window.create and reference the same id via params.windowId in dom.* operations.',
    };
  }
  for (const rid of referencedIds) {
    if (rid === idStr) return { ok: true };
  }
  return {
    ok: false,
    code: 'E-UICP-0407',
    reason: 'Referenced windowId does not match created window id',
    hint: 'Ensure window.create id matches params.windowId used by subsequent dom.* operations.',
  };
}

export function validateBatchForApply(plan: Plan, batch: Batch): ValidatorResult {
  const a = validateFirstRender(plan, batch);
  if (!a.ok) return a;
  const b = validateWindowIdConsistency(plan, batch);
  if (!b.ok) return b;
  const c = validateNeedsCode(plan, batch);
  if (!c.ok) return c;
  return { ok: true };
}

// Heuristic validator: if the batch relies on dynamic behavior, require a code artifact
// to be present (either via needs.code marker or a code/applet component).
// Dynamic cues include:
// - api.call with an `into` sink (drives state/view updates)
// - dom.* HTML containing common interactive markers (data-command, on* handlers)
// Pass conditions include:
// - presence of a needs.code op, or
// - component.render params that indicate a script/applet-like component
export function validateNeedsCode(_plan: Plan, batch: Batch): ValidatorResult {
  const hasNeedsCode = batch.some((env) => env.op === 'needs.code');

  // Detect dynamic behavior cues
  let requiresCode = false;
  for (const env of batch) {
    if (env.op === 'api.call') {
      const params = env.params as { into?: unknown };
      const intoSink = params && typeof params.into === 'object' && params.into !== null;
      if (intoSink) {
        requiresCode = true;
        break;
      }
    }
    if (isDomOp(env.op)) {
      const params = env.params as { html?: unknown };
      const html = typeof params?.html === 'string' ? params.html : '';
      if (html && /data-command\s*=|\bon(click|input|submit|change|keyup|keydown)\b/i.test(html)) {
        requiresCode = true;
        break;
      }
    }
  }

  if (!requiresCode) return { ok: true };
  if (hasNeedsCode) return { ok: true };

  // Try to detect presence of a code/applet component
  const hasCodeComponent = batch.some((env) => {
    if (env.op !== 'component.render') return false;
    const params = env.params as Record<string, unknown>;
    // Look for obvious keys/values suggestive of script/applet components
    for (const [k, v] of Object.entries(params)) {
      if (typeof v === 'string' && /(script|applet|code|quickjs)/i.test(v)) return true;
      if (/(script|applet|code|quickjs)/i.test(k)) return true;
    }
    return false;
  });

  if (hasCodeComponent) return { ok: true };

  return {
    ok: false,
    code: 'E-UICP-0408',
    reason: 'Batch relies on dynamic behavior but no code component or needs.code marker is present',
    hint: 'Add a needs.code operation to the batch or render a code/applet component to handle interactive logic.',
  };
}
