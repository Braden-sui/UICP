# UICP Desktop Setup (Windows MVP)

## Prerequisites
- **Rust**: Stable toolchain via `rustup` (https://rustup.rs/)
- **Node.js**: v20.x (see `uicp/package.json` engines)
- **Tauri CLI**: ` npm install -g @tauri-apps/cli`
- **Visual C++ Build Tools** (MSVC)
- **Ollama Cloud API key** from https://ollama.com

## Project Layout
```text
AI web-interface/
├─ uicp/             # React + Tailwind webview
│  └─ src-tauri/     # Async Rust backend
└─ docs/             # Documentation
```
