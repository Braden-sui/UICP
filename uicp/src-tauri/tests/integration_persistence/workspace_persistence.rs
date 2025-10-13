//! Tests workspace save/load persistence using production DB schema and logic.
//! Tests SQLite operations directly to ensure schema integrity without Tauri wrapper overhead.

use rusqlite::{params, Connection};
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

    // Production schema
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
        VALUES ('default', 'Test Workspace', 0, 0);
        "#,
    )
    .expect("create schema");

    (tmp, conn)
}

#[test]
fn workspace_save_load_roundtrip() {
    let (_tmp, mut conn) = init_test_db();

    // Save windows (mimics save_workspace command)
    let now = 1000i64;
    let tx = conn.transaction().unwrap();
    tx.execute(
        "DELETE FROM window WHERE workspace_id = ?1",
        params!["default"],
    )
    .unwrap();

    tx.execute(
        "INSERT INTO window (id, workspace_id, title, size, x, y, width, height, z_index, created_at, updated_at)
         VALUES ('w1', 'default', 'Test Window', 'md', 100.0, 200.0, 800.0, 600.0, 0, ?1, ?1)",
        params![now],
    )
    .unwrap();

    tx.execute(
        "UPDATE workspace SET updated_at = ?1 WHERE id = ?2",
        params![now, "default"],
    )
    .unwrap();
    tx.commit().unwrap();

    // Load windows (mimics load_workspace command)
    let mut stmt = conn
        .prepare(
            "SELECT id, title, x, y, width, height, z_index 
             FROM window WHERE workspace_id = ?1 ORDER BY z_index ASC",
        )
        .unwrap();

    let windows: Vec<(String, String, f64, f64, f64, f64, i64)> = stmt
        .query_map(params!["default"], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();

    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0].0, "w1");
    assert_eq!(windows[0].1, "Test Window");
    assert_eq!(windows[0].2, 100.0);
    assert_eq!(windows[0].3, 200.0);
}

#[test]
fn workspace_foreign_key_cascade_delete() {
    let (_tmp, conn) = init_test_db();

    // Insert workspace and window
    conn.execute(
        "INSERT INTO workspace (id, name, created_at, updated_at) 
         VALUES ('ws-test', 'Temp', 100, 100)",
        [],
    )
    .unwrap();

    conn.execute(
        "INSERT INTO window (id, workspace_id, title, size, x, y, width, height, z_index, created_at, updated_at)
         VALUES ('w-test', 'ws-test', 'Win', 'md', 0.0, 0.0, 640.0, 480.0, 0, 100, 100)",
        [],
    )
    .unwrap();

    // Delete workspace should cascade to window
    conn.execute("DELETE FROM workspace WHERE id = 'ws-test'", [])
        .unwrap();

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM window WHERE id = 'w-test'", [], |r| {
            r.get(0)
        })
        .unwrap();

    assert_eq!(count, 0, "Window should be cascade deleted with workspace");
}

#[test]
fn concurrent_workspace_writes_last_write_wins() {
    let (_tmp, conn) = init_test_db();

    // Simulate multiple rapid updates to workspace
    for i in 0..10 {
        conn.execute(
            "UPDATE workspace SET updated_at = ?1 WHERE id = 'default'",
            params![i * 100],
        )
        .unwrap();
    }

    let updated_at: i64 = conn
        .query_row(
            "SELECT updated_at FROM workspace WHERE id = 'default'",
            [],
            |r| r.get(0),
        )
        .unwrap();

    assert_eq!(updated_at, 900, "Should have last write value");
}
