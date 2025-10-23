# Network Ops Artifacts (OPS-ONLY)

> WARNING: These scripts are for operators/admins, not end users. The desktop app never invokes them. Host firewall changes are disabled by default and require two explicit confirmations.

Purpose

- This folder contains operator- and CI-facing scripts and configuration for network policy experiments and enforcement (e.g., host firewall, platform-specific installers, allowlist generation).

Policy and scope

- OPS-ONLY: These scripts are not executed by the desktop app under any circumstance.
- The application enforces egress policy in-process via the UI Network Guard (`VITE_NET_GUARD_*`).
- Provider network is disabled unless `UICP_ALLOW_NET=1`; when enabled, requests remain constrained by httpjail allowlists (`UICP_HTTPJAIL_ALLOWLIST` override supported).

App (in-process) network guard

- Process-level wrappers intercept `fetch`, XHR, WebSocket, EventSource, Beacon, WebRTC, WebTransport, and Worker APIs.
- Default behavior:
  - Loopback allowed: `localhost`, `127.0.0.1`, `::1`.
  - LAN/private ranges blocked by default (RFC1918/CGNAT/link-local).
  - DoT/DoQ/DoH providers blocked (port 853 and common DoH domains).
  - Metadata endpoints blocked (e.g., `169.254.169.254`, `fd00:ec2::254`).
  - Workers/SharedWorkers: monitor-only by default; ServiceWorkers blocked by default.
  - WebRTC/WebTransport: monitor-only by default (log attempts; allow).
- Dev default: monitor-only (`VITE_NET_GUARD_MONITOR=1`) so development tools work, with LAN still blocked unless explicitly allow-listed.

Environment variables (Vite)

- Core
  - `VITE_NET_GUARD_ENABLED=1` (process-level guard on/off)
  - `VITE_NET_GUARD_MONITOR=1` (do not hard-block; still logs and evaluates policy)
  - `VITE_GUARD_VERBOSE=0`
- Allow lists
  - `VITE_GUARD_ALLOW_DOMAINS=localhost`
  - `VITE_GUARD_ALLOW_IPS=127.0.0.1,::1` (explicit; loopback is allowed by default regardless)
  - `VITE_GUARD_ALLOW_IP_RANGES=` (IPv4 CIDR ranges, e.g., `192.168.0.0/16`)
- Optional hard blocks (off by default except ServiceWorker)
  - `VITE_GUARD_BLOCK_WORKERS=0`
  - `VITE_GUARD_BLOCK_SERVICE_WORKER=1`
  - `VITE_GUARD_BLOCK_WEBRTC=0`
  - `VITE_GUARD_BLOCK_WEBTRANSPORT=0`

Content Security Policy (CSP)

- index.html ships a CSP to restrict passive subresources (img/link/CSS url()) and allow blob workers:

```
default-src 'self';
connect-src 'self' https: wss: http://127.0.0.1:* http://[::1]:*;
img-src 'self' https: data: blob:;
script-src 'self';
style-src 'self' 'unsafe-inline';
font-src 'self' https: data:;
frame-src 'self';
worker-src 'self' blob:';
```

Notes

- A tiny prelude module runs before the app bundle to install wrappers early; `fetch` is locked (non-configurable, non-writable) in non-test builds so third-party code cannot unhook it.
- OPS scripts here remain completely separate. They require explicit operator approval and flags, and are never called by the desktop app.

Safety gates for host firewall changes

- To run any script that alters the host firewall you must set BOTH environment variables in the invoking shell:
  - `UICP_ALLOW_HOST_FW=1`
  - `UICP_HOST_FW_I_UNDERSTAND=YES`
- Without both, scripts exit immediately without making changes.

Usage guidance (operators only)

- Run from CI or an operator shell with appropriate privileges.
- Review scripts before use and test in non-production environments first.
- Prefer Linux runners for strict enforcement; macOS host firewalls are best-effort.
- Do not package or distribute these with end-user builds; they are examples/reference for ops environments.
