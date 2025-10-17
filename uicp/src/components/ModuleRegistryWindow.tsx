import { useCallback, useEffect, useState } from 'react';
import DesktopWindow from './DesktopWindow';
import { useAppSelector } from '../state/app';
import { hasTauriBridge, tauriInvoke } from '../lib/bridge/tauri';

interface ModuleProvenance {
  task: string;
  version: string;
  origin_url?: string;
  build_toolchain?: string;
  wit_world?: string;
  built_at?: number;
  source_revision?: string;
  builder?: string;
  metadata?: Record<string, unknown>;
}

interface ModuleInfo {
  task: string;
  version: string;
  filename: string;
  digest: string;
  signature?: string;
  keyid?: string;
  signedAt?: number;
  provenance?: ModuleProvenance;
}

interface RegistryData {
  dir: string;
  modules: ModuleInfo[];
}

const ModuleRegistryWindow = () => {
  const isOpen = useAppSelector((s) => s.moduleRegistryOpen);
  const setOpen = useAppSelector((s) => s.setModuleRegistryOpen);
  const pushToast = useAppSelector((s) => s.pushToast);
  const [loading, setLoading] = useState(false);
  const [registry, setRegistry] = useState<RegistryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedModule, setExpandedModule] = useState<string | null>(null);

  const loadRegistry = useCallback(async () => {
    if (!hasTauriBridge()) {
      setError('Module registry requires the Tauri runtime');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await tauriInvoke<RegistryData>('get_modules_registry');
      setRegistry(data);
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      setError(msg);
      pushToast({ variant: 'error', message: `Failed to load registry: ${msg}` });
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  useEffect(() => {
    if (isOpen) {
      loadRegistry();
    }
  }, [isOpen, loadRegistry]);

  const formatDate = (ts: number) => {
    return new Date(ts * 1000).toLocaleString();
  };

  const truncateHash = (hash: string) => {
    if (hash.length <= 16) return hash;
    return `${hash.slice(0, 8)}...${hash.slice(-8)}`;
  };

  const copyToClipboard = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      pushToast({ variant: 'success', message: `Copied ${label}` });
    } catch (err) {
      pushToast({ variant: 'error', message: `Copy failed: ${(err as Error)?.message ?? String(err)}` });
    }
  };

  const openModulesDir = async () => {
    if (!registry?.dir) return;
    try {
      await tauriInvoke('open_path', { path: registry.dir });
    } catch (err) {
      pushToast({ variant: 'error', message: `Open failed: ${(err as Error)?.message ?? String(err)}` });
    }
  };

  return (
    <DesktopWindow
      id="module-registry"
      title="Module Registry & Supply Chain"
      isOpen={isOpen}
      onClose={() => setOpen(false)}
      initialPosition={{ x: 120, y: 120 }}
      width={720}
      minHeight={400}
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between text-sm text-slate-600">
          <span>Cryptographic provenance and supply chain transparency</span>
          <button
            type="button"
            className="rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-100 disabled:opacity-50"
            onClick={loadRegistry}
            disabled={loading}
          >
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>

        {error && (
          <div className="rounded border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            {error}
          </div>
        )}

        {registry && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span>Registry: {registry.dir}</span>
            <button
              type="button"
              className="rounded px-1 text-[11px] underline decoration-dotted underline-offset-2 hover:text-slate-700"
              onClick={openModulesDir}
              title="Open modules directory"
            >
              Open
            </button>
          </div>
        )}

        {registry && registry.modules.length === 0 && (
          <div className="rounded border border-slate-200 bg-slate-50 p-4 text-center text-sm text-slate-500">
            No modules found in registry
          </div>
        )}

        <div className="flex flex-col gap-2 overflow-y-auto" style={{ maxHeight: '500px' }}>
          {registry?.modules.map((mod) => {
            const moduleKey = `${mod.task}@${mod.version}`;
            const isExpanded = expandedModule === moduleKey;
            const hasSig = !!mod.signature;
            const hasProv = !!mod.provenance;

            return (
              <div
                key={moduleKey}
                className="rounded border border-slate-200 bg-white shadow-sm"
              >
                <button
                  type="button"
                  className="w-full px-3 py-2 text-left hover:bg-slate-50"
                  onClick={() => setExpandedModule(isExpanded ? null : moduleKey)}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-slate-800">
                        {moduleKey}
                      </span>
                      {hasSig && (
                        <span className="rounded bg-green-100 px-2 py-0.5 text-[10px] font-semibold text-green-700">
                          SIGNED
                        </span>
                      )}
                      {hasProv && (
                        <span className="rounded bg-blue-100 px-2 py-0.5 text-[10px] font-semibold text-blue-700">
                          PROVENANCE
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-slate-400">
                      {isExpanded ? '▼' : '▶'}
                    </span>
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t border-slate-100 p-3">
                    <div className="space-y-3 text-xs">
                      {/* File Info */}
                      <div className="space-y-1">
                        <div className="font-semibold text-slate-700">File</div>
                        <div className="font-mono text-slate-600">{mod.filename}</div>
                      </div>

                      {/* Digest */}
                      <div className="space-y-1">
                        <div className="font-semibold text-slate-700">SHA-256 Digest</div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[11px] text-slate-600" title={mod.digest}>
                            {truncateHash(mod.digest)}
                          </span>
                          <button
                            type="button"
                            className="rounded px-1 text-[10px] underline decoration-dotted underline-offset-2 hover:text-slate-700"
                            onClick={() => copyToClipboard(mod.digest, 'digest')}
                          >
                            copy
                          </button>
                        </div>
                      </div>

                      {/* Signature */}
                      {mod.signature && (
                        <div className="space-y-1">
                          <div className="font-semibold text-slate-700">Ed25519 Signature</div>
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-[11px] text-slate-600">
                              {truncateHash(mod.signature)}
                            </span>
                            <button
                              type="button"
                              className="rounded px-1 text-[10px] underline decoration-dotted underline-offset-2 hover:text-slate-700"
                              onClick={() => copyToClipboard(mod.signature!, 'signature')}
                            >
                              copy
                            </button>
                          </div>
                          {mod.keyid && (
                            <div className="text-slate-500">
                              Key ID: <span className="font-mono">{mod.keyid}</span>
                            </div>
                          )}
                          {mod.signedAt && (
                            <div className="text-slate-500">
                              Signed: {formatDate(mod.signedAt)}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Provenance */}
                      {mod.provenance && (
                        <div className="space-y-2 rounded border border-blue-100 bg-blue-50/30 p-3">
                          <div className="font-semibold text-blue-900">Supply Chain Provenance</div>

                          {mod.provenance.origin_url && (
                            <div className="space-y-1">
                              <div className="text-[11px] font-medium text-blue-800">Origin</div>
                              <div className="font-mono text-[11px] text-blue-700">
                                {mod.provenance.origin_url}
                              </div>
                            </div>
                          )}

                          {mod.provenance.build_toolchain && (
                            <div className="space-y-1">
                              <div className="text-[11px] font-medium text-blue-800">Build Toolchain</div>
                              <div className="font-mono text-[11px] text-blue-700">
                                {mod.provenance.build_toolchain}
                              </div>
                            </div>
                          )}

                          {mod.provenance.wit_world && (
                            <div className="space-y-1">
                              <div className="text-[11px] font-medium text-blue-800">WIT World</div>
                              <div className="font-mono text-[11px] text-blue-700">
                                {mod.provenance.wit_world}
                              </div>
                            </div>
                          )}

                          {mod.provenance.source_revision && (
                            <div className="space-y-1">
                              <div className="text-[11px] font-medium text-blue-800">Source Revision</div>
                              <div className="font-mono text-[11px] text-blue-700">
                                {mod.provenance.source_revision}
                              </div>
                            </div>
                          )}

                          {mod.provenance.builder && (
                            <div className="space-y-1">
                              <div className="text-[11px] font-medium text-blue-800">Builder</div>
                              <div className="font-mono text-[11px] text-blue-700">
                                {mod.provenance.builder}
                              </div>
                            </div>
                          )}

                          {mod.provenance.built_at && (
                            <div className="space-y-1">
                              <div className="text-[11px] font-medium text-blue-800">Built</div>
                              <div className="text-[11px] text-blue-700">
                                {formatDate(mod.provenance.built_at)}
                              </div>
                            </div>
                          )}

                          {mod.provenance.metadata && (
                            <div className="space-y-1">
                              <div className="text-[11px] font-medium text-blue-800">Additional Metadata</div>
                              <pre className="overflow-auto rounded bg-blue-900/5 p-2 font-mono text-[10px] text-blue-800">
                                {JSON.stringify(mod.provenance.metadata, null, 2)}
                              </pre>
                            </div>
                          )}
                        </div>
                      )}

                      {!mod.signature && !mod.provenance && (
                        <div className="rounded border border-amber-200 bg-amber-50 p-2 text-[11px] text-amber-700">
                          No signature or provenance data available for this module.
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="text-[11px] text-slate-500">
          Museum labels for every skull: Each module's cryptographic digest, signature, and supply chain provenance.
        </div>
      </div>
    </DesktopWindow>
  );
};

export default ModuleRegistryWindow;
