import { useEffect, useMemo, useState } from 'react';
import DesktopWindow from './DesktopWindow';
import { useAppStore } from '../state/app';
import { getEffectivePolicy, setRuntimePolicy } from '../lib/security/policyLoader';
import { open } from '@tauri-apps/plugin-dialog';

export type FsScope = {
  description?: string;
  read?: string[];
  write?: string[];
};

const FilesystemScopesWindow = () => {
  const openFlag = useAppStore((s) => s.filesystemScopesOpen);
  const setOpenFlag = useAppStore((s) => s.setFilesystemScopesOpen);

  const [scopes, setScopes] = useState<FsScope[]>([]);

  const refresh = () => {
    try {
      const pol = getEffectivePolicy();
      setScopes([...(pol.filesystem.scopes ?? [])]);
    } catch {
      setScopes([]);
    }
  };

  useEffect(() => { if (openFlag) refresh(); }, [openFlag]);

  const addScope = () => {
    setScopes((prev) => [...prev, { description: 'Project files', read: [], write: [] }]);
  };

  const removeScope = (index: number) => {
    setScopes((prev) => prev.filter((_, i) => i !== index));
  };

  const pickFolder = async (): Promise<string | null> => {
    try {
      const result = await open({ directory: true, multiple: false });
      if (typeof result === 'string' && result.trim().length > 0) return result;
      return null;
    } catch {
      return null;
    }
  };

  const addReadPath = async (index: number) => {
    const p = await pickFolder();
    if (!p) return;
    setScopes((prev) => {
      const next = [...prev];
      const s = { ...(next[index] ?? { read: [], write: [] }) };
      s.read = Array.from(new Set([...(s.read ?? []), p]));
      next[index] = s;
      return next;
    });
  };

  const addWritePath = async (index: number) => {
    const p = await pickFolder();
    if (!p) return;
    setScopes((prev) => {
      const next = [...prev];
      const s = { ...(next[index] ?? { read: [], write: [] }) };
      s.write = Array.from(new Set([...(s.write ?? []), p]));
      next[index] = s;
      return next;
    });
  };

  const removePath = (index: number, kind: 'read' | 'write', path: string) => {
    setScopes((prev) => {
      const next = [...prev];
      const s = { ...(next[index] ?? { read: [], write: [] }) };
      const list = (s[kind] ?? []).filter((p) => p !== path);
      s[kind] = list;
      next[index] = s;
      return next;
    });
  };

  const save = () => {
    try {
      const pol = getEffectivePolicy();
      const next = { ...pol };
      next.filesystem.scopes = scopes.map((s) => ({
        description: s.description,
        read: s.read && s.read.length ? s.read : undefined,
        write: s.write && s.write.length ? s.write : undefined,
      }));
      setRuntimePolicy(next);
      refresh();
    } catch { /* non-fatal */ }
  };

  const hasScopes = useMemo(() => scopes.some((s) => (s.read && s.read.length) || (s.write && s.write.length)), [scopes]);

  return (
    <DesktopWindow
      id="filesystem-scopes"
      title="Filesystem Scopes"
      isOpen={openFlag}
      onClose={() => setOpenFlag(false)}
      initialPosition={{ x: 480, y: 180 }}
      width={560}
      minHeight={420}
    >
      <div className="flex h-full flex-col gap-3 text-xs">
        <div className="flex items-center gap-2">
          <button type="button" className="rounded border px-2 py-1" onClick={addScope}>Add Scope</button>
          <button type="button" className="ml-auto rounded bg-slate-900 px-2 py-1 text-white" onClick={save} disabled={!hasScopes}>Save</button>
        </div>
        <div className="flex-1 space-y-3 overflow-auto">
          {scopes.map((s, idx) => (
            <section key={idx} className="rounded border bg-white p-2">
              <div className="mb-2 flex items-center gap-2">
                <input
                  className="w-64 rounded border px-2 py-1"
                  placeholder="Description"
                  value={s.description ?? ''}
                  onChange={(e) => setScopes((prev) => {
                    const next = [...prev];
                    next[idx] = { ...next[idx], description: e.target.value };
                    return next;
                  })}
                />
                <button type="button" className="ml-auto rounded px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-200" onClick={() => removeScope(idx)}>Remove scope</button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-semibold text-slate-700">Read</span>
                    <button type="button" className="rounded border px-2 py-0.5" onClick={() => void addReadPath(idx)}>Add folder</button>
                  </div>
                  <ul className="space-y-1">
                    {(s.read ?? []).map((p) => (
                      <li key={p} className="flex items-center justify-between rounded border bg-slate-50 px-2 py-1 font-mono">
                        <span className="truncate">{p}</span>
                        <button type="button" className="rounded px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-200" onClick={() => removePath(idx, 'read', p)}>Remove</button>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-semibold text-slate-700">Write</span>
                    <button type="button" className="rounded border px-2 py-0.5" onClick={() => void addWritePath(idx)}>Add folder</button>
                  </div>
                  <ul className="space-y-1">
                    {(s.write ?? []).map((p) => (
                      <li key={p} className="flex items-center justify-between rounded border bg-slate-50 px-2 py-1 font-mono">
                        <span className="truncate">{p}</span>
                        <button type="button" className="rounded px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-200" onClick={() => removePath(idx, 'write', p)}>Remove</button>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </section>
          ))}
          {scopes.length === 0 && (
            <div className="rounded border border-dashed bg-slate-50 p-4 text-center text-slate-500">
              No scopes configured. Click &ldquo;Add Scope&rdquo; to add read/write folder access for this project.
            </div>
          )}
        </div>
      </div>
    </DesktopWindow>
  );
};

export default FilesystemScopesWindow;
