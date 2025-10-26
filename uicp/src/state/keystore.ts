import { create } from 'zustand';
import { keystoreStatus, keystoreUnlockPassphrase, keystoreLock, saveProviderApiKey } from '../lib/bridge/tauri';
import { inv } from '../lib/bridge/tauri';

type KeystoreState = {
  locked: boolean;
  ttlRemainingSec: number | null;
  method: string | null;
  busy: boolean;
  error?: string;
  refreshStatus: () => Promise<void>;
  unlock: (passphrase: string) => Promise<boolean>;
  quickLock: () => Promise<void>;
  saveProviderKey: (provider: 'openai' | 'anthropic' | 'ollama' | 'openrouter', key: string) => Promise<boolean>;
};

let ticker: number | null = null;

const startTicker = (get: () => KeystoreState, set: (patch: Partial<KeystoreState>) => void) => {
  if (ticker != null) return;
  ticker = (setInterval(() => {
    const s = get();
    if (s.locked || s.ttlRemainingSec == null) return;
    const next = Math.max(0, s.ttlRemainingSec - 1);
    if (next === 0) {
      // Re-sync from backend when countdown hits zero
      s.refreshStatus();
    } else {
      set({ ttlRemainingSec: next });
    }
  }, 1000) as unknown) as number;
};

const stopTicker = () => {
  if (ticker != null) {
    clearInterval(ticker as unknown as number);
    ticker = null;
  }
};

export const useKeystore = create<KeystoreState>((set, get) => ({
  locked: true,
  ttlRemainingSec: null,
  method: null,
  busy: false,
  error: undefined,
  refreshStatus: async () => {
    const res = await keystoreStatus();
    if (!res.ok || res.value == null) {
      // Treat missing or errored payloads as locked to avoid surfacing runtime errors.
      set({ locked: true, ttlRemainingSec: null, method: null });
      stopTicker();
      return;
    }
    const { locked, ttl_remaining_sec, method } = res.value;
    set({ locked, ttlRemainingSec: ttl_remaining_sec ?? null, method: method ?? null });
    if (!locked) startTicker(get, (patch) => set(patch)); else stopTicker();
  },
  unlock: async (passphrase: string) => {
    set({ busy: true, error: undefined });
    const res = await keystoreUnlockPassphrase(passphrase);
    set({ busy: false });
    if (!res.ok || res.value == null) {
      set({ error: res.ok ? 'Keystore returned no status payload' : res.error.message });
      return false;
    }
    const { locked, ttl_remaining_sec, method } = res.value;
    set({ locked, ttlRemainingSec: ttl_remaining_sec ?? null, method: method ?? null });
    if (!locked) startTicker(get, (patch) => set(patch));
    return !locked;
  },
  quickLock: async () => {
    await keystoreLock();
    set({ locked: true, ttlRemainingSec: null, method: null });
    stopTicker();
  },
  saveProviderKey: async (provider, key) => {
    const res = await saveProviderApiKey(provider === 'openrouter' ? 'openai' : (provider as 'openai' | 'anthropic'), key);
    if (!res.ok) return false;
    if (provider === 'ollama') {
      const test = await inv<{ valid: boolean; message?: string }>('test_api_key');
      if (!test.ok || !test.value.valid) return false;
    }
    return true;
  },
}));
