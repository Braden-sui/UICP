/**
 * Batch Linter Module (E-UICP-0400 series)
 * 
 * Pre-apply validation gate that rejects low-value batches:
 * - E-UICP-0401: No visible effect
 * - E-UICP-0402: Targets missing selectors without creating window
 * - E-UICP-0403: Only appends inert text without interactive elements
 * 
 * Purpose: Make component-first behavior the path of least resistance.
 * Models that emit useful, structured UI pass through; lazy text-only batches are rejected.
 */

import type { Batch } from './schemas';
import { getComponentCatalogSummary } from './componentRenderer';

export type LintResult =
  | { ok: true }
  | { ok: false; code: string; reason: string; hint: string };

const VISUAL_OPS = new Set([
  'window.create',
  'window.update',
  'dom.set',
  'dom.replace',
  'dom.append',
  'component.render',
  'component.update',
  'needs.code',
]);

const INTERACTIVE_PATTERNS = [
  /data-command\s*=/i,
  /<button\b/i,
  /<input\b/i,
  /<textarea\b/i,
  /<select\b/i,
  /<form\b/i,
  /\bhref\s*=\s*["']https?:/i,
];

/**
 * Check if HTML contains interactive elements or data-command attributes
 */
function hasInteractiveContent(html: string): boolean {
  if (!html || typeof html !== 'string') return false;
  return INTERACTIVE_PATTERNS.some((pattern) => pattern.test(html));
}

/**
 * Check if batch creates or references a window
 */
function establishesWindow(batch: Batch): boolean {
  return batch.some(
    (env) => env.op === 'window.create' || env.op === 'window.update'
  );
}

/**
 * Check if batch has at least one visual effect
 */
function hasVisualEffect(batch: Batch): boolean {
  return batch.some((env) => VISUAL_OPS.has(env.op));
}

/**
 * Check if batch only appends plain text without structure
 */
function isInertTextOnly(batch: Batch): boolean {
  const visualEnvs = batch.filter((env) => VISUAL_OPS.has(env.op));
  if (visualEnvs.length === 0) return false;

  // If there's a component.render or component.update, it's not inert
  if (visualEnvs.some((env) => env.op.startsWith('component.'))) {
    return false;
  }

  // Check dom.* operations (exclude window.create/update)
  const domOps = visualEnvs.filter((env) =>
    env.op === 'dom.set' || env.op === 'dom.replace' || env.op === 'dom.append'
  );

  if (domOps.length === 0) {
    // Only window.create/update with no DOM ops - that's OK
    return false;
  }

  // All dom ops must be append-only with no interactive content for batch to be inert
  const onlyInertAppends = domOps.every((env) => {
    if (env.op !== 'dom.append') return false;
    const params = env.params as { html?: unknown };
    const html = typeof params?.html === 'string' ? params.html : '';
    if (!html.trim()) return true; // Empty is inert
    return !hasInteractiveContent(html);
  });

  // If all DOM ops are inert appends, the batch is inert
  return onlyInertAppends && domOps.length > 0;
}

/**
 * Check if batch references DOM selectors without establishing a window first
 */
function hasDanglingSelectors(batch: Batch): boolean {
  const hasWindow = establishesWindow(batch);
  if (hasWindow) return false;

  // Check if any dom.* ops reference targets without a valid windowId
  const domOps = batch.filter((env) =>
    env.op === 'dom.set' || env.op === 'dom.replace' || env.op === 'dom.append'
  );

  return domOps.some((env) => {
    const params = env.params as { target?: unknown; windowId?: unknown };
    const hasValidWindowId = typeof params?.windowId === 'string' && params.windowId.trim().length > 0;
    const hasTarget = typeof params?.target === 'string' && params.target.trim().length > 0;
    // If target is present but windowId is missing/empty, it's dangling
    return hasTarget && !hasValidWindowId;
  });
}

/**
 * Lint a batch before application
 * 
 * INVARIANT: Empty batches pass (handled by orchestrator-level degraded mode)
 * INVARIANT: Batches with txn.cancel pass (queue handles immediately)
 * INVARIANT: Batches with api.call pass if they include follow-up UI
 */
export function lintBatch(batch: Batch): LintResult {
  // Rule 0: Empty batches and txn.cancel are not linted (orchestrator-level concerns)
  if (batch.length === 0) {
    return { ok: true };
  }

  if (batch.some((env) => env.op === 'txn.cancel')) {
    return { ok: true };
  }

  // Rule 1: Batch must create at least one visible effect
  if (!hasVisualEffect(batch)) {
    const catalog = getComponentCatalogSummary();
    return {
      ok: false,
      code: 'E-UICP-0401',
      reason: 'Batch creates no visible UI effect',
      hint: `Add window.create, component.render, or dom.set operation.\n\n${catalog}`,
    };
  }

  // Rule 2: If batch targets DOM selectors, it must establish a window
  if (hasDanglingSelectors(batch)) {
    return {
      ok: false,
      code: 'E-UICP-0402',
      reason: 'Batch targets DOM selectors without creating or specifying window',
      hint: 'Add window.create operation or include windowId in params',
    };
  }

  // Rule 3: Batch must not be inert text-only appends
  if (isInertTextOnly(batch)) {
    const catalog = getComponentCatalogSummary();
    return {
      ok: false,
      code: 'E-UICP-0403',
      reason: 'Batch only appends plain text without interactive elements or structure',
      hint: `Use component.render for structured UI, or add interactive elements (buttons, forms, data-command attributes).\n\n${catalog}`,
    };
  }

  return { ok: true };
}

/**
 * Format lint error for retry prompt injection
 */
export function formatLintError(result: LintResult): string {
  if (result.ok) return '';
  return `BATCH REJECTED: ${result.code} - ${result.reason}\n\n${result.hint}`;
}
