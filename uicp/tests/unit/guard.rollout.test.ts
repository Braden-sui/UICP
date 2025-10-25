import { describe, it, expect, beforeEach } from 'vitest';
import { startGuardRollout } from '../../src/lib/security/guardRollout';

const dispatchBlock = () => {
  const ev = new (globalThis as any).window.CustomEvent('net-guard-block', {
    detail: { api: 'fetch', reason: 'test' },
  });
  (globalThis as any).window.dispatchEvent(ev);
};

describe('Guard rollout controller', () => {
  beforeEach(() => {
    // Reset localStorage state used by rollout
    try { localStorage.removeItem('uicp:netguard:rollout'); } catch {}
    // Ensure window and CustomEvent exist (jsdom)
    if (!(globalThis as any).window) {
      (globalThis as any).window = {} as any;
    }
    if (!(globalThis as any).window.CustomEvent) {
      (globalThis as any).window.CustomEvent = function (this: any, type: string, init?: any) {
        this.type = type;
        this.detail = init?.detail;
      } as any;
    }
    if (typeof (globalThis as any).window.addEventListener !== 'function') {
      const listeners: Record<string, Array<(e: any) => void>> = {};
      (globalThis as any).window.addEventListener = (type: string, cb: (e: any) => void) => {
        (listeners[type] = listeners[type] || []).push(cb);
      };
      (globalThis as any).window.dispatchEvent = (ev: any) => {
        const arr = listeners[ev?.type] || [];
        for (const fn of arr) fn(ev);
        return true;
      };
    }
  });

  it('escalates from auto → enforce when no blocks and minutesMonitor=0', () => {
    let escalated = false;
    const ctl = startGuardRollout({ stage: 'auto', minutesMonitor: 0, onEscalate: () => { escalated = true; } });
    ctl.checkNow();
    expect(escalated).toBe(true);
    ctl.stop();
  });

  it('does not escalate when blocks were observed', () => {
    let escalated = false;
    const ctl = startGuardRollout({ stage: 'auto', minutesMonitor: 0, onEscalate: () => { escalated = true; } });
    dispatchBlock();
    ctl.checkNow();
    expect(escalated).toBe(false);
    ctl.stop();
  });

  it('monitor stage never escalates', () => {
    let escalated = false;
    const ctl = startGuardRollout({ stage: 'monitor', minutesMonitor: 0, onEscalate: () => { escalated = true; } });
    ctl.checkNow();
    expect(escalated).toBe(false);
    ctl.stop();
  });

  it('enforce stage does not escalate', () => {
    let escalated = false;
    const ctl = startGuardRollout({ stage: 'enforce', minutesMonitor: 0, onEscalate: () => { escalated = true; } });
    ctl.checkNow();
    expect(escalated).toBe(false);
    ctl.stop();
  });
});
