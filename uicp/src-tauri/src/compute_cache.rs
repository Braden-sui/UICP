use anyhow::Context;
use chrono::Utc;
use rusqlite::{params, Connection};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::AppState;

/// Canonicalize JSON deterministically (keys sorted, stable formatting).
pub fn canonicalize_input(value: &Value) -> String {
    fn write(value: &Value, out: &mut String) {
        match value {
            Value::Null => out.push_str("null"),
            Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Value::Number(n) => out.push_str(&n.to_string()),
            Value::String(s) => {
                out.push('"');
                for ch in s.chars() {
                    match ch {
                        // Escape JS separators to avoid accidental script-breaking tokens.
                        '\u{2028}' => out.push_str("\\u2028"),
                        '\u{2029}' => out.push_str("\\u2029"),
                        '"' => out.push_str("\\\""),
                        '\\' => out.push_str("\\\\"),
                        '\n' => out.push_str("\\n"),
                        '\r' => out.push_str("\\r"),
                        '\t' => out.push_str("\\t"),
                        c if c.is_control() => out.push_str(&format!("\\u{:04x}", c as u32)),
                        c => out.push(c),
                    }
                }
                out.push('"');
            }
            Value::Array(arr) => {
                out.push('[');
                let mut first = true;
                for v in arr {
                    if !first {
                        out.push(',');
                    } else {
                        first = false;
                    }
                    write(v, out);
                }
                out.push(']');
            }
            Value::Object(map) => {
                out.push('{');
                let mut first = true;
                let mut keys: Vec<_> = map.keys().collect();
                keys.sort();
                for k in keys {
                    if !first {
                        out.push(',');
                    } else {
                        first = false;
                    }
                    // key
                    write(&Value::String(k.to_string()), out);
                    out.push(':');
                    write(map.get(k).unwrap(), out);
                }
                out.push('}');
            }
        }
    }
    let mut out = String::with_capacity(256);
    write(value, &mut out);
    out
}

/// Compute a content-addressed cache key from task, canonical input, and env hash.
pub fn compute_key(task: &str, input: &Value, env_hash: &str) -> String {
    let canonical = canonicalize_input(input);
    let mut hasher = Sha256::new();
    hasher.update(b"v1|");
    hasher.update(task.as_bytes());
    hasher.update(b"|env|");
    hasher.update(env_hash.as_bytes());
    hasher.update(b"|input|");
    hasher.update(canonical.as_bytes());
    let digest = hasher.finalize();
    hex::encode(digest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalize_is_stable_and_key_sorted() {
        let v1 = serde_json::json!({"b":2,"a":1,"z":[3,2,1],"o":{"y":2,"x":1}});
        let v2 = serde_json::json!({"z":[3,2,1],"a":1,"o":{"x":1,"y":2},"b":2});
        let s1 = canonicalize_input(&v1);
        let s2 = canonicalize_input(&v2);
        assert_eq!(
            s1, s2,
            "canonicalization should be deterministic and order-insensitive for object keys"
        );
    }

    #[test]
    fn compute_key_changes_with_input_and_env() {
        let k1 = compute_key("task", &serde_json::json!({"x":1}), "env1");
        let k2 = compute_key("task", &serde_json::json!({"x":2}), "env1");
        let k3 = compute_key("task", &serde_json::json!({"x":1}), "env2");
        assert_ne!(k1, k2);
        assert_ne!(k1, k3);
        assert_ne!(k2, k3);
    }

    #[test]
    fn canonicalize_escapes_js_separators() {
        let value = Value::String("\u{2028}\u{2029}".to_string());
        let canonical = canonicalize_input(&value);
        assert!(
            canonical.contains("\\u2028") && canonical.contains("\\u2029"),
            "canonical string should escape JS separators for deterministic hashing"
        );
    }

    #[test]
    fn upsert_scopes_to_workspace_and_preserves_created_at() {
        let conn = rusqlite::Connection::open_in_memory().expect("in-memory sqlite");
        conn.execute_batch(
            r#"
            CREATE TABLE compute_cache (
                workspace_id TEXT NOT NULL,
                key TEXT NOT NULL,
                task TEXT NOT NULL,
                env_hash TEXT NOT NULL,
                value_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                PRIMARY KEY (workspace_id, key)
            );
            "#,
        )
        .unwrap();

        upsert_cache_row(
            &conn,
            "ws1",
            "shared-key",
            "task-a",
            "env-1",
            "{\"value\":1}",
            10,
        )
        .unwrap();
        upsert_cache_row(
            &conn,
            "ws2",
            "shared-key",
            "task-b",
            "env-1",
            "{\"value\":2}",
            20,
        )
        .unwrap();

        let ws1_value: String = conn
            .query_row(
                "SELECT value_json FROM compute_cache WHERE workspace_id = ?1 AND key = ?2",
                rusqlite::params!["ws1", "shared-key"],
                |row| row.get(0),
            )
            .unwrap();
        let ws2_value: String = conn
            .query_row(
                "SELECT value_json FROM compute_cache WHERE workspace_id = ?1 AND key = ?2",
                rusqlite::params!["ws2", "shared-key"],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(ws1_value, "{\"value\":1}");
        assert_eq!(ws2_value, "{\"value\":2}");

        // Repeat insert for ws1 and ensure created_at is not overwritten while metadata updates.
        upsert_cache_row(
            &conn,
            "ws1",
            "shared-key",
            "task-c",
            "env-2",
            "{\"value\":3}",
            30,
        )
        .unwrap();

        let ws1_created_at: i64 = conn
            .query_row(
                "SELECT created_at FROM compute_cache WHERE workspace_id = ?1 AND key = ?2",
                rusqlite::params!["ws1", "shared-key"],
                |row| row.get(0),
            )
            .unwrap();
        let ws1_task: String = conn
            .query_row(
                "SELECT task FROM compute_cache WHERE workspace_id = ?1 AND key = ?2",
                rusqlite::params!["ws1", "shared-key"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(ws1_created_at, 10, "created_at should remain original");
        assert_eq!(ws1_task, "task-c", "task should update on conflict");
    }
}

/// Fetch cached final event payload by key, scoped to a workspace.
pub async fn lookup(
    app: &AppHandle,
    workspace_id: &str,
    key: &str,
) -> anyhow::Result<Option<Value>> {
    let key = key.to_string();
    let ws = workspace_id.to_string();
    let state: State<'_, AppState> = app.state();
    let res = state
        .db_ro
        .call(move |conn| {
            let mut stmt = conn
                .prepare("SELECT value_json FROM compute_cache WHERE workspace_id = ?1 AND key = ?2")
                .context("prepare cache select")?;
            let mut rows = stmt.query(params![ws, key]).context("exec cache select")?;
            if let Some(row) = rows.next()? {
                let json_str: String = row.get(0)?;
                let val: Value = serde_json::from_str(&json_str).context("parse cached value")?;
                Ok(Some(val))
            } else {
                Ok(None)
            }
        })
        .await
        .context("cache lookup")?;
    Ok(res)
}

fn upsert_cache_row(
    conn: &Connection,
    workspace_id: &str,
    key: &str,
    task: &str,
    env_hash: &str,
    value_json: &str,
    created_at: i64,
) -> anyhow::Result<()> {
    // Intentionally leave created_at untouched on conflict to preserve original insertion time.
    conn.execute(
        "INSERT INTO compute_cache (workspace_id, key, task, env_hash, value_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(workspace_id, key) DO UPDATE
           SET task = excluded.task,
               env_hash = excluded.env_hash,
               value_json = excluded.value_json",
        params![workspace_id, key, task, env_hash, value_json, created_at],
    )
    .context("upsert cache value")?;
    Ok(())
}

/// Store final event payload by key (idempotent upsert).
pub async fn store(
    app: &AppHandle,
    workspace_id: &str,
    key: &str,
    task: &str,
    env_hash: &str,
    value: &Value,
) -> anyhow::Result<()> {
    // Freeze writes to persistence in Safe Mode
    let state: State<'_, AppState> = app.state();
    if *state.safe_mode.read().await {
        return Ok(());
    }
    let key = key.to_string();
    let ws = workspace_id.to_string();
    let task = task.to_string();
    let env_hash = env_hash.to_string();
    let json = serde_json::to_string(value).context("serialize cache value")?;
    state
        .db_rw
        .call(move |conn| {
            let now = Utc::now().timestamp();
            upsert_cache_row(conn, &ws, &key, &task, &env_hash, &json, now)
        })
        .await
        .context("cache store")??;
    Ok(())
}
