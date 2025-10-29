import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import DesktopWindow from './DesktopWindow';
import { useAppSelector, useAppStore } from '../state/app';
import { selectSafeMode } from '../state/app';
import { getActiveFlags } from '../lib/flags';
import {
  listPlannerProfiles,
  listActorProfiles,
  getPlannerProfile,
  getActorProfile,
} from '../lib/llm/profiles';
import type { PlannerProfileKey, ActorProfileKey, ReasoningEffort } from '../lib/llm/profiles';
import { hasTauriBridge, tauriInvoke } from '../lib/bridge/tauri';
import { useKeystore } from '../state/keystore';
import {
  useProviderSelector,
  type ProviderHealthPayload,
  type ProviderLoginPayload,
  type ProviderName,
  type ProviderStatus,
} from '../state/providers';
import {
  usePreferencesStore,
  type CodegenDefaultProvider,
} from '../state/preferences';
import { loadAgentsConfig, saveAgentsConfigFile, startWatcher, stopWatcher } from '../lib/agents/loader';
import type { AgentsFile, ProfileEntry, ProfileMode } from '../lib/agents/schema';
import { stringify } from 'yaml';
import { useLLM, type ProviderKey } from '../state/llm';

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

// Present a friendlier model label from a resolved model id
// Examples:
// - anthropic/claude-sonnet-4.5 -> claude sonnet 4.5
// - glm-4.6 -> glm 4.6
// - gpt-oss:120b -> gpt oss 120b
const toFriendlyModelName = (resolvedId: string): string => {
  const withoutPrefix = resolvedId.includes('/') ? resolvedId.split('/').pop()! : resolvedId;
  return withoutPrefix.replace(/[-_:]/g, ' ');
};

type ProfileEditorState = {
  provider: string;
  mode: ProfileMode;
  presetModel: string;
  customModel: string;
};

type ModelPresetOption = {
  id: string;
  label: string;
  resolvesTo: string;
};

const EMPTY_PROFILE_STATE: ProfileEditorState = {
  provider: '',
  mode: 'preset',
  presetModel: '',
  customModel: '',
};

const inferProfileEditorState = (profile?: ProfileEntry | null): ProfileEditorState => {
  if (!profile) {
    return { ...EMPTY_PROFILE_STATE };
  }
  const inferredMode: ProfileMode = profile.mode ?? (profile.custom_model && profile.custom_model.trim() ? 'custom' : 'preset');
  const presetModel = profile.preset_model ?? (inferredMode === 'preset' ? profile.model ?? '' : '');
  const customModel = profile.custom_model ?? (inferredMode === 'custom' ? profile.model ?? '' : '');
  return {
    provider: profile.provider ?? '',
    mode: inferredMode,
    presetModel: presetModel ?? '',
    customModel: customModel ?? '',
  };
};

const getProviderPresets = (agents: AgentsFile | null, providerKey: string): ModelPresetOption[] => {
  if (!agents || !providerKey) return [];
  const provider = agents.providers?.[providerKey];
  if (!provider) return [];
  const aliasEntries = Object.entries(provider.model_aliases ?? {});
  return aliasEntries
    .map(([alias, entry]) => {
      const resolved = typeof entry === 'string' ? entry : entry.id;
      const display = toFriendlyModelName(resolved);
      return { id: alias, label: display, resolvesTo: resolved };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
};

const validateCustomModel = (providerKey: string, value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'Model id cannot be empty';
  }
  if (providerKey === 'openrouter' && !trimmed.includes('/')) {
    return 'OpenRouter models require provider/model-name format';
  }
  return null;
};

type ModelSelectorProps = {
  mode: ProfileMode;
  provider: string;
  presets: ModelPresetOption[];
  presetValue: string;
  customValue: string;
  customPlaceholder: string;
  customError: string | null;
  disabled: boolean;
  onModeChange: (mode: ProfileMode) => void;
  onPresetChange: (value: string) => void;
  onCustomChange: (value: string) => void;
  onCustomBlur: () => void | Promise<void>;
};

const ModelSelector = (props: ModelSelectorProps) => {
  const {
    mode,
    provider,
    presets,
    presetValue,
    customValue,
    customPlaceholder,
    customError,
    disabled,
    onModeChange,
    onPresetChange,
    onCustomChange,
    onCustomBlur,
  } = props;
  const hasProvider = provider.trim().length > 0;
  const hasPresets = presets.length > 0;
  const isOpenRouter = provider === 'openrouter';

  if (!hasProvider) {
    return (
      <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-500">
        Select a provider first
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {hasPresets && (
        <label className="flex items-start gap-2.5">
          <input
            type="radio"
            checked={mode === 'preset'}
            onChange={() => onModeChange('preset')}
            disabled={disabled}
            className="mt-0.5 h-4 w-4 text-emerald-600 focus:ring-emerald-500 disabled:cursor-not-allowed"
          />
          <div className="flex flex-1 flex-col gap-2">
            <span className="text-sm font-medium text-slate-700">Use preset model</span>
            {mode === 'preset' && (
              <select
                value={presetValue || presets[0]?.id || ''}
                onChange={(event) => onPresetChange(event.target.value)}
                disabled={disabled}
                className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              >
                {presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            )}
          </div>
        </label>
      )}
      <label className="flex items-start gap-2.5">
        <input
          type="radio"
          checked={mode === 'custom'}
          onChange={() => onModeChange('custom')}
          disabled={disabled}
          className="mt-0.5 h-4 w-4 text-emerald-600 focus:ring-emerald-500 disabled:cursor-not-allowed"
        />
        <div className="flex flex-1 flex-col gap-2">
          <span className="text-sm font-medium text-slate-700">
            {isOpenRouter ? 'Custom model (recommended for OpenRouter)' : 'Use custom model ID'}
          </span>
          {mode === 'custom' && (
            <>
              <input
                type="text"
                value={customValue}
                onChange={(event) => onCustomChange(event.target.value)}
                onBlur={() => {
                  void onCustomBlur();
                }}
                placeholder={customPlaceholder}
                disabled={disabled}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              />
              {customError && <span className="text-xs text-rose-600">⚠️ {customError}</span>}
              {isOpenRouter && !customError && (
                <span className="text-xs text-slate-500">
                  Examples: anthropic/claude-sonnet-4.5, openai/gpt-5, meta-llama/llama-3.3-70b
                </span>
              )}
            </>
          )}
        </div>
      </label>
    </div>
  );
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
  const defaultProviderPreference = usePreferencesStore((state) => state.defaultProvider);
  const setDefaultProviderPreference = usePreferencesStore((state) => state.setDefaultProvider);
  const runBothByDefault = usePreferencesStore((state) => state.runBothByDefault);
  const setRunBothByDefault = usePreferencesStore((state) => state.setRunBothByDefault);
  const firewallDisabled = usePreferencesStore((state) => state.firewallDisabled);
  const setFirewallDisabledPref = usePreferencesStore((state) => state.setFirewallDisabled);
  const strictCaps = usePreferencesStore((state) => state.strictCaps);
  const setStrictCapsPref = usePreferencesStore((state) => state.setStrictCaps);
  const codexStatus = useProviderSelector((state) => state.statuses.codex);
  const claudeStatus = useProviderSelector((state) => state.statuses.claude);
  const codexModel = useProviderSelector((state) => state.settings.codexModel);
  const claudeModel = useProviderSelector((state) => state.settings.claudeModel);
  const beginConnect = useProviderSelector((state) => state.beginConnect);
  const completeConnect = useProviderSelector((state) => state.completeConnect);
  const beginHealthCheck = useProviderSelector((state) => state.beginHealthCheck);
  const completeHealthCheck = useProviderSelector((state) => state.completeHealthCheck);
  const failProvider = useProviderSelector((state) => state.fail);
  const setCodexModel = useProviderSelector((state) => state.setCodexModel);
  const setClaudeModel = useProviderSelector((state) => state.setClaudeModel);
  const bridgeAvailable = hasTauriBridge();
  const devMode = import.meta.env.DEV === true;
  const [installingProvider, setInstallingProvider] = useState<ProviderName | null>(null);

  // Keystore state
  const refreshKeystoreStatus = useKeystore((s) => s.refreshStatus);
  const keystoreLocked = useKeystore((s) => s.locked);
  const keystoreTtl = useKeystore((s) => s.ttlRemainingSec);
  const keystoreBusy = useKeystore((s) => s.busy);
  const keystoreMethod = useKeystore((s) => s.method);
  const keystoreError = useKeystore((s) => s.error);
  const unlockKeystore = useKeystore((s) => s.unlock);
  const quickLockKeystore = useKeystore((s) => s.quickLock);
  const [passphrase, setPassphrase] = useState<string>('');
  useEffect(() => {
    if (!hasTauriBridge()) return;
    void refreshKeystoreStatus();
  }, [refreshKeystoreStatus]);

  const formatTtl = (sec: number | null): string => {
    if (sec == null) return '';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const plannerProfile = useMemo(() => getPlannerProfile(plannerProfileKey), [plannerProfileKey]);
  const actorProfile = useMemo(() => getActorProfile(actorProfileKey), [actorProfileKey]);

  const [agentsConfig, setAgentsConfig] = useState<AgentsFile | null>(null);
  
  const [plannerState, setPlannerState] = useState<ProfileEditorState>({ ...EMPTY_PROFILE_STATE });
  const [actorState, setActorState] = useState<ProfileEditorState>({ ...EMPTY_PROFILE_STATE });
  const [globalProvider, setGlobalProvider] = useState<string>('');
  const [plannerCustomError, setPlannerCustomError] = useState<string | null>(null);
  const [actorCustomError, setActorCustomError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [newPlannerFallback, setNewPlannerFallback] = useState<string>('');

  const [localFallbackLoading, setLocalFallbackLoading] = useState<boolean>(false);
  const [newActorFallback, setNewActorFallback] = useState<string>('');
  const [authPreflight, setAuthPreflight] = useState<{ state: 'idle' | 'checking' | 'ok' | 'error' | 'na'; code?: string; detail?: string }>({ state: 'idle' });

  const provider = useLLM((s) => s.provider);
  const model = useLLM((s) => s.model);
  const setProviderModel = useLLM((s) => s.setProviderModel);
  const allowLocalOllama = useLLM((s) => s.allowLocalOllama);
  const setAllowLocalOllama = useLLM((s) => s.setAllowLocalOllama);
  useEffect(() => {
    if (!hasTauriBridge()) return;
    (async () => {
      try {
        const [, allowLocal] = await tauriInvoke<[boolean, boolean]>('get_ollama_mode');
        if (allowLocal !== allowLocalOllama) {
          setAllowLocalOllama(allowLocal);
        }
      } catch (err) {
        console.warn('[AgentSettings] Failed to sync Ollama mode from backend:', err);
      }
    })();
  }, [allowLocalOllama, setAllowLocalOllama]);

  useEffect(() => {
    if (!hasTauriBridge()) {
      setAgentsConfig(null);
      setPlannerState({ ...EMPTY_PROFILE_STATE });
      setActorState({ ...EMPTY_PROFILE_STATE });
      setPlannerCustomError(null);
      setActorCustomError(null);
      return;
    }
    (async () => {
      try {
        const config = await loadAgentsConfig();
        setAgentsConfig(config);
        setPlannerState(inferProfileEditorState(config.profiles?.planner));
        setActorState(inferProfileEditorState(config.profiles?.actor));
        const initialProvider = config.profiles?.planner?.provider ?? config.profiles?.actor?.provider ?? '';
        setGlobalProvider(initialProvider);
        setPlannerState((prev) => ({ ...prev, provider: initialProvider }));
        setActorState((prev) => ({ ...prev, provider: initialProvider }));
        setPlannerCustomError(null);
        setActorCustomError(null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        useAppStore.getState().pushToast({ variant: 'error', message: `Failed to load agent config: ${message}` });
      }
    })();
  }, []);

  useEffect(() => {
    if (!hasTauriBridge()) return;
    let disposed = false;
    void startWatcher(async (agents) => {
      if (disposed) return;
      setAgentsConfig(agents);
    });
    return () => {
      disposed = true;
      stopWatcher();
    };
  }, []);

  useEffect(() => {
    if (!agentsConfig?.profiles) {
      setPlannerState({ ...EMPTY_PROFILE_STATE });
      setActorState({ ...EMPTY_PROFILE_STATE });
      setGlobalProvider('');
      setPlannerCustomError(null);
      setActorCustomError(null);
      return;
    }
    const { planner, actor } = agentsConfig.profiles;
    setPlannerState(inferProfileEditorState(planner));
    setActorState(inferProfileEditorState(actor));
    const initialProvider = planner?.provider ?? actor?.provider ?? '';
    setGlobalProvider(initialProvider);
    setPlannerState((prev) => ({ ...prev, provider: initialProvider }));
    setActorState((prev) => ({ ...prev, provider: initialProvider }));
    setPlannerCustomError(null);
    setActorCustomError(null);
  }, [agentsConfig]);

  const customModelPlaceholder = useCallback((providerKey: string, role: 'planner' | 'actor'): string => {
    switch (providerKey) {
      case 'openai':
        return role === 'planner' ? 'e.g. gpt-5, gpt-5-mini' : 'e.g. gpt-5, gpt-5-mini';
      case 'anthropic':
        return role === 'planner' ? 'e.g. claude-sonnet-4-5-20250929, claude-haiku-4-5' : 'e.g. claude-sonnet-4-5-20250929, claude-haiku-4-5';
      case 'openrouter':
        return role === 'planner' ? 'openai/gpt-5, anthropic/claude-sonnet-4.5' : 'anthropic/claude-sonnet-4.5, openai/gpt-5-mini';
      case 'ollama':
        return 'e.g. deepseek-v3.1, qwen3-coder:480b';
      default:
        return role === 'planner' ? 'Enter a model id or alias' : 'Enter a model id or alias';
    }
  }, []);

  const plannerPresets = useMemo(
    () => getProviderPresets(agentsConfig, globalProvider),
    [agentsConfig, globalProvider],
  );

  const actorPresets = useMemo(
    () => getProviderPresets(agentsConfig, globalProvider),
    [agentsConfig, globalProvider],
  );

  // resolved model ids are internal; UI only shows friendly names
  const persistAgentsConfig = useCallback(
    async (updater: (draft: AgentsFile) => void) => {
      if (!agentsConfig) return;
      const draft: AgentsFile = JSON.parse(JSON.stringify(agentsConfig));
      updater(draft);
      try {
        const yamlText = stringify(draft);
        await saveAgentsConfigFile(yamlText);
        setAgentsConfig(draft);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        useAppStore.getState().pushToast({ variant: 'error', message: `Failed to save agent config: ${message}` });
        throw err;
      }
    },
    [agentsConfig],
  );

  const validateFallbackEntry = (value: string): string | null => {
    const v = (value || '').trim();
    if (!v) return 'Value required';
    const idx = v.indexOf(':');
    if (idx <= 0 || idx === v.length - 1) return 'Use provider:aliasOrId format';
    return null;
  };

  const handleAddFallback = useCallback(
    async (role: 'planner' | 'actor', value: string) => {
      const err = validateFallbackEntry(value);
      if (err) {
        useAppStore.getState().pushToast({ variant: 'error', message: err });
        return;
      }
      if (!agentsConfig) return;
      const trimmed = value.trim();
      await persistAgentsConfig((draft) => {
        const profile = draft.profiles?.[role];
        if (!profile) return;
        const list = Array.isArray(profile.fallbacks) ? [...profile.fallbacks] : [];
        if (!list.includes(trimmed)) list.push(trimmed);
        profile.fallbacks = list;
      });
      if (role === 'planner') setNewPlannerFallback('');
      if (role === 'actor') setNewActorFallback('');
    },
    [agentsConfig, persistAgentsConfig],
  );

  const handleRemoveFallback = useCallback(
    async (role: 'planner' | 'actor', index: number) => {
      if (!agentsConfig) return;
      await persistAgentsConfig((draft) => {
        const profile = draft.profiles?.[role];
        if (!profile || !Array.isArray(profile.fallbacks)) return;
        profile.fallbacks = profile.fallbacks.filter((_, i) => i !== index);
      });
    },
    [agentsConfig, persistAgentsConfig],
  );

  // Proxy settings
  const [proxyHttps, setProxyHttps] = useState<string>('');
  const [proxyNoProxy, setProxyNoProxy] = useState<string>('');
  useEffect(() => {
    if (!hasTauriBridge()) return;
    (async () => {
      try {
        const res = (await tauriInvoke('get_proxy_env')) as { https?: string; http?: string; noProxy?: string };
        setProxyHttps(res?.https ?? '');
        setProxyNoProxy(res?.noProxy ?? '');
      } catch {
        // ignore
      }
    })();
  }, []);

  const handleFirewallToggle = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const disabled = event.target.checked;
      setFirewallDisabledPref(disabled);
      if (!hasTauriBridge()) return;
      try {
        await tauriInvoke('set_env_var', { name: 'UICP_DISABLE_FIREWALL', value: disabled ? '1' : null });
        useAppStore.getState().pushToast({ variant: 'info', message: disabled ? 'Container firewall disabled' : 'Container firewall enabled' });
      } catch (err) {
        useAppStore.getState().pushToast({ variant: 'error', message: `Toggle failed: ${(err as Error)?.message ?? String(err)}` });
      }
    },
    [setFirewallDisabledPref],
  );

  const handleStrictCapsToggle = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const enabled = event.target.checked;
      setStrictCapsPref(enabled);
      if (!hasTauriBridge()) return;
      try {
        await tauriInvoke('set_env_var', { name: 'UICP_STRICT_CAPS', value: enabled ? '1' : null });
        useAppStore.getState().pushToast({ variant: 'info', message: enabled ? 'Strict capability minimization enabled' : 'Strict capability minimization disabled' });
      } catch (err) {
        useAppStore.getState().pushToast({ variant: 'error', message: `Toggle failed: ${(err as Error)?.message ?? String(err)}` });
      }
    },
    [setStrictCapsPref],
  );
  const handleApplyProxy = useCallback(async () => {
    if (!hasTauriBridge()) {
      useAppStore.getState().pushToast({ variant: 'error', message: 'Proxy apply requires the desktop runtime' });
      return;
    }
    try {
      await tauriInvoke('set_proxy_env', { https: proxyHttps, no_proxy: proxyNoProxy });
      useAppStore.getState().pushToast({ variant: 'success', message: 'Proxy settings applied' });
    } catch (err) {
      useAppStore.getState().pushToast({ variant: 'error', message: `Apply failed: ${(err as Error)?.message ?? String(err)}` });
    }
  }, [proxyHttps, proxyNoProxy]);

  // Resolved paths (dev-only UI)
  const [resolvedPaths, setResolvedPaths] = useState<Record<ProviderName, { exe?: string; via?: string }>>({} as Record<ProviderName, { exe?: string; via?: string }>);
  const refreshResolved = useCallback(async (provider: ProviderName) => {
    if (!hasTauriBridge()) return;
    try {
      const res = (await tauriInvoke('provider_resolve', { provider })) as { exe?: string; via?: string };
      setResolvedPaths((prev) => ({ ...prev, [provider]: { exe: res?.exe, via: res?.via } }));
    } catch (err) {
      useAppStore.getState().pushToast({ variant: 'error', message: `Resolve failed: ${(err as Error)?.message ?? String(err)}` });
    }
  }, []);
  useEffect(() => {
    if (!devMode || !hasTauriBridge()) return;
    void refreshResolved('codex');
    void refreshResolved('claude');
  }, [devMode, refreshResolved]);

  // Wizard: API key inputs
  const [openaiKey, setOpenaiKey] = useState<string>('');
  const [anthropicKey, setAnthropicKey] = useState<string>('');
  const [openrouterKey, setOpenrouterKey] = useState<string>('');
  const [ollamaKey, setOllamaKey] = useState<string>('');
  const saveProviderKeyToStore = useKeystore((state) => state.saveProviderKey);
  const handleSaveProviderKey = useCallback(
    async (provider: 'openai' | 'anthropic' | 'openrouter' | 'ollama', key: string) => {
      if (!hasTauriBridge()) {
        useAppStore.getState().pushToast({ variant: 'error', message: 'Saving keys requires the desktop runtime' });
        return;
      }
      if (keystoreLocked) {
        useAppStore.getState().pushToast({ variant: 'error', message: 'Unlock keystore first' });
        return;
      }
      try {
        const ok = await saveProviderKeyToStore(provider, key);
        if (ok) {
          useAppStore.getState().pushToast({ variant: 'success', message: `${provider} key saved to keystore` });
        } else {
          useAppStore.getState().pushToast({ variant: 'error', message: `Failed to save ${provider} key` });
        }
      } catch (err) {
        useAppStore.getState().pushToast({ variant: 'error', message: `Save failed: ${(err as Error)?.message ?? String(err)}` });
      }
    },
    [keystoreLocked, saveProviderKeyToStore],
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

  const handleStrictHealth = useCallback(async () => {
    if (!hasTauriBridge()) {
      useAppStore
        .getState()
        .pushToast({ variant: 'error', message: 'Health check requires the desktop runtime' });
      return;
    }
    try {
      await tauriInvoke('set_env_var', { name: 'UICP_HEALTH_STRICT', value: '1' });
      await handleProviderHealth('codex');
      await handleProviderHealth('claude');
    } catch (err) {
      useAppStore.getState().pushToast({ variant: 'error', message: `Strict health failed: ${(err as Error)?.message ?? String(err)}` });
    }
  }, [handleProviderHealth]);

  const handleStandardHealth = useCallback(async () => {
    if (!hasTauriBridge()) {
      useAppStore
        .getState()
        .pushToast({ variant: 'error', message: 'Health check requires the desktop runtime' });
      return;
    }
    try {
      // Unset strict mode and run non-strict provider health checks
      await tauriInvoke('set_env_var', { name: 'UICP_HEALTH_STRICT', value: null });
      await handleProviderHealth('codex');
      await handleProviderHealth('claude');
    } catch (err) {
      useAppStore
        .getState()
        .pushToast({ variant: 'error', message: `Standard health failed: ${(err as Error)?.message ?? String(err)}` });
    }
  }, [handleProviderHealth]);

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

  const updateProfileConfig = useCallback(
    async (role: 'planner' | 'actor', nextState: ProfileEditorState) => {
      if (!agentsConfig) return;
      await persistAgentsConfig((draft) => {
        const profile = draft.profiles?.[role];
        if (!profile) return;
        profile.provider = nextState.provider;
        profile.mode = nextState.mode;
        profile.preset_model = nextState.presetModel.trim() || undefined;
        profile.custom_model = nextState.customModel.trim() || undefined;
        profile.model = nextState.mode === 'custom' ? nextState.customModel.trim() : nextState.presetModel.trim();
      });
    },
    [agentsConfig, persistAgentsConfig],
  );

  // Per-role provider change no longer exposed in UI

  const handlePlannerModeChange = useCallback(
    async (mode: ProfileMode) => {
      const nextState: ProfileEditorState = {
        ...plannerState,
        mode,
        presetModel: mode === 'preset' ? plannerState.presetModel || plannerPresets[0]?.id || '' : plannerState.presetModel,
      };
      setPlannerState(nextState);
      if (mode === 'custom') {
        const error = validateCustomModel(plannerState.provider, plannerState.customModel);
        setPlannerCustomError(error);
        if (error) return;
      }
      try {
        await updateProfileConfig('planner', nextState);
      } catch {
        // toast emitted upstream
      }
    },
    [plannerState, plannerPresets, updateProfileConfig],
  );

  const handlePlannerPresetChange = useCallback(
    async (value: string) => {
      const nextState: ProfileEditorState = { ...plannerState, presetModel: value, mode: 'preset' };
      setPlannerState(nextState);
      try {
        await updateProfileConfig('planner', nextState);
      } catch {
        // toast emitted upstream
      }
    },
    [plannerState, updateProfileConfig],
  );

  const handlePlannerCustomChange = useCallback((value: string) => {
    setPlannerState((prev) => ({ ...prev, customModel: value }));
    setPlannerCustomError(null);
  }, []);

  const handlePlannerCustomBlur = useCallback(async () => {
    const error = validateCustomModel(plannerState.provider, plannerState.customModel);
    setPlannerCustomError(error);
    if (error) return;
    const nextState: ProfileEditorState = { ...plannerState, mode: 'custom' };
    setPlannerState(nextState);
    try {
      await updateProfileConfig('planner', nextState);
    } catch {
      // toast emitted upstream
    }
  }, [plannerState, updateProfileConfig]);

  // Per-role provider change no longer exposed in UI

  const handleActorModeChange = useCallback(
    async (mode: ProfileMode) => {
      const nextState: ProfileEditorState = {
        ...actorState,
        mode,
        presetModel: mode === 'preset' ? actorState.presetModel || actorPresets[0]?.id || '' : actorState.presetModel,
      };
      setActorState(nextState);
      if (mode === 'custom') {
        const error = validateCustomModel(actorState.provider, actorState.customModel);
        setActorCustomError(error);
        if (error) return;
      }
      try {
        await updateProfileConfig('actor', nextState);
      } catch {
        // toast emitted upstream
      }
    },
    [actorState, actorPresets, updateProfileConfig],
  );

  const handleActorPresetChange = useCallback(
    async (value: string) => {
      const nextState: ProfileEditorState = { ...actorState, presetModel: value, mode: 'preset' };
      setActorState(nextState);
      try {
        await updateProfileConfig('actor', nextState);
      } catch {
        // toast emitted upstream
      }
    },
    [actorState, updateProfileConfig],
  );

  const handleActorCustomChange = useCallback((value: string) => {
    setActorState((prev) => ({ ...prev, customModel: value }));
    setActorCustomError(null);
  }, []);

  const handleActorCustomBlur = useCallback(async () => {
    const error = validateCustomModel(actorState.provider, actorState.customModel);
    setActorCustomError(error);
    if (error) return;
    const nextState: ProfileEditorState = { ...actorState, mode: 'custom' };
    setActorState(nextState);
    try {
      await updateProfileConfig('actor', nextState);
    } catch {
      // toast emitted upstream
    }
  }, [actorState, updateProfileConfig]);

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
      setRunBothByDefault(event.target.checked);
    },
    [setRunBothByDefault],
  );

  const handleDefaultProviderChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setDefaultProviderPreference(event.target.value as CodegenDefaultProvider);
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

  const handleProviderInstall = useCallback(
    async (provider: ProviderName) => {
      const info = PROVIDER_INFO[provider];
      if (!hasTauriBridge()) {
        useAppStore
          .getState()
          .pushToast({ variant: 'error', message: `${info.label} install requires the desktop runtime` });
        return;
      }
      setInstallingProvider(provider);
      try {
        const res = (await tauriInvoke('provider_install', { provider })) as
          | { ok?: boolean; exe?: string; via?: string; detail?: string }
          | undefined;
        if (res?.ok) {
          const via = res?.via ? ` via ${res.via}` : '';
          const exe = res?.exe ? ` (${res.exe})` : '';
          useAppStore
            .getState()
            .pushToast({ variant: 'success', message: `${info.label} updated${via}${exe}` });
          void handleProviderHealth(provider);
          if (devMode) {
            void refreshResolved(provider);
          }
        } else {
          const detail = res?.detail?.trim();
          useAppStore
            .getState()
            .pushToast({
              variant: 'error',
              message: detail && detail.length > 0 ? `${info.label} install failed: ${detail}` : `${info.label} install failed`,
            });
        }
      } catch (err) {
        const message = (err as Error)?.message ?? String(err);
        useAppStore
          .getState()
          .pushToast({ variant: 'error', message: `${info.label} install failed: ${message}` });
      } finally {
        setInstallingProvider((current) => (current === provider ? null : current));
      }
    },
    [devMode, handleProviderHealth, refreshResolved],
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
        {/* Header with Advanced Toggle */}
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-800">Agent Configuration</h2>
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            {showAdvanced ? '← Hide Advanced' : 'Show Advanced →'}
          </button>
        </div>

        {/* Simplified LLM Configuration (Primary) */}
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 text-sm font-semibold text-slate-700">LLM Provider & Model</div>
          <div className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Provider</label>
              <select
                value={provider}
                onChange={(e) => setProviderModel(e.target.value as ProviderKey, model)}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none"
              >
                <option value="ollama-cloud">Ollama Cloud (default)</option>
                <option value="openrouter">OpenRouter</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="ollama-local">Ollama Local</option>
              </select>
              <p className="mt-1 text-xs text-slate-500">
                {provider === 'ollama-cloud' && 'Hosted models with cloud API key'}
                {provider === 'openrouter' && 'Access to 100+ models via unified API'}
                {provider === 'openai' && 'GPT models from OpenAI'}
                {provider === 'anthropic' && 'Claude models from Anthropic'}
                {provider === 'ollama-local' && 'Local Ollama daemon (requires installation)'}
              </p>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    const map = (k: ProviderKey): string | null => {
                      if (k === 'openai') return 'openai';
                      if (k === 'anthropic') return 'anthropic';
                      if (k === 'openrouter') return 'openrouter';
                      if (k === 'ollama-cloud') return 'ollama';
                      if (k === 'ollama-local') return null;
                      return null;
                    };
                    const mapped = map(provider as ProviderKey);
                    if (!mapped) {
                      setAuthPreflight({ state: 'na' });
                      return;
                    }
                    if (!bridgeAvailable) {
                      useAppStore.getState().pushToast({ variant: 'error', message: 'Desktop runtime required' });
                      return;
                    }
                    setAuthPreflight({ state: 'checking' });
                    try {
                      const res = (await tauriInvoke('auth_preflight', { provider: mapped })) as { ok?: boolean; code?: string; detail?: string } | undefined;
                      if (res?.ok) {
                        setAuthPreflight({ state: 'ok', code: res.code ?? 'OK' });
                      } else {
                        setAuthPreflight({ state: 'error', code: res?.code ?? 'AuthMissing', detail: res?.detail });
                      }
                    } catch (err) {
                      const msg = (err as Error)?.message ?? String(err);
                      setAuthPreflight({ state: 'error', code: 'Error', detail: msg });
                    }
                  }}
                  disabled={!bridgeAvailable}
                  className="rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Auth Preflight
                </button>
                {authPreflight.state !== 'idle' && (
                  <span
                    className={
                      authPreflight.state === 'ok'
                        ? 'text-xs font-medium text-emerald-600'
                        : authPreflight.state === 'checking'
                        ? 'text-xs font-medium text-slate-600'
                        : authPreflight.state === 'na'
                        ? 'text-xs font-medium text-slate-500'
                        : 'text-xs font-medium text-rose-600'
                    }
                  >
                    {authPreflight.state === 'ok' && (authPreflight.code || 'OK')}
                    {authPreflight.state === 'checking' && 'Checking…'}
                    {authPreflight.state === 'na' && 'Not applicable'}
                    {authPreflight.state === 'error' && (authPreflight.code || 'Error')}
                  </span>
                )}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Model</label>
              <input
                type="text"
                value={model}
                onChange={(e) => setProviderModel(provider, e.target.value)}
                placeholder={provider === 'openrouter' ? 'e.g., anthropic/claude-sonnet-4.5' : provider === 'ollama-cloud' ? 'e.g., llama3.1-405b-instruct' : 'e.g., gpt-5'}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none"
              />
              <p className="mt-1 text-xs text-slate-500">
                {provider === 'openrouter' && 'Use provider/model-name format (e.g., openai/gpt-5, meta-llama/llama-3.3-70b)'}
                {provider === 'ollama-cloud' && 'Cloud-hosted model ID'}
                {provider === 'ollama-local' && 'Model name from your local Ollama installation'}
              </p>
            </div>
            {provider === 'ollama-cloud' && bridgeAvailable && (
              <label className="flex items-start gap-3 rounded-md border border-slate-200 bg-slate-50 p-3">
                <input
                  type="checkbox"
                  checked={allowLocalOllama}
                  disabled={localFallbackLoading}
                  onChange={async (e) => {
                    const allow = e.target.checked;
                    setLocalFallbackLoading(true);
                    try {
                      setAllowLocalOllama(allow);
                      await tauriInvoke('set_allow_local_opt_in', { allow });
                      useAppStore.getState().pushToast({
                        variant: 'info',
                        message: allow ? 'Local Ollama fallback enabled' : 'Local Ollama fallback disabled',
                      });
                    } catch (err) {
                      setAllowLocalOllama(!allow);
                      useAppStore.getState().pushToast({
                        variant: 'error',
                        message: `Failed to toggle local fallback: ${(err as Error)?.message ?? String(err)}`,
                      });
                    } finally {
                      setLocalFallbackLoading(false);
                    }
                  }}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500 disabled:cursor-not-allowed"
                />
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium text-slate-700">Allow local Ollama fallback when available</span>
                  <span className="text-xs text-slate-500">
                    If a local Ollama daemon is detected, use it instead of cloud (no API key required)
                  </span>
                </div>
              </label>
            )}
          </div>
        </div>

        {/* Planner Configuration (Advanced) */}
        {showAdvanced && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 text-sm font-semibold text-slate-700">Planner (Reasoning & Planning)</div>
          <div className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Profile</label>
              <select
                value={plannerProfileKey}
                onChange={handlePlannerChange}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none"
              >
                {plannerProfiles.map((profile) => (
                  <option key={profile.key} value={profile.key}>
                    {profile.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-500">{plannerProfile.description}</p>
            </div>
            <div>
              <div className="mb-2 text-xs font-medium text-slate-600">Model Selection</div>
              <ModelSelector
                mode={plannerState.mode}
                provider={globalProvider}
                presets={plannerPresets}
                presetValue={plannerState.presetModel}
                customValue={plannerState.customModel}
                customPlaceholder={customModelPlaceholder(globalProvider, 'planner')}
                customError={plannerCustomError}
                disabled={!globalProvider}
                onModeChange={handlePlannerModeChange}
                onPresetChange={handlePlannerPresetChange}
                onCustomChange={handlePlannerCustomChange}
                onCustomBlur={handlePlannerCustomBlur}
              />
            </div>
            {plannerProfile.key === 'gpt-oss' && (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <label className="mb-1 block text-xs font-medium text-slate-600">Reasoning Effort</label>
                <select
                  value={plannerReasoningEffort}
                  onChange={handlePlannerReasoningChange}
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                >
                  {REASONING_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-slate-500">
                  {REASONING_OPTIONS.find((option) => option.value === plannerReasoningEffort)?.helper ??
                    'Choose reasoning depth'}
                </p>
              </div>
            )}
          </div>
        </div>
        )}

          {/* Actor Configuration (Advanced) */}
        {showAdvanced && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 text-sm font-semibold text-slate-700">Actor (Execution & Implementation)</div>
          <div className="flex flex-col gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">Profile</label>
              <select
                value={actorProfileKey}
                onChange={handleActorChange}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none"
              >
                {actorProfiles.map((profile) => (
                  <option key={profile.key} value={profile.key}>
                    {profile.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-500">{actorProfile.description}</p>
            </div>
            <div>
              <div className="mb-2 text-xs font-medium text-slate-600">Model Selection</div>
              <ModelSelector
                mode={actorState.mode}
                provider={globalProvider}
                presets={actorPresets}
                presetValue={actorState.presetModel}
                customValue={actorState.customModel}
                customPlaceholder={customModelPlaceholder(globalProvider, 'actor')}
                customError={actorCustomError}
                disabled={!globalProvider}
                onModeChange={handleActorModeChange}
                onPresetChange={handleActorPresetChange}
                onCustomChange={handleActorCustomChange}
                onCustomBlur={handleActorCustomBlur}
              />
            </div>
            {actorProfile.key === 'gpt-oss' && (
              <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
                <label className="mb-1 block text-xs font-medium text-slate-600">Reasoning Effort</label>
                <select
                  value={actorReasoningEffort}
                  onChange={handleActorReasoningChange}
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 focus:outline-none"
                >
                  {REASONING_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-slate-500">
                  {REASONING_OPTIONS.find((option) => option.value === actorReasoningEffort)?.helper ??
                    'Choose reasoning depth'}
                </p>
              </div>
            )}
          </div>
        </div>
        )}

        {/* System Settings */}
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 text-sm font-semibold text-slate-700">System Settings</div>
          <div className="flex flex-col gap-3">
            <label className="flex items-start gap-3 rounded-md border border-slate-200 bg-slate-50 p-3">
              <input
                type="checkbox"
                checked={plannerTwoPhaseEnabled}
                onChange={handleTwoPhaseToggle}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
              />
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-slate-700">Two-Phase Planner</span>
                <span className="text-xs text-slate-500">
                  Generate structured TaskSpec before final plan (experimental)
                </span>
              </div>
            </label>
            <label className="flex items-start gap-3 rounded-md border border-slate-200 bg-slate-50 p-3">
              <input
                type="checkbox"
                checked={safeMode}
                onChange={handleSafeModeToggle}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-rose-600 focus:ring-rose-500"
              />
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-slate-700">Safe Mode</span>
                <span className="text-xs text-slate-500">
                  Disable all code generation (emergency kill switch)
                </span>
              </div>
            </label>
          </div>
        </div>
        <div className="rounded border border-slate-200 bg-slate-50/30 p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Secrets (Keystore)</div>
          <div className="flex flex-col gap-3 text-sm">
            {keystoreLocked ? (
              <div className="flex flex-col gap-2">
                <div className="text-rose-600">Locked</div>
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    placeholder="Enter passphrase"
                    className="flex-1 rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-inner focus:border-slate-400 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      if (!passphrase.trim()) return;
                      const ok = await unlockKeystore(passphrase);
                      if (!ok) {
                        useAppStore.getState().pushToast({ variant: 'error', message: keystoreError ?? 'Unlock failed' });
                      } else {
                        setPassphrase('');
                        useAppStore.getState().pushToast({ variant: 'success', message: 'Keystore unlocked' });
                      }
                    }}
                    disabled={keystoreBusy || !passphrase.trim()}
                    className="rounded border border-slate-300 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {keystoreBusy ? 'Unlocking…' : 'Unlock'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <div className="text-emerald-600">Unlocked</div>
                <div className="text-slate-600">Method: {keystoreMethod ?? 'passphrase'}</div>
                <div className="text-slate-600">Auto-lock in {formatTtl(keystoreTtl)}</div>
                <button
                  type="button"
                  onClick={() => quickLockKeystore()}
                  className="ml-auto rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-100"
                >
                  Quick Lock
                </button>
              </div>
            )}
          </div>
        </div>

        {showAdvanced && (
        <div className="rounded border border-slate-200 bg-slate-50/30 p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Connect Providers (Wizard)</div>
          <div className="grid grid-cols-1 gap-2 text-xs text-slate-600">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">Step 1:</span>
              <span>Detect CLI and version with strict policy (httpjail required unless using container)</span>
              <button
                type="button"
                onClick={handleStrictHealth}
                disabled={!bridgeAvailable}
                className="ml-auto rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Run Strict Health
              </button>
              <button
                type="button"
                onClick={handleStandardHealth}
                disabled={!bridgeAvailable}
                className="rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Run Standard Health
              </button>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-semibold">Step 2:</span>
              <span>Ensure CLI tooling is installed for secure defaults</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">Step 3:</span>
              <span>Save API keys to Keystore</span>
            </div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-4">
              <label className="flex flex-col gap-1">
                <span className="font-semibold uppercase tracking-wide text-slate-500">OPENAI_API_KEY</span>
                <input
                  type="password"
                  value={openaiKey}
                  onChange={(e) => setOpenaiKey(e.target.value)}
                  placeholder="sk-..."
                  className="rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-inner focus:border-slate-400 focus:outline-none"
                />
                <div>
                  <button
                    type="button"
                    onClick={() => handleSaveProviderKey('openai', openaiKey)}
                    disabled={!bridgeAvailable || !openaiKey.trim()}
                    className="mt-1 rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Save Key
                  </button>
                </div>
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-semibold uppercase tracking-wide text-slate-500">ANTHROPIC_API_KEY</span>
                <input
                  type="password"
                  value={anthropicKey}
                  onChange={(e) => setAnthropicKey(e.target.value)}
                  placeholder="anthropic-..."
                  className="rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-inner focus:border-slate-400 focus:outline-none"
                />
                <div>
                  <button
                    type="button"
                    onClick={() => handleSaveProviderKey('anthropic', anthropicKey)}
                    disabled={!bridgeAvailable || !anthropicKey.trim()}
                    className="mt-1 rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Save Key
                  </button>
                </div>
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-semibold uppercase tracking-wide text-slate-500">OPENROUTER_API_KEY</span>
                <input
                  type="password"
                  value={openrouterKey}
                  onChange={(e) => setOpenrouterKey(e.target.value)}
                  placeholder="sk-or-..."
                  className="rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-inner focus:border-slate-400 focus:outline-none"
                />
                <div>
                  <button
                    type="button"
                    onClick={() => handleSaveProviderKey('openrouter', openrouterKey)}
                    disabled={!bridgeAvailable || !openrouterKey.trim()}
                    className="mt-1 rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Save Key
                  </button>
                </div>
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-semibold uppercase tracking-wide text-slate-500">OLLAMA_API_KEY</span>
                <input
                  type="password"
                  value={ollamaKey}
                  onChange={(e) => setOllamaKey(e.target.value)}
                  placeholder="ol-..."
                  className="rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-inner focus:border-slate-400 focus:outline-none"
                />
                <div>
                  <button
                    type="button"
                    onClick={() => handleSaveProviderKey('ollama', ollamaKey)}
                    disabled={!bridgeAvailable || !ollamaKey.trim()}
                    className="mt-1 rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    Save Key
                  </button>
                </div>
              </label>
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-slate-600">Fallbacks</div>
              <div className="flex flex-wrap gap-1">
                {(agentsConfig?.profiles?.planner?.fallbacks ?? []).map((fb, i) => (
                  <span key={`p-fb-${i}`} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700">
                    {fb}
                    <button
                      type="button"
                      onClick={() => void handleRemoveFallback('planner', i)}
                      className="ml-1 rounded px-1 text-[10px] text-slate-500 hover:bg-slate-200"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="text"
                  value={newPlannerFallback}
                  onChange={(e) => setNewPlannerFallback(e.target.value)}
                  placeholder="provider:aliasOrId"
                  className="flex-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 shadow-sm focus:border-emerald-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void handleAddFallback('planner', newPlannerFallback)}
                  className="rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
                >
                  Add
                </button>
              </div>
            </div>
            <div className="mt-3">
              <div className="mb-1 text-xs font-medium text-slate-600">Actor Fallbacks</div>
              <div className="flex flex-wrap gap-1">
                {(agentsConfig?.profiles?.actor?.fallbacks ?? []).map((fb, i) => (
                  <span key={`a-fb-${i}`} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700">
                    {fb}
                    <button
                      type="button"
                      onClick={() => void handleRemoveFallback('actor', i)}
                      className="ml-1 rounded px-1 text-[10px] text-slate-500 hover:bg-slate-200"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="text"
                  value={newActorFallback}
                  onChange={(e) => setNewActorFallback(e.target.value)}
                  placeholder="provider:aliasOrId"
                  className="flex-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 shadow-sm focus:border-emerald-500 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => void handleAddFallback('actor', newActorFallback)}
                  className="rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
                >
                  Add
                </button>
              </div>
            </div>
          </div>
        </div>
        )}
        {showAdvanced && (
        <div className="rounded border border-slate-200 bg-slate-50/30 p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Container Security</div>
          <label className="flex items-center gap-3 rounded border border-slate-200 bg-white/80 p-3 text-sm">
            <input
              type="checkbox"
              checked={firewallDisabled}
              onChange={handleFirewallToggle}
              className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
            />
            <div className="flex flex-col gap-1">
              <span className="font-medium text-slate-700">Disable container firewall (iptables)</span>
              <span className="text-xs text-slate-500">Skips iptables egress rules and removes cap-adds. httpjail host/method allowlist remains in effect.</span>
            </div>
          </label>
          <label className="mt-2 flex items-center gap-3 rounded border border-slate-200 bg-white/80 p-3 text-sm">
            <input
              type="checkbox"
              checked={strictCaps}
              onChange={handleStrictCapsToggle}
              className="h-4 w-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
            />
            <div className="flex flex-col gap-1">
              <span className="font-medium text-slate-700">Strict capability minimization</span>
              <span className="text-xs text-slate-500">Never add NET_ADMIN/NET_RAW to containers. Use when firewall is disabled or external egress control is enforced.</span>
            </div>
          </label>
        </div>
        )}
        {showAdvanced && (
        <div className="rounded border border-slate-200 bg-slate-50/30 p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Feature Flags (runtime)</div>
          <ul className="list-disc pl-5 text-xs text-slate-600">
            {Object.entries(getActiveFlags()).map(([k, v]) => (
              <li key={k}>
                <span className="font-mono">{k}</span>: {v ? 'on' : 'off'}
              </li>
            ))}
          </ul>
        </div>
        )}
        {showAdvanced && (
        <div className="rounded border border-slate-200 bg-slate-50/30 p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Code Providers</div>
          <div className="flex flex-col gap-3">
            {providerEntries.map(({ provider, status }) => {
              const info = PROVIDER_INFO[provider];
              const meta = describeStatus(status);
              const detail = normalizeDetail(status.detail);
              const installing = installingProvider === provider;
              const connecting = status.state === 'connecting' || installing;
              const checking = status.state === 'checking' || installing;
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
                  <div className="mt-2 text-xs">
                    <label className="flex flex-col gap-1">
                      <span className="font-semibold uppercase tracking-wide text-slate-500">Model Override</span>
                      <input
                        type="text"
                        value={provider === 'codex' ? (codexModel ?? '') : (claudeModel ?? '')}
                        onChange={(e) =>
                          provider === 'codex' ? setCodexModel(e.target.value) : setClaudeModel(e.target.value)
                        }
                        placeholder={provider === 'codex' ? 'e.g. gpt-5-codex' : 'e.g. claude-3.5' }
                        className="rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-inner focus:border-slate-400 focus:outline-none"
                      />
                      <span className="text-slate-500">Applies via CLI <code>--model</code>; leave blank to use defaults.</span>
                    </label>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => handleProviderInstall(provider)}
                      disabled={installing || !bridgeAvailable}
                      className="rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Install / Update
                    </button>
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
                    {devMode && (
                      <button
                        type="button"
                        onClick={() => refreshResolved(provider)}
                        disabled={!bridgeAvailable || installing}
                        className="rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Show Resolved Path
                      </button>
                    )}
                  </div>
                  {devMode && resolvedPaths?.[provider]?.exe && (
                    <div className="mt-1 text-[11px] text-slate-500">
                      Path: <span className="font-mono">{resolvedPaths[provider]?.exe}</span>
                      {resolvedPaths[provider]?.via ? (
                        <span> (via {resolvedPaths[provider]?.via})</span>
                      ) : null}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="mt-3 flex flex-col gap-2 text-xs text-slate-600">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={runBothByDefault}
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
                disabled={runBothByDefault}
              >
                <option value="auto">Auto (planner preference)</option>
                <option value="codex">OpenAI Codex</option>
                <option value="claude">Anthropic Claude</option>
              </select>
              <span>
                {runBothByDefault
                  ? 'Auto mode is active while both providers are allowed.'
                  : 'When a single provider is enabled, needs.code will request this provider.'}
              </span>
            </label>
            {!bridgeAvailable && (
              <span className="text-slate-500">
                This provider requires interactive login and will open a new window or dialog. Keep the Assistant window visible so you can approve the request quickly.
              </span>
            )}
          </div>
        </div>
        )}
        {showAdvanced && (
          <div className="rounded border border-slate-200 bg-white/60 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Network (Proxy)</div>
            <div className="flex flex-col gap-2 text-xs text-slate-600">
              <label className="flex flex-col gap-1">
                <span className="font-semibold uppercase tracking-wide text-slate-500">HTTPS Proxy</span>
                <input
                  type="text"
                  value={proxyHttps}
                  onChange={(e) => setProxyHttps(e.target.value)}
                  placeholder="http://host:port"
                  className="rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-inner focus:border-slate-400 focus:outline-none"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="font-semibold uppercase tracking-wide text-slate-500">No Proxy</span>
                <input
                  type="text"
                  value={proxyNoProxy}
                  onChange={(e) => setProxyNoProxy(e.target.value)}
                  placeholder="localhost,127.0.0.1"
                  className="rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 shadow-inner focus:border-slate-400 focus:outline-none"
                />
              </label>
              <div>
                <button
                  type="button"
                  onClick={handleApplyProxy}
                  disabled={!bridgeAvailable}
                  className="rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Apply Proxy
                </button>
                <span className="ml-2 text-slate-500">Affects new CLI runs (login/health/jobs)</span>
              </div>
            </div>
          </div>
        )}

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

        {showAdvanced && (
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
        )}

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

