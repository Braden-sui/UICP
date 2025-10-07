# UICP Desktop Setup (Windows MVP)

## Prerequisites
- **Rust**: Stable toolchain via `rustup` (https://rustup.rs/)
- **Node.js**: v20.x (see `uicp/package.json` engines)
- **Tauri CLI**: `npm install -g @tauri-apps/cli`
- **Visual C++ Build Tools** (MSVC)
- **Ollama Cloud API key** from https://ollama.com

## Project Layout
{{ ... }}
AI web-interface/
├─ uicp/             # React + Tailwind webview
│  └─ src-tauri/     # Async Rust backend
└─ docs/             # Documentation
```

## Install Dependencies
```powershell
cd uicp
npm install
```

## Configure Ollama API key (.env)
Store the key locally for the MVP:
```powershell
New-Item -Type Directory -Force "$env:USERPROFILE\Documents\UICP" | Out-Null
Set-Content "$env:USERPROFILE\Documents\UICP\.env" "OLLAMA_API_KEY=your_key_here"
```
You can also paste the key in the in-app Settings modal (writes the same `.env`).

### Optional: Planner/Actor timeouts (build-time)
Add generous timeouts (in milliseconds) if you expect long generations. Early-stop parsing still returns as soon as the JSON is complete.

```env
# Vite build-time env
VITE_PLANNER_TIMEOUT_MS=120000
VITE_ACTOR_TIMEOUT_MS=180000
```

## Run in Development
```powershell
cd uicp
npm run tauri:dev
```
This starts Vite (port 1420) and the Tauri shell.

## Build Release Bundle
```powershell
cd uicp
npm run tauri:build
```
Artifacts land under `uicp/src-tauri/target/release/bundle/`.

## Data & Logs
- SQLite DB: `~/Documents/UICP/data.db`
- `.env`: `~/Documents/UICP/.env`
- Logs: `~/Documents/UICP/logs/`

## Models (default)
- Primary: `qwen3-coder:480b-cloud`
- Fallback (post-MVP): `qwen3-coder:480b`

## Authorization
Requests to Ollama Cloud use the Bearer token header:
```
Authorization: Bearer <api-key>
```
Primary endpoints invoked by the app:
```
GET  https://ollama.com/api/tags   # key validation / model list
POST https://ollama.com/api/chat   # streaming chat completions
```

Notes:
- Do not append `/v1` to the Cloud base URL in app config. We standardize on `https://ollama.com` + `/api/chat` for Cloud. Local offload uses `/v1` endpoints.
- STOP cancels long generations via a Tauri backend command; the HTTP client has no hard timeout.

## Notes
- Workspace state persists once you click **Save** (writes to `~/Documents/UICP/data.db`).
- Tauri config lives at `uicp/src-tauri/tauri.conf.json` (v2 schema).
- Pressing `Ctrl+Shift+I` (Windows/Linux) or `Cmd+Opt+I` (macOS) now logs a devtools analytics event; open the **Metrics** window to inspect shortcut direction, agent phase, and streaming context.
