import { useEffect, useState } from 'react';
import { setPermissionPromptHandler } from '../lib/permissions/promptBridge';
import type { PromptFn } from '../lib/permissions/PermissionManager';

export type PromptState = {
  title: string;
  body: string;
  choices: Array<{ id: string; label: string; decision: 'allow' | 'deny'; duration?: 'once' | 'session' | 'forever' }>;
};

const PermissionPromptHost = () => {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [resolver, setResolver] = useState<((value: { decision: 'allow' | 'deny'; duration?: 'once' | 'session' | 'forever' }) => void) | null>(null);

  useEffect(() => {
    const handler: PromptFn = async (info) => {
      return new Promise((resolve) => {
        const narrowed = (info.choices || [])
          .filter((c) => c.decision === 'allow' || c.decision === 'deny')
          .map((c) => ({ id: c.id, label: c.label, decision: c.decision as 'allow' | 'deny', duration: c.duration as ('once' | 'session' | 'forever' | undefined) }));
        setPrompt({ title: info.title, body: info.body, choices: narrowed });
        setResolver(() => resolve);
        setOpen(true);
      });
    };
    setPermissionPromptHandler(handler);
    return () => setPermissionPromptHandler(null);
  }, []);

  if (!open || !prompt) return null;

  const act = (choice: PromptState['choices'][number]) => {
    try { resolver?.({ decision: choice.decision, duration: choice.duration }); } catch {}
    setOpen(false);
    setResolver(null);
    setPrompt(null);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm">
      <div className="w-[min(520px,92vw)] rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
        <h2 className="text-lg font-semibold text-slate-900">{prompt.title}</h2>
        <p className="mt-1 text-sm text-slate-600">{prompt.body}</p>
        <div className="mt-4 grid grid-cols-1 gap-2">
          {prompt.choices.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`rounded px-3 py-2 text-sm font-semibold ${c.decision === 'allow' ? 'bg-slate-900 text-white hover:bg-slate-700' : 'bg-white text-slate-700 border'}`}
              onClick={() => act(c)}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={() => act({ id: 'deny', label: 'Deny', decision: 'deny', duration: 'once' })} className="rounded border px-3 py-1 text-sm">Cancel</button>
        </div>
      </div>
    </div>
  );
};

export default PermissionPromptHost;
