UICP Core DX Client (Frontend)

Quickstart
- Install: npm i
- Dev: npm run dev (Tauri uses this as frontend)
- Build: npm run build
- Tests: npm test (unit), npm run test:e2e (Playwright)

Env Vars (Vite)
- VITE_UICP_WS_URL (default ws://localhost:7700)
- VITE_DEV_MODE (default true)
- VITE_MOCK_MODE (default false)

Features
- WebSocket client with hello/resume handshake (mock available)
- Desktop canvas with multi-window frames
- Inspector (Timeline, State, Events, Network) + Command Builder
- Demo workspace to scaffold a Todos window

Notes
- All HTML inserted via dom.replace/dom.append is sanitized to strip scripts and event handlers.

