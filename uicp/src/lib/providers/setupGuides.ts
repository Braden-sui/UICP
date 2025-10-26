export type ProviderId = 'openai' | 'anthropic' | 'openrouter' | 'ollama';

export type ProviderGuide = {
  id: ProviderId;
  label: string;
  summary: string;
  steps: string[];
  docsUrl: string;
};

export const PROVIDER_GUIDES: ProviderGuide[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    summary: 'Use OpenAI\'s developer dashboard to create a secret key. Keys are shown once.',
    steps: [
      'Sign in at https://platform.openai.com/ with your developer account.',
      'Verify billing is enabled so requests are not blocked.',
      'Open "API keys" in the dashboard and click "Create new secret key".',
      'Copy the key immediately. OpenAI only displays it once.',
      'Paste the key below. We encrypt it locally and never send it to the UI.',
    ],
    docsUrl: 'https://help.openai.com/en/articles/5112595-best-practices-for-api-key-safety',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    summary: 'Claude requires an API key from console.anthropic.com with an approved workspace.',
    steps: [
      'Sign in at https://console.anthropic.com/ and select the correct organization.',
      'Go to Settings → API Keys and click "Create Key".',
      'Copy the key; it is shown once. You can revoke it later from the same page.',
      'Every request uses the key in the "x-api-key" header.',
      'Paste the key below so we can call Claude securely from the backend.',
    ],
    docsUrl: 'https://docs.anthropic.com/en/docs/initial-setup',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    summary: 'Create a Bearer token on OpenRouter and optionally set spending limits.',
    steps: [
      'Sign in at https://openrouter.ai/ and open Docs → API Keys.',
      'Click "Create API key" and give it a descriptive name (e.g. "UICP Desktop").',
      'Optionally configure a credit limit or referrer so you can track usage.',
      'Copy the Bearer token that is generated.',
      'Paste the token below. We will send it only from the host runtime.',
    ],
    docsUrl: 'https://openrouter.ai/docs/api-keys',
  },
  {
    id: 'ollama',
    label: 'Ollama Cloud',
    summary: 'Ollama Cloud provides hosted models. Local Ollama installs do not need a key.',
    steps: [
      'Register or sign in at https://cloud.ollama.com/.',
      'Open Account → API Keys and create a new key.',
      'Copy the key. It authorizes requests to the cloud endpoint.',
      'Paste the key below. We store it encrypted and add the Authorization header for you.',
      'If you only run Ollama locally, you can skip this key.',
    ],
    docsUrl: 'https://docs.ollama.com/cloud',
  },
];

export const PROVIDER_SECRET_IDS: Record<ProviderId, string> = {
  openai: 'env:uicp:openai:api_key',
  anthropic: 'env:uicp:anthropic:api_key',
  openrouter: 'env:uicp:openrouter:api_key',
  ollama: 'env:uicp:ollama:api_key',
};
