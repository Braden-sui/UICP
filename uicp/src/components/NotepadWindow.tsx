import { type ChangeEvent, useCallback, useMemo } from 'react';
import DesktopWindow from './DesktopWindow';
import { useNotepadStore } from '../state/notepad';
import { useAppStore } from '../state/app';
import { strings } from '../strings';

const formatTimestamp = (value?: number) => {
  if (!value) return 'Never saved';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return 'Never saved';
  }
};

const toSafeFilename = (raw: string) => {
  const base = raw.trim() || 'note';
  return `${base.replace(/[^a-z0-9\-_. ]/gi, '_')}.txt`;
};

const TITLE_INPUT_ID = 'notepad-title-input';

// NotepadWindow gives users a manual scratchpad so they can capture ideas without waiting on the agent.
const NotepadWindow = () => {
  const notepadOpen = useAppStore((state) => state.notepadOpen);
  const setNotepadOpen = useAppStore((state) => state.setNotepadOpen);
  const pushToast = useAppStore((state) => state.pushToast);
  const {
    title,
    content,
    dirty,
    lastSavedAt,
    setTitle,
    setContent,
    markSaved,
    reset,
  } = useNotepadStore();

  const status = useMemo(() => (dirty ? 'Unsaved changes' : `Saved: ${formatTimestamp(lastSavedAt)}`), [dirty, lastSavedAt]);

  const handleTitleChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setTitle(event.target.value);
  }, [setTitle]);

  const handleContentChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setContent(event.target.value);
  }, [setContent]);

  const handleSave = useCallback(() => {
    markSaved();
    pushToast({ variant: 'success', message: 'Notepad saved locally.' });
  }, [markSaved, pushToast]);

  const handleExport = useCallback(() => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = toSafeFilename(title);
    // Provide quick blob export so notes can leave the sandbox without extra tooling.
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
    pushToast({ variant: 'success', message: `Exported ${link.download}` });
  }, [content, pushToast, title]);

  const handleClear = useCallback(() => {
    if (!content && !title.trim()) {
      reset();
      return;
    }
    const confirmed = window.confirm('Clear current note? This cannot be undone.');
    if (!confirmed) return;
    reset();
    pushToast({ variant: 'info', message: 'Notepad cleared.' });
  }, [content, pushToast, reset, title]);

  const handleClose = useCallback(() => {
    setNotepadOpen(false);
  }, [setNotepadOpen]);

  return (
    <DesktopWindow
      id="notepad"
      title="Notepad"
      isOpen={notepadOpen}
      onClose={handleClose}
      initialPosition={{ x: 200, y: 180 }}
      width={520}
      minHeight={360}
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <label className="flex flex-1 min-w-[220px] flex-col gap-2" htmlFor={TITLE_INPUT_ID}>
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Title</span>
            <input
              id={TITLE_INPUT_ID}
              value={title}
              onChange={handleTitleChange}
              className="rounded border border-slate-300 bg-white/90 px-3 py-2 text-sm text-slate-800 shadow-inner focus:border-slate-400 focus:outline-none"
              placeholder={strings.notepadTitlePlaceholder}
            />
          </label>
          <div className="flex flex-col items-end gap-2 text-right text-xs text-slate-500">
            <span aria-live="polite">{status}</span>
            <button
              type="button"
              onClick={handleClose}
              className="rounded border border-slate-300 px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500 hover:bg-slate-100"
            >
              Hide
            </button>
          </div>
        </div>
        <label htmlFor="notepad-body" className="flex flex-1 flex-col gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Body</span>
          <textarea
            id="notepad-body"
            value={content}
            onChange={handleContentChange}
            className="min-h-[220px] flex-1 resize-none rounded border border-slate-300 bg-white/90 px-3 py-3 text-sm leading-relaxed text-slate-800 shadow-inner focus:border-slate-400 focus:outline-none"
            placeholder={strings.notepadBodyPlaceholder}
            aria-label="Notepad body"
          />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSave}
              className="rounded bg-slate-900 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-white shadow hover:bg-slate-700"
            >
              Save
            </button>
            <button
              type="button"
              onClick={handleExport}
              className="rounded border border-slate-300 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600 hover:bg-slate-100"
            >
              Export .txt
            </button>
          </div>
          <button
            type="button"
            onClick={handleClear}
            className="rounded border border-red-400 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-red-600 hover:bg-red-50"
          >
            Clear
          </button>
        </div>
      </div>
    </DesktopWindow>
  );
};

export default NotepadWindow;
