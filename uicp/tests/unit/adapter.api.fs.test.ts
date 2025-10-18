import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/uicp/adapters/adapter.fs', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/uicp/adapters/adapter.fs')>(
    '../../src/lib/uicp/adapters/adapter.fs',
  );
  return {
    ...actual,
    safeWrite: vi.fn(async () => ({ ok: true, bytesWritten: 7, path: 'out.txt' })),
  };
});

import { routeApiCall } from '../../src/lib/uicp/adapters/adapter.api';
import type { Envelope } from '../../src/lib/uicp/adapters/schemas';
import { BaseDirectory, safeWrite } from '../../src/lib/uicp/adapters/adapter.fs';

describe('adapter.api tauri fs routing', () => {
  beforeEach(() => {
    vi.mocked(safeWrite).mockReset();
  });

  const makeEnvelope = (overrides?: Partial<Envelope>): Envelope => ({
    op: 'api.call',
    params: { url: 'tauri://fs/writeTextFile' } as any,
    ...overrides,
  } as Envelope);

  it('maps Desktop directory token and enforces devDesktopWrite', async () => {
    vi.mocked(safeWrite).mockResolvedValueOnce({ ok: true, bytesWritten: 7, path: 'report.txt' });
    const params = {
      url: 'tauri://fs/writeTextFile',
      body: { path: 'report.txt', contents: 'payload', directory: 'Desktop' },
    } as any;
    const res = await routeApiCall(params, makeEnvelope(), { runId: 't-fs' }, () => ({ success: true, value: 'ok' }));
    expect(res.success).toBe(true);
    expect(safeWrite).toHaveBeenCalledWith(
      'report.txt',
      'payload',
      expect.objectContaining({ base: BaseDirectory.Desktop, devDesktopWrite: true }),
    );
  });

  it('falls back to AppData for unknown directory tokens', async () => {
    vi.mocked(safeWrite).mockResolvedValueOnce({ ok: true, bytesWritten: 3, path: 'a.txt' });
    const params = {
      url: 'tauri://fs/writeTextFile',
      body: { path: 'a.txt', contents: 'hey', directory: 'Documents' },
    } as any;
    const res = await routeApiCall(params, makeEnvelope(), { runId: 't-fs2' }, () => ({ success: true, value: 'ok' }));
    expect(res.success).toBe(true);
    expect(safeWrite).toHaveBeenCalledWith(
      'a.txt',
      'hey',
      expect.objectContaining({ base: BaseDirectory.AppData }),
    );
  });
});

