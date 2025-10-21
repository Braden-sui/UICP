use std::process::Stdio;

use serde::Serialize;
use tokio::process::Command;

use serde_json::Value;

const ERR_PROVIDER_INVALID: &str = "E-UICP-1500";
const ERR_PROVIDER_SPAWN: &str = "E-UICP-1501";

#[derive(Debug, Clone, Serialize)]
pub struct ProviderLoginResult {
    pub ok: bool,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderHealthResult {
    pub ok: bool,
    pub version: Option<String>,
    pub detail: Option<String>,
}

pub async fn login(provider: &str) -> Result<ProviderLoginResult, String> {
    match provider {
        "codex" => run_login("codex", &["login"], &[]).await,
        "claude" => run_login("claude", &["login"], &[("CLAUDE_HEADLESS", "1")]).await,
        other => Err(format!(
            "{ERR_PROVIDER_INVALID}: unsupported provider '{other}'"
        )),
    }
}

pub async fn health(provider: &str) -> Result<ProviderHealthResult, String> {
    match provider {
        "codex" => codex_health().await,
        "claude" => claude_health().await,
        other => Err(format!(
            "{ERR_PROVIDER_INVALID}: unsupported provider '{other}'"
        )),
    }
}

async fn run_login(
    program: &str,
    args: &[&str],
    extra_env: &[(&str, &str)],
) -> Result<ProviderLoginResult, String> {
    let output = run_command(program, args, extra_env)
        .await
        .map_err(|err| format!("{ERR_PROVIDER_SPAWN}: {err}"))?;
    let ok = output.status.success();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let detail = merge_streams(&stdout, &stderr);
    Ok(ProviderLoginResult {
        ok,
        detail: detail.filter(|d| !d.trim().is_empty()),
    })
}

async fn codex_health() -> Result<ProviderHealthResult, String> {
    let output = run_command("codex", &["--version"], &[])
        .await
        .map_err(|err| format!("{ERR_PROVIDER_SPAWN}: {err}"))?;
    let ok = output.status.success();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let version = if ok && !stdout.is_empty() {
        Some(
            stdout
                .lines()
                .next()
                .map(|line| line.trim().to_string())
                .unwrap_or(stdout.clone()),
        )
    } else {
        None
    };
    let detail = if ok {
        merge_streams(
            if version.as_ref().map(|v| v.as_str()) == stdout.lines().next().map(|line| line.trim())
            {
                ""
            } else {
                &stdout
            },
            &stderr,
        )
    } else {
        merge_streams(&stdout, &stderr)
    };
    Ok(ProviderHealthResult {
        ok,
        version,
        detail,
    })
}

async fn claude_health() -> Result<ProviderHealthResult, String> {
    let output = run_command(
        "claude",
        &["-p", "ping", "--output-format", "json"],
        &[("CLAUDE_HEADLESS", "1")],
    )
    .await
    .map_err(|err| format!("{ERR_PROVIDER_SPAWN}: {err}"))?;
    let ok = output.status.success();
    let stdout_raw = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let aggregated = extract_claude_text(stdout_raw.as_ref());
    let fallback_stdout = stdout_raw.trim();
    let detail = if aggregated
        .as_ref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
    {
        aggregated
    } else if !stderr.is_empty() {
        Some(stderr)
    } else if !fallback_stdout.is_empty() {
        Some(fallback_stdout.to_string())
    } else {
        None
    };
    Ok(ProviderHealthResult {
        ok,
        version: None,
        detail,
    })
}

fn merge_streams(stdout: &str, stderr: &str) -> Option<String> {
    match (stdout.trim(), stderr.trim()) {
        ("", "") => None,
        (out, "") => Some(out.to_string()),
        ("", err) => Some(err.to_string()),
        (out, err) => Some(format!("{out}\n{err}")),
    }
}

fn extract_claude_text(stdout: &str) -> Option<String> {
    let mut aggregated = String::new();
    for raw_line in stdout.lines() {
        let line = raw_line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(line) {
            if obj.get("type").and_then(|value| value.as_str()) == Some("content_block_delta")
                && obj
                    .get("delta")
                    .and_then(|delta| delta.get("type"))
                    .and_then(|value| value.as_str())
                    == Some("text_delta")
            {
                if let Some(text) = obj
                    .get("delta")
                    .and_then(|delta| delta.get("text"))
                    .and_then(|value| value.as_str())
                {
                    aggregated.push_str(text);
                }
            }
        }
    }
    if aggregated.trim().is_empty() {
        None
    } else {
        Some(aggregated)
    }
}

async fn run_command(
    program: &str,
    args: &[&str],
    extra_env: &[(&str, &str)],
) -> Result<std::process::Output, std::io::Error> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    cmd.stdin(Stdio::inherit());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    for (key, value) in extra_env {
        cmd.env(key, value);
    }
    cmd.output().await
}
