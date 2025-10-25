#!/usr/bin/env bash
# =============================================================
# OPS-ONLY SCRIPT — DO NOT RUN ON END-USER MACHINES
# This script loads pf anchor tables.
# It MUST NOT be invoked by the application runtime or regular users.
# To proceed, you must set BOTH env vars:
#   UICP_ALLOW_HOST_FW=1
#   UICP_HOST_FW_I_UNDERSTAND=YES
# Otherwise, this script will exit without making changes.
# =============================================================
if [[ "${UICP_ALLOW_HOST_FW:-}" != "1" || "${UICP_HOST_FW_I_UNDERSTAND:-}" != "YES" ]]; then
  echo "[uicp-fw] Refusing to modify host firewall. Set UICP_ALLOW_HOST_FW=1 and UICP_HOST_FW_I_UNDERSTAND=YES to proceed." >&2
  exit 3
fi
set -euo pipefail

# Refresh pf tables from files written by update-lists.mjs
ANCHOR="com.uicp.fw"
BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
TABLE_DIR="$BASE_DIR/tables"

sudo pfctl -a "$ANCHOR" -t allow_dns -T replace -f "$TABLE_DIR/allow_dns.txt" || true
sudo pfctl -a "$ANCHOR" -t allow_job -T replace -f "$TABLE_DIR/allow_job.txt" || true
sudo pfctl -a "$ANCHOR" -t block_doh -T replace -f "$TABLE_DIR/block_doh.txt" || true
sudo pfctl -a "$ANCHOR" -t block_meta_v4 -T replace -f "$TABLE_DIR/block_meta_v4.txt" || true
sudo pfctl -a "$ANCHOR" -t block_meta_v6 -T replace -f "$TABLE_DIR/block_meta_v6.txt" || true
sudo pfctl -a "$ANCHOR" -t block_priv_v4 -T replace -f "$TABLE_DIR/block_priv_v4.txt" || true
sudo pfctl -a "$ANCHOR" -t block_priv_v6 -T replace -f "$TABLE_DIR/block_priv_v6.txt" || true

echo "[uicp-fw] pf tables refreshed" >&2
