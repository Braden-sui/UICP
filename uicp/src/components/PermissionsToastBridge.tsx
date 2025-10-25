import { useEffect } from 'react';
import { useAppStore } from '../state/app';
import { setApiPolicyDecision } from '../lib/permissions/PermissionManager';

const PermissionsToastBridge = () => {
  useEffect(() => {
    const onDeny = (e: Event) => {
      try {
        const detail = (e as CustomEvent).detail as { origin: string; method?: string };
        const store = useAppStore.getState();
        const origin = String(detail.origin || '').trim();
        const method = String(detail.method || 'GET').toUpperCase();
        if (!origin) return;
        const message = `Permission required: ${method} ${origin}`;
        const actions = [
          { label: 'Allow once', run: () => void setApiPolicyDecision(method, origin, 'allow', 'session') },
          { label: 'Always allow', run: () => void setApiPolicyDecision(method, origin, 'allow', 'forever') },
          { label: 'Open Policy', run: () => useAppStore.getState().setPolicyViewerOpen(true) },
        ];
        store.pushToast({ message, variant: 'error', actions });
      } catch { /* non-fatal */ }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    window.addEventListener('permissions-deny', onDeny as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return () => window.removeEventListener('permissions-deny', onDeny as any);
  }, []);
  return null;
};

export default PermissionsToastBridge;
