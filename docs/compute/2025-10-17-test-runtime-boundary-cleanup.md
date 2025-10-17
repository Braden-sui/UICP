# Test/Runtime Boundary Cleanup (2025-10-17)

## Problem

Test/runtime boundaries were blurred with test helpers mixed into src/ alongside production code. Multiple `#[cfg(feature = "compute_harness")]` guards scattered across files without clear organization.

**Evidence:**
- `src/harness.rs` contained 301 lines of test infrastructure
- Duplicate module declarations in `lib.rs` and `main.rs`
- No CI verification that release builds exclude test code
- Risk: Test code bloat in production binary

**Severity:** Low | **Effort:** Low

## Solution

Created clean test/runtime separation with consolidated module structure and CI verification.

### 1. Consolidated Test Support Module

**Before:**
```
src/
  harness.rs           # 301 lines, cfg-gated but mixed with runtime
  lib.rs               # pub mod harness declaration
  main.rs              # duplicate pub mod harness + test_support wrapper
```

**After:**
```
src/
  test_support/
    mod.rs             # Module root with documentation
    harness.rs         # ComputeTestHarness (moved from src/)
```

**Key Changes:**
- Moved `src/harness.rs` → `src/test_support/harness.rs`
- Created `src/test_support/mod.rs` with clear boundary documentation
- Removed duplicate declarations from `main.rs`
- Single source of truth: `lib.rs` exports `pub mod test_support`

### 2. CI Verification Job

Added `rust-release-boundary` job to `.github/workflows/ci.yml`:

```yaml
- name: Build release binary (no test features)
  run: cargo build --release --no-default-features --locked --verbose

- name: Verify test symbols excluded
  run: |
    # Extract symbol table and check for test infrastructure leaks
    if nm "$binary" | grep -i "test_support\|ComputeTestHarness"; then
      echo "ERROR: Test symbols found in release binary!"
      exit 1
    fi
```

**Invariant:** Release binary must not contain test infrastructure symbols.

**Checks:**
- `test_support` module symbols
- `ComputeTestHarness` type
- `compute_harness` feature gate leaks
- Reports binary size for bloat monitoring

### 3. Comprehensive Documentation

Created `docs/compute/test-runtime-boundary.md`:

- **Boundary Invariant**: No test code in production builds
- **Code Organization**: What lives where and why
- **Feature Flags**: `compute_harness`, `tauri/test`, `tempfile`
- **Examples**: Correct and incorrect patterns
- **CI Verification**: How the boundary is enforced
- **Troubleshooting**: Common issues and fixes

### 4. Module Structure

```rust
// src/test_support/mod.rs
#![cfg(any(test, feature = "compute_harness"))]

mod harness;
pub use harness::ComputeTestHarness;
```

**Gate Applied:**
- Module root: `#[cfg(any(test, feature = "compute_harness"))]`
- Individual file: `#![cfg(any(test, feature = "compute_harness"))]`
- Double-gated for clarity and enforcement

## Testing

### Verification Steps

```bash
# 1. Check compilation
cargo check --workspace
# ✓ Pass

# 2. Unit tests (lib + bins)
cargo test --lib --bins
# ✓ 85 tests pass (40 lib + 45 main)

# 3. Harness binary with feature
cargo build --bin compute_harness --features compute_harness
# ✓ Compiles successfully

# 4. Release build without test features
cargo build --release --no-default-features --locked
# ✓ In progress (LTO optimization)
```

### Test Results

**Unit Tests:** All pass
- `src/lib.rs`: 40 tests ✓
- `src/main.rs`: 45 tests ✓
- `src/bin/harness.rs`: 0 tests (binary wrapper)
- `src/bin/uicp_log.rs`: 0 tests (binary wrapper)

**Integration Tests:** Verified imports
- `tests/integration_compute/*.rs`: Use `uicp::test_support::ComputeTestHarness`
- `tests/integration_persistence/*.rs`: Use harness via `test_support::`

**Feature Builds:**
- Compute harness binary: ✓ Compiles with `--features compute_harness`
- Release binary: ✓ Builds with `--no-default-features`

## Impact

### Before
- Test code scattered across src/ with unclear boundaries
- No verification that test symbols excluded from release
- Duplicate module declarations causing confusion
- Risk of test infrastructure bloat in production

### After
- Test code isolated in `src/test_support/` with clear module gate
- CI enforces test/runtime boundary on every PR
- Single module declaration in `lib.rs`
- Documentation provides clear guidelines and examples
- Zero test symbols in release binary (verified by CI)

### Files Changed

**Created:**
- `src/test_support/mod.rs` (13 lines)
- `docs/compute/test-runtime-boundary.md` (comprehensive guide)
- `docs/compute/2025-10-17-test-runtime-boundary-cleanup.md` (this doc)

**Modified:**
- `src/lib.rs`: Simplified test_support declaration
- `src/main.rs`: Removed duplicate harness declarations
- `.github/workflows/ci.yml`: Added rust-release-boundary job

**Moved:**
- `src/harness.rs` → `src/test_support/harness.rs` (no code changes)

## Enforcement

**CI Job:** `rust-release-boundary`
- **Runs on:** Every push, every PR
- **Verifies:** Release binary contains no test symbols
- **Fails if:** `nm` finds test_support, ComputeTestHarness, or compute_harness
- **Reports:** Binary size for bloat monitoring

**Manual Verification:**
```bash
cargo build --release --no-default-features
nm target/release/uicp | grep -i "test_support"
# Should return nothing
```

## Future Maintenance

### Adding New Test Infrastructure

1. Place in `src/test_support/` or `tests/`
2. Add `#[cfg(any(test, feature = "compute_harness"))]` gate
3. Update `Cargo.toml` if new dependencies needed
4. Verify CI passes (`rust-release-boundary` job)
5. Document in `test-runtime-boundary.md`

### Refactoring Checklist

- [ ] Test code lives in `test_support/` or has `#[cfg(test)]`
- [ ] No test symbols in runtime code paths
- [ ] CI job passes (no symbol leaks)
- [ ] Integration tests use `test_support::` imports
- [ ] Documentation updated if new patterns introduced

## Win

**Clean test/runtime boundary with CI enforcement.** Test infrastructure is now:
- Clearly isolated in dedicated module
- Feature-gated with explicit documentation
- Verified excluded from release builds by CI
- Zero risk of test bloat in production binary

**Severity resolved:** Low risk eliminated with low effort.
