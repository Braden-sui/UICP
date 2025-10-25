/// <reference lib="dom" />
/* global EventListener */
import { useEffect } from 'react';
import { useAppStore } from '../state/app';
import { getEffectivePolicy, setRuntimePolicy } from '../lib/security/policyLoader';
import { addNetGuardSessionAllow } from '../lib/security/networkGuard';

const toDomain = (url: string): string => {
  try { return new URL(url).hostname; } catch { return ''; }
};

// Suppress duplicate block toasts for a domain for a short window
const recentBlocks: Record<string, number> = {};
const SUPPRESS_MS = 2000;
const shouldSuppress = (domain: string) => {
  if (!domain) return false;
  const now = Date.now();
  const last = recentBlocks[domain] ?? 0;
  return now - last < SUPPRESS_MS;
};
const markSuppressed = (domain: string) => { if (domain) recentBlocks[domain] = Date.now(); };

const pushSuccess = (message: string) => {
  try { useAppStore.getState().pushToast({ message, variant: 'success' }); } catch { /* non-fatal */ }
};


const ensureAllowExact = (domain: string) => {
  try {
    if (!domain) return;
    const policy = getEffectivePolicy();
    const rules = Array.isArray(policy.network.wildcard_rules) ? [...policy.network.wildcard_rules] : [];
    const exact = domain;
    const has = rules.some((r) => Array.isArray(r.allow) && r.allow.some((p) => p === exact));
    if (!has) {
      rules.push({ allow: [exact] });
      setRuntimePolicy({ ...policy, network: { ...policy.network, wildcard_rules: rules } });
    }
  } catch (err) {
    console.warn('[NetGuardToastBridge] ensureAllowExact failed', err);
  }
};

const ensureAllowWildcard = (domain: string) => {
  try {
    if (!domain) return;
    const policy = getEffectivePolicy();
    const rules = Array.isArray(policy.network.wildcard_rules) ? [...policy.network.wildcard_rules] : [];
    const pattern = domain.includes('.') ? `*.${domain.split('.').slice(-2).join('.')}` : domain;
    const has = rules.some((r) => Array.isArray(r.allow) && r.allow.some((p) => p === pattern));
    if (!has) {
      rules.push({ allow: [pattern] });
      setRuntimePolicy({ ...policy, network: { ...policy.network, wildcard_rules: rules } });
    }
  } catch (err) {
    console.warn('[NetGuardToastBridge] ensureAllowWildcard failed', err);
  }
};

const setLanMode = (mode: 'deny' | 'ask' | 'allow') => {
  try {
    const policy = getEffectivePolicy();
    setRuntimePolicy({ ...policy, network: { ...policy.network, allow_private_lan: mode } });
  } catch (err) {
    console.warn('[NetGuardToastBridge] setLanMode failed', err);
  }
};

const setAllowIpLiterals = (val: boolean) => {
  try {
    const policy = getEffectivePolicy();
    setRuntimePolicy({ ...policy, network: { ...policy.network, allow_ip_literals: val } });
  } catch (err) {
    console.warn('[NetGuardToastBridge] setAllowIpLiterals failed', err);
  }
};

const setHttpsOnly = (val: boolean) => {
  try {
    const policy = getEffectivePolicy();
    setRuntimePolicy({ ...policy, network: { ...policy.network, https_only: val } });
  } catch (err) {
    console.warn('[NetGuardToastBridge] setHttpsOnly failed', err);
  }
};

const NetGuardToastBridge = () => {
  useEffect(() => {
    const onBlock = (e: Event) => {
      try {
        const detail = (e as CustomEvent).detail as { url: string; api: string; reason?: string };
        const store = useAppStore.getState();
        const domain = toDomain(detail.url);
        const reason = detail.reason ?? 'policy';
        const message = `Connection blocked: ${domain || detail.url} (${reason})`;
        if (shouldSuppress(domain)) return;
        const base = domain.includes('.') ? domain.split('.').slice(-2).join('.') : domain;
        const actions = [
          { label: 'Allow once', run: () => { if (addNetGuardSessionAllow(domain)) { pushSuccess(`Temporarily allowed ${domain}`); markSuppressed(domain); } } },
          { label: 'Allow exact', run: () => { ensureAllowExact(domain); pushSuccess(`Allowed ${domain}`); markSuppressed(domain); } },
          { label: `Allow *.${base}`, run: () => { ensureAllowWildcard(domain); pushSuccess(`Allowed *.${base}`); markSuppressed(domain); } },
          { label: 'Open Policy', run: () => { const s = useAppStore.getState(); s.setPolicyViewerSeedRule(domain); s.setPolicyViewerOpen(true); } },
        ];
        if (reason === 'private_lan_blocked' || reason === 'ip_private' || reason === 'ip_v6_private') {
          actions.splice(1, 0, { label: 'LAN: Ask', run: () => { setLanMode('ask'); pushSuccess('LAN set to: ask'); markSuppressed(domain); } });
          if (actions.length > 4) actions.pop();
        }
        if (reason === 'ip_literal_blocked') {
          actions.splice(1, 0, { label: 'Allow IP literals', run: () => { setAllowIpLiterals(true); pushSuccess('IP literals allowed'); markSuppressed(domain); } });
          if (actions.length > 4) actions.pop();
        }
        if (reason === 'https_only') {
          actions.splice(1, 0, { label: 'Disable HTTPS-only', run: () => { setHttpsOnly(false); pushSuccess('HTTPS-only disabled'); markSuppressed(domain); } });
          if (actions.length > 4) actions.pop();
        }
        store.pushToast({ message, variant: 'error', actions });
        markSuppressed(domain);
      } catch (err) {
        console.warn('[NetGuardToastBridge] ensureAllowRule failed', err);
      }
    };
    window.addEventListener('net-guard-block', onBlock as EventListener);
    return () => {
      window.removeEventListener('net-guard-block', onBlock as EventListener);
    };
  }, []);
  return null;
};

export default NetGuardToastBridge;
