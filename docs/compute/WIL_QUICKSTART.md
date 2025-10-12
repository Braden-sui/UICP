WIL Quickstart (Operators + Examples)

What is WIL?
- Words → Intent → LEXICON. The model uses allowed verbs/templates; we deterministically map to typed ops.

Actor Contract
- Output WIL only. One command per line. No commentary. Stop on first `nop:`.

Core templates (examples)
- window.create
  - create window title "Notes" width 1200 height 800
  - create window title "Notes" size 1200x800
  - create window title "Notes" at 80,120

- window.update
  - update window win-notes title "Notes v2"
  - update window win-notes width 800 height 600
  - move window win-notes to 120,80
  - resize window win-notes to 1200x800

- DOM
  - set html in "#root" of window win-notes to "<div>Ready</div>"
  - replace html in "#root" of window win-notes with "<div>Fresh</div>"
  - append html in "#list" of window win-notes with "<li>Item</li>"

- Components
  - render component panel in window win-notes at "#root"
  - mount panel in "#root"

- State
  - set state key user to {"name":"Ada"} in window
  - get state key user in window
  - watch state key user in window
  - unwatch state key user in window

- HTTP/API
  - open url https://example.com
  - visit https://example.com
  - go to https://example.com
  - api GET https://api.example.com/v1/status

Nop lines (stop batch)
- nop: missing <slot>
- nop: invalid <slot>
- nop: blocked <capability>
- nop: budget exhausted
- nop: batch capped
- nop: invalid WIL line

Caps
- Default: 50 lines (hard 200). Truncation appends `nop: batch capped`.

