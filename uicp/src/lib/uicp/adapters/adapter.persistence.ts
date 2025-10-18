/**
 * Workspace Persistence & Replay
 * 
 * WHY: Manages workspace state persistence to database and replay on restart.
 * INVARIANT: Replay preserves original command ordering to maintain valid state transitions.
 * SAFETY: Ephemeral operations (state.get, txn.cancel) excluded from persistence.
 */

import { hasTauriBridge, tauriInvoke } from "../../bridge/tauri";
import { createId } from "../../utils";
import type { Envelope } from "./schemas";

// Persist command to database for replay on restart
// Skip ephemeral operations that shouldn't be replayed
export const persistCommand = async (command: Envelope): Promise<void> => {
  // Skip ephemeral operations
  const ephemeralOps = ['txn.cancel', 'state.get', 'state.watch', 'state.unwatch'];
  if (ephemeralOps.includes(command.op)) {
    return;
  }
  if (command.op === 'api.call') {
    const params = command.params;
    if (typeof params?.url === 'string' && params.url.startsWith('uicp://intent')) {
      return;
    }
  }

  if (!hasTauriBridge()) {
    if (import.meta.env.DEV) {
      console.info('[adapter] skipping persist_command; tauri bridge unavailable');
    }
    return;
  }
  try {
    await tauriInvoke('persist_command', {
      cmd: {
        id: command.idempotencyKey ?? command.id ?? createId('cmd'),
        tool: command.op,
        args: command.params,
      },
    });
  } catch (error) {
    // Log but don't throw - persistence failures shouldn't break command execution
    console.error('Failed to persist command', command.op, error);
  }
};

const REPLAY_PROGRESS_EVENT = 'workspace-replay-progress';
const REPLAY_COMPLETE_EVENT = 'workspace-replay-complete';
const REPLAY_BATCH_SIZE = 20;

export type ReplayProgressDetail = {
  total: number;
  processed: number;
  applied: number;
  errors: number;
  done?: boolean;
};

const emitReplayProgress = (detail: ReplayProgressDetail) => {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new CustomEvent(REPLAY_PROGRESS_EVENT, { detail }));
  if (detail.done) {
    window.dispatchEvent(new CustomEvent(REPLAY_COMPLETE_EVENT, { detail }));
  }
};

const yieldReplay = () =>
  new Promise<void>((resolve) => {
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => resolve(), { timeout: 32 });
      return;
    }
    setTimeout(resolve, 16);
  });

// Deterministic stringify (sorted object keys; preserves array order) for stable op-hash.
const stableStringify = (input: unknown): string => {
  const seen = new WeakSet<object>();
  const walk = (value: unknown): unknown => {
    if (value === null) return null;
    const t = typeof value;
    if (t === 'undefined' || t === 'function' || t === 'symbol') return null;
    if (t !== 'object') return value;
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return null;
    seen.add(obj);
    if (Array.isArray(obj)) {
      return obj.map((v) => walk(v));
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = walk(obj[key]);
    }
    return out;
  };
  // Strict: fail fast on unstringifiable input instead of silently degrading
  return JSON.stringify(walk(input));
};

/**
 * Replay persisted commands from database to restore workspace state.
 * 
 * WHY: Enables workspace persistence across restarts.
 * INVARIANT: Preserves original creation order to avoid inverting window lifecycle.
 * 
 * @param applyCommand - Command executor function
 * @param stateStore - State store to clear before replay
 * @returns Applied count and error list
 */
export const replayWorkspace = async (
  applyCommand: (command: Envelope, ctx: { runId?: string }) => Promise<{ success: boolean; error?: string }>,
  stateStore: Map<string, Map<string, unknown>>,
): Promise<{ applied: number; errors: string[] }> => {
  // WHY: Allow replay under Vitest where __TAURI__ is absent but mocks are installed.
  // INVARIANT: Proceed when either Tauri is present or test mocks are registered; otherwise, no-op.
  const tauriWindow = typeof window !== 'undefined' ? window : undefined;
  const hasMocks = typeof (globalThis as { __TAURI_MOCKS__?: unknown }).__TAURI_MOCKS__ !== 'undefined';
  const hasTauri = typeof tauriWindow?.__TAURI__ !== 'undefined' || hasMocks;

  if (!hasTauri) {
    return { applied: 0, errors: [] };
  }

  let commands: Array<{ id: string; tool: string; args: unknown }> = [];
  let processed = 0;
  let applied = 0;
  let errors: string[] = [];
  try {
    commands = await tauriInvoke<Array<{ id: string; tool: string; args: unknown }>>('get_workspace_commands');
    
    // SAFETY: tauriInvoke may return undefined if the command fails
    if (!commands || !Array.isArray(commands)) {
      commands = [];
    }
    
    errors = [];
    applied = 0;
    processed = 0;
    const dedup = new Set<string>();
    // Discard transient in-memory state before replay so replayed ops fully define the state.
    for (const scope of stateStore.values()) scope.clear();

    const total = commands.length;
    emitReplayProgress({ total, processed, applied, errors: 0 });

    // Preserve original creation order to avoid inverting
    // window lifecycle (e.g., a prior close followed by a create
    // for the same id). Hoisting all creates caused a regression
    // where a later replayed close would immediately remove a
    // newly created window. We intentionally replay in-order and
    // fail loud on any invalid sequence.
    for (const cmd of commands) {
      try {
        // Skip exact duplicate tool+args pairs within this replay session.
        // This mitigates double-persistence or accidental duplicate rows without risking reordering.
        const key = `${cmd.tool}:${stableStringify(cmd.args)}`;
        if (dedup.has(key)) {
          processed += 1;
          if (processed % REPLAY_BATCH_SIZE === 0 || processed === total) {
            emitReplayProgress({ total, processed, applied, errors: errors.length });
            await yieldReplay();
          }
          continue;
        }
        dedup.add(key);
        const envelope = {
          op: cmd.tool,
          params: cmd.args,
          idempotencyKey: cmd.id,
        } as Envelope;
        const result = await applyCommand(envelope, { runId: cmd.id });
        if (result.success) {
          applied += 1;
        } else {
          errors.push(`${cmd.tool}: ${result.error}`);
        }
      } catch (error) {
        errors.push(`${cmd.tool}: ${error instanceof Error ? error.message : String(error)}`);
      }
      processed += 1;
      if (processed % REPLAY_BATCH_SIZE === 0 || processed === total) {
        emitReplayProgress({ total, processed, applied, errors: errors.length });
        // Yield to the browser so first paint and interactivity aren't blocked.
        // WHY: Heavy workspaces can contain hundreds of commands; chunking keeps the UI responsive.
        // INVARIANT: Replay preserves original ordering even when yielding between batches.
        await yieldReplay();
      }
    }

    emitReplayProgress({ total, processed, applied, errors: errors.length, done: true });
    return { applied, errors };
  } catch (error) {
    console.error('Failed to replay workspace', error);
    const message = error instanceof Error ? error.message : String(error);
    const total = commands?.length ?? 0;
    emitReplayProgress({
      total,
      processed,
      applied,
      errors: errors.length + 1,
      done: true,
    });
    return { applied, errors: [...errors, message] };
  }
};

export const recordStateCheckpoint = async (): Promise<void> => {
  try {
    const stable = (obj: unknown): string => {
      if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
      if (Array.isArray(obj)) return `[${obj.map(stable).join(",")}]`;
      const o = obj as Record<string, unknown>;
      const keys = Object.keys(o).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
    };
    const stateStore = (typeof window !== 'undefined' && (window as { __UICP_STATE_STORE__?: Map<string, Map<string, unknown>> }).__UICP_STATE_STORE__) || new Map();
    const snapshot = {
      window: Object.fromEntries(stateStore.get("window") || new Map()),
      workspace: Object.fromEntries(stateStore.get("workspace") || new Map()),
      global: Object.fromEntries(stateStore.get("global") || new Map()),
    };
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(snapshot)));
    const hex = Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (hasTauriBridge()) {
      await tauriInvoke("save_checkpoint", { hash: hex });
    }
  } catch (err) {
    console.error("recordStateCheckpoint failed", err);
  }
};
