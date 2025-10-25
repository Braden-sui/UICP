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

    // Open preset characteristics
    expect(pol.network.mode).toBe('default_allow');
    expect(pol.network.allow_private_lan).toBe('allow');
    expect(pol.compute.webrtc).toBe('allow');
    // sanity check on quotas to distinguish from Balanced
    expect(pol.network.quotas?.domain_defaults?.rps).toBe(50);
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
