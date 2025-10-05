import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// AppState keeps cross-cutting UI control flags so DockChat, modal flows, and transport logic stay in sync.
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';
export type ToastVariant = 'info' | 'success' | 'error';

export type Toast = {
  id: string;
  message: string;
  variant: ToastVariant;
};

export type AppState = {
  connectionStatus: ConnectionStatus;
  devMode: boolean;
  fullControl: boolean;
  fullControlLocked: boolean;
  chatOpen: boolean;
  streaming: boolean;
  grantModalOpen: boolean;
  toasts: Toast[];
  setConnectionStatus: (status: ConnectionStatus) => void;
  setDevMode: (devMode: boolean) => void;
  setFullControl: (value: boolean) => void;
  lockFullControl: () => void;
  unlockFullControl: () => void;
  setChatOpen: (value: boolean) => void;
  setStreaming: (value: boolean) => void;
  openGrantModal: () => void;
  closeGrantModal: () => void;
  pushToast: (toast: Omit<Toast, 'id'>) => void;
  dismissToast: (id: string) => void;
};

const getEnvFlag = (value: string | boolean | undefined, fallback: boolean) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value !== 'false';
  return fallback;
};

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      connectionStatus: 'disconnected',
      devMode: getEnvFlag(import.meta.env.VITE_DEV_MODE as unknown as string, true),
      fullControl: false,
      fullControlLocked: false,
      chatOpen: false,
      streaming: false,
      grantModalOpen: false,
      toasts: [],
      setConnectionStatus: (status) => set({ connectionStatus: status }),
      setDevMode: (devMode) => set({ devMode }),
      setFullControl: (value) => set({ fullControl: value, fullControlLocked: false }),
      lockFullControl: () => set({ fullControl: false, fullControlLocked: true }),
      unlockFullControl: () => set({ fullControlLocked: false }),
      setChatOpen: (value) => set({ chatOpen: value }),
      setStreaming: (value) => set({ streaming: value }),
      openGrantModal: () => set({ grantModalOpen: true }),
      closeGrantModal: () => set({ grantModalOpen: false }),
      pushToast: (toast) =>
        set((state) => ({
          toasts: [...state.toasts, { id: crypto.randomUUID(), ...toast }],
        })),
      dismissToast: (id) =>
        set((state) => ({
          toasts: state.toasts.filter((toast) => toast.id !== id),
        })),
    }),
    {
      name: 'uicp-app',
      partialize: (state) => ({
        fullControl: state.fullControl,
        chatOpen: state.chatOpen,
      }),
    },
  ),
);
