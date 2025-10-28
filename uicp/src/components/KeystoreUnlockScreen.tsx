import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { hasTauriBridge } from '../lib/bridge/tauri';
import { useKeystore } from '../state/keystore';
import { easings, getTransition, windowVariants } from '../lib/ui/animation';

const INPUT_ID = 'keystore-unlock-passphrase';

const KeystoreUnlockScreen = () => {
  const locked = useKeystore((state) => state.locked);
  const busy = useKeystore((state) => state.busy);
  const error = useKeystore((state) => state.error);
  const method = useKeystore((state) => state.method);
  const ttl = useKeystore((state) => state.ttlRemainingSec);
  const unlock = useKeystore((state) => state.unlock);
  const refreshStatus = useKeystore((state) => state.refreshStatus);

  const [passphrase, setPassphrase] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [isFocused, setIsFocused] = useState(false);

  useEffect(() => {
    if (!locked) {
      setPassphrase('');
      setAttempted(false);
      return;
    }
    if (!hasTauriBridge()) return;
    void refreshStatus();
  }, [locked, refreshStatus]);

  const submitDisabled = useMemo(() => busy || passphrase.trim().length === 0, [busy, passphrase]);

  const handleSubmit = useCallback(async (evt: FormEvent<HTMLFormElement>) => {
    evt.preventDefault();
    if (submitDisabled) return;
    setAttempted(true);
    const ok = await unlock(passphrase);
    if (!ok) {
      return;
    }
    setAttempted(false);
    setPassphrase('');
  }, [passphrase, submitDisabled, unlock]);

  if (!locked) return null;

  return (
    <div className="relative flex min-h-screen w-full items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      {/* Enhanced ambient background layers */}
      <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" aria-hidden="true" />
      <div className="absolute inset-0">
        <div className="absolute inset-0 bg-gradient-to-br from-indigo-500/5 via-transparent to-purple-500/5 animate-pulse" />
        <div className="absolute top-1/4 left-1/4 h-96 w-96 rounded-full bg-blue-500/10 blur-3xl animate-pulse" style={{ animationDuration: '8s' }} />
        <div className="absolute bottom-1/4 right-1/4 h-96 w-96 rounded-full bg-purple-500/10 blur-3xl animate-pulse" style={{ animationDuration: '12s', animationDelay: '2s' }} />
      </div>

      {/* Main unlock container */}
      <motion.div
        initial="initial"
        animate="animate"
        exit="exit"
        variants={windowVariants}
        transition={getTransition(600, easings.easeOut)}
        className="relative z-10 mx-4 w-full max-w-md"
      >
        <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-white/10 via-white/5 to-white/10 backdrop-blur-2xl shadow-2xl">
          {/* Glassmorphic border effect */}
          <div className="absolute inset-0 rounded-3xl bg-gradient-to-br from-white/20 via-transparent to-white/10" />
          <div className="absolute inset-0 rounded-3xl border border-white/20" />
          
          <div className="relative z-10 p-8">
            {/* Header with icon and title */}
            <motion.div 
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1, duration: 0.4 }}
              className="text-center"
            >
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500/20 to-purple-500/20 backdrop-blur-sm border border-white/10">
                <svg className="h-8 w-8 text-white/80" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <h1 className="text-2xl font-semibold text-white tracking-tight">Welcome Back</h1>
              <p className="mt-3 text-sm text-slate-300 leading-relaxed">
                Enter your keystore passphrase to unlock your secure workspace
              </p>
            </motion.div>

            {/* Form with enhanced styling */}
            <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
              <motion.div
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.2, duration: 0.4 }}
              >
                <label className="block text-sm font-medium text-slate-200 mb-2" htmlFor={INPUT_ID}>
                  Passphrase
                </label>
                <div className="relative">
                  <motion.div
                    animate={{
                      borderColor: isFocused ? 'rgb(99 102 241 / 0.5)' : 'rgb(148 163 184 / 0.2)',
                      boxShadow: isFocused ? '0 0 0 1px rgb(99 102 241 / 0.3)' : 'none'
                    }}
                    transition={{ duration: 0.2 }}
                    className="absolute inset-0 rounded-xl border border-slate-700/30 bg-slate-950/40 backdrop-blur-sm"
                  />
                  <input
                    id={INPUT_ID}
                    type="password"
                    autoFocus
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                    onFocus={() => setIsFocused(true)}
                    onBlur={() => setIsFocused(false)}
                    className="relative w-full rounded-xl border-0 bg-transparent px-4 py-3 text-sm text-white placeholder-slate-400 outline-none transition-all duration-200"
                    placeholder="Enter your passphrase"
                    aria-invalid={Boolean(error) && attempted}
                  />
                  {passphrase && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      className="absolute right-3 top-1/2 -translate-y-1/2"
                    >
                      <div className="h-2 w-2 rounded-full bg-green-400/60 animate-pulse" />
                    </motion.div>
                  )}
                </div>
              </motion.div>

              {/* Error message with animation */}
              <AnimatePresence>
                {error && attempted && (
                  <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.2 }}
                    className="rounded-lg bg-rose-500/10 border border-rose-500/20 px-3 py-2"
                  >
                    <p className="text-sm text-rose-300 flex items-center gap-2">
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      {error}
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Submit button with enhanced interactions */}
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3, duration: 0.4 }}
              >
                <motion.button
                  type="submit"
                  disabled={submitDisabled}
                  whileHover={{ scale: submitDisabled ? 1 : 1.02 }}
                  whileTap={{ scale: submitDisabled ? 1 : 0.98 }}
                  transition={{ duration: 0.2, ease: easings.easeOut }}
                  className={`relative w-full overflow-hidden rounded-xl px-6 py-3 text-sm font-semibold text-white transition-all duration-200 ${
                    submitDisabled 
                      ? 'bg-slate-700/30 cursor-not-allowed opacity-60' 
                      : 'bg-gradient-to-r from-indigo-500/20 to-purple-500/20 hover:from-indigo-500/30 hover:to-purple-500/30 border border-white/10 hover:border-white/20'
                  }`}
                >
                  <span className="relative z-10 flex items-center justify-center gap-2">
                    {busy ? (
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
                  {!submitDisabled && (
                    <div className="absolute inset-0 bg-gradient-to-r from-indigo-500/10 to-purple-500/10 opacity-0 hover:opacity-100 transition-opacity duration-200" />
                  )}
                </motion.button>
              </motion.div>
            </form>

            {/* Status information */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.4, duration: 0.4 }}
              className="mt-8 grid grid-cols-1 gap-4 border-t border-white/10 pt-6 sm:grid-cols-2"
            >
              <div className="rounded-lg bg-white/5 border border-white/10 p-3">
                <dt className="text-xs font-medium text-slate-400 uppercase tracking-wider">Security Mode</dt>
                <dd className="mt-1 text-sm font-medium text-white">{method ?? 'Unknown'}</dd>
              </div>
              <div className="rounded-lg bg-white/5 border border-white/10 p-3">
                <dt className="text-xs font-medium text-slate-400 uppercase tracking-wider">Session</dt>
                <dd className="mt-1 text-sm font-medium text-white">
                  {typeof ttl === 'number' ? `${ttl}s remaining` : 'Locked'}
                </dd>
              </div>
            </motion.div>
          </div>
        </div>
      </motion.div>
    </div>
  );
};

export default KeystoreUnlockScreen;
