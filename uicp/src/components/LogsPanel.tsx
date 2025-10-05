import { useChatStore } from '../state/chat';
import { useAppStore } from '../state/app';
import DesktopWindow from './DesktopWindow';

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
    <>
      {/* Logs live inside a movable DesktopWindow so they respect the new OS-style chrome. */}
      <DesktopWindow
        id="logs"
        title="Logs"
        isOpen={logsOpen}
        onClose={() => setLogsOpen(false)}
        initialPosition={{ x: 560, y: 160 }}
        width={420}
      >
        <div className="flex flex-col gap-3 text-xs">
          <header className="flex items-center justify-between text-[11px] uppercase tracking-wide text-slate-500">
            <span>Conversation Logs</span>
            <span className="text-[10px] font-mono lowercase text-slate-400">{messages.length} entries</span>
          </header>
          <ul className="flex flex-col gap-2 text-slate-700">
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
      </DesktopWindow>
      <div className="pointer-events-none absolute bottom-4 right-4 z-40 flex flex-col items-end gap-2 text-sm">
        <button
          type="button"
          onClick={() => setLogsOpen(!logsOpen)}
          className="pointer-events-auto rounded-full bg-slate-900 px-3 py-1 text-xs font-semibold text-white shadow hover:bg-slate-700"
          aria-expanded={logsOpen}
        >
          {logsOpen ? 'Hide Logs' : 'Open Logs'}
        </button>
      </div>
    </>
  );
};

export default LogsPanel;
