# WIT ABI Changelog

## 2025-10-10 - Version 1.0.0 baseline

- `uicp:task` package exports the `world command` with `csv` and `table` task interfaces.
- Result shape: both `csv.run` and `table.run` return `result<rows, string>`; error strings surface verbatim to the host.
- Host packages `uicp:host@1.0.0` and `uicp:host-determinism@1.0.0` provide control, rng, logger, and clock imports with deterministic semantics.
- Cancellation contract: guests must poll `control.should-cancel(job)` and respect `deadline-ms`/`remaining-ms` bounds.
- Partial output contract: guests acquire an output stream through `control.open-partial-sink(job)` for CBOR frames; misuse results in `Compute.CapabilityDenied`.

> Bump the package version(s) above and record the delta before shipping any interface change. Downstream bindings (`npm run gen:io`) must be regenerated in the same change.
