import { create } from 'zustand';

export type ProviderKey = 'openai' | 'anthropic' | 'openrouter' | 'ollama-cloud' | 'ollama-local';

type LLMState = {
  provider: ProviderKey;
  model: string;
  allowLocalOllama: boolean;
  setProviderModel: (p: ProviderKey, m: string) => void;
  setAllowLocalOllama: (v: boolean) => void;
};

export const useLLM = create<LLMState>((set) => ({
  provider: 'ollama-cloud',
  model: 'llama3.1-405b-instruct',
  allowLocalOllama: false,
  setProviderModel: (provider, model) => set({ provider, model }),
  setAllowLocalOllama: (v) => set({ allowLocalOllama: v }),
}));
