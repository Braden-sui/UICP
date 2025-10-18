import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  writeTextFileMock,
  writeBinaryFileMock,
  confirmMock,
} = vi.hoisted(() => ({
  writeTextFileMock: vi.fn(),
  writeBinaryFileMock: vi.fn(),
  confirmMock: vi.fn<(message: string, options?: { title?: string }) => Promise<boolean>>(),
}));
const telemetryMock = vi.hoisted(() => ({ emitTelemetryEvent: vi.fn() }));

vi.mock('@tauri-apps/plugin-fs', () => ({
  BaseDirectory: {
    AppData: 'AppData',
    Desktop: 'Desktop',
  },
  writeTextFile: writeTextFileMock,
  writeBinaryFile: writeBinaryFileMock,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  confirm: confirmMock,
}));

vi.mock('../../telemetry', () => telemetryMock);
vi.mock('../telemetry', () => telemetryMock);

import { safeWrite, BaseDirectory } from './adapter.fs';

describe('adapter.fs safeWrite', () => {
  beforeEach(() => {
    writeTextFileMock.mockReset();
    writeBinaryFileMock.mockReset();
    confirmMock.mockReset();
    telemetryMock.emitTelemetryEvent.mockReset();
    confirmMock.mockResolvedValue(true);
  });

  it('rejects traversal attempts', async () => {
    const outcome = await safeWrite('../escape.txt', 'payload');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.errorCode).toBe('E-UICP-FS-TRAVERSAL');
    }
    expect(writeTextFileMock).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('enforces devDesktopWrite flag and user confirmation before Desktop writes', async () => {
    const deniedFlag = await safeWrite('report.txt', 'payload', { base: BaseDirectory.Desktop });
    expect(deniedFlag.ok).toBe(false);
    if (!deniedFlag.ok) {
      expect(deniedFlag.errorCode).toBe('E-UICP-FS-PATH-DENIED');
    }
    expect(confirmMock).not.toHaveBeenCalled();
    expect(writeTextFileMock).not.toHaveBeenCalled();

    confirmMock.mockResolvedValueOnce(false);
    const deniedPrompt = await safeWrite('report.txt', 'payload', {
      base: BaseDirectory.Desktop,
      devDesktopWrite: true,
      runId: 'run-desktop-denied',
    });
    expect(deniedPrompt.ok).toBe(false);
    if (!deniedPrompt.ok) {
      expect(deniedPrompt.errorCode).toBe('E-UICP-FS-PATH-DENIED');
      expect(deniedPrompt.message).toContain('E-UICP-6202');
    }
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(writeTextFileMock).not.toHaveBeenCalled();

    confirmMock.mockResolvedValueOnce(true);
    const success = await safeWrite('exports/report.txt', 'payload', {
      base: BaseDirectory.Desktop,
      devDesktopWrite: true,
      runId: 'run-desktop-allowed',
    });
    expect(success).toEqual({ ok: true, bytesWritten: 'payload'.length, path: 'exports/report.txt' });
    expect(confirmMock).toHaveBeenCalledTimes(2);
    expect(writeTextFileMock).toHaveBeenCalledWith('exports/report.txt', 'payload', { baseDir: BaseDirectory.Desktop });
  });
});
