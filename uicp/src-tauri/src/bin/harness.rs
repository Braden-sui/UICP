use std::{env, fs, path::PathBuf};

use chrono::Utc;
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

fn usage() -> ! {
    eprintln!("harness commands:\n  init-db <db_path>\n  persist <db_path> <id> <tool> <args_json>\n  clear-log <db_path>\n  log-hash <db_path>\n  save-checkpoint <db_path> <hash>\n  compact-log <db_path>\n  rollback-to-last-checkpoint <db_path>\n  reindex <db_path>\n  integrity-check <db_path>");
    std::process::exit(2)
}

fn init_db(db: &PathBuf) -> anyhow::Result<()> {
    if let Some(dir) = db.parent() { fs::create_dir_all(dir)?; }
    let conn = Connection::open(db)?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS workspace (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS window (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            title TEXT NOT NULL,
            size TEXT NOT NULL,
            x REAL,
            y REAL,
            width REAL,
            height REAL,
            z_index INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY(workspace_id) REFERENCES workspace(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS tool_call (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            tool TEXT NOT NULL,
            args_json TEXT NOT NULL,
            result_json TEXT,
            created_at INTEGER NOT NULL,
            FOREIGN KEY(workspace_id) REFERENCES workspace(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS replay_checkpoint (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            hash TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        "#,
    )?;
    let now = Utc::now().timestamp();
    conn.execute(
        "INSERT OR IGNORE INTO workspace (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
        params!["default", "Default", now],
    )?;
    Ok(())
}

fn persist(db: &PathBuf, id: &str, tool: &str, args_json: &str) -> anyhow::Result<()> {
    let conn = Connection::open(db)?;
    let now = Utc::now().timestamp();
    conn.execute(
        "INSERT INTO tool_call (id, workspace_id, tool, args_json, result_json, created_at) VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
        params![id, "default", tool, args_json, now],
    )?;
    Ok(())
}

fn clear_log(db: &PathBuf) -> anyhow::Result<()> {
    let conn = Connection::open(db)?;
    conn.execute("DELETE FROM tool_call WHERE workspace_id = ?1", params!["default"])?;
    Ok(())
}

fn save_checkpoint(db: &PathBuf, hash: &str) -> anyhow::Result<()> {
    let conn = Connection::open(db)?;
    let now = Utc::now().timestamp();
    conn.execute(
        "INSERT INTO replay_checkpoint (hash, created_at) VALUES (?1, ?2)",
        params![hash, now],
    )?;
    Ok(())
}

fn last_checkpoint_ts(conn: &Connection) -> anyhow::Result<Option<i64>> {
    let ts: Option<i64> = conn.query_row("SELECT MAX(created_at) FROM replay_checkpoint", [], |r| r.get(0)).optional()?;
    Ok(ts)
}

fn compact_log(db: &PathBuf) -> anyhow::Result<i64> {
    let conn = Connection::open(db)?;
    let since = last_checkpoint_ts(&conn)?;
    if since.is_none() { return Ok(0); }
    let since = since.unwrap();
    let n = conn.execute(
        "DELETE FROM tool_call WHERE created_at > ?1 AND (result_json IS NULL OR TRIM(result_json) = '')",
        params![since],
    )?;
    Ok(n as i64)
}

fn rollback_to_last_checkpoint(db: &PathBuf) -> anyhow::Result<i64> {
    let conn = Connection::open(db)?;
    let since = last_checkpoint_ts(&conn)?;
    if since.is_none() { return Ok(0); }
    let since = since.unwrap();
    let n = conn.execute("DELETE FROM tool_call WHERE created_at > ?1", params![since])?;
    Ok(n as i64)
}

fn integrity_check(db: &PathBuf) -> anyhow::Result<bool> {
    let conn = Connection::open(db)?;
    let mut stmt = conn.prepare("PRAGMA integrity_check")?;
    let mut rows = stmt.query([])?;
    let mut s = String::new();
    while let Some(row) = rows.next()? {
        let part: String = row.get(0)?;
        s.push_str(&part);
    }
    Ok(s.to_lowercase().contains("ok"))
}

fn reindex(db: &PathBuf) -> anyhow::Result<()> {
    let conn = Connection::open(db)?;
    conn.execute("REINDEX", [])?;
    Ok(())
}

fn canonicalize_json(value: &serde_json::Value) -> String {
    fn write(value: &serde_json::Value, out: &mut String) {
        use serde_json::Value as V;
        match value {
            V::Null | V::Bool(_) | V::Number(_) | V::String(_) => out.push_str(&value.to_string()),
            V::Array(arr) => {
                out.push('[');
                let mut first = true;
                for v in arr {
                    if !first { out.push(','); } else { first = false; }
                    write(v, out);
                }
                out.push(']');
            }
            V::Object(map) => {
                out.push('{');
                let mut keys: Vec<_> = map.keys().collect();
                keys.sort();
                let mut first = true;
                for k in keys {
                    if !first { out.push(','); } else { first = false; }
                    out.push_str(&format!("\"{}\":", k));
                    write(map.get(k).unwrap(), out);
                }
                out.push('}');
            }
        }
    }
    let mut out = String::new();
    write(value, &mut out);
    out
}

fn log_hash(db: &PathBuf) -> anyhow::Result<String> {
    let conn = Connection::open(db)?;
    let mut stmt = conn.prepare("SELECT tool, args_json FROM tool_call WHERE workspace_id = ?1 ORDER BY created_at ASC")?;
    let rows = stmt
        .query_map(params!["default"], |row| {
            let tool: String = row.get(0)?;
            let args: String = row.get(1)?;
            Ok((tool, args))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let arr = serde_json::Value::Array(
        rows.into_iter().map(|(t, a)| {
            serde_json::json!({ "tool": t, "args": serde_json::from_str::<serde_json::Value>(&a).unwrap_or(serde_json::json!(null)) })
        }).collect()
    );
    let canon = canonicalize_json(&arr);
    let mut hasher = Sha256::new();
    hasher.update(canon.as_bytes());
    Ok(hex::encode(hasher.finalize()))
}

fn main() -> anyhow::Result<()> {
    let mut args = env::args().skip(1).collect::<Vec<_>>();
    if args.is_empty() { usage(); }
    let cmd = args.remove(0);
    match cmd.as_str() {
        "init-db" => {
            let db = PathBuf::from(args.get(0).cloned().unwrap_or_default());
            init_db(&db)?;
            println!("ok");
        }
        "persist" => {
            if args.len() < 4 { usage(); }
            let db = PathBuf::from(&args[0]);
            persist(&db, &args[1], &args[2], &args[3])?;
            println!("ok");
        }
        "clear-log" => {
            let db = PathBuf::from(args.get(0).cloned().unwrap_or_default());
            clear_log(&db)?;
            println!("ok");
        }
        "log-hash" => {
            let db = PathBuf::from(args.get(0).cloned().unwrap_or_default());
            println!("{}", log_hash(&db)?);
        }
        "save-checkpoint" => {
            if args.len() < 2 { usage(); }
            let db = PathBuf::from(&args[0]);
            save_checkpoint(&db, &args[1])?; println!("ok");
        }
        "compact-log" => {
            let db = PathBuf::from(args.get(0).cloned().unwrap_or_default());
            println!("{}", compact_log(&db)?);
        }
        "rollback-to-last-checkpoint" => {
            let db = PathBuf::from(args.get(0).cloned().unwrap_or_default());
            println!("{}", rollback_to_last_checkpoint(&db)?);
        }
        "reindex" => {
            let db = PathBuf::from(args.get(0).cloned().unwrap_or_default());
            reindex(&db)?; println!("ok");
        }
        "integrity-check" => {
            let db = PathBuf::from(args.get(0).cloned().unwrap_or_default());
            println!("{}", integrity_check(&db)?);
        }
        _ => usage(),
    }
    Ok(())
}
