use anyhow::Context;
use chrono::Utc;
use rusqlite::{params, Connection};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{Manager, Runtime, State};

use crate::compute_input::sanitize_ws_files_path;
use crate::core::log_warn;
use crate::AppState;
use crate::ComputeJobSpec;
use blake3::Hasher as Blake3;

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
                    // SAFETY: k came from keys iterator, so must exist in map
                    write(
                        map.get(k).expect("key from iterator must exist in map"),
                        out,
                    );
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

fn collect_ws_inputs(value: &Value, acc: &mut Vec<String>) {
    match value {
        Value::String(s) => {
            if s.starts_with("ws:/files/") {
                acc.push(s.clone());
            }
        }
        Value::Array(arr) => {
            for v in arr {
                collect_ws_inputs(v, acc);
            }
        }
        Value::Object(map) => {
            for v in map.values() {
                collect_ws_inputs(v, acc);
            }
        }
        _ => {}
    }
}

fn build_ws_manifest(input: &Value) -> String {
    let mut paths: Vec<String> = Vec::new();
    collect_ws_inputs(input, &mut paths);
    paths.sort();
    paths.dedup();
    if paths.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    for ws in paths {
        let entry = if let Ok(host_path) = sanitize_ws_files_path(&ws) {
            match std::fs::read(&host_path) {
                Ok(bytes) => {
                    let mut h = Blake3::new();
                    h.update(&bytes);
                    let digest = h.finalize();
                    format!("{}={},{}", ws, "b3", hex::encode(digest.as_bytes()))
                }
                Err(_) => format!("{}={},{}", ws, "missing", 0),
            }
        } else {
            format!("{}={},{}", ws, "denied", 0)
        };
        if !out.is_empty() {
            out.push('|');
        }
        out.push_str(&entry);
    }
    out
}

#[cfg(test)]
pub fn compute_key_v2(spec: &ComputeJobSpec, input: &Value) -> String {
    let canonical = canonicalize_input(input);
    let manifest = build_ws_manifest(input);
    let mut hasher = Sha256::new();
    hasher.update(b"v2|");
    hasher.update(spec.task.as_bytes());
    hasher.update(b"|env|");
    hasher.update(spec.provenance.env_hash.as_bytes());
    hasher.update(b"|input|");
    hasher.update(canonical.as_bytes());
    if !manifest.is_empty() {
        hasher.update(b"|manifest|");
        hasher.update(manifest.as_bytes());
    }
    let digest = hasher.finalize();
    hex::encode(digest)
}

pub fn compute_key_v2_plus(spec: &ComputeJobSpec, input: &Value, invariants: &str) -> String {
    let canonical = canonicalize_input(input);
    let manifest = build_ws_manifest(input);
    let mut hasher = Sha256::new();
    hasher.update(b"v2|");
    hasher.update(spec.task.as_bytes());
    hasher.update(b"|env|");
    hasher.update(spec.provenance.env_hash.as_bytes());
    hasher.update(b"|input|");
    hasher.update(canonical.as_bytes());
    if !invariants.is_empty() {
        hasher.update(b"|inv|");
        hasher.update(invariants.as_bytes());
    }
    if !manifest.is_empty() {
        hasher.update(b"|manifest|");
        hasher.update(manifest.as_bytes());
    }
    let digest = hasher.finalize();
    hex::encode(digest)
}

/// Golden artifact lookup result.
#[derive(Debug, Clone, PartialEq)]
pub struct GoldenRecord {
    pub output_hash: String,
    pub value: Value,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Number;

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
    fn canonicalize_preserves_float_ieee_representation() {
        // Test that identical IEEE 754 values produce identical canonical forms.
        // NOTE: 0.3 and (0.1 + 0.2) have DIFFERENT IEEE representations (classic precision issue).
        // We test that the same IEEE value, created multiple ways, canonicalizes identically.

        let value = 0.3f64; // Exact IEEE representation
        let canonical_a =
            canonicalize_input(&Value::Number(Number::from_f64(value).expect("finite")));
        let canonical_b =
            canonicalize_input(&Value::Number(Number::from_f64(value).expect("finite")));
        assert_eq!(
            canonical_a, canonical_b,
            "identical IEEE 754 values must canonicalize identically"
        );

        // Verify that DIFFERENT IEEE values produce DIFFERENT canonical forms (cache correctness).
        let different = 0.1f64 + 0.2f64; // Different IEEE representation from 0.3
        let canonical_c =
            canonicalize_input(&Value::Number(Number::from_f64(different).expect("finite")));
        assert_ne!(
            canonical_a, canonical_c,
            "different IEEE 754 values (0.3 vs 0.1+0.2) must canonicalize differently for cache correctness"
        );
    }

    #[test]
    fn serde_refuses_non_finite_numbers() {
        assert!(
            Number::from_f64(f64::NAN).is_none(),
            "serde_json::Number must reject NaN"
        );
        assert!(
            Number::from_f64(f64::INFINITY).is_none(),
            "serde_json::Number must reject +INF"
        );
        assert!(
            Number::from_f64(f64::NEG_INFINITY).is_none(),
            "serde_json::Number must reject -INF"
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

    #[test]
    fn compute_key_v2_plus_includes_invariants() {
        use crate::policy::ComputeJobSpec;

        let spec = ComputeJobSpec {
            job_id: "job1".to_string(),
            task: "test.task".to_string(),
            input: serde_json::json!({"x": 1}),
            cache: "readwrite".to_string(),
            workspace_id: "ws1".to_string(),
            replayable: true,
            provenance: crate::policy::ComputeProvenanceSpec {
                env_hash: "env123".to_string(),
                agent_trace_id: None,
            },
            token: None,
            capabilities: crate::policy::ComputeCapabilitiesSpec {
                ..Default::default()
            },
            mem_limit_mb: None,
            timeout_ms: None,
            fuel: None,
            bind: vec![],
            golden_key: None,
            artifact_id: None,
            expect_golden: false,
        };

        let input = serde_json::json!({"x": 1});

        // Key without invariants
        let key_v2 = compute_key_v2(&spec, &input);

        // Key with module invariants
        let invariants = "modsha=abc123|modver=1.0.0";
        let key_v2_plus = compute_key_v2_plus(&spec, &input, invariants);

        // Keys must differ when invariants are included
        assert_ne!(
            key_v2, key_v2_plus,
            "v2_plus key must differ from v2 when invariants present"
        );

        // Keys with same invariants must be identical (cache consistency)
        let key_v2_plus_dup = compute_key_v2_plus(&spec, &input, invariants);
        assert_eq!(
            key_v2_plus, key_v2_plus_dup,
            "v2_plus keys with identical invariants must match"
        );

        // Keys with different invariants must differ
        let different_invariants = "modsha=xyz789|modver=2.0.0";
        let key_v2_plus_diff = compute_key_v2_plus(&spec, &input, different_invariants);
        assert_ne!(
            key_v2_plus, key_v2_plus_diff,
            "v2_plus keys with different invariants must differ"
        );

        // Empty invariants should match v2 key
        let key_v2_plus_empty = compute_key_v2_plus(&spec, &input, "");
        assert_eq!(
            key_v2, key_v2_plus_empty,
            "v2_plus with empty invariants should match v2"
        );
    }
}

/// Fetch cached final event payload by key, scoped to a workspace.
#[cfg_attr(feature = "otel_spans", tracing::instrument(level = "info", skip(app), fields(workspace = %workspace_id)))]
pub async fn lookup<R: Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    key: &str,
) -> anyhow::Result<Option<Value>> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("compute_cache_lookup", workspace = %workspace_id);
    let key = key.to_string();
    let ws = workspace_id.to_string();
    let state: State<'_, AppState> = app.state();
    let path = state.db_path.clone();
    #[cfg(feature = "otel_spans")]
    #[cfg(feature = "otel_spans")]
    let started = std::time::Instant::now();
    let res = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<Value>> {
        let conn = Connection::open(path).context("open sqlite for cache lookup")?;
        crate::configure_sqlite(&conn).context("configure sqlite for cache lookup")?;
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
    #[cfg(feature = "otel_spans")]
    {
        let ms = started.elapsed().as_millis() as i64;
        match &res {
            Ok(Some(_)) => tracing::info!(
                target = "uicp",
                duration_ms = ms,
                hit = true,
                "cache lookup ok"
            ),
            Ok(None) => tracing::info!(
                target = "uicp",
                duration_ms = ms,
                hit = false,
                "cache lookup ok"
            ),
            Err(e) => log_warn(format!("cache lookup failed (duration_ms={ms}, error={e})")),
        }
    }
    #[cfg(not(feature = "otel_spans"))]
    if let Err(e) = &res {
        log_warn(format!("cache lookup failed: {e}"));
    }
    res
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
#[cfg_attr(feature = "otel_spans", tracing::instrument(level = "info", skip(app, value), fields(workspace = %workspace_id, task = %task)))]
pub async fn store<R: Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    key: &str,
    task: &str,
    env_hash: &str,
    value: &Value,
) -> anyhow::Result<()> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("compute_cache_store", workspace = %workspace_id, task = %task);
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
    let path = state.db_path.clone();
    #[cfg(feature = "otel_spans")]
    let started = std::time::Instant::now();
    let res = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = Connection::open(path).context("open sqlite for cache store")?;
        crate::configure_sqlite(&conn).context("configure sqlite for cache store")?;
        let now = Utc::now().timestamp();
        upsert_cache_row(&conn, &ws, &key, &task, &env_hash, &json, now)
    })
    .await
    .context("cache store")?;
    #[cfg(feature = "otel_spans")]
    {
        let ms = started.elapsed().as_millis() as i64;
        match &res {
            Ok(_) => tracing::info!(target = "uicp", duration_ms = ms, "cache store ok"),
            Err(e) => log_warn(format!("cache store failed (duration_ms={ms}, error={e})")),
        }
    }
    res?;
    Ok(())
}

// ============================================================================
// Track C: Golden Cache for Code Artifacts
// ============================================================================

/// Compute SHA-256 hash of output JSON for golden artifact verification.
pub fn compute_output_hash(output: &Value) -> String {
    let canonical = canonicalize_input(output);
    let mut hasher = Sha256::new();
    hasher.update(b"golden-v1|");
    hasher.update(canonical.as_bytes());
    let digest = hasher.finalize();
    hex::encode(digest)
}

/// Store golden artifact hash for deterministic replay validation.
///
/// WHY: Track C code generation must be deterministic. Store the hash of the first
/// successful output, then verify subsequent runs produce identical results.
///
/// INVARIANT: golden_key uniquely identifies the artifact within a workspace.
#[cfg_attr(feature = "otel_spans", tracing::instrument(level = "info", skip(app, value), fields(workspace = %workspace_id, key = %golden_key)))]
pub async fn store_golden<R: Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    golden_key: &str,
    output_hash: &str,
    task: &str,
    value: &Value,
) -> anyhow::Result<()> {
    #[cfg(feature = "otel_spans")]
    let _span =
        tracing::info_span!("golden_cache_store", workspace = %workspace_id, key = %golden_key);

    let state: State<'_, AppState> = app.state();
    if *state.safe_mode.read().await {
        return Ok(());
    }

    let key = golden_key.to_string();
    let ws = workspace_id.to_string();
    let hash = output_hash.to_string();
    let task_str = task.to_string();
    let json = serde_json::to_string(value).context("serialize golden value")?;
    let path = state.db_path.clone();

    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let conn = Connection::open(path).context("open sqlite for golden store")?;
        crate::configure_sqlite(&conn).context("configure sqlite for golden store")?;
        let now = Utc::now().timestamp();

        // Upsert golden hash (preserve created_at on conflict)
        conn.execute(
            "INSERT INTO golden_cache (workspace_id, key, output_hash, task, value_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(workspace_id, key) DO NOTHING",
            params![ws, key, hash, task_str, json, now],
        )
        .context("upsert golden hash")?;
        Ok(())
    })
    .await
    .context("golden cache store")??;

    Ok(())
}

/// Lookup golden artifact hash for replay validation.
///
/// Returns None if no golden exists for this key (first run).
/// Returns Some(hash) if a golden artifact was previously stored.
#[cfg_attr(feature = "otel_spans", tracing::instrument(level = "info", skip(app), fields(workspace = %workspace_id, key = %golden_key)))]
pub async fn lookup_golden<R: Runtime>(
    app: &tauri::AppHandle<R>,
    workspace_id: &str,
    golden_key: &str,
) -> anyhow::Result<Option<GoldenRecord>> {
    #[cfg(feature = "otel_spans")]
    let _span =
        tracing::info_span!("golden_cache_lookup", workspace = %workspace_id, key = %golden_key);

    let key = golden_key.to_string();
    let ws = workspace_id.to_string();
    let state: State<'_, AppState> = app.state();
    let path = state.db_path.clone();

    let res = tokio::task::spawn_blocking(move || -> anyhow::Result<Option<GoldenRecord>> {
        let conn = Connection::open(path).context("open sqlite for golden lookup")?;
        crate::configure_sqlite(&conn).context("configure sqlite for golden lookup")?;

        let mut stmt = conn
            .prepare("SELECT output_hash, value_json FROM golden_cache WHERE workspace_id = ?1 AND key = ?2")
            .context("prepare golden select")?;

        let mut rows = stmt.query(params![ws, key]).context("exec golden select")?;
        if let Some(row) = rows.next()? {
            let hash: String = row.get(0)?;
            let value_json: String = row.get(1)?;
            let value: Value =
                serde_json::from_str(&value_json).context("parse golden cached value")?;
            Ok(Some(GoldenRecord {
                output_hash: hash,
                value,
            }))
        } else {
            Ok(None)
        }
    })
    .await
    .context("golden lookup")??;

    Ok(res)
}
