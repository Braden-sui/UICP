import 'dotenv/config';
import { describe, expect, test } from 'vitest';

type HarmonyMessage = {
  channel?: string;
  content?: string;
};

type HarmonyChoice = {
  message?: HarmonyMessage;
};

type HarmonyResponse = {
  choices?: HarmonyChoice[];
  message?: HarmonyMessage;
  messages?: HarmonyMessage[];
  response?: {
    message?: HarmonyMessage;
    messages?: HarmonyMessage[];
  };
};

const runLive = process.env.OLLAMA_LIVE_TEST === '1';

const testOrSkip = runLive ? test : test.skip;

const MODEL_ID = 'gpt-oss:120b-cloud';
const OLLAMA_CHAT_URL = 'https://ollama.com/api/chat';

const promptMessages = [
  {
    role: 'system',
    content:
      'You are an automated verification assistant that follows Harmony channels (analysis, commentary, final). Keep analysis private and only speak to the user via final.',
  },
  {
    role: 'user',
    content: 'Respond on the final channel with exactly OK (uppercase) and nothing else. Do not call tools.',
  },
];

describe(runLive ? 'Ollama Cloud live smoke' : 'Ollama Cloud live smoke (skipped)', () => {
  testOrSkip('gpt-oss 120B returns a valid Harmony final reply', async () => {
    const apiKey = process.env.OLLAMA_API_KEY;
    expect(apiKey, 'Set OLLAMA_API_KEY to run live Ollama tests').toBeTruthy();

    const response = await fetch(OLLAMA_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL_ID,
        messages: promptMessages,
        stream: false,
      }),
    });

    const rawBody = await response.text();
    expect(response.ok, `Ollama chat request failed with ${response.status}: ${rawBody}`).toBe(true);

    const payload = JSON.parse(rawBody) as HarmonyResponse;

    const candidates: HarmonyMessage[] = [];
    if (Array.isArray(payload.choices)) {
      for (const choice of payload.choices) {
        if (choice?.message) candidates.push(choice.message);
      }
    }
    if (payload.message) {
      candidates.push(payload.message);
    }
    if (Array.isArray(payload.messages)) {
      candidates.push(...payload.messages);
    }
    if (payload.response?.message) {
      candidates.push(payload.response.message);
    }
    if (Array.isArray(payload.response?.messages)) {
      candidates.push(...payload.response.messages);
    }

    expect(
      candidates.length,
      `Ollama response missing Harmony messages: ${rawBody}`,
    ).toBeGreaterThan(0);

    let finalMessage = candidates.find((message) => message?.channel === 'final');
    if (!finalMessage && candidates.length) {
      finalMessage = candidates[candidates.length - 1];
    }
    expect(finalMessage, `No Harmony messages in response: ${rawBody}`).toBeTruthy();

    const finalContent = finalMessage?.content?.trim();
    expect(finalContent, 'Final channel content missing').toBe('OK');
  }, 120_000);
});


