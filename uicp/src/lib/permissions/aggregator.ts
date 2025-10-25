export type PermissionAggregates = {
  internet?: boolean;
  localNetwork?: 'deny' | 'ask' | 'allow';
  realtime?: 'deny' | 'ask' | 'allow';
  filesystem?: 'deny' | 'prompt' | 'allow';
};

export type PermissionAggregateResult = {
  accepted: boolean;
  values?: PermissionAggregates;
};

const EVENT_REQUEST = 'permissions-aggregate-request';
const EVENT_RESULT = 'permissions-aggregate-result';

export async function promptPermissions(defaults?: PermissionAggregates): Promise<PermissionAggregateResult> {
  const id = `perm_${Math.random().toString(36).slice(2)}`;
  return new Promise<PermissionAggregateResult>((resolve) => {
    const onResult = (e: Event) => {
      try {
        const detail = (e as CustomEvent).detail as { id: string; accepted: boolean; values?: PermissionAggregates };
        if (!detail || detail.id !== id) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        window.removeEventListener(EVENT_RESULT, onResult as any);
        resolve({ accepted: detail.accepted, values: detail.values });
      } catch {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        window.removeEventListener(EVENT_RESULT, onResult as any);
        resolve({ accepted: false });
      }
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    window.addEventListener(EVENT_RESULT, onResult as any);
    try {
      const evt = new CustomEvent(EVENT_REQUEST, { detail: { id, defaults } });
      window.dispatchEvent(evt);
    } catch {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      window.removeEventListener(EVENT_RESULT, onResult as any);
      resolve({ accepted: false });
    }
  });
}
