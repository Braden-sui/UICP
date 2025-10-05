import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import NotepadWindow from '../../src/components/NotepadWindow';
import { useAppStore } from '../../src/state/app';
import { useNotepadStore, DEFAULT_TITLE } from '../../src/state/notepad';

const ensureCrypto = () => {
  if (!globalThis.crypto) {
    // Minimal stub so pushToast can mint IDs during tests.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    globalThis.crypto = {};
  }
  if (!globalThis.crypto.randomUUID) {
    globalThis.crypto.randomUUID = () => '00000000-0000-0000-0000-000000000000';
  }
};

describe('<NotepadWindow />', () => {
  beforeEach(() => {
    ensureCrypto();
    useAppStore.setState({ notepadOpen: true, toasts: [] });
    useNotepadStore.setState({
      title: DEFAULT_TITLE,
      content: '',
      dirty: false,
      lastSavedAt: undefined,
    });
  });

  it('updates the store when title and body change', () => {
    render(<NotepadWindow />);

    fireEvent.change(screen.getByLabelText('Title', { selector: 'input' }), { target: { value: 'Design doc' } });
    fireEvent.change(screen.getByLabelText('Notepad body'), { target: { value: 'Outline key ideas' } });

    const state = useNotepadStore.getState();
    expect(state.title).toBe('Design doc');
    expect(state.content).toBe('Outline key ideas');
    expect(state.dirty).toBe(true);
  });

  it('marks the note as saved and emits a toast when Save is clicked', () => {
    render(<NotepadWindow />);
    const store = useNotepadStore.getState();
    const markSavedSpy = vi.spyOn(store, 'markSaved');

    fireEvent.change(screen.getByLabelText('Title', { selector: 'input' }), { target: { value: 'Retro' } });
    fireEvent.change(screen.getByLabelText('Notepad body'), { target: { value: 'Wins and risks' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(markSavedSpy).toHaveBeenCalledTimes(1);
    const { dirty, lastSavedAt } = useNotepadStore.getState();
    expect(dirty).toBe(false);
    expect(typeof lastSavedAt).toBe('number');
    const toasts = useAppStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.message).toMatch(/saved locally/i);
  });
});
