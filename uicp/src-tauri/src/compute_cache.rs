use std::path::PathBuf;

use anyhow::Context;
use chrono::Utc;
use rusqlite::{params, Connection};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};

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
                    if !first { out.push(','); } else { first = false; }
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
                    if !first { out.push(','); } else { first = false; }
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

fn db_path(app: &AppHandle) -> PathBuf {
    let state: State<'_, AppState> = app.state();
    state.db_path.clone()
}

/// Fetch cached final event payload by key.
pub async fn lookup(app: &AppHandle, key: &str) -> anyhow::Result<Option<Value>> {
    let path = db_path(app);
    let key = key.to_string();
    let res = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<Value>> {
        let conn = Connection::open(path).context("open sqlite for compute_cache lookup")?;
        let mut stmt = conn
            .prepare("SELECT value_json FROM compute_cache WHERE key = ?1")
            .context("prepare cache select")?;
        let mut rows = stmt.query(params![key]).context("exec cache select")?;
        if let Some(row) = rows.next()? {
            let json_str: String = row.get(0)?;
            let val: Value = serde_json::from_str(&json_str).context("parse cached value")?;
            Ok(Some(val))
        } else {
            Ok(None)
        }
    })
    .await
    .context("join cache lookup")??;
    Ok(res)
}

/// Store final event payload by key (idempotent upsert).
pub async fn store(app: &AppHandle, key: &str, task: &str, env_hash: &str, value: &Value) -> anyhow::Result<()> {
    let path = db_path(app);
    let key = key.to_string();
    let task = task.to_string();
    let env_hash = env_hash.to_string();
    let json = serde_json::to_string(value).context("serialize cache value")?;
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = Connection::open(path).context("open sqlite for compute_cache store")?;
        let now = Utc::now().timestamp();
        conn.execute(
            "INSERT INTO compute_cache (key, task, env_hash, value_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(key) DO UPDATE SET task = excluded.task, env_hash = excluded.env_hash, value_json = excluded.value_json, created_at = excluded.created_at",
            params![key, task, env_hash, json, now],
        )
        .context("upsert cache value")?;
        Ok(())
    })
    .await
    .context("join cache store")??;
    Ok(())
}

