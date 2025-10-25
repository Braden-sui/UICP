import type { PromptFn } from './PermissionManager';

let handler: PromptFn | null = null;

export const setPermissionPromptHandler = (fn: PromptFn | null) => {
  handler = fn;
};

export const getPermissionPromptHandler = (): PromptFn | null => handler;
