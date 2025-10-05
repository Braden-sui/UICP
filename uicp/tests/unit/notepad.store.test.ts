import { beforeEach, describe, expect, it } from 'vitest';
import { useNotepadStore, DEFAULT_TITLE } from '../../src/state/notepad';

const resetStore = () => {
  useNotepadStore.setState({
    title: DEFAULT_TITLE,
    content: '',
    dirty: false,
    lastSavedAt: undefined,
  });
};

describe('useNotepadStore', () => {
  beforeEach(() => {
    resetStore();
  });

  it('starts with a blank draft and no save timestamp', () => {
    const state = useNotepadStore.getState();
    expect(state.title).toBe(DEFAULT_TITLE);
    expect(state.content).toBe('');
    expect(state.dirty).toBe(false);
    expect(state.lastSavedAt).toBeUndefined();
  });

  it('tracks edits as dirty until markSaved trims and stamps them', () => {
    const store = useNotepadStore.getState();
    store.setTitle('   Daily Scratch   ');
    store.setContent('remember to ship notepad window');
    let next = useNotepadStore.getState();
    expect(next.dirty).toBe(true);

    store.markSaved();
    next = useNotepadStore.getState();
    expect(next.dirty).toBe(false);
    expect(next.title).toBe('Daily Scratch');
    expect(typeof next.lastSavedAt).toBe('number');
  });

  it('reset clears the draft while keeping the store clean', () => {
    const store = useNotepadStore.getState();
    store.setTitle('Retro notes');
    store.setContent('ship it');
    store.reset();
    const state = useNotepadStore.getState();
    expect(state.title).toBe(DEFAULT_TITLE);
    expect(state.content).toBe('');
    expect(state.dirty).toBe(false);
    expect(state.lastSavedAt).toBeUndefined();
  });
});
