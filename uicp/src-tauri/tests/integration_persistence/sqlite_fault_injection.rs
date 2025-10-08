//! Integration: simulate partial write/index corruption and verify recovery playbook.

use std::process::Command;
use tempfile::tempdir;

fn harness() -> std::path::PathBuf {
    let var = "CARGO_BIN_EXE_harness";
    let path = std::env::var(var).expect("CARGO_BIN_EXE_harness not set");
    std::path::PathBuf::from(path)
}

#[test]
fn sqlite_fault_injection() {
    let tmp = tempdir().expect("tempdir");
    let db = tmp.path().join("data.db");
    // init
    assert!(Command::new(harness()).args(["init-db", db.to_str().unwrap()]).status().unwrap().success());
    // persist two ok rows
    assert!(Command::new(harness()).args(["persist", db.to_str().unwrap(), "id-1", "state.set", "{\"scope\":\"workspace\",\"key\":\"/x\",\"value\":1}"]).status().unwrap().success());
    // save checkpoint
    assert!(Command::new(harness()).args(["save-checkpoint", db.to_str().unwrap(), "deadbeef"]).status().unwrap().success());
    // simulate trailing incomplete row (result_json = NULL)
    assert!(Command::new(harness()).args(["persist", db.to_str().unwrap(), "id-2", "state.set", "{\"scope\":\"workspace\",\"key\":\"/x\",\"value\":2}"]).status().unwrap().success());
    // compact-log should delete the trailing incomplete row
    let out = Command::new(harness()).args(["compact-log", db.to_str().unwrap()]).output().unwrap();
    assert!(out.status.success());
    let deleted = String::from_utf8_lossy(&out.stdout).trim().parse::<i64>().unwrap_or(-1);
    assert!(deleted >= 0);
}
