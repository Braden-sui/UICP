import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { hasTauriBridge } from '../lib/bridge/tauri';
import { useKeystore } from '../state/keystore';

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
      <div className="absolute inset-0 bg-black/40 backdrop-blur" aria-hidden="true" />
      <div className="relative z-10 mx-4 w-full max-w-md rounded-2xl border border-slate-800/60 bg-slate-900/80 p-8 shadow-2xl">
        <h1 className="text-2xl font-semibold text-white">Unlock Required</h1>
        <p className="mt-2 text-sm text-slate-300">
          Enter your keystore passphrase to continue. Secrets stay encrypted until you unlock them.
        </p>
        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <div>
            <label className="text-sm font-medium text-slate-200" htmlFor={INPUT_ID}>
              Passphrase
            </label>
            <input
              id={INPUT_ID}
              type="password"
              autoFocus
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 text-sm text-white shadow-inner outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-600"
              placeholder="Enter passphrase"
              aria-invalid={Boolean(error) && attempted}
            />
          </div>
          {error && attempted ? (
            <p className="text-sm text-rose-300" role="alert">
              {error}
            </p>
          ) : null}
          <button
            type="submit"
            className="flex w-full items-center justify-center rounded-lg bg-white/10 px-4 py-2 text-sm font-semibold text-white transition hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-60"
            disabled={submitDisabled}
          >
            {busy ? 'Unlocking…' : 'Unlock'}
          </button>
        </form>
        <dl className="mt-6 grid grid-cols-1 gap-2 text-xs text-slate-400 sm:grid-cols-2">
          <div>
            <dt className="uppercase tracking-wide text-slate-500">Mode</dt>
            <dd>{method ?? 'Unknown'}</dd>
          </div>
          <div>
            <dt className="uppercase tracking-wide text-slate-500">Session TTL</dt>
            <dd>{typeof ttl === 'number' ? `${ttl}s remaining` : 'Locked'}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
};

export default KeystoreUnlockScreen;
