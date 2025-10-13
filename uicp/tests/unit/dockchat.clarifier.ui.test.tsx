import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { render, screen, within, act } from '@testing-library/react';
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
  beforeEach(() => {
    ensureCrypto();
    act(() => {
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
  });

  afterEach(() => {
    useAppStore.setState({ chatOpen: false });
    useChatStore.setState({ messages: [] } as any);
  });

  it('renders amber card styling and icon for clarifier-needed', async () => {
    const { container } = await act(async () => render(<DockChat />));
    // Scope text lookup to the visible message list (avoid aria-live duplication)
    const list = screen.getByRole('list');
    const el = within(list).getByText('Need a quick clarification on the selector.');
    const li = el.closest('li');
    expect(li).toBeTruthy();
    // Amber card classes applied
    expect(li!.className).toContain('bg-amber-50');
    expect(li!.className).toContain('border-amber-200');
    // Icon is rendered inline before text
    const svg = li!.querySelector('svg');
    expect(svg).toBeTruthy();
  });
});
