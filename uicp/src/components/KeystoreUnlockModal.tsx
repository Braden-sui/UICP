import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useKeystore } from '../state/keystore';
import { useAppStore } from '../state/app';
import { easings } from '../lib/ui/animation';

const KeystoreUnlockModal = () => {
  const unlockKeystore = useKeystore((state) => state.unlock);
  const keystoreError = useKeystore((state) => state.error);
  const keystoreBusy = useKeystore((state) => state.busy);
  const [open, setOpen] = useState(false);
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [pass, setPass] = useState('');
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string }>).detail;
      const id = (detail?.id ?? '').toString();
      setOpen(true);
      if (id) setPendingIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    };
    window.addEventListener('keystore-unlock-request', onRequest);
    return () => window.removeEventListener('keystore-unlock-request', onRequest);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setPass('');
    setPendingIds([]);
  }, []);

  const handleUnlock = useCallback(async () => {
    if (!pass.trim()) return;
    const ok = await unlockKeystore(pass);
    if (!ok) {
      useAppStore.getState().pushToast({ variant: 'error', message: keystoreError ?? 'Unlock failed' });
      return;
    }
    // Resume all pending actions
    for (const id of pendingIds) {
      window.dispatchEvent(new CustomEvent('keystore-unlock-resume', { detail: { id } }));
    }
    useAppStore.getState().pushToast({ variant: 'success', message: 'Keystore unlocked' });
    close();
  }, [pass, pendingIds, unlockKeystore, keystoreError, close]);

  const handleEscape = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape' && open) {
      close();
    }
  }, [open, close]);

  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [open, handleEscape]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-md"
          onClick={close}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.25, ease: easings.easeOut }}
            onClick={(e) => e.stopPropagation()}
            className="w-[min(480px,90vw)] relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-white/95 via-white/90 to-white/95 backdrop-blur-2xl shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="keystore-unlock-title"
          >
            {/* Glassmorphic border effect */}
            <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-white/20 via-transparent to-white/10" />
            <div className="absolute inset-0 rounded-2xl border border-white/20" />
            
            <div className="relative z-10 p-6">
              {/* Header with icon and title */}
              <div className="flex items-start gap-4">
                <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500/15 to-purple-500/15 backdrop-blur-sm border border-white/10">
                  <svg className="h-6 w-6 text-slate-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                </div>
                <div className="flex-1">
                  <h2 id="keystore-unlock-title" className="text-lg font-semibold text-slate-900 tracking-tight">
                    Authentication Required
                  </h2>
                  <p className="mt-1 text-sm text-slate-600 leading-relaxed">
                    Enter your keystore passphrase to continue with the requested action
                  </p>
                </div>
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  transition={{ duration: 0.15, ease: easings.easeOut }}
                  onClick={close}
                  className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors duration-200"
                  aria-label="Close"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </motion.button>
              </div>

              {/* Input field with enhanced styling */}
              <div className="mt-6">
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  Passphrase
                </label>
                <div className="relative">
                  <motion.div
                    animate={{
                      borderColor: isFocused ? 'rgb(99 102 241 / 0.5)' : 'rgb(203 213 225 / 0.5)',
                      boxShadow: isFocused ? '0 0 0 3px rgb(99 102 241 / 0.1)' : 'none'
                    }}
                    transition={{ duration: 0.2 }}
                    className="absolute inset-0 rounded-xl border border-slate-300/50 bg-white/80 backdrop-blur-sm"
                  />
                  <input
                    type="password"
                    value={pass}
                    onChange={(e) => setPass(e.target.value)}
                    onFocus={() => setIsFocused(true)}
                    onBlur={() => setIsFocused(false)}
                    placeholder="Enter your passphrase"
                    className="relative w-full rounded-xl border-0 bg-transparent px-4 py-3 text-sm text-slate-900 placeholder-slate-400 outline-none transition-all duration-200"
                    autoFocus
                  />
                  {pass && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="absolute right-3 top-1/2 -translate-y-1/2"
                    >
                      <div className="h-2 w-2 rounded-full bg-green-500/60 animate-pulse" />
                    </motion.div>
                  )}
                </div>
              </div>

              {/* Action buttons */}
              <div className="mt-6 flex gap-3">
                <motion.button
                  type="button"
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  transition={{ duration: 0.2, ease: easings.easeOut }}
                  onClick={close}
                  className="flex-1 rounded-xl border border-slate-300/60 bg-white/50 px-4 py-2.5 text-sm font-medium text-slate-700 backdrop-blur-sm transition-all duration-200 hover:bg-slate-100 hover:border-slate-400/60"
                >
                  Cancel
                </motion.button>
                <motion.button
                  type="button"
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  transition={{ duration: 0.2, ease: easings.easeOut }}
                  onClick={handleUnlock}
                  disabled={keystoreBusy || !pass.trim()}
                  className={`relative flex-1 overflow-hidden rounded-xl px-4 py-2.5 text-sm font-semibold text-white transition-all duration-200 ${
                    keystoreBusy || !pass.trim()
                      ? 'bg-slate-400/50 cursor-not-allowed opacity-60'
                      : 'bg-gradient-to-r from-indigo-500 to-purple-500 hover:from-indigo-600 hover:to-purple-600 shadow-lg hover:shadow-xl'
                  }`}
                >
                  <span className="relative z-10 flex items-center justify-center gap-2">
                    {keystoreBusy ? (
                      <>
                        <motion.div
                          animate={{ rotate: 360 }}
                          transition={{ duration: 1, repeat: Infinity, ease: 'linear' }}
                          className="h-4 w-4 border-2 border-white/30 border-t-white rounded-full"
                        />
                        Unlocking…
                      </>
                    ) : (
                      <>
                        Unlock
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                        </svg>
                      </>
                    )}
                  </span>
                  {!keystoreBusy && pass.trim() && (
                    <div className="absolute inset-0 bg-gradient-to-r from-white/10 to-transparent opacity-0 hover:opacity-100 transition-opacity duration-200" />
                  )}
                </motion.button>
              </div>

              {/* Pending actions indicator */}
              {pendingIds.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1, duration: 0.3 }}
                  className="mt-4 flex items-center gap-2 rounded-lg bg-amber-50/80 border border-amber-200/60 p-3 backdrop-blur-sm"
                >
                  <svg className="h-4 w-4 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <p className="text-xs text-amber-800">
                    {pendingIds.length} pending {pendingIds.length === 1 ? 'action' : 'actions'} will resume after unlock
                  </p>
                </motion.div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default KeystoreUnlockModal;
