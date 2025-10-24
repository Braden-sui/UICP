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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p: any = typeof process !== 'undefined' ? process : undefined;
    if (p && p.env && (p.env.VITEST || p.env.NODE_ENV === 'test')) return true;
  } catch {}
  try {
    // Vite-style import.meta.env
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ie: any = (import.meta as any)?.env;
    if (ie && (ie.MODE === 'test' || ie.VITEST)) return true;
  } catch {}
  return false;
};

const setProp = (obj: any, key: string, value: any) => {
  try {
    Object.defineProperty(obj, key, {
      value,
      configurable: true, // allow test envs/jsdom teardown to delete
      writable: isTestEnv(), // allow mutation in tests; prevent in prod
      enumerable: false,
    });
  } catch {
    try { obj[key] = value; } catch {}
  }
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
  } catch {}
  return null;
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

const emitBlockEvent = (detail: { url: string; reason?: string; method?: string; api: 'fetch' | 'xhr' | 'ws' | 'sse' | 'beacon' | 'webrtc' | 'webtransport' | 'worker'; blocked: boolean }) => {
  try {
    const w: any = typeof window !== 'undefined' ? window : undefined;
    if (!w || typeof w.dispatchEvent !== 'function' || typeof (w as any).CustomEvent !== 'function') return;
    const ev = new (w as any).CustomEvent('net-guard-block', { detail });
    w.dispatchEvent(ev);
  } catch {}
};

const emitAttemptEvent = (detail: { url: string; method?: string; api: 'fetch' | 'xhr' | 'ws' | 'sse' | 'beacon' }) => {
  try {
    const w: any = typeof window !== 'undefined' ? window : undefined;
    if (!w || typeof w.dispatchEvent !== 'function' || typeof (w as any).CustomEvent !== 'function') return;
    const ev = new (w as any).CustomEvent('net-guard-attempt', { detail });
    w.dispatchEvent(ev);
  } catch {}
};

const maybeEmitAttempt = (api: 'fetch' | 'xhr' | 'ws' | 'sse' | 'beacon', url: string, method?: string) => {
  try {
    const sample = cfg?.attemptSample;
    if (!sample || sample <= 0) return;
    if (sample === 1 || Math.floor(Math.random() * sample) === 0) {
      emitAttemptEvent({ api, url, method });
    }
  } catch {}
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
    if (!(cfg.allowIPs && cfg.allowIPs.includes(lower))) {
      if (isIp4) {
        if (privateBlockIPv4Cidrs.some((c) => ipInCidrV4(lower, c))) return { block: true, reason: 'ip_private' };
        if (defaultBlockIPsExact.has(lower) || (cfg.blockIPs ?? []).includes(lower)) return { block: true, reason: 'ip_exact' };
        if (defaultBlockIPv4Cidrs.some((c) => ipInCidrV4(lower, c))) return { block: true, reason: 'ip_cidr' };
      } else {
        if (defaultBlockIPsExact.has(lower) || (cfg.blockIPs ?? []).includes(lower)) return { block: true, reason: 'ip_v6' };
        if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) return { block: true, reason: 'ip_v6_private' };
      }
      return { block: true, reason: 'ip_literal' };
    }
  }

  return { block: false };
};

const makeBlockResponse = (url: string, reason?: string): Response => {
  const body = JSON.stringify({ ok: false, blocked: true, reason: reason ?? 'policy', url });
  return new Response(body, { status: 403, headers: { 'content-type': 'application/json' } });
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
  const wrapper = (input: any, init?: RequestInit) => {
    try {
      const url = toUrl(input);
      const scheme = url.protocol.replace(/:$/, '');
      maybeEmitAttempt('fetch', sanitizeForLog(url), (init as any)?.method || (input?.method ?? 'GET'));
      if (scheme === 'blob' || scheme === 'data') {
        return orig(input, init);
      }
      if (scheme === 'file' || scheme === 'filesystem') {
        if (cfg?.verbose) console.warn('[net-guard] fetch blocked (scheme)', sanitizeForLog(url), 'scheme_forbidden');
        emitBlockEvent({ url: sanitizeForLog(url), reason: 'scheme_forbidden', method: (init as any)?.method || (input?.method ?? 'GET'), api: 'fetch', blocked: !(cfg?.monitorOnly) });
        if (cfg?.monitorOnly) return orig(input, init);
        return Promise.resolve(makeBlockResponse(sanitizeForLog(url), 'scheme_forbidden'));
      }
      // Path allowlist (optional)
      if (!pathAllowed(url)) {
        if (cfg?.verbose) console.warn('[net-guard] fetch blocked (path)', sanitizeForLog(url), 'path_forbidden');
        emitBlockEvent({ url: sanitizeForLog(url), reason: 'path_forbidden', method: (init as any)?.method || (input?.method ?? 'GET'), api: 'fetch', blocked: !(cfg?.monitorOnly) });
        if (cfg?.monitorOnly) return orig(input, init);
        return Promise.resolve(makeBlockResponse(sanitizeForLog(url), 'path_forbidden'));
      }
      // Request payload cap (best-effort)
      const method = String((init as any)?.method || (input?.method ?? 'GET')).toUpperCase();
      if (cfg?.maxRequestBytes && method !== 'GET') {
        const len = getBodyLength((init as any)?.body ?? (input as any)?.body);
        if (len != null && len > (cfg.maxRequestBytes as number)) {
          if (cfg?.verbose) console.warn('[net-guard] fetch blocked (payload_too_large)', sanitizeForLog(url), len);
          emitBlockEvent({ url: sanitizeForLog(url), reason: 'payload_too_large', method, api: 'fetch', blocked: !(cfg?.monitorOnly) });
          if (cfg?.monitorOnly) return orig(input, init);
          const body = JSON.stringify({ ok: false, blocked: true, reason: 'payload_too_large', url: sanitizeForLog(url) });
          return Promise.resolve(new Response(body, { status: 413, headers: { 'content-type': 'application/json' } }));
        }
      }
      const res = shouldBlockHost(url.hostname, url.port);
      if (res.block) {
        if (cfg?.verbose) console.warn('[net-guard] fetch blocked', sanitizeForLog(url), res.reason);
        emitBlockEvent({ url: sanitizeForLog(url), reason: res.reason, method: (init as any)?.method || (input?.method ?? 'GET'), api: 'fetch', blocked: !(cfg?.monitorOnly) });
        if (cfg?.monitorOnly) return orig(input, init);
        return Promise.resolve(makeBlockResponse(sanitizeForLog(url), res.reason));
      }
    } catch {}
    const startedUrl = (() => { try { return sanitizeForLog(toUrl(input)); } catch { return String(input); } })();
    const p = orig(input, init);
    // Post-response checks (redirects and content-length)
    if (!cfg) return p;
    const wantsRedirectCheck = typeof cfg.maxRedirects === 'number';
    const wantsSizeCheck = typeof cfg.maxResponseBytes === 'number';
    if (!wantsRedirectCheck && !wantsSizeCheck) return p;
    return p.then((res: Response) => {
      try {
        if (wantsRedirectCheck && (cfg!.maxRedirects as number) === 0 && res.redirected) {
          if (cfg?.verbose) console.warn('[net-guard] fetch blocked (redirect_exceeded)', startedUrl);
          emitBlockEvent({ url: startedUrl, reason: 'redirect_exceeded', method: (init as any)?.method || (input?.method ?? 'GET'), api: 'fetch', blocked: !(cfg?.monitorOnly) });
          if (!(cfg?.monitorOnly)) {
            const body = JSON.stringify({ ok: false, blocked: true, reason: 'redirect_exceeded', url: startedUrl });
            return new Response(body, { status: 470, headers: { 'content-type': 'application/json' } });
          }
        }
        if (wantsSizeCheck) {
          const clHeader = res.headers.get('content-length');
          const cl = clHeader ? Number(clHeader) : NaN;
          if (Number.isFinite(cl) && cl > (cfg!.maxResponseBytes as number)) {
            if (cfg?.verbose) console.warn('[net-guard] fetch blocked (response_too_large)', startedUrl, cl);
            emitBlockEvent({ url: startedUrl, reason: 'response_too_large', method: (init as any)?.method || (input?.method ?? 'GET'), api: 'fetch', blocked: !(cfg?.monitorOnly) });
            if (!(cfg?.monitorOnly)) {
              const body = JSON.stringify({ ok: false, blocked: true, reason: 'response_too_large', url: startedUrl });
              return new Response(body, { status: 413, headers: { 'content-type': 'application/json' } });
            }
          }
        }
      } catch {}
      return res;
    });
  };
  (wrapper as any).__uicpWrapped = true;
  // Wrap both window and global fetch if present
  try { if (win) setProp(win, 'fetch', wrapper); } catch {}
  try { if (hasGlobalFetch) setProp(g, 'fetch', wrapper); } catch {}
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
  } catch {}
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
  try { Object.defineProperty(XHR.prototype, 'open', { value: wrapped, configurable: true, writable: isTestEnv() }); } catch {}
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
        } catch {}
        const fn = (this as any).__uicpOrigSend || proto.__uicpOrigSend || proto.send;
        return fn.apply(this, arguments as any);
      } as any;
      try { Object.defineProperty(proto, 'send', { value: sendWrapped, configurable: true, writable: isTestEnv() }); } catch { proto.send = sendWrapped; }
    }
  } catch {}
};

const installWSGuard = () => {
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
      if (!(cfg?.monitorOnly)) throw new DOMException('Blocked by Network Guard', 'SecurityError');
    }
    if (!pathAllowed(u)) {
      if (cfg?.verbose) console.warn('[net-guard] ws blocked (path)', sanitizeForLog(u), 'path_forbidden');
      emitBlockEvent({ url: sanitizeForLog(u), reason: 'path_forbidden', api: 'ws', blocked: !(cfg?.monitorOnly) });
      if (!(cfg?.monitorOnly)) throw new DOMException('Blocked by Network Guard', 'SecurityError');
    }
    const res = shouldBlockHost(u.hostname, u.port);
    if (res.block) {
      if (cfg?.verbose) console.warn('[net-guard] ws blocked', sanitizeForLog(u), res.reason);
      emitBlockEvent({ url: sanitizeForLog(u), reason: res.reason, api: 'ws', blocked: !(cfg?.monitorOnly) });
      if (!(cfg?.monitorOnly)) throw new DOMException('Blocked by Network Guard', 'SecurityError');
    }
    return new WS(url as any, protocols as any) as any;
  } as any;
  (Wrapped as any).__uicpWrapped = true;
  Wrapped.prototype = WS.prototype;
  setProp(window as any, 'WebSocket', Wrapped);
};

const installESGuard = () => {
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
      if (!(cfg?.monitorOnly)) throw new DOMException('Blocked by Network Guard', 'SecurityError');
    }
    if (!pathAllowed(u)) {
      if (cfg?.verbose) console.warn('[net-guard] es blocked (path)', sanitizeForLog(u), 'path_forbidden');
      emitBlockEvent({ url: sanitizeForLog(u), reason: 'path_forbidden', api: 'sse', blocked: !(cfg?.monitorOnly) });
      if (!(cfg?.monitorOnly)) throw new DOMException('Blocked by Network Guard', 'SecurityError');
    }
    const res = shouldBlockHost(u.hostname, u.port);
    if (res.block) {
      if (cfg?.verbose) console.warn('[net-guard] es blocked', sanitizeForLog(u), res.reason);
      emitBlockEvent({ url: sanitizeForLog(u), reason: res.reason, api: 'sse', blocked: !(cfg?.monitorOnly) });
      if (!(cfg?.monitorOnly)) throw new DOMException('Blocked by Network Guard', 'SecurityError');
    }
    return new ES(url as any, eventSourceInitDict) as any;
  } as any;
  (Wrapped as any).__uicpWrapped = true;
  Wrapped.prototype = ES.prototype;
  setProp(window as any, 'EventSource', Wrapped);
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
    } catch {}
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
        try { emitBlockEvent({ url: 'webrtc:iceservers', reason: doBlock ? 'webrtc_blocked' : 'webrtc_monitor', api: 'webrtc', blocked: doBlock }); } catch {}
        if (doBlock) throw new DOMException('Blocked by Network Guard', 'SecurityError');
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
      try { emitBlockEvent({ url: sanitizeForLog(u), reason: 'scheme_forbidden', api: 'webtransport', blocked: !(cfg?.monitorOnly) }); } catch {}
      if (!(cfg?.monitorOnly)) throw new DOMException('Blocked by Network Guard', 'SecurityError');
    }
    if (doBlock) {
      try { emitBlockEvent({ url: sanitizeForLog(u), reason: 'webtransport_blocked', api: 'webtransport', blocked: true }); } catch {}
      throw new DOMException('Blocked by Network Guard', 'SecurityError');
    }
    const res = shouldBlockHost(u.hostname, u.port);
    if (res.block) {
      if (cfg?.verbose) console.warn('[net-guard] webtransport blocked', sanitizeForLog(u), res.reason);
      try { emitBlockEvent({ url: sanitizeForLog(u), reason: res.reason, api: 'webtransport', blocked: !(cfg?.monitorOnly) }); } catch {}
      if (!(cfg?.monitorOnly)) throw new DOMException('Blocked by Network Guard', 'SecurityError');
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
        try { emitBlockEvent({ url: 'worker', reason: doBlock ? 'worker_blocked' : 'worker_monitor', api: 'worker', blocked: doBlock }); } catch {}
        if (doBlock) throw new DOMException('Blocked by Network Guard', 'SecurityError');
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
        try { emitBlockEvent({ url: 'sharedworker', reason: doBlock ? 'worker_blocked' : 'worker_monitor', api: 'worker', blocked: doBlock }); } catch {}
        if (doBlock) throw new DOMException('Blocked by Network Guard', 'SecurityError');
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
        try { emitBlockEvent({ url: String(scriptURL), reason: doBlock ? 'service_worker_blocked' : 'service_worker_monitor', api: 'worker', blocked: doBlock }); } catch {}
        if (doBlock) throw new DOMException('Blocked by Network Guard', 'SecurityError');
        return reg(scriptURL, options);
      }) as any;
      (wrapped as any).__uicpWrapped = true;
      (w.navigator as any).serviceWorker.register = wrapped;
    }
  }
};

export function installNetworkGuard(custom?: Partial<GuardConfig>) {
  const env: any = (import.meta as any)?.env ?? {};
  const g: any = globalThis as any;
  const installed = !!g.__UICP_NET_GUARD_INSTALLED__;
  const enabledEnv = String(env.VITE_NET_GUARD_ENABLED ?? '1').toLowerCase();
  const mode = String(env.MODE ?? env.NODE_ENV ?? '').toLowerCase();
  const defaultMonitor = (mode === 'development' || mode === 'dev') ? '1' : '0';
  const monitorEnv = String(env.VITE_NET_GUARD_MONITOR ?? defaultMonitor).toLowerCase();
  const verboseEnv = String(env.VITE_GUARD_VERBOSE ?? '0').toLowerCase();
  const blockWorkersEnv = String(env.VITE_GUARD_BLOCK_WORKERS ?? '1').toLowerCase();
  const blockSWEnv = String(env.VITE_GUARD_BLOCK_SERVICE_WORKER ?? '1').toLowerCase();
  const blockRtcEnv = String(env.VITE_GUARD_BLOCK_WEBRTC ?? '1').toLowerCase();
  const blockWtEnv = String(env.VITE_GUARD_BLOCK_WEBTRANSPORT ?? '1').toLowerCase();
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
  if (!allowDomains.includes('localhost')) allowDomains.push('localhost');
  if (!allowIPs.includes('127.0.0.1')) allowIPs.push('127.0.0.1');
  if (!allowIPs.includes('::1')) allowIPs.push('::1');
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
    blockWorkers: blockWorkersEnv === '1' || blockWorkersEnv === 'true',
    blockServiceWorker: blockSWEnv === '1' || blockSWEnv === 'true',
    blockWebRTC: blockRtcEnv === '1' || blockRtcEnv === 'true',
    blockWebTransport: blockWtEnv === '1' || blockWtEnv === 'true',
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
  if (!installed) {
    g.__UICP_NET_GUARD_INSTALLED__ = true;
  }
}
