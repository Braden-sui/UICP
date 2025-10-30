import { describe, it, expect } from 'vitest';
import { useAppStore } from '../../../state/app';

// Helper to set VITE_APPLY_HANDSHAKE_V1 for tests
const enableHandshakeFlag = () => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const im = import.meta as any;
    if (im && im.env) {
      im.env.VITE_APPLY_HANDSHAKE_V1 = 'true';
    }
  } catch {
    // ignore
  }
};

describe('apply handshake (awaitApplyAck/ackApply)', () => {
  it('resolves immediately when token pre-exists (ack before await)', async () => {
    enableHandshakeFlag();
    const app = useAppStore.getState();
    app.ackApply('win-x');
    const start = Date.now();
    await app.awaitApplyAck('win-x', 250);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it('resolves when ack arrives before timeout (await then ack)', async () => {
    enableHandshakeFlag();
    const app = useAppStore.getState();
    const p = app.awaitApplyAck('win-y', 250);
    setTimeout(() => app.ackApply('win-y'), 10);
    const start = Date.now();
    await p;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(8);
    expect(elapsed).toBeLessThan(200);
  });

  it('times out when no ack arrives', async () => {
    enableHandshakeFlag();
    const app = useAppStore.getState();
    let timedOut = false;
    try {
      await app.awaitApplyAck('win-z', 20);
    } catch {
      timedOut = true;
    }
    expect(timedOut).toBe(true);
  });
});
