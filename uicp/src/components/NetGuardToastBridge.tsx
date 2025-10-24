import { useEffect } from 'react';
import { useAppStore } from '../state/app';
import { getEffectivePolicy, setRuntimePolicy } from '../lib/security/policyLoader';
import { addNetGuardSessionAllow } from '../lib/security/networkGuard';

const toDomain = (url: string): string => {
  try { return new URL(url).hostname; } catch { return ''; }
};

const ensureAllowRule = (domain: string) => {
  try {
    if (!domain) return;
    const policy = getEffectivePolicy();
    const rules = Array.isArray(policy.network.wildcard_rules) ? [...policy.network.wildcard_rules] : [];
    const pattern = domain.includes('.') ? `*.${domain.split('.').slice(-2).join('.')}` : domain;
    const exact = domain;
    const has = rules.some((r) => Array.isArray(r.allow) && r.allow.some((p) => p === exact || p === pattern));
    if (!has) {
      rules.push({ allow: [exact, pattern] });
      setRuntimePolicy({ ...policy, network: { ...policy.network, wildcard_rules: rules } });
    }
  } catch {}
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
        const actions = [
          { label: 'Allow once', run: () => addNetGuardSessionAllow(domain) },
          { label: 'Always allow', run: () => ensureAllowRule(domain) },
          { label: 'Open Policy', run: () => useAppStore.getState().setPolicyViewerOpen(true) },
        ];
        store.pushToast({ message, variant: 'error', actions });
      } catch {}
    };
    const onAttempt = (_e: Event) => {};
    window.addEventListener('net-guard-block', onBlock as any);
    window.addEventListener('net-guard-attempt', onAttempt as any);
    return () => {
      window.removeEventListener('net-guard-block', onBlock as any);
      window.removeEventListener('net-guard-attempt', onAttempt as any);
    };
  }, []);
  return null;
};

export default NetGuardToastBridge;
