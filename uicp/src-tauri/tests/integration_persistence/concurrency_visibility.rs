//! Integration: interleave apply and persist under load; assert last-write-wins and no lost writes.

#[test]
#[ignore = "integration harness pending"]
fn concurrency_visibility() {
    // Steps:
    // - Flood adapter with writes to the same state path from multiple batches
    // - Ensure persistence log contains all writes in order
    // - Replay and validate last-write-wins at the target path
    assert!(true);
}

