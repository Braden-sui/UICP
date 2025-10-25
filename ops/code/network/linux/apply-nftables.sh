#!/usr/bin/env bash
# =============================================================
# OPS-ONLY SCRIPT — DO NOT RUN ON END-USER MACHINES
# This script modifies host firewall (nftables).
# It MUST NOT be invoked by the application runtime or regular users.
# To proceed, you must set BOTH env vars:
#   UICP_ALLOW_HOST_FW=1
#   UICP_HOST_FW_I_UNDERSTAND=YES
# Otherwise, this script will exit without making changes.
# =============================================================
set -euo pipefail

if [[ "${UICP_ALLOW_HOST_FW:-}" != "1" || "${UICP_HOST_FW_I_UNDERSTAND:-}" != "YES" ]]; then
  echo "[uicp-fw] Refusing to modify host firewall. Set UICP_ALLOW_HOST_FW=1 and UICP_HOST_FW_I_UNDERSTAND=YES to proceed." >&2
  exit 3
fi

# UICP host nftables policy (Linux)
# - Separates UI vs Job tiers via Unix groups uicp_ui and uicp_job (meta skgid)
# - Keeps containers covered by existing ops/code/images/common/with-firewall.sh
# - Global guards: ESTABLISHED/RELATED, loopback, DNS only to resolvers, block DoT/DoH IPs,
#                  block cloud metadata, drop noisy exfil ports, drop multicast/broadcast egress
# - Jobs: default deny to Internet; only allow seeded hosts on 80/443; QUIC (UDP 443) blocked
# - UI: allow general web on TCP 80/443 and UDP 443 (HTTP/3)
# - Safety: 10s rollback unless FIREWALL_FINALIZE=1

TABLE="uicp"

# Resolve group IDs for uicp_ui and uicp_job
get_gid() {
  local name="$1"
  local gid
  gid=$(getent group "$name" | awk -F: '{print $3}' || true)
  if [[ -z "${gid:-}" ]]; then
    echo "[uicp-fw] ERROR: Unix group '$name' not found. Create it before applying (groupadd $name)." >&2
    exit 1
  fi
  echo "$gid"
}

UI_GID=$(get_gid "uicp_ui")
JOB_GID=$(get_gid "uicp_job")

# Apply nftables table and chains
nft -f - <<EOF
flush table inet ${TABLE}

add table inet ${TABLE}

# Address sets populated by updater (update-lists.mjs)
add set inet ${TABLE} allow_dns_v4 { type ipv4_addr; flags interval; }
add set inet ${TABLE} allow_dns_v6 { type ipv6_addr; flags interval; }
add set inet ${TABLE} allow_job_hosts_v4 { type ipv4_addr; flags interval; }
add set inet ${TABLE} allow_job_hosts_v6 { type ipv6_addr; flags interval; }
add set inet ${TABLE} block_doh_v4 { type ipv4_addr; flags interval; }
add set inet ${TABLE} block_doh_v6 { type ipv6_addr; flags interval; }
add set inet ${TABLE} block_priv_v4 { type ipv4_addr; flags interval; }
add set inet ${TABLE} block_priv_v6 { type ipv6_addr; flags interval; }
add set inet ${TABLE} block_meta_v4 { type ipv4_addr; flags interval; }
add set inet ${TABLE} block_meta_v6 { type ipv6_addr; flags interval; }

# Seed private/meta sets (IPv6 metadata may be added by updater)
add element inet ${TABLE} block_priv_v4 { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 169.254.0.0/16 }
add element inet ${TABLE} block_priv_v6 { fc00::/7, fe80::/10 }
add element inet ${TABLE} block_meta_v4 { 169.254.169.254/32, 169.254.170.2/32 }

# Host OUTPUT policy (covers host processes and host-network containers)
add chain inet ${TABLE} output { type filter hook output priority 0; policy accept; }

# Base allows
add rule inet ${TABLE} output oifname "lo" accept
add rule inet ${TABLE} output ct state established,related accept

# DNS only to resolvers
add rule inet ${TABLE} output udp dport 53 ip daddr @allow_dns_v4 accept
add rule inet ${TABLE} output tcp dport 53 ip daddr @allow_dns_v4 accept
add rule inet ${TABLE} output udp dport 53 ip6 daddr @allow_dns_v6 accept
add rule inet ${TABLE} output tcp dport 53 ip6 daddr @allow_dns_v6 accept

# Block DoT/DoQ and DoH edges
add rule inet ${TABLE} output tcp dport 853 drop
add rule inet ${TABLE} output udp dport 853 drop
add rule inet ${TABLE} output tcp dport 443 ip daddr @block_doh_v4 drop
add rule inet ${TABLE} output tcp dport 443 ip6 daddr @block_doh_v6 drop

# Block cloud metadata everywhere
add rule inet ${TABLE} output ip daddr @block_meta_v4 drop
add rule inet ${TABLE} output ip6 daddr @block_meta_v6 drop

# Drop noisy exfil ports globally
add rule inet ${TABLE} output tcp dport { 21, 23, 135, 137-139, 445, 3389, 5985, 5986 } drop
add rule inet ${TABLE} output udp dport { 69, 137-138, 161-162, 514 } drop

# Drop multicast/broadcast egress unless explicitly enabled
add rule inet ${TABLE} output ip daddr { 224.0.0.0/4, 255.255.255.255/32 } drop
add rule inet ${TABLE} output ip6 daddr ff00::/8 drop

# UI tier: allow general web on 80/443 and QUIC on 443
add rule inet ${TABLE} output meta skgid ${UI_GID} tcp dport { 80, 443 } accept
add rule inet ${TABLE} output meta skgid ${UI_GID} udp dport 443 accept

# Job tier: stricter defaults
# - Block private/link-local egress
add rule inet ${TABLE} output meta skgid ${JOB_GID} ip daddr @block_priv_v4 drop
add rule inet ${TABLE} output meta skgid ${JOB_GID} ip6 daddr @block_priv_v6 drop
# - Block QUIC by default for jobs (can be changed by updater if required)
add rule inet ${TABLE} output meta skgid ${JOB_GID} udp dport 443 drop
# - Allow only seeded job hosts on 80/443
add rule inet ${TABLE} output meta skgid ${JOB_GID} tcp dport { 80, 443 } ip daddr @allow_job_hosts_v4 accept
add rule inet ${TABLE} output meta skgid ${JOB_GID} tcp dport { 80, 443 } ip6 daddr @allow_job_hosts_v6 accept
# - Default drop for other job egress
add rule inet ${TABLE} output meta skgid ${JOB_GID} counter drop

# FORWARD policy: apply baseline blocks to bridged containers
add chain inet ${TABLE} forward { type filter hook forward priority 0; policy accept; }
add rule inet ${TABLE} forward iifname "docker*" ip daddr @block_meta_v4 drop
add rule inet ${TABLE} forward iifname "docker*" ip daddr @block_priv_v4 drop
add rule inet ${TABLE} forward iifname "docker*" ip6 daddr @block_meta_v6 drop
add rule inet ${TABLE} forward iifname "docker*" ip6 daddr @block_priv_v6 drop
add rule inet ${TABLE} forward iifname "docker*" tcp dport 853 drop
add rule inet ${TABLE} forward iifname "docker*" udp dport 853 drop
add rule inet ${TABLE} forward iifname "docker*" tcp dport 443 ip daddr @block_doh_v4 drop
add rule inet ${TABLE} forward iifname "docker*" tcp dport 443 ip6 daddr @block_doh_v6 drop
EOF

echo "[uicp-fw] nftables table '${TABLE}' applied"

# Optional: load current sets if present
SETS_FILE="$(dirname "$0")/nft-sets.nft"
if [[ -f "$SETS_FILE" ]]; then
  nft -f "$SETS_FILE" || echo "[uicp-fw] WARN: failed to load $SETS_FILE" >&2
fi

# Safety rollback unless finalized
if [[ "${FIREWALL_FINALIZE:-}" != "1" ]]; then
  (
    sleep 10
    if nft list table inet ${TABLE} >/dev/null 2>&1; then
      nft flush table inet ${TABLE} || true
      nft delete table inet ${TABLE} || true
      echo "[uicp-fw] rollback applied (table ${TABLE} removed)" >&2
    fi
  ) &
  echo "[uicp-fw] rollback scheduled in 10s (export FIREWALL_FINALIZE=1 to keep rules)" >&2
fi
