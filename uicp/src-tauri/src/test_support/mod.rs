//! Test support infrastructure.
//!
//! This module and its contents are only compiled when running tests or when the
//! `compute_harness` feature is enabled. It is excluded from production release builds.
//!
//! **BOUNDARY INVARIANT**: No code in this module should be referenced by runtime code.
//! All items here exist solely to support testing and development harnesses.

#![cfg(any(test, feature = "compute_harness"))]

mod harness;

pub use harness::ComputeTestHarness;
