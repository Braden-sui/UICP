import type { AgentsFile, ResolvedProfiles } from './schema';

export type ProviderPreflight = {
  provider: string;
  models: string[];
  fetchedAt: number;
  error?: string;
  skipped?: boolean;
};

export type AgentsPreflight = {
  providers: Record<string, ProviderPreflight>;
  resolvedProfiles: ResolvedProfiles;
};

const DEFAULT_TIMEOUT_MS = 10_000;

type ListModelsConfig = Required<NonNullable<AgentsFile['providers'][string]['list_models']>>;

const isFetchAvailable = (): boolean => typeof fetch === 'function';
const isAbortControllerAvailable = (): boolean => typeof AbortController === 'function';

const uniqueStrings = (values: string[]): string[] => {
  const seen = new Set<string>();
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
    }
  }
  return Array.from(seen);
};

const extractStringsByPath = (source: unknown, path: string): string[] => {
  if (!path || typeof source === 'undefined' || source === null) {
    return [];
  }
  const segments = path.split('.');
  let current: unknown[] = [source];

  for (const segment of segments) {
    const next: unknown[] = [];
    const isArraySegment = segment.endsWith('[]');
    const key = isArraySegment ? segment.slice(0, -2) : segment;

    for (const node of current) {
      if (node === null || typeof node !== 'object') {
        continue;
      }
      if (isArraySegment) {
        const value = key ? (node as Record<string, unknown>)[key] : node;
        if (Array.isArray(value)) {
          next.push(...value);
        }
        continue;
      }
      const value = (node as Record<string, unknown>)[key];
      if (typeof value !== 'undefined') {
        next.push(value);
      }
    }

    current = next;
    if (current.length === 0) {
      break;
    }
  }

  const results: string[] = [];
  for (const node of current) {
    if (typeof node === 'string') {
      results.push(node);
    }
  }
  return uniqueStrings(results);
};

const toFetchHeaders = (headers: Record<string, string>): HeadersInit => {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      normalized[key] = value;
    }
  }
  return normalized;
};

const timeoutFetch = async (input: RequestInfo, init: RequestInit, timeoutMs: number): Promise<Response> => {
  if (!isAbortControllerAvailable()) {
    return fetch(input, init);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

const fetchProviderModels = async (
  providerKey: string,
  config: ListModelsConfig,
  headers: Record<string, string>,
): Promise<ProviderPreflight> => {
  const fetchedAt = Date.now();
  if (!isFetchAvailable()) {
    return {
      provider: providerKey,
      models: [],
      fetchedAt,
      skipped: true,
      error: 'fetch unavailable in current runtime',
    };
  }

  try {
    const response = await timeoutFetch(
      config.url,
      {
        method: config.method ?? 'GET',
        headers: toFetchHeaders(headers),
      },
      DEFAULT_TIMEOUT_MS,
    );

    if (!response.ok) {
      return {
        provider: providerKey,
        models: [],
        fetchedAt,
        error: `HTTP ${response.status} ${response.statusText}`,
      };
    }

    const body = await response.json();
    const models = extractStringsByPath(body, config.id_path);
    return {
      provider: providerKey,
      models,
      fetchedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      provider: providerKey,
      models: [],
      fetchedAt,
      error: message,
    };
  }
};

export const runAgentsPreflight = async (
  agents: AgentsFile,
  resolved: ResolvedProfiles,
): Promise<AgentsPreflight> => {
  const providers: Record<string, ProviderPreflight> = {};

  const entries = Object.entries(agents.providers ?? {});
  for (const [providerKey, providerEntry] of entries) {
    if (providerEntry.list_models) {
      const config: ListModelsConfig = {
        method: providerEntry.list_models.method ?? 'GET',
        url: providerEntry.list_models.url,
        id_path: providerEntry.list_models.id_path,
      };
      providers[providerKey] = await fetchProviderModels(providerKey, config, providerEntry.headers ?? {});
    }
  }

  logResolvedChoices(resolved, providers);

  return {
    providers,
    resolvedProfiles: resolved,
  };
};

const formatCandidate = (label: string, candidate: ResolvedProfiles['planner'][number] | undefined): string => {
  if (!candidate) {
    return `${label}: none`;
  }
  const aliasPart = candidate.alias ? ` (alias ${candidate.alias})` : '';
  return `${label}: ${candidate.provider} → ${candidate.model}${aliasPart}`;
};

const candidateMissing = (
  candidate: ResolvedProfiles['planner'][number] | undefined,
  providerSnapshot: ProviderPreflight | undefined,
): boolean => {
  if (!candidate || !providerSnapshot) {
    return false;
  }
  if (!providerSnapshot.models.length) {
    return false;
  }
  return !providerSnapshot.models.includes(candidate.model);
};

const logResolvedChoices = (
  resolved: ResolvedProfiles,
  providers: Record<string, ProviderPreflight>,
): void => {
  const plannerPrimary = resolved.planner[0];
  const actorPrimary = resolved.actor[0];

  console.info('[agents] planner selection →', formatCandidate('primary', plannerPrimary));
  resolved.planner.slice(1).forEach((candidate, index) => {
    console.info('[agents] planner selection →', formatCandidate(`fallback ${index + 1}`, candidate));
  });

  console.info('[agents] actor selection →', formatCandidate('primary', actorPrimary));
  resolved.actor.slice(1).forEach((candidate, index) => {
    console.info('[agents] actor selection →', formatCandidate(`fallback ${index + 1}`, candidate));
  });

  const plannerProvider = providers[plannerPrimary?.provider ?? ''];
  if (candidateMissing(plannerPrimary, plannerProvider)) {
    console.warn(
      '[agents] planner primary model missing from fetched list; first fallback will be attempted at runtime.',
    );
  }

  const actorProvider = providers[actorPrimary?.provider ?? ''];
  if (candidateMissing(actorPrimary, actorProvider)) {
    console.warn(
      '[agents] actor primary model missing from fetched list; first fallback will be attempted at runtime.',
    );
  }
};
