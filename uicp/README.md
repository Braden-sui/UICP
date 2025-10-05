# Generative Desktop Frontend

React + Tailwind client for the UICP generative desktop. DockChat is the only user surface; the agent drives every UI change through validated UICP Core commands. Streaming is provided via Tauri events with a provider/orchestrator on the frontend.

## Quickstart

```bash
cd uicp
npm install
npm run dev
```

The Vite dev server defaults to `http://localhost:5173`. Tauri uses the same build when running `npm run tauri:dev`.

## Scripts

| script | purpose |
| --- | --- |
| `npm run dev` | Start Vite dev server |
| `npm run build` | Typecheck + bundle for production |
| `npm run lint` | ESLint (flat config) over `src/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Vitest unit suite |
| `npm run test:e2e` | Playwright flow (builds + preview with MOCK mode) |

## Environment

| variable | default | description |
| --- | --- | --- |
| `VITE_DEV_MODE` | `true` | Enables dev-only UX touches |
| `VITE_MOCK_MODE` | `true` | Use deterministic planner + mock API for offline & tests |
| `E2E_ORCHESTRATOR` | unset | When `1`, opt-in E2E spec for orchestrator (requires real backend) |

## Architecture Highlights

- **DockChat**: Proximity-reveal chat dock with paperclip/send/stop controls, modal gating for full control, and live region system messages.
- **State slices**: `useAppStore` and `useChatStore` persist chat-open/full-control flags and orchestrate planner → adapter flows.
- **UICP Core**: Zod-validated schemas, DOM adapter, per-window FIFO queue with idempotency and `txn.cancel`.
- **Mock planner**: Deterministic batches for "notepad", "todo list", and "dashboard" prompts so MOCK mode works offline.
- **Workspace DOM**: Sanitized HTML mutations under `#workspace-root`, mock component rendering, and memory stores for state APIs.
- **Streaming**: Frontend `streamOllamaCompletion` subscribes to Tauri `ollama-completion` events and supports best-effort cancel via `cancel_chat(requestId)` when the iterator is closed.
- **Aggregator gating**: The Tauri bridge uses a gating callback—auto-apply when Full Control is ON, otherwise preview; suppresses auto-apply during orchestrator runs.

## Testing

- Unit: `npm run test` (Vitest) covers dock reveal, DockChat, schemas, queue semantics, aggregator parse, orchestrator parse, STOP cancel, and stream cancellation.
- E2E: `npm run test:e2e` (Playwright) builds with `VITE_MOCK_MODE=true` and runs the mock notepad flow deterministically.
- Orchestrator E2E (optional): build with `VITE_MOCK_MODE=false`, provide an Ollama Cloud API key in-app, then run with `E2E_ORCHESTRATOR=1 npm run test:e2e`. This spec is skipped by default.

## CI

`.github/workflows/ci.yml` runs lint, typecheck, unit, e2e, and build on pushes/PRs. Keep these commands passing locally before pushing.

## Notes

- All HTML from planner commands is sanitized before insertion.
- Planner validation failures raise typed errors and surface through toast + system message.
- Full control is opt-in; STOP enqueues `txn.cancel`, locks control until modal consent toggles it back on, and the streaming transport is canceled best-effort via `cancel_chat`.
