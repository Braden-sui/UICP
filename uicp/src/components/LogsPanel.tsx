import { useChatStore } from '../state/chat';
import { useAppStore } from '../state/app';
import { LogsIcon } from '../icons';

const formatTimestamp = (value: number) => {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return '';
  }
};

export const LogsPanel = () => {
  const messages = useChatStore((state) => state.messages);
  const logsOpen = useAppStore((s) => s.logsOpen);
  const setLogsOpen = useAppStore((s) => s.setLogsOpen);

  return (
    <div className="pointer-events-none absolute bottom-4 right-4 z-40 flex flex-col items-end gap-2 text-sm">
      <button
        type="button"
        onClick={() => setLogsOpen(!logsOpen)}
        className="pointer-events-auto rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white shadow hover:bg-slate-700"
        aria-expanded={logsOpen}
      >
        {logsOpen ? 'Close Logs' : 'View Logs'}
      </button>
      {logsOpen && (
        <div
          role="region"
          aria-label="Conversation logs"
          className="pointer-events-auto max-h-72 w-80 overflow-y-auto rounded-xl border border-slate-200 bg-white/95 p-3 shadow-xl"
        >
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Conversation Logs</h2>
            <button
              type="button"
              onClick={() => setLogsOpen(false)}
              className="rounded px-2 py-0.5 text-xs font-semibold text-slate-600 hover:bg-slate-100"
              aria-label="Close logs"
            >
              Close
            </button>
          </div>
          <ul className="flex flex-col gap-2 text-xs text-slate-700">
            {messages.length === 0 && <li className="text-slate-400">No messages yet.</li>}
            {messages.map((message) => (
              <li key={message.id} className="rounded border border-slate-200 bg-slate-50 px-2 py-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold uppercase tracking-wide text-slate-500">{message.role}</span>
                  <span className="text-[10px] text-slate-400">{formatTimestamp(message.createdAt)}</span>
                </div>
                {message.errorCode && (
                  <div className="mt-1 text-[10px] font-mono uppercase text-red-500">{message.errorCode}</div>
                )}
                <p className="mt-1 whitespace-pre-wrap text-slate-700">{message.content}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default LogsPanel;
