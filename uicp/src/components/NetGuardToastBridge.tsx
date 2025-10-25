/// <reference lib="dom" />
/* global EventListener */
import { useEffect } from 'react';
import { useAppStore } from '../state/app';
import { getEffectivePolicy, setRuntimePolicy } from '../lib/security/policyLoader';
import {
  addNetGuardSessionAllow,
  retryBlockedFetch,
  setInteractiveGuardRemediation,
  type BlockEventDetail,
  type GuardBlockPayload,
  type RemediationActionType,
} from '../lib/security/networkGuard';

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
    setInteractiveGuardRemediation(true);
    const onBlock = (e: Event) => {
      try {
        const detail = (e as CustomEvent).detail as BlockEventDetail;
        const store = useAppStore.getState();
        const payload = detail.payload as GuardBlockPayload | undefined;
        const retryId = detail.retryId;
        const domain = payload?.domain ?? toDomain(detail.url);
        if (shouldSuppress(domain)) return;

        const reason = payload?.reason ?? detail.reason ?? 'policy';
        const apiLabel = (payload?.context.api ?? detail.api ?? 'fetch').toUpperCase();
        const primaryTarget = domain || payload?.context.url || detail.url;
        const howToFix = payload?.how_to_fix ?? 'Open Policy viewer and adjust network rules.';
        const message = `Blocked ${apiLabel} ${primaryTarget}: ${reason}. ${howToFix}`;

        const runRetry = () => {
          if (!retryId) return;
          void retryBlockedFetch(retryId).catch((err) => {
            console.warn('[NetGuardToastBridge] retry failed', err);
          });
        };

        const handleAction = (action: RemediationActionType) => {
          switch (action) {
            case 'allow_once':
              if (!domain) return;
              if (addNetGuardSessionAllow(domain)) {
                pushSuccess(`Temporarily allowed ${domain}`);
                markSuppressed(domain);
                runRetry();
              }
              break;
            case 'allow_exact':
              ensureAllowExact(domain);
              pushSuccess(`Allowed ${domain}`);
              markSuppressed(domain);
              runRetry();
              break;
            case 'allow_wildcard': {
              const base = domain.includes('.') ? domain.split('.').slice(-2).join('.') : domain;
              ensureAllowWildcard(domain);
              pushSuccess(`Allowed *.${base}`);
              markSuppressed(domain);
              runRetry();
              break;
            }
            case 'open_policy_viewer':
              (() => {
                const s = useAppStore.getState();
                if (domain) s.setPolicyViewerSeedRule(domain);
                s.setPolicyViewerOpen(true);
              })();
              break;
            case 'set_lan_mode_allow':
              setLanMode('allow');
              pushSuccess('LAN set to: allow');
              markSuppressed(domain);
              runRetry();
              break;
            case 'set_lan_mode_ask':
              setLanMode('ask');
              pushSuccess('LAN set to: ask');
              markSuppressed(domain);
              runRetry();
              break;
            case 'allow_ip_literals':
              setAllowIpLiterals(true);
              pushSuccess('IP literals allowed');
              markSuppressed(domain);
              runRetry();
              break;
            case 'disable_https_only':
              setHttpsOnly(false);
              pushSuccess('HTTPS-only disabled');
              markSuppressed(domain);
              runRetry();
              break;
            default:
              break;
          }
        };

        const remediationActions = payload?.remediation.actions ?? ['allow_once', 'open_policy_viewer'];
        const toastActions = remediationActions.map((action) => ({
          label: labelForAction(action, domain),
          run: () => handleAction(action),
        }));

        store.pushToast({ message, variant: 'error', actions: toastActions });
        markSuppressed(domain);
      } catch (err) {
        console.warn('[NetGuardToastBridge] ensureAllowRule failed', err);
      }
    };
    window.addEventListener('net-guard-block', onBlock as EventListener);
    return () => {
      setInteractiveGuardRemediation(false);
      window.removeEventListener('net-guard-block', onBlock as EventListener);
    };
  }, []);
  return null;
};

const labelForAction = (action: RemediationActionType, domain: string): string => {
  switch (action) {
    case 'allow_once':
      return 'Allow once';
    case 'allow_exact':
      return domain ? `Allow ${domain}` : 'Allow domain';
    case 'allow_wildcard': {
      const base = domain.includes('.') ? domain.split('.').slice(-2).join('.') : domain;
      return domain ? `Allow *.${base}` : 'Allow wildcard';
    }
    case 'open_policy_viewer':
      return 'Open Policy';
    case 'set_lan_mode_allow':
      return 'LAN: Allow';
    case 'set_lan_mode_ask':
      return 'LAN: Ask';
    case 'allow_ip_literals':
      return 'Allow IP literals';
    case 'disable_https_only':
      return 'Disable HTTPS-only';
    default:
      return 'Resolve';
  }
};

export default NetGuardToastBridge;
