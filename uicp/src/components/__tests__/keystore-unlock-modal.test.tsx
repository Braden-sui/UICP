import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import KeystoreUnlockModal from '../../components/KeystoreUnlockModal';
import { setInvOverride, type Result } from '../../lib/bridge/tauri';
import { useKeystore } from '../../state/keystore';

// Simple helper to wait a microtask
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('KeystoreUnlockModal', () => {
  beforeEach(() => {
    // Reset store
    useKeystore.setState({ locked: true, ttlRemainingSec: null, method: null, busy: false, error: undefined });
    setInvOverride(null);
  });

  afterEach(() => {
    setInvOverride(null);
  });

  it('shows on unlock-request, unlocks via passphrase, emits resume event, and closes', async () => {
    const user = userEvent.setup();

    // Arrange: capture resume events
    const resumes: string[] = [];
    const onResume = (e: Event) => {
      const d = (e as CustomEvent).detail as { id?: string } | undefined;
      if (d?.id) resumes.push(d.id);
    };
    window.addEventListener('keystore-unlock-resume', onResume as EventListener);

    // Arrange: mock keystore_unlock to succeed
    setInvOverride(async <T,>(command: string): Promise<Result<T>> => {
      if (command === 'keystore_unlock') {
        // Return unlocked with TTL
        return { ok: true, value: { locked: false, ttl_remaining_sec: 60, method: 'Passphrase' } as unknown as T };
      }
      return { ok: true, value: undefined as unknown as T };
    });

    // Act: render modal host and dispatch request
    render(<KeystoreUnlockModal />);
    const resumeId = 'unlock-1';
    window.dispatchEvent(new CustomEvent('keystore-unlock-request', { detail: { id: resumeId } }));

    // Assert: modal visible
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Unlock Keystore')).toBeInTheDocument();

    // Enter passphrase and unlock
    const input = screen.getByPlaceholderText('Passphrase');
    await user.type(input, 'correct horse battery staple');
    const btn = screen.getByRole('button', { name: 'Unlock' });
    await user.click(btn);

    // Wait microtask for event dispatch
    await tick();

    // Expect resume event
    expect(resumes).toContain(resumeId);

    // Modal closed
    await tick();
    expect(screen.queryByRole('dialog')).toBeNull();

    window.removeEventListener('keystore-unlock-resume', onResume as EventListener);
  });
});
