# Generative Desktop

Local-first Tauri UI that exposes a clean desktop canvas and a DockChat surface. DockChat is the only control that users touch while the agent drives the UI through UICP Core commands. Streaming uses Tauri events; MOCK mode ships with a deterministic planner so the flow works without any backend.

Key runtime guardrails
- Environment Snapshot is prepended to planner/actor prompts (agent flags, open windows, last trace, and a trimmed DOM summary) to boost context-awareness.
- Models must not emit event APIs or inline JS. Interactivity is declared via `data-command` and `data-state-*` attributes only; the adapter executes these declaratively.
- Adapter auto-creates a shell window if a batch targets a missing `windowId` for `window.update`, `dom.*`, or `component.render`, and persists the synthetic `window.create` to keep replay consistent.
- Command replay preserves original creation order (no hoisting). Window closure deletes persisted commands for that window; workspace reset clears all.

## Quickstart

```bash
cd uicp
npm install
npm run dev
```

The dev server expects the Tauri shell to proxy at `http://localhost:1420`. When running standalone, open the Vite dev URL (`http://localhost:5173`).
When running standalone (without Tauri), this project still uses port `1420` as configured in `uicp/vite.config.ts`.
Open `http://127.0.0.1:1420`.

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
| `VITE_PLANNER_PROFILE` | `deepseek` | default planner profile (`deepseek`, `kimi`). Overridable via Agent Settings window. |
| `VITE_ACTOR_PROFILE` | `qwen` | default actor profile (`qwen`, `kimi`). Overridable via Agent Settings window. |

Environment Snapshot
- Included by default in planner/actor prompts; no flag required. It lists agent state and open windows (with a trimmed DOM summary) to help models target updates instead of recreating UI.
- Size budget: target ~16 KB (hard cap 32 KB). Truncation rules are documented in `docs/architecture.md` (drop excess windows; no file contents; deterministic ordering).

## Agent profiles & settings

- **Planner / actor selection** – The desktop ships an *Agent Settings* utility (gear shortcut on the left rail). Switch the planner (reasoning) and actor (batch builder) between available profiles without rebuilding.
  - Planner profiles: `deepseek` (default: `deepseek-v3.1:671b`), `kimi` (default: `kimi-k2:1t`)
  - Actor profiles: `qwen` (default: `qwen3-coder:480b`), `kimi` (default: `kimi-k2:1t`)
- **Persistence** – Selections persist via Zustand storage (`uicp-app` key) and apply to the next intent immediately.
- **Cloud endpoint** – Uses Ollama Cloud native API: `POST https://ollama.com/api/chat` (SSE streaming). Local daemon uses OpenAI-compatible `/v1/chat/completions`.
- **Model IDs** – Use colon tags (e.g., `deepseek-v3.1:671b`, `qwen3-coder:480b`). Ensure your Ollama Cloud API key has access to the selected models.

## Architecture

- `src/components/Desktop.tsx` – registers the `#workspace-root` canvas, exposes the desktop menu bar, and keeps the window list in sync with adapter lifecycle events.
- `src/components/DockChat.tsx` - chat surface with proximity reveal, STOP handling, and plan preview.
- `src/components/LogsPanel.tsx` - menu-controlled logs window that mirrors chat/system history for auditing.
- `src/state/app.ts` – global flags (chat open, streaming, full control) plus persisted desktop shortcuts and workspace window metadata.
- `src/state/chat.ts` – planner pipeline, plan queueing, STOP lock.
- `src/lib/uicp` - Zod schemas, DOM adapter, per-window FIFO queue with idempotency and txn.cancel, and documentation.
- `src/lib/mock.ts` – deterministic planner outputs for common prompts.

- Compute plane: Feature-gated Wasm host (see `docs/compute/README.md`). When a task is not suitable for local compute, external APIs remain first-class and are supported via `api.call`.

## Testing

1. `npm run test` executes the Vitest suite covering the reveal hook, DockChat behaviour, schema validation, queue semantics, aggregator/orchestrator parse, STOP, and stream cancellation.
2. `npm run test:e2e` drives the notepad flow end-to-end in Playwright. The config builds with `VITE_MOCK_MODE=true` and starts preview automatically. Optional orchestrator E2E is gated by `E2E_ORCHESTRATOR=1` and requires a Tauri runtime + valid API key.

CI (`.github/workflows/ci.yml`) runs lint, typecheck, unit tests, e2e, and build on every push/PR.
