import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import { render, screen, within, act } from '@testing-library/react';
// Mock useDockReveal to avoid focus/timing side-effects during render
vi.mock('../../src/hooks/useDockReveal', () => ({
  useDockReveal: () => ({ chatOpen: true, onFocus: () => {}, onBlur: () => {}, setChatOpen: () => {} })
}));
vi.mock('../../src/hooks/useContainerStatus', () => ({
  useContainerStatus: () => ({
    loading: false,
    containerStatus: { available: true },
    networkCapabilities: { hasNetwork: true, restricted: false },
    showWarning: false,
    warningMessage: '',
  }),
}));
import DockChat from '../../src/components/DockChat';
import { useAppStore } from '../../src/state/app';
import { useChatStore } from '../../src/state/chat';

const ensureCrypto = () => {
  if (!globalThis.crypto) {
    // @ts-expect-error minimal stub for tests
    globalThis.crypto = {};
  }
  if (!globalThis.crypto.randomUUID) {
    globalThis.crypto.randomUUID = () => '00000000-0000-0000-0000-000000000000';
  }
};

describe('DockChat clarifier-needed UI', () => {
  const originalRaf = globalThis.requestAnimationFrame;
  const originalCancelRaf = globalThis.cancelAnimationFrame;

  beforeEach(async () => {
    ensureCrypto();
    await act(async () => {
      useAppStore.setState({ chatOpen: true });
      useChatStore.setState({
        messages: [
          {
            id: 'm1',
            role: 'system',
            content: 'Need a quick clarification on the selector.',
            errorCode: 'clarifier_needed',
          } as any,
        ],
      } as any);
    });
    // Stub rAF/cAF to avoid timing-driven focus updates causing act warnings
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    }) as typeof globalThis.requestAnimationFrame;
    globalThis.cancelAnimationFrame = (() => {
      // no-op
    }) as typeof globalThis.cancelAnimationFrame;
  });

  afterEach(async () => {
    await act(async () => {
      useAppStore.setState({ chatOpen: false });
      useChatStore.setState({ messages: [] } as any);
    });
    if (originalRaf) {
      globalThis.requestAnimationFrame = originalRaf;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (globalThis as { requestAnimationFrame?: typeof globalThis.requestAnimationFrame }).requestAnimationFrame;
    }
    if (originalCancelRaf) {
      globalThis.cancelAnimationFrame = originalCancelRaf;
    } else {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete (globalThis as { cancelAnimationFrame?: typeof globalThis.cancelAnimationFrame }).cancelAnimationFrame;
    }
  });

  it('renders amber card styling and icon for clarifier-needed', async () => {
    await act(async () => {
      render(<DockChat />);
    });
    // Scope text lookup to the visible message list (avoid aria-live duplication)
    const list = screen.getByRole('list');
    const el = within(list).getByText('Need a quick clarification on the selector.');
    const li = el.closest('li');
    expect(li).toBeTruthy();
    // Amber card classes applied (align with current UI)
    expect(li!.className).toContain('bg-amber-100/30');
    expect(li!.className).toContain('border-amber-300/50');
    // Icon is rendered inline before text
    const svg = li!.querySelector('svg');
    expect(svg).toBeTruthy();
  });
});
