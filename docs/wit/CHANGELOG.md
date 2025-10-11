# WIT ABI Changelog

## 2025-10-10 - Version 1.0.0 baseline

- `uicp:task` package exports the `world command` with `csv` and `table` task interfaces.
- Result shape: both `csv.run` and `table.run` return `result<rows, string>`; error strings surface verbatim to the host.
- Host packages `uicp:host@1.0.0` and `uicp:host_determinism@1.0.0` provide control, rng, logger, and clock imports with deterministic semantics.
- Cancellation contract: guests must poll `control.should_cancel(job)` and respect `deadline_ms`/`remaining_ms` bounds.
- Partial output contract: guests acquire an output stream through `control.open_partial_sink(job)` for CBOR frames; misuse results in `Compute.CapabilityDenied`.
- **Identifier hygiene:** component and interface identifiers use kebab-case (lowercase words separated by single hyphens) to satisfy the v0.240+ WIT grammar. Future changes must avoid dash-separated labels in packages, types, functions, and fields.

> Bump the package version(s) above and record the delta before shipping any interface change. Downstream bindings (`npm run gen:io`) must be regenerated in the same change.

