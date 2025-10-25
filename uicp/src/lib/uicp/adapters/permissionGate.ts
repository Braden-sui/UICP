/**
 * PermissionGate Module
 * 
 * Centralized permission checks for adapter operations.
 * Wraps existing PermissionManager with adapter-friendly interface.
 * 
 * PR 5: Extracted permission logic for modular adapter
 */

import type { PermissionDecision, PermissionScope, PermissionContext } from './adapter.types';

export interface PermissionGate {
  /**
   * Check if operation scope is permitted.
   * Returns 'granted' or 'denied'.
   */
  require(
    scope: PermissionScope,
    context: PermissionContext
  ): Promise<PermissionDecision>;

  /**
   * Check if scope requires permission check.
   * Low-risk scopes are allow-listed and skip checks.
   */
  isGated(scope: PermissionScope): boolean;
}

/**
 * Create a PermissionGate instance.
 */
export const createPermissionGate = (): PermissionGate => {

  /**
   * Check if scope requires permission check
   */
  const isGated = (scope: PermissionScope): boolean => {
    // Only DOM-related operations have risk that depends on params (e.g., sanitize flag)
    return scope === 'dom';
  };

  /**
   * Require permission for scope
   */
  const require = async (
    scope: PermissionScope,
    context: PermissionContext
  ): Promise<PermissionDecision> => {
    // Default-deny fallback
    const deny: PermissionDecision = 'denied';

    // Fast-allow for low-risk scopes
    if (scope === 'window' || scope === 'components') {
      return 'granted';
    }

    // DOM scope: enforce sanitization and allow benign ops
    if (scope === 'dom') {
      const op = String(context.operation || '').trim();

      // Handle DOM mutation ops explicitly
      if (op === 'dom.set' || op === 'dom.replace' || op === 'dom.append') {
        const params = (context.params ?? {}) as { sanitize?: boolean };
        if (params.sanitize === false) return deny;
        return 'granted';
      }

      // State ops and txn.cancel are benign
      if (
        op === 'state.set' ||
        op === 'state.get' ||
        op === 'state.patch' ||
        op === 'state.watch' ||
        op === 'state.unwatch' ||
        op === 'txn.cancel'
      ) {
        return 'granted';
      }

      // api.call gating is handled inside adapter.api via PermissionManager; do not block here
      if (op === 'api.call') {
        return 'granted';
      }

      // Unknown op under DOM scope -> default deny
      return deny;
    }

    // Unknown scope -> default deny
    return deny;
  };

  return {
    require,
    isGated,
  };
};
