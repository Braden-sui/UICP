#![cfg(feature = "compute_harness")]

use std::{env, path::PathBuf};

use anyhow::{bail, Context, Result};
use serde_json::Value;
use tokio::io::{self, AsyncBufReadExt, BufReader};
use tokio::select;

use uicp::test_support::ComputeTestHarness;
use uicp::ComputeJobSpec;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let mut args = env::args().skip(1);
    let Some(cmd) = args.next() else {
        bail!("missing command (expected 'run')");
    };

    match cmd.as_str() {
        "run" => run_command(args).await?,
        other => bail!("unknown command: {other}"),
    }

    Ok(())
}

async fn run_command(mut args: impl Iterator<Item = String>) -> Result<()> {
    let mut data_dir: Option<PathBuf> = None;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--data-dir" => {
                let path = args.next().context("--data-dir requires a value")?;
                data_dir = Some(PathBuf::from(path));
            }
            flag => bail!("unknown flag for run command: {flag}"),
        }
    }

    let harness = match data_dir {
        Some(path) => ComputeTestHarness::with_data_dir_async(path).await?,
        None => ComputeTestHarness::new_async().await?,
    };

    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin).lines();

    let job_line = reader
        .next_line()
        .await
        .context("read job spec")?
        .context("missing job spec JSON on stdin")?;

    let spec: ComputeJobSpec = serde_json::from_str(&job_line).context("parse job spec JSON")?;
    let job_id = spec.job_id.clone();

    let mut run_future = std::pin::Pin::from(Box::new(harness.run_job(spec)));

    let final_event: Value = loop {
        select! {
            res = &mut run_future => {
                let value = res?;
                break value;
            }
            maybe_line = reader.next_line() => {
                match maybe_line.context("read control line")? {
                    Some(line) if line.trim().eq_ignore_ascii_case("cancel") => {
                        harness
                            .cancel_job(&job_id)
                            .await
                            .context("cancel job")?;
                    }
                    Some(_) => {}
                    None => {}
                }
            }
        }
    };

    println!("{}", serde_json::to_string(&final_event)?);

    Ok(())
}
