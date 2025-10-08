import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangeEvent } from 'react';
import DesktopWindow from './DesktopWindow';
import { useAppStore } from '../state/app';
import {
  listPlannerProfiles,
  listActorProfiles,
  getPlannerProfile,
  getActorProfile,
} from '../lib/llm/profiles';
import type { PlannerProfileKey, ActorProfileKey } from '../lib/llm/profiles';
import { invoke } from '@tauri-apps/api/core';

const plannerProfiles = listPlannerProfiles();
const actorProfiles = listActorProfiles();

const AgentSettingsWindow = () => {
  const agentSettingsOpen = useAppStore((state) => state.agentSettingsOpen);
  const setAgentSettingsOpen = useAppStore((state) => state.setAgentSettingsOpen);
  const plannerProfileKey = useAppStore((state) => state.plannerProfileKey);
  const actorProfileKey = useAppStore((state) => state.actorProfileKey);
  const setPlannerProfileKey = useAppStore((state) => state.setPlannerProfileKey);
  const setActorProfileKey = useAppStore((state) => state.setActorProfileKey);

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

  const handleClose = useCallback(() => setAgentSettingsOpen(false), [setAgentSettingsOpen]);

  // Modules directory info (Wasm compute)
  const [modulesDir, setModulesDir] = useState<string>('');
  const [modulesCount, setModulesCount] = useState<number>(0);
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const info = await invoke('get_modules_info');
        if (!mounted) return;
        const obj = info as { dir?: string; entries?: number };
        setModulesDir(obj.dir ?? '');
        setModulesCount(obj.entries ?? 0);
      } catch {
        // ignore
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);
  const handleCopyModulesPath = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(modulesDir);
    } catch {
      // ignore
    }
  }, [modulesDir]);
  const handleOpenModulesFolder = useCallback(async () => {
    try {
      if (!modulesDir) return;
      await invoke('open_path', { path: modulesDir });
    } catch {
      // ignore
    }
  }, [modulesDir]);

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
          Select which model profiles power the planner (reasoning &amp; plan generation) and actor (batch builder). DeepSeek and
          Qwen remain the default pairing.
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
