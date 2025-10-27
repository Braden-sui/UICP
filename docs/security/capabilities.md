# Tauri Capabilities

Last updated: 2025-10-26

Purpose: document capability files under `uicp/src-tauri/capabilities/` and how they constrain frontend permissions.

Overview
- Schema: vendored as `schema.json` (draft-07) in the same directory.
- Files: `default.json`, `events.json`, `fs.json`, `fs-appdata-read.json`, `fs-appdata-write.json`.
- Each capability lists `permissions` (core fs/window/app/webview sets) and optional scoped entries.

Key capabilities
- `default.json`: enables core/window/app/webview defaults for the `main` window.
- `events.json`: allows frontend to subscribe to core events.
- `fs-appdata-read.json`: read-only AppData access (+ text read) for policy/config.
- `fs-appdata-write.json`: read/write AppData under `$APPDATA/uicp/**` using a scoped `fs:scope` permission; includes mkdir/exist/read/write.

Scope example
```
{
  "identifier": "fs-appdata-write",
  "windows": ["main"],
  "permissions": [
    "fs:allow-appdata-write",
    { "identifier": "fs:scope", "allow": [ { "path": "$APPDATA/uicp/**" } ] }
  ]
}
```

Notes
- Capabilities apply per-window label. Our UI runs in `main`.
- Use capabilities to keep filesystem access narrowly scoped to AppData. No Desktop access is granted.
