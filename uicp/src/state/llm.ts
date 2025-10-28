import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ProviderKey = 'openai' | 'anthropic' | 'openrouter' | 'ollama-cloud' | 'ollama-local';

type LLMState = {
  provider: ProviderKey;
  model: string;
  allowLocalOllama: boolean;
  setProviderModel: (p: ProviderKey, m: string) => void;
  setAllowLocalOllama: (v: boolean) => void;
};

export const useLLM = create<LLMState>()(
  persist(
    (set) => ({
      provider: 'ollama-cloud',
      model: 'glm-4.6',
      allowLocalOllama: false,
      setProviderModel: (provider, model) => set({ provider, model }),
      setAllowLocalOllama: (v) => set({ allowLocalOllama: v }),
    }),
    {
      name: 'llm-preferences',
    },
  ),
);
