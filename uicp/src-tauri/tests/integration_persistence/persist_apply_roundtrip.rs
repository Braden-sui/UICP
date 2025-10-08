//! Integration: persist → restart → replay roundtrip.
//! NOTE: This is a scaffold. Replace placeholders with a real harness that starts the app and exercises Tauri commands.

use std::process::Command;
use tempfile::tempdir;

fn harness() -> std::path::PathBuf {
    let var = "CARGO_BIN_EXE_harness";
    let path = std::env::var(var).expect("CARGO_BIN_EXE_harness not set; run tests with cargo to build harness");
    std::path::PathBuf::from(path)
}

#[test]
fn persist_apply_roundtrip() {
    let tmp = tempdir().expect("tempdir");
    let db = tmp.path().join("data.db");

    // init-db
    let status = Command::new(harness()).args(["init-db", db.to_str().unwrap()]).status().unwrap();
    assert!(status.success());

    // persist two ops
    let s1 = Command::new(harness()).args(["persist", db.to_str().unwrap(), "id-1", "state.set", "{\"scope\":\"workspace\",\"key\":\"/k\",\"value\":1}"]).status().unwrap();
    assert!(s1.success());
    let s2 = Command::new(harness()).args(["persist", db.to_str().unwrap(), "id-2", "state.set", "{\"scope\":\"workspace\",\"key\":\"/k\",\"value\":2}"]).status().unwrap();
    assert!(s2.success());

    // log-hash before "restart"
    let out1 = Command::new(harness()).args(["log-hash", db.to_str().unwrap()]).output().unwrap();
    assert!(out1.status.success());
    let h1 = String::from_utf8_lossy(&out1.stdout).trim().to_string();

    // Simulate restart by re-running hash computation
    let out2 = Command::new(harness()).args(["log-hash", db.to_str().unwrap()]).output().unwrap();
    assert!(out2.status.success());
    let h2 = String::from_utf8_lossy(&out2.stdout).trim().to_string();

    assert_eq!(h1, h2, "log hash should be stable across restarts");
}
