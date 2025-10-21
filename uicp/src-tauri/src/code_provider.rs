use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use std::sync::Arc;
use std::time::SystemTime;

use async_trait::async_trait;
use once_cell::sync::Lazy;
use serde::Deserialize;
use serde_json::Value;
use tokio::fs;
use tokio::io::AsyncWriteExt as _;
use tokio::process::Command;

const ERR_PROVIDER_CONFIG: &str = "E-UICP-1400";
const ERR_PROVIDER_SPAWN: &str = "E-UICP-1401";
const ERR_PROVIDER_IO: &str = "E-UICP-1402";
const ERR_PROVIDER_EXIT: &str = "E-UICP-1403";
const ERR_PROVIDER_PARSE: &str = "E-UICP-1404";
const ERR_PROVIDER_SESSION: &str = "E-UICP-1405";
const WARN_HTTPJAIL_DISABLED: &str = "E-UICP-1406";

static PROVIDER_TMP_ROOT: Lazy<PathBuf> =
    Lazy::new(|| std::env::temp_dir().join("uicp-code-providers"));

const HTTPJAIL_ENV_FLAG: &str = "UICP_HTTPJAIL";
const DEFAULT_HTTP_METHODS: &[&str] = &["GET", "HEAD", "OPTIONS"];

const CODEX_OUTPUT_SCHEMA: &str = r#"{
  "type": "object",
  "required": ["code", "language"],
  "additionalProperties": true,
  "properties": {
    "code": { "type": "string" },
    "language": { "type": "string" },
    "meta": { "type": "object" }
  }
}"#;

#[derive(Debug, Clone)]
pub struct CodeProviderJob {
    pub job_id: String,
    pub prompt: String,
    pub workspace_root: PathBuf,
    pub allowed_tools: Vec<String>,
    pub extra_env: HashMap<String, String>,
    pub metadata: Value,
}

impl CodeProviderJob {
    pub fn new(
        job_id: impl Into<String>,
        prompt: impl Into<String>,
        workspace_root: impl Into<PathBuf>,
    ) -> Self {
        Self {
            job_id: job_id.into(),
            prompt: prompt.into(),
            workspace_root: workspace_root.into(),
            allowed_tools: Vec::new(),
            extra_env: HashMap::new(),
            metadata: Value::Null,
        }
    }

    pub fn with_allowed_tools(mut self, tools: Vec<String>) -> Self {
        self.allowed_tools = tools;
        self
    }

    pub fn with_extra_env(mut self, env: HashMap<String, String>) -> Self {
        self.extra_env = env;
        self
    }

    pub fn with_metadata(mut self, metadata: Value) -> Self {
        self.metadata = metadata;
        self
    }
}

#[derive(Debug, Clone)]
pub struct ProviderContext {
    pub working_dir: PathBuf,
    pub env: HashMap<String, String>,
    pub started_at: SystemTime,
}

#[derive(Debug, Clone)]
pub struct ProviderRun {
    pub stdout: String,
    pub stderr: String,
    #[allow(dead_code)]
    pub exit_status: ExitStatus,
    pub events: Vec<Value>,
    pub aggregated_output: Option<String>,
    pub parsed_output: Option<Value>,
    pub summary: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProviderDiff {
    pub path: PathBuf,
    pub patch: String,
}

#[derive(Debug, Clone)]
pub struct ProviderArtifacts {
    pub run: ProviderRun,
    pub session_path: Option<PathBuf>,
    pub session_events: Vec<Value>,
    pub diffs: Vec<ProviderDiff>,
}

#[derive(Debug, Clone)]
pub struct CodeProviderError {
    pub code: &'static str,
    pub message: String,
}

impl CodeProviderError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[async_trait]
pub trait CommandRunner: Send + Sync {
    async fn run(
        &self,
        program: &str,
        args: &[String],
        working_dir: &Path,
        env: &HashMap<String, String>,
        input: Option<&str>,
    ) -> Result<CommandExecution, CodeProviderError>;
}

#[derive(Debug, Clone)]
pub struct CommandExecution {
    pub stdout: String,
    pub stderr: String,
    pub status: ExitStatus,
}

pub struct SystemCommandRunner;

#[async_trait]
impl CommandRunner for SystemCommandRunner {
    async fn run(
        &self,
        program: &str,
        args: &[String],
        working_dir: &Path,
        env: &HashMap<String, String>,
        input: Option<&str>,
    ) -> Result<CommandExecution, CodeProviderError> {
        let mut cmd = Command::new(program);
        cmd.args(args);
        cmd.current_dir(working_dir);
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());
        if input.is_some() {
            cmd.stdin(std::process::Stdio::piped());
        } else {
            cmd.stdin(std::process::Stdio::null());
        }
        for (key, value) in env {
            cmd.env(key, value);
        }

        let mut child = cmd.spawn().map_err(|err| {
            CodeProviderError::new(ERR_PROVIDER_SPAWN, format!("{program} spawn failed: {err}"))
        })?;

        if let Some(payload) = input {
            if let Some(stdin) = child.stdin.as_mut() {
                stdin.write_all(payload.as_bytes()).await.map_err(|err| {
                    CodeProviderError::new(
                        ERR_PROVIDER_IO,
                        format!("{program} stdin write failed: {err}"),
                    )
                })?;
            }
        }

        let output = child.wait_with_output().await.map_err(|err| {
            CodeProviderError::new(ERR_PROVIDER_IO, format!("{program} wait failed: {err}"))
        })?;

        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

        Ok(CommandExecution {
            stdout,
            stderr,
            status: output.status,
        })
    }
}

#[derive(Debug, Deserialize)]
struct HttpjailPolicy {
    providers: HashMap<String, HttpjailProviderPolicy>,
}

#[derive(Debug, Deserialize)]
struct HttpjailProviderPolicy {
    #[serde(default)]
    hosts: Vec<String>,
    #[serde(default)]
    methods: Vec<String>,
    #[serde(default, alias = "blockPost", alias = "block_post")]
    block_post: Option<bool>,
}

struct HttpjailGuard {
    exe: String,
    predicate: String,
}

impl HttpjailGuard {
    async fn new(provider: &str) -> Result<Self, String> {
        let exe = find_httpjail_binary()?;
        let predicate = load_httpjail_predicate(provider).await?;
        Ok(Self { exe, predicate })
    }

    fn wrap(&self, base_program: String, base_args: Vec<String>) -> (String, Vec<String>) {
        let mut args = Vec::with_capacity(base_args.len() + 4);
        args.push("--js".to_string());
        args.push(self.predicate.clone());
        args.push("--".to_string());
        args.push(base_program);
        args.extend(base_args);
        (self.exe.clone(), args)
    }
}

async fn maybe_wrap_with_httpjail(
    provider_key: &str,
    base_program: &str,
    base_args: Vec<String>,
    env: &HashMap<String, String>,
) -> (String, Vec<String>) {
    if !httpjail_requested(env) {
        return (base_program.to_string(), base_args);
    }

    match HttpjailGuard::new(provider_key).await {
        Ok(guard) => {
            log_httpjail_applied(provider_key);
            guard.wrap(base_program.to_string(), base_args)
        }
        Err(reason) => {
            log_httpjail_skipped(provider_key, &reason);
            (base_program.to_string(), base_args)
        }
    }
}

fn httpjail_requested(env: &HashMap<String, String>) -> bool {
    env.get(HTTPJAIL_ENV_FLAG)
        .map(|value| parse_env_flag(value))
        .or_else(|| {
            std::env::var(HTTPJAIL_ENV_FLAG)
                .ok()
                .map(|value| parse_env_flag(&value))
        })
        .unwrap_or(false)
}

fn parse_env_flag(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn find_httpjail_binary() -> Result<String, String> {
    let path_var = std::env::var_os("PATH").ok_or_else(|| "PATH not set".to_string())?;
    for dir in std::env::split_paths(&path_var) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        let candidate = dir.join("httpjail");
        if candidate.is_file() {
            return Ok(candidate.to_string_lossy().into_owned());
        }
        let candidate_exe = dir.join("httpjail.exe");
        if candidate_exe.is_file() {
            return Ok(candidate_exe.to_string_lossy().into_owned());
        }
    }
    Err("httpjail binary not found on PATH".to_string())
}

async fn load_httpjail_predicate(provider: &str) -> Result<String, String> {
    let policy_path = httpjail_policy_path();
    let content = fs::read_to_string(&policy_path)
        .await
        .map_err(|err| format!("failed to read {}: {err}", policy_path.display()))?;
    let policy: HttpjailPolicy = serde_json::from_str(&content)
        .map_err(|err| format!("failed to parse {}: {err}", policy_path.display()))?;
    let entry = policy.providers.get(provider).ok_or_else(|| {
        format!(
            "provider '{provider}' not present in {}",
            policy_path.display()
        )
    })?;

    let hosts = normalize_hosts(&entry.hosts);
    let methods_source = if entry.methods.is_empty() {
        DEFAULT_HTTP_METHODS
            .iter()
            .map(|method| method.to_string())
            .collect::<Vec<_>>()
    } else {
        entry.methods.clone()
    };
    let methods = normalize_methods(&methods_source);
    let block_post = entry.block_post.unwrap_or(true);
    Ok(build_httpjail_predicate(&hosts, &methods, block_post))
}

fn httpjail_policy_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("ops")
        .join("code")
        .join("network")
        .join("allowlist.json")
}

fn normalize_hosts(hosts: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for host in hosts {
        let trimmed = host.trim().to_ascii_lowercase();
        if trimmed.is_empty() {
            continue;
        }
        if seen.insert(trimmed.clone()) {
            normalized.push(trimmed);
        }
    }
    normalized
}

fn normalize_methods(methods: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for method in methods {
        let upper = method.trim().to_ascii_uppercase();
        if upper.is_empty() {
            continue;
        }
        if seen.insert(upper.clone()) {
            normalized.push(upper);
        }
    }
    normalized
}

fn build_httpjail_predicate(hosts: &[String], methods: &[String], block_post: bool) -> String {
    let hosts_json = serde_json::to_string(hosts).unwrap_or_else(|_| "[]".to_string());
    let methods_json = serde_json::to_string(methods).unwrap_or_else(|_| "[]".to_string());
    let block_literal = if block_post { "true" } else { "false" };

    let mut predicate = String::from("(()=>{");
    predicate.push_str(&format!("const hosts={hosts_json};"));
    predicate.push_str(&format!("const methods={methods_json};"));
    predicate.push_str(&format!("const blockPost={block_literal};"));
    predicate.push_str("const reqHost=(r.host||\"\").toLowerCase();");
    predicate.push_str("const reqMethod=(r.method||\"\").toUpperCase();");
    predicate.push_str(
        "const hostAllowed=hosts.length===0||hosts.some((pattern)=>{\
         if(pattern===\"*\") return true;\
         if(pattern.startsWith(\"*.\")){\
           const suffix=pattern.slice(1);\
           const bare=pattern.slice(2);\
           if(bare && reqHost===bare) return true;\
           return reqHost.endsWith(suffix);\
         }\
         return reqHost===pattern;\
        });",
    );
    predicate.push_str("if(!hostAllowed) return false;");
    predicate.push_str("if(blockPost && reqMethod===\"POST\") return false;");
    predicate.push_str("if(methods.length && !methods.includes(reqMethod)) return false;");
    predicate.push_str("return true;");
    predicate.push_str("})()");
    predicate
}

fn log_httpjail_applied(provider: &str) {
    #[cfg(feature = "otel_spans")]
    tracing::info!(
        target = "uicp",
        provider = provider,
        "httpjail allowlist enforced"
    );
    #[cfg(not(feature = "otel_spans"))]
    {
        eprintln!("[uicp] httpjail allowlist enforced for provider {provider}");
    }
}

fn log_httpjail_skipped(provider: &str, reason: &str) {
    #[cfg(feature = "otel_spans")]
    tracing::warn!(
        target = "uicp",
        provider = provider,
        code = WARN_HTTPJAIL_DISABLED,
        error = %reason,
        "httpjail requested but not enforced"
    );
    #[cfg(not(feature = "otel_spans"))]
    {
        eprintln!(
            "[uicp:{}] httpjail requested but not enforced for provider {provider}: {reason}",
            WARN_HTTPJAIL_DISABLED
        );
    }
}

#[async_trait]
pub trait CodeProvider: Send + Sync {
    fn name(&self) -> &'static str;

    async fn prepare(&self, job: &CodeProviderJob) -> Result<ProviderContext, CodeProviderError>;

    async fn run(
        &self,
        job: &CodeProviderJob,
        ctx: &ProviderContext,
    ) -> Result<ProviderRun, CodeProviderError>;

    async fn finalize(
        &self,
        job: &CodeProviderJob,
        ctx: ProviderContext,
        run: ProviderRun,
    ) -> Result<ProviderArtifacts, CodeProviderError>;
}

pub struct ClaudeProvider {
    runner: Arc<dyn CommandRunner>,
    model: Option<String>,
}

impl ClaudeProvider {
    pub fn new() -> Self {
        Self {
            runner: Arc::new(SystemCommandRunner),
            model: None,
        }
    }

    pub fn with_runner(runner: Arc<dyn CommandRunner>) -> Self {
        Self {
            runner,
            model: None,
        }
    }
}

#[async_trait]
impl CodeProvider for ClaudeProvider {
    fn name(&self) -> &'static str {
        "claude"
    }

    async fn prepare(&self, job: &CodeProviderJob) -> Result<ProviderContext, CodeProviderError> {
        let workdir = PROVIDER_TMP_ROOT.join(&job.job_id).join(self.name());
        fs::create_dir_all(&workdir).await.map_err(|err| {
            CodeProviderError::new(
                ERR_PROVIDER_IO,
                format!("create provider temp dir failed: {err}"),
            )
        })?;

        let mut env = job.extra_env.clone();
        if let Some(api_key) = job
            .extra_env
            .get("ANTHROPIC_API_KEY")
            .cloned()
            .or_else(|| std::env::var("ANTHROPIC_API_KEY").ok())
            .filter(|value| !value.trim().is_empty())
        {
            env.entry("ANTHROPIC_API_KEY".into()).or_insert(api_key);
        }
        env.entry("CLAUDE_TELEMETRY_OPTOUT".into())
            .or_insert_with(|| String::from("1"));
        env.entry("CLAUDE_HEADLESS".into())
            .or_insert_with(|| String::from("1"));

        Ok(ProviderContext {
            working_dir: workdir,
            env,
            started_at: SystemTime::now(),
        })
    }

    async fn run(
        &self,
        job: &CodeProviderJob,
        ctx: &ProviderContext,
    ) -> Result<ProviderRun, CodeProviderError> {
        // WHY: Ensure Claude CLI respects tool permissions and surfaces step-by-step events.
        // INVARIANT: stream-json output is parsed line-by-line; invalid JSON lines are preserved as plain text.
        let mut args = Vec::new();
        args.push("--output-format".to_string());
        args.push("stream-json".to_string());
        args.push("--print".to_string());
        args.push("--permission-mode".to_string());
        args.push("acceptEdits".to_string());

        for tool in &job.allowed_tools {
            args.push("--allowedTools".to_string());
            args.push(tool.clone());
        }

        if let Some(model) = &self.model {
            args.push("--model".to_string());
            args.push(model.clone());
        }

        let (program, final_args) =
            maybe_wrap_with_httpjail(self.name(), "claude", args, &ctx.env).await;

        let exec = self
            .runner
            .run(
                &program,
                &final_args,
                &ctx.working_dir,
                &ctx.env,
                Some(job.prompt.as_str()),
            )
            .await?;

        if !exec.status.success() {
            let code = exec
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".to_string());
            return Err(CodeProviderError::new(
                ERR_PROVIDER_EXIT,
                format!("claude exited with {code}: {}", exec.stderr.trim()),
            ));
        }

        let mut events = Vec::new();
        let mut aggregated = String::new();

        for raw_line in exec.stdout.lines() {
            let line = raw_line.trim();
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(line) {
                Ok(value) => {
                    if let Some(event_type) = value.get("type").and_then(|v| v.as_str()) {
                        if event_type == "content_block_delta" {
                            if value.pointer("/delta/type").and_then(|v| v.as_str())
                                == Some("text_delta")
                            {
                                if let Some(text) =
                                    value.pointer("/delta/text").and_then(|v| v.as_str())
                                {
                                    aggregated.push_str(text);
                                }
                            }
                        }
                    }
                    events.push(value);
                }
                Err(_) => {
                    aggregated.push_str(line);
                    aggregated.push('\n');
                }
            }
        }

        let aggregated_output = if aggregated.trim().is_empty() {
            None
        } else {
            Some(aggregated)
        };

        let parsed_output = aggregated_output
            .as_ref()
            .and_then(|raw| serde_json::from_str::<Value>(raw.trim()).ok());

        Ok(ProviderRun {
            stdout: exec.stdout,
            stderr: exec.stderr,
            exit_status: exec.status,
            events,
            aggregated_output,
            parsed_output,
            summary: None,
        })
    }

    async fn finalize(
        &self,
        _job: &CodeProviderJob,
        ctx: ProviderContext,
        run: ProviderRun,
    ) -> Result<ProviderArtifacts, CodeProviderError> {
        // WHY: Claude CLI writes all relevant information to stdout; finalize is a passthrough wrapper.
        let _ = fs::remove_dir_all(&ctx.working_dir).await;
        Ok(ProviderArtifacts {
            run,
            session_path: None,
            session_events: Vec::new(),
            diffs: Vec::new(),
        })
    }
}

pub struct CodexProvider {
    runner: Arc<dyn CommandRunner>,
    pub allow_write: bool,
    model: Option<String>,
}

impl CodexProvider {
    pub fn new() -> Self {
        Self {
            runner: Arc::new(SystemCommandRunner),
            allow_write: true,
            model: None,
        }
    }

    pub fn with_runner(runner: Arc<dyn CommandRunner>) -> Self {
        Self {
            runner,
            allow_write: true,
            model: None,
        }
    }

    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    fn codex_home() -> Result<PathBuf, CodeProviderError> {
        if let Ok(home) = std::env::var("CODEX_HOME") {
            return Ok(PathBuf::from(home));
        }
        let home = dirs::home_dir().ok_or_else(|| {
            CodeProviderError::new(
                ERR_PROVIDER_CONFIG,
                "Unable to resolve home directory for Codex session discovery",
            )
        })?;
        Ok(home.join(".codex"))
    }

    fn sessions_root(&self) -> Result<PathBuf, CodeProviderError> {
        let root = Self::codex_home()?.join("sessions");
        Ok(root)
    }
}

#[async_trait]
impl CodeProvider for CodexProvider {
    fn name(&self) -> &'static str {
        "codex"
    }

    async fn prepare(&self, job: &CodeProviderJob) -> Result<ProviderContext, CodeProviderError> {
        let workdir = job.workspace_root.clone();
        fs::create_dir_all(&workdir).await.map_err(|err| {
            CodeProviderError::new(
                ERR_PROVIDER_IO,
                format!("create Codex workspace failed: {err}"),
            )
        })?;

        let env = job.extra_env.clone();

        if env.contains_key("CODEX_API_KEY") || std::env::var("CODEX_API_KEY").is_ok() {
            // User already set explicit API key; nothing to add.
        }

        Ok(ProviderContext {
            working_dir: workdir,
            env,
            started_at: SystemTime::now(),
        })
    }

    async fn run(
        &self,
        job: &CodeProviderJob,
        ctx: &ProviderContext,
    ) -> Result<ProviderRun, CodeProviderError> {
        let schema_path = ctx.working_dir.join("schema.json");
        tokio::fs::write(&schema_path, CODEX_OUTPUT_SCHEMA)
            .await
            .map_err(|err| {
                CodeProviderError::new(
                    ERR_PROVIDER_IO,
                    format!("write Codex output schema failed: {err}"),
                )
            })?;

        let mut args = vec![
            "exec".to_string(),
            "--json".to_string(),
            "--output-schema".to_string(),
            schema_path.to_string_lossy().to_string(),
        ];

        if let Some(model) = &self.model {
            args.push("--model".to_string());
            args.push(model.clone());
        }
        if self.allow_write {
            args.push("--full-auto".to_string());
        }

        args.push(job.prompt.clone());

        let (program, final_args) =
            maybe_wrap_with_httpjail(self.name(), "codex", args, &ctx.env).await;

        let exec = self
            .runner
            .run(&program, &final_args, &ctx.working_dir, &ctx.env, None)
            .await?;

        if !exec.status.success() {
            let code = exec
                .status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "signal".to_string());
            return Err(CodeProviderError::new(
                ERR_PROVIDER_EXIT,
                format!("codex exited with {code}: {}", exec.stderr.trim()),
            ));
        }

        let mut events = Vec::new();
        let mut aggregated = String::new();
        let mut parsed: Option<Value> = None;

        for raw_line in exec.stdout.lines() {
            let line = raw_line.trim();
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(line) {
                Ok(value) => {
                    collect_codex_text(&value, &mut aggregated);
                    if parsed.is_none() {
                        parsed = extract_codex_json(&value);
                    }
                    events.push(value);
                }
                Err(_) => {
                    aggregated.push_str(line);
                    aggregated.push('\n');
                }
            }
        }

        if parsed.is_none() {
            let trimmed = aggregated.trim();
            if !trimmed.is_empty() {
                if let Ok(val) = serde_json::from_str::<Value>(trimmed) {
                    parsed = Some(val);
                }
            }
        }

        let aggregated_output = if aggregated.trim().is_empty() {
            None
        } else {
            Some(aggregated)
        };

        Ok(ProviderRun {
            stdout: exec.stdout.clone(),
            stderr: exec.stderr,
            exit_status: exec.status,
            events,
            aggregated_output,
            parsed_output: parsed,
            summary: Some(exec.stdout),
        })
    }

    async fn finalize(
        &self,
        _job: &CodeProviderJob,
        ctx: ProviderContext,
        run: ProviderRun,
    ) -> Result<ProviderArtifacts, CodeProviderError> {
        let session_root = self.sessions_root()?;
        let session_path = find_latest_session(&session_root, ctx.started_at).await?;

        let content = fs::read_to_string(&session_path).await.map_err(|err| {
            CodeProviderError::new(
                ERR_PROVIDER_SESSION,
                format!("read session log failed: {err}"),
            )
        })?;

        let mut events = Vec::new();
        let mut diffs = Vec::new();
        for line in content.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(trimmed) {
                Ok(value) => {
                    if let Some(diff) = extract_codex_diff(&value) {
                        diffs.push(diff);
                    }
                    events.push(value);
                }
                Err(err) => {
                    return Err(CodeProviderError::new(
                        ERR_PROVIDER_PARSE,
                        format!("Failed to parse Codex session JSONL: {err}"),
                    ));
                }
            }
        }

        // Preserve Codex temp workdir if distinct from workspace root; otherwise no-op.
        if ctx.working_dir.starts_with(&*PROVIDER_TMP_ROOT) {
            let _ = fs::remove_dir_all(&ctx.working_dir).await;
        }

        Ok(ProviderArtifacts {
            run,
            session_path: Some(session_path),
            session_events: events,
            diffs,
        })
    }
}

async fn find_latest_session(root: &Path, since: SystemTime) -> Result<PathBuf, CodeProviderError> {
    let mut stack = vec![root.to_path_buf()];
    let mut newest: Option<(SystemTime, PathBuf)> = None;

    while let Some(dir) = stack.pop() {
        let mut entries = fs::read_dir(&dir).await.map_err(|err| {
            CodeProviderError::new(
                ERR_PROVIDER_SESSION,
                format!("scan session dir failed: {err}"),
            )
        })?;

        while let Some(entry) = entries.next_entry().await.map_err(|err| {
            CodeProviderError::new(
                ERR_PROVIDER_SESSION,
                format!("iterate session dir failed: {err}"),
            )
        })? {
            let path = entry.path();
            let meta = entry.metadata().await.map_err(|err| {
                CodeProviderError::new(
                    ERR_PROVIDER_SESSION,
                    format!("stat session path failed: {err}"),
                )
            })?;
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file()
                && path.extension().and_then(|ext| ext.to_str()) == Some("jsonl")
            {
                if let Ok(modified) = meta.modified() {
                    if modified >= since {
                        if let Some((prev, _)) = newest {
                            if modified > prev {
                                newest = Some((modified, path));
                            }
                        } else {
                            newest = Some((modified, path));
                        }
                    }
                }
            }
        }
    }

    newest.map(|(_, path)| path).ok_or_else(|| {
        CodeProviderError::new(
            ERR_PROVIDER_SESSION,
            "No Codex session logs detected after run",
        )
    })
}

fn extract_codex_diff(event: &Value) -> Option<ProviderDiff> {
    let item = event.get("item")?;
    let kind = item.get("type")?.as_str()?;
    if kind != "file_change" {
        return None;
    }
    let path = item
        .get("path")
        .and_then(|v| v.as_str())
        .or_else(|| item.pointer("/file/path").and_then(|v| v.as_str()))
        .unwrap_or("unknown.diff");

    let patch = item
        .get("diff")
        .and_then(|v| v.get("patch"))
        .and_then(|v| v.as_str())
        .or_else(|| item.get("patch").and_then(|v| v.as_str()))
        .or_else(|| item.get("changes").and_then(|v| v.as_str()))?;

    Some(ProviderDiff {
        path: PathBuf::from(path),
        patch: patch.to_string(),
    })
}

fn collect_codex_text(value: &Value, out: &mut String) {
    if let Some(text) = value.get("text").and_then(|v| v.as_str()) {
        out.push_str(text);
    }
    if let Some(delta) = value.get("delta") {
        if let Some(text) = delta.get("text").and_then(|v| v.as_str()) {
            out.push_str(text);
        }
        if let Some(json_str) = delta.get("json").and_then(|v| v.as_str()) {
            out.push_str(json_str);
        }
    }
    if let Some(payload) = value.get("payload") {
        if let Some(content) = payload.get("content").and_then(|v| v.as_array()) {
            for item in content {
                if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                    out.push_str(text);
                }
                if let Some(json_str) = item.get("json").and_then(|v| v.as_str()) {
                    out.push_str(json_str);
                }
            }
        }
    }
}

fn extract_codex_json(value: &Value) -> Option<Value> {
    if let Some(payload) = value.get("payload") {
        if let Some(content) = payload.get("content").and_then(|v| v.as_array()) {
            for item in content {
                if let Some(kind) = item.get("type").and_then(|v| v.as_str()) {
                    match kind {
                        "output_json" => {
                            if let Some(obj) = item.get("object") {
                                return Some(obj.clone());
                            }
                            if let Some(json_str) = item.get("json").and_then(|v| v.as_str()) {
                                if let Ok(parsed) = serde_json::from_str(json_str) {
                                    return Some(parsed);
                                }
                            }
                        }
                        "output_text" | "text" => {
                            if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                                if let Ok(parsed) = serde_json::from_str(text) {
                                    return Some(parsed);
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
    }
    if let Some(delta) = value.get("delta") {
        if let Some(json_str) = delta.get("json").and_then(|v| v.as_str()) {
            if let Ok(parsed) = serde_json::from_str(json_str) {
                return Some(parsed);
            }
        }
        if let Some(text) = delta.get("text").and_then(|v| v.as_str()) {
            if let Ok(parsed) = serde_json::from_str(text) {
                return Some(parsed);
            }
        }
    }
    if let Some(text) = value.get("text").and_then(|v| v.as_str()) {
        if let Ok(parsed) = serde_json::from_str(text) {
            return Some(parsed);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(unix)]
    use std::os::unix::process::ExitStatusExt;
    #[cfg(windows)]
    use std::os::windows::process::ExitStatusExt;
    use tokio::runtime::Runtime;

    static TEST_MUTEX: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

    fn success_status() -> ExitStatus {
        #[cfg(unix)]
        {
            ExitStatus::from_raw(0)
        }
        #[cfg(windows)]
        {
            ExitStatus::from_raw(0)
        }
    }

    struct StubRunner {
        program: String,
        stdout: String,
        stderr: String,
        status: ExitStatus,
        observed_args: Mutex<Vec<String>>,
        observed_input: Mutex<Option<String>>,
    }

    impl StubRunner {
        fn new(program: &str, stdout: &str) -> Self {
            Self {
                program: program.to_string(),
                stdout: stdout.to_string(),
                stderr: String::new(),
                status: success_status(),
                observed_args: Mutex::new(Vec::new()),
                observed_input: Mutex::new(None),
            }
        }
    }

    #[async_trait]
    impl CommandRunner for StubRunner {
        async fn run(
            &self,
            program: &str,
            args: &[String],
            _working_dir: &Path,
            _env: &HashMap<String, String>,
            input: Option<&str>,
        ) -> Result<CommandExecution, CodeProviderError> {
            assert_eq!(program, self.program);
            {
                let mut guard = self.observed_args.lock();
                guard.extend(args.iter().cloned());
            }
            if let Some(payload) = input {
                *self.observed_input.lock() = Some(payload.to_string());
            }
            Ok(CommandExecution {
                stdout: self.stdout.clone(),
                stderr: self.stderr.clone(),
                status: self.status,
            })
        }
    }

    #[test]
    fn claude_provider_parses_stream_events() {
        let _guard = TEST_MUTEX.lock();
        std::env::set_var("ANTHROPIC_API_KEY", "test-key");

        let stream = r#"
{"type":"message_start","message":{"id":"msg_1","model":"claude-3.5"}}
{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\"code\":\"console.log(1)\", "}}
{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"\"language\":\"ts\"}"}}
{"type":"message_stop"}
"#;

        let runner = Arc::new(StubRunner::new("claude", stream));
        let provider = ClaudeProvider::with_runner(runner.clone());
        let rt = Runtime::new().expect("runtime");
        rt.block_on(async move {
            let job =
                CodeProviderJob::new("job-1", "Generate code", std::env::current_dir().unwrap());
            let ctx = provider.prepare(&job).await.expect("prepare");
            let run = provider.run(&job, &ctx).await.expect("run");
            let artifacts = provider
                .finalize(&job, ctx, run.clone())
                .await
                .expect("finalize");
            assert!(artifacts.session_events.is_empty());
            let aggregated = run.aggregated_output.expect("aggregated");
            assert!(aggregated.contains("\"language\":\"ts\""));
            let parsed = run.parsed_output.expect("parsed json");
            assert_eq!(
                parsed.get("code").and_then(|v| v.as_str()),
                Some("console.log(1)")
            );
            assert_eq!(
                runner.observed_input.lock().clone(),
                Some("Generate code".to_string())
            );
        });
        std::env::remove_var("ANTHROPIC_API_KEY");
    }

    #[test]
    fn claude_provider_wraps_with_httpjail_when_available() {
        let _guard = TEST_MUTEX.lock();
        std::env::set_var("ANTHROPIC_API_KEY", "test-key");

        let temp_dir = tempfile::tempdir().expect("tempdir");
        let httpjail_path = if cfg!(windows) {
            temp_dir.path().join("httpjail.exe")
        } else {
            temp_dir.path().join("httpjail")
        };
        std::fs::write(&httpjail_path, b"stub").expect("httpjail stub");
        #[cfg(unix)]
        {
            let mut perms = std::fs::metadata(&httpjail_path)
                .expect("httpjail metadata")
                .permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&httpjail_path, perms).expect("set permissions");
        }

        let previous_path = std::env::var_os("PATH");
        let mut segments = vec![temp_dir.path().to_path_buf()];
        if let Some(existing) = previous_path.clone() {
            segments.extend(std::env::split_paths(&existing));
        }
        let joined = std::env::join_paths(segments).expect("join paths");
        std::env::set_var("PATH", &joined);

        let stream = r#"
{"type":"message_start","message":{"id":"msg_1","model":"claude-3.5"}}
{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\"code\":\"console.log(1)\", "}}
{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"\"language\":\"ts\"}"}}
{"type":"message_stop"}
"#;
        let runner = Arc::new(StubRunner::new(&httpjail_path.to_string_lossy(), stream));
        let provider = ClaudeProvider::with_runner(runner.clone());
        let rt = Runtime::new().expect("runtime");
        rt.block_on(async {
            let mut job = CodeProviderJob::new(
                "job-httpjail-claude",
                "Generate code",
                std::env::current_dir().unwrap(),
            );
            job.extra_env
                .insert(HTTPJAIL_ENV_FLAG.to_string(), "1".to_string());
            let ctx = provider.prepare(&job).await.expect("prepare");
            let _ = provider.run(&job, &ctx).await.expect("run");
        });

        let observed = runner.observed_args.lock().clone();

        if let Some(existing) = previous_path {
            std::env::set_var("PATH", existing);
        } else {
            std::env::remove_var("PATH");
        }
        std::env::remove_var("ANTHROPIC_API_KEY");

        assert!(
            observed.len() >= 4,
            "expected httpjail wrapper arguments to be present"
        );
        assert_eq!(observed[0], "--js");
        assert!(
            observed[1].contains("api.anthropic.com"),
            "predicate should include Anthropics hosts"
        );
        assert_eq!(observed[2], "--");
        assert_eq!(observed[3], "claude");
    }

    #[test]
    fn codex_provider_degrades_without_httpjail() {
        let _guard = TEST_MUTEX.lock();

        let previous_path = std::env::var_os("PATH");
        std::env::set_var("PATH", "");

        let temp_workspace = tempfile::tempdir().expect("tempdir");
        let runner = Arc::new(StubRunner::new(
            "codex",
            r#"{"type":"message","text":"done"}"#,
        ));
        let provider = CodexProvider::with_runner(runner.clone());
        let rt = Runtime::new().expect("runtime");
        rt.block_on(async {
            let mut job = CodeProviderJob::new(
                "job-httpjail-codex",
                "Inspect changes",
                temp_workspace.path(),
            );
            job.extra_env
                .insert(HTTPJAIL_ENV_FLAG.to_string(), "1".to_string());
            let ctx = provider.prepare(&job).await.expect("prepare");
            let _ = provider.run(&job, &ctx).await.expect("run");
        });

        let observed = runner.observed_args.lock().clone();

        if let Some(existing) = previous_path {
            std::env::set_var("PATH", existing);
        } else {
            std::env::remove_var("PATH");
        }

        assert!(
            !observed.is_empty(),
            "expected codex arguments to be captured"
        );
        assert_eq!(
            observed[0], "exec",
            "command should execute without httpjail wrapper when binary missing"
        );
    }

    #[test]
    fn codex_provider_collects_session_diffs() {
        let _guard = TEST_MUTEX.lock();
        let temp = tempfile::tempdir().expect("tempdir");
        let codex_home = temp.path().join("codex-home");
        std::fs::create_dir_all(&codex_home).expect("codex home");
        std::env::set_var("CODEX_HOME", &codex_home);

        let runner = Arc::new(StubRunner::new("codex", "Summary complete"));
        let provider = CodexProvider::with_runner(runner);
        let rt = Runtime::new().expect("runtime");

        rt.block_on(async {
            let job = CodeProviderJob::new("job-2", "Inspect changes", temp.path());
            let ctx = provider.prepare(&job).await.expect("prepare");
            let run = provider.run(&job, &ctx).await.expect("run");

            let sessions_root = codex_home.join("sessions").join("2025").join("10").join("20");
            std::fs::create_dir_all(&sessions_root).expect("sessions dir");
            let session_path = sessions_root.join("log.jsonl");
            let lines = vec![
                serde_json::json!({"type":"item.completed","item":{"type":"file_change","path":"src/app.ts","diff":{"patch":"@@ -1 +1 @@\n-console.log('old')\n+console.log('new')\n"}}}),
                serde_json::json!({"type":"item.completed","item":{"type":"agent_message","text":"Done"}}),
            ];
            let mut file =
                std::fs::File::create(&session_path).expect("session file create");
            for line in &lines {
                writeln!(&mut file, "{}", line.to_string()).expect("write line");
            }

            // Update modification time to ensure it is after prepare timestamp.
            let mtime = filetime::FileTime::from_system_time(SystemTime::now());
            filetime::set_file_mtime(&session_path, mtime).expect("set mtime");

            let artifacts = provider.finalize(&job, ctx, run.clone()).await.expect("finalize");
            assert_eq!(artifacts.session_events.len(), 2);
            assert_eq!(artifacts.diffs.len(), 1);
            assert_eq!(artifacts.diffs[0].path, PathBuf::from("src/app.ts"));
            assert!(artifacts.diffs[0].patch.contains("console.log('new')"));
            assert!(run.summary.unwrap().contains("Summary complete"));
        });

        std::env::remove_var("CODEX_HOME");
    }
}
