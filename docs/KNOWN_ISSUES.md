# Known Issues

Last updated: 2025-10-21

- QuickJS module size (first-run latency)
  - The `applet.quickjs@0.1.0.wasm` component is large. The first time it loads, the desktop may pause while the module is verified and JIT-compiled. Subsequent runs are warm and fast.
  - Workarounds
    - Pre-warm: open any Script Panel or click Verify Modules in Agent Settings.
    - Keep the app open between codegen runs to avoid cold starts.

- CLAUDE/CODEX login flows vary by OS
  - Codex uses the `codex` CLI when present, or `OPENAI_API_KEY` if set. On some OSes the CLI may launch a browser or native prompt.
  - Claude uses the `claude` CLI. Without an API key it relies on OS keychain-backed login; prompts differ by platform.
  - Workarounds
    - Use Agent Settings → Connect and Check buttons to drive headless-friendly flows where possible.
    - Set `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` to bypass interactive logins.

- Containerization disabled by default on macOS
  - Local runs default to host execution without a container; `httpjail` is used when available to restrict HTTP methods/hosts, but enforcement varies on macOS.
  - Workarounds
    - Prefer Linux for CI/agents and strict policy.
    - When using the ops CLI, pass `--container` to run providers inside a hardened container with default-deny egress.

