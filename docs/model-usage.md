# Model Usage (Ollama Cloud)

## Base Endpoints
- Cloud: `https://ollama.com` (use native `/api/*` paths; do not append `/v1` in this app)
- Local: `http://127.0.0.1:11434/v1` (OpenAI-compatible)

## Authentication
- Header: `Authorization: Bearer <api-key>`
- Keys are user-provided and stored locally in `.env` (MVP).

## Default Models
- Planner: `deepseek-v3.1:671b` (profile: `deepseek`)
- Actor: `qwen3-coder:480b` (profile: `qwen`)

## Example Request (Python, from docs)
```python
headers = {
    'Authorization': f"Bearer {os.environ['OLLAMA_API_KEY']}"
}

payload = {
    "model": "qwen3-coder:480b",
    "messages": [
        {"role": "system", "content": "You are Gui, an AI UI conductor."},
        {"role": "user", "content": "Create a dashboard"}
    ]
}

response = requests.post(
    "https://ollama.com/api/chat",
    headers=headers,
    json=payload,
    stream=True
)
```

## Notes
- Cloud requests standardize on `POST https://ollama.com/api/chat` with `Authorization: Bearer <api-key>`.
- Local offload uses `POST http://127.0.0.1:11434/v1/chat/completions` with no auth.
- Streaming responses arrive as newline-delimited JSON; the Tauri backend re-emits chunks to the webview for parsing.
- Optional: add `"format": "json"` to bias models toward strict JSON outputs when needed.

## Response format
- Planner and Actor prompts expect pure JSON responses with no Markdown fences or commentary.
- DeepSeek/Qwen/Kimi profiles use legacy single-channel response mode with tool calls in standard OpenAI format.
- Downstream parsing extracts JSON from streamed SSE chunks; non-JSON content triggers fallback handling.

## Source references
- Ollama Cloud models (official): https://docs.ollama.com/cloud
- DeepSeek model: https://ollama.com/library/deepseek-v3.1
- Qwen3-Coder model: https://ollama.com/library/qwen3-coder
- Kimi K2 model: https://ollama.com/library/kimi-k2

