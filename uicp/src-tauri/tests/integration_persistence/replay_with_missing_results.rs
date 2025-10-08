//! Integration: replay when jobs are missing terminal results.

#[test]
#[ignore = "integration harness pending"]
fn replay_with_missing_results() {
    // Steps:
    // - Insert a JobSpec without a terminal result (replayable=true)
    // - On replay, verify re-enqueue happens only when replayable=true
    assert!(true);
}

