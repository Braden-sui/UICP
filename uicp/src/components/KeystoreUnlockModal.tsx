import { useEffect, useState, useCallback } from 'react';
import { useKeystore } from '../state/keystore';
import { useAppStore } from '../state/app';

const KeystoreUnlockModal = () => {
  const ks = useKeystore();
  const [open, setOpen] = useState(false);
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [pass, setPass] = useState('');

  useEffect(() => {
    const onRequest = (e: Event) => {
      const detail = (e as CustomEvent).detail as { id?: string } | undefined;
      const id = (detail?.id ?? '').toString();
      setOpen(true);
      if (id) setPendingIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    };
    window.addEventListener('keystore-unlock-request', onRequest as EventListener);
    return () => window.removeEventListener('keystore-unlock-request', onRequest as EventListener);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setPass('');
    setPendingIds([]);
  }, []);

  const handleUnlock = useCallback(async () => {
    if (!pass.trim()) return;
    const ok = await ks.unlock(pass);
    if (!ok) {
      useAppStore.getState().pushToast({ variant: 'error', message: ks.error ?? 'Unlock failed' });
      return;
    }
    // Resume all pending actions
    for (const id of pendingIds) {
      try {
        window.dispatchEvent(new CustomEvent('keystore-unlock-resume', { detail: { id } }));
      } catch {}
    }
    useAppStore.getState().pushToast({ variant: 'success', message: 'Keystore unlocked' });
    close();
  }, [pass, pendingIds, ks, close]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur">
      <div className="w-[min(420px,90vw)] rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="keystore-unlock-title">
        <h2 id="keystore-unlock-title" className="text-lg font-semibold text-slate-900">Unlock Keystore</h2>
        <p className="mt-2 text-sm text-slate-600">Enter your passphrase to continue the pending action.</p>
        <div className="mt-4 flex items-center gap-2">
          <input
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            placeholder="Passphrase"
            className="flex-1 rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-inner focus:border-slate-400 focus:outline-none"
          />
          <button
            type="button"
            onClick={handleUnlock}
            disabled={ks.busy || !pass.trim()}
            className="rounded bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition-all duration-200 hover:bg-slate-700 hover:scale-105 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {ks.busy ? 'Unlocking…' : 'Unlock'}
          </button>
          <button
            type="button"
            onClick={close}
            className="rounded border border-slate-300 px-4 py-2 text-sm text-slate-600 transition-all duration-200 hover:bg-slate-100 active:scale-95"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

export default KeystoreUnlockModal;
