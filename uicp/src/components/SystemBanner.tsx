import { useAppStore, selectSafeMode, selectSafeReason } from '../state/app';
import { hasTauriBridge, tauriInvoke } from '../lib/bridge/tauri';

const SystemBanner = () => {
  const safeMode = useAppStore(selectSafeMode);
  const safeReason = useAppStore(selectSafeReason);
  // Fallback: hide if the store hasn't been extended yet
  if (!safeMode) return null;

  const message = `Replay issue detected: ${safeReason ?? 'Unknown'}. You can attempt automatic repair, restore from checkpoint, export diagnostics, or start fresh.`;
  const act = async (kind: string) => {
    if (!hasTauriBridge()) {
      console.warn(`[system-banner] recovery action ${kind} skipped; tauri bridge unavailable`);
      return;
    }
    try {
      await tauriInvoke('recovery_action', { kind });
    } catch (err) {
      console.error('recovery_action failed', err);
    }
  };

  return (
    <div className="pointer-events-auto fixed inset-x-0 top-0 z-[60] border-b border-amber-300 bg-amber-50/95 p-2 text-sm text-amber-900">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
        <div className="font-medium">{message}</div>
        <div className="flex items-center gap-2">
          <button
            className="rounded border border-amber-300 bg-white/80 px-2 py-1 text-xs"
            onClick={async () => {
              if (!hasTauriBridge()) {
                console.warn('[system-banner] recovery_auto skipped; tauri bridge unavailable');
                return;
              }
              try {
                await tauriInvoke('recovery_auto');
              } catch (err) {
                console.error('recovery_auto failed', err);
              }
            }}
          >
            Attempt auto-repair
          </button>
          <button className="rounded border border-amber-300 bg-white/80 px-2 py-1 text-xs" onClick={() => act('restore_checkpoint')}>Restore from checkpoint</button>
          <button
            className="rounded border border-amber-300 bg-white/80 px-2 py-1 text-xs"
            onClick={async () => {
              if (!hasTauriBridge()) {
                console.warn('[system-banner] recovery_export skipped; tauri bridge unavailable');
                return;
              }
              try {
                const res = await tauriInvoke('recovery_export');
                console.info('diagnostics path', res);
              } catch (e) {
                console.error(e);
              }
            }}
          >
            Export diagnostics
          </button>
          <button className="rounded border border-amber-300 bg-white/80 px-2 py-1 text-xs" onClick={() => act('reset')}>Start fresh</button>
        </div>
      </div>
    </div>
  );
};

export default SystemBanner;
