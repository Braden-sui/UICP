// Environment snapshot for LLM prompts.
// Purpose: give the planner/actor compact awareness of the current UI/workspace state
// without leaking PII or excessive DOM content. This improves correctness (e.g., reusing
// existing window ids) and reduces unknown-window errors.
import { useAppStore } from '../state/app';
import { flagsSummary } from './flags';

const clamp = (value: string, max = 160): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

export type EnvSnapshotOptions = {
  includeDom?: boolean;
  maxWindows?: number;
};

export const buildEnvironmentSnapshot = (opts?: EnvSnapshotOptions): string => {
  const { includeDom = false, maxWindows = 12 } = opts ?? {};
  const app = useAppStore.getState();

  const phase = app.agentStatus.phase;
  const trace = app.agentStatus.traceId ?? 'none';
  const fullControl = app.fullControl && !app.fullControlLocked ? 'enabled' : 'disabled';
  const streaming = app.streaming ? 'yes' : 'no';
  const devMode = app.devMode ? 'on' : 'off';
  const platform = typeof navigator !== 'undefined' ? navigator.platform : 'unknown';

  const windows = Object.values(app.workspaceWindows);
  const windowCount = windows.length;
  const windowLines = windows
    .slice(0, maxWindows)
    .map((w) => `- ${w.id} :: ${w.title} [${w.kind}]`)
    .join('\n');

  let domLines = '';
  const shouldProbeDom = typeof document !== 'undefined' && (includeDom || windowCount === 0);
  if (shouldProbeDom) {
    try {
      const shells = Array.from(document.querySelectorAll<HTMLElement>('[data-window-id]'));
      domLines = shells
        .slice(0, maxWindows)
        .map((el) => {
          const id = el.getAttribute('data-window-id') || 'unknown';
          const title = el.querySelector('.window-title')?.textContent?.trim() || 'Untitled';
          if (!includeDom) {
            return `- ${id} :: ${title}`;
          }
          const root = el.querySelector('#root');
          const text = root ? clamp(root.textContent?.trim() || '') : '';
          return `- ${id} :: ${title}${text ? ` — ${text}` : ''}`;
        })
        .join('\n');
    } catch {
      // ignore DOM access errors in non-browser environments
    }
  }

  const lines: string[] = [];
  lines.push('Environment Snapshot');
  lines.push(`- Agent: phase=${phase}, fullControl=${fullControl}, streaming=${streaming}`);
  lines.push(`- Flags: devMode=${devMode}, platform=${platform}`);
  lines.push(`- FeatureFlags: ${flagsSummary()}`);
  lines.push(`- LastTrace: ${trace}${app.agentStatus.error ? ` (error=${app.agentStatus.error})` : ''}`);
  lines.push(`- WorkspaceWindows: ${windowCount}`);
  if (windowLines) lines.push(windowLines);
  if (domLines) {
    lines.push('- DOM:');
    lines.push(domLines);
  }

  // Gentle nudge for the LLM to reuse context correctly.
  lines.push('Guidance: reuse existing window ids when updating; '
    + 'prefer dom.set/replace targeting #root in the chosen window; '
    + 'only create new windows when needed.');

  return lines.join('\n');
};
