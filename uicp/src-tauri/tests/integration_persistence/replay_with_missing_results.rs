//! Integration: compact-log deletes trailing entries with missing results after a checkpoint.

use std::process::Command;
use tempfile::tempdir;

fn harness() -> std::path::PathBuf {
    let var = "CARGO_BIN_EXE_harness";
    let path = std::env::var(var).expect("CARGO_BIN_EXE_harness not set");
    std::path::PathBuf::from(path)
}

#[test]
fn replay_with_missing_results() {
    let tmp = tempdir().expect("tempdir");
    let db = tmp.path().join("data.db");
    assert!(Command::new(harness()).args(["init-db", db.to_str().unwrap()]).status().unwrap().success());

    // Write a few entries
    for i in 0..3 {
        let id = format!("pre-{}", i);
        let args = format!("{{\"scope\":\"workspace\",\"key\":\"/m\",\"value\":{}}}", i);
        assert!(Command::new(harness()).args(["persist", db.to_str().unwrap(), &id, "state.set", &args]).status().unwrap().success());
    }

    // Save a checkpoint (use a dummy hash)
    assert!(Command::new(harness()).args(["save-checkpoint", db.to_str().unwrap(), "beef"]).status().unwrap().success());

    // Add trailing incomplete rows (result_json is NULL in harness persist)
    for i in 0..5 {
        let id = format!("post-{}", i);
        let args = format!("{{\"scope\":\"workspace\",\"key\":\"/m\",\"value\":{}}}", i + 10);
        assert!(Command::new(harness()).args(["persist", db.to_str().unwrap(), &id, "state.set", &args]).status().unwrap().success());
    }

    // Count missing rows
    let before = Command::new(harness()).args(["count-missing", db.to_str().unwrap()]).output().unwrap();
    assert!(before.status.success());
    let before_n: i64 = String::from_utf8_lossy(&before.stdout).trim().parse().unwrap_or(-1);
    assert!(before_n >= 8, "expected at least 8 missing (pre + post)");

    // Compact: should delete trailing incomplete rows beyond the last checkpoint
    let out = Command::new(harness()).args(["compact-log", db.to_str().unwrap()]).output().unwrap();
    assert!(out.status.success());
    let deleted = String::from_utf8_lossy(&out.stdout).trim().parse::<i64>().unwrap_or(-1);
    assert!(deleted >= 0);

    // Count again; should be fewer (pre-checkpoint missing remain)
    let after = Command::new(harness()).args(["count-missing", db.to_str().unwrap()]).output().unwrap();
    assert!(after.status.success());
    let after_n: i64 = String::from_utf8_lossy(&after.stdout).trim().parse().unwrap_or(-1);
    assert!(after_n < before_n);
}
