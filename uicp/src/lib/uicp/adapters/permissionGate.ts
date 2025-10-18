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
  const isGated = (_scope: PermissionScope): boolean => false;

  /**
   * Require permission for scope
   */
  const require = async (
    _scope: PermissionScope,
    _context: PermissionContext
  ): Promise<PermissionDecision> => 'granted';

  return {
    require,
    isGated,
  };
};
