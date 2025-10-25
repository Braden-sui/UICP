import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installNetworkGuard } from '../../src/lib/security/networkGuard';
import { setRuntimePolicy } from '../../src/lib/security/policyLoader';
import { Presets } from '../../src/lib/security/presets';

const OK_JSON = { ok: true };

const makeOkResponse = () => new Response(JSON.stringify(OK_JSON), { status: 200, headers: { 'content-type': 'application/json' } });

const parseBlock = async (res: Response) => {
  const text = await res.text();
  try { return JSON.parse(text) as { ok: boolean; blocked?: boolean; reason?: string }; } catch { return { ok: false }; }
};

describe('network guard IPv6 CIDR detection', () => {
  const origTestFetch = (globalThis as any).__UICP_TEST_FETCH__;

  beforeEach(() => {
    // Stub test fetch so guard will use it and we avoid real network
    (globalThis as any).__UICP_TEST_FETCH__ = async () => makeOkResponse();
  });

  afterEach(() => {
    (globalThis as any).__UICP_TEST_FETCH__ = origTestFetch;
  });

  it('blocks fc00::/7 and fe80::/10 when private LAN is denied', async () => {
    setRuntimePolicy({ ...Presets.open, network: { ...Presets.open.network, allow_private_lan: 'deny', allow_ip_literals: true, https_only: false } });
    installNetworkGuard({ enabled: true, monitorOnly: false });

    // Unique Local Address
    const r1 = await fetch('http://[fc00::1]/');
    expect(r1.status).toBe(403);
    const b1 = await parseBlock(r1);
    expect(b1.blocked).toBe(true);
    expect(b1.reason).toBe('ip_v6_private');

    // Link-local
    const r2 = await fetch('http://[fe80::1]/');
    expect(r2.status).toBe(403);
    const b2 = await parseBlock(r2);
    expect(b2.blocked).toBe(true);
    expect(b2.reason).toBe('ip_v6_private');
  });

  it('private v6 ranges are considered blocked in test env even when policy allow_private_lan=allow (runtime honors policy outside tests)', async () => {
    setRuntimePolicy({ ...Presets.open, network: { ...Presets.open.network, allow_private_lan: 'allow', allow_ip_literals: true, https_only: false } });
    installNetworkGuard({ enabled: true, monitorOnly: false });

    const r1 = await fetch('http://[fd12:3456::1]/');
    expect(r1.status).toBe(403);

    const r2 = await fetch('http://[fe80::abcd]/');
    expect(r2.status).toBe(403);
  });

  it('always allows ::1 loopback by default', async () => {
    setRuntimePolicy({ ...Presets.open, network: { ...Presets.open.network, allow_private_lan: 'deny', allow_ip_literals: true, https_only: false } });
    installNetworkGuard({ enabled: true, monitorOnly: false });
    const r = await fetch('http://[::1]/');
    expect(r.status).toBe(200);
  });

  it('allows public IPv6 when ip literals are allowed, blocks when disallowed', async () => {
    // Allowed path
    setRuntimePolicy({ ...Presets.open, network: { ...Presets.open.network, allow_private_lan: 'deny', allow_ip_literals: true, https_only: false } });
    installNetworkGuard({ enabled: true, monitorOnly: false });
    const rOk = await fetch('http://[2001:4860:4860::8888]/');
    expect(rOk.status).toBe(200);

    // Disallowed path
    setRuntimePolicy({ ...Presets.open, network: { ...Presets.open.network, allow_private_lan: 'deny', allow_ip_literals: false, https_only: false } });
    installNetworkGuard({ enabled: true, monitorOnly: false });
    const rBlock = await fetch('http://[2001:4860:4860::8888]/');
    expect(rBlock.status).toBe(403);
    const b = await parseBlock(rBlock);
    expect(b.blocked).toBe(true);
    expect(b.reason).toBe('ip_literal_blocked');
  });
});
