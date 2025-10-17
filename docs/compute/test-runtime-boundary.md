# Test/Runtime Code Boundary

This document describes the strict separation between test infrastructure and production runtime code in the Rust codebase.

## Boundary Invariant

**No test infrastructure code should be compiled into production release builds.**

Test helpers, harnesses, and development tooling must be:
1. Located in clearly marked directories/modules
2. Gated by `#[cfg(test)]` or `#[cfg(feature = "compute_harness")]`
3. Verified by CI to not appear in release binaries

## Code Organization

### Test Support Module

All test infrastructure lives in `src-tauri/src/test_support/`:

```
src-tauri/src/
  test_support/          # Test infrastructure (feature-gated)
    mod.rs               # Module root with #[cfg(...)] gate
    harness.rs           # ComputeTestHarness for integration tests
```

**Gate:** `#[cfg(any(test, feature = "compute_harness"))]`

### What Lives Where

| Location | Purpose | Compilation |
|----------|---------|-------------|
| `src/test_support/` | Test harness, fixtures, helpers | Test builds + `compute_harness` feature only |
| `tests/` | Integration tests | Test builds only |
| `#[cfg(test)] mod tests` | Unit tests inline with runtime code | Test builds only |
| `src/*.rs` (no cfg) | Production runtime | Always compiled |

### Feature Flags

- `compute_harness`: Enables test infrastructure for external harness binaries
- `tauri/test`: Tauri's test utilities (implied by `compute_harness`)
- `tempfile`: Test-only dependency (gated by `compute_harness`)

## Examples

### Correct: Feature-Gated Test Module

```rust
// src/test_support/mod.rs
#![cfg(any(test, feature = "compute_harness"))]

mod harness;
pub use harness::ComputeTestHarness;
```

### Correct: Unit Test in Runtime File

```rust
// src/compute.rs
pub fn runtime_function() { /* ... */ }

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_runtime_function() { /* ... */ }
}
```

### Incorrect: Test Helper in Runtime Code

```rust
// ❌ WRONG - test helper mixed with runtime code
pub fn production_fn() { /* ... */ }

pub fn test_helper_fn() { /* for tests only */ }  // NO! Missing cfg gate
```

### Correct: Test-Only Function with Gate

```rust
#[cfg_attr(not(test), allow(dead_code))]
pub fn verify_chain(/* ... */) { /* ... */ }
```

This allows the function to exist but marks it as unused in release builds, preventing compiler warnings while maintaining visibility for tests.

## CI Verification

The `rust-release-boundary` CI job (`ci.yml`) verifies the boundary:

1. Builds a release binary with no test features: `--release --no-default-features`
2. Extracts symbols with `nm`
3. Fails if test symbols are present: `test_support`, `ComputeTestHarness`, `compute_harness`
4. Reports binary size to detect bloat

**Invariant:** If test symbols leak into release, CI fails.

## Dependencies

Test-only dependencies are gated in `Cargo.toml`:

```toml
[dependencies]
tempfile = { version = "3.10", optional = true }

[dev-dependencies]
tempfile = "3.10"

[features]
compute_harness = ["dep:tempfile", "tauri/test"]
```

**Key:**
- `optional = true` + feature-gated: Not compiled unless feature enabled
- `[dev-dependencies]`: Only available during tests/benchmarks

## Usage

### Using Test Harness in Integration Tests

```rust
// tests/integration_compute/my_test.rs
use uicp::test_support::ComputeTestHarness;

#[tokio::test]
async fn test_compute_job() {
    let harness = ComputeTestHarness::new_async()
        .await
        .expect("harness");
    
    let result = harness.run_job(spec).await.expect("job");
    assert!(result.get("ok").unwrap().as_bool().unwrap());
}
```

### Using Test Harness in Bin

```rust
// src/bin/compute_harness.rs
#![cfg(feature = "compute_harness")]

use uicp::test_support::ComputeTestHarness;

#[tokio::main]
async fn main() {
    let harness = ComputeTestHarness::new()?;
    // ...
}
```

Requires: `cargo run --bin compute_harness --features compute_harness`

## Refactoring Checklist

When adding new test infrastructure:

- [ ] Place in `src/test_support/` or `tests/`
- [ ] Add `#[cfg(any(test, feature = "compute_harness"))]` gate
- [ ] Update `Cargo.toml` if new dependencies needed
- [ ] Verify CI passes (`rust-release-boundary` job)
- [ ] Document any new modules here

When modifying existing test code:

- [ ] Ensure gates are preserved
- [ ] Verify imports use `test_support::` path
- [ ] Check CI still passes

## Troubleshooting

### CI Fails: "Test symbols found in release binary"

**Cause:** Code in `src/` is missing `#[cfg(...)]` gate.

**Fix:**
1. Move code to `src/test_support/`
2. OR add `#[cfg(any(test, feature = "compute_harness"))]` gate
3. Verify locally: `cargo build --release --no-default-features`

### Integration Tests Can't Find Harness

**Cause:** Module path changed or gate incorrect.

**Fix:**
1. Import: `use uicp::test_support::ComputeTestHarness;`
2. Ensure `Cargo.toml` dev-dependencies include `tempfile`

### Binary Won't Build with Harness Feature

**Cause:** Missing feature flag in run command.

**Fix:** Add `--features compute_harness`:
```bash
cargo run --bin compute_harness --features compute_harness
```

## Severity

**High Risk:** Test code in production increases:
- Binary size (bloat)
- Attack surface (unused code paths)
- Maintenance burden (dead code analysis fails)

**Enforcement:** CI fails if boundary violated.
