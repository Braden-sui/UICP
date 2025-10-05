# UICP Desktop Setup (Windows MVP)

## Prerequisites
- **Rust**: Stable toolchain via `rustup` (https://rustup.rs/)
- **Node.js**: v22.x (bundled npm)
- **Tauri CLI**: `npm install -g @tauri-apps/cli`
- **Visual C++ Build Tools** (MSVC)
- **Ollama Cloud API key** from https://ollama.com

## Project Layout
```
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
- Logs: `~/Documents/UICP/logs/` (planned)

## Models (default)
- Primary: `qwen3-coder:480b-cloud`
- Fallback (post-MVP): `qwen3-coder:480b`

## Authorization
Requests to Ollama Cloud use:
```
Authorization: <api-key>
```
No `Bearer` prefix is required (see https://docs.ollama.com/cloud#python-2).

## Notes
- Workspace state persists once you click **Save** (writes to `~/Documents/UICP/data.db`).
- Tauri config lives at `uicp/src-tauri/tauri.conf.json` (v2 schema).