import { BaseDirectory, exists, mkdir, readTextFile, remove, writeTextFile } from '@tauri-apps/plugin-fs';
import type { Envelope } from '../uicp/schemas';

export type Decision = 'allow' | 'deny' | 'prompt';

export type PolicyKey =
  | `api:${Uppercase<string>}:${string}`
  | `compute:${string}`
  | `media:${string}`;

export type Policy = Record<PolicyKey, Decision>;

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
    return JSON.parse(txt) as Policy;
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

export type PromptFn = (info: {
  title: string;
  body: string;
  choices: Array<{ id: Decision; label: string }>;
}) => Promise<Decision>;

export const defaultPrompt: PromptFn = async () => 'deny';

export async function checkPermission(env: Envelope, prompt: PromptFn = defaultPrompt): Promise<Decision> {
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
      const method = String((env.params as any).method ?? 'GET').toUpperCase();
      const urlStr = String((env.params as any).url ?? '');
      const url = new URL(urlStr);
      // Internal schemes and localhost are considered safe dev operations
      if (
        url.protocol.startsWith('uicp:') ||
        url.protocol.startsWith('tauri:') ||
        url.protocol === 'http:' ||
        url.protocol === 'https:' ||
        url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1'
      ) {
        return 'allow';
      }
      const key: PolicyKey = `api:${method}:${url.origin}` as PolicyKey;

      const current = (await readPolicy())[key];
      if (current === 'allow') return 'allow';
      if (current === 'deny') return 'deny';

      const decision = await prompt({
        title: 'Permission needed',
        body: `Actor requests ${method} ${url.origin}${url.pathname}`,
        choices: [
          { id: 'allow', label: 'Allow once' },
          { id: 'prompt', label: `Always allow for ${url.origin}` },
          { id: 'deny', label: 'Deny' },
        ],
      });

      if (decision === 'prompt') {
        const next = await readPolicy();
        next[key] = 'allow';
        await writePolicy(next);
        return 'allow';
      }
      return decision;
    } catch {
      return 'deny';
    }
  }

  // Unknown op → deny by default
  return 'deny';
}
