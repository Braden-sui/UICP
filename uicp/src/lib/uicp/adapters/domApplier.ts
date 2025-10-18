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
  }
): DomApplier => {
  // Map of target selector -> content hash for deduplication
  const contentHashes = new Map<string, string>();
  const dedupeEnabled = options?.enableDeduplication !== false;

  /**
   * Apply DOM mutation with sanitization and deduplication
   */
  const apply = async (
    params: OperationParamMap['dom.set']
  ): Promise<{ applied: number; skippedDuplicates: number }> => {
    // Validate window exists
    const windowId = params.windowId;
    if (!windowManager.exists(windowId)) {
      throw new AdapterError('Adapter.WindowNotFound', `Window not found: ${windowId}`, { windowId });
    }

    const record = windowManager.getRecord(windowId);
    if (!record) {
      throw new AdapterError('Adapter.WindowNotFound', `Window record not accessible: ${windowId}`);
    }

    // Get target element
    const target = params.target === '#root' 
      ? record.content.querySelector('#root') 
      : record.content.querySelector(params.target);

    if (!target) {
      throw new AdapterError(
        'Adapter.DomApplyFailed',
        `Target element not found: ${params.target}`,
        { windowId, target: params.target }
      );
    }

    // Sanitize HTML (unless explicitly disabled, which should never happen in production)
    const shouldSanitize = params.sanitize !== false;
    const html = shouldSanitize ? sanitizeHtmlStrict(params.html) : params.html;

    // Check deduplication
    if (dedupeEnabled) {
      const dedupeKey = `${windowId}:${params.target}`;
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
    const mode = params.mode ?? 'set';
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
        { windowId, target: params.target, mode, error }
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
