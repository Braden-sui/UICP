import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import DesktopWindow from './DesktopWindow';
import { useAppSelector, useAppStore } from '../state/app';
import { selectSafeMode } from '../state/app';
import {
  listPlannerProfiles,
  listActorProfiles,
  getPlannerProfile,
  getActorProfile,
} from '../lib/llm/profiles';
import type { PlannerProfileKey, ActorProfileKey, ReasoningEffort } from '../lib/llm/profiles';
import { hasTauriBridge, tauriInvoke } from '../lib/bridge/tauri';
import {
  useProviderSelector,
  type ProviderHealthPayload,
  type ProviderLoginPayload,
  type ProviderName,
  type ProviderPreference,
  type ProviderStatus,
} from '../state/providers';

const plannerProfiles = listPlannerProfiles();
const actorProfiles = listActorProfiles();
const REASONING_OPTIONS: ReadonlyArray<{ value: ReasoningEffort; label: string; helper: string }> = [
  { value: 'low', label: 'Low', helper: 'Fastest output, minimal chain-of-thought tokens.' },
  { value: 'medium', label: 'Medium', helper: 'Balanced reasoning depth and latency.' },
  { value: 'high', label: 'High', helper: 'Deepest reasoning (default).' },
];

const PROVIDER_INFO: Record<
  ProviderName,
  { label: string; description: string; connectLabel: string; healthLabel: string }
> = {
  codex: {
    label: 'OpenAI Codex CLI',
    description: 'Uses codex CLI login or OPENAI_API_KEY when available.',
    connectLabel: 'Connect Codex',
    healthLabel: 'Check Codex',
  },
  claude: {
    label: 'Anthropic Claude CLI',
    description: 'Relies on claude CLI with keychain login when no API key is set.',
    connectLabel: 'Connect Claude',
    healthLabel: 'Check Claude',
  },
};

const describeStatus = (
  status: ProviderStatus,
): { label: string; className: string } => {
  switch (status.state) {
    case 'connected':
      return { label: 'Connected', className: 'text-emerald-600' };
    case 'connecting':
      return { label: 'Connecting...', className: 'text-slate-600' };
    case 'checking':
      return { label: 'Checking...', className: 'text-slate-600' };
    case 'error':
      return { label: 'Not connected', className: 'text-rose-600' };
    default:
      return { label: 'Not checked', className: 'text-slate-500' };
  }
};

const normalizeDetail = (detail?: string): string | undefined => {
  if (!detail) return undefined;
  const trimmed = detail.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 220 ? `${trimmed.slice(0, 217)}...` : trimmed;
};

const AgentSettingsWindow = () => {
  const agentSettingsOpen = useAppSelector((state) => state.agentSettingsOpen);
  const setAgentSettingsOpen = useAppSelector((state) => state.setAgentSettingsOpen);
  const plannerProfileKey = useAppSelector((state) => state.plannerProfileKey);
  const actorProfileKey = useAppSelector((state) => state.actorProfileKey);
  const setPlannerProfileKey = useAppSelector((state) => state.setPlannerProfileKey);
  const setActorProfileKey = useAppSelector((state) => state.setActorProfileKey);
  const plannerReasoningEffort = useAppSelector((state) => state.plannerReasoningEffort);
  const actorReasoningEffort = useAppSelector((state) => state.actorReasoningEffort);
  const setPlannerReasoningEffort = useAppSelector((state) => state.setPlannerReasoningEffort);
  const setActorReasoningEffort = useAppSelector((state) => state.setActorReasoningEffort);
  const plannerTwoPhaseEnabled = useAppSelector((state) => state.plannerTwoPhaseEnabled);
  const setPlannerTwoPhaseEnabled = useAppSelector((state) => state.setPlannerTwoPhaseEnabled);
  const safeMode = useAppSelector(selectSafeMode);
  const setSafeMode = useAppSelector((state) => state.setSafeMode);
  const defaultProviderPreference = useProviderSelector((state) => state.settings.defaultProvider);
  const enableBothProviders = useProviderSelector((state) => state.settings.enableBoth);
  const setDefaultProviderPreference = useProviderSelector((state) => state.setDefaultProvider);
  const setEnableBothProviders = useProviderSelector((state) => state.setEnableBoth);
  const codexStatus = useProviderSelector((state) => state.statuses.codex);
  const claudeStatus = useProviderSelector((state) => state.statuses.claude);
  const beginConnect = useProviderSelector((state) => state.beginConnect);
  const completeConnect = useProviderSelector((state) => state.completeConnect);
  const beginHealthCheck = useProviderSelector((state) => state.beginHealthCheck);
  const completeHealthCheck = useProviderSelector((state) => state.completeHealthCheck);
  const failProvider = useProviderSelector((state) => state.fail);
  const bridgeAvailable = hasTauriBridge();

  const plannerProfile = useMemo(() => getPlannerProfile(plannerProfileKey), [plannerProfileKey]);
  const actorProfile = useMemo(() => getActorProfile(actorProfileKey), [actorProfileKey]);

  const handlePlannerChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setPlannerProfileKey(event.target.value as PlannerProfileKey);
    },
    [setPlannerProfileKey],
  );

  const handleActorChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setActorProfileKey(event.target.value as ActorProfileKey);
    },
    [setActorProfileKey],
  );

  const handleTwoPhaseToggle = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setPlannerTwoPhaseEnabled(event.target.checked);
    },
    [setPlannerTwoPhaseEnabled],
  );
  const handlePlannerReasoningChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setPlannerReasoningEffort(event.target.value as ReasoningEffort);
    },
    [setPlannerReasoningEffort],
  );
  const handleActorReasoningChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setActorReasoningEffort(event.target.value as ReasoningEffort);
    },
    [setActorReasoningEffort],
  );

  const handleEnableBothChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setEnableBothProviders(event.target.checked);
    },
    [setEnableBothProviders],
  );

  const handleDefaultProviderChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setDefaultProviderPreference(event.target.value as ProviderPreference);
    },
    [setDefaultProviderPreference],
  );

  const handleProviderConnect = useCallback(
    async (provider: ProviderName) => {
      const info = PROVIDER_INFO[provider];
      if (!hasTauriBridge()) {
        failProvider(provider, 'Desktop bridge unavailable');
        useAppStore
          .getState()
          .pushToast({ variant: 'error', message: `${info.label} login requires the desktop runtime` });
        return;
      }
      beginConnect(provider);
      try {
        const raw = (await tauriInvoke('provider_login', { provider })) as ProviderLoginPayload | undefined;
        const payload: ProviderLoginPayload = {
          ok: !!raw?.ok,
          detail: typeof raw?.detail === 'string' ? raw.detail : undefined,
        };
        completeConnect(provider, payload);
        useAppStore.getState().pushToast(
          payload.ok
            ? { variant: 'success', message: `${info.label} login completed` }
            : {
                variant: 'error',
                message:
                  payload.detail && payload.detail.trim().length > 0
                    ? `${info.label} login reported: ${payload.detail}`
                    : `${info.label} login reported an error`,
              },
        );
      } catch (error) {
        const message = (error as Error)?.message ?? String(error);
        failProvider(provider, message);
        useAppStore
          .getState()
          .pushToast({ variant: 'error', message: `${info.label} login failed: ${message}` });
      }
    },
    [beginConnect, completeConnect, failProvider],
  );

  const handleProviderHealth = useCallback(
    async (provider: ProviderName) => {
      const info = PROVIDER_INFO[provider];
      if (!hasTauriBridge()) {
        failProvider(provider, 'Desktop bridge unavailable');
        useAppStore
          .getState()
          .pushToast({ variant: 'error', message: `${info.label} health check requires the desktop runtime` });
        return;
      }
      beginHealthCheck(provider);
      try {
        const raw = (await tauriInvoke('provider_health', { provider })) as ProviderHealthPayload | undefined;
        const payload: ProviderHealthPayload = {
          ok: !!raw?.ok,
          version:
            typeof raw?.version === 'string' && raw.version.trim().length > 0
              ? raw.version.trim()
              : undefined,
          detail: typeof raw?.detail === 'string' ? raw.detail : undefined,
        };
        completeHealthCheck(provider, payload);
        useAppStore.getState().pushToast(
          payload.ok
            ? {
                variant: 'success',
                message: `${info.label} health check succeeded${payload.version ? ` (${payload.version})` : ''}`,
              }
            : {
                variant: 'error',
                message:
                  payload.detail && payload.detail.trim().length > 0
                    ? `${info.label} health check failed: ${payload.detail}`
                    : `${info.label} health check failed`,
              },
        );
      } catch (error) {
        const message = (error as Error)?.message ?? String(error);
        failProvider(provider, message);
        useAppStore
          .getState()
          .pushToast({ variant: 'error', message: `${info.label} health check failed: ${message}` });
      }
    },
    [beginHealthCheck, completeHealthCheck, failProvider],
  );

  const handleSafeModeToggle = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const enabled = event.target.checked;
      // Update local store immediately for responsive UI
      setSafeMode(enabled, enabled ? 'USER_KILL_SWITCH' : undefined);
      try {
        if (!hasTauriBridge()) {
          // In test/dev without Tauri, just update local state
          return;
        }
        await tauriInvoke('set_safe_mode', { enabled, reason: enabled ? 'USER_KILL_SWITCH' : null });
        useAppStore
          .getState()
          .pushToast({ variant: 'info', message: enabled ? 'Safe Mode enabled: codegen disabled' : 'Safe Mode disabled' });
      } catch (err) {
        useAppStore.getState().pushToast({ variant: 'error', message: `Toggle failed: ${(err as Error)?.message ?? String(err)}` });
      }
    },
    [setSafeMode],
  );

  const handleClose = useCallback(() => setAgentSettingsOpen(false), [setAgentSettingsOpen]);

  const providerEntries = useMemo(
    () =>
      (['codex', 'claude'] as ProviderName[]).map((provider) => ({
        provider,
        status: provider === 'codex' ? codexStatus : claudeStatus,
      })),
    [codexStatus, claudeStatus],
  );

  // Modules directory info (Wasm compute)
  const [modulesDir, setModulesDir] = useState<string>('');
  const [modulesCount, setModulesCount] = useState<number>(0);
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        if (!hasTauriBridge()) {
          if (import.meta.env.DEV) {
            console.info('[agent-settings] tauri bridge unavailable; skipping get_modules_info');
          }
          return;
        }
        const info = await tauriInvoke('get_modules_info');
        if (!mounted) return;
        const obj = info as { dir?: string; entries?: number };
        setModulesDir(obj.dir ?? '');
        setModulesCount(obj.entries ?? 0);
      } catch (err) {
        useAppStore.getState().pushToast({ variant: 'error', message: `Failed to load modules info: ${(err as Error)?.message ?? String(err)}` });
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);
  const handleCopyModulesPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(modulesDir);
    } catch (err) {
      useAppStore.getState().pushToast({ variant: 'error', message: `Copy failed: ${(err as Error)?.message ?? String(err)}` });
    }
  }, [modulesDir]);
  const handleOpenModulesFolder = useCallback(async () => {
    try {
      if (!hasTauriBridge()) {
        useAppStore.getState().pushToast({ variant: 'error', message: 'Open folder requires the Tauri runtime' });
        return;
      }
      if (!modulesDir) return;
      await tauriInvoke('open_path', { path: modulesDir });
    } catch (err) {
      useAppStore.getState().pushToast({ variant: 'error', message: `Open folder failed: ${(err as Error)?.message ?? String(err)}` });
    }
  }, [modulesDir]);

  const handleVerifyModules = useCallback(async () => {
    try {
      if (!hasTauriBridge()) {
        useAppStore.getState().pushToast({ variant: 'error', message: 'Module verification requires the Tauri runtime' });
        return;
      }
      const res = await tauriInvoke<{ ok?: boolean; failures?: Array<{ filename?: string; reason?: string }>; count?: number }>(
        'verify_modules',
      );
      if (res?.ok) {
        useAppStore.getState().pushToast({ variant: 'success', message: `Modules OK (${res.count ?? 0} entries)` });
      } else {
        const n = res?.failures?.length ?? 0;
        useAppStore.getState().pushToast({ variant: 'error', message: `Module verification failed (${n})` });
      }
    } catch (err) {
      useAppStore.getState().pushToast({ variant: 'error', message: `Verify failed: ${(err as Error)?.message ?? String(err)}` });
    }
  }, []);

  const handleClearComputeCache = useCallback(async () => {
    try {
      if (!hasTauriBridge()) {
        useAppStore.getState().pushToast({ variant: 'error', message: 'Clearing cache requires the Tauri runtime' });
        return;
      }
      await tauriInvoke('clear_compute_cache', { workspace_id: 'default' });
      useAppStore.getState().pushToast({ variant: 'success', message: 'Compute cache cleared for workspace: default' });
    } catch (err) {
      useAppStore.getState().pushToast({ variant: 'error', message: `Clear cache failed: ${(err as Error)?.message ?? String(err)}` });
    }
  }, []);

  return (
    <DesktopWindow
      id="agent-settings"
      title="Agent Settings"
      isOpen={agentSettingsOpen}
      onClose={handleClose}
      initialPosition={{ x: 260, y: 160 }}
      width={520}
      minHeight={320}
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-slate-600">
          Select which model profiles power the planner (reasoning &amp; plan generation) and actor (batch builder). The defaults now
          target GLM 4.6; you can switch profiles here when you need a different pairing.
        </p>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-2 text-sm text-slate-600">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Planner profile</span>
            <select
              value={plannerProfileKey}
              onChange={handlePlannerChange}
              className="rounded border border-slate-300 bg-white/90 px-3 py-2 text-sm text-slate-800 shadow-inner focus:border-slate-400 focus:outline-none"
            >
              {plannerProfiles.map((profile) => (
                <option key={profile.key} value={profile.key}>
                  {profile.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-slate-500">{plannerProfile.description}</span>
            <span className="text-[11px] uppercase tracking-wide text-slate-400">
              Channels: {plannerProfile.capabilities?.channels.join(', ') ?? 'commentary'}
            </span>
          </label>
          {plannerProfile.key === 'gpt-oss' && (
            <div className="flex flex-col gap-2 rounded border border-slate-200 bg-slate-50/30 p-3 text-sm text-slate-600">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Planner reasoning effort</span>
              <select
                value={plannerReasoningEffort}
                onChange={handlePlannerReasoningChange}
                className="rounded border border-slate-300 bg-white/90 px-3 py-2 text-sm text-slate-800 shadow-inner focus:border-slate-400 focus:outline-none"
              >
                {REASONING_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="text-xs text-slate-500">
                {REASONING_OPTIONS.find((option) => option.value === plannerReasoningEffort)?.helper ??
                  'Choose how much chain-of-thought detail gpt-oss should use.'}
              </span>
            </div>
          )}
          <label className="flex flex-col gap-2 text-sm text-slate-600">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Actor profile</span>
            <select
              value={actorProfileKey}
              onChange={handleActorChange}
              className="rounded border border-slate-300 bg-white/90 px-3 py-2 text-sm text-slate-800 shadow-inner focus:border-slate-400 focus:outline-none"
            >
              {actorProfiles.map((profile) => (
                <option key={profile.key} value={profile.key}>
                  {profile.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-slate-500">{actorProfile.description}</span>
            <span className="text-[11px] uppercase tracking-wide text-slate-400">
              Channels: {actorProfile.capabilities?.channels.join(', ') ?? 'commentary'}
            </span>
          </label>
          {actorProfile.key === 'gpt-oss' && (
            <div className="flex flex-col gap-2 rounded border border-slate-200 bg-slate-50/30 p-3 text-sm text-slate-600">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Actor reasoning effort</span>
              <select
                value={actorReasoningEffort}
                onChange={handleActorReasoningChange}
                className="rounded border border-slate-300 bg-white/90 px-3 py-2 text-sm text-slate-800 shadow-inner focus:border-slate-400 focus:outline-none"
              >
                {REASONING_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <span className="text-xs text-slate-500">
                {REASONING_OPTIONS.find((option) => option.value === actorReasoningEffort)?.helper ??
                  'Higher effort increases reasoning depth for gpt-oss batches.'}
              </span>
            </div>
          )}
          <label className="flex items-center gap-3 rounded border border-slate-200 bg-slate-50/50 p-3 text-sm">
            <input
              type="checkbox"
              checked={plannerTwoPhaseEnabled}
              onChange={handleTwoPhaseToggle}
              className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
            />
            <div className="flex flex-col gap-1">
              <span className="font-medium text-slate-700">Two-Phase Planner (Experimental)</span>
              <span className="text-xs text-slate-500">
                When enabled, the planner first generates a structured TaskSpec, then produces the final plan. This can improve plan quality for complex requests.
              </span>
            </div>
          </label>
        </div>
        <div className="rounded border border-slate-200 bg-slate-50/30 p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Code Providers</div>
          <div className="flex flex-col gap-3">
            {providerEntries.map(({ provider, status }) => {
              const info = PROVIDER_INFO[provider];
              const meta = describeStatus(status);
              const detail = normalizeDetail(status.detail);
              const connecting = status.state === 'connecting';
              const checking = status.state === 'checking';
              return (
                <div key={provider} className="rounded border border-slate-200 bg-white/80 p-3 shadow-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex flex-col gap-1">
                      <span className="text-sm font-semibold text-slate-700">{info.label}</span>
                      <span className="text-xs text-slate-500">{info.description}</span>
                    </div>
                    <span className={`text-[11px] font-semibold uppercase tracking-wide ${meta.className}`}>
                      {meta.label}
                    </span>
                  </div>
                  {status.version && (
                    <div className="mt-2 text-xs text-slate-500">
                      Version: <span className="font-mono">{status.version}</span>
                    </div>
                  )}
                  {detail && <div className="mt-1 text-xs text-slate-500">{detail}</div>}
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => handleProviderConnect(provider)}
                      disabled={connecting || !bridgeAvailable}
                      className="rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {info.connectLabel}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleProviderHealth(provider)}
                      disabled={checking || !bridgeAvailable}
                      className="rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {info.healthLabel}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex flex-col gap-2 text-xs text-slate-600">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={enableBothProviders}
                onChange={handleEnableBothChange}
                className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
              />
              <span>Allow needs.code to try both providers before falling back</span>
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-semibold uppercase tracking-wide text-slate-500">Default provider</span>
              <select
                value={defaultProviderPreference}
                onChange={handleDefaultProviderChange}
                className="rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-inner focus:border-slate-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                disabled={enableBothProviders}
              >
                <option value="auto">Auto (planner preference)</option>
                <option value="codex">OpenAI Codex</option>
                <option value="claude">Anthropic Claude</option>
              </select>
              <span>
                {enableBothProviders
                  ? 'Auto mode is active while both providers are allowed.'
                  : 'When a single provider is enabled, needs.code will request this provider.'}
              </span>
            </label>
            {!bridgeAvailable && (
              <span className="text-slate-500">
                Provider commands require the desktop runtime. Buttons stay disabled in browser preview.
              </span>
            )}
          </div>
        </div>
        <div className="rounded border border-slate-200 bg-slate-50/30 p-3">
          <label className="flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={safeMode}
              onChange={handleSafeModeToggle}
              className="h-4 w-4 rounded border-slate-300 text-rose-600 focus:ring-rose-500"
            />
            <div className="flex flex-col gap-1">
              <span className="font-medium text-slate-700">Disable codegen (Safe Mode)</span>
              <span className="text-xs text-slate-500">Prevents needs.code jobs from starting. Useful when auditing or recovering state.</span>
            </div>
          </label>
        </div>
        <div className="rounded border border-slate-200 p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Wasm Modules</div>
          <div className="text-xs text-slate-600">Directory: <span className="font-mono">{modulesDir || 'unresolved'}</span></div>
          <div className="text-xs text-slate-600">Manifest entries: {modulesCount}</div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={handleCopyModulesPath}
              className="rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-100"
            >
              Copy Path
            </button>
            <button
              type="button"
              onClick={handleOpenModulesFolder}
              className="rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-100"
            >
              Open Folder
            </button>
            <button
              type="button"
              onClick={handleVerifyModules}
              className="rounded border border-emerald-300 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-700 hover:bg-emerald-50"
              title="Runs modules:verify"
            >
              Verify Modules
            </button>
            <button
              type="button"
              onClick={handleClearComputeCache}
              className="rounded border border-rose-300 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-rose-700 hover:bg-rose-50"
              title="Clears workspace-scoped compute cache"
            >
              Clear Cache
            </button>
          </div>
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleClose}
            className="rounded border border-slate-300 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-100"
          >
            Close
          </button>
        </div>
      </div>
    </DesktopWindow>
  );
};

export default AgentSettingsWindow;

