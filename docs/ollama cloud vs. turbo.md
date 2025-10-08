# Ollama Cloud – API endpoints, models, and integration

This document explains how our stack talks to Ollama in both local and cloud modes, lists the current cloud models, and provides sample calls that match our production configuration.

## Local daemon vs. Ollama Cloud

- **Local Ollama** exposes `http://localhost:11434/api/*` (Ollama-native) and `http://localhost:11434/v1/*` (OpenAI-compatible). No credential is required because the daemon binds to localhost.
- **Ollama Cloud** hosts the same surfaces behind `https://ollama.com`, but you must include `Authorization: Bearer <api-key>` on every request. Canonical model IDs use colon tags (e.g., `deepseek-v3.1:671b`, `qwen3-coder:480b`).

### Side-by-side summary

| Item | Local Ollama | Ollama Cloud |
| --- | --- | --- |
| Host | `http://localhost:11434` | `https://ollama.com` |
| Primary endpoints | `/api/*`, `/v1/*` | `/api/*`, `/v1/*` |
| Auth | None | Bearer token |
| Model tags | No suffix | `-cloud` suffix |
| Hardware | Your machine | Managed GPU cluster |

## Cloud model catalog (current)

- `qwen3-coder:480b`
- `deepseek-v3.1:671b`
- `kimi-k2:1t`

Note: Use colon-tag IDs exactly as shown. The app does not append or normalize suffixes.

Use `/api/tags` to fetch the latest list programmatically.

## Example calls

### Enumerate cloud models

```bash
curl -H "Authorization: Bearer <API_KEY>" \
     https://ollama.com/api/tags
```

### Stream a chat completion

```bash
curl https://ollama.com/api/chat \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-oss:120b",
    "messages": [
      {"role": "user", "content": "Why is the sky blue?"}
    ],
    "stream": true
  }'
```

### Python (official library)

```python
import os
from ollama import Client

client = Client(
    host="https://ollama.com",
    headers={"Authorization": f"Bearer {os.environ['OLLAMA_API_KEY']}"},
)

messages = [{"role": "user", "content": "Why is the sky blue?"}]

for part in client.chat("gpt-oss-120b-cloud", messages=messages, stream=True):
    print(part["message"]["content"], end="", flush=True)
```

### JavaScript (official package)

```ts
import { Ollama } from "ollama";

const ollama = new Ollama({
  host: "https://ollama.com",
  headers: { Authorization: `Bearer ${process.env.OLLAMA_API_KEY}` },
});

const response = await ollama.chat({
  model: "gpt-oss-120b-cloud",
  messages: [{ role: "user", content: "Why is the sky blue?" }],
  stream: true,
});

for await (const chunk of response) {
  process.stdout.write(chunk.message.content ?? "");
}
```

## OpenAI-compatible surface

Ollama mirrors the OpenAI Chat Completions endpoints under `/v1`. Local usage: `POST http://localhost:11434/v1/chat/completions`.

Cloud also exposes `/v1`, but this app standardizes on the native path `POST https://ollama.com/api/chat` for Cloud and enforces a base host without `/v1` to avoid configuration drift. Keep Cloud calls on `/api/*`; use `/v1` only for the local daemon.

## Integration checklist for our app

- **Auth**: Always send `Authorization: Bearer <api-key>` when `USE_DIRECT_CLOUD=1`.
- **Endpoints**: Use `GET https://ollama.com/api/tags` to test keys and `POST https://ollama.com/api/chat` for streaming; the local fallback uses `/v1` endpoints.
- **Model names**: Use colon-tag IDs (e.g., `deepseek-v3.1:671b`, `qwen3-coder:480b`).
- **Streaming**: Cloud responses use SSE. The backend forwards each SSE data line (JSON or text), and the frontend parser extracts JSON from the stream, handling both complete objects and chunked delivery.

Following these rules lets the product swap between local and cloud inference with minimal friction while fully complying with Ollama Cloud requirements.
