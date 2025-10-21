#!/usr/bin/env bash
set -euo pipefail

# WHY: Default-deny egress inside container; allow only allowlisted hosts on 80/443.
# INVARIANT: If iptables is unavailable/capabilities missing, log and continue (httpjail still enforces host/methods).

ALLOWLIST_JSON=${ALLOWLIST_JSON:-/workspace/ops/code/network/allowlist.json}
PROVIDER_KEY=${PROVIDER_KEY:-}

log() { echo "[with-firewall] $*" >&2; }

apply_firewall() {
  if ! command -v iptables >/dev/null 2>&1; then log "iptables not found; skipping firewall"; return 0; fi
  # Default deny outbound; allow loopback + established
  set +e
  iptables -P OUTPUT DROP 2>/dev/null || true
  iptables -F OUTPUT 2>/dev/null || true
  iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true
  iptables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true
  set -e

  if [ -z "$PROVIDER_KEY" ] || [ ! -f "$ALLOWLIST_JSON" ]; then
    log "no provider or allowlist file; leaving default deny except loopback"
    return 0
  fi

  if ! command -v jq >/dev/null 2>&1; then log "jq missing; cannot parse allowlist.json"; return 0; fi
  hosts=$(jq -r --arg k "$PROVIDER_KEY" '.providers[$k].hosts[]?' "$ALLOWLIST_JSON" 2>/dev/null || true)
  if [ -z "$hosts" ]; then log "no hosts for provider=$PROVIDER_KEY"; return 0; fi

  for h in $hosts; do
    # Resolve to IPs; tolerate failures
    ips=$(getent ahosts "$h" | awk '{print $1}' | sort -u)
    for ip in $ips; do
      log "allow host=$h ip=$ip ports 443,80"
      iptables -A OUTPUT -d "$ip" -p tcp --dport 443 -j ACCEPT 2>/dev/null || true
      iptables -A OUTPUT -d "$ip" -p tcp --dport 80 -j ACCEPT 2>/dev/null || true
    done
  done
}

apply_firewall || true

exec "$@"

