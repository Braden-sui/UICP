/// <reference lib="dom" />
/* global EventListener */
import { useEffect } from 'react';
import { useAppStore } from '../state/app';
import { getEffectivePolicy, setRuntimePolicy } from '../lib/security/policyLoader';

const setFeature = (feature: string, value: 'deny' | 'ask' | 'allow') => {
  try {
    const pol = getEffectivePolicy();
    const next = { ...pol, compute: pol.compute ?? {} };
    switch (feature) {
      case 'webrtc':
        next.compute.webrtc = value; break;
      case 'webtransport':
        next.compute.webtransport = value; break;
      case 'workers':
        next.compute.workers = value; break;
      case 'service_worker':
        next.compute.service_worker = value; break;
      default:
        return;
    }
    setRuntimePolicy(next);
  } catch (err) {
    console.warn('[ComputeToastBridge] setFeature failed', err);
  }
};

const ComputeToastBridge = () => {
  useEffect(() => {
    const onComputePermission = (e: Event) => {
      try {
        const detail = (e as CustomEvent<{ feature: string }>).detail;
        const feat = String(detail?.feature || '').trim();
        if (!feat) return;
        const store = useAppStore.getState();
        const label = feat.replace('_', ' ');
        const message = `Permission required: ${label}`;
        const actions = [
          { label: 'Allow always', run: () => setFeature(feat, 'allow') },
          { label: 'Deny always', run: () => setFeature(feat, 'deny') },
          { label: 'Open Policy', run: () => useAppStore.getState().setPolicyViewerOpen(true) },
        ];
        store.pushToast({ message, variant: 'error', actions });
      } catch (err) {
        console.warn('[ComputeToastBridge] permission handler failed', err);
      }
    };
     
    window.addEventListener('compute-permission', onComputePermission as EventListener);
     
    return () => window.removeEventListener('compute-permission', onComputePermission as EventListener);
  }, []);
  return null;
};

export default ComputeToastBridge;
