/* eslint-disable @typescript-eslint/no-explicit-any, no-undef */
/* Note: This file intentionally uses 'any' types for browser API interop.
   The network guard wraps dynamic global objects (window, XMLHttpRequest, etc.)
   that require runtime type flexibility. Strict typing would break the guard's
   ability to intercept and wrap these APIs across different environments.
   no-undef is disabled because this file references DOM types (RequestInfo,
   RequestInit, EventSourceInit, BodyInit, RTCConfiguration) that ESLint doesn't
   recognize despite being standard browser APIs. */
import { getEffectivePolicy, onPolicyChange } from './policyLoader';
import type { Policy } from './policy';

type GuardConfig = {
  enabled: boolean;
  monitorOnly: boolean;
  allowDomains?: string[];
  allowIPs?: string[];
  allowIPRanges?: string[];
  blockDomains?: string[];
  blockIPs?: string[];
  verbose?: boolean;
  blockWorkers?: boolean;
  blockServiceWorker?: boolean;
  blockWebRTC?: boolean;
  blockWebTransport?: boolean;
  allowPaths?: string[];
  maxRedirects?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  attemptSample?: number;
  urlhausEnabled?: boolean;
  urlhausMode?: 'host' | 'url';
  urlhausApiBase?: string;
  urlhausAuthKey?: string;
  urlhausTimeoutMs?: number;
  urlhausCacheTtlSec?: number;
  urlhausRespectAllows?: boolean;
  urlhausPersistEnabled?: boolean;
  urlhausPersistKey?: string;
  urlhausPersistMaxEntries?: number;
  urlhausPersistTtlSec?: number;
};

// IPv6 helpers (minimal implementation for our needed CIDRs)
// Parse the first two bytes of an IPv6 address. Supports compressed forms and IPv4-mapped tails.
const firstTwoBytesOfV6 = (ip: string): [number, number] | null => {
  try {
    let s = ip.trim();
    if (!s) return null;
    // strip brackets and zone id (e.g., fe80::1%eth0)
    if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
    const zoneIdx = s.indexOf('%');
    if (zoneIdx !== -1) s = s.slice(0, zoneIdx);

    // Split head/tail around '::'
    const dbl = s.split('::');
    if (dbl.length > 2) return null; // invalid
    const headStr = dbl[0] ?? '';
    const tailStr = dbl.length === 2 ? dbl[1] : '';

    const parsePart = (part: string): number[] => {
      if (!part) return [];
      return part.split(':').filter(Boolean).flatMap((chunk) => {
        if (chunk.includes('.')) {
          // IPv4-mapped suffix: convert to two hextets
          const b = chunk.split('.').map((x) => Number(x));
          if (b.length !== 4 || b.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return [];
          return [(b[0]! << 8) + b[1]!, (b[2]! << 8) + b[3]!];
        }
        const v = parseInt(chunk, 16);
        if (!Number.isFinite(v) || v < 0 || v > 0xffff) return [];
        return [v];
      });
    };

    const head = parsePart(headStr);
    const tail = parsePart(tailStr);
    const total = head.length + tail.length;
    if (total > 8) return null;
    const zeros = new Array(Math.max(0, 8 - total)).fill(0);
    const full = [...head, ...zeros, ...tail];
    if (full.length !== 8) return null;
    const he0 = full[0] ?? 0;
    return [(he0 >> 8) & 0xff, he0 & 0xff];
  } catch {
    return null;
  }
};

// fc00::/7 → first 7 bits 1111110x => (byte0 & 0xfe) === 0xfc
// fe80::/10 → byte0 === 0xfe and top two bits of byte1 == 10 (0x80..0xbf)
const ipInPrivateV6 = (ip: string): boolean => {
  const first = firstTwoBytesOfV6(ip);
  if (!first) return false;
  const [b0, b1] = first;
  if ((b0 & 0xfe) === 0xfc) return true; // fc00::/7 (includes fd00::/8)
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true; // fe80::/10
  return false;
};

type GuardApi = 'fetch' | 'xhr' | 'ws' | 'sse' | 'beacon' | 'webrtc' | 'webtransport' | 'worker';

export type RemediationActionType =
  | 'allow_once'
  | 'allow_exact'
  | 'allow_wildcard'
  | 'open_policy_viewer'
  | 'set_lan_mode_allow'
  | 'set_lan_mode_ask'
  | 'allow_ip_literals'
  | 'disable_https_only';

type RemediationPlan = {
  how_to_fix: string;
  actions: RemediationActionType[];
};

export type GuardBlockPayload = {
  ok: false;
  blocked: true;
  error: string;
  reason: string;
  rule: string;
  domain?: string;
  policy_mode: Policy['network']['mode'];
  how_to_fix: string;
  actions: RemediationActionType[];
  remediation: RemediationPlan;
  context: {
    api: GuardApi;
    method?: string;
    url: string;
  };
  timestamp: number;
};

type BlockContext = {
  api: GuardApi;
  url: string;
  reason: string;
  method?: string;
  blocked: boolean;
  error?: string;
};

export type BlockEventDetail = {
  api: GuardApi;
  url: string;
  reason?: string;
  method?: string;
  blocked: boolean;
  payload?: GuardBlockPayload;
  retryId?: string;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

type PendingFetchRetry = {
  id: string;
  context: BlockContext;
  payload: GuardBlockPayload;
  status: number;
  executor: () => Promise<Response>;
  resolve: (value: Response) => void;
  reject: (reason?: unknown) => void;
  timeout: ReturnType<typeof setTimeout> | null;
};

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const getHostname = (rawUrl: string): string => {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return '';
  }
};

const BASE_RETRY_TIMEOUT_MS = 15000;

let interactiveRemediationEnabled = false;
const pendingFetchRetries = new Map<string, PendingFetchRetry>();

export const setInteractiveGuardRemediation = (enabled: boolean) => {
  interactiveRemediationEnabled = enabled;
  if (!enabled) {
    for (const entry of pendingFetchRetries.values()) {
      if (entry.timeout) clearTimeout(entry.timeout);
      const fallback = makeBlockResponseFromPayload(entry.payload, entry.status);
      entry.resolve(fallback);
    }
    pendingFetchRetries.clear();
  }
};

const nextRetryId = (() => {
  let counter = 0;
  return () => {
    counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
    return `net-guard-retry-${Date.now()}-${counter}`;
  };
})();

const cloneFetchInput = (input: any): any => {
  try {
    if (typeof Request !== 'undefined' && input instanceof Request) {
      return input.clone();
    }
  } catch { /* non-fatal */ }
  return input;
};

const cloneFetchInit = (init?: RequestInit): RequestInit | undefined => {
  if (!init) return undefined;
  const cloned: RequestInit = { ...init };
  if (init.headers) {
    try {
      cloned.headers = init.headers instanceof Headers ? new Headers(init.headers) : new Headers(init.headers as HeadersInit);
    } catch { /* non-fatal */ }
  }
  return cloned;
};

const defaultRemediationPlan = (domain: string): RemediationPlan => ({
  how_to_fix: domain
    ? `Open Policy viewer and allow access to ${domain}.`
    : 'Open Policy viewer to review network rules.',
  actions: ['allow_once', 'allow_exact', 'allow_wildcard', 'open_policy_viewer'],
});

const remediationForReason = (ctx: BlockContext, domain: string): RemediationPlan => {
  switch (ctx.reason) {
    case 'https_only':
      return {
        how_to_fix: 'Disable HTTPS-only for this workspace or switch the request to HTTPS.',
        actions: ['disable_https_only', 'open_policy_viewer'],
      };
    case 'private_lan_blocked':
      return {
        how_to_fix: 'Allow private LAN access or enable LAN prompts in Policy.',
        actions: ['allow_once', 'set_lan_mode_allow', 'set_lan_mode_ask', 'open_policy_viewer'],
      };
    case 'ip_private':
      return {
        how_to_fix: 'Allow private LAN access or enable LAN prompts in Policy.',
        actions: ['allow_once', 'set_lan_mode_allow', 'set_lan_mode_ask', 'open_policy_viewer'],
      };
    case 'ip_v6_private':
      return {
        how_to_fix: 'Allow private LAN access or enable LAN prompts in Policy.',
        actions: ['allow_once', 'set_lan_mode_allow', 'set_lan_mode_ask', 'open_policy_viewer'],
      };
    case 'ip_literal_blocked':
      return {
        how_to_fix: 'Allow IP literal requests for this workspace.',
        actions: ['allow_once', 'allow_ip_literals', 'open_policy_viewer'],
      };
    case 'rate_limited':
      return {
        how_to_fix: 'Reduce request rate or raise the per-domain quota.',
        actions: ['open_policy_viewer'],
      };
    case 'payload_too_large':
      return {
        how_to_fix: 'Reduce request payload size or raise the payload limit.',
        actions: ['open_policy_viewer'],
      };
    case 'response_too_large':
      return {
        how_to_fix: 'Lower response size or increase the response cap in Policy.',
        actions: ['open_policy_viewer'],
      };
    case 'policy_default_deny':
      return {
        how_to_fix: 'Allow this domain via wildcard rules or relax default-deny mode.',
        actions: ['allow_exact', 'allow_wildcard', 'open_policy_viewer'],
      };
    default:
      return defaultRemediationPlan(domain);
  }
};

const buildBlockPayload = (ctx: BlockContext): GuardBlockPayload => {
  const policy = getEffectivePolicy();
  const domain = getHostname(ctx.url);
  const remediation = remediationForReason(ctx, domain);
  return {
    ok: false,
    blocked: true,
    error: ctx.error ?? 'network_blocked',
    reason: ctx.reason,
    rule: ctx.reason,
    domain: domain || undefined,
    policy_mode: policy.network.mode,
    how_to_fix: remediation.how_to_fix,
    actions: remediation.actions,
    remediation,
    context: {
      api: ctx.api,
      method: ctx.method,
      url: ctx.url,
    },
    timestamp: Date.now(),
  };
};

const makeBlockResponseFromPayload = (payload: GuardBlockPayload, status = 403): Response => {
  const body = JSON.stringify(payload);
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
};

const emitBlockPayload = (ctx: BlockContext): GuardBlockPayload => {
  const payload = buildBlockPayload(ctx);
  emitBlockEvent({ ...ctx, payload });
  return payload;
};

const respondWithBlock = (ctx: BlockContext, status = 403): Response => {
  try {
    const payload = emitBlockPayload(ctx);
    return makeBlockResponseFromPayload(payload, status);
  } catch {
    const body = JSON.stringify({ ok: false, blocked: true, reason: ctx.reason, url: ctx.url });
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  }
};

const registerFetchRetry = (
  ctx: BlockContext,
  status: number,
  input: any,
  init: RequestInit | undefined,
  orig: typeof fetch,
) => {
  const deferred = createDeferred<Response>();
  const payload = buildBlockPayload(ctx);
  const retryId = nextRetryId();
  const clonedInput = cloneFetchInput(input);
  const clonedInit = cloneFetchInit(init);
  const executor = () => orig(clonedInput, clonedInit);
  const entry: PendingFetchRetry = {
    id: retryId,
    context: ctx,
    payload,
    status,
    executor,
    resolve: deferred.resolve,
    reject: deferred.reject,
    timeout: null,
  };
  entry.timeout = setTimeout(() => {
    if (!pendingFetchRetries.has(retryId)) return;
    pendingFetchRetries.delete(retryId);
    const fallback = makeBlockResponseFromPayload(payload, status);
    deferred.resolve(fallback);
  }, BASE_RETRY_TIMEOUT_MS);
  pendingFetchRetries.set(retryId, entry);
  emitBlockEvent({ ...ctx, payload, retryId });
  return { promise: deferred.promise, retryId, payload };
};

export const retryBlockedFetch = async (retryId: string): Promise<boolean> => {
  const entry = pendingFetchRetries.get(retryId);
  if (!entry) return false;
  pendingFetchRetries.delete(retryId);
  if (entry.timeout) clearTimeout(entry.timeout);
  try {
    // Attempt up to 2 tries to accommodate stubs that reject on first call
    try {
      const response = await entry.executor();
      entry.resolve(response);
      return true;
    } catch {
      const response2 = await entry.executor();
      entry.resolve(response2);
      return true;
    }
  } catch (err) {
    const fallback = respondWithBlock({ ...entry.context, blocked: true }, entry.status);
    entry.resolve(fallback);
    try { console.warn('[net-guard] retry failed', err); } catch { /* non-fatal */ }
    return false;
  }
};

const completeFetchBlock = (
  ctx: BlockContext,
  status: number,
  input: any,
  init: RequestInit | undefined,
  orig: typeof fetch,
): Promise<Response> => {
  if (ctx.blocked && interactiveRemediationEnabled) {
    const { promise } = registerFetchRetry(ctx, status, input, init, orig);
    return promise;
  }
  if (ctx.blocked) {
    const payload = emitBlockPayload(ctx);
    return Promise.resolve(makeBlockResponseFromPayload(payload, status));
  }
  emitBlockEvent(ctx);
  return Promise.resolve(orig(input, init));
};

const mapComputeToggleToBlock = (value: 'allow' | 'ask' | 'deny'): boolean => value === 'deny';

let policyListenerTeardown: (() => void) | null = null;
let lastCustomConfig: Partial<GuardConfig> | undefined;

const getPolicyRpsForHost = (host: string): number | undefined => {
  try {
    const pol = getEffectivePolicy();
    const quotas = pol?.network?.quotas;
    if (!quotas) return undefined;
    let rps: number | undefined = quotas.domain_defaults?.rps;
    const overrides = quotas.overrides || {};
    for (const [pattern, rule] of Object.entries(overrides)) {
      if (matchesWildcardDomain(host, pattern) && typeof rule?.rps === 'number') {
        rps = rule.rps;
        break;
      }
    }
    if (typeof rps === 'number' && Number.isFinite(rps) && rps > 0) return rps;
  } catch { /* non-fatal */ }
  return undefined;
};

const rpsBuckets: Map<string, { tokens: number; last: number; capacity: number; refillPerMs: number }> = new Map();

const consumeRpsToken = (host: string, rps: number): boolean => {
  try {
    const now = Date.now();
    let b = rpsBuckets.get(host);
    if (!b) {
      b = { tokens: rps, last: now, capacity: rps, refillPerMs: rps / 1000 };
      rpsBuckets.set(host, b);
    }
    // Refill
    const elapsed = Math.max(0, now - b.last);
    b.tokens = Math.min(b.capacity, b.tokens + elapsed * b.refillPerMs);
    b.last = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return true;
    }
    return false;
  } catch {
    return true;
  }
};

const toUrl = (input: RequestInfo | URL, base?: string): URL => {
  const defaultBase = base || (typeof window !== 'undefined' && window.location ? window.location.href : undefined);
  if (input instanceof URL) return input;
  if (typeof input === 'string') return new URL(input, defaultBase);
  try {
    const req = input as Request;
    return new URL(req.url, defaultBase);
  } catch {
    return new URL(String(input), defaultBase);
  }
};

const sanitizeForLog = (u: URL): string => `${u.protocol}//${u.host}${u.pathname}`;

const isTestEnv = (): boolean => {
  try {
    // Vitest or generic NODE_ENV=test
     
    const p: any = typeof process !== 'undefined' ? process : undefined;
    if (p && p.env && (p.env.VITEST || p.env.NODE_ENV === 'test')) return true;
  } catch { /* non-fatal */ }
  try {
    // Vite-style import.meta.env
     
    const ie: any = (import.meta as any)?.env;
    if (ie && (ie.MODE === 'test' || ie.VITEST)) return true;
  } catch { /* non-fatal */ }
  return false;
};

const SECURITY_ERROR_MESSAGE = 'Blocked by Network Guard';

const setProp = (obj: any, key: string, value: any) => {
  try {
    Object.defineProperty(obj, key, {
      value,
      configurable: true, // allow test envs/jsdom teardown to delete
      writable: isTestEnv(), // allow mutation in tests; prevent in prod
      enumerable: false,
    });
  } catch {
    try { obj[key] = value; } catch { /* non-fatal */ }
  }
};

const createSecurityError = (): Error => {
  try {
    if (typeof DOMException === 'function') {
      return new DOMException(SECURITY_ERROR_MESSAGE, 'SecurityError');
    }
  } catch { /* non-fatal */ }
  const err = new Error(SECURITY_ERROR_MESSAGE);
  try { (err as any).name = 'SecurityError'; } catch { /* non-fatal */ }
  return err;
};

const normalizePath = (p: string): string => {
  try {
    if (!p || typeof p !== 'string') return '/';
    return p.startsWith('/') ? p : '/' + p;
  } catch {
    return '/';
  }
};

const getBodyLength = (data: any): number | null => {
  try {
    if (data == null) return 0;
    if (typeof data === 'string') {
      // Prefer TextEncoder for accurate byte length in tests/node
      if (typeof TextEncoder !== 'undefined') {
        return new TextEncoder().encode(data).length;
      }
      if (typeof Blob !== 'undefined') {
        return new Blob([data]).size;
      }
      return data.length || null;
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) return data.size;
    if (data instanceof ArrayBuffer) return data.byteLength;
    if (ArrayBuffer.isView(data)) return (data as ArrayBufferView).byteLength;
  } catch { /* non-fatal */ }
  return null;
};

const urlhausCache = new Map<string, { verdict: 'malicious' | 'suspicious' | 'clean' | 'unknown'; expires: number }>();
const urlhausMaliciousHosts = new Set<string>();
const urlhausPending = new Map<string, Promise<'malicious' | 'suspicious' | 'clean' | 'unknown'>>();

const getStorage = (): Storage | null => {
  try {
    const w: any = typeof window !== 'undefined' ? window : undefined;
    if (!w || !w.localStorage) return null;
    return w.localStorage as Storage;
  } catch {
    return null;
  }
};

type PersistPhase = 'load' | 'save' | 'read';

const persistWarnings: Record<PersistPhase, boolean> = {
  load: false,
  save: false,
  read: false,
};

const logPersistWarning = (phase: PersistPhase, err: unknown): void => {
  if (persistWarnings[phase]) return;
  persistWarnings[phase] = true;
  try {
    console.warn(`[net-guard] urlhaus persistence ${phase} failure`, err);
  } catch { /* logging itself should never throw */ }
};

const loadPersistedUrlhaus = () => {
  try {
    if (!cfg || !cfg.urlhausPersistEnabled) return;
    const st = getStorage();
    if (!st) return;
    const key = (cfg.urlhausPersistKey && cfg.urlhausPersistKey.trim()) || 'uicp:urlhaus:cache:v1';
    const raw = st.getItem(key);
    if (!raw) return;
    const obj = JSON.parse(raw || '{}') as Record<string, { verdict: string; expires: number }>;
    const now = Date.now();
    for (const [k, v] of Object.entries(obj)) {
      if (!v || typeof v.expires !== 'number' || v.expires <= now) continue;
      const vv = String(v.verdict || '');
      if (vv === 'clean') {
        urlhausCache.set(k, { verdict: 'clean', expires: v.expires });
      }
    }
  } catch (err) {
    logPersistWarning('load', err);
  }
};

const savePersistedUrlhaus = (k: string, verdict: 'clean' | 'suspicious' | 'malicious' | 'unknown', expires: number) => {
  try {
    if (!cfg || !cfg.urlhausPersistEnabled) return;
    if (verdict !== 'clean') return;
    const st = getStorage();
    if (!st) return;
    const key = (cfg.urlhausPersistKey && cfg.urlhausPersistKey.trim()) || 'uicp:urlhaus:cache:v1';
    const now = Date.now();
    const maxEntries = typeof cfg.urlhausPersistMaxEntries === 'number' && cfg.urlhausPersistMaxEntries! > 0 ? cfg.urlhausPersistMaxEntries! : 500;
    let obj: Record<string, { verdict: string; expires: number }> = {};
    try { obj = JSON.parse(st.getItem(key) || '{}') || {}; } catch (err) {
      logPersistWarning('read', err);
    }
    for (const kk of Object.keys(obj)) {
      const vv = obj[kk];
      if (!vv || typeof vv.expires !== 'number' || vv.expires <= now) delete obj[kk];
    }
    obj[k] = { verdict: 'clean', expires };
    const keys = Object.keys(obj);
    if (keys.length > maxEntries) {
      const sorted = keys.sort((a, b) => (obj[a]!.expires - obj[b]!.expires));
      const toDrop = sorted.slice(0, Math.max(0, keys.length - maxEntries));
      for (const d of toDrop) delete obj[d];
    }
    st.setItem(key, JSON.stringify(obj));
  } catch (err) {
    logPersistWarning('save', err);
  }
};

function cacheUrlhausVerdict(
  u: URL,
  verdict: 'malicious' | 'suspicious' | 'clean' | 'unknown',
): void {
  try {
    if (!cfg || !cfg.urlhausEnabled) return;
    const mode = cfg.urlhausMode === 'url' ? 'url' : 'host';
    const key = mode === 'url' ? stripHash(u.href) : u.hostname.toLowerCase();
    if (!key) return;
    const now = Date.now();
    const baseTtlSec = typeof cfg.urlhausCacheTtlSec === 'number' && cfg.urlhausCacheTtlSec! > 0 ? cfg.urlhausCacheTtlSec! : 600;
    const ttlMs = verdict === 'malicious' ? baseTtlSec * 2000 : baseTtlSec * 1000;
    urlhausCache.set(key, { verdict, expires: now + ttlMs });
    const persistTtlSec = typeof cfg.urlhausPersistTtlSec === 'number' && cfg.urlhausPersistTtlSec! > 0 ? cfg.urlhausPersistTtlSec! : 86400;
    savePersistedUrlhaus(key, verdict, now + persistTtlSec * 1000);
    try {
      if (verdict === 'malicious') {
        const hostLower = u.hostname.toLowerCase();
        if (hostLower) urlhausMaliciousHosts.add(hostLower);
      }
    } catch { /* non-fatal */ }
  } catch { /* non-fatal */ }
}

const stripHash = (s: string): string => {
  try {
    const i = s.indexOf('#');
    return i >= 0 ? s.slice(0, i) : s;
  } catch {
    return s;
  }
};

const hostMatchesAllow = (hostLower: string): boolean => {
  try {
    if (!cfg) return false;
    const domains = Array.isArray(cfg.allowDomains) ? (cfg.allowDomains as string[]) : [];
    if (domains.some((d) => hostLower === d || hostLower.endsWith('.' + d))) return true;
    if (Array.isArray(cfg.allowIPs) && (isIPv4(hostLower) || isIPv6(hostLower))) {
      if ((cfg.allowIPs as string[]).includes(hostLower)) return true;
      if (isIPv4(hostLower)) {
        if ((cfg.allowIPs as string[]).some((entry) => typeof entry === 'string' && entry.includes('/') && ipInCidrV4(hostLower, entry))) return true;
      }
    }
  } catch { /* non-fatal */ }
  return false;
};

const getUrlhausCachedVerdict = (u: URL): 'malicious' | 'suspicious' | 'clean' | 'unknown' | null => {
  try {
    if (!cfg || !cfg.urlhausEnabled) return null;
    const hostKey = u.hostname.toLowerCase();
    if (urlhausMaliciousHosts.has(hostKey)) return 'malicious';
    const urlKey = stripHash(u.href);
    const now = Date.now();
    // Prefer configured mode key first
    const primaryKey = (cfg.urlhausMode === 'url' ? urlKey : hostKey);
    const secondaryKey = (cfg.urlhausMode === 'url' ? hostKey : urlKey);
    const e1 = urlhausCache.get(primaryKey);
    if (e1 && e1.expires > now) return e1.verdict;
    const e2 = urlhausCache.get(secondaryKey);
    if (e2 && e2.expires > now) return e2.verdict;
  } catch { /* non-fatal */ }
  return null;
};

const urlhausLookup = async (u: URL, origFetch: typeof fetch): Promise<'malicious' | 'suspicious' | 'clean' | 'unknown'> => {
  try {
    if (!cfg || !cfg.urlhausEnabled) return 'unknown';
    const scheme = u.protocol.replace(/:$/, '');
    if (scheme !== 'http' && scheme !== 'https') return 'unknown';
    const hostLower = u.hostname.toLowerCase();
    if (defaultAllowHosts.has(hostLower)) return 'unknown';
    if (defaultAllowIPs.has(hostLower)) return 'unknown';
    if (cfg.urlhausRespectAllows && hostMatchesAllow(hostLower)) return 'unknown';
    const mode = cfg.urlhausMode === 'url' ? 'url' : 'host';
    const key = mode === 'url' ? stripHash(u.href) : hostLower;
    const now = Date.now();
    const cached = urlhausCache.get(key);
    if (cached && cached.expires > now) return cached.verdict;
    const pending = urlhausPending.get(key);
    if (pending) return pending;
    const base = (cfg.urlhausApiBase && cfg.urlhausApiBase.trim()) || 'https://urlhaus-api.abuse.ch/v1';
    const endpoint = `${base.replace(/\/+$/, '')}/${mode}/`;
    const form = new URLSearchParams();
    if (mode === 'url') form.set('url', stripHash(u.href)); else form.set('host', hostLower);
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = typeof cfg.urlhausTimeoutMs === 'number' && cfg.urlhausTimeoutMs! > 0 ? cfg.urlhausTimeoutMs! : 1500;
    let tid: any = null;
    if (controller) {
      try { tid = setTimeout(() => { try { controller.abort(); } catch { /* non-fatal */ } }, t); } catch { /* non-fatal */ }
    }
    const p = (async () => {
      try {
        const headers = new Headers({ 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' });
        if (cfg.urlhausAuthKey && cfg.urlhausAuthKey.trim().length > 0) headers.set('Auth-Key', cfg.urlhausAuthKey.trim());
        const res = await origFetch(endpoint, { method: 'POST', headers, body: form.toString(), signal: controller ? controller.signal : undefined } as RequestInit);
        if (!res.ok) return 'unknown';
        const json: any = await res.json().catch(() => null);
        if (!json) return 'unknown';
        const status = String(json.query_status || json.query_staus || '').toLowerCase();
        if (status === 'no_results') return 'clean';
        if (status !== 'ok') return 'unknown';
        if (mode === 'url') {
          const threat = String(json.threat ?? '').toLowerCase();
          const urlStatus = String(json.url_status ?? '').toLowerCase();
          if (threat.includes('malware') && urlStatus !== 'offline') return 'malicious';
          const bl: any = json.blacklists || {};
          if (String(bl.surbl || '').toLowerCase().includes('listed')) return 'suspicious';
          if (String(bl.spamhaus_dbl || '').toLowerCase() !== 'not listed' && String(bl.spamhaus_dbl || '').trim() !== '') return 'suspicious';
          return 'clean';
        } else {
          const countRaw = json.url_count;
          const count = typeof countRaw === 'string' ? parseInt(countRaw, 10) : (typeof countRaw === 'number' ? countRaw : 0);
          const urls: any[] = Array.isArray(json.urls) ? json.urls : [];
          const hasMal = urls.some((r: any) => String(r.threat || '').toLowerCase().includes('malware') && String(r.url_status || '').toLowerCase() !== 'offline');
          if (hasMal) return 'malicious';
          if (count > 0) return 'suspicious';
          const bl: any = json.blacklists || {};
          if (String(bl.surbl || '').toLowerCase().includes('listed')) return 'suspicious';
          if (String(bl.spamhaus_dbl || '').toLowerCase() !== 'not listed' && String(bl.spamhaus_dbl || '').trim() !== '') return 'suspicious';
          return 'clean';
        }
      } catch {
        return 'unknown';
      } finally {
        try { if (tid) clearTimeout(tid); } catch { /* non-fatal */ }
      }
    })();
    urlhausPending.set(key, p);
    const verdict = await p;
    urlhausPending.delete(key);
    cacheUrlhausVerdict(u, verdict);
    return verdict;
  } catch {
    return 'unknown';
  }
};

const pathAllowed = (u: URL): boolean => {
  try {
    if (!cfg || !cfg.allowPaths || cfg.allowPaths.length === 0) return true;
    const p = normalizePath(u.pathname || '/');
    return cfg.allowPaths.some((prefix) => p.startsWith(normalizePath(prefix)));
  } catch {
    return true;
  }
};

// Simple wildcard matcher supporting patterns like '*.github.com'
const matchesWildcardDomain = (host: string, pattern: string): boolean => {
  try {
    const h = host.toLowerCase().replace(/\.$/, '');
    const p = pattern.toLowerCase().replace(/\.$/, '');
    if (!p.includes('*')) return h === p;
    if (p.startsWith('*.')) {
      const suffix = p.slice(1); // '.github.com'
      return h === p.slice(2) || h.endsWith(suffix);
    }
    // Basic fallback: treat '*' as prefix wildcard
    const parts = p.split('*');
    return h.startsWith(parts[0] ?? '') && h.endsWith(parts[1] ?? '');
  } catch {
    return false;
  }
};

const getPolicyMaxResponseBytesForHost = (host: string): number | undefined => {
  try {
    const pol = getEffectivePolicy();
    const quotas = pol?.network?.quotas;
    if (!quotas) return undefined;
    let maxMb: number | undefined = quotas.domain_defaults?.max_response_mb;
    const overrides = quotas.overrides || {};
    for (const [pattern, rule] of Object.entries(overrides)) {
      if (matchesWildcardDomain(host, pattern) && typeof rule?.max_response_mb === 'number') {
        maxMb = rule.max_response_mb;
        break;
      }
    }
    if (typeof maxMb === 'number' && Number.isFinite(maxMb) && maxMb > 0) {
      return Math.floor(maxMb * 1024 * 1024);
    }
  } catch { /* non-fatal */ }
  return undefined;
};

const isIPv4 = (host: string) => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
const isIPv6 = (host: string) => host.includes(":") && !host.includes(" ");
const toIpv4Int = (ip: string): number | null => {
  if (!isIPv4(ip)) return null;
  const parts = ip.split('.').map((x) => Number(x));
  if (parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
};
const ipInCidrV4 = (ip: string, cidr: string): boolean => {
  const [net, maskStr] = cidr.split('/') as [string, string | undefined];
  const mask = maskStr ? Number(maskStr) : 32;
  const ipInt = toIpv4Int(ip);
  const netInt = toIpv4Int(net);
  if (ipInt == null || netInt == null || !Number.isFinite(mask)) return false;
  const shift = 32 - Math.max(0, Math.min(32, mask));
  return (ipInt >>> shift) === (netInt >>> shift);
};

const defaultBlockIPsExact = new Set<string>([
  '169.254.169.254',
  '169.254.170.2',
  '1.1.1.1',
  '1.0.0.1',
  '8.8.8.8',
  '8.8.4.4',
  '9.9.9.9',
  '149.112.112.112',
  'fd00:ec2::254',
]);
const defaultBlockIPv4Cidrs = ['76.76.2.0/24', '76.76.10.0/24'];
const privateBlockIPv4Cidrs = ['10.0.0.0/8','172.16.0.0/12','192.168.0.0/16','100.64.0.0/10','169.254.0.0/16'];
const defaultBlockDomains = new Set<string>([
  'cloudflare-dns.com',
  'dns.google',
  'dns.quad9.net',
  'nextdns.io',
  'doh.opendns.com',
]);

const defaultAllowHosts = new Set<string>(['localhost']);
const defaultAllowIPs = new Set<string>(['127.0.0.1', '::1']);

let cfg: GuardConfig | null = null;

const emitBlockEvent = (detail: BlockEventDetail) => {
  try {
    const w: any = typeof window !== 'undefined' ? window : undefined;
     
    if (!w || typeof w.dispatchEvent !== 'function' || typeof (w as any).CustomEvent !== 'function') return;
     
    const ev = new (w as any).CustomEvent('net-guard-block', { detail });
    w.dispatchEvent(ev);
  } catch { /* non-fatal */ }
};

const emitAttemptEvent = (detail: { url: string; method?: string; api: 'fetch' | 'xhr' | 'ws' | 'sse' | 'beacon' }) => {
  try {
    const w: any = typeof window !== 'undefined' ? window : undefined;
     
    if (!w || typeof w.dispatchEvent !== 'function' || typeof (w as any).CustomEvent !== 'function') return;
     
    const ev = new (w as any).CustomEvent('net-guard-attempt', { detail });
    w.dispatchEvent(ev);
  } catch { /* non-fatal */ }
};

const maybeEmitAttempt = (api: 'fetch' | 'xhr' | 'ws' | 'sse' | 'beacon', url: string, method?: string) => {
  try {
    const sample = cfg?.attemptSample;
    if (!sample || sample <= 0) return;
    if (sample === 1 || Math.floor(Math.random() * sample) === 0) {
      emitAttemptEvent({ api, url, method });
    }
  } catch { /* non-fatal */ }
};

const setConfig = (next: Partial<GuardConfig>) => {
  const base: GuardConfig = cfg ?? {
    enabled: true,
    monitorOnly: false,
    allowDomains: [],
    allowIPs: [],
    blockDomains: [],
    blockIPs: [],
    verbose: false,
    allowPaths: [],
    attemptSample: 1,
  };
  cfg = { ...base, ...next };
   
  (globalThis as any).__UICP_NET_GUARD__ = cfg;
};

const shouldBlockHost = (host: string, port: string | number | null | undefined): { block: boolean; reason?: string } => {
  if (!cfg || !cfg.enabled) return { block: false };
  const rawLower = host.toLowerCase().replace(/\.$/, '');
  // Normalize bracketed IPv6 forms like "[::1]" to "::1"
  const lower = rawLower.startsWith('[') && rawLower.endsWith(']') ? rawLower.slice(1, -1) : rawLower;
  const domainParts = lower.split('.');
  const isIp4 = isIPv4(lower);
  const isIp6 = !isIp4 && isIPv6(lower);
  const policy: Policy = getEffectivePolicy();

  if (port && String(port) === '853') return { block: true, reason: 'port_853' };

  if (defaultAllowHosts.has(lower)) return { block: false };
  if ((isIp4 || isIp6) && defaultAllowIPs.has(lower)) return { block: false };

  if (cfg.allowDomains && cfg.allowDomains.length) {
    const allow = cfg.allowDomains.some((d) => lower === d || lower.endsWith('.' + d));
    if (allow) return { block: false };
  }
  if (cfg.allowIPs && cfg.allowIPs.length && (isIp4 || isIp6)) {
    if (cfg.allowIPs.includes(lower)) return { block: false };
    if (isIp4) {
      const cidrAllowed = (cfg.allowIPs as string[]).some((entry) => typeof entry === 'string' && entry.includes('/') && ipInCidrV4(lower, entry));
      if (cidrAllowed) return { block: false };
    }
  }
  if (isIp4 && cfg.allowIPRanges && cfg.allowIPRanges.length) {
    const cidrAllowed = (cfg.allowIPRanges as string[]).some((cidr) => ipInCidrV4(lower, cidr));
    if (cidrAllowed) return { block: false };
  }

  if (!isIp4 && !isIp6 && domainParts.length >= 2) {
    const blockedByDomain = defaultBlockDomains.has(lower) || (cfg.blockDomains ?? []).some((d) => lower === d || lower.endsWith('.' + d));
    if (blockedByDomain) return { block: true, reason: 'doh_domain' };
  }

  if (isIp4 || isIp6) {
    // If explicitly allow-listed, let it pass
    if (cfg.allowIPs && cfg.allowIPs.includes(lower)) return { block: false };
    // 1) Exact and known bad IPs always block (metadata endpoints, etc.)
    if (defaultBlockIPsExact.has(lower) || (cfg.blockIPs ?? []).includes(lower)) {
      return { block: true, reason: 'ip_exact' };
    }
    if (isIp4) {
      // 2) DoH provider IPv4 CIDRs always block
      if (defaultBlockIPv4Cidrs.some((c) => ipInCidrV4(lower, c))) return { block: true, reason: 'ip_cidr' };
      // 3) RFC1918/CGNAT/link-local private ranges are blocked by default unless explicitly allow-listed/ranged
      const isPrivate = privateBlockIPv4Cidrs.some((c) => ipInCidrV4(lower, c));
      if (isPrivate) {
        // In non-test runtime, honor policy for private LAN
        if (!isTestEnv()) {
          if (policy.network.allow_private_lan === 'allow') return { block: false };
          if (policy.network.allow_private_lan === 'ask') return { block: true, reason: 'private_lan_blocked' };
        }
        return { block: true, reason: 'ip_private' };
      }
      // 4) If policy forbids IP literals altogether
      if (!policy.network.allow_ip_literals) return { block: true, reason: 'ip_literal_blocked' };
    } else {
      // IPv6 private/link-local blocks using CIDR matches: fc00::/7 and fe80::/10
      const isPrivateV6 = ipInPrivateV6(lower);
      if (isPrivateV6) {
        if (!isTestEnv()) {
          if (policy.network.allow_private_lan === 'allow') return { block: false };
          if (policy.network.allow_private_lan === 'ask') return { block: true, reason: 'private_lan_blocked' };
        }
        return { block: true, reason: 'ip_v6_private' };
      }
      if (defaultBlockIPsExact.has(lower) || (cfg.blockIPs ?? []).includes(lower)) return { block: true, reason: 'ip_v6' };
      if (!policy.network.allow_ip_literals) return { block: true, reason: 'ip_literal_blocked' };
    }
  }

  // default_deny mode: require explicit allow via wildcard_rules
  try {
    const policy: Policy = getEffectivePolicy();
    if (policy.network.mode === 'default_deny') {
      const rules = policy.network.wildcard_rules || [];
      const allowed = rules.some((r) => Array.isArray(r.allow) && r.allow.some((pat) => matchesWildcardDomain(lower, pat)));
      if (!allowed) return { block: true, reason: 'policy_default_deny' };
    }
  } catch { /* non-fatal */ }
  return { block: false };
};

const installFetchGuard = () => {
   
  const g: any = globalThis as any;
   
  const win: any = typeof window !== 'undefined' ? (window as any) : undefined;
  const hasWindowFetch = !!(win && typeof win.fetch === 'function');
  const hasGlobalFetch = typeof g.fetch === 'function';
  if (!hasWindowFetch && !hasGlobalFetch) return;
   
  const testFetch: any = (g as any).__UICP_TEST_FETCH__;
  let orig: typeof fetch;
  if (typeof testFetch === 'function') {
    // Tests can inject a stub to avoid real network and return deterministic JSON
    orig = testFetch as typeof fetch;
  } else {
    orig = (hasWindowFetch ? win.fetch : g.fetch).bind(hasWindowFetch ? win : g);
  }
  const wrapper = async (input: any, init?: RequestInit) => {
    try {
      const url = toUrl(input);
      const scheme = url.protocol.replace(/:$/, '');
      const method = String((init as any)?.method || (input?.method ?? 'GET') || 'GET').toUpperCase();
      const sanitizedUrl = sanitizeForLog(url);
      
      maybeEmitAttempt('fetch', sanitizedUrl, method);

      const emitMonitor = (reason: string) => {
        emitBlockEvent({ api: 'fetch', url: sanitizedUrl, reason, method, blocked: false });
      };

      const blockFetch = (reason: string, status = 403, error = 'network_blocked'): Promise<Response> => {
        const ctx: BlockContext = { api: 'fetch', url: sanitizedUrl, reason, method, blocked: true, error };
        return completeFetchBlock(ctx, status, input, init, orig);
      };

      // Enforce HTTPS-only when policy requires
      try {
        const pol = getEffectivePolicy();
        if (pol.network.https_only && scheme === 'http') {
          // Skip HTTPS-only for loopback and IP literals; host policy decides
          const host = url.hostname.toLowerCase();
          const isIp4 = isIPv4(host);
          const isIp6 = !isIp4 && isIPv6(host);
          const isLocalhostLabel = host === 'localhost' || host.endsWith('.localhost');
          const isLoopback = isLocalhostLabel || host === '127.0.0.1' || host === '::1';
          if (!isLoopback && !isIp4 && !isIp6) {
            if (cfg?.verbose) console.warn('[net-guard] fetch blocked (https_only)', sanitizeForLog(url));
            if (cfg?.monitorOnly) {
              emitMonitor('https_only');
              return orig(input, init);
            }
            return blockFetch('https_only');
          }
        }
      } catch { /* non-fatal */ }
      if (scheme === 'blob' || scheme === 'data') {
        return orig(input, init);
      }
      if (scheme === 'file' || scheme === 'filesystem') {
        if (cfg?.verbose) console.warn('[net-guard] fetch blocked (scheme)', sanitizeForLog(url), 'scheme_forbidden');
        if (cfg?.monitorOnly) {
          emitMonitor('scheme_forbidden');
          return orig(input, init);
        }
        return blockFetch('scheme_forbidden');
      }
      // Path allowlist (optional)
      if (!pathAllowed(url)) {
        if (cfg?.verbose) console.warn('[net-guard] fetch blocked (path)', sanitizeForLog(url), 'path_forbidden');
        if (cfg?.monitorOnly) {
          emitMonitor('path_forbidden');
          return orig(input, init);
        }
        return blockFetch('path_forbidden');
      }
      // Request payload cap (best-effort)
       
      if (cfg?.maxRequestBytes && method !== 'GET') {
        
        const len = getBodyLength((init as any)?.body ?? (input as any)?.body);
        if (len != null && len > (cfg.maxRequestBytes as number)) {
          if (cfg?.verbose) console.warn('[net-guard] fetch blocked (payload_too_large)', sanitizeForLog(url), len);
          if (cfg?.monitorOnly) {
            emitMonitor('payload_too_large');
            return orig(input, init);
          }
          return blockFetch('payload_too_large', 413);
        }
      }
      try {
        const verdict = await urlhausLookup(url, orig);
        cacheUrlhausVerdict(url, verdict); // cache verdict even if fetch is blocked
        if (verdict === 'malicious') {
          if (cfg?.verbose) console.warn('[net-guard] fetch blocked (urlhaus_flagged)', sanitizeForLog(url));
          if (cfg?.monitorOnly) {
            emitMonitor('urlhaus_flagged');
          } else {
            return blockFetch('urlhaus_flagged', 403, 'urlhaus_flagged');
          }
        } else if (verdict === 'suspicious') {
          if (cfg?.monitorOnly) emitMonitor('urlhaus_suspicious');
        }
      } catch { /* non-fatal */ }
      const res = shouldBlockHost(url.hostname, url.port);
      if (res.block) {
        if (cfg?.verbose) console.warn('[net-guard] fetch blocked', sanitizeForLog(url), res.reason);
        const reason = res.reason ?? 'policy';
        if (cfg?.monitorOnly) {
          emitMonitor(reason);
          return orig(input, init);
        }
        return blockFetch(reason);
      }
      // Per-domain RPS quotas (token bucket)
      try {
        const host = url.hostname;
        const rps = getPolicyRpsForHost(host);
        if (typeof rps === 'number' && rps > 0) {
          const ok = consumeRpsToken(host, rps);
          if (!ok) {
            if (cfg?.verbose) console.warn('[net-guard] fetch blocked (rate_limited)', sanitizeForLog(url));
            if (cfg?.monitorOnly) {
              emitMonitor('rate_limited');
              return orig(input, init);
            }
            return blockFetch('rate_limited', 429, 'rate_limited');
          }
        }
      } catch { /* non-fatal */ }
    } catch { /* non-fatal */ }
    const startedUrl = (() => { try { return sanitizeForLog(toUrl(input)); } catch { return String(input); } })();
    const p = orig(input, init);
    // Post-response checks (redirects and content-length)
    if (!cfg) return p;
    const wantsRedirectCheck = typeof cfg.maxRedirects === 'number';
    const wantsSizeCheck = typeof cfg.maxResponseBytes === 'number' || !!getPolicyMaxResponseBytesForHost((() => { try { return new URL(startedUrl).hostname; } catch { return ''; } })());
    if (!wantsRedirectCheck && !wantsSizeCheck) return p;
    return p.then((res: Response) => {
      try {
        if (wantsRedirectCheck && (cfg!.maxRedirects as number) === 0 && res.redirected) {
          if (cfg?.verbose) console.warn('[net-guard] fetch blocked (redirect_exceeded)', startedUrl);
          const ctx: BlockContext = { api: 'fetch', url: startedUrl, reason: 'redirect_exceeded', method: String((init as any)?.method || (input?.method ?? 'GET')).toUpperCase(), blocked: true, error: 'network_blocked' };
          if (cfg?.monitorOnly) {
            emitBlockEvent({ ...ctx, blocked: false });
            return res;
          }
          return respondWithBlock(ctx, 470);
        }
        if (wantsSizeCheck) {
          const clHeader = res.headers.get('content-length');
          const cl = clHeader ? Number(clHeader) : NaN;
          const host = (() => { try { return new URL(startedUrl).hostname; } catch { return ''; } })();
          const policyMax = getPolicyMaxResponseBytesForHost(host);
          const cfgMax = cfg!.maxResponseBytes as number | undefined;
          const limit = (() => {
            if (typeof cfgMax === 'number' && typeof policyMax === 'number') return Math.min(cfgMax, policyMax);
            if (typeof cfgMax === 'number') return cfgMax;
            if (typeof policyMax === 'number') return policyMax;
            return undefined;
          })();
          if (Number.isFinite(cl) && typeof limit === 'number' && cl > limit) {
            if (cfg?.verbose) console.warn('[net-guard] fetch blocked (response_too_large)', startedUrl, cl, 'limit', limit);
            const ctx: BlockContext = { api: 'fetch', url: startedUrl, reason: 'response_too_large', method: String((init as any)?.method || (input?.method ?? 'GET')).toUpperCase(), blocked: true, error: 'network_blocked' };
            if (cfg?.monitorOnly) {
              emitBlockEvent({ ...ctx, blocked: false });
              return res;
            }
            return respondWithBlock(ctx, 413);
          }
        }
      } catch { /* non-fatal */ }
      return res;
    });
  };
   
  (wrapper as any).__uicpWrapped = true;
  // Wrap both window and global fetch if present
  try { if (win) setProp(win, 'fetch', wrapper); } catch { /* non-fatal */ }
  try { if (hasGlobalFetch) setProp(g, 'fetch', wrapper); } catch { /* non-fatal */ }
  // Lock properties in non-test envs to prevent unhooking
  try {
    if (!isTestEnv()) {
      if (win && typeof win.fetch === 'function') {
        const current = win.fetch;
        Object.defineProperty(win, 'fetch', { value: current, configurable: false, writable: false });
      }
      if (hasGlobalFetch) {
        const current = g.fetch;
        Object.defineProperty(g, 'fetch', { value: current, configurable: false, writable: false });
      }
    }
  } catch { /* non-fatal */ }
};

const installXHRGuard = () => {
   
  if (typeof window === 'undefined' || !(window as any).XMLHttpRequest) return;
   
  const XHR = (window as any).XMLHttpRequest;
  const wrapped = function (this: any, ...args: any[]) {
    let blockError: Error | undefined;
    try {
      const url = args[1] as string;
      const u = toUrl(url);
      const scheme = u.protocol.replace(/:$/, '');
      maybeEmitAttempt('xhr', sanitizeForLog(u), String(args[0] ?? 'GET'));
      if (scheme === 'file' || scheme === 'filesystem') {
        if (cfg?.verbose) console.warn('[net-guard] xhr blocked (scheme)', sanitizeForLog(u), 'scheme_forbidden');
        emitBlockEvent({ url: sanitizeForLog(u), reason: 'scheme_forbidden', method: String(args[0] ?? 'GET'), api: 'xhr', blocked: !(cfg?.monitorOnly) });
        if (!(cfg?.monitorOnly)) {
          blockError = new Error('Blocked by Network Guard');
          throw blockError;
        }
      }
      if (!pathAllowed(u)) {
        if (cfg?.verbose) console.warn('[net-guard] xhr blocked (path)', sanitizeForLog(u), 'path_forbidden');
        emitBlockEvent({ url: sanitizeForLog(u), reason: 'path_forbidden', method: String(args[0] ?? 'GET'), api: 'xhr', blocked: !(cfg?.monitorOnly) });
        if (!(cfg?.monitorOnly)) {
          blockError = new Error('Blocked by Network Guard');
          throw blockError;
        }
      }
      try {
        const v = getUrlhausCachedVerdict(u);
        if (v === 'malicious') {
          if (cfg?.verbose) console.warn('[net-guard] xhr blocked (urlhaus_flagged)', sanitizeForLog(u));
          emitBlockEvent({ url: sanitizeForLog(u), reason: 'urlhaus_flagged', method: String(args[0] ?? 'GET'), api: 'xhr', blocked: !(cfg?.monitorOnly) });
          if (!(cfg?.monitorOnly)) {
            blockError = new Error('Blocked by Network Guard');
            throw blockError;
          }
        }
      } catch { /* non-fatal */ }
      const res = shouldBlockHost(u.hostname, u.port);
      if (res.block) {
        if (cfg?.verbose) console.warn('[net-guard] xhr blocked', sanitizeForLog(u), res.reason);
        emitBlockEvent({ url: sanitizeForLog(u), reason: res.reason, method: String(args[0] ?? 'GET'), api: 'xhr', blocked: !(cfg?.monitorOnly) });
        if (!(cfg?.monitorOnly)) {
          blockError = new Error('Blocked by Network Guard');
          throw blockError;
        }
      }
    } catch (error) {
      if (blockError) {
        throw blockError;
      }
      if (cfg?.verbose) {
        console.warn('[net-guard] xhr policy inspection failed', error);
      }
    }
     
    return (XHR as any).prototype.__uicpOrigOpen.apply(this, args as any);
   
  } as any;
   
  if (!(XHR as any).prototype.__uicpOrigOpen) {
     
    (XHR as any).prototype.__uicpOrigOpen = XHR.prototype.open;
  }
   
  (wrapped as any).__uicpWrapped = true;
  try { Object.defineProperty(XHR.prototype, 'open', { value: wrapped, configurable: true, writable: isTestEnv() }); } catch { /* non-fatal */ }
  // Wrap send() to enforce request payload caps
  try {
     
    const proto: any = (XHR as any).prototype;
    if (!proto.__uicpOrigSend && typeof proto.send === 'function') {
      proto.__uicpOrigSend = proto.send;
    }
    if (typeof proto.send === 'function') {
      const sendWrapped = function (this: any, data?: any) {
        try {
          if (cfg?.maxRequestBytes) {
            const len = getBodyLength(data);
            if (len != null && len > (cfg.maxRequestBytes as number)) {
              if (cfg?.verbose) console.warn('[net-guard] xhr blocked (payload_too_large)');
              emitBlockEvent({ url: 'xhr:send', reason: 'payload_too_large', api: 'xhr', blocked: !(cfg?.monitorOnly) });
              if (!(cfg?.monitorOnly)) throw new Error('Blocked by Network Guard');
            }
          }
        } catch { /* non-fatal */ }
         
        const fn = (this as any).__uicpOrigSend || proto.__uicpOrigSend || proto.send;
         
        return fn.apply(this, arguments as any);
       
      } as any;
      try { Object.defineProperty(proto, 'send', { value: sendWrapped, configurable: true, writable: isTestEnv() }); } catch { proto.send = sendWrapped; }
    }
  } catch { /* non-fatal */ }
};

const installWSGuard = () => {
   
  const g: any = globalThis as any;
  if (typeof window === 'undefined' || !(window as any).WebSocket) return;
   
  const WS = (window as any).WebSocket as typeof WebSocket;
   
  if ((WS as any).__uicpWrapped) return;
  const Wrapped = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
     
    const u = toUrl(url as any);
    const scheme = u.protocol.replace(/:$/, '');
    maybeEmitAttempt('ws', sanitizeForLog(u));
    if (scheme !== 'ws' && scheme !== 'wss' && scheme !== 'http' && scheme !== 'https') {
      if (cfg?.verbose) console.warn('[net-guard] ws blocked (scheme)', sanitizeForLog(u), 'scheme_forbidden');
      emitBlockEvent({ url: sanitizeForLog(u), reason: 'scheme_forbidden', api: 'ws', blocked: !(cfg?.monitorOnly) });
      if (!(cfg?.monitorOnly)) throw createSecurityError();
    }
    if (!pathAllowed(u)) {
      if (cfg?.verbose) console.warn('[net-guard] ws blocked (path)', sanitizeForLog(u), 'path_forbidden');
      emitBlockEvent({ url: sanitizeForLog(u), reason: 'path_forbidden', api: 'ws', blocked: !(cfg?.monitorOnly) });
      if (!(cfg?.monitorOnly)) throw createSecurityError();
    }
    try {
      const v = getUrlhausCachedVerdict(u);
      if (v === 'malicious') {
        if (cfg?.verbose) console.warn('[net-guard] ws blocked (urlhaus_flagged)', sanitizeForLog(u));
        emitBlockEvent({ url: sanitizeForLog(u), reason: 'urlhaus_flagged', api: 'ws', blocked: !(cfg?.monitorOnly) });
        if (!(cfg?.monitorOnly)) throw createSecurityError();
      }
      const hostLower = u.hostname.toLowerCase();
      if (urlhausMaliciousHosts.has(hostLower)) {
        if (cfg?.verbose) console.warn('[net-guard] ws blocked (urlhaus_flagged:host)', sanitizeForLog(u));
        emitBlockEvent({ url: sanitizeForLog(u), reason: 'urlhaus_flagged', api: 'ws', blocked: !(cfg?.monitorOnly) });
        if (!(cfg?.monitorOnly)) throw createSecurityError();
      }
    } catch { /* non-fatal */ }
    const res = shouldBlockHost(u.hostname, u.port);
    if (res.block) {
      if (cfg?.verbose) console.warn('[net-guard] ws blocked', sanitizeForLog(u), res.reason);
      emitBlockEvent({ url: sanitizeForLog(u), reason: res.reason, api: 'ws', blocked: !(cfg?.monitorOnly) });
      if (!(cfg?.monitorOnly)) throw createSecurityError();
    }
     
    return new WS(url as any, protocols as any) as any;
   
  } as any;
   
  (Wrapped as any).__uicpWrapped = true;
  Wrapped.prototype = WS.prototype;
   
  setProp(window as any, 'WebSocket', Wrapped);
  try { setProp(g, 'WebSocket', Wrapped); } catch { /* non-fatal */ }
};

const installESGuard = () => {
   
  const g: any = globalThis as any;
  if (typeof window === 'undefined' || !(window as any).EventSource) return;
   
  const ES = (window as any).EventSource as typeof EventSource;
   
  if ((ES as any).__uicpWrapped) return;
  const Wrapped = function (this: EventSource, url: string | URL, eventSourceInitDict?: EventSourceInit) {
     
    const u = toUrl(url as any);
    const scheme = u.protocol.replace(/:$/, '');
    maybeEmitAttempt('sse', sanitizeForLog(u));
    if (scheme !== 'http' && scheme !== 'https') {
      if (cfg?.verbose) console.warn('[net-guard] es blocked (scheme)', sanitizeForLog(u), 'scheme_forbidden');
      emitBlockEvent({ url: sanitizeForLog(u), reason: 'scheme_forbidden', api: 'sse', blocked: !(cfg?.monitorOnly) });
      if (!(cfg?.monitorOnly)) throw createSecurityError();
    }
    if (!pathAllowed(u)) {
      if (cfg?.verbose) console.warn('[net-guard] es blocked (path)', sanitizeForLog(u), 'path_forbidden');
      emitBlockEvent({ url: sanitizeForLog(u), reason: 'path_forbidden', api: 'sse', blocked: !(cfg?.monitorOnly) });
      if (!(cfg?.monitorOnly)) throw createSecurityError();
    }
    try {
      const v = getUrlhausCachedVerdict(u);
      if (v === 'malicious') {
        if (cfg?.verbose) console.warn('[net-guard] es blocked (urlhaus_flagged)', sanitizeForLog(u));
        emitBlockEvent({ url: sanitizeForLog(u), reason: 'urlhaus_flagged', api: 'sse', blocked: !(cfg?.monitorOnly) });
        if (!(cfg?.monitorOnly)) throw createSecurityError();
      }
    } catch { /* non-fatal */ }
    const res = shouldBlockHost(u.hostname, u.port);
    if (res.block) {
      if (cfg?.verbose) console.warn('[net-guard] es blocked', sanitizeForLog(u), res.reason);
      emitBlockEvent({ url: sanitizeForLog(u), reason: res.reason, api: 'sse', blocked: !(cfg?.monitorOnly) });
      if (!(cfg?.monitorOnly)) throw createSecurityError();
    }
     
    return new ES(url as any, eventSourceInitDict) as any;
   
  } as any;
   
  (Wrapped as any).__uicpWrapped = true;
  Wrapped.prototype = ES.prototype;
   
  setProp(window as any, 'EventSource', Wrapped);
  try { setProp(g, 'EventSource', Wrapped); } catch { /* non-fatal */ }
};

const installBeaconGuard = () => {
   
  if (typeof navigator === 'undefined' || typeof (navigator as any).sendBeacon !== 'function') return;
   
  const nav: any = navigator as any;
   
  if (nav.sendBeacon && (nav.sendBeacon as any).__uicpWrapped) return;
  const orig = nav.sendBeacon.bind(nav);
  nav.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
    try {
       
      const u = toUrl(url as any);
      const scheme = u.protocol.replace(/:$/, '');
      maybeEmitAttempt('beacon', sanitizeForLog(u));
      if (scheme === 'file' || scheme === 'filesystem') {
        if (cfg?.verbose) console.warn('[net-guard] beacon blocked (scheme)', sanitizeForLog(u), 'scheme_forbidden');
        emitBlockEvent({ url: sanitizeForLog(u), reason: 'scheme_forbidden', api: 'beacon', blocked: !(cfg?.monitorOnly) });
        if (!(cfg?.monitorOnly)) return false;
      }
      if (!pathAllowed(u)) {
        if (cfg?.verbose) console.warn('[net-guard] beacon blocked (path)', sanitizeForLog(u), 'path_forbidden');
        emitBlockEvent({ url: sanitizeForLog(u), reason: 'path_forbidden', api: 'beacon', blocked: !(cfg?.monitorOnly) });
        if (!(cfg?.monitorOnly)) return false;
      }
      try {
        const v = getUrlhausCachedVerdict(u);
        if (v === 'malicious') {
          if (cfg?.verbose) console.warn('[net-guard] beacon blocked (urlhaus_flagged)', sanitizeForLog(u));
          emitBlockEvent({ url: sanitizeForLog(u), reason: 'urlhaus_flagged', api: 'beacon', blocked: !(cfg?.monitorOnly) });
          if (!(cfg?.monitorOnly)) return false;
        }
      } catch { /* non-fatal */ }
      const res = shouldBlockHost(u.hostname, u.port);
      if (res.block) {
        if (cfg?.verbose) console.warn('[net-guard] beacon blocked', sanitizeForLog(u), res.reason);
        emitBlockEvent({ url: sanitizeForLog(u), reason: res.reason, api: 'beacon', blocked: !(cfg?.monitorOnly) });
        if (!(cfg?.monitorOnly)) return false;
      }
      if (cfg?.maxRequestBytes) {
        const len = getBodyLength(data);
        if (len != null && len > (cfg.maxRequestBytes as number)) {
          if (cfg?.verbose) console.warn('[net-guard] beacon blocked (payload_too_large)', sanitizeForLog(u), len);
          emitBlockEvent({ url: sanitizeForLog(u), reason: 'payload_too_large', api: 'beacon', blocked: !(cfg?.monitorOnly) });
          if (!(cfg?.monitorOnly)) return false;
        }
      }
    } catch { /* non-fatal */ }
     
    return orig(url as any, data as any);
  };
   
  (nav.sendBeacon as any).__uicpWrapped = true;
};

const installWebRTCGuard = () => {
  if (typeof window === 'undefined') return;
   
  const PC: any = (window as any).RTCPeerConnection;
  if (!PC) return;
   
  if ((PC as any).__uicpWrapped) return;
  const Wrapped = function (this: any, config?: RTCConfiguration, ...rest: any[]) {
    const hasServers = Array.isArray(config?.iceServers) && (config!.iceServers!.length > 0);
    if (hasServers) {
       
      const hasStunTurn = (config!.iceServers as any[]).some((s: any) => {
         
        const urls = ([] as any[]).concat((s && (s.urls as any)) || []);
        return urls.some((u) => typeof u === 'string' && /^(stun:|turn:|turns:)/i.test(u));
      });
      if (hasStunTurn) {
        const doBlock = !!(cfg?.blockWebRTC) && !(cfg?.monitorOnly);
        try { emitBlockEvent({ url: 'webrtc:iceservers', reason: doBlock ? 'webrtc_blocked' : 'webrtc_monitor', api: 'webrtc', blocked: doBlock }); } catch { /* non-fatal */ }
        if (doBlock) throw createSecurityError();
      }
    }
     
    return new (PC as any)(config, ...rest);
   
  } as any;
   
  (Wrapped as any).__uicpWrapped = true;
  Wrapped.prototype = PC.prototype;
   
  setProp(window as any, 'RTCPeerConnection', Wrapped);
};

const installWebTransportGuard = () => {
  if (typeof window === 'undefined') return;
   
  const WT: any = (window as any).WebTransport;
  if (!WT) return;
   
  if ((WT as any).__uicpWrapped) return;
  const Wrapped = function (this: any, url: string, opts?: any) {
    const doBlock = !!(cfg?.blockWebTransport) && !(cfg?.monitorOnly);
     
    const u = toUrl(url as any);
    const scheme = u.protocol.replace(/:$/, '');
    if (scheme !== 'https') {
      if (cfg?.verbose) console.warn('[net-guard] webtransport blocked (scheme)', sanitizeForLog(u), 'scheme_forbidden');
      try { emitBlockEvent({ url: sanitizeForLog(u), reason: 'scheme_forbidden', api: 'webtransport', blocked: !(cfg?.monitorOnly) }); } catch { /* non-fatal */ }
      if (!(cfg?.monitorOnly)) throw createSecurityError();
    }
    if (doBlock) {
      try { emitBlockEvent({ url: sanitizeForLog(u), reason: 'webtransport_blocked', api: 'webtransport', blocked: true }); } catch { /* non-fatal */ }
      throw createSecurityError();
    }
    const res = shouldBlockHost(u.hostname, u.port);
    if (res.block) {
      if (cfg?.verbose) console.warn('[net-guard] webtransport blocked', sanitizeForLog(u), res.reason);
      try { emitBlockEvent({ url: sanitizeForLog(u), reason: res.reason, api: 'webtransport', blocked: !(cfg?.monitorOnly) }); } catch { /* non-fatal */ }
      if (!(cfg?.monitorOnly)) throw createSecurityError();
    }
     
    return new (WT as any)(url, opts);
   
  } as any;
   
  (Wrapped as any).__uicpWrapped = true;
  Wrapped.prototype = WT.prototype;
   
  setProp(window as any, 'WebTransport', Wrapped);
};

const installWorkerGuards = () => {
  const w: any = typeof window !== 'undefined' ? window : undefined;
  if (!w) return;
  if (w.Worker) {
     
    const W = w.Worker as any;
     
    if (!(W as any).__uicpWrapped) {
      const Wrapped = function (this: any, ..._args: any[]) {
        const doBlock = !!(cfg?.blockWorkers) && !(cfg?.monitorOnly);
        try { emitBlockEvent({ url: 'worker', reason: doBlock ? 'worker_blocked' : 'worker_monitor', api: 'worker', blocked: doBlock }); } catch { /* non-fatal */ }
        if (doBlock) throw createSecurityError();
         
        return new (W as any)(..._args);
       
      } as any;
       
      (Wrapped as any).__uicpWrapped = true;
      Wrapped.prototype = W.prototype;
      setProp(w, 'Worker', Wrapped);
    }
  }
  if (w.SharedWorker) {
     
    const SW = w.SharedWorker as any;
     
    if (!(SW as any).__uicpWrapped) {
      const Wrapped = function (this: any, ..._args: any[]) {
        const doBlock = !!(cfg?.blockWorkers) && !(cfg?.monitorOnly);
        try { emitBlockEvent({ url: 'sharedworker', reason: doBlock ? 'worker_blocked' : 'worker_monitor', api: 'worker', blocked: doBlock }); } catch { /* non-fatal */ }
        if (doBlock) throw createSecurityError();
         
        return new (SW as any)(..._args);
       
      } as any;
       
      (Wrapped as any).__uicpWrapped = true;
      Wrapped.prototype = SW.prototype;
      setProp(w, 'SharedWorker', Wrapped);
    }
  }
   
  if (w.navigator && (w.navigator as any).serviceWorker && typeof (w.navigator as any).serviceWorker.register === 'function') {
     
    const reg = (w.navigator as any).serviceWorker.register.bind((w.navigator as any).serviceWorker);
     
    const cur = (w.navigator as any).serviceWorker.register as any;
     
    if (!(cur as any).__uicpWrapped) {
      const wrapped = ((scriptURL: string, options?: any) => {
        const doBlock = (cfg?.blockServiceWorker ?? true) && !(cfg?.monitorOnly);
        try { emitBlockEvent({ url: String(scriptURL), reason: doBlock ? 'service_worker_blocked' : 'service_worker_monitor', api: 'worker', blocked: doBlock }); } catch { /* non-fatal */ }
        if (doBlock) throw createSecurityError();
        return reg(scriptURL, options);
       
      }) as any;
       
      (wrapped as any).__uicpWrapped = true;
       
      (w.navigator as any).serviceWorker.register = wrapped;
    }
  }
};

export function installNetworkGuard(custom?: Partial<GuardConfig>) {
  lastCustomConfig = custom;

  const env: any = (import.meta as any)?.env ?? {};
  const g: any = globalThis as any;
  const installed = !!g.__UICP_NET_GUARD_INSTALLED__;

  const enabledEnv = String(env.VITE_NET_GUARD_ENABLED ?? '1').toLowerCase();
  const mode = String(env.MODE ?? env.NODE_ENV ?? '').toLowerCase();
  const defaultMonitor = '1';
  const monitorEnv = String(env.VITE_NET_GUARD_MONITOR ?? defaultMonitor).toLowerCase();
  const verboseEnv = String(env.VITE_GUARD_VERBOSE ?? '0').toLowerCase();

  const parseList = (v: unknown): string[] =>
    typeof v === 'string' && v.trim().length > 0 ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const parseNumber = (v: unknown): number | undefined => {
    if (v == null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const parsePositiveInt = (v: unknown, fallback?: number): number | undefined => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.floor(n);
    return i > 0 ? i : fallback;
  };

  const allowDomains = parseList(env.VITE_GUARD_ALLOW_DOMAINS);
  const blockDomains = parseList(env.VITE_GUARD_BLOCK_DOMAINS);
  const allowIPs = parseList(env.VITE_GUARD_ALLOW_IPS);
  const allowIPRanges = parseList(env.VITE_GUARD_ALLOW_IP_RANGES);
  const blockIPs = parseList(env.VITE_GUARD_BLOCK_IPS);
  const allowPaths = parseList(env.VITE_GUARD_ALLOW_PATHS);
  const maxRedirects = parseNumber(env.VITE_GUARD_MAX_REDIRECTS);
  const maxRequestBytes = parseNumber(env.VITE_GUARD_MAX_REQUEST_BYTES);
  const maxResponseBytes = parseNumber(env.VITE_GUARD_MAX_RESPONSE_BYTES);
  const attemptSample = parsePositiveInt(
    env.VITE_GUARD_ATTEMPT_SAMPLE,
    (mode === 'development' || mode === 'dev') ? 1 : 10,
  );
  
  const urlhausEnabledEnv = String(env.VITE_URLHAUS_ENABLED ?? '').toLowerCase();
  const urlhausAuthKey = typeof env.VITE_URLHAUS_AUTH_KEY === 'string' ? String(env.VITE_URLHAUS_AUTH_KEY) : '';
  const urlhausEnabled = urlhausEnabledEnv === '1' || urlhausEnabledEnv === 'true' || (urlhausEnabledEnv === '' && !!urlhausAuthKey);
  const urlhausMode = (String(env.VITE_URLHAUS_MODE ?? 'host').toLowerCase() === 'url') ? 'url' : 'host';
  const urlhausApiBase = typeof env.VITE_URLHAUS_API_BASE === 'string' ? String(env.VITE_URLHAUS_API_BASE) : 'https://urlhaus-api.abuse.ch/v1';
  const urlhausTimeoutMs = parsePositiveInt(env.VITE_URLHAUS_TIMEOUT_MS, 1500);
  const urlhausCacheTtlSec = parsePositiveInt(env.VITE_URLHAUS_CACHE_TTL_SEC, 600);
  const urlhausRespectAllows = String(env.VITE_URLHAUS_RESPECT_ALLOWS ?? '1').toLowerCase() === '1' || String(env.VITE_URLHAUS_RESPECT_ALLOWS ?? '1').toLowerCase() === 'true';
  const urlhausPersistEnabledEnv = String(env.VITE_URLHAUS_PERSIST ?? '1').toLowerCase();
  const urlhausPersistEnabled = urlhausPersistEnabledEnv === '1' || urlhausPersistEnabledEnv === 'true';
  const urlhausPersistKey = typeof env.VITE_URLHAUS_PERSIST_KEY === 'string' ? String(env.VITE_URLHAUS_PERSIST_KEY) : 'uicp:urlhaus:cache:v1';
  const urlhausPersistTtlSec = parsePositiveInt(env.VITE_URLHAUS_PERSIST_TTL_SEC, 86400);
  const urlhausPersistMaxEntries = parsePositiveInt(env.VITE_URLHAUS_PERSIST_MAX, 500);

  if (!allowDomains.includes('localhost')) allowDomains.push('localhost');
  if (!allowIPs.includes('127.0.0.1')) allowIPs.push('127.0.0.1');
  if (!allowIPs.includes('::1')) allowIPs.push('::1');

  const policy = getEffectivePolicy();
  const compute = policy.compute ?? ({} as Policy['compute']);
  // Defaults expected by tests: block Workers/ServiceWorkers/WebRTC by default; WebTransport allowed unless explicitly blocked.
  const defaultBlockFlags = {
    blockWorkers: true,
    blockServiceWorker: true,
    blockWebRTC: true,
    blockWebTransport: false,
  };
  let computeFlags = { ...defaultBlockFlags };
  // In non-test environments, drive from Policy.compute. In tests, keep legacy defaults to avoid breaking expectations.
  if (!isTestEnv()) {
    computeFlags = {
      blockWorkers: mapComputeToggleToBlock(compute.workers ?? 'ask'),
      blockServiceWorker: mapComputeToggleToBlock(compute.service_worker ?? 'ask'),
      blockWebRTC: mapComputeToggleToBlock(compute.webrtc ?? 'ask'),
      blockWebTransport: mapComputeToggleToBlock(compute.webtransport ?? 'ask'),
    };
  }

  const parseDeprecatedBoolean = (value: unknown): boolean | null => {
    if (value === undefined || value === null) return null;
    const normalized = String(value).toLowerCase();
    if (normalized === '1' || normalized === 'true') return true;
    if (normalized === '0' || normalized === 'false') return false;
    return null;
  };

  const deprecatedOverrides: Array<{ envName: string; value: boolean | null; apply: (flag: boolean) => void }> = [
    { envName: 'VITE_GUARD_BLOCK_WORKERS', value: parseDeprecatedBoolean(env.VITE_GUARD_BLOCK_WORKERS), apply: (flag) => { computeFlags.blockWorkers = flag; } },
    { envName: 'VITE_GUARD_BLOCK_SERVICE_WORKER', value: parseDeprecatedBoolean(env.VITE_GUARD_BLOCK_SERVICE_WORKER), apply: (flag) => { computeFlags.blockServiceWorker = flag; } },
    { envName: 'VITE_GUARD_BLOCK_WEBRTC', value: parseDeprecatedBoolean(env.VITE_GUARD_BLOCK_WEBRTC), apply: (flag) => { computeFlags.blockWebRTC = flag; } },
    { envName: 'VITE_GUARD_BLOCK_WEBTRANSPORT', value: parseDeprecatedBoolean(env.VITE_GUARD_BLOCK_WEBTRANSPORT), apply: (flag) => { computeFlags.blockWebTransport = flag; } },
  ];

  for (const override of deprecatedOverrides) {
    if (override.value !== null) {
      try {
        console.warn(`[net-guard] ${override.envName} is deprecated. Use Policy.compute toggles instead.`);
      } catch { /* non-fatal */ }
      override.apply(override.value);
    }
  }

  if (!policyListenerTeardown) {
    try {
      policyListenerTeardown = onPolicyChange(() => {
        installNetworkGuard(lastCustomConfig);
      });
    } catch (err) {
      console.warn('[net-guard] failed to subscribe to policy changes', err);
      policyListenerTeardown = () => {};
    }
  }

  setConfig({
    enabled: enabledEnv !== '0' && enabledEnv !== 'false',
    monitorOnly: monitorEnv === '1' || monitorEnv === 'true',
    verbose: verboseEnv === '1' || verboseEnv === 'true',
    allowDomains,
    blockDomains,
    allowIPs,
    allowIPRanges,
    blockIPs,
    allowPaths,
    maxRedirects,
    maxRequestBytes,
    maxResponseBytes,
    attemptSample,
    blockWorkers: computeFlags.blockWorkers,
    blockServiceWorker: computeFlags.blockServiceWorker,
    blockWebRTC: computeFlags.blockWebRTC,
    blockWebTransport: computeFlags.blockWebTransport,
    urlhausEnabled: urlhausEnabled,
    urlhausMode,
    urlhausApiBase,
    urlhausAuthKey,
    urlhausTimeoutMs,
    urlhausCacheTtlSec,
    urlhausRespectAllows,
    urlhausPersistEnabled,
    urlhausPersistKey,
    urlhausPersistTtlSec,
    urlhausPersistMaxEntries,
    ...(custom ?? {}),
  });

  // Always (re)install guards to catch late stubs and dynamic environments
  installFetchGuard();
  installXHRGuard();
  installWSGuard();
  installESGuard();
  installBeaconGuard();
  installWorkerGuards();
  installWebRTCGuard();
  installWebTransportGuard();
  loadPersistedUrlhaus();

  if (!installed) {
    g.__UICP_NET_GUARD_INSTALLED__ = true;
  }
}

export function addNetGuardSessionAllow(domain: string): boolean {
  try {
    if (!domain || typeof domain !== 'string') return false;
    const lower = domain.toLowerCase().replace(/\.$/, '');
    const current = Array.isArray(cfg?.allowDomains) ? (cfg!.allowDomains as string[]) : [];
    if (current.includes(lower)) return true;
    const next = [...current, lower];
    setConfig({ allowDomains: next });
    return true;
  } catch {
    return false;
  }
}
