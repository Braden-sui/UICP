# Model Usage (Ollama Cloud)

## Base Endpoint
- `https://ollama.com`

## Authentication
- Header: `Authorization: <api-key>`
- No `Bearer` prefix (per https://docs.ollama.com/cloud#python-2)
- Keys are user-provided and stored locally in `.env` (MVP).

## Default Models
- Primary: `kimi-k2:1t-cloud`
- Fallback (post-MVP): `qwen3-coder:480b-cloud`

## Example Request (Python, from docs)
```python
headers = {
    'Authorization': '<api key>'
}

payload = {
    "model": "kimi-k2:1t-cloud",
    "messages": [
        {"role": "system", "content": "You are Gui, an AI UI conductor."},
        {"role": "user", "content": "Create a dashboard"}
    ]
}

response = requests.post(
    "https://ollama.com",
    headers=headers,
    json=payload,
    stream=True
)
```

## Notes
- Streaming responses follow the OpenAI Chat Completions protocol (`data: {...}` lines).
- Tool/function calling is supported via the same `function_call` schema.
- Local Ollama (localhost:11434) uses the same format but requires no `Authorization` header.


