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
  return { ok: true };
}
