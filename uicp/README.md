# Generative Desktop Frontend

React + Tailwind client for the UICP generative desktop. DockChat is the only user surface; the agent drives every UI change through validated UICP Core commands. Streaming is provided via Tauri events with a provider/orchestrator on the frontend.

## Quickstart

```bash
cd uicp
pnpm install

# Full desktop with Tauri (recommended)
pnpm run tauri:dev

# UI-only preview (no Tauri bridge functionality)
pnpm run dev
```

> `pnpm run dev` only launches the Vite server. Provider logins, compute bridge actions, keychain access, and other desktop features require `pnpm run tauri:dev`.

The dev server is pinned to `http://127.0.0.1:1420` (see `vite.config.ts`). Tauri uses the same build when running `pnpm run tauri:dev`.

## Scripts

| script              | purpose                                           |
| ------------------- | ------------------------------------------------- |
| `pnpm run dev`       | Start Vite dev server (UI only)                   |
| `pnpm run build`     | Typecheck + bundle for production                 |
| `pnpm run lint`      | ESLint (flat config) over `src/`                  |
| `pnpm run typecheck` | `tsc --noEmit`                                    |
| `pnpm run test`      | Vitest unit suite                                 |
| `pnpm run test:e2e`  | Playwright flow (builds + preview) |

## Environment

| variable                  | default  | description                                                        |
| ------------------------- | -------- | ------------------------------------------------------------------ |
| `VITE_DEV_MODE`           | `true`   | Enables dev-only UX touches                                        |
| `E2E_ORCHESTRATOR`        | unset    | When `1`, opt-in E2E spec for orchestrator (requires real backend) |
| `VITE_PLANNER_TIMEOUT_MS` | `120000` | Planner stream timeout (ms); early-stop parses sooner              |
| `VITE_ACTOR_TIMEOUT_MS`   | `180000` | Actor stream timeout (ms); early-stop parses sooner                |

## Architecture Highlights

- **DockChat**: Proximity-reveal chat dock with paperclip/send/stop controls, modal gating for full control, and live region system messages.
- **Desktop**: `Desktop.tsx` registers `#workspace-root`, renders the top menu bar, and mirrors workspace windows from adapter lifecycle events.
- **Notepad utility**: Built-in desktop shortcut that opens a local-first note window with save/export so users can jot ideas without engaging the agent.
- **State slices**: `useAppStore` and `useChatStore` persist chat-open/full-control flags, desktop shortcut positions, and orchestrate planner → adapter flows.
- **UICP Core**: Zod-validated schemas, DOM adapter, per-window FIFO queue with idempotency and `txn.cancel`.
- **Workspace DOM**: Sanitized HTML mutations under `#workspace-root`, component rendering, and memory stores for state APIs.
- **Event actions**: `data-state-scope`/`data-state-key` auto-bind inputs; `data-command` enqueues JSON batches on click/submit; template tokens like `{{form.title}}` resolve at event time.
- **Streaming**: Frontend `streamOllamaCompletion` subscribes to Tauri `ollama-completion` events and supports best-effort cancel via `cancel_chat(requestId)` when the iterator is closed.
- **Aggregator gating**: The Tauri bridge uses a gating callback—auto-apply when Full Control is ON, otherwise preview; suppresses auto-apply during orchestrator runs.

## Testing

- Unit: `pnpm run test` (Vitest) covers dock reveal, DockChat, schemas, queue semantics, aggregator parse, orchestrator parse, STOP cancel, and stream cancellation.
- E2E: `pnpm run test:e2e` (Playwright) builds and runs UI flows against the preview server.
- Orchestrator E2E (optional): provide an Ollama Cloud API key in-app, then run with `E2E_ORCHESTRATOR=1 pnpm run test:e2e`. This spec is skipped by default.

## CI

`.github/workflows/ci.yml` runs lint, typecheck, unit, e2e, and build on pushes/PRs. Keep these commands passing locally before pushing.

## Notes

- All HTML from planner commands is sanitized before insertion.
- Planner validation failures raise typed errors and surface through toast + system message.
- Full control is opt-in; STOP enqueues `txn.cancel`, locks control until modal consent toggles it back on, and the streaming transport is canceled best-effort via `cancel_chat`.
- File save in Tauri builds: use `api.call` with `url: "tauri://fs/writeTextFile"` and body `{ path, contents, directory?: "AppData" | "Desktop" }` (defaults to AppData) from planner output.
