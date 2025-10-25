import { BaseDirectory, exists, mkdir, readTextFile, remove, writeTextFile } from '@tauri-apps/plugin-fs';
import { emitTelemetryEvent } from '../telemetry';
import type { Envelope } from '../uicp/schemas';

export type Decision = 'allow' | 'deny' | 'prompt';

// Duration for stored decisions: once (allow this request), session (until app restart), forever (persist)
export type PolicyDuration = 'once' | 'session' | 'forever';

export type PolicyKey =
  | `api:${Uppercase<string>}:${string}`
  | `compute:${string}`
  | `media:${string}`;

// Enhanced policy entry with scope, duration, and optional path prefix
export type PolicyEntry = {
  decision: Decision;
  duration?: PolicyDuration;
  // For api policies: optional path prefix to scope the permission (e.g., "/api/v1")
  pathPrefix?: string;
  // When the policy was created (for auditing)
  createdAt?: number;
  // Session-scoped policies are stored in memory only; this field tracks them
  sessionOnly?: boolean;
};

export type Policy = Record<PolicyKey, PolicyEntry>;

// In-memory session-only policies (cleared on restart)
let sessionPolicies: Policy = {};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object';

const POLICY_ROOT = 'uicp';
const POLICY_FILENAME = 'permissions.json';
const POLICY_PATH = `${POLICY_ROOT}/${POLICY_FILENAME}`;
const LEGACY_POLICY_PATH = 'permissions.json';

let policyCache: Policy | null = null;

const ensurePolicyDir = async () => {
  if (await exists(POLICY_ROOT, { baseDir: BaseDirectory.AppData })) {
    return;
  }
  await mkdir(POLICY_ROOT, { baseDir: BaseDirectory.AppData, recursive: true });
};

const readPolicyFile = async (relativePath: string): Promise<Policy | null> => {
  try {
    const txt = await readTextFile(relativePath, { baseDir: BaseDirectory.AppData });
    const parsed = JSON.parse(txt) as Record<string, unknown>;

    // Migrate legacy policies: Decision -> PolicyEntry
    const migrated: Policy = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && (value === 'allow' || value === 'deny' || value === 'prompt')) {
        // Legacy format: just a Decision string
        migrated[key as PolicyKey] = {
          decision: value as Decision,
          duration: 'forever',
          createdAt: Date.now(),
        };
      } else if (value && typeof value === 'object' && 'decision' in value) {
        // New format: PolicyEntry
        migrated[key as PolicyKey] = value as PolicyEntry;
      }
    }
    return migrated;
  } catch {
    return null;
  }
};

const readPolicy = async (): Promise<Policy> => {
  if (policyCache) return policyCache;

  const current = await readPolicyFile(POLICY_PATH);
  if (current) {
    policyCache = current;
    return policyCache;
  }

  const legacy = await readPolicyFile(LEGACY_POLICY_PATH);
  if (legacy) {
    policyCache = legacy;
    try {
      await writePolicy(legacy);
      await remove(LEGACY_POLICY_PATH, { baseDir: BaseDirectory.AppData }).catch(() => undefined);
    } catch {
      // Ignore migration errors; legacy data stays in cache.
    }
    return policyCache;
  }

  policyCache = {} as Policy;
  return policyCache;
};

const writePolicy = async (p: Policy) => {
  policyCache = p;
  await ensurePolicyDir();
  await writeTextFile(POLICY_PATH, JSON.stringify(p, null, 2), { baseDir: BaseDirectory.AppData });
};

// Enhanced prompt function with duration selection
export type PromptFn = (info: {
  title: string;
  body: string;
  choices: Array<{ id: string; label: string; decision: Decision; duration?: PolicyDuration }>;
}) => Promise<{ decision: Decision; duration?: PolicyDuration }>;

// WHY: Default prompt must deny when no UI is available to prevent silent auto-allow.
// INVARIANT: Never auto-allow without explicit user confirmation.
export const defaultPrompt: PromptFn = async () => ({ decision: 'deny' });

export async function checkPermission(env: Envelope, prompt: PromptFn = defaultPrompt): Promise<Decision> {
  const traceId = env.traceId;
  const recordDecision = (decision: Decision, data: Record<string, unknown>) => {
    if (!traceId) return;
    const event = decision === 'allow' ? 'permissions_allow' : 'permissions_deny';
    emitTelemetryEvent(event, {
      traceId,
      span: 'permissions',
      data,
    });
  };
  const recordPrompt = (data: Record<string, unknown>) => {
    if (!traceId) return;
    emitTelemetryEvent('permissions_prompt', {
      traceId,
      span: 'permissions',
      data,
    });
  };

  // Allow-list for low-risk ops
  const lowRiskOps = new Set([
    'window.create',
    'window.update',
    'window.close',
    'dom.set',
    'dom.replace',
    'dom.append',
    'component.render',
    'component.update',
    'component.destroy',
    'state.set',
    'state.get',
    'state.watch',
    'state.unwatch',
    'txn.cancel',
  ]);
  if (lowRiskOps.has(env.op)) return 'allow';

  if (env.op === 'api.call') {
    try {
      if (!isRecord(env.params)) {
        recordDecision('deny', { op: env.op, reason: 'invalid_params' });
        return 'deny';
      }

      const params = env.params;

      const methodRaw = params.method;
      const urlRaw = params.url;
      const method = typeof methodRaw === 'string' ? methodRaw.toUpperCase() : 'GET';
      const urlStr = typeof urlRaw === 'string' ? urlRaw : '';
      const url = new URL(urlStr);

      // WHY: Internal schemes (uicp:, tauri:) are trusted for app-internal communication
      // INVARIANT: Only allow localhost/127.0.0.1 for http/https, not all http/https URLs
      if (url.protocol.startsWith('uicp:') || url.protocol.startsWith('tauri:')) {
        recordDecision('allow', { op: env.op, reason: 'internal_scheme', scheme: url.protocol });
        return 'allow';
      }

      // WHY: Localhost is safe for dev, but remote http/https requires permission
      // INVARIANT: All non-localhost http/https requests must be explicitly allowed
      const isLocalhost =
        url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '[::1]';

      if ((url.protocol === 'http:' || url.protocol === 'https:') && isLocalhost) {
        recordDecision('allow', {
          op: env.op,
          reason: 'localhost',
          origin: url.origin,
          method,
        });
        return 'allow';
      }

      // Check if non-http/https scheme (deny unknown schemes)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        recordDecision('deny', { op: env.op, reason: 'unknown_protocol', scheme: url.protocol });
        return 'deny';
      }

      const key: PolicyKey = `api:${method}:${url.origin}` as PolicyKey;

      // Check session policies first (in-memory, not persisted)
      const sessionEntry = sessionPolicies[key];
      if (sessionEntry) {
        const baseData = { op: env.op, origin: url.origin, method, source: 'session' as const };
        if (sessionEntry.pathPrefix) {
          if (!url.pathname.startsWith(sessionEntry.pathPrefix)) {
            // Path doesn't match, continue to check persistent policies or prompt
          } else if (sessionEntry.decision === 'allow') {
            recordDecision('allow', { ...baseData, pathPrefix: sessionEntry.pathPrefix });
            return 'allow';
          } else if (sessionEntry.decision === 'deny') {
            recordDecision('deny', { ...baseData, pathPrefix: sessionEntry.pathPrefix });
            return 'deny';
          }
        } else {
          if (sessionEntry.decision === 'allow') {
            recordDecision('allow', baseData);
            return 'allow';
          }
          if (sessionEntry.decision === 'deny') {
            recordDecision('deny', baseData);
            return 'deny';
          }
        }
      }

      // Check persistent policies
      const persistentPolicies = await readPolicy();
      const persistentEntry = persistentPolicies[key];
      if (persistentEntry) {
        const baseData = { op: env.op, origin: url.origin, method, source: 'persistent' as const };
        if (persistentEntry.pathPrefix) {
          if (!url.pathname.startsWith(persistentEntry.pathPrefix)) {
            // Path doesn't match, continue to prompt
          } else if (persistentEntry.decision === 'allow') {
            recordDecision('allow', { ...baseData, pathPrefix: persistentEntry.pathPrefix });
            return 'allow';
          } else if (persistentEntry.decision === 'deny') {
            recordDecision('deny', { ...baseData, pathPrefix: persistentEntry.pathPrefix });
            return 'deny';
          }
        } else {
          if (persistentEntry.decision === 'allow') {
            recordDecision('allow', baseData);
            return 'allow';
          }
          if (persistentEntry.decision === 'deny') {
            recordDecision('deny', baseData);
            return 'deny';
          }
        }
      }

      // WHY: No matching policy found, so we must prompt the user
      // INVARIANT: NEVER auto-allow; always require explicit user decision
      recordPrompt({
        op: env.op,
        method,
        origin: url.origin,
        pathname: url.pathname,
      });
      const result = await prompt({
        title: 'Permission needed',
        body: `Actor requests ${method} ${url.origin}${url.pathname}`,
        choices: [
          { id: 'allow-once', label: 'Allow once', decision: 'allow', duration: 'once' },
          { id: 'allow-session', label: `Allow for this session (${url.origin})`, decision: 'allow', duration: 'session' },
          { id: 'allow-forever', label: `Always allow (${url.origin})`, decision: 'allow', duration: 'forever' },
          { id: 'deny', label: 'Deny', decision: 'deny', duration: 'once' },
        ],
      });
      recordDecision(result.decision, {
        op: env.op,
        method,
        origin: url.origin,
        pathname: url.pathname,
        duration: result.duration ?? 'once',
        source: 'prompt',
      });

      // WHY: Store the decision based on duration, but only if not 'once'
      // INVARIANT: 'once' means allow/deny this single request without persisting
      if (result.decision === 'allow' && result.duration && result.duration !== 'once') {
        const entry: PolicyEntry = {
          decision: 'allow',
          duration: result.duration,
          createdAt: Date.now(),
        };

        if (result.duration === 'session') {
          entry.sessionOnly = true;
          sessionPolicies[key] = entry;
        } else if (result.duration === 'forever') {
          const nextPolicy = await readPolicy();
          nextPolicy[key] = entry;
          await writePolicy(nextPolicy);
        }
      } else if (result.decision === 'deny' && result.duration && result.duration !== 'once') {
        const entry: PolicyEntry = {
          decision: 'deny',
          duration: result.duration,
          createdAt: Date.now(),
        };

        if (result.duration === 'session') {
          entry.sessionOnly = true;
          sessionPolicies[key] = entry;
        } else if (result.duration === 'forever') {
          const nextPolicy = await readPolicy();
          nextPolicy[key] = entry;
          await writePolicy(nextPolicy);
        }
      }

      return result.decision;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      recordDecision('deny', { op: env.op, reason: 'exception', error: errorMessage });
      console.error('[PermissionManager] Permission check failed', {
        traceId,
        error: errorMessage,
      });
      return 'deny';
    }
  }

  // Unknown op → deny by default
  return 'deny';
}

export async function setApiPolicyDecision(method: string, origin: string, decision: Decision, duration: 'session' | 'forever'): Promise<void> {
  try {
    const key = `api:${String(method || 'GET').toUpperCase()}:${origin}` as PolicyKey;
    const entry: PolicyEntry = {
      decision,
      duration,
      createdAt: Date.now(),
    };
    if (duration === 'session') {
      entry.sessionOnly = true;
      sessionPolicies[key] = entry;
      return;
    }
    if (duration === 'forever') {
      const nextPolicy = await readPolicy();
      nextPolicy[key] = entry;
      await writePolicy(nextPolicy);
      return;
    }
  } catch { /* non-fatal */ }
}
