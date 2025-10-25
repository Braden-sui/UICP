#!/usr/bin/env bash
# =============================================================
# OPS-ONLY SCRIPT — DO NOT RUN ON END-USER MACHINES
# This script installs launchd jobs that affect pf (host firewall) state.
# It MUST NOT be invoked by the application runtime or regular users.
# To proceed, you must set BOTH env vars:
#   UICP_ALLOW_HOST_FW=1
#   UICP_HOST_FW_I_UNDERSTAND=YES
# Otherwise, this script will exit without making changes.
# =============================================================
set -euo pipefail

if [[ "${UICP_ALLOW_HOST_FW:-}" != "1" || "${UICP_HOST_FW_I_UNDERSTAND:-}" != "YES" ]]; then
  echo "[uicp-fw] Refusing to install launchd firewall jobs. Set UICP_ALLOW_HOST_FW=1 and UICP_HOST_FW_I_UNDERSTAND=YES to proceed." >&2
  exit 3
fi

# Install launchd jobs to load pf anchor at boot and refresh tables hourly
ANCHOR_ID="com.uicp.fw"
ANCHOR_DEST="/etc/pf.anchors/${ANCHOR_ID}"
LAUNCHD_DIR="/Library/LaunchDaemons"
BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
ANCHOR_SRC="$BASE_DIR/anchor.conf"
REFRESH_SH="$BASE_DIR/refresh-tables.sh"

# Copy anchor to system anchors
sudo install -m 0644 "$ANCHOR_SRC" "$ANCHOR_DEST"

# Generate load plist with absolute command
LOAD_PLIST_PATH="$LAUNCHD_DIR/${ANCHOR_ID}.load.plist"
cat <<PLIST | sudo tee "$LOAD_PLIST_PATH" >/dev/null
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${ANCHOR_ID}.load</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>pfctl -E; pfctl -a ${ANCHOR_ID} -f ${ANCHOR_DEST}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
PLIST

# Generate refresh plist pointing to repo refresh script (expects tables in repo)
REFRESH_PLIST_PATH="$LAUNCHD_DIR/${ANCHOR_ID}.refresh.plist"
cat <<PLIST | sudo tee "$REFRESH_PLIST_PATH" >/dev/null
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${ANCHOR_ID}.refresh</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${REFRESH_SH}</string>
  </array>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
PLIST

# Fix permissions and load
sudo chown root:wheel "$LOAD_PLIST_PATH" "$REFRESH_PLIST_PATH"
sudo chmod 0644 "$LOAD_PLIST_PATH" "$REFRESH_PLIST_PATH"

sudo launchctl unload "$LOAD_PLIST_PATH" 2>/dev/null || true
sudo launchctl unload "$REFRESH_PLIST_PATH" 2>/dev/null || true
sudo launchctl load -w "$LOAD_PLIST_PATH"
sudo launchctl load -w "$REFRESH_PLIST_PATH"

echo "[uicp-fw] launchd jobs installed: ${LOAD_PLIST_PATH}, ${REFRESH_PLIST_PATH}" >&2
