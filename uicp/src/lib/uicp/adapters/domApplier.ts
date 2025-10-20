/**
 * DomApplier Module
 * 
 * WHY: Centralize DOM mutations with mandatory sanitization and deduplication.
 * INVARIANT: All HTML must pass through sanitizeHtmlStrict to prevent XSS.
 * INVARIANT: Identical content (by hash) is never applied twice (prevents flicker).
 * 
 * PR 3: Extracted from adapter.lifecycle.ts monolith
 * 
 * Design Decisions:
 * - FNV-1a hash: Fast, deterministic, good distribution for HTML strings
 * - Content-addressed: Hash is key, not time-based or counter-based
 * - Three modes: set (innerHTML), replace (outerHTML), append (insertAdjacentHTML)
 * - Deduplication key: `${windowId}:${target}` to scope per-element
 */

import { sanitizeHtmlStrict } from './adapter.security';
import type { WindowManager } from './windowManager';
import type { OperationParamMap } from '../../schema';
import { AdapterError } from './adapter.errors';

export interface DomApplier {
  apply(params: OperationParamMap['dom.set']): Promise<{ applied: number; skippedDuplicates: number }>;
}

/**
 * Stable hash for DOM content deduplication.
 * Simple FNV-1a hash for detecting identical DOM states.
 */
const hashString = (str: string): string => {
  let hash = 2166136261; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(36);
};

/**
 * Create a DomApplier instance bound to a WindowManager.
 */
export const createDomApplier = (
  windowManager: WindowManager,
  options?: {
    enableDeduplication?: boolean;
    getWorkspaceRoot?: () => HTMLElement | null;
  }
): DomApplier => {
  // Map of target selector -> content hash for deduplication
  const contentHashes = new Map<string, string>();
  const dedupeEnabled = options?.enableDeduplication !== false;
  const resolveWorkspaceRoot = options?.getWorkspaceRoot ?? (() => null);

  /**
   * Apply DOM mutation with sanitization and deduplication
   */
  const apply = async (
    params: OperationParamMap['dom.set']
  ): Promise<{ applied: number; skippedDuplicates: number }> => {
    const rawWindowId = (params.windowId ?? '').trim();
    const isWorkspaceTarget = rawWindowId.length === 0;
    const workspaceRoot = isWorkspaceTarget ? resolveWorkspaceRoot() : null;

    if (!isWorkspaceTarget && !windowManager.exists(rawWindowId)) {
      throw new AdapterError('Adapter.WindowNotFound', `Window not found: ${rawWindowId}`, { windowId: rawWindowId });
    }

    const record = isWorkspaceTarget ? undefined : windowManager.getRecord(rawWindowId);
    if (!isWorkspaceTarget && !record) {
      throw new AdapterError('Adapter.WindowNotFound', `Window record not accessible: ${rawWindowId}`, { windowId: rawWindowId });
    }

    const searchRoot: HTMLElement | null = isWorkspaceTarget ? workspaceRoot : record?.content ?? null;
    if (!searchRoot) {
      throw new AdapterError(
        'Adapter.WindowNotFound',
        isWorkspaceTarget ? 'Workspace root not registered' : `Window record not accessible: ${rawWindowId}`,
        { windowId: rawWindowId, workspace: isWorkspaceTarget }
      );
    }

    // Get target element
    let target: HTMLElement | null;
    if (params.target === '#root') {
      if (isWorkspaceTarget) {
        target = searchRoot;
      } else {
        const explicitRoot = searchRoot.querySelector('#root') as HTMLElement | null;
        target = explicitRoot ?? searchRoot;
      }
    } else {
      target = searchRoot.querySelector(params.target) as HTMLElement | null;
    }

    if (!target) {
      throw new AdapterError(
        'Adapter.DomApplyFailed',
        `Target element not found: ${params.target}`,
        {
          windowId: isWorkspaceTarget ? undefined : rawWindowId,
          workspace: isWorkspaceTarget,
          target: params.target,
        }
      );
    }

    // Sanitize HTML (unless explicitly disabled, which should never happen in production)
    const shouldSanitize = params.sanitize !== false;
    const html = shouldSanitize ? sanitizeHtmlStrict(params.html) : params.html;

    // Check deduplication (only for set/replace, not append)
    const mode = params.mode ?? 'set';
    if (dedupeEnabled && mode !== 'append') {
      const dedupeScope = isWorkspaceTarget ? '__workspace__' : rawWindowId;
      const dedupeKey = `${dedupeScope}:${params.target}`;
      const contentHash = hashString(html);
      const existing = contentHashes.get(dedupeKey);

      if (existing === contentHash) {
        // Identical content - skip update (idempotent)
        return { applied: 0, skippedDuplicates: 1 };
      }

      // Update hash
      contentHashes.set(dedupeKey, contentHash);
    }

    // Apply DOM mutation based on mode
    try {
      switch (mode) {
        case 'set':
          // eslint-disable-next-line no-restricted-syntax -- content sanitized via sanitizeHtmlStrict above
          target.innerHTML = html;
          break;

        case 'replace':
          target.outerHTML = html;
          break;

        case 'append':
          target.insertAdjacentHTML('beforeend', html);
          break;

        default:
          throw new AdapterError(
            'Adapter.ValidationFailed',
            `Invalid DOM mode: ${mode}`,
            { mode }
          );
      }
    } catch (error) {
      throw new AdapterError(
        'Adapter.DomApplyFailed',
        `DOM mutation failed: ${error instanceof Error ? error.message : String(error)}`,
        {
          windowId: isWorkspaceTarget ? undefined : rawWindowId,
          workspace: isWorkspaceTarget,
          target: params.target,
          mode,
          error,
        }
      );
    }

    return { applied: 1, skippedDuplicates: 0 };
  };

  return {
    apply,
  };
};

/**
 * Security test helper: verify that unsafe content is stripped
 */
export const testSanitization = (html: string): string => {
  return sanitizeHtmlStrict(html);
};
