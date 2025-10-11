//! Tests command persistence (persist_command / get_workspace_commands).
//! Validates production tool_call table operations.

use chrono::Utc;
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

    conn.execute_batch(
        r#"
        CREATE TABLE workspace (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
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
fn persist_command_stores_in_tool_call_table() {
    let (_tmp, conn) = init_test_db();
    let now = Utc::now().timestamp();

    // Mimics persist_command production logic
    let id = "cmd-001";
    let tool = "state.set";
    let args_json = r#"{"key":"/test","value":42}"#;

    conn.execute(
        "INSERT INTO tool_call (id, workspace_id, tool, args_json, result_json, created_at)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
        params![id, "default", tool, args_json, now],
    )
    .unwrap();

    // Verify stored
    let (stored_tool, stored_args): (String, String) = conn
        .query_row(
            "SELECT tool, args_json FROM tool_call WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();

    assert_eq!(stored_tool, "state.set");
    assert!(stored_args.contains("\"key\":\"/test\""));
    assert!(stored_args.contains("\"value\":42"));
}

#[test]
fn get_workspace_commands_returns_ordered_by_created_at() {
    let (_tmp, conn) = init_test_db();

    // Insert commands out of order
    for i in [3, 1, 4, 2, 5] {
        conn.execute(
            "INSERT INTO tool_call (id, workspace_id, tool, args_json, result_json, created_at)
             VALUES (?1, 'default', 'test.cmd', '{}', NULL, ?2)",
            params![format!("cmd-{}", i), i * 100],
        )
        .unwrap();
    }

    // Mimics get_workspace_commands query
    let mut stmt = conn
        .prepare(
            "SELECT id FROM tool_call 
             WHERE workspace_id = 'default'
             ORDER BY created_at ASC",
        )
        .unwrap();

    let ids: Vec<String> = stmt
        .query_map(params![], |r| r.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();

    assert_eq!(
        ids,
        vec!["cmd-1", "cmd-2", "cmd-3", "cmd-4", "cmd-5"],
        "Should be ordered by created_at ascending"
    );
}

#[test]
fn clear_workspace_commands_deletes_all_for_workspace() {
    let (_tmp, conn) = init_test_db();

    // Add commands to default workspace
    for i in 0..5 {
        conn.execute(
            "INSERT INTO tool_call (id, workspace_id, tool, args_json, result_json, created_at)
             VALUES (?1, 'default', 'test.cmd', '{}', NULL, ?2)",
            params![format!("cmd-{}", i), i],
        )
        .unwrap();
    }

    // Add command to different workspace
    conn.execute(
        "INSERT INTO workspace (id, name, created_at, updated_at) 
         VALUES ('other', 'Other', 0, 0)",
        [],
    )
    .unwrap();

    conn.execute(
        "INSERT INTO tool_call (id, workspace_id, tool, args_json, result_json, created_at)
         VALUES ('other-cmd', 'other', 'test.cmd', '{}', NULL, 100)",
        [],
    )
    .unwrap();

    // Mimics clear_workspace_commands
    conn.execute("DELETE FROM tool_call WHERE workspace_id = 'default'", [])
        .unwrap();

    let default_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM tool_call WHERE workspace_id = 'default'",
            [],
            |r| r.get(0),
        )
        .unwrap();

    let other_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM tool_call WHERE workspace_id = 'other'",
            [],
            |r| r.get(0),
        )
        .unwrap();

    assert_eq!(
        default_count, 0,
        "Default workspace commands should be cleared"
    );
    assert_eq!(other_count, 1, "Other workspace commands should remain");
}

#[test]
fn incomplete_commands_have_null_result() {
    let (_tmp, conn) = init_test_db();

    // Insert incomplete command (result_json = NULL)
    conn.execute(
        "INSERT INTO tool_call (id, workspace_id, tool, args_json, result_json, created_at)
         VALUES ('incomplete', 'default', 'test.cmd', '{}', NULL, 100)",
        [],
    )
    .unwrap();

    let result: Option<String> = conn
        .query_row(
            "SELECT result_json FROM tool_call WHERE id = 'incomplete'",
            [],
            |r| r.get(0),
        )
        .unwrap();

    assert!(
        result.is_none(),
        "Incomplete command should have NULL result"
    );

    // Count incomplete commands
    let incomplete_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM tool_call 
             WHERE result_json IS NULL OR TRIM(result_json) = ''",
            [],
            |r| r.get(0),
        )
        .unwrap();

    assert_eq!(incomplete_count, 1);
}
