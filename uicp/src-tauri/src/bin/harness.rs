use std::env;
use std::path::PathBuf;
use std::time::Duration;

use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use tokio_rusqlite::Connection as AsyncConn;
use sha2::{Digest, Sha256};

async fn init_database(db_path: &PathBuf) -> anyhow::Result<()> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = AsyncConn::open(db_path).await?;
    conn.call(|c| configure_sqlite(c)).await??;
    conn.call(|c| c.execute_batch(
        r#"
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
        CREATE TABLE IF NOT EXISTS window_content (
            id TEXT PRIMARY KEY,
            window_id TEXT NOT NULL,
            html TEXT NOT NULL,
            version INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            FOREIGN KEY(window_id) REFERENCES window(id) ON DELETE CASCADE
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
        CREATE TABLE IF NOT EXISTS compute_cache (
            workspace_id TEXT NOT NULL,
            key TEXT NOT NULL,
            task TEXT NOT NULL,
            env_hash TEXT NOT NULL,
            value_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (workspace_id, key)
        );
        CREATE INDEX IF NOT EXISTS idx_compute_cache_task_env
            ON compute_cache (workspace_id, task, env_hash);
        CREATE TABLE IF NOT EXISTS replay_checkpoint (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            hash TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        "#,
    )).await??;
    Ok(())
}

fn configure_sqlite(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.busy_timeout(Duration::from_millis(5_000))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(())
}

async fn ensure_default_workspace(db_path: &PathBuf) -> anyhow::Result<()> {
    let conn = AsyncConn::open(db_path).await?;
    conn.call(|c| configure_sqlite(c)).await??;
    let now = Utc::now().timestamp();
    conn.call(move |c| {
        c.execute(
            "INSERT OR IGNORE INTO workspace (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            params!["default", "Default Workspace", now],
        )?;
        Ok::<_, rusqlite::Error>(())
    }).await??;
    Ok(())
}

async fn cmd_init_db(db: &PathBuf) -> anyhow::Result<i32> {
    init_database(db).await?;
    ensure_default_workspace(db).await?;
    Ok(0)
}

async fn cmd_persist(db: &PathBuf, id: &str, tool: &str, args_json: &str) -> anyhow::Result<i32> {
    init_database(db).await?; // idempotent
    ensure_default_workspace(db).await?;
    let conn = AsyncConn::open(db).await?;
    conn.call(|c| configure_sqlite(c)).await??;
    let id = id.to_string();
    let tool = tool.to_string();
    let args = args_json.to_string();
    conn.call(move |c| {
        let now = Utc::now().timestamp();
        c.execute(
            "INSERT INTO tool_call (id, workspace_id, tool, args_json, result_json, created_at) VALUES (?1, ?2, ?3, ?4, NULL, ?5)",
            params![id, "default", tool, args, now],
        )?;
        Ok::<_, rusqlite::Error>(())
    }).await?;
    Ok(0)
}

async fn cmd_log_hash(db: &PathBuf) -> anyhow::Result<i32> {
    init_database(db).await?;
    let conn = AsyncConn::open(db).await?;
    conn.call(|c| configure_sqlite(c)).await?;
    let hex = conn
        .call(|c| {
            let mut stmt = c.prepare(
                "SELECT id, tool, COALESCE(args_json, ''), COALESCE(result_json, ''), created_at FROM tool_call ORDER BY created_at ASC, id ASC",
            )?;
            let mut rows = stmt.query([])?;
            let mut hasher = Sha256::new();
            while let Some(row) = rows.next()? {
                let id: String = row.get(0)?;
                let tool: String = row.get(1)?;
                let args: String = row.get(2)?;
                let res: String = row.get(3)?;
                let ts: i64 = row.get(4)?;
                hasher.update(id.as_bytes());
                hasher.update([0]);
                hasher.update(tool.as_bytes());
                hasher.update([0]);
                hasher.update(args.as_bytes());
                hasher.update([0]);
                hasher.update(res.as_bytes());
                hasher.update([0]);
                hasher.update(ts.to_le_bytes());
                hasher.update([0xff]);
            }
            Ok::<_, rusqlite::Error>(hex::encode(hasher.finalize()))
        })
        .await??;
    println!("{}", hex);
    Ok(0)
}

fn last_checkpoint_ts(conn: &rusqlite::Connection) -> anyhow::Result<Option<i64>> {
    let ts: Option<i64> = conn
        .query_row("SELECT MAX(created_at) FROM replay_checkpoint", [], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(ts)
}

async fn cmd_save_checkpoint(db: &PathBuf, hash: &str) -> anyhow::Result<i32> {
    init_database(db).await?;
    let conn = AsyncConn::open(db).await?;
    conn.call(|c| configure_sqlite(c)).await??;
    let hash = hash.to_string();
    conn
        .call(move |c| {
            let now = Utc::now().timestamp();
            c.execute(
                "INSERT INTO replay_checkpoint (hash, created_at) VALUES (?1, ?2)",
                params![hash, now],
            )?;
            Ok::<_, rusqlite::Error>(())
        })
        .await??;
    Ok(0)
}

async fn cmd_compact_log(db: &PathBuf) -> anyhow::Result<i32> {
    init_database(db).await?;
    let conn = AsyncConn::open(db).await?;
    conn.call(|c| configure_sqlite(c)).await??;
    let since = conn
        .call(|c| last_checkpoint_ts(c))
        .await??
        .unwrap_or(0);
    let deleted = conn
        .call(move |c| {
            let n = c.execute(
                "DELETE FROM tool_call WHERE created_at > ?1 AND (result_json IS NULL OR TRIM(result_json) = '')",
                params![since],
            )? as i64;
            Ok::<_, rusqlite::Error>(n)
        })
        .await??;
    println!("{}", deleted);
    Ok(0)
}

fn usage() -> ! {
    eprintln!("Usage:\n  harness init-db <db_path>\n  harness persist <db_path> <id> <tool> <args_json>\n  harness log-hash <db_path>\n  harness save-checkpoint <db_path> <hash>\n  harness compact-log <db_path>\n  harness materialize <db_path> <key>\n  harness count-missing <db_path>\n  harness quick-check <db_path>\n  harness fk-check <db_path>");
    std::process::exit(2)
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut args = env::args().skip(1);
    let Some(cmd) = args.next() else { usage() };
    let code = match cmd.as_str() {
        "init-db" => {
            let db = PathBuf::from(args.next().unwrap_or_else(|| usage()));
            cmd_init_db(&db).await
        }
        "persist" => {
            let db = PathBuf::from(args.next().unwrap_or_else(|| usage()));
            let id = args.next().unwrap_or_else(|| usage());
            let tool = args.next().unwrap_or_else(|| usage());
            let args_json = args.next().unwrap_or_else(|| usage());
            cmd_persist(&db, &id, &tool, &args_json).await
        }
        "log-hash" => {
            let db = PathBuf::from(args.next().unwrap_or_else(|| usage()));
            cmd_log_hash(&db).await
        }
        "materialize" => {
            let db = PathBuf::from(args.next().unwrap_or_else(|| usage()));
            let key = args.next().unwrap_or_else(|| usage());
            cmd_materialize(&db, &key).await
        }
        "count-missing" => {
            let db = PathBuf::from(args.next().unwrap_or_else(|| usage()));
            cmd_count_missing(&db).await
        }
        "quick-check" => {
            let db = PathBuf::from(args.next().unwrap_or_else(|| usage()));
            cmd_quick_check(&db).await
        }
        "fk-check" => {
            let db = PathBuf::from(args.next().unwrap_or_else(|| usage()));
            cmd_fk_check(&db).await
        }
        "save-checkpoint" => {
            let db = PathBuf::from(args.next().unwrap_or_else(|| usage()));
            let hash = args.next().unwrap_or_else(|| usage());
            cmd_save_checkpoint(&db, &hash).await
        }
        "compact-log" => {
            let db = PathBuf::from(args.next().unwrap_or_else(|| usage()));
            cmd_compact_log(&db).await
        }
        _ => usage(),
    };
    match code {
        Ok(_) => {}
        Err(err) => {
            eprintln!("error: {err:?}");
            std::process::exit(1);
        }
    }
}

async fn cmd_materialize(db: &PathBuf, key: &str) -> anyhow::Result<i32> {
    init_database(db).await?;
    let conn = AsyncConn::open(db).await?;
    conn.call(|c| configure_sqlite(c)).await??;
    let key_s = key.to_string();
    let value: Option<String> = conn
        .call(move |c| {
            let mut stmt = c.prepare(
                "SELECT json_extract(args_json, '$.value') FROM tool_call \
                 WHERE tool = 'state.set' AND json_extract(args_json, '$.key') = ?1 \
                 ORDER BY created_at DESC, id DESC LIMIT 1",
            )?;
            let v: Option<String> = stmt.query_row([key_s], |r| r.get(0)).optional()?;
            Ok::<_, rusqlite::Error>(v)
        })
        .await??;
    if let Some(v) = value {
        println!("{}", v);
    }
    Ok(0)
}

async fn cmd_count_missing(db: &PathBuf) -> anyhow::Result<i32> {
    init_database(db).await?;
    let conn = AsyncConn::open(db).await?;
    conn.call(|c| configure_sqlite(c)).await??;
    let count: i64 = conn
        .call(|c| c.query_row(
            "SELECT COUNT(*) FROM tool_call WHERE result_json IS NULL OR TRIM(result_json) = ''",
            [],
            |r| r.get(0),
        ))
        .await??;
    println!("{}", count);
    Ok(0)
}

async fn cmd_quick_check(db: &PathBuf) -> anyhow::Result<i32> {
    init_database(db).await?;
    let conn = AsyncConn::open(db).await?;
    conn.call(|c| configure_sqlite(c)).await??;
    let status: String = conn
        .call(|c| {
            let mut stmt = c.prepare("PRAGMA quick_check")?;
            let mut rows = stmt.query([])?;
            let mut results = Vec::new();
            while let Some(row) = rows.next()? {
                let s: String = row.get(0)?;
                results.push(s);
            }
            Ok::<_, rusqlite::Error>(results.join(", "))
        })
        .await??;
    let ok = status.to_lowercase().contains("ok");
    println!("{}", if ok { "ok" } else { "not_ok" });
    Ok(if ok { 0 } else { 1 })
}

async fn cmd_fk_check(db: &PathBuf) -> anyhow::Result<i32> {
    init_database(db).await?;
    let conn = AsyncConn::open(db).await?;
    conn.call(|c| configure_sqlite(c)).await??;
    let violations: u64 = conn
        .call(|c| {
            let mut stmt = c.prepare("PRAGMA foreign_key_check")?;
            let mut rows = stmt.query([])?;
            let mut v = 0u64;
            while let Some(_row) = rows.next()? {
                v += 1;
            }
            Ok::<_, rusqlite::Error>(v)
        })
        .await??;
    println!("{}", violations);
    Ok(if violations == 0 { 0 } else { 1 })
}
