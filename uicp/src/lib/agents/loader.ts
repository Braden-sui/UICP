import { parse as parseYaml } from 'yaml';
import {
  AgentsFileSchema,
  type AgentsFile,
  type ModelAlias,
  type ModelLimits,
  type ResolvedCandidate,
  type ResolvedProfiles,
} from './schema';
import { readStringEnv } from '../env/values';
import { runAgentsPreflight, type AgentsPreflight } from './preflight';
import { hasTauriBridge, inv } from '../bridge/tauri';
import type { UICPError } from '../bridge/result';

// In-memory snapshot with hot-reload support (simple polling watcher)
let snapshot: { data: AgentsFile; loadedAt: number; source: 'appdata' | 'builtin' | 'test'; rawHash: string } | null = null;
let watchTimer: number | null = null;
let preflightSnapshot: AgentsPreflight | null = null;
const preflightListeners = new Set<(snapshot: AgentsPreflight | null) => void>();

const CONFIG_PATH = 'uicp/agents.yaml'; // AppData location

type AgentsConfigCommandPayload = {
  exists: boolean;
  contents?: string | null;
  path: string;
};

type FsModule = typeof import('@tauri-apps/plugin-fs');
let fsMod: FsModule | null = null;
const getFs = async (): Promise<FsModule> => {
  if (fsMod) return fsMod;
  try {
    fsMod = await import('@tauri-apps/plugin-fs');
  } catch (err) {
    throw new Error('[agents] filesystem module unavailable');
  }
  return fsMod;
};

const hashString = (s: string): string => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
};

const getEnv = (key: string): string | undefined => {
  // Prefer vite/import.meta.env for browser/tauri front-end
  const viaVite = readStringEnv(key);
  if (viaVite !== undefined) return viaVite;
  // Fallback to process.env for tests/node
  // eslint-disable-next-line no-restricted-globals
  const anyGlobal = (globalThis as any);
  const proc = anyGlobal?.process as { env?: Record<string, string | undefined> } | undefined;
  return proc?.env?.[key];
};

const interpolate = (value: unknown): unknown => {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
      const v = getEnv(name);
      return v !== undefined ? v : `\${${name}}`;
    });
  }
  if (Array.isArray(value)) {
    return value.map(interpolate);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = interpolate(v);
    }
    return out;
  }
  return value;
};

export const loadFromText = (yamlText: string): AgentsFile => {
  const raw = parseYaml(yamlText) as unknown;
  const interpolated = interpolate(raw);
  const parsed = AgentsFileSchema.parse(interpolated);
  return parsed;
};

const formatBridgeError = (err: UICPError): string => {
  const code = err?.code ?? 'E-UICP-UNKNOWN';
  const message = err?.message ?? 'unknown error';
  return `${code} ${message}`;
};

export const readAgentsConfigRaw = async (): Promise<{ text: string; source: 'appdata' | 'builtin' } | null> => {
  if (hasTauriBridge()) {
    const res = await inv<AgentsConfigCommandPayload>('load_agents_config_file');
    if (!res.ok) {
      throw new Error(`[agents] load command failed: ${formatBridgeError(res.error)}`);
    }
    if (!res.value.exists || res.value.contents == null) {
      return null;
    }
    return { text: res.value.contents, source: 'appdata' };
  }
  try {
    const fs = await getFs();
    if (await fs.exists(CONFIG_PATH, { baseDir: fs.BaseDirectory.AppData })) {
      const txt = await fs.readTextFile(CONFIG_PATH, { baseDir: fs.BaseDirectory.AppData });
      return { text: txt, source: 'appdata' };
    }
  } catch {
    // ignore
  }
  // No builtin source shipped yet (template lives in repo root). Return null.
  return null;
};

const writeConfigFile = async (yamlText: string): Promise<void> => {
  if (hasTauriBridge()) {
    const res = await inv<void>('save_agents_config_file', { contents: yamlText });
    if (!res.ok) {
      throw new Error(`[agents] save command failed: ${formatBridgeError(res.error)}`);
    }
    return;
  }
  const fs = await getFs();
  await fs.writeTextFile(CONFIG_PATH, yamlText, { baseDir: fs.BaseDirectory.AppData });
};

export const loadAgentsConfig = async (): Promise<AgentsFile> => {
  const file = await readAgentsConfigRaw();
  if (!file) {
    // Minimal safe default with local placeholders; no secrets or external calls.
    const minimal: AgentsFile = {
      version: '1',
      defaults: { temperature: 0.2, top_p: 1.0, max_tokens: 4096, json_mode: true, tools_enabled: true },
      providers: {
        openai: {
          base_url: 'https://api.openai.com/v1',
          headers: {},
          model_aliases: {
            gpt_default: { id: 'gpt-5', limits: { max_context_tokens: 400_000 } },
            gpt_mini: { id: 'gpt-5-mini', limits: { max_context_tokens: 200_000 } },
          },
          list_models: undefined,
        },
        anthropic: {
          base_url: 'https://api.anthropic.com',
          headers: {},
          model_aliases: {
            claude_default: { id: 'claude-sonnet-4-5', limits: { max_context_tokens: 200_000 } },
            claude_mini: { id: 'claude-haiku-4-5', limits: { max_context_tokens: 200_000 } },
          },
          list_models: undefined,
        },
        ollama: {
          base_url: 'https://ollama.com/v1',
          headers: { Authorization: 'Bearer ${OLLAMA_API_KEY}' },
          model_aliases: {
            glm_default: { id: 'glm-4.6', limits: { max_context_tokens: 200_000 } },
            deepseek_default: { id: 'deepseek-v3.1', limits: { max_context_tokens: 128_000 } },
            gptoss_default: { id: 'gpt-oss:120b', limits: { max_context_tokens: 131_072 } },
            kimi_default: { id: 'kimi-k2', limits: { max_context_tokens: 128_000 } },
            qwen_default: { id: 'qwen3-coder:480b', limits: { max_context_tokens: 256_000 } },
          },
          list_models: undefined,
        },
        openrouter: {
          base_url: 'https://openrouter.ai/api/v1',
          headers: {},
          model_aliases: {
            gpt_default: { id: 'openai/gpt-5', limits: { max_context_tokens: 400_000 } },
            gpt_mini: { id: 'openai/gpt-5-mini', limits: { max_context_tokens: 200_000 } },
            claude_default: { id: 'anthropic/claude-4.5-sonnet', limits: { max_context_tokens: 200_000 } },
            claude_mini: { id: 'anthropic/claude-haiku-4.5', limits: { max_context_tokens: 200_000 } },
          },
          list_models: undefined,
        },
      },
      profiles: {
        planner: {
          provider: 'openai',
          model: 'gpt_default',
          temperature: 0.2,
          max_tokens: 4096,
          fallbacks: ['ollama:glm_default', 'ollama:deepseek_default', 'ollama:gptoss_default', 'ollama:kimi_default', 'ollama:qwen_default'],
        },
        actor: {
          provider: 'anthropic',
          model: 'claude_default',
          temperature: 0.2,
          max_tokens: 4096,
          fallbacks: ['ollama:glm_default', 'ollama:deepseek_default', 'ollama:gptoss_default', 'ollama:kimi_default', 'ollama:qwen_default'],
        },
      },
      codegen: { engine: 'cli', allow_paid_fallback: false },
    };
    snapshot = { data: minimal, loadedAt: Date.now(), source: 'builtin', rawHash: '0' };
    return minimal;
  }
  const data = loadFromText(file.text);
  snapshot = { data, loadedAt: Date.now(), source: file.source, rawHash: hashString(file.text) };
  return data;
};

export const saveAgentsConfig = async (yamlText: string): Promise<AgentsFile> => {
  await writeConfigFile(yamlText);
  const data = loadFromText(yamlText);
  snapshot = { data, loadedAt: Date.now(), source: 'appdata', rawHash: hashString(yamlText) };
  try {
    const resolved = resolveProfiles(data);
    await refreshAgentsPreflight(data, resolved);
  } catch (err) {
    console.warn('[agents] preflight after save failed', err);
  }
  return data;
};

export const getSnapshot = (): AgentsFile | null => snapshot?.data ?? null;
export const getPreflightSnapshot = (): AgentsPreflight | null => preflightSnapshot;

export const refreshAgentsPreflight = async (
  agents: AgentsFile,
  resolved: ResolvedProfiles,
): Promise<void> => {
  try {
    preflightSnapshot = await runAgentsPreflight(agents, resolved);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[agents] preflight failed', message);
  }
  notifyPreflightListeners(preflightSnapshot);
};

type NormalizedAlias = { id: string; alias?: string; limits?: ModelLimits };

const normalizeAlias = (entry: ModelAlias | undefined, fallbackId: string): NormalizedAlias => {
  if (!entry) {
    return { id: fallbackId };
  }
  if (typeof entry === 'string') {
    return { id: entry, alias: fallbackId };
  }
  return { id: entry.id, alias: fallbackId, limits: entry.limits };
};

export const resolveModel = (agents: AgentsFile, providerKey: string, modelOrAlias: string): string => {
  const provider = agents.providers[providerKey];
  if (!provider) return modelOrAlias;
  const normalized = normalizeAlias(provider.model_aliases?.[modelOrAlias], modelOrAlias);
  return normalized.id;
};

const resolveCandidate = (
  agents: AgentsFile,
  providerKey: string,
  modelOrAlias: string,
): ResolvedCandidate => {
  const provider = agents.providers[providerKey];
  if (!provider) {
    return { provider: providerKey, model: modelOrAlias };
  }
  const normalized = normalizeAlias(provider.model_aliases?.[modelOrAlias], modelOrAlias);
  return {
    provider: providerKey,
    model: normalized.id,
    alias: normalized.alias,
    limits: normalized.limits,
  };
};

const parseFallbackEntry = (entry: string): { provider?: string; model: string } => {
  const idx = entry.indexOf(':');
  if (idx === -1) return { model: entry };
  return { provider: entry.slice(0, idx), model: entry.slice(idx + 1) };
};

export const resolveProfiles = (agents: AgentsFile): ResolvedProfiles => {
  const planP = agents.profiles.planner;
  const actP = agents.profiles.actor;

  const planner: ResolvedCandidate[] = [resolveCandidate(agents, planP.provider, planP.model)];
  for (const fb of planP.fallbacks || []) {
    const { provider, model } = parseFallbackEntry(fb);
    const p = provider ?? planP.provider;
    planner.push(resolveCandidate(agents, p, model));
  }

  const actor: ResolvedCandidate[] = [resolveCandidate(agents, actP.provider, actP.model)];
  for (const fb of actP.fallbacks || []) {
    const { provider, model } = parseFallbackEntry(fb);
    const p = provider ?? actP.provider;
    actor.push(resolveCandidate(agents, p, model));
  }

  return { planner, actor };
};

const notifyPreflightListeners = (value: AgentsPreflight | null): void => {
  for (const listener of [...preflightListeners]) {
    try {
      listener(value);
    } catch (err) {
      console.warn('[agents] preflight listener error', err);
    }
  }
};

export const subscribeAgentsPreflight = (
  listener: (snapshot: AgentsPreflight | null) => void,
): (() => void) => {
  preflightListeners.add(listener);
  try {
    listener(preflightSnapshot);
  } catch (err) {
    console.warn('[agents] preflight listener invoke failed', err);
  }
  return () => {
    preflightListeners.delete(listener);
  };
};

export const initializeAgentsPreflight = async (): Promise<void> => {
  try {
    const agents = await loadAgentsConfig();
    const resolved = resolveProfiles(agents);
    await refreshAgentsPreflight(agents, resolved);
  } catch (err) {
    console.warn('[agents] initialize preflight failed', err);
  }
};

export const startWatcher = async (
  onReload?: (agents: AgentsFile) => void | Promise<void>,
): Promise<void> => {
  if (watchTimer !== null) return; // already watching
  let lastHash = snapshot?.rawHash ?? '';
  const intervalMs = 2500;
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  watchTimer = setInterval(async () => {
    try {
      const file = await readAgentsConfigRaw();
      if (!file) return;
      const h = hashString(file.text);
      if (h !== lastHash) {
        const data = loadFromText(file.text);
        snapshot = { data, loadedAt: Date.now(), source: file.source, rawHash: h };
        lastHash = h;
        try {
          await refreshAgentsPreflight(data, resolveProfiles(data));
        } catch (err) {
          console.warn('[agents] preflight refresh during watch failed', err);
        }
        if (onReload) {
          await onReload(data);
        }
        console.info('[agents] config reloaded');
      }
    } catch (err) {
      console.warn('[agents] watcher error', err);
    }
  }, intervalMs) as unknown as number;
};

export const stopWatcher = (): void => {
  if (watchTimer !== null) {
    clearInterval(watchTimer as unknown as number);
    watchTimer = null;
  }
};

export const __resetPreflightForTests = (): void => {
  preflightSnapshot = null;
  preflightListeners.clear();
};

// Test helper to inject config without filesystem
export const __setTestSnapshot = (data: AgentsFile): void => {
  snapshot = { data, loadedAt: Date.now(), source: 'test', rawHash: 'test' };
};
