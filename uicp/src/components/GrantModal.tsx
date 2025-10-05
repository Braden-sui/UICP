import { useAppStore } from '../state/app';

// GrantModal ensures the user explicitly opts into agent full control before applying patches automatically.
export const GrantModal = () => {
  const open = useAppStore((state) => state.grantModalOpen);
  const close = useAppStore((state) => state.closeGrantModal);
  const setFullControl = useAppStore((state) => state.setFullControl);
  const unlock = useAppStore((state) => state.unlockFullControl);
  const locked = useAppStore((state) => state.fullControlLocked);

  if (!open) return null;

  const grant = () => {
    unlock();
    setFullControl(true);
    close();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="grant-modal-title"
        className="w-[min(420px,90vw)] rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl"
      >
        <h2 id="grant-modal-title" className="text-lg font-semibold text-slate-900">
          Grant full control to the agent?
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          When enabled, plans from the agent apply immediately. You can revoke access at any time by pressing Stop or opening this modal again.
        </p>
        {locked && (
          <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            Stop was pressed earlier so full control is currently locked. Granting access clears the lock.
          </p>
        )}
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            className="rounded border border-slate-300 px-4 py-2 text-sm text-slate-600 hover:bg-slate-100"
            onClick={close}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rounded bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
            onClick={grant}
          >
            Grant full control
          </button>
        </div>
      </div>
    </div>
  );
};

export default GrantModal;
