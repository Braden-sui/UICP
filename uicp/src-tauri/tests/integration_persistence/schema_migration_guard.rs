//! Integration: simulate schema/constraint mismatch and detect via foreign key check.

use std::process::Command;
use tempfile::tempdir;

fn harness() -> std::path::PathBuf {
    let var = "CARGO_BIN_EXE_harness";
    let path = std::env::var(var).expect("CARGO_BIN_EXE_harness not set");
    std::path::PathBuf::from(path)
}

#[test]
fn schema_migration_guard() {
    let tmp = tempdir().expect("tempdir");
    let db = tmp.path().join("data.db");

    // init schema
    assert!(Command::new(harness()).args(["init-db", db.to_str().unwrap()]).status().unwrap().success());

    // Quick check should be ok on fresh DB
    let qc = Command::new(harness()).args(["quick-check", db.to_str().unwrap()]).output().unwrap();
    assert!(qc.status.success());
    let status = String::from_utf8_lossy(&qc.stdout).trim().to_string();
    assert_eq!(status, "ok");

    // Insert a window referencing a non-existent workspace id to violate FK constraints
    let conn = rusqlite::Connection::open(&db).expect("open");
    let now = chrono::Utc::now().timestamp();
    conn.execute(
        "INSERT INTO window (id, workspace_id, title, size, x, y, width, height, z_index, created_at, updated_at) \
         VALUES ('w-bad', 'missing', 'Bad', 'md', 0, 0, 640, 480, 0, ?1, ?1)",
        [now],
    )
    .unwrap();

    // Foreign key check should report a violation (non-zero)
    let fk = Command::new(harness()).args(["fk-check", db.to_str().unwrap()]).output().unwrap();
    let fk_code = fk.status.code().unwrap_or(0);
    assert_ne!(fk_code, 0, "fk-check should fail when constraints are violated");
}
