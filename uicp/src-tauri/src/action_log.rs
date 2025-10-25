use std::{
    borrow::Cow,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc as std_mpsc, Arc,
    },
    time::Duration,
};

use anyhow::{anyhow, Context};
use base64::engine::general_purpose::STANDARD as BASE64_ENGINE;
use base64::Engine as _;
use blake3::Hasher;
use chrono::Utc;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use rand::rngs::OsRng;
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{
    mpsc::{self, error::TrySendError},
    oneshot,
};
use tokio::time::timeout;

const HASH_DOMAIN: &[u8] = b"UICP-ACTION-LOG-V0";
#[cfg(not(test))]
// WHY: Compute stdout bursts can enqueue thousands of frames; 256 depth keeps writers mostly non-blocking while remaining bounded.
const DEFAULT_QUEUE_DEPTH: usize = 256;
#[cfg(test)]
const DEFAULT_QUEUE_DEPTH: usize = 16;
const ACTION_LOG_SEND_TIMEOUT_MS: u64 = 500;
const ENV_SIGNING_SEED: &str = "UICP_ACTION_LOG_SIGNING_SEED";
const ENV_SIGNING_SEED_FALLBACK: &str = "UICP_MODULES_SIGNING_SEED";

#[derive(Debug, Default)]
struct ActionLogMetrics {
    backpressure_events: AtomicU64,
    enqueue_failures: AtomicU64,
    reply_failures: AtomicU64,
    dropped_appends: AtomicU64,
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionLogStatsSnapshot {
    pub backpressure_events: u64,
    pub enqueue_failures: u64,
    pub reply_failures: u64,
    pub dropped_appends: u64,
}

#[derive(Debug, Clone)]
pub struct ActionLogHandle {
    tx: mpsc::Sender<ActionLogCommand>,
    metrics: Arc<ActionLogMetrics>,
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug)]
pub struct ActionLogReceipt {
    pub id: i64,
    pub hash: [u8; 32],
    pub prev_hash: Option<[u8; 32]>,
}

#[derive(Debug)]
pub struct ActionLogEntry<'a> {
    pub ts: i64,
    pub kind: Cow<'a, str>,
    pub payload_json: Cow<'a, str>,
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug)]
enum ActionLogCommand {
    Append {
        entry: ActionLogEntry<'static>,
        reply: oneshot::Sender<anyhow::Result<ActionLogReceipt>>,
    },
    #[cfg(test)]
    Shutdown,
}

pub struct ActionLogService;

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Debug, Clone)]
pub struct ActionLogVerifyReport {
    pub entries: usize,
    pub first_id: Option<i64>,
    pub last_id: Option<i64>,
    pub last_hash: Option<[u8; 32]>,
}

impl ActionLogService {
    pub fn start(db_path: &Path) -> anyhow::Result<ActionLogHandle> {
        let signing_seed = load_signing_seed()?;
        Self::start_with_seed(db_path, signing_seed)
    }

    pub fn start_with_seed(
        db_path: &Path,
        signing_seed: Option<[u8; 32]>,
    ) -> anyhow::Result<ActionLogHandle> {
        Self::start_with_seed_with_capacity(db_path, signing_seed, DEFAULT_QUEUE_DEPTH)
    }

    fn start_with_seed_with_capacity(
        db_path: &Path,
        signing_seed: Option<[u8; 32]>,
        queue_depth: usize,
    ) -> anyhow::Result<ActionLogHandle> {
        ensure_parent_dir(db_path)?;
        let (tx, rx) = mpsc::channel(queue_depth);
        let (ready_tx, ready_rx) = std_mpsc::channel::<anyhow::Result<()>>();
        let path: PathBuf = db_path.to_path_buf();
        let metrics = Arc::new(ActionLogMetrics::default());
        let metrics_for_worker = metrics.clone();

        let worker_join = tauri::async_runtime::spawn_blocking(move || {
            let mut rx = rx;
            let init = (|| -> anyhow::Result<()> {
                let mut conn = Connection::open(&path)
                    .with_context(|| format!("open sqlite for action log {:?}", path))?;
                crate::configure_sqlite(&conn).context("configure sqlite (action log)")?;
                ensure_action_log_schema(&conn)?;
                let signing_key = signing_seed.map(|seed| SigningKey::from_bytes(&seed));
                let mut rng = OsRng;
                ready_tx
                    .send(Ok(()))
                    .context("signal action log worker ready")?;

                if let Err(err) = worker_loop(
                    &mut conn,
                    signing_key.as_ref(),
                    &mut rng,
                    &mut rx,
                    metrics_for_worker,
                ) {
                    tracing::error!("action_log worker terminated with error: {err:?}");
                }
                Ok(())
            })();

            if let Err(err) = init {
                let _ = ready_tx.send(Err(err));
            }
        });

        tauri::async_runtime::spawn(async move {
            if let Err(err) = worker_join.await {
                tracing::error!("action_log worker join failed: {err:?}");
            }
        });

        ready_rx
            .recv()
            .context("await action log worker init")?
            .context("action log worker failed to initialize")?;

        Ok(ActionLogHandle { tx, metrics })
    }
}

impl ActionLogHandle {
    pub fn stats_snapshot(&self) -> ActionLogStatsSnapshot {
        ActionLogStatsSnapshot {
            backpressure_events: self.metrics.backpressure_events.load(Ordering::Relaxed),
            enqueue_failures: self.metrics.enqueue_failures.load(Ordering::Relaxed),
            reply_failures: self.metrics.reply_failures.load(Ordering::Relaxed),
            dropped_appends: self.metrics.dropped_appends.load(Ordering::Relaxed),
        }
    }

    #[cfg(test)]
    pub(crate) async fn close_channel_for_test(&self) {
        let _ = self.tx.send(ActionLogCommand::Shutdown).await;
        self.tx.closed().await;
    }

    pub fn append_json_blocking(
        &self,
        kind: &str,
        payload: &Value,
    ) -> anyhow::Result<ActionLogReceipt> {
        tauri::async_runtime::block_on(self.append_json(kind, payload))
    }

    pub async fn append_json(
        &self,
        kind: &str,
        payload: &Value,
    ) -> anyhow::Result<ActionLogReceipt> {
        let json = serde_json::to_string(payload).context("serialize action log payload")?;
        let entry = ActionLogEntry {
            ts: Utc::now().timestamp_millis(),
            kind: Cow::Owned(kind.to_owned()),
            payload_json: Cow::Owned(json),
        };
        self.append(entry).await
    }

    pub fn append_blocking(&self, entry: ActionLogEntry<'_>) -> anyhow::Result<ActionLogReceipt> {
        tauri::async_runtime::block_on(self.append(entry))
    }

    pub async fn append(&self, entry: ActionLogEntry<'_>) -> anyhow::Result<ActionLogReceipt> {
        let entry_owned = ActionLogEntry {
            ts: entry.ts,
            kind: Cow::Owned(entry.kind.into_owned()),
            payload_json: Cow::Owned(entry.payload_json.into_owned()),
        };
        let (reply_tx, reply_rx) = oneshot::channel();

        match self.tx.try_send(ActionLogCommand::Append {
            entry: entry_owned,
            reply: reply_tx,
        }) {
            Ok(()) => {}
            Err(TrySendError::Full(cmd)) => {
                // WHY: Record when writers encounter backpressure so operators can alert before logs stall.
                self.metrics
                    .backpressure_events
                    .fetch_add(1, Ordering::Relaxed);
                match timeout(
                    Duration::from_millis(ACTION_LOG_SEND_TIMEOUT_MS),
                    self.tx.send(cmd),
                )
                .await
                {
                    Ok(Ok(())) => {}
                    Ok(Err(err)) => {
                        self.metrics
                            .enqueue_failures
                            .fetch_add(1, Ordering::Relaxed);
                        self.metrics.dropped_appends.fetch_add(1, Ordering::Relaxed);
                        anyhow::bail!(
                            "E-UICP-0601: action log channel closed while flushing backlog: {err}"
                        );
                    }
                    Err(_) => {
                        self.metrics.dropped_appends.fetch_add(1, Ordering::Relaxed);
                        anyhow::bail!(
                            "E-UICP-0604: action log channel saturated after {ACTION_LOG_SEND_TIMEOUT_MS}ms backpressure window"
                        );
                    }
                }
            }
            Err(TrySendError::Closed(_cmd)) => {
                self.metrics
                    .enqueue_failures
                    .fetch_add(1, Ordering::Relaxed);
                self.metrics.dropped_appends.fetch_add(1, Ordering::Relaxed);
                anyhow::bail!("E-UICP-0602: action log worker not available");
            }
        }

        match reply_rx.await {
            Ok(result) => result,
            Err(err) => {
                self.metrics.reply_failures.fetch_add(1, Ordering::Relaxed);
                Err(anyhow!(
                    "E-UICP-0603: action log worker dropped reply: {err}"
                ))
            }
        }
    }
}

fn worker_loop(
    conn: &mut Connection,
    signing_key: Option<&SigningKey>,
    rng: &mut OsRng,
    rx: &mut mpsc::Receiver<ActionLogCommand>,
    metrics: Arc<ActionLogMetrics>,
) -> anyhow::Result<()> {
    while let Some(cmd) = rx.blocking_recv() {
        match cmd {
            ActionLogCommand::Append { entry, reply } => {
                let result = append_entry(conn, signing_key, rng, entry);
                if reply.send(result).is_err() {
                    metrics.reply_failures.fetch_add(1, Ordering::Relaxed);
                }
            }
            #[cfg(test)]
            ActionLogCommand::Shutdown => {
                break;
            }
        }
    }
    Ok(())
}

fn append_entry(
    conn: &mut Connection,
    signing_key: Option<&SigningKey>,
    rng: &mut OsRng,
    entry: ActionLogEntry<'static>,
) -> anyhow::Result<ActionLogReceipt> {
    let tx = conn.transaction().context("start action log transaction")?;
    let prev_hash: Option<Vec<u8>> = tx
        .query_row(
            "SELECT hash FROM action_log ORDER BY id DESC LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .context("read action log prev hash")?;

    let mut nonce = [0u8; 32];
    rng.fill_bytes(&mut nonce);

    let hash = compute_hash(
        prev_hash.as_deref(),
        entry.ts,
        entry.kind.as_ref(),
        entry.payload_json.as_ref(),
        &nonce,
    );

    let sig_bytes = signing_key.map(|key| key.sign(&hash).to_bytes().to_vec());

    tx.execute(
        "INSERT INTO action_log (ts, kind, payload_json, prev_hash, hash, nonce, sig)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            entry.ts,
            entry.kind.as_ref(),
            entry.payload_json.as_ref(),
            prev_hash.as_ref(),
            &hash[..],
            &nonce[..],
            sig_bytes.as_ref()
        ],
    )
    .context("insert action log entry")?;
    let id = tx.last_insert_rowid();
    tx.commit().context("commit action log transaction")?;

    Ok(ActionLogReceipt {
        id,
        hash,
        prev_hash: prev_hash.as_ref().map(|v| {
            let mut array = [0u8; 32];
            array.copy_from_slice(v.as_slice());
            array
        }),
    })
}

pub fn ensure_action_log_schema(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS action_log (
            id INTEGER PRIMARY KEY,
            ts INTEGER NOT NULL,
            kind TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            prev_hash BLOB,
            hash BLOB NOT NULL,
            nonce BLOB NOT NULL,
            sig BLOB
        );
        CREATE INDEX IF NOT EXISTS action_log_hash ON action_log(hash);
        "#,
    )
    .context("ensure action_log schema")?;
    Ok(())
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn verify_chain(
    db_path: &Path,
    expected_pubkey: Option<VerifyingKey>,
) -> anyhow::Result<ActionLogVerifyReport> {
    let conn = Connection::open(db_path)
        .with_context(|| format!("open sqlite for verify {:?}", db_path))?;
    conn.busy_timeout(Duration::from_millis(5_000))
        .context("sqlite busy timeout (verify)")?;

    let mut stmt = conn
        .prepare(
            "SELECT id, ts, kind, payload_json, prev_hash, hash, nonce, sig
             FROM action_log ORDER BY id ASC",
        )
        .context("prepare action_log scan")?;
    let mut rows = stmt.query([]).context("query action_log")?;

    let mut entries = 0usize;
    let mut first_id: Option<i64> = None;
    let mut last_id: Option<i64> = None;
    let mut last_hash: Option<[u8; 32]> = None;

    while let Some(row) = rows.next().context("scan action_log rows")? {
        let id: i64 = row.get(0)?;
        let ts: i64 = row.get(1)?;
        let kind: String = row.get(2)?;
        let payload_json: String = row.get(3)?;
        let prev_hash: Option<Vec<u8>> = row.get(4)?;
        let hash: Vec<u8> = row.get(5)?;
        let nonce: Vec<u8> = row.get(6)?;
        let sig: Option<Vec<u8>> = row.get(7)?;

        if hash.len() != 32 {
            anyhow::bail!("E-UICP-0620: hash length invalid for action_log id {}", id);
        }
        if nonce.len() != 32 {
            anyhow::bail!("E-UICP-0621: nonce length invalid for action_log id {}", id);
        }
        if let Some(prev) = prev_hash.as_ref() {
            if prev.len() != 32 {
                anyhow::bail!(
                    "E-UICP-0622: prev_hash length invalid for action_log id {}",
                    id
                );
            }
            if let Some(expected_prev) = last_hash.as_ref() {
                if prev.as_slice() != expected_prev {
                    anyhow::bail!("E-UICP-0623: prev_hash mismatch at action_log id {}", id);
                }
            } else {
                anyhow::bail!("E-UICP-0624: non-genesis entry missing previous hash context");
            }
        } else if last_hash.is_some() {
            anyhow::bail!(
                "E-UICP-0625: prev_hash missing for non-genesis action_log id {}",
                id
            );
        }

        let computed = compute_hash(
            prev_hash.as_deref(),
            ts,
            &kind,
            &payload_json,
            nonce.as_slice(),
        );
        if computed.as_slice() != hash.as_slice() {
            anyhow::bail!("E-UICP-0626: hash mismatch for action_log id {}", id);
        }

        if let Some(ref key) = expected_pubkey {
            let sig_bytes = sig
                .as_ref()
                .context("E-UICP-0627: missing signature while verifying chain")?;
            if sig_bytes.len() != ed25519_dalek::SIGNATURE_LENGTH {
                anyhow::bail!(
                    "E-UICP-0628: signature length invalid for action_log id {}",
                    id
                );
            }
            let sig_arr: [u8; ed25519_dalek::SIGNATURE_LENGTH] =
                sig_bytes.as_slice().try_into().map_err(|_| {
                    anyhow::anyhow!(
                        "E-UICP-0629: signature parse failed for action_log id {}",
                        id
                    )
                })?;
            let signature = Signature::from_bytes(&sig_arr);
            key.verify_strict(hash.as_slice(), &signature)
                .with_context(|| format!("E-UICP-0630: signature verify failed at id {}", id))?;
        }

        if first_id.is_none() {
            first_id = Some(id);
        }
        entries += 1;
        last_id = Some(id);
        let mut hash_arr = [0u8; 32];
        hash_arr.copy_from_slice(hash.as_slice());
        last_hash = Some(hash_arr);
    }

    Ok(ActionLogVerifyReport {
        entries,
        first_id,
        last_id,
        last_hash,
    })
}

fn ensure_parent_dir(path: &Path) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("E-UICP-0631: create action log parent dir {:?}", parent))?;
    }
    Ok(())
}

fn load_signing_seed() -> anyhow::Result<Option<[u8; 32]>> {
    if let Ok(raw) = std::env::var(ENV_SIGNING_SEED) {
        return parse_seed(&raw).with_context(|| format!("parse {}", ENV_SIGNING_SEED));
    }
    if let Ok(raw) = std::env::var(ENV_SIGNING_SEED_FALLBACK) {
        return parse_seed(&raw).with_context(|| format!("parse {}", ENV_SIGNING_SEED_FALLBACK));
    }
    Ok(None)
}

pub fn parse_seed(raw: &str) -> anyhow::Result<Option<[u8; 32]>> {
    if raw.trim().is_empty() {
        return Ok(None);
    }
    let decoded = BASE64_ENGINE
        .decode(raw)
        .or_else(|_| hex::decode(raw).context("decode seed hex"))?;
    if decoded.len() != 32 {
        anyhow::bail!("seed must be 32 bytes");
    }
    let mut array = [0u8; 32];
    array.copy_from_slice(&decoded);
    Ok(Some(array))
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn parse_pubkey(raw: &str) -> anyhow::Result<VerifyingKey> {
    let decoded = BASE64_ENGINE
        .decode(raw)
        .or_else(|_| hex::decode(raw).context("decode pubkey hex"))?;
    let bytes: [u8; 32] = decoded
        .as_slice()
        .try_into()
        .map_err(|_| anyhow::anyhow!("E-UICP-0632: pubkey must decode to 32 bytes (Ed25519)"))?;
    VerifyingKey::from_bytes(&bytes).context("parse verifying key")
}

fn compute_hash(
    prev_hash: Option<&[u8]>,
    ts: i64,
    kind: &str,
    payload_json: &str,
    nonce: &[u8],
) -> [u8; 32] {
    // WHY: Domain-separate action log hashing and length-prefix components to avoid ambiguity.
    let mut hasher = Hasher::new();
    hasher.update(HASH_DOMAIN);
    match prev_hash {
        Some(prev) => {
            hasher.update(&[1u8]);
            update_len_prefixed(&mut hasher, prev);
        }
        None => {
            hasher.update(&[0u8]);
        }
    }
    hasher.update(&ts.to_le_bytes());
    update_len_prefixed(&mut hasher, kind.as_bytes());
    update_len_prefixed(&mut hasher, payload_json.as_bytes());
    update_len_prefixed(&mut hasher, nonce);
    hasher.finalize().into()
}

fn update_len_prefixed(hasher: &mut Hasher, bytes: &[u8]) {
    let len = (bytes.len() as u64).to_le_bytes();
    hasher.update(&len);
    hasher.update(bytes);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tempfile::tempdir;
    use tokio::{sync::Barrier, task::JoinSet};

    #[test]
    fn blocking_append_and_verify_chain() -> anyhow::Result<()> {
        let dir = tempdir()?;
        let db_path = dir.path().join("test.db");
        let seed = [7u8; 32];
        let handle = ActionLogService::start_with_seed(&db_path, Some(seed))?;

        let first =
            handle.append_json_blocking("test.event", &serde_json::json!({"msg": "first"}))?;
        let second =
            handle.append_json_blocking("test.event", &serde_json::json!({"msg": "second"}))?;

        assert_ne!(first.id, second.id);
        assert_ne!(first.hash, second.hash);
        assert_eq!(
            second.prev_hash.expect("prev hash"),
            first.hash,
            "INVARIANT: chain links to previous hash"
        );

        let signing = SigningKey::from_bytes(&seed);
        let report = verify_chain(&db_path, Some(signing.verifying_key()))?;
        assert_eq!(report.entries, 2);
        assert!(report.last_id.is_some());
        assert!(report.last_hash.is_some());
        assert_eq!(report.first_id, Some(1));

        let vk_b64 = BASE64_ENGINE.encode(signing.verifying_key().to_bytes());
        let parsed = parse_pubkey(&vk_b64)?;
        assert_eq!(parsed.to_bytes(), signing.verifying_key().to_bytes());

        Ok(())
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn append_and_verify_chain_async() -> anyhow::Result<()> {
        let dir = tempdir()?;
        let db_path = dir.path().join("test-async.db");
        let seed = [5u8; 32];
        let handle = ActionLogService::start_with_seed(&db_path, Some(seed))?;

        let first = handle
            .append_json("test.event", &serde_json::json!({"msg": "first"}))
            .await?;
        let second = handle
            .append_json("test.event", &serde_json::json!({"msg": "second"}))
            .await?;

        assert_eq!(
            second.prev_hash.expect("prev hash"),
            first.hash,
            "INVARIANT: chain links to previous hash"
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn records_backpressure_when_queue_starves() -> anyhow::Result<()> {
        let dir = tempdir()?;
        let db_path = dir.path().join("test-backpressure.db");
        let seed = [9u8; 32];
        let handle = ActionLogService::start_with_seed(&db_path, Some(seed))?;

        // WHY: Barrier forces all tasks to enqueue concurrently, increasing pressure on the bounded queue.
        let concurrency = 64usize;
        let barrier = Arc::new(Barrier::new(concurrency + 1));
        let mut join_set: JoinSet<anyhow::Result<_>> = JoinSet::new();
        for idx in 0..concurrency {
            let handle = handle.clone();
            let barrier = barrier.clone();
            let payload = serde_json::json!({
                "msg": format!("burst-{idx}"),
                // WHY: Inflate payload so sqlite work is non-trivial, keeping the worker busy.
                "blob": "x".repeat(8 * 1024),
            });
            join_set.spawn(async move {
                barrier.wait().await;
                handle.append_json("test.burst", &payload).await
            });
        }

        barrier.wait().await;
        while let Some(outcome) = join_set.join_next().await {
            outcome??;
        }

        let stats = handle.stats_snapshot();
        assert!(
            stats.backpressure_events > 0,
            "expected at least one backpressure event, stats={stats:?}"
        );
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn increments_drop_counter_when_channel_closed() -> anyhow::Result<()> {
        let dir = tempdir()?;
        let db_path = dir.path().join("test-drop.db");
        let seed = [3u8; 32];
        let handle = ActionLogService::start_with_seed(&db_path, Some(seed))?;

        handle.close_channel_for_test().await;
        let result = handle
            .append_json("test.event", &serde_json::json!({ "msg": "drop-me" }))
            .await;
        assert!(result.is_err(), "append should fail after channel close");

        let stats = handle.stats_snapshot();
        assert_eq!(stats.enqueue_failures, 1);
        assert_eq!(stats.dropped_appends, 1);
        Ok(())
    }
}
