import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setInvOverride, type Result } from '../../lib/bridge/tauri';
import { useKeystore } from '../keystore';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Keystore countdown ticker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // reset store
    useKeystore.setState({ locked: true, ttlRemainingSec: null, method: null, busy: false, error: undefined });
    setInvOverride(null);
  });
  afterEach(() => {
    setInvOverride(null);
    vi.useRealTimers();
  });

  it('decrements ttl every second and re-syncs when hits zero', async () => {
    // Arrange: inv override for unlock and status
    setInvOverride(async <T,>(command: string): Promise<Result<T>> => {
      if (command === 'keystore_unlock') {
        return { ok: true, value: { locked: false, ttl_remaining_sec: 2, method: 'Passphrase' } as unknown as T };
      }
      if (command === 'keystore_status') {
        // After countdown reaches 0, refreshStatus should set locked:true
        return { ok: true, value: { locked: true, ttl_remaining_sec: null, method: null } as unknown as T };
      }
      return { ok: true, value: undefined as unknown as T };
    });

    // Act: unlock to start ticker
    const ok = await useKeystore.getState().unlock('pass');
    expect(ok).toBe(true);
    expect(useKeystore.getState().locked).toBe(false);
    expect(useKeystore.getState().ttlRemainingSec).toBe(2);

    // Advance 1s -> ttl 1
    vi.advanceTimersByTime(1000);
    await tick();
    expect(useKeystore.getState().ttlRemainingSec).toBe(1);

    // Advance 1s -> ttl 0 triggers refreshStatus
    vi.advanceTimersByTime(1000);
    await tick();
    // After refresh, locked should be true and ticker stopped
    expect(useKeystore.getState().locked).toBe(true);
    expect(useKeystore.getState().ttlRemainingSec).toBeNull();
  });
});
