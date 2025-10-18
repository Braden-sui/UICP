import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/uicp/adapter', () => ({
  registerWorkspaceRoot: vi.fn(),
  registerWindowLifecycle: vi.fn(() => () => undefined),
  listWorkspaceWindows: vi.fn(() => []),
  closeWorkspaceWindow: vi.fn(),
  replayWorkspace: vi.fn(async () => ({ applied: 0, errors: [] })),
}));

vi.mock('../../src/lib/uicp/cleanup', () => ({
  installWorkspaceArtifactCleanup: vi.fn(() => () => undefined),
}));

vi.mock('../../src/components/LogsPanel', () => ({ default: () => null }));
vi.mock('../../src/components/NotepadWindow', () => ({ default: () => null }));
vi.mock('../../src/components/MetricsPanel', () => ({ default: () => null }));
vi.mock('../../src/components/AgentSettingsWindow', () => ({ default: () => null }));
vi.mock('../../src/components/ComputeDemoWindow', () => ({ default: () => null }));
vi.mock('../../src/components/ModuleRegistryWindow', () => ({ default: () => null }));
vi.mock('../../src/components/AgentTraceWindow', () => ({ default: () => null }));
vi.mock('../../src/components/DesktopMenuBar', () => ({ default: () => null }));
vi.mock('../../src/components/DesktopClock', () => ({ default: () => null }));
vi.mock('../../src/components/DesktopIcon', () => ({ default: () => null }));
vi.mock('../../src/components/DevtoolsAnalyticsListener', () => ({ default: () => null }));

import Desktop from '../../src/components/Desktop';

describe('Desktop layout', () => {
  it('anchors the workspace root to the full viewport canvas', () => {
    const { container } = render(<Desktop />);
    const workspaceRoot = container.querySelector('#workspace-root') as HTMLDivElement | null;
    expect(workspaceRoot).not.toBeNull();
    expect(workspaceRoot?.className).toContain('absolute');
    expect(workspaceRoot?.className).toContain('inset-0');
    expect(workspaceRoot?.className).toContain('z-40');
    expect(workspaceRoot?.className).toContain('pointer-events-none');

    const canvas = workspaceRoot?.parentElement;
    expect(canvas).not.toBeNull();
    expect(canvas?.className).toContain('flex-1');
    expect(canvas?.className).toContain('relative');

    const overlay = canvas?.querySelector('[data-shortcut-layer="true"]');
    expect(overlay?.className).toContain('z-20');
  });
});
