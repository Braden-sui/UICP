# User Guide: Understanding UICP

## What is UICP

- UICP is a local‑first desktop you build by describing what you want. The AI plans the work, then applies safe building blocks called commands. This is not a toy: it’s a usable desktop for day‑to‑day flows.

## Core concepts

- Windows: surfaces to show content.
- Commands: small, safe steps like “set this state path” or “render this component”.
- Planner: decides the steps.
- Actor: turns steps into exact commands that pass validation.

## Full Control mode

- You approve plans before they run. When Full Control is OFF, the app shows a preview; when ON, it auto‑applies validated batches.

## Reset

- You can reset a window, a workspace, or the whole session.
- Files in `ws:/files` are not deleted unless you choose to.
