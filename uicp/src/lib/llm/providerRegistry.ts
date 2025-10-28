export const PROVIDERS = {
  'openai':        { baseUrl: 'https://api.openai.com/v1',    list: { method: 'GET', url: '/models',  idPath: 'data.*.id' } },
  'anthropic':     { baseUrl: 'https://api.anthropic.com',    list: { method: 'GET', url: '/v1/models', idPath: 'data.*.id' } },
  'openrouter':    { baseUrl: 'https://openrouter.ai/api/v1', list: { method: 'GET', url: '/models',  idPath: 'data.*.id' } },
  'ollama-cloud':  { baseUrl: 'https://ollama.com',           list: { method: 'GET', url: '/api/tags', idPath: '*.name'    } },
  'ollama-local':  { baseUrl: 'http://127.0.0.1:11434/v1',    list: { method: 'GET', url: '/models',  idPath: 'data.*.id' } },
} as const;

export type ProviderRegistryKey = keyof typeof PROVIDERS;
