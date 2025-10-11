Model formatting for the planner/actor pipeline (JSON only)
================================================================

Last reviewed: 2025-10-11  
Audience: engineers editing prompts, profiles, or backend integrations for the planner (`getPlannerClient`) and actor (`getActorClient`) flows.

Summary
-------
- Planner profile defaults: `deepseek` or `kimi`. Actor profile defaults: `qwen` or `kimi`. Set via `VITE_PLANNER_PROFILE` / `VITE_ACTOR_PROFILE`.
- The runtime prepends an Environment Snapshot (agent flags, open windows, and trimmed DOM) before the developer prompt. **Do not** include your own snapshot copy.
- Responses must be valid JSON with no surrounding prose, code fences, or channel markers. Harmony sentinels (`<|start|>`, `analysis`, `commentary`, `final`, etc.) are deprecated.
- Planner output schema: `{ summary: string, risks?: string[], batch: Command[], actor_hints?: string[] }`.
- Actor output schema: `{ batch: Command[] }`. Commands must validate against `uicp/src/lib/uicp/schemas.ts`.

1. Request templates
--------------------

### Planner
```
[
  { "role": "system", "content": "<environment snapshot injected at runtime>" },
  { "role": "developer", "content": plannerPrompt },   // uicp/src/prompts/planner.txt
  { "role": "user", "content": "<intent text>" }
]
```

### Actor
```
[
  { "role": "system", "content": "<environment snapshot injected at runtime>" },
  { "role": "developer", "content": actorPrompt },     // uicp/src/prompts/actor.txt
  { "role": "user", "content": "<planner JSON string>" }
]
```

Prompts already instruct the models to “Output JSON only.” Do not add extra role turns unless you are extending the orchestrator.

2. Response requirements
------------------------

### Shared
- First non-whitespace character must be `{` (object) or `[` (array). No preambles, explanations, or markdown fences.
- Strings must be valid UTF‑8 with the UTF‑8 BOM removed. The orchestrator strips a BOM defensively, but keep prompts strict to avoid leniency.
- Keep HTML compact and safe: no `<script>`, `<style>`, inline event handlers, or `javascript:` URLs. Interactivity lives in `data-command` and `data-state-*` attributes.
- Maximum batch size: 64 commands (`MAX_OPS_PER_BATCH`). Per-command HTML cap: 64 KB. Total HTML per batch: 128 KB.
- Planner and actor must never invent operations outside the enum in `schemas.ts`.

### Planner-specific
- `summary`: a concise sentence (<= 140 chars recommended).
- `risks`: actionable implementation hints. Include `clarifier:structured` when asking follow-up questions through `api.call uicp://intent`.
- `batch`: either empty (actor-only) or upfront commands (e.g., static window create).
- `actor_hints`: optional array (max 20 entries) guiding the actor—think TODOs, aria-live reminders, etc.

### Actor-specific
- Return `{ "batch": [ ... ] }` even for empty batches (`[]`).
- Ensure referenced windows exist (create or reuse). Prefer `dom.set` over `dom.replace` after initial mount.
- Stamp or preserve stable IDs (`windowId`, `componentId`) if the planner provided them.
- Leave observability to the runtime; the actor should not emit logs.

3. Examples
-----------

### Planner output
```json
{
  "summary": "Create a notepad window with name and body fields",
  "risks": [
    "gui: reuse window id win-notepad",
    "gui: include aria-live status element updated via dom.set"
  ],
  "batch": [
    {
      "op": "window.create",
      "params": { "id": "win-notepad", "title": "Notepad", "width": 640, "height": 480 }
    }
  ],
  "actor_hints": [
    "Populate #root via dom.replace once, then use dom.set for updates",
    "Wire Save button with data-command calling api.call tauri://fs/writeTextFile"
  ]
}
```

### Actor output
```json
{
  "batch": [
    {
      "op": "dom.replace",
      "params": {
        "windowId": "win-notepad",
        "target": "#root",
        "html": "<div class=\"flex h-full flex-col gap-3 p-4\">...</div>"
      }
    },
    {
      "op": "dom.set",
      "params": {
        "windowId": "win-notepad",
        "target": "#status",
        "html": "<span class=\"text-xs text-emerald-600\">Saved</span>"
      }
    }
  ]
}
```

4. API example (Ollama Cloud)
-----------------------------

```python
import json
import os
import requests

API_KEY = os.environ["OLLAMA_API_KEY"]
URL = "https://ollama.com/api/chat"

messages = [
    {"role": "system", "content": "<env snapshot goes here>"},
    {"role": "developer", "content": open("uicp/src/prompts/planner.txt").read().strip()},
    {"role": "user", "content": "Draft a notepad window with autosave feedback."}
]

payload = {
    "model": "deepseek-v3.1:671b",
    "messages": messages,
    "stream": True,
    "format": "json",
    "response_format": {"type": "json_object"}
}

resp = requests.post(URL, headers={"Authorization": f"Bearer {API_KEY}"}, json=payload, stream=True)
for line in resp.iter_lines():
    if not line:
        continue
    if line.startswith(b"data: "):
        event = json.loads(line[6:])
        for choice in event.get("choices", []):
            content = choice.get("message", {}).get("content")
            if content:
                print(content)
```

When streaming locally through the Tauri backend, `streamOllamaCompletion` sets the same `format` and `response_format` options, so adhering to the JSON contract keeps the orchestrator fast-path engaged.

5. Legacy references
--------------------

- Harmony / GPT-OSS documentation now lives in `docs/legacy/Model Formatting (Harmony).md`.
- Archived Harmony samples (multi-channel sentinel format) are at `docs/legacy/harmony-samples.md`.

If you reintroduce GPT-OSS or other multi-channel models, restore the legacy documentation in a dedicated RFC first, then update this guide with the new contract.
