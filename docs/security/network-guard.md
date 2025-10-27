# Network Guard (In-App Egress Policy)

Last updated: 2025-10-26

Purpose: explain the in-app egress guard that wraps `fetch`, XHR, WebSocket, EventSource, beacon, Workers, WebRTC and WebTransport. Covers defaults, environment toggles, and URLHaus integration.

## Overview
- Implementation: `uicp/src/lib/security/networkGuard.ts`
- Installed at app start and reinstalled on policy changes.
- Default-deny for sensitive endpoints; safe defaults for localhost.
- Emits structured block events via `window.dispatchEvent(new CustomEvent('net-guard-block', { detail }))`.

## Key Features
- Domain/IP allowlists and blocklists (domains, IP literals, CIDR ranges).
- Optional HTTPS-only enforcement.
- Payload caps (request/response byte limits) for `fetch`, XHR, beacon.
- URLHaus integration for host/url verdicts with in-memory + persisted cache.
- Monitor-only mode (observe but do not block) for diagnostics.

Defaults (policy flags)
- blockWorkers: true; blockServiceWorker: true; blockWebRTC: true; blockWebTransport: false (unless policy overrides)

## Environment and Config (Vite/Frontend)
- `VITE_NET_GUARD_ENABLED` (default 1): `1|true` to enable.
- `VITE_NET_GUARD_MONITOR` (default 0): `1|true` to observe only.
- `VITE_NET_GUARD_VERBOSE` (default 0): `1|true` to log decisions to console.
- `VITE_ALLOW_DOMAINS` / `VITE_BLOCK_DOMAINS`: comma-separated hostnames.
- `VITE_ALLOW_IPS` / `VITE_BLOCK_IPS`: comma-separated IPs (supports IPv6 forms `[::1]`).
- `VITE_ALLOW_PATHS`: optional prefix allowlist, e.g. `/api/`.
- `VITE_MAX_REDIRECTS`: default 5.
- `VITE_MAX_REQUEST_BYTES` / `VITE_MAX_RESPONSE_BYTES`: soft caps.
- `VITE_ATTEMPT_SAMPLE`: integer sampling factor for attempt events (1 = always).

## URLHaus Integration
- Enablement: `VITE_URLHAUS_ENABLED` (default auto: enabled when `VITE_URLHAUS_AUTH_KEY` present).
- Mode: `VITE_URLHAUS_MODE` = `host` (default) or `url`.
- API base: `VITE_URLHAUS_API_BASE` (default `https://urlhaus-api.abuse.ch/v1`).
- Timeout: `VITE_URLHAUS_TIMEOUT_MS` (default 1500).
- Cache TTL (seconds): `VITE_URLHAUS_CACHE_TTL_SEC` (default 600).
- Respect allows: `VITE_URLHAUS_RESPECT_ALLOWS` (default 1) skips verdicts for explicitly allowed hosts.
- Persistence: `VITE_URLHAUS_PERSIST` (default 1), `VITE_URLHAUS_PERSIST_KEY`, `VITE_URLHAUS_PERSIST_TTL_SEC`, `VITE_URLHAUS_PERSIST_MAX`.

## Compute/Policy Interaction
- Network policy is independent of compute policy. Operators control host firewall outside of the app; see repo root notes under `ops/code/network/` (ops-only).

## Testing
- Unit tests: `uicp/tests/unit/network.guard.test.ts` cover DoH domains, allowlists, URLHaus, and monitor-only behavior.

## Notes
- In tests, defaults force Workers/ServiceWorker/WebRTC blocked unless toggled by policy.
- WebSocket wrapper also blocks when a prior fetch verdict cached a host as malicious.
