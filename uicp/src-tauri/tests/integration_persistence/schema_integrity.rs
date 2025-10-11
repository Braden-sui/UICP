//! Tests database schema integrity constraints.
//! Validates FK constraints, indexes, and schema migrations.

use rusqlite::Connection;
use std::time::Duration;
use tempfile::tempdir;

fn configure_sqlite(conn: &Connection) -> rusqlite::Result<()> {
    conn.busy_timeout(Duration::from_millis(5_000))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

fn init_test_db() -> (tempfile::TempDir, Connection) {
    let tmp = tempdir().expect("create tempdir");
    let db_path = tmp.path().join("test.db");
    let conn = Connection::open(&db_path).expect("open db");
    configure_sqlite(&conn).expect("configure");

    conn.execute_batch(
        r#"
        CREATE TABLE workspace (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE window (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            title TEXT NOT NULL,
            size TEXT NOT NULL,
            x REAL, y REAL, width REAL, height REAL,
            z_index INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY(workspace_id) REFERENCES workspace(id) ON DELETE CASCADE
        );
        CREATE TABLE tool_call (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            tool TEXT NOT NULL,
            args_json TEXT NOT NULL,
            result_json TEXT,
            created_at INTEGER NOT NULL,
            FOREIGN KEY(workspace_id) REFERENCES workspace(id) ON DELETE CASCADE
        );
        INSERT INTO workspace (id, name, created_at, updated_at) 
        VALUES ('default', 'Default', 0, 0);
        "#,
    )
    .expect("create schema");

    (tmp, conn)
}

#[test]
fn foreign_key_constraint_prevents_orphaned_windows() {
    let (_tmp, conn) = init_test_db();

    // Attempt to insert window with non-existent workspace_id
    let result = conn.execute(
        "INSERT INTO window (id, workspace_id, title, size, x, y, width, height, z_index, created_at, updated_at)
         VALUES ('orphan', 'nonexistent', 'Orphan', 'md', 0.0, 0.0, 800.0, 600.0, 0, 100, 100)",
        [],
    );

    assert!(
        result.is_err(),
        "Should fail to insert window with invalid workspace_id"
    );
}

#[test]
fn foreign_key_check_detects_violations() {
    let (_tmp, mut conn) = init_test_db();

    // Temporarily disable FK to insert bad data
    conn.pragma_update(None, "foreign_keys", "OFF").unwrap();

    conn.execute(
        "INSERT INTO window (id, workspace_id, title, size, x, y, width, height, z_index, created_at, updated_at)
         VALUES ('bad', 'missing-workspace', 'Bad', 'md', 0.0, 0.0, 640.0, 480.0, 0, 100, 100)",
        [],
    )
    .unwrap();

    // Re-enable FK
    conn.pragma_update(None, "foreign_keys", "ON").unwrap();

    // Run FK check
    let mut stmt = conn.prepare("PRAGMA foreign_key_check").unwrap();
    let violations: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();

    assert!(
        !violations.is_empty(),
        "FK check should detect orphaned window"
    );
}

#[test]
fn quick_check_validates_db_integrity() {
    let (_tmp, conn) = init_test_db();

    // Insert valid data
    conn.execute(
        "INSERT INTO window (id, workspace_id, title, size, x, y, width, height, z_index, created_at, updated_at)
         VALUES ('w1', 'default', 'Win', 'md', 0.0, 0.0, 800.0, 600.0, 0, 100, 100)",
        [],
    )
    .unwrap();

    // Run quick_check
    let mut stmt = conn.prepare("PRAGMA quick_check").unwrap();
    let mut rows = stmt.query([]).unwrap();
    let result: String = rows.next().unwrap().unwrap().get(0).unwrap();

    assert_eq!(result, "ok", "Database should pass integrity check");
}

#[test]
fn workspace_primary_key_prevents_duplicates() {
    let (_tmp, conn) = init_test_db();

    let result = conn.execute(
        "INSERT INTO workspace (id, name, created_at, updated_at) 
         VALUES ('default', 'Duplicate', 200, 200)",
        [],
    );

    assert!(
        result.is_err(),
        "Should fail to insert duplicate workspace id"
    );
}

#[test]
fn wal_mode_is_enabled() {
    let (_tmp, conn) = init_test_db();

    let journal_mode: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap();

    assert_eq!(
        journal_mode.to_lowercase(),
        "wal",
        "WAL mode should be enabled for concurrency"
    );
}

#[test]
fn foreign_keys_are_enabled() {
    let (_tmp, conn) = init_test_db();

    let fk_enabled: i64 = conn
        .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
        .unwrap();

    assert_eq!(fk_enabled, 1, "Foreign keys should be enabled");
}
