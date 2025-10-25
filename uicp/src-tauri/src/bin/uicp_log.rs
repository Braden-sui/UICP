use std::{env, path::PathBuf, process::ExitCode};

use anyhow::{anyhow, Context, Result};
use uicp::{parse_pubkey, verify_chain, ActionLogVerifyReport, DATA_DIR};

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            tracing::error!("uicp-log: {err:?}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<()> {
    let mut args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        print_usage();
        return Err(anyhow!("E-UICP-0640: missing command"));
    }
    let cmd = args.remove(0);
    match cmd.as_str() {
        "verify" => verify_cmd(&args),
        "--help" | "-h" => {
            print_usage();
            Ok(())
        }
        other => Err(anyhow!("E-UICP-0641: unknown command '{other}'")),
    }
}

fn verify_cmd(args: &[String]) -> Result<()> {
    let mut db_path: Option<PathBuf> = None;
    let mut pubkey_raw: Option<String> = None;
    let mut idx = 0usize;
    while idx < args.len() {
        match args[idx].as_str() {
            "--db" => {
                idx += 1;
                let path = args
                    .get(idx)
                    .context("E-UICP-0642: --db expects a file path")?;
                db_path = Some(PathBuf::from(path));
            }
            "--pubkey" => {
                idx += 1;
                let raw = args
                    .get(idx)
                    .context("E-UICP-0643: --pubkey expects a base64 or hex key")?;
                pubkey_raw = Some(raw.clone());
            }
            flag => {
                return Err(anyhow!(
                    "E-UICP-0644: unexpected flag '{flag}' for verify command"
                ));
            }
        }
        idx += 1;
    }

    let db_path = db_path.unwrap_or_else(|| DATA_DIR.join("data.db"));
    let pubkey_source = pubkey_raw.or_else(|| env::var("UICP_ACTION_LOG_PUBKEY").ok());
    let verifying_key = match pubkey_source {
        Some(raw) => {
            Some(parse_pubkey(&raw).context("E-UICP-0645: failed to parse verifying key")?)
        }
        None => None,
    };
    let sig_checked = verifying_key.is_some();

    let report = verify_chain(&db_path, verifying_key)
        .with_context(|| format!("E-UICP-0646: verify failed for {:?}", db_path))?;
    emit_report(report, sig_checked);
    Ok(())
}

fn emit_report(report: ActionLogVerifyReport, sig_checked: bool) {
    let last_hash_hex = report
        .last_hash
        .map(|h| hex::encode(h))
        .unwrap_or_else(|| "none".into());
    println!("action-log: entries={}", report.entries);
    println!("last-id: {:?}", report.last_id);
    println!("last-hash: {last_hash_hex}");
    println!(
        "signatures: {}",
        if sig_checked { "verified" } else { "skipped" }
    );
}

fn print_usage() {
    tracing::warn!("Usage:");
    tracing::warn!("  uicp-log verify [--db path/to/data.db] [--pubkey HEX_OR_B64]");
    tracing::warn!("  uicp-log --help");
}
