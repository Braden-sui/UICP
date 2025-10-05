import { useAppStore } from '../state/app';

// SystemToast surfaces failures loudly per the fail-fast policy.
export const SystemToast = () => {
  const toasts = useAppStore((state) => state.toasts);
  const dismiss = useAppStore((state) => state.dismissToast);

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-50 flex max-w-sm flex-col gap-3">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="status"
          className={`pointer-events-auto rounded-lg border px-3 py-2 text-sm shadow-lg backdrop-blur ${
            toast.variant === 'error'
              ? 'border-red-300 bg-red-50 text-red-700'
              : toast.variant === 'success'
                ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                : 'border-slate-200 bg-white/90 text-slate-700'
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <span>{toast.message}</span>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              className="rounded bg-transparent px-1 py-0.5 text-xs text-slate-500 hover:text-slate-900"
            >
              Close
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};

export default SystemToast;
