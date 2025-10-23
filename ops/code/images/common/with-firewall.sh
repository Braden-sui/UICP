#!/usr/bin/env bash
set -euo pipefail

# WHY: Default-deny egress inside container; allow only allowlisted hosts on 80/443.
# INVARIANT: If iptables is unavailable/capabilities missing, log and continue (httpjail still enforces host/methods).

ALLOWLIST_JSON=${ALLOWLIST_JSON:-/workspace/ops/code/network/allowlist.json}
PROVIDER_KEY=${PROVIDER_KEY:-}

log() { echo "[with-firewall] $*" >&2; }

apply_firewall() {
  if [ "${DISABLE_FIREWALL:-}" = "1" ]; then
    log "DISABLE_FIREWALL=1; skipping firewall"
    return 0
  fi

  # Dependencies: iptables required; jq/getent/awk optional (fail-soft)
  if ! command -v iptables >/dev/null 2>&1; then
    log "iptables missing; skipping firewall"
    return 0
  fi
  if ! command -v awk >/dev/null 2>&1; then
    log "awk missing; DNS resolver parsing may be incomplete"
  fi
  if ! command -v getent >/dev/null 2>&1; then
    log "getent missing; hostname resolution for allowlist will be skipped"
  fi
  if ! command -v jq >/dev/null 2>&1; then
    log "jq missing; allowlist parsing disabled (base allows only)"
  fi

  # Permission guard with lock wait
  if ! iptables -w 5 -S OUTPUT >/dev/null 2>&1; then
    log "no iptables permission; skipping all firewall setup"
    return 0
  fi
  has_ip6=0
  if command -v ip6tables >/dev/null 2>&1 && ip6tables -w 5 -S OUTPUT >/dev/null 2>&1; then
    has_ip6=1
  fi
  if command -v nft >/dev/null 2>&1; then
    log "nftables detected; using iptables CLI (likely nft backend)"
  fi
  # Parse resolvers from resolv.conf (IPv4/IPv6)
  RESOLV4=""
  RESOLV6=""
  if [ -r /etc/resolv.conf ]; then
    while read -r _ ip rest; do
      case "${ip:-}" in
        *:*) RESOLV6="$RESOLV6 $ip" ;;
        *.*) RESOLV4="$RESOLV4 $ip" ;;
      esac
    done < <(awk '/^nameserver /{print $0}' /etc/resolv.conf)
  fi
  # Common container stub resolvers if none detected
  if [ -z "$RESOLV4" ]; then RESOLV4="127.0.0.11 127.0.0.53"; fi

  CHAIN="FWJAIL"
  has_ipset=0
  if command -v ipset >/dev/null 2>&1; then has_ipset=1; fi
  # Create dedicated chain and hook once; then flush our chain idempotently
  for cmd in iptables ${has_ip6:+ip6tables}; do
    $cmd -w 5 -N "$CHAIN" 2>/dev/null || true
    $cmd -w 5 -C OUTPUT -j "$CHAIN" >/dev/null 2>&1 || $cmd -w 5 -I OUTPUT -j "$CHAIN"
    $cmd -w 5 -F "$CHAIN"
    # Optional ipset fast-path: destination sets for allowed egress
    if [ "$has_ipset" = "1" ]; then
      if [ "$cmd" = "iptables" ]; then
        ipset create fwjail_v4 hash:ip family inet -exist
        # Accept traffic to members of the set on 443/80
        $cmd -w 5 -C "$CHAIN" -m set --match-set fwjail_v4 dst -p tcp --dport 443 -j ACCEPT >/dev/null 2>&1 || \
          $cmd -w 5 -A "$CHAIN" -m set --match-set fwjail_v4 dst -p tcp --dport 443 -j ACCEPT
        $cmd -w 5 -C "$CHAIN" -m set --match-set fwjail_v4 dst -p tcp --dport 80 -j ACCEPT >/dev/null 2>&1 || \
          $cmd -w 5 -A "$CHAIN" -m set --match-set fwjail_v4 dst -p tcp --dport 80 -j ACCEPT
      else
        ipset create fwjail_v6 hash:ip family inet6 -exist
        $cmd -w 5 -C "$CHAIN" -m set --match-set fwjail_v6 dst -p tcp --dport 443 -j ACCEPT >/dev/null 2>&1 || \
          $cmd -w 5 -A "$CHAIN" -m set --match-set fwjail_v6 dst -p tcp --dport 443 -j ACCEPT
        $cmd -w 5 -C "$CHAIN" -m set --match-set fwjail_v6 dst -p tcp --dport 80 -j ACCEPT >/dev/null 2>&1 || \
          $cmd -w 5 -A "$CHAIN" -m set --match-set fwjail_v6 dst -p tcp --dport 80 -j ACCEPT
      fi
    fi
    # Base allows
    $cmd -w 5 -C "$CHAIN" -o lo -j ACCEPT >/dev/null 2>&1 || \
      $cmd -w 5 -A "$CHAIN" -o lo -j ACCEPT
    $cmd -w 5 -C "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT >/dev/null 2>&1 || \
      $cmd -w 5 -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    # Block cloud metadata endpoints by default
    if [ "$cmd" = "iptables" ]; then
      $cmd -w 5 -C "$CHAIN" -d 169.254.169.254/32 -j DROP >/dev/null 2>&1 || $cmd -w 5 -A "$CHAIN" -d 169.254.169.254/32 -j DROP
      $cmd -w 5 -C "$CHAIN" -d 169.254.170.2/32 -j DROP >/dev/null 2>&1 || $cmd -w 5 -A "$CHAIN" -d 169.254.170.2/32 -j DROP
    else
      $cmd -w 5 -C "$CHAIN" -d fe80::/10 -j DROP >/dev/null 2>&1 || $cmd -w 5 -A "$CHAIN" -d fe80::/10 -j DROP
    fi
    # DNS (UDP/TCP 53) constrained to resolvers only
    if [ "$cmd" = "iptables" ]; then
      for r in $RESOLV4; do
        $cmd -w 5 -C "$CHAIN" -d "$r" -p udp --dport 53 -j ACCEPT >/dev/null 2>&1 || \
          $cmd -w 5 -A "$CHAIN" -d "$r" -p udp --dport 53 -j ACCEPT
        $cmd -w 5 -C "$CHAIN" -d "$r" -p tcp --dport 53 -j ACCEPT >/dev/null 2>&1 || \
          $cmd -w 5 -A "$CHAIN" -d "$r" -p tcp --dport 53 -j ACCEPT
      done
    else
      for r in $RESOLV6; do
        $cmd -w 5 -C "$CHAIN" -d "$r" -p udp --dport 53 -j ACCEPT >/dev/null 2>&1 || \
          $cmd -w 5 -A "$CHAIN" -d "$r" -p udp --dport 53 -j ACCEPT
        $cmd -w 5 -C "$CHAIN" -d "$r" -p tcp --dport 53 -j ACCEPT >/dev/null 2>&1 || \
          $cmd -w 5 -A "$CHAIN" -d "$r" -p tcp --dport 53 -j ACCEPT
      done
    fi
  done

  # Provider policy
  if [ -z "$PROVIDER_KEY" ] || [ ! -f "$ALLOWLIST_JSON" ]; then
    log "no provider or allowlist file; using base allows (DNS/loopback/established)"
  else
    if ! hosts=$(jq -r --arg k "$PROVIDER_KEY" '.providers[$k].hosts[]?' "$ALLOWLIST_JSON"); then
      log "ERROR: allowlist.json parse failed; proceeding with base allows only"
      hosts=""
    fi
    if [ -z "$hosts" ]; then
      log "no hosts for provider=$PROVIDER_KEY"
    else
      for h in $hosts; do
        ips=$(getent ahosts "$h" | awk '{print $1}' | sort -u || true)
        for ip in $ips; do
          if [[ "$ip" == *:* ]]; then
            cmd=ip6tables; setname=fwjail_v6
          else
            cmd=iptables; setname=fwjail_v4
          fi
          if [ "$has_ipset" = "1" ]; then
            # Add to ipset; rule already present to accept members
            ipset add "$setname" "$ip" -exist 2>/dev/null || true
            log "allow (set) host=$h ip=$ip ports 443,80"
          else
            if ! command -v "$cmd" >/dev/null 2>&1; then continue; fi
            if ! $cmd -w 5 -S OUTPUT >/dev/null 2>&1; then continue; fi
            log "allow host=$h ip=$ip ports 443,80"
            $cmd -w 5 -C "$CHAIN" -d "$ip" -p tcp --dport 443 -j ACCEPT >/dev/null 2>&1 || \
              $cmd -w 5 -A "$CHAIN" -d "$ip" -p tcp --dport 443 -j ACCEPT
            $cmd -w 5 -C "$CHAIN" -d "$ip" -p tcp --dport 80 -j ACCEPT >/dev/null 2>&1 || \
              $cmd -w 5 -A "$CHAIN" -d "$ip" -p tcp --dport 80 -j ACCEPT
          fi
        done
      done
    fi
  fi

  # Final LOG (rate-limited) then DROP in our chain
  for cmd in iptables ${has_ip6:+ip6tables}; do
    $cmd -w 5 -C "$CHAIN" -m limit --limit 5/min -j LOG --log-prefix "[fwjail DROP] " --log-ip-options >/dev/null 2>&1 || \
      $cmd -w 5 -A "$CHAIN" -m limit --limit 5/min -j LOG --log-prefix "[fwjail DROP] " --log-ip-options
    $cmd -w 5 -C "$CHAIN" -j DROP >/dev/null 2>&1 || $cmd -w 5 -A "$CHAIN" -j DROP
  done

  # Safety rollback: if interactive and not finalized, auto-flush in 10s
  if [ -t 1 ] && [ -z "${FIREWALL_FINALIZE:-}" ]; then
    (
      sleep 10
      for cmd in iptables ${has_ip6:+ip6tables}; do
        if command -v "$cmd" >/dev/null 2>&1; then
          $cmd -w 5 -F "$CHAIN" 2>/dev/null || true
          $cmd -w 5 -D OUTPUT -j "$CHAIN" 2>/dev/null || true
        fi
      done
    ) &
    log "scheduled firewall rollback in 10s (set FIREWALL_FINALIZE=1 to disable)"
  fi
}

apply_firewall || true

exec "$@"


