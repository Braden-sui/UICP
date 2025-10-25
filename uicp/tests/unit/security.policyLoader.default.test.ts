import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// NOTE: We import after stubbing env so fromEnv() sees our values.

describe('policyLoader default preset', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('UICP_SAFE_MODE', '0');
    vi.stubEnv('UICP_POLICY', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to PresetOpen when no env is set', async () => {
    const policyLoader = await import('../../src/lib/security/policyLoader');
    const { getEffectivePolicy } = policyLoader;
    const pol = getEffectivePolicy();

    // Open preset characteristics (personal OS baseline)
    expect(pol.network.mode).toBe('default_allow');
    expect(pol.network.https_only).toBe(false);
    expect(pol.network.allow_ip_literals).toBe(true);
    expect(pol.network.allow_private_lan).toBe('allow');
    expect(pol.compute.mem_mb).toBe(8192);
    expect(pol.compute.webrtc).toBe('allow');
    // Quota defaults distinguish from Balanced/Locked
    expect(pol.network.quotas?.domain_defaults?.rps).toBe(200);
  });

  it('respects UICP_SAFE_MODE=1 forcing locked', async () => {
    vi.resetModules();
    vi.stubEnv('UICP_SAFE_MODE', '1');
    vi.stubEnv('UICP_POLICY', '');
    const policyLoader = await import('../../src/lib/security/policyLoader');
    const { getEffectivePolicy } = policyLoader;
    const pol = getEffectivePolicy();

    expect(pol.network.mode).toBe('default_deny');
  });
});
