# Generative Desktop

Local-first Tauri UI that exposes a clean desktop canvas and a DockChat surface. DockChat is the only control that users touch while the agent drives the UI through UICP Core commands. Streaming uses Tauri events; MOCK mode ships with a deterministic planner so the flow works without any backend.

## Quickstart

```bash
cd uicp
npm install
npm run dev
```

The dev server expects the Tauri shell to proxy at `http://localhost:1420`. When running standalone, open the Vite dev URL (`http://localhost:5173`).

## Commands

- `npm run dev` – start Vite in development mode
- `npm run build` – typecheck + bundle for production
- `npm run lint` – ESLint over `src`
- `npm run typecheck` – strict TS compile
- `npm run test` – Vitest unit suite (`tests/unit`)
- `npm run test:e2e` - Playwright smoke (`tests/e2e/specs`), builds with MOCK mode then runs preview

## Environment

| variable | default | notes |
| --- | --- | --- |
| `VITE_DEV_MODE` | `true` | enables developer UX touches |
| `VITE_MOCK_MODE` | `true` | when true the deterministic planner + mock api are used |
| `E2E_ORCHESTRATOR` | unset | set to `1` to run the orchestrator E2E (requires real backend)

## Architecture

- `src/components/Desktop.tsx` – registers the `#workspace-root` canvas the adapter mutates.
- `src/components/DockChat.tsx` - chat surface with proximity reveal, STOP handling, and plan preview.
- `src/components/LogsPanel.tsx` - toggleable desktop logs panel showing the chat/system message history for auditing.
- `src/state/app.ts` – global flags (chat open, streaming, full control) with persistence.
- `src/state/chat.ts` – planner pipeline, plan queueing, STOP lock.
- `src/lib/uicp` - Zod schemas, DOM adapter, per-window FIFO queue with idempotency and txn.cancel, and documentation.
- `src/lib/mock.ts` – deterministic planner outputs for common prompts.

## Testing

1. `npm run test` executes the Vitest suite covering the reveal hook, DockChat behaviour, schema validation, queue semantics, aggregator/orchestrator parse, STOP, and stream cancellation.
2. `npm run test:e2e` drives the notepad flow end-to-end in Playwright. The config builds with `VITE_MOCK_MODE=true` and starts preview automatically. Optional orchestrator E2E is gated by `E2E_ORCHESTRATOR=1` and requires a Tauri runtime + valid API key.

CI (`.github/workflows/ci.yml`) runs lint, typecheck, unit tests, e2e, and build on every push/PR.
