# Generative Desktop Frontend

React + Tailwind client for the UICP generative desktop. DockChat is the only user surface; the agent drives every UI change through validated UICP Core commands.

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
| `npm run test:e2e` | Playwright flow (uses `npm run preview`) |

## Environment

| variable | default | description |
| --- | --- | --- |
| `VITE_UICP_WS_URL` | `ws://localhost:7700` | Backend WebSocket entrypoint |
| `VITE_DEV_MODE` | `true` | Toggles hello payload `dev` flag |
| `VITE_MOCK_MODE` | `true` | Use deterministic planner + mock api |
| `VITE_PLANNER_URL` | – | External planner endpoint when MOCK false |

## Architecture Highlights

- **DockChat**: Proximity-reveal chat dock with paperclip/send/stop controls, modal gating for full control, and live region system messages.
- **State slices**: `useAppStore` and `useChatStore` persist chat-open/full-control flags and orchestrate planner → adapter flows.
- **UICP Core**: Zod-validated schemas, DOM adapter, and WebSocket transport with heartbeats/idempotency handling.
- **Mock planner**: Deterministic batches for “notepad”, “todo list”, and “dashboard” prompts so MOCK mode works offline.
- **Workspace DOM**: Sanitized HTML mutations under `#workspace-root`, mock component rendering, and memory stores for state APIs.

## Testing

- Unit: `npm run test` (Vitest) covers dock reveal, DockChat, schemas, and adapter behaviour.
- E2E: `npm run test:e2e` (Playwright) runs the notepad planner flow, auto-installing browsers via `npx playwright install`. The config starts `npm run preview` automatically.

## CI

`.github/workflows/ci.yml` runs lint, typecheck, unit, e2e, and build on pushes/PRs. Keep these commands passing locally before pushing.

## Notes

- All HTML from planner commands is sanitized before insertion.
- Planner validation failures raise typed errors and surface through toast + system message.
- Full control is opt-in; STOP locks control until modal consent toggles it back on.
