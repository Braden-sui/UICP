# MiniApp capabilities (v0.1)

The MiniApp runtime lives inside an iframe and operates strictly through the host bridge (`hostBridge.ts`). The following guardrails are non-negotiable for v0.1:

## Secrets

- Secrets never cross into the iframe. The embedded keystore remains host-only; MiniApps cannot call `secrets.read`, `secrets.write`, or any equivalent API.

## File system dialogs

- MiniApps do not get file picker or save dialogs. Desktop file access stays in the host shell.

## Network

- MiniApps cannot reach the network directly. All outbound requests must go through the `egress_fetch` command exposed by the host. No `fetch`, WebSocket, or other network primitives are permitted inside the iframe.

These constraints are deliberate. Do not add new bridge methods or capabilities without a security review and policy update.
