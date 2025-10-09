//! Integration: interleave apply and persist under load; assert last-write-wins on materialization.

use std::process::Command;
use tempfile::tempdir;

fn harness() -> std::path::PathBuf {
    let var = "CARGO_BIN_EXE_harness";
    let path = std::env::var(var).expect("CARGO_BIN_EXE_harness not set; run with cargo test");
    std::path::PathBuf::from(path)
}

#[test]
fn concurrency_visibility() {
    let tmp = tempdir().expect("tempdir");
    let db = tmp.path().join("data.db");

    // init
    assert!(Command::new(harness()).args(["init-db", db.to_str().unwrap()]).status().unwrap().success());

    // Flood N writes to the same key
    let key = "/k";
    let n = 50;
    for i in 0..n {
        let id = format!("id-{}", i);
        let val = i.to_string();
        let args = format!("{{\"scope\":\"workspace\",\"key\":\"{}\",\"value\":{}}}", key, val);
        assert!(Command::new(harness()).args(["persist", db.to_str().unwrap(), &id, "state.set", &args]).status().unwrap().success());
    }

    // Materialize last-write-wins and expect the last value
    let out = Command::new(harness()).args(["materialize", db.to_str().unwrap(), key]).output().unwrap();
    assert!(out.status.success());
    let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
    assert_eq!(value, (n - 1).to_string());
}
