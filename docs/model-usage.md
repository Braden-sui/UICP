# Model Usage (Ollama Cloud)

## Base Endpoints
- Cloud: `https://ollama.com` (use native `/api/*` paths; do not append `/v1` in this app)
- Local: `http://127.0.0.1:11434/v1` (OpenAI-compatible)

## Authentication
- Header: `Authorization: Bearer <api-key>`
- Keys are user-provided and stored locally in `.env` (MVP).

## Default Models
- Primary: `qwen3-coder:480b-cloud`
- Fallback (post-MVP): `qwen3-coder:480b`

## Example Request (Python, from docs)
```python
headers = {
    'Authorization': '<api key>'
}

payload = {
    "model": "qwen3-coder:480b-cloud",
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


