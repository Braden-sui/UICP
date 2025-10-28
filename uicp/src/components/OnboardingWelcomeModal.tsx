import { useCallback, useEffect, useMemo, useState } from 'react';
import { createId } from '../lib/utils';
import { hasTauriBridge, openBrowserWindow, keystoreSentinelExists } from '../lib/bridge/tauri';
import { useAppStore } from '../state/app';
import { useKeystore } from '../state/keystore';
import {
  PROVIDER_GUIDES,
  PROVIDER_SECRET_IDS,
  type ProviderGuide,
  type ProviderId,
} from '../lib/providers/setupGuides';

type Step = 'setup' | 'intro' | 'providers' | 'summary';

type ProviderRow = {
  id: string;
  provider: ProviderId;
  key: string;
  saving: boolean;
  message?: string;
};

type ProviderInstructionsProps = {
  guide: ProviderGuide;
};

const ProviderInstructions = ({ guide }: ProviderInstructionsProps) => (
  <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
    <div className="flex items-center justify-between gap-3">
      <div className="text-sm font-semibold text-slate-900">{guide.label}</div>
      <button
        type="button"
        className="text-xs font-semibold text-slate-600 underline-offset-4 hover:underline"
        onClick={() => {
          if (hasTauriBridge()) {
            void openBrowserWindow(guide.docsUrl, { label: `${guide.label} Docs`, safe: true });
          } else if (typeof window !== 'undefined') {
            window.open(guide.docsUrl, '_blank', 'noopener');
          }
        }}
      >
        View setup guide
      </button>
    </div>
    <p className="mt-2 text-sm text-slate-600">{guide.summary}</p>
    <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-slate-600">
      {guide.steps.map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ol>
  </div>
);

const DEFAULT_PROVIDERS: ProviderId[] = ['openai', 'anthropic'];

const OnboardingWelcomeModal = () => {
  const welcomeCompleted = useAppStore((state) => state.welcomeCompleted);
  const setWelcomeCompleted = useAppStore((state) => state.setWelcomeCompleted);
  const pushToast = useAppStore((state) => state.pushToast);

  const refreshStatus = useKeystore((state) => state.refreshStatus);
  const refreshIds = useKeystore((state) => state.refreshIds);
  const knownIds = useKeystore((state) => state.knownIds);
  const locked = useKeystore((state) => state.locked);
  const saveProviderKey = useKeystore((state) => state.saveProviderKey);
  const keystoreError = useKeystore((state) => state.error);
  const busy = useKeystore((state) => state.busy);
  const unlock = useKeystore((state) => state.unlock);

  const [initializing, setInitializing] = useState(true);
  const [step, setStep] = useState<Step>('intro');
  const [rows, setRows] = useState<ProviderRow[]>(() =>
    DEFAULT_PROVIDERS.map((provider) => ({
      id: createId('provider'),
      provider,
      key: '',
      saving: false,
    })),
  );
  const [firstRun, setFirstRun] = useState<boolean | null>(null);
  const [username, setUsername] = useState('');
  const [pass1, setPass1] = useState('');
  const [pass2, setPass2] = useState('');

  const renderSetup = () => (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold text-slate-900">Set up your keystore</h2>
      <p className="text-sm text-slate-600">
        Create a passphrase to encrypt your API keys. You will need this to unlock the keystore.
      </p>
      <div className="flex flex-col gap-3">
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Username (optional)"
          className="rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
        />
        <input
          type="password"
          value={pass1}
          onChange={(e) => setPass1(e.target.value)}
          placeholder="Passphrase (min 6 chars)"
          className="rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
        />
        <input
          type="password"
          value={pass2}
          onChange={(e) => setPass2(e.target.value)}
          placeholder="Confirm passphrase"
          className="rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
        />
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100"
          onClick={() => setStep('intro')}
        >
          Back
        </button>
        <button
          type="button"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
          onClick={handleCreatePassphrase}
          disabled={!canSetPass || busy}
        >
          {busy ? 'Setting up…' : 'Create & Unlock'}
        </button>
      </div>
    </div>
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await refreshStatus();
        try {
          const exists = await keystoreSentinelExists();
          if (!cancelled) setFirstRun(exists.ok ? !exists.value : false);
        } catch {
          if (!cancelled) setFirstRun(false);
        }
        const ids = await refreshIds();
        if (!cancelled && ids.length > 0) {
          setWelcomeCompleted(true);
        }
      } finally {
        if (!cancelled) {
          setInitializing(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshIds, refreshStatus, setWelcomeCompleted]);

  useEffect(() => {
    if (!initializing && !welcomeCompleted && knownIds.length > 0) {
      setWelcomeCompleted(true);
    }
  }, [initializing, knownIds, setWelcomeCompleted, welcomeCompleted]);

  const savedProviders = useMemo(() => {
    const saved = new Set<ProviderId>();
    for (const guide of PROVIDER_GUIDES) {
      if (knownIds.includes(PROVIDER_SECRET_IDS[guide.id])) {
        saved.add(guide.id);
      }
    }
    return saved;
  }, [knownIds]);

  const hasAnySaved = savedProviders.size > 0;

  const unusedProviders = useMemo(() => {
    return PROVIDER_GUIDES.filter((guide) => !rows.some((row) => row.provider === guide.id));
  }, [rows]);

  const shouldShow = !welcomeCompleted && !initializing && knownIds.length === 0;
  const canSetPass = pass1.trim().length >= 6 && pass1 === pass2;

  const handleCreatePassphrase = useCallback(async () => {
    if (!canSetPass) return;
    const ok = await unlock(pass1);
    if (ok) {
      pushToast({ variant: 'success', message: 'Keystore initialized and unlocked.' });
      setStep('providers');
    } else {
      const currentError = useKeystore.getState().error;
      pushToast({ variant: 'error', message: currentError ?? 'Failed to initialize keystore' });
    }
  }, [canSetPass, pass1, pushToast, unlock]);

  const handleRowProviderChange = useCallback((rowId: string, provider: ProviderId) => {
    setRows((prev) =>
      prev.map((row) => (row.id === rowId ? { ...row, provider, key: '', message: undefined } : row)),
    );
  }, []);

  const handleRowKeyChange = useCallback((rowId: string, keyValue: string) => {
    setRows((prev) => prev.map((row) => (row.id === rowId ? { ...row, key: keyValue } : row)));
  }, []);

  const handleAddRow = useCallback(() => {
    if (unusedProviders.length === 0) return;
    const nextProvider = unusedProviders[0].id;
    setRows((prev) => [
      ...prev,
      { id: createId('provider'), provider: nextProvider, key: '', saving: false },
    ]);
  }, [unusedProviders]);

  const handleRemoveRow = useCallback((rowId: string) => {
    setRows((prev) => (prev.length <= 1 ? prev : prev.filter((row) => row.id !== rowId)));
  }, []);

  const handleSave = useCallback(
    async (rowId: string) => {
      const current = rows.find((row) => row.id === rowId);
      if (!current) return;
      const trimmed = current.key.trim();
      if (!trimmed) {
        setRows((prev) =>
          prev.map((row) =>
            row.id === rowId
              ? { ...row, message: 'Enter an API key before saving.' }
              : row,
          ),
        );
        return;
      }
      setRows((prev) => prev.map((row) => (row.id === rowId ? { ...row, saving: true, message: undefined } : row)));
      const ok = await saveProviderKey(current.provider, trimmed);
      if (ok) {
        setRows((prev) =>
          prev.map((row) =>
            row.id === rowId
              ? { ...row, saving: false, key: '', message: 'Saved securely.' }
              : row,
          ),
        );
        pushToast({ variant: 'success', message: `${PROVIDER_GUIDES.find((g) => g.id === current.provider)?.label ?? 'Provider'} key saved securely.` });
      } else {
        setRows((prev) =>
          prev.map((row) =>
            row.id === rowId
              ? { ...row, saving: false, message: 'Save failed. Unlock the keystore and try again.' }
              : row,
          ),
        );
      }
    },
    [pushToast, rows, saveProviderKey],
  );

  const handleFinish = useCallback(() => {
    setWelcomeCompleted(true);
    pushToast({ variant: 'success', message: 'Welcome! Your keys are now stored securely.' });
  }, [pushToast, setWelcomeCompleted]);

  const requestUnlock = useCallback(() => {
    try {
      window.dispatchEvent(new CustomEvent('keystore-unlock-request'));
    } catch {
      // ignore
    }
  }, []);

  if (!shouldShow) {
    return null;
  }

  const currentSavedCount = savedProviders.size;

  const renderIntro = () => (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold text-slate-900">Welcome to UICP</h2>
      <p className="text-sm text-slate-600">
        This desktop app is local-first and keeps your provider credentials encrypted at rest. We use a zero-knowledge keystore
        secured by your passphrase. Secrets stay on your machine and we only inject them into backend requests when needed.
      </p>
      <ul className="list-disc space-y-2 pl-6 text-sm text-slate-600">
        <li>API keys are encrypted with your passphrase-derived key and auto-lock after 20 minutes.</li>
        <li>Plaintext secrets never touch the UI or logs—only the backend sees them.</li>
        <li>You can manage keys later from Agent Settings, but most features require at least one provider key.</li>
      </ul>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100"
          onClick={() => handleFinish()}
        >
          Skip for now
        </button>
        <button
          type="button"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
          onClick={() => setStep('providers')}
        >
          Get Started
        </button>
      </div>
    </div>
  );

  const renderProviderRows = () => (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <h2 className="text-xl font-semibold text-slate-900">Add your API keys</h2>
        <p className="text-sm text-slate-600">
          Select a provider, paste your API key, then click save. You can unlock the keystore from here if it is locked.
        </p>
        {locked ? (
          <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            The keystore is locked. <button type="button" className="font-semibold underline" onClick={requestUnlock}>Unlock now</button> to save keys.
          </div>
        ) : null}
        {keystoreError ? (
          <div className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-700">{keystoreError}</div>
        ) : null}
      </div>
      <div className="space-y-4">
        {rows.map((row) => {
          const guide = PROVIDER_GUIDES.find((g) => g.id === row.provider)!;
          const providerSaved = savedProviders.has(row.provider);
          return (
            <div key={row.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div className="flex items-center gap-3">
                    <label className="text-sm font-semibold text-slate-900" htmlFor={`provider-${row.id}`}>
                      Provider
                    </label>
                    <select
                      id={`provider-${row.id}`}
                      className="rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
                      value={row.provider}
                      onChange={(event) => handleRowProviderChange(row.id, event.target.value as ProviderId)}
                    >
                      {PROVIDER_GUIDES.map((option) => (
                        <option
                          key={option.id}
                          value={option.id}
                          disabled={rows.some((other) => other.provider === option.id && other.id !== row.id)}
                        >
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {providerSaved ? (
                    <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
                      Saved
                    </span>
                  ) : null}
                </div>
                <ProviderInstructions guide={guide} />
                <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
                  <input
                    type="password"
                    value={row.key}
                    onChange={(event) => handleRowKeyChange(row.id, event.target.value)}
                    placeholder="Paste API key"
                    className="flex-1 rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
                    autoComplete="off"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
                      onClick={() => handleSave(row.id)}
                      disabled={row.saving}
                    >
                      {row.saving ? 'Saving…' : 'Save'}
                    </button>
                    {rows.length > 1 ? (
                      <button
                        type="button"
                        className="text-sm font-semibold text-slate-500 hover:text-slate-700"
                        onClick={() => handleRemoveRow(row.id)}
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                </div>
                {row.message ? <p className="text-xs text-slate-600">{row.message}</p> : null}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          className="text-sm font-semibold text-slate-600 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={handleAddRow}
          disabled={unusedProviders.length === 0}
        >
          + Add another provider
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100"
            onClick={() => setStep('intro')}
          >
            Back
          </button>
          <button
            type="button"
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
            onClick={() => setStep('summary')}
            disabled={!hasAnySaved}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );

  const renderSummary = () => (
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold text-slate-900">You are all set</h2>
      {currentSavedCount > 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-sm text-slate-600">Saved providers:</p>
          <ul className="mt-2 list-disc space-y-1 pl-6 text-sm text-slate-700">
            {Array.from(savedProviders).map((providerId) => (
              <li key={providerId}>{PROVIDER_GUIDES.find((guide) => guide.id === providerId)?.label ?? providerId}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
          No provider keys were saved. You can add them later from Agent Settings → Providers.
        </div>
      )}
      <p className="text-sm text-slate-600">
        You can manage secrets at any time from Agent Settings. We will remind you if a request needs a key that is missing.
      </p>
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          className="rounded-md border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100"
          onClick={() => setStep('providers')}
        >
          Back
        </button>
        <button
          type="button"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
          onClick={handleFinish}
        >
          Finish
        </button>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/60 backdrop-blur">
      <div className="w-[min(720px,92vw)] rounded-3xl bg-slate-50 p-6 shadow-2xl">
        {step === 'setup' || (firstRun && step === 'intro') ? renderSetup() : null}
        {step === 'intro' && !firstRun ? renderIntro() : null}
        {step === 'providers' ? renderProviderRows() : null}
        {step === 'summary' ? renderSummary() : null}
      </div>
    </div>
  );
};

export default OnboardingWelcomeModal;
