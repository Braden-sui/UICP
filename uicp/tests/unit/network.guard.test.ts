import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  installNetworkGuard,
  retryBlockedFetch,
  setInteractiveGuardRemediation,
  type GuardBlockPayload,
  type BlockEventDetail,
} from '../../src/lib/security/networkGuard';

const getJSON = async (res: Response) => JSON.parse(await res.text());

declare global {
  interface Window {
    WebSocket: any;
    EventSource: any;
  }
}

describe('NetworkGuard (in-app egress)', () => {
  const orig = {
    fetch: globalThis.fetch,
    XMLHttpRequest: (globalThis as any).XMLHttpRequest,
    WebSocket: (globalThis as any).window?.WebSocket ?? (globalThis as any).WebSocket,
    EventSource: (globalThis as any).window?.EventSource ?? (globalThis as any).EventSource,
    sendBeacon: (globalThis as any).navigator?.sendBeacon,
  } as const;

  beforeEach(() => {
    // Ensure window exists for guards that attach to window.*
    if (!(globalThis as any).window) {
      (globalThis as any).window = {} as any;
    }
    // Event system stubs for CustomEvent-based notifications
    const listeners: Record<string, Array<(e: any) => void>> = {};
    (globalThis as any).window.addEventListener = (type: string, cb: (e: any) => void) => {
      (listeners[type] = listeners[type] || []).push(cb);
    };
    (globalThis as any).window.dispatchEvent = (ev: any) => {
      const arr = listeners[ev?.type] || [];
      for (const fn of arr) fn(ev);
      return true;
    };
    if (!(globalThis as any).window.CustomEvent) {
      (globalThis as any).window.CustomEvent = function (this: any, type: string, init?: any) {
        this.type = type;
        this.detail = init?.detail;
      } as any;
    }

    // Stub underlying fetch for the guard using test hook
    (globalThis as any).__UICP_TEST_FETCH__ = (input: any) => {
      const url = typeof input === 'string' ? input : (input?.url ?? '');
      return Promise.resolve(new Response(JSON.stringify({ ok: true, url }), { status: 200, headers: { 'content-type': 'application/json' } }));
    };

    // Stub XHR
    class XHRStub {
      public lastOpen?: { method: string; url: string };
      open(method: string, url: string) {
        this.lastOpen = { method, url };
      }
    }
    (globalThis as any).XMLHttpRequest = XHRStub as any;
    (globalThis as any).window.XMLHttpRequest = XHRStub as any;

    // Stub WebSocket
    class WSStub {
      public url: string;
      constructor(url: string) {
        this.url = typeof url === 'string' ? url : String(url);
      }
    }
    (globalThis as any).WebSocket = WSStub as any;
    (globalThis as any).window.WebSocket = WSStub as any;

    // Stub EventSource
    class ESStub {
      public url: string;
      constructor(url: string) {
        this.url = typeof url === 'string' ? url : String(url);
      }
    }
    (globalThis as any).EventSource = ESStub as any;
    (globalThis as any).window.EventSource = ESStub as any;

    // Stub sendBeacon
    if (!(globalThis as any).navigator) {
      (globalThis as any).navigator = {} as any;
    }
    (globalThis as any).navigator.sendBeacon = (_url: string) => true;
    (globalThis as any).window.navigator = (globalThis as any).navigator;
  });

  afterEach(() => {
    try { (globalThis as any).fetch = orig.fetch; } catch {}
    delete (globalThis as any).__UICP_TEST_FETCH__;
    (globalThis as any).XMLHttpRequest = orig.XMLHttpRequest;
    if (orig.WebSocket) (globalThis as any).WebSocket = orig.WebSocket;
    if (orig.EventSource) (globalThis as any).EventSource = orig.EventSource;
    if (orig.sendBeacon) (globalThis as any).navigator.sendBeacon = orig.sendBeacon;
  });

  it('blocks metadata IPv4 via fetch', async () => {
    installNetworkGuard({ enabled: true, monitorOnly: false, verbose: true });
    const res = await fetch('http://169.254.169.254/latest/meta-data');
    expect(res.status).toBe(403);
    const json = await getJSON(res);
    expect(json.blocked).toBe(true);
  });

  it('allows normal fetch to example.com', async () => {
    installNetworkGuard({ enabled: true, monitorOnly: false });
    const res = await fetch('https://example.com/');
    expect(res.status).toBe(200);
    const json = await getJSON(res);
    expect(json.ok).toBe(true);
  });

  it('blocks DoH domain via fetch (dns.google)', async () => {
    installNetworkGuard({ enabled: true, monitorOnly: false });
    const res = await fetch('https://dns.google/dns-query');
    expect(res.status).toBe(403);
    const json = await getJSON(res);
    expect(json.blocked).toBe(true);
  });

  it('blocks port 853 via fetch', async () => {
    installNetworkGuard({ enabled: true, monitorOnly: false });
    const res = await fetch('https://example.com:853/whatever');
    expect(res.status).toBe(403);
    const json = await getJSON(res);
    expect(json.blocked).toBe(true);
  });

  it('monitorOnly does not block but still evaluates policy', async () => {
    installNetworkGuard({ enabled: true, monitorOnly: true, verbose: true });
    const res = await fetch('https://dns.google/dns-query');
    expect(res.status).toBe(200);
    const json = await getJSON(res);
    expect(json.ok).toBe(true);
  });

  it('XMLHttpRequest.open throws on blocked host', () => {
    installNetworkGuard({ enabled: true, monitorOnly: false });
    const xhr = new (globalThis as any).XMLHttpRequest();
    expect(() => xhr.open('GET', 'https://cloudflare-dns.com/dns-query')).toThrowError();
  });

  it('XMLHttpRequest.open passes through on allowed host', () => {
    installNetworkGuard({ enabled: true, monitorOnly: false });
    const xhr = new (globalThis as any).XMLHttpRequest();
    xhr.open('GET', 'https://example.com/');
    expect(xhr.lastOpen.url).toContain('example.com');
  });

  it('WebSocket is blocked for DoH domain', () => {
    installNetworkGuard({ enabled: true, monitorOnly: false });
    expect(() => new (globalThis as any).WebSocket('wss://dns.google/dns-query')).toThrowError();
  });

  it('WebSocket connects for allowed host', () => {
    installNetworkGuard({ enabled: true, monitorOnly: false });
    const ws = new (globalThis as any).WebSocket('wss://example.com/socket');
    expect(ws.url).toContain('example.com');
  });

  it('EventSource is blocked for DoH domain', () => {
    installNetworkGuard({ enabled: true, monitorOnly: false });
    expect(() => new (globalThis as any).EventSource('https://nextdns.io/events')).toThrowError();
  });

  it('sendBeacon returns false when blocked', () => {
    installNetworkGuard({ enabled: true, monitorOnly: false });
    const ok = (globalThis as any).navigator.sendBeacon('https://dns.google/upload');
    expect(ok).toBe(false);
  });

  it('allows loopback fetch: localhost, 127.0.0.1, ::1', async () => {
    installNetworkGuard({ enabled: true, monitorOnly: false });
    const r1 = await fetch('http://localhost:3000/api');
    expect(r1.status).toBe(200);
    const r2 = await fetch('http://127.0.0.1/api');
    expect(r2.status).toBe(200);
    const r3 = await fetch('http://[::1]/api');
    expect(r3.status).toBe(200);
  });

  it('allows XHR/WS/SSE/beacon to localhost', () => {
    installNetworkGuard({ enabled: true, monitorOnly: false });
    const xhr = new (globalThis as any).XMLHttpRequest();
    xhr.open('GET', 'https://localhost/test');
    expect(xhr.lastOpen.url).toContain('localhost');

    const ws = new (globalThis as any).WebSocket('wss://localhost/socket');
    expect(ws.url).toContain('localhost');

    const es = new (globalThis as any).EventSource('https://localhost/events');
    expect(es.url).toContain('localhost');

    const ok = (globalThis as any).navigator.sendBeacon('https://localhost/beacon');
    expect(ok).toBe(true);
  });

  it('blocks RFC1918 IP literal via fetch and emits structured event', async () => {
    const events: Array<{ payload?: GuardBlockPayload; url: string; reason?: string }> = [];
    (globalThis as any).window.addEventListener('net-guard-block', (e: CustomEvent<BlockEventDetail>) => events.push(e.detail));
    installNetworkGuard({ enabled: true, monitorOnly: false });
    const res = await fetch('http://192.168.1.10/api');
    expect(res.status).toBe(403);
    const json = await getJSON(res);
    expect(json.blocked).toBe(true);
    expect(events.some((d) => d && d.payload?.context?.api === 'fetch' && d.payload?.blocked === true)).toBe(true);
    const detail = events.find((d) => d?.payload?.context?.api === 'fetch');
    expect(detail?.payload?.actions).toContain('allow_once');
    expect(detail?.payload?.how_to_fix).toBeDefined();
  });

  it('registers retry for blocked fetch and resolves on retry', async () => {
    const events: BlockEventDetail[] = [];
    (globalThis as any).window.addEventListener('net-guard-block', (e: CustomEvent<BlockEventDetail>) => events.push(e.detail));
    setInteractiveGuardRemediation(true);
    let attempt = 0;
    (globalThis as any).__UICP_TEST_FETCH__ = (input: any) => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.reject(new Error('should not hit original fetch')); // guard intercepts before
      }
      const url = typeof input === 'string' ? input : (input?.url ?? '');
      return Promise.resolve(new Response(JSON.stringify({ ok: true, url }), { status: 200, headers: { 'content-type': 'application/json' } }));
    };
    installNetworkGuard({ enabled: true, monitorOnly: false, allowDomains: [] });
    const blockedPromise = fetch('http://169.254.169.254/metadata');
    // Allow microtask queue to process retry registration
    await Promise.resolve();
    expect(events.length).toBeGreaterThan(0);
    const detail = events[0];
    expect(detail.blocked).toBe(true);
    expect(detail.retryId).toBeTruthy();
    // Retry should resolve to successful response
    const retried = await retryBlockedFetch(detail.retryId!);
    expect(retried).toBe(true);
    const res = await blockedPromise;
    expect(res.status).toBe(200);
    const json = await getJSON(res);
    expect(json.ok).toBe(true);
    setInteractiveGuardRemediation(false);
  });

  it('allows explicitly allow-listed IP literal', async () => {
    installNetworkGuard({ enabled: true, monitorOnly: false, allowIPs: ['192.168.1.10'] });
    const res = await fetch('http://192.168.1.10/api');
    expect(res.status).toBe(200);
    const json = await getJSON(res);
    expect(json.ok).toBe(true);
  });

  it('allows IPv4 CIDR range via allowIPRanges', async () => {
    installNetworkGuard({ enabled: true, monitorOnly: false, allowIPRanges: ['192.168.0.0/16'] });
    const res = await fetch('http://192.168.100.42/api');
    expect(res.status).toBe(200);
    const json = await getJSON(res);
    expect(json.ok).toBe(true);
  });

  it('WebRTC blocked by default when STUN/TURN present', () => {
    class PCStub { constructor(_cfg?: any) {} }
    (globalThis as any).window.RTCPeerConnection = PCStub as any;
    installNetworkGuard({ enabled: true, monitorOnly: false });
    expect(() => new (globalThis as any).window.RTCPeerConnection({ iceServers: [{ urls: ['stun:exfil.local'] }] })).toThrowError();
  });

  it('WebRTC blocked when blockWebRTC=true and STUN/TURN present', () => {
    class PCStub { constructor(_cfg?: any) {} }
    (globalThis as any).window.RTCPeerConnection = PCStub as any;
    installNetworkGuard({ enabled: true, monitorOnly: false, blockWebRTC: true });
    expect(() => new (globalThis as any).window.RTCPeerConnection({ iceServers: [{ urls: ['turn:exfil.local'] }] })).toThrowError();
  });

  it('WebTransport blocks DoH host', () => {
    class WTStub { public url: string; constructor(url: string) { this.url = url; } }
    (globalThis as any).window.WebTransport = WTStub as any;
    installNetworkGuard({ enabled: true, monitorOnly: false });
    expect(() => new (globalThis as any).window.WebTransport('https://dns.google/dns-query')).toThrowError();
  });

  it('WebTransport blocks all when blockWebTransport=true even for allowed host', () => {
    class WTStub { public url: string; constructor(url: string) { this.url = url; } }
    (globalThis as any).window.WebTransport = WTStub as any;
    installNetworkGuard({ enabled: true, monitorOnly: false, blockWebTransport: true });
    expect(() => new (globalThis as any).window.WebTransport('https://example.com/transport')).toThrowError();
  });

  it('Worker constructor is blocked by default', () => {
    class WorkerStub { constructor(_s: string) {} }
    (globalThis as any).window.Worker = WorkerStub as any;
    installNetworkGuard({ enabled: true, monitorOnly: false });
    expect(() => new (globalThis as any).window.Worker('foo.js')).toThrowError();
  });

  it('Worker constructor is blocked when blockWorkers=true', () => {
    class WorkerStub { constructor(_s: string) {} }
    (globalThis as any).window.Worker = WorkerStub as any;
    installNetworkGuard({ enabled: true, monitorOnly: false, blockWorkers: true });
    expect(() => new (globalThis as any).window.Worker('foo.js')).toThrowError();
  });

  it('ServiceWorker register is blocked by default', () => {
    (globalThis as any).navigator.serviceWorker = { register: (_u: string) => Promise.resolve({ ok: true }) };
    installNetworkGuard({ enabled: true, monitorOnly: false });
    expect(() => (globalThis as any).navigator.serviceWorker.register('/sw.js')).toThrowError();
  });

  it('ServiceWorker register allowed when blockServiceWorker=false', async () => {
    (globalThis as any).navigator.serviceWorker = { register: (_u: string) => Promise.resolve({ ok: true }) };
    installNetworkGuard({ enabled: true, monitorOnly: false, blockServiceWorker: false });
    const res = await (globalThis as any).navigator.serviceWorker.register('/sw.js');
    expect(res).toBeTruthy();
  });

  it('path allowlist permits only configured prefixes', async () => {
    installNetworkGuard({ enabled: true, monitorOnly: false, allowPaths: ['/ok', '/api/v1'] });
    const ok1 = await fetch('https://example.com/ok/resource');
    expect(ok1.status).toBe(200);
    const ok2 = await fetch('https://example.com/api/v1/items');
    expect(ok2.status).toBe(200);
    const blocked = await fetch('https://example.com/deny/here');
    expect(blocked.status).toBe(403);
    const json = await getJSON(blocked);
    expect(json.reason).toBe('path_forbidden');
  });

  it('fetch blocks payload larger than maxRequestBytes', async () => {
    installNetworkGuard({ enabled: true, monitorOnly: false, maxRequestBytes: 4 });
    const small = await fetch('https://example.com/ok', { method: 'POST', body: '1234' });
    expect(small.status).toBe(200);
    const big = await fetch('https://example.com/ok', { method: 'POST', body: '12345' });
    expect(big.status).toBe(413);
    const json = await getJSON(big);
    expect(json.reason).toBe('payload_too_large');
  });

  it('XMLHttpRequest.send blocks payload larger than maxRequestBytes', () => {
    installNetworkGuard({ enabled: true, monitorOnly: false, maxRequestBytes: 2 });
    const xhr = new (globalThis as any).XMLHttpRequest();
    xhr.open('POST', 'https://example.com/ok');
    expect(() => xhr.send('123')).toThrowError();
  });

  it('sendBeacon blocks payload larger than maxRequestBytes', () => {
    installNetworkGuard({ enabled: true, monitorOnly: false, maxRequestBytes: 3 });
    const ok = (globalThis as any).navigator.sendBeacon('https://example.com/ok', '123');
    expect(ok).toBe(true);
    const blocked = (globalThis as any).navigator.sendBeacon('https://example.com/ok', '1234');
    expect(blocked).toBe(false);
  });

  it('fetch blocks when response content-length exceeds maxResponseBytes', async () => {
    // Override test fetch to emit a large content-length. Must be set BEFORE guard install.
    (globalThis as any).__UICP_TEST_FETCH__ = (_input: any) => {
      return Promise.resolve(new Response('ok', { status: 200, headers: { 'content-length': '10000', 'content-type': 'text/plain' } }));
    };
    installNetworkGuard({ enabled: true, monitorOnly: false, maxResponseBytes: 1024 });
    const res = await fetch('https://example.com/ok');
    expect(res.status).toBe(413);
    const json = await getJSON(res);
    expect(json.reason).toBe('response_too_large');
  });
});
