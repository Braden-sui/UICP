use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Serialize;
use tokio::process::Command;

use serde_json::Value;

const ERR_PROVIDER_INVALID: &str = "E-UICP-1500";
const ERR_PROGRAM_NOT_FOUND: &str = "E-UICP-1501"; // ProgramNotFound
const ERR_NOT_AUTHENTICATED: &str = "E-UICP-1502"; // NotAuthenticated
const ERR_KEYCHAIN_LOCKED: &str = "E-UICP-1503"; // KeychainLocked (macOS)
const ERR_NETWORK_DENIED: &str = "E-UICP-1504"; // NetworkDenied (jail)
const ERR_VERSION_MISMATCH: &str = "E-UICP-1505"; // VersionMismatch
const ERR_TIMEOUT: &str = "E-UICP-1506"; // Timeout
const ERR_SPAWN: &str = "E-UICP-1507"; // Spawn/exec failure

#[derive(Debug, Clone, Serialize)]
pub struct ProviderLoginResult {
    pub ok: bool,
    pub detail: Option<String>,
    pub code: Option<String>,
    pub search_paths: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderHealthResult {
    pub ok: bool,
    pub version: Option<String>,
    pub detail: Option<String>,
    pub code: Option<String>,
    pub search_paths: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderResolveResult {
    pub exe: String,
    pub via: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderInstallResult {
    pub ok: bool,
    pub provider: String,
    pub exe: Option<String>,
    pub via: Option<String>,
    pub detail: Option<String>,
}

pub async fn login(provider: &str) -> Result<ProviderLoginResult, String> {
    match provider {
        "codex" => run_login_with_resolve("codex", provider, &["login"], &[]).await,
        // For login, do NOT force headless so the CLI can open a browser/device flow.
        "claude" => run_login_with_resolve("claude", provider, &["login"], &[]).await,
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

pub fn resolve(provider: &str) -> Result<ProviderResolveResult, String> {
    let (exe, via) = resolve_provider_exe_with_source(provider, provider_program(provider));
    Ok(ProviderResolveResult { exe, via })
}

pub async fn install(provider: &str, version: Option<&str>) -> Result<ProviderInstallResult, String> {
    match provider {
        "codex" => install_via_npm("@openai/codex", version).await,
        "claude" => {
            // For licensing reasons we do not download or redistribute Claude Code ourselves.
            // Offer guidance to install via npm into the managed prefix, then login via our existing flow.
            Err("E-UICP-1502: proprietary CLI; install via npm or vendor installer, then use Connect".into())
        }
        other => Err(format!("{ERR_PROVIDER_INVALID}: unsupported provider '{other}'")),
    }
}

async fn install_via_npm(pkg: &str, version: Option<&str>) -> Result<ProviderInstallResult, String> {
    let npm = resolve_provider_exe_with_source("npm", "npm").0;
    // Determine managed prefix (one directory above /bin)
    let prefix = managed_prefix_dir().ok_or_else(|| "Failed to resolve managed prefix".to_string())?;
    let _ = std::fs::create_dir_all(&prefix).map_err(|e| format!("create prefix dir failed: {e}"))?;

    let spec = if let Some(v) = version { format!("{pkg}@{v}") } else { pkg.to_string() };
    let args = [
        "i",
        "-g",
        "--prefix",
        prefix.to_string_lossy().as_ref(),
        &spec,
    ];
    let output = run_command(&npm, &args, &[])
        .await
        .map_err(|e| format!("{ERR_SPAWN}: npm install failed: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("npm install failed: {}", stderr.trim()));
    }
    // After install, resolve the provider exe from managed bin
    // The installed binary name equals the pkg CLI name for our providers
    let tool = if pkg.contains("codex") { "codex" } else { pkg };
    let (exe, via) = resolve_provider_exe_with_source(tool, tool);
    Ok(ProviderInstallResult { ok: true, provider: tool.into(), exe: Some(exe), via: Some(via), detail: None })
}

fn managed_prefix_dir() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        if let Ok(appdata) = std::env::var("APPDATA") {
            // managed_bin_base() returns %APPDATA%/UICP/bin; npm --prefix expects parent directory
            return Some(PathBuf::from(appdata).join("UICP"));
        }
        None
    } else if cfg!(target_os = "macos") {
        let home = std::env::var_os("HOME").map(PathBuf::from)?;
        Some(home.join("Library").join("Application Support").join("UICP"))
    } else {
        let home = std::env::var_os("HOME").map(PathBuf::from)?;
        Some(home.join(".local").join("share").join("UICP"))
    }
}

async fn run_login_with_resolve(
    program: &str,
    provider_key: &str,
    args: &[&str],
    extra_env: &[(&str, &str)],
) -> Result<ProviderLoginResult, String> {
    let exe = resolve_provider_exe(provider_key, program);
    let (program_final, args_final) = maybe_wrap_with_httpjail_login(provider_key, &exe, args);
    let output = match run_command_timeout(&program_final, args_final.as_slice(), extra_env, Some(180_000)).await {
        Ok(o) => o,
        Err(e) => {
            let (msg, code, paths) = format_spawn_error(provider_key, &program_final, e);
            return Ok(ProviderLoginResult { ok: false, detail: Some(msg), code: Some(code), search_paths: Some(paths) });
        }
    };
    let ok = output.status.success();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let mut detail = merge_streams(&stdout, &stderr);
    let mut code: Option<String> = None;
    if let Some(d) = detail.as_ref() {
        let lower = d.to_ascii_lowercase();
        if provider_key == "claude" {
            if lower.contains("missing api key") || lower.contains("run /login") || lower.contains("not authenticated") {
                let hint = "Tip: On macOS, unlock the login keychain or run the CLI login in a local (non-SSH) session: security unlock-keychain ~/Library/Keychains/login.keychain-db, then run 'claude login'.";
                detail = Some(format!("{d}\n{hint}"));
                code = Some(ERR_NOT_AUTHENTICATED.to_string());
            }
            if lower.contains("keychain") || lower.contains("errsec") {
                let hint = "Tip: On macOS, unlock the login keychain or run the CLI login in a local (non-SSH) session: security unlock-keychain ~/Library/Keychains/login.keychain-db, then run 'claude login'.";
                detail = Some(format!("{d}\n{hint}"));
                code = Some(ERR_KEYCHAIN_LOCKED.to_string());
            }
        }
        if lower.contains("httpjail") || lower.contains("denied by policy") || lower.contains("not allowed") || lower.contains("blocked") {
            if code.is_none() { code = Some(ERR_NETWORK_DENIED.to_string()); }
        }
    }
    Ok(ProviderLoginResult {
        ok,
        detail: detail.filter(|d| !d.trim().is_empty()),
        code,
        search_paths: None,
    })
}

// Wrap login with httpjail using broader login allowlist when requested.
fn maybe_wrap_with_httpjail_login<'a>(
    provider: &str,
    base_program: &str,
    base_args: &'a [&'a str],
) -> (String, Vec<&'a str>) {
    if !httpjail_requested_env() {
        return (base_program.to_string(), base_args.to_vec());
    }
    let httpjail = match find_httpjail_binary() {
        Ok(p) => p,
        Err(_) => return (base_program.to_string(), base_args.to_vec()),
    };
    let policy_key = match provider {
        "claude" => "claude-login",
        "codex" => "codex-login",
        other => other,
    };
    match load_httpjail_predicate(policy_key) {
        Ok(pred) => {
            let mut out: Vec<&'a str> = Vec::with_capacity(base_args.len() + 4);
            // SAFETY: pred is an owned String; httpjail expects a JS predicate argument.
            // We must keep a copy alive; since we return Vec<&str>, we cannot push pred here by ref.
            // Instead, return a Vec<String> at the call site.
            drop(pred);
        }
        Err(_) => {
            return (base_program.to_string(), base_args.to_vec());
        }
    }
    // Build owned Vec<String> so we can include the predicate string
    let pred = match load_httpjail_predicate(policy_key) { Ok(s) => s, Err(_) => String::new() };
    if pred.is_empty() {
        return (base_program.to_string(), base_args.to_vec());
    }
    let mut args_owned: Vec<String> = Vec::with_capacity(base_args.len() + 4);
    args_owned.push("--js".into());
    args_owned.push(pred);
    args_owned.push("--".into());
    args_owned.push(base_program.to_string());
    for a in base_args { args_owned.push((*a).to_string()); }
    // Convert back to Vec<&str> expected by run_command wrapper
    let args_refs: Vec<&str> = args_owned.iter().map(|s| s.as_str()).collect();
    (httpjail, args_refs)
}

fn find_httpjail_binary() -> Result<String, String> {
    let path_var = std::env::var_os("PATH").ok_or_else(|| "PATH not set".to_string())?;
    for dir in std::env::split_paths(&path_var) {
        if dir.as_os_str().is_empty() { continue; }
        let cand = dir.join(if cfg!(windows) { "httpjail.exe" } else { "httpjail" });
        if cand.is_file() { return Ok(cand.to_string_lossy().into_owned()); }
    }
    Err("httpjail binary not found on PATH".into())
}

fn httpjail_policy_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("ops")
        .join("code")
        .join("network")
        .join("allowlist.json")
}

fn load_httpjail_predicate(provider_key: &str) -> Result<String, String> {
    use std::fs;
    let policy_path = httpjail_policy_path();
    let content = fs::read_to_string(&policy_path)
        .map_err(|e| format!("failed to read {}: {e}", policy_path.display()))?;
    let json: Value = serde_json::from_str(&content)
        .map_err(|e| format!("failed to parse {}: {e}", policy_path.display()))?;
    let entry = json.get("providers")
        .and_then(|p| p.get(provider_key))
        .ok_or_else(|| format!("provider '{provider_key}' not present in {}", policy_path.display()))?;
    let hosts = entry.get("hosts").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut hosts_norm: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for h in hosts.into_iter().filter_map(|v| v.as_str().map(|s| s.to_string())) {
        let t = h.trim().to_ascii_lowercase();
        if !t.is_empty() && seen.insert(t.clone()) { hosts_norm.push(t); }
    }
    let methods = entry.get("methods").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let mut methods_norm: Vec<String> = Vec::new();
    let mut seen_m = std::collections::HashSet::new();
    for m in methods.into_iter().filter_map(|v| v.as_str().map(|s| s.to_string())) {
        let u = m.trim().to_ascii_uppercase();
        if !u.is_empty() && seen_m.insert(u.clone()) { methods_norm.push(u); }
    }
    let block_post = entry.get("block_post").or_else(|| entry.get("blockPost")).and_then(|v| v.as_bool()).unwrap_or(false);
    Ok(build_httpjail_predicate(&hosts_norm, &methods_norm, block_post))
}

fn build_httpjail_predicate(hosts: &[String], methods: &[String], block_post: bool) -> String {
    let hosts_json = serde_json::to_string(hosts).unwrap_or_else(|_| "[]".into());
    let methods_json = serde_json::to_string(methods).unwrap_or_else(|_| "[]".into());
    let block_literal = if block_post { "true" } else { "false" };
    let mut predicate = String::from("(()=>{");
    predicate.push_str(&format!("const hosts={hosts_json};"));
    predicate.push_str(&format!("const methods={methods_json};"));
    predicate.push_str(&format!("const blockPost={block_literal};"));
    predicate.push_str("const reqHost=(r.host||\"\").toLowerCase();");
    predicate.push_str("const reqMethod=(r.method||\"\").toUpperCase();");
    predicate.push_str("const hostAllowed=hosts.length===0||hosts.some((pattern)=>{ if(pattern===\"*\") return true; if(pattern.startsWith(\"*.\")){ const suffix=pattern.slice(1); const bare=pattern.slice(2); if(bare && reqHost===bare) return true; return reqHost.endsWith(suffix);} return reqHost===pattern;});");
    predicate.push_str("if(!hostAllowed) return false;");
    predicate.push_str("if(blockPost && reqMethod===\"POST\") return false;");
    predicate.push_str("if(methods.length && !methods.includes(reqMethod)) return false;");
    predicate.push_str("return true;})()");
    predicate
}

async fn codex_health() -> Result<ProviderHealthResult, String> {
    let exe = resolve_provider_exe("codex", provider_program("codex"));
    let output = match run_command_timeout(&exe, &["--version"], &[], Some(15_000)).await {
        Ok(o) => o,
        Err(e) => {
            let (msg, code, paths) = format_spawn_error("codex", &exe, e);
            return Ok(ProviderHealthResult { ok: false, version: None, detail: Some(msg), code: Some(code), search_paths: if paths.is_empty() { None } else { Some(paths) } });
        }
    };
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
        code: None,
        search_paths: None,
    })
}

async fn claude_health() -> Result<ProviderHealthResult, String> {
    let exe = resolve_provider_exe("claude", provider_program("claude"));
    let output = match run_command_timeout(&exe, &["-p", "ping", "--output-format", "json"], &[("CLAUDE_HEADLESS", "1")], Some(15_000)).await {
        Ok(o) => o,
        Err(e) => {
            let (msg, code, paths) = format_spawn_error("claude", &exe, e);
            return Ok(ProviderHealthResult { ok: false, version: None, detail: Some(msg), code: Some(code), search_paths: if paths.is_empty() { None } else { Some(paths) } });
        }
    };
    let ok = output.status.success();
    let stdout_raw = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let aggregated = extract_claude_text(stdout_raw.as_ref());
    let fallback_stdout = stdout_raw.trim();
    let mut detail = if aggregated
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
    let mut code: Option<String> = None;
    if provider_program("claude") == "claude" {
        if let Some(d) = detail.as_ref() {
            let lower = d.to_ascii_lowercase();
            if lower.contains("missing api key") || lower.contains("run /login") || lower.contains("not authenticated") {
                code = Some(ERR_NOT_AUTHENTICATED.to_string());
            }
            if lower.contains("keychain") || lower.contains("errsec") {
                code = Some(ERR_KEYCHAIN_LOCKED.to_string());
            }
            if code.is_some() {
                let hint = "Tip: On macOS, unlock the login keychain or run the CLI login in a local (non-SSH) session: security unlock-keychain ~/Library/Keychains/login.keychain-db, then run 'claude login'.";
                detail = detail.map(|d| format!("{d}\n{hint}"));
            }
        }
    }
    Ok(ProviderHealthResult {
        ok,
        version: None,
        detail,
        code,
        search_paths: None,
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

async fn run_command_timeout(
    program: &str,
    args: &[&str],
    extra_env: &[(&str, &str)],
    timeout_ms: Option<u64>,
) -> Result<std::process::Output, std::io::Error> {
    use tokio::time::{timeout, Duration};
    if let Some(ms) = timeout_ms {
        match timeout(Duration::from_millis(ms), run_command(program, args, extra_env)).await {
            Ok(res) => res,
            Err(_) => Err(std::io::Error::new(std::io::ErrorKind::TimedOut, format!("{ERR_TIMEOUT}: spawn timed out after {}ms", ms))),
        }
    } else {
        run_command(program, args, extra_env).await
    }
}

fn format_spawn_error(provider: &str, program: &str, err: std::io::Error) -> (String, String, Vec<String>) {
    use std::io::ErrorKind;
    if err.kind() == ErrorKind::TimedOut {
        return (format!("{ERR_TIMEOUT}: {provider} {program} timed out"), ERR_TIMEOUT.to_string(), Vec::new());
    }
    if err.kind() == ErrorKind::NotFound {
        // enumerate candidates we look for
        let mut paths: Vec<String> = Vec::new();
        for p in managed_install_candidates(program) { paths.push(p.to_string_lossy().into_owned()); }
        for p in common_install_candidates(program) { paths.push(p.to_string_lossy().into_owned()); }
        let msg = format!(
            "{ERR_PROGRAM_NOT_FOUND}: {program} not found. Searched: {}. Set {} or install the CLI.",
            if paths.is_empty() { "<none>".into() } else { paths.join(", ") },
            if provider == "claude" { "UICP_CLAUDE_PATH" } else { "UICP_CODEX_PATH" }
        );
        return (msg, ERR_PROGRAM_NOT_FOUND.to_string(), paths);
    }
    (format!("{ERR_PROGRAM_NOT_FOUND}: {err}"), ERR_PROGRAM_NOT_FOUND.to_string(), Vec::new())
}

fn httpjail_requested_env() -> bool {
    parse_env_flag(&std::env::var("UICP_HTTPJAIL").unwrap_or_default())
}

fn parse_env_flag(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn resolve_provider_exe(provider: &str, default_prog: &str) -> String {
    let (exe, _via) = resolve_provider_exe_with_source(provider, default_prog);
    exe
}

fn provider_program(provider: &str) -> &str {
    match provider {
        "claude" => "claude",
        "codex" => "codex",
        other => other,
    }
}

fn resolve_provider_exe_with_source(provider: &str, default_prog: &str) -> (String, String) {
    // 1) Env override
    let override_keys: &[&str] = match provider {
        "claude" => &["UICP_CLAUDE_PATH", "UICP_CLAUDE_BIN"],
        "codex" => &["UICP_CODEX_PATH", "UICP_CODEX_BIN"],
        _ => &[],
    };
    for key in override_keys {
        if let Ok(p) = std::env::var(key) {
            let p = p.trim();
            if !p.is_empty() {
                let path = PathBuf::from(p);
                if path.is_file() {
                    log_resolved(provider, &path, "env");
                    return (path.to_string_lossy().into_owned(), "env".to_string());
                }
            }
        }
    }

    // 2) PATH search (respect PATHEXT on Windows)
    if let Some(found) = search_in_path(default_prog) {
        log_resolved(provider, &found, "PATH");
        return (found.to_string_lossy().into_owned(), "PATH".to_string());
    }

    // 3) Common install locations
    for cand in common_install_candidates(default_prog) {
        if cand.is_file() {
            log_resolved(provider, &cand, "common");
            return (cand.to_string_lossy().into_owned(), "common".to_string());
        }
    }

    // 4) Fallback to the provided program name
    (default_prog.to_string(), "fallback".to_string())
}

fn log_resolved(provider: &str, path: &Path, source: &str) {
    if cfg!(debug_assertions) {
        #[cfg(feature = "otel_spans")]
        tracing::info!(
            target = "uicp",
            provider = provider,
            exe = %path.display(),
            source = source,
            os = %std::env::consts::OS,
            arch = %std::env::consts::ARCH,
            "provider executable resolved"
        );
        #[cfg(not(feature = "otel_spans"))]
        {
            eprintln!(
                "[uicp] provider {provider} executable resolved via {source}: {} (os={}, arch={})",
                path.display(),
                std::env::consts::OS,
                std::env::consts::ARCH
            );
        }
    }
}

fn search_in_path(program: &str) -> Option<PathBuf> {
    let exts: Vec<String> = if cfg!(windows) {
        std::env::var_os("PATHEXT")
            .map(|v| v.to_string_lossy().split(';').map(|s| s.to_string()).collect())
            .unwrap_or_else(|| vec![".EXE".into(), ".CMD".into(), ".BAT".into(), ".COM".into()])
    } else {
        Vec::new()
    };
    let path_var = match std::env::var_os("PATH") { Some(v) => v, None => return None };
    for dir in std::env::split_paths(&path_var) {
        if dir.as_os_str().is_empty() { continue; }
        if let Some(p) = candidate_in_dir(&dir, program, &exts) { return Some(p); }
    }
    None
}

fn candidate_in_dir(dir: &Path, program: &str, exts: &[String]) -> Option<PathBuf> {
    if cfg!(windows) {
        // Try with and without extensions
        if program.contains('.') {
            let p = dir.join(program);
            if p.is_file() { return Some(p); }
        } else {
            for ext in exts {
                let p = dir.join(format!("{program}{ext}"));
                if p.is_file() { return Some(p); }
            }
        }
    } else {
        let p = dir.join(program);
        if p.is_file() { return Some(p); }
    }
    None
}

fn common_install_candidates(program: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    // Managed app dir candidates first (per-OS app data bin)
    out.extend(managed_install_candidates(program));
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if cfg!(target_os = "macos") {
        out.push(PathBuf::from("/opt/homebrew/bin").join(program));
        out.push(PathBuf::from("/usr/local/bin").join(program));
        if let Some(h) = home.as_ref() {
            out.push(h.join(".local/bin").join(program));
            out.push(h.join("Library/pnpm").join(program));
            out.push(h.join(".npm-global/bin").join(program));
        }
    } else if cfg!(target_os = "linux") {
        out.push(PathBuf::from("/usr/local/bin").join(program));
        out.push(PathBuf::from("/usr/bin").join(program));
        if let Some(h) = home.as_ref() {
            out.push(h.join(".local/bin").join(program));
            out.push(h.join(".npm-global/bin").join(program));
            out.push(h.join(".local/share/pnpm").join(program));
        }
    } else if cfg!(target_os = "windows") {
        // Windows typical NPM global bins
        if let Ok(userprofile) = std::env::var("USERPROFILE") {
            let up = PathBuf::from(userprofile);
            out.push(up.join("AppData/Roaming/npm").join(format!("{program}.cmd")));
            out.push(up.join("AppData/Roaming/npm").join(format!("{program}.exe")));
            out.push(up.join("nodejs").join(program));
            out.push(up.join("nodejs").join(format!("{program}.cmd")));
            out.push(up.join("nodejs").join(format!("{program}.exe")));
        }
        out.push(PathBuf::from("C:/Program Files/nodejs").join(program));
        out.push(PathBuf::from("C:/Program Files/nodejs").join(format!("{program}.cmd")));
        out.push(PathBuf::from("C:/Program Files/nodejs").join(format!("{program}.exe")));
    }
    out
}

fn managed_install_candidates(program: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let base = managed_bin_base();
    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "unknown"
    };
    if let Some(base) = base {
        // bin/{tool}
        out.push(base.join(program));
        // bin/{os}/{arch}/{tool}
        out.push(base.join(os).join(arch).join(program));
        if cfg!(windows) {
            out.push(base.join(format!("{program}.exe")));
            out.push(base.join(format!("{program}.cmd")));
            out.push(base.join(os).join(arch).join(format!("{program}.exe")));
            out.push(base.join(os).join(arch).join(format!("{program}.cmd")));
        }
    }
    out
}

fn managed_bin_base() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        if let Ok(appdata) = std::env::var("APPDATA") {
            let base = PathBuf::from(appdata).join("UICP").join("bin");
            return Some(base);
        }
        None
    } else if cfg!(target_os = "macos") {
        let home = std::env::var_os("HOME").map(PathBuf::from)?;
        Some(home.join("Library").join("Application Support").join("UICP").join("bin"))
    } else {
        // linux
        let home = std::env::var_os("HOME").map(PathBuf::from)?;
        Some(home.join(".local").join("share").join("UICP").join("bin"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write as _;
    use tempfile::tempdir;

    #[cfg(not(target_os = "windows"))]
    fn write_exec(path: &Path, content: &str) {
        let mut f = fs::File::create(path).expect("create stub");
        f.write_all(content.as_bytes()).expect("write stub");
        drop(f);
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms).unwrap();
    }

    #[tokio::test]
    async fn health_program_not_found_reports_paths_and_code() {
        // Simulate fresh machine: empty PATH, bogus override path
        let prev_path = std::env::var_os("PATH");
        std::env::set_var("PATH", "");
        std::env::set_var("UICP_CLAUDE_PATH", "/nonexistent/claude");

        let res = health("claude").await.expect("result");

        if let Some(v) = prev_path { std::env::set_var("PATH", v); } else { std::env::remove_var("PATH"); }
        std::env::remove_var("UICP_CLAUDE_PATH");

        assert_eq!(res.ok, false);
        assert_eq!(res.code.as_deref(), Some(ERR_PROGRAM_NOT_FOUND));
        assert!(res.search_paths.as_ref().map(|v| !v.is_empty()).unwrap_or(false), "expected search_paths list");
        assert!(res.detail.as_ref().map(|d| d.contains("UICP_CLAUDE_PATH")).unwrap_or(false));
    }

    #[tokio::test]
    #[cfg(not(target_os = "windows"))]
    async fn claude_health_classifies_keychain_locked() {
        let temp = tempdir().unwrap();
        let bin_dir = temp.path();
        let claude_path = bin_dir.join("claude");
        write_exec(&claude_path, "#!/usr/bin/env bash\necho '{""type"":""content_block_delta"", ""delta"":{""type"":""text_delta"", ""text"":""Keychain locked: errSecAuthFailed""}}'\nexit 1\n");

        let prev_path = std::env::var_os("PATH");
        std::env::set_var("PATH", bin_dir);

        let res = health("claude").await.expect("result");

        if let Some(v) = prev_path { std::env::set_var("PATH", v); } else { std::env::remove_var("PATH"); }

        assert_eq!(res.ok, false);
        assert_eq!(res.code.as_deref(), Some(ERR_KEYCHAIN_LOCKED));
        assert!(res.detail.as_deref().unwrap_or("").to_lowercase().contains("keychain"));
    }

    #[tokio::test]
    #[cfg(not(target_os = "windows"))]
    async fn login_with_httpjail_denied_then_allowed() {
        let temp = tempdir().unwrap();
        let bin_dir = temp.path();
        // Stub claude: print success
        let claude_path = bin_dir.join("claude");
        write_exec(&claude_path, "#!/usr/bin/env bash\necho 'Login success'\nexit 0\n");
        // Stub httpjail: deny unless ALLOW_HTTPJAIL=1, in which case exec after --
        let httpjail_path = bin_dir.join("httpjail");
        write_exec(&httpjail_path, r"#!/usr/bin/env bash
if [[ "${ALLOW_HTTPJAIL:-}" == "1" ]]; then
  # find -- separator
  i=1
  for arg in "$@"; do
    if [[ "$arg" == "--" ]]; then
      shift $i
      exec "$@"
    fi
    i=$((i+1))
  done
  exit 0
else
  echo 'httpjail: denied by policy' 1>&2
  exit 1
fi
");

        let prev_path = std::env::var_os("PATH");
        std::env::set_var("PATH", bin_dir);
        std::env::set_var("UICP_HTTPJAIL", "1");

        // Denied
        let res1 = login("claude").await.expect("result");
        assert_eq!(res1.ok, false);
        assert_eq!(res1.code.as_deref(), Some(ERR_NETWORK_DENIED));

        // Allowed
        std::env::set_var("ALLOW_HTTPJAIL", "1");
        let res2 = login("claude").await.expect("result");
        assert_eq!(res2.ok, true);

        // cleanup
        std::env::remove_var("ALLOW_HTTPJAIL");
        std::env::remove_var("UICP_HTTPJAIL");
        if let Some(v) = prev_path { std::env::set_var("PATH", v); } else { std::env::remove_var("PATH"); }
    }

    #[tokio::test]
    #[cfg(not(target_os = "windows"))]
    async fn codex_health_parses_version() {
        let temp = tempdir().unwrap();
        let bin_dir = temp.path();
        let codex_path = bin_dir.join("codex");
        write_exec(&codex_path, "#!/usr/bin/env bash\necho 'codex 1.2.3'\nexit 0\n");
        let prev_path = std::env::var_os("PATH");
        std::env::set_var("PATH", bin_dir);
        let res = health("codex").await.expect("result");
        if let Some(v) = prev_path { std::env::set_var("PATH", v); } else { std::env::remove_var("PATH"); }
        assert_eq!(res.ok, true);
        assert_eq!(res.version.as_deref(), Some("codex 1.2.3"));
    }

    #[tokio::test]
    #[cfg(not(target_os = "windows"))]
    async fn env_override_to_stub_and_empty_path_allows_health() {
        let temp = tempdir().unwrap();
        let bin_dir = temp.path();
        let claude_path = bin_dir.join("claude");
        write_exec(&claude_path, "#!/usr/bin/env bash\necho '{""type"":""content_block_delta"", ""delta"":{""type"":""text_delta"", ""text"":""{\\"ok\\":true}""}}'\nexit 0\n");

        let prev_path = std::env::var_os("PATH");
        std::env::set_var("PATH", "");
        std::env::set_var("UICP_CLAUDE_PATH", &claude_path);

        let res = health("claude").await.expect("result");

        if let Some(v) = prev_path { std::env::set_var("PATH", v); } else { std::env::remove_var("PATH"); }
        std::env::remove_var("UICP_CLAUDE_PATH");

        assert!(res.detail.is_some(), "should capture output");
        // We don't guarantee ok=true because our stub emits stream-json; just ensure no ProgramNotFound
        assert_ne!(res.code.as_deref(), Some(ERR_PROGRAM_NOT_FOUND));
    }
}
