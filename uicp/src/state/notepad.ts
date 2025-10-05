import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// NotepadState maintains the local-first note content so the utility window feels native and persists across runs.
export type NotepadState = {
  title: string;
  content: string;
  lastSavedAt?: number;
  dirty: boolean;
  setTitle: (value: string) => void;
  setContent: (value: string) => void;
  markSaved: () => void;
  reset: () => void;
};

export const DEFAULT_TITLE = 'Untitled note';

export const useNotepadStore = create<NotepadState>()(
  persist(
    (set) => ({
      title: DEFAULT_TITLE,
      content: '',
      lastSavedAt: undefined,
      dirty: false,
      setTitle: (value) =>
        set(() => ({
          title: value,
          dirty: true,
        })),
      setContent: (value) =>
        set(() => ({
          content: value,
          dirty: true,
        })),
      markSaved: () =>
        set((state) => ({
          lastSavedAt: Date.now(),
          dirty: false,
          title: state.title.trim() ? state.title.trim() : DEFAULT_TITLE,
        })),
      reset: () =>
        set(() => ({
          title: DEFAULT_TITLE,
          content: '',
          lastSavedAt: undefined,
          dirty: false,
        })),
    }),
    {
      name: 'uicp-notepad',
      partialize: (state) => ({
        title: state.title,
        content: state.content,
        lastSavedAt: state.lastSavedAt,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        state.dirty = false;
      },
    },
  ),
);
