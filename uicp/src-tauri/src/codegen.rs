use std::{
    collections::{HashMap, HashSet},
    env,
    path::{Path, PathBuf},
    time::Instant,
};

use anyhow::{anyhow, Context};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tauri::{async_runtime::spawn as tauri_spawn, AppHandle, Manager, Runtime, State};
use tokio::sync::OwnedSemaphorePermit;
use tree_sitter::{Node, Parser, Tree};
use tree_sitter_typescript::LANGUAGE_TYPESCRIPT;
use uuid::Uuid;

use crate::{
    code_provider::{
        ClaudeProvider, CodeProvider, CodeProviderError, CodeProviderJob, CodexProvider,
        ProviderArtifacts, ProviderDiff,
    },
    compute_cache, emit_or_log, remove_compute_job, AppState, ComputeFinalErr, ComputeFinalOk,
    ComputeJobSpec,
};

const TASK_PREFIX: &str = "codegen.run@";
const VALIDATOR_VERSION: &str = "codegen-validator-v1";
const LEGACY_VALIDATOR_V0: &str = "codegen-validator-v0";
const ERR_INPUT_INVALID: &str = "E-UICP-1300";
const ERR_CODE_UNSAFE: &str = "E-UICP-1301";
const ERR_PROVIDER: &str = "E-UICP-1302";
const ERR_API_KEY: &str = "E-UICP-1303";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExecutionStrategy {
    SequentialFallback,
    FirstOk,
    BestOfBoth,
}

impl ExecutionStrategy {
    fn parse(raw: Option<&str>) -> Result<Self, CodegenFailure> {
        match raw.unwrap_or("sequential-fallback") {
            "sequential-fallback" => Ok(ExecutionStrategy::SequentialFallback),
            "first-ok" => Ok(ExecutionStrategy::FirstOk),
            "best-of-both" => Ok(ExecutionStrategy::BestOfBoth),
            other => Err(CodegenFailure::invalid(format!(
                "{ERR_INPUT_INVALID}: strategy '{other}' unsupported"
            ))),
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            ExecutionStrategy::SequentialFallback => "sequential-fallback",
            ExecutionStrategy::FirstOk => "first-ok",
            ExecutionStrategy::BestOfBoth => "best-of-both",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum ProviderKind {
    CodexCli,
    ClaudeCli,
    OpenAiApi,
}

impl ProviderKind {
    fn as_str(&self) -> &'static str {
        match self {
            ProviderKind::CodexCli => "codex",
            ProviderKind::ClaudeCli => "claude",
            ProviderKind::OpenAiApi => "openai",
        }
    }

    fn runner_label(&self) -> &'static str {
        match self {
            ProviderKind::CodexCli => "codex-cli",
            ProviderKind::ClaudeCli => "claude-cli",
            ProviderKind::OpenAiApi => "openai-api",
        }
    }
}

#[derive(Debug, Clone)]
struct CodeProviderPlan {
    kind: ProviderKind,
    requested_label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CodeLanguage {
    Typescript,
    Rust,
    Python,
}

impl CodeLanguage {
    fn parse(raw: &str) -> Result<Self, CodegenFailure> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "ts" | "tsx" | "typescript" => Ok(CodeLanguage::Typescript),
            "rs" | "rust" => Ok(CodeLanguage::Rust),
            "py" | "python" => Ok(CodeLanguage::Python),
            other => Err(CodegenFailure::invalid(format!(
                "{ERR_INPUT_INVALID}: unsupported language '{other}'"
            ))),
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            CodeLanguage::Typescript => "ts",
            CodeLanguage::Rust => "rust",
            CodeLanguage::Python => "python",
        }
    }
}

#[allow(dead_code)]
#[derive(Debug)]
struct InstallPlan {
    panel_id: String,
    window_id: String,
    target: String,
    state_key: Option<String>,
}

#[derive(Debug)]
struct CodegenPlan {
    spec_text: String,
    language: CodeLanguage,
    constraints: Value,
    validator_version: String,
    model_id: String,
    temperature: f32,
    max_output_tokens: u32,
    mock_response: Option<Value>,
    mock_error: Option<String>,
    golden_key: String,
    provider_label: String,
    providers: Vec<String>,
    strategy: ExecutionStrategy,
    #[allow(dead_code)]
    install: Option<InstallPlan>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodegenJobInput {
    spec: String,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    constraints: Option<Value>,
    #[serde(default)]
    caps: Option<Value>,
    #[serde(default)]
    model_id: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    validator_version: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    providers: Option<Vec<String>>,
    #[serde(default)]
    strategy: Option<String>,
    #[serde(default)]
    install: Option<CodegenInstallInput>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CodegenInstallInput {
    panel_id: String,
    window_id: String,
    target: String,
    #[serde(default)]
    state_key: Option<String>,
}

struct ProviderSettings {
    model_id: String,
    api_key: String,
}

#[derive(Debug)]
struct CodegenRunOk {
    output: Value,
    output_hash: String,
    golden_hash: String,
    cache_hit: bool,
    duration_ms: u64,
    queue_wait_ms: u64,
}

#[derive(Debug, Clone)]
struct NormalizedArtifact {
    code: String,
    language: String,
    meta: Value,
    diffs: Vec<ProviderDiff>,
}

#[derive(Debug)]
struct ProviderAttemptLog {
    provider: ProviderKind,
    requested_label: String,
    success: bool,
    duration_ms: u64,
    error: Option<String>,
}

#[derive(Debug)]
struct ExecutionResult {
    artifact: NormalizedArtifact,
    plan: CodeProviderPlan,
    attempts: Vec<ProviderAttemptLog>,
}

impl NormalizedArtifact {
    fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("code".into(), Value::String(self.code.clone()));
        map.insert("language".into(), Value::String(self.language.clone()));
        map.insert("meta".into(), self.meta.clone());
        if !self.diffs.is_empty() {
            let diffs = self
                .diffs
                .iter()
                .map(|diff| {
                    json!({
                        "path": diff.path.to_string_lossy(),
                        "patch": diff.patch,
                    })
                })
                .collect::<Vec<_>>();
            map.insert("diffs".into(), Value::Array(diffs));
        }
        Value::Object(map)
    }
}

#[derive(Debug)]
enum CodegenFailure {
    Invalid { message: String },
    Provider { message: String },
    MissingApiKey,
    Unsafe { message: String },
}

impl CodegenFailure {
    fn invalid(message: String) -> Self {
        CodegenFailure::Invalid { message }
    }

    fn unsafe_code(message: String) -> Self {
        CodegenFailure::Unsafe { message }
    }

    fn provider(message: String) -> Self {
        CodegenFailure::Provider { message }
    }

    fn missing_key() -> Self {
        CodegenFailure::MissingApiKey
    }

    fn compute_code(&self) -> &'static str {
        match self {
            CodegenFailure::Invalid { .. } | CodegenFailure::Unsafe { .. } => {
                "Compute.Input.Invalid"
            }
            CodegenFailure::Provider { .. } => "Runtime.Fault",
            CodegenFailure::MissingApiKey => "Compute.CapabilityDenied",
        }
    }

    fn message(&self) -> String {
        match self {
            CodegenFailure::Invalid { message }
            | CodegenFailure::Provider { message }
            | CodegenFailure::Unsafe { message } => message.clone(),
            CodegenFailure::MissingApiKey => format!(
                "{ERR_API_KEY}: missing API key. Set OPENAI_API_KEY in the environment or provide a mockResponse constraint."
            ),
        }
    }
}

/// Entry-point for spawning codegen jobs (host-side implementation).
pub fn spawn_job<R: Runtime>(
    app: AppHandle<R>,
    mut spec: ComputeJobSpec,
    permit: Option<OwnedSemaphorePermit>,
    queue_wait_ms: u64,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri_spawn(async move {
        let _permit = permit;
        let (tx_cancel, mut rx_cancel) = tokio::sync::watch::channel(false);
        {
            let state: State<'_, AppState> = app.state();
            state
                .compute_cancel
                .write()
                .await
                .insert(spec.job_id.clone(), tx_cancel);
        }

        let started = Instant::now();
        let outcome = tokio::select! {
            _ = rx_cancel.changed() => {
                emit_error(
                    &app,
                    &spec,
                    crate::compute::error_codes::CANCELLED,
                    "E-UICP-1304: codegen job cancelled",
                    started.elapsed().as_millis() as u64,
                    queue_wait_ms,
                ).await;
                {
                    let state: State<'_, AppState> = app.state();
                    state.compute_cancel.write().await.remove(&spec.job_id);
                }
                remove_compute_job(&app, &spec.job_id).await;
                return;
            },
            result = run_codegen(&app, &mut spec, queue_wait_ms) => result,
        };

        match outcome {
            Ok(ok) => {
                emit_final_ok(&app, &spec, ok).await;
            }
            Err(err) => {
                let duration_ms = started.elapsed().as_millis() as u64;
                let message = err.message();
                emit_error(
                    &app,
                    &spec,
                    err.compute_code(),
                    &message,
                    duration_ms,
                    queue_wait_ms,
                )
                .await;
            }
        }

        {
            let state: State<'_, AppState> = app.state();
            state.compute_cancel.write().await.remove(&spec.job_id);
        }
        remove_compute_job(&app, &spec.job_id).await;
    })
}

async fn run_codegen<R: Runtime>(
    app: &AppHandle<R>,
    spec: &mut ComputeJobSpec,
    queue_wait_ms: u64,
) -> Result<CodegenRunOk, CodegenFailure> {
    let state: State<'_, AppState> = app.state();
    let plan = build_plan(spec)?;
    let provider_queue = resolve_provider_queue(&plan);

    if plan.validator_version != VALIDATOR_VERSION {
        emit_or_log(
            app,
            "codegen.validator-version",
            json!({
                "jobId": spec.job_id,
                "task": spec.task,
                "requested": plan.validator_version,
                "default": VALIDATOR_VERSION,
            }),
        );
    }
    spec.golden_key = Some(plan.golden_key.clone());
    spec.expect_golden = true;

    if let Some(record) = compute_cache::lookup_golden(app, &spec.workspace_id, &plan.golden_key)
        .await
        .map_err(|err| {
            CodegenFailure::provider(format!("{ERR_PROVIDER}: golden lookup failed: {err}"))
        })?
    {
        return Ok(CodegenRunOk {
            output: record.value,
            output_hash: record.output_hash.clone(),
            golden_hash: record.output_hash,
            cache_hit: true,
            duration_ms: 0,
            queue_wait_ms,
        });
    }

    if let Some(message) = plan.mock_error.as_ref() {
        return Err(CodegenFailure::provider(message.clone()));
    }

    let started = Instant::now();
    let artifact = if let Some(mock) = plan.mock_response.clone() {
        let mut normalized = normalize_response(&plan, ProviderKind::OpenAiApi, mock, Vec::new())
            .map_err(|err| CodegenFailure::invalid(err.to_string()))?;
        let attempt = ProviderAttemptLog {
            provider: ProviderKind::OpenAiApi,
            requested_label: ProviderKind::OpenAiApi.as_str().to_string(),
            success: true,
            duration_ms: 0,
            error: None,
        };
        let plan_selected = CodeProviderPlan {
            kind: ProviderKind::OpenAiApi,
            requested_label: ProviderKind::OpenAiApi.as_str().to_string(),
        };
        enrich_artifact_meta(&mut normalized, &plan_selected, &plan, &[attempt]);
        normalized
    } else {
        let execution =
            execute_with_strategy(app, spec, &plan, &provider_queue, &state.http).await?;
        execution.artifact
    };

    validate_code(plan.language, &plan.validator_version, &artifact.code)
        .map_err(CodegenFailure::unsafe_code)?;

    let mut output_value = artifact.to_value();
    if let Value::Object(ref mut obj) = output_value {
        if let Some(id) = spec.artifact_id.clone() {
            obj.insert("artifactId".into(), Value::String(id));
        }
        obj.insert("goldenKey".into(), Value::String(plan.golden_key.clone()));
    }

    let output_hash = compute_cache::compute_output_hash(&output_value);
    compute_cache::store_golden(
        app,
        &spec.workspace_id,
        &plan.golden_key,
        &output_hash,
        &spec.task,
        &output_value,
    )
    .await
    .map_err(|err| {
        CodegenFailure::provider(format!("{ERR_PROVIDER}: golden store failed: {err}"))
    })?;

    Ok(CodegenRunOk {
        output: output_value,
        output_hash: output_hash.clone(),
        golden_hash: output_hash,
        cache_hit: false,
        duration_ms: started.elapsed().as_millis() as u64,
        queue_wait_ms,
    })
}

async fn emit_final_ok<R: Runtime>(app: &AppHandle<R>, spec: &ComputeJobSpec, ok: CodegenRunOk) {
    let mut metrics = json!({
        "durationMs": ok.duration_ms,
        "queueMs": ok.queue_wait_ms,
        "outputHash": ok.output_hash,
        "goldenHash": ok.golden_hash,
        "goldenMatched": true,
    });
    if ok.cache_hit {
        metrics
            .as_object_mut()
            .expect("metrics object")
            .insert("cacheHit".into(), Value::Bool(true));
    }

    let payload = ComputeFinalOk {
        ok: true,
        job_id: spec.job_id.clone(),
        task: spec.task.clone(),
        output: ok.output.clone(),
        metrics: Some(metrics.clone()),
    };
    emit_or_log(app, "compute.result.final", payload);

    if spec.replayable && spec.cache == "readwrite" {
        let key = compute_cache::compute_key(&spec.task, &spec.input, &spec.provenance.env_hash);
        let mut cache_value = json!({
            "ok": true,
            "jobId": spec.job_id,
            "task": spec.task,
            "output": ok.output,
        });
        if let Some(map) = cache_value.as_object_mut() {
            map.insert("metrics".into(), metrics);
        }
        let _ = compute_cache::store(
            app,
            &spec.workspace_id,
            &key,
            &spec.task,
            &spec.provenance.env_hash,
            &cache_value,
        )
        .await;
    }
}

async fn emit_error<R: Runtime>(
    app: &AppHandle<R>,
    spec: &ComputeJobSpec,
    code: &str,
    message: &str,
    duration_ms: u64,
    queue_wait_ms: u64,
) {
    let payload = ComputeFinalErr {
        ok: false,
        job_id: spec.job_id.clone(),
        task: spec.task.clone(),
        code: code.to_string(),
        message: message.to_string(),
        metrics: Some(json!({
            "durationMs": duration_ms,
            "queueMs": queue_wait_ms,
        })),
    };
    emit_or_log(app, "compute.result.final", payload);
}

fn build_plan(spec: &ComputeJobSpec) -> Result<CodegenPlan, CodegenFailure> {
    let input: CodegenJobInput = serde_json::from_value(spec.input.clone()).map_err(|err| {
        CodegenFailure::invalid(format!(
            "{ERR_INPUT_INVALID}: unable to parse codegen input: {err}"
        ))
    })?;

    let language = CodeLanguage::parse(
        input
            .language
            .as_deref()
            .unwrap_or_else(|| spec.task.split('@').next().unwrap_or("ts")),
    )?;

    let constraints = input.constraints.clone().unwrap_or(Value::Null);
    let constraints_for_key = sanitize_constraints(&constraints);
    let validator_version = input
        .validator_version
        .as_ref()
        .cloned()
        .or_else(|| {
            constraints
                .get("validatorVersion")
                .and_then(|v| v.as_str())
                .map(String::from)
        })
        .unwrap_or_else(|| VALIDATOR_VERSION.to_string());
    let model_id = resolve_model_id(&input, &constraints).unwrap_or_else(default_model);
    let temperature = constraints
        .get("temperature")
        .and_then(|v| v.as_f64())
        .map(|v| v.clamp(0.0, 1.0) as f32)
        .unwrap_or(0.1);
    let max_output_tokens = constraints
        .get("maxOutputTokens")
        .or_else(|| constraints.get("maxTokens"))
        .or_else(|| constraints.get("max_tokens"))
        .and_then(|v| v.as_u64())
        .map(|v| v.min(8192) as u32)
        .unwrap_or(2048);
    let mock_response = constraints.get("mockResponse").cloned();
    let mock_error = constraints
        .get("mockError")
        .and_then(|v| v.as_str())
        .map(String::from);

    let strategy = ExecutionStrategy::parse(
        input
            .strategy
            .as_deref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty()),
    )?;

    let provider_label = input
        .provider
        .as_deref()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "auto".to_string());
    if !matches!(provider_label.as_str(), "auto" | "codex" | "claude") {
        return Err(CodegenFailure::invalid(format!(
            "{ERR_INPUT_INVALID}: provider '{}' unsupported",
            provider_label
        )));
    }

    let mut providers: Vec<String> = Vec::new();
    if let Some(list) = input.providers.as_ref() {
        for item in list {
            let candidate = item.trim().to_ascii_lowercase();
            if matches!(candidate.as_str(), "codex" | "claude")
                && !providers.iter().any(|existing| existing == &candidate)
            {
                providers.push(candidate);
            }
        }
    }

    let install = input.install.as_ref().map(|value| InstallPlan {
        panel_id: value.panel_id.clone(),
        window_id: value.window_id.clone(),
        target: value.target.clone(),
        state_key: value.state_key.clone(),
    });

    let providers_for_key = providers.clone();
    let key_payload = json!({
        "spec": input.spec,
        "language": language.as_str(),
        "constraints": constraints_for_key,
        "validatorVersion": validator_version,
        "modelId": model_id,
        "provider": provider_label,
        "providers": providers_for_key,
        "strategy": strategy.as_str(),
    });
    let canonical = compute_cache::canonicalize_input(&key_payload);
    let mut hasher = sha2::Sha256::new();
    use sha2::Digest as _;
    hasher.update(b"codegen-golden-v1|");
    hasher.update(canonical.as_bytes());
    let golden_key = hex::encode(hasher.finalize());

    Ok(CodegenPlan {
        spec_text: input.spec,
        language,
        constraints,
        validator_version,
        model_id,
        temperature,
        max_output_tokens,
        mock_response,
        mock_error,
        golden_key,
        provider_label,
        providers,
        strategy,
        install,
    })
}

fn command_available(program: &str) -> bool {
    fn candidate_paths<'a>(dir: &'a Path, program: &'a str) -> Vec<PathBuf> {
        #[cfg(windows)]
        {
            let mut out = Vec::new();
            if program.contains('.') {
                out.push(dir.join(program));
            } else {
                const DEFAULT_EXTS: [&str; 4] = [".EXE", ".CMD", ".BAT", ".COM"];
                let exts = env::var_os("PATHEXT")
                    .map(|v| {
                        v.to_string_lossy()
                            .split(';')
                            .filter(|s| !s.is_empty())
                            .map(|s| {
                                if s.starts_with('.') {
                                    s.to_string()
                                } else {
                                    format!(".{}", s)
                                }
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_else(|| DEFAULT_EXTS.iter().map(|s| s.to_string()).collect());
                for ext in exts {
                    out.push(dir.join(format!("{program}{ext}")));
                }
            }
            out
        }
        #[cfg(not(windows))]
        {
            vec![dir.join(program)]
        }
    }

    let path_var = match env::var_os("PATH") {
        Some(val) => val,
        None => return false,
    };
    for dir in env::split_paths(&path_var) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for candidate in candidate_paths(&dir, program) {
            if candidate.exists() {
                return true;
            }
        }
    }
    false
}

fn detect_auto_provider() -> ProviderKind {
    if command_available("codex") {
        ProviderKind::CodexCli
    } else if command_available("claude") {
        ProviderKind::ClaudeCli
    } else {
        ProviderKind::OpenAiApi
    }
}

fn provider_kind_from_label(label: &str, auto_kind: ProviderKind) -> ProviderKind {
    match label {
        "codex" => ProviderKind::CodexCli,
        "claude" => ProviderKind::ClaudeCli,
        "openai" => ProviderKind::OpenAiApi,
        "auto" | "" => auto_kind,
        _ => auto_kind,
    }
}

fn resolve_provider_queue(plan: &CodegenPlan) -> Vec<CodeProviderPlan> {
    let auto_kind = detect_auto_provider();

    let mut requested_labels: Vec<String> = if plan.providers.is_empty() {
        vec![plan.provider_label.clone()]
    } else {
        plan.providers.clone()
    };

    if requested_labels.is_empty() {
        requested_labels.push("auto".to_string());
    }

    let mut seen: HashSet<ProviderKind> = HashSet::new();
    let mut queue: Vec<CodeProviderPlan> = Vec::new();

    for label in requested_labels {
        let kind = provider_kind_from_label(label.as_str(), auto_kind);
        if seen.insert(kind) {
            let resolved_label = if label == "auto" || label.is_empty() {
                kind.as_str().to_string()
            } else {
                label
            };
            queue.push(CodeProviderPlan {
                kind,
                requested_label: resolved_label,
            });
        }
    }

    if !queue
        .iter()
        .any(|p| matches!(p.kind, ProviderKind::OpenAiApi))
    {
        queue.push(CodeProviderPlan {
            kind: ProviderKind::OpenAiApi,
            requested_label: ProviderKind::OpenAiApi.as_str().to_string(),
        });
    }

    queue
}

async fn execute_with_strategy<R: Runtime>(
    app: &AppHandle<R>,
    spec: &ComputeJobSpec,
    plan: &CodegenPlan,
    queue: &[CodeProviderPlan],
    client: &reqwest::Client,
) -> Result<ExecutionResult, CodegenFailure> {
    let mut attempts: Vec<ProviderAttemptLog> = Vec::new();

    match plan.strategy {
        ExecutionStrategy::SequentialFallback | ExecutionStrategy::FirstOk => {
            let mut last_err: Option<CodegenFailure> = None;
            for provider_plan in queue {
                let started = Instant::now();
                let result = run_provider(app, spec, plan, provider_plan, client).await;
                let duration_ms = started.elapsed().as_millis() as u64;
                match result {
                    Ok(mut artifact) => {
                        attempts.push(ProviderAttemptLog {
                            provider: provider_plan.kind,
                            requested_label: provider_plan.requested_label.clone(),
                            success: true,
                            duration_ms,
                            error: None,
                        });
                        emit_provider_attempt(app, spec, plan, attempts.last().unwrap());
                        enrich_artifact_meta(&mut artifact, provider_plan, plan, &attempts);
                        return Ok(ExecutionResult {
                            artifact,
                            plan: provider_plan.clone(),
                            attempts,
                        });
                    }
                    Err(err) => {
                        let message = err.message();
                        attempts.push(ProviderAttemptLog {
                            provider: provider_plan.kind,
                            requested_label: provider_plan.requested_label.clone(),
                            success: false,
                            duration_ms,
                            error: Some(message.clone()),
                        });
                        emit_provider_attempt(app, spec, plan, attempts.last().unwrap());
                        last_err = Some(err);
                        if matches!(plan.strategy, ExecutionStrategy::FirstOk) {
                            break;
                        }
                    }
                }
            }
            Err(last_err.unwrap_or_else(|| {
                CodegenFailure::provider(format!("{ERR_PROVIDER}: all providers failed"))
            }))
        }
        ExecutionStrategy::BestOfBoth => {
            let mut successes: Vec<(NormalizedArtifact, CodeProviderPlan, u64)> = Vec::new();
            let mut last_err: Option<CodegenFailure> = None;

            for provider_plan in queue {
                let is_cli = matches!(
                    provider_plan.kind,
                    ProviderKind::CodexCli | ProviderKind::ClaudeCli
                );
                if !is_cli {
                    continue;
                }
                let started = Instant::now();
                let result = run_provider(app, spec, plan, provider_plan, client).await;
                let duration_ms = started.elapsed().as_millis() as u64;
                match result {
                    Ok(artifact) => {
                        attempts.push(ProviderAttemptLog {
                            provider: provider_plan.kind,
                            requested_label: provider_plan.requested_label.clone(),
                            success: true,
                            duration_ms,
                            error: None,
                        });
                        emit_provider_attempt(app, spec, plan, attempts.last().unwrap());
                        successes.push((artifact, provider_plan.clone(), duration_ms));
                    }
                    Err(err) => {
                        let message = err.message();
                        attempts.push(ProviderAttemptLog {
                            provider: provider_plan.kind,
                            requested_label: provider_plan.requested_label.clone(),
                            success: false,
                            duration_ms,
                            error: Some(message.clone()),
                        });
                        emit_provider_attempt(app, spec, plan, attempts.last().unwrap());
                        last_err = Some(err);
                    }
                }
            }

            if let Some((mut chosen, chosen_plan, _dur)) = choose_best_artifact(successes) {
                enrich_artifact_meta(&mut chosen, &chosen_plan, plan, &attempts);
                return Ok(ExecutionResult {
                    artifact: chosen,
                    plan: chosen_plan,
                    attempts,
                });
            }

            for provider_plan in queue {
                if matches!(
                    provider_plan.kind,
                    ProviderKind::CodexCli | ProviderKind::ClaudeCli
                ) {
                    continue;
                }
                let started = Instant::now();
                let result = run_provider(app, spec, plan, provider_plan, client).await;
                let duration_ms = started.elapsed().as_millis() as u64;
                match result {
                    Ok(mut artifact) => {
                        attempts.push(ProviderAttemptLog {
                            provider: provider_plan.kind,
                            requested_label: provider_plan.requested_label.clone(),
                            success: true,
                            duration_ms,
                            error: None,
                        });
                        emit_provider_attempt(app, spec, plan, attempts.last().unwrap());
                        enrich_artifact_meta(&mut artifact, provider_plan, plan, &attempts);
                        return Ok(ExecutionResult {
                            artifact,
                            plan: provider_plan.clone(),
                            attempts,
                        });
                    }
                    Err(err) => {
                        let message = err.message();
                        attempts.push(ProviderAttemptLog {
                            provider: provider_plan.kind,
                            requested_label: provider_plan.requested_label.clone(),
                            success: false,
                            duration_ms,
                            error: Some(message.clone()),
                        });
                        emit_provider_attempt(app, spec, plan, attempts.last().unwrap());
                        last_err = Some(err);
                    }
                }
            }

            Err(last_err.unwrap_or_else(|| {
                CodegenFailure::provider(format!("{ERR_PROVIDER}: all providers failed"))
            }))
        }
    }
}

async fn run_provider<R: Runtime>(
    app: &AppHandle<R>,
    spec: &ComputeJobSpec,
    plan: &CodegenPlan,
    provider_plan: &CodeProviderPlan,
    client: &reqwest::Client,
) -> Result<NormalizedArtifact, CodegenFailure> {
    match provider_plan.kind {
        ProviderKind::OpenAiApi => run_openai_api(client, plan).await,
        ProviderKind::CodexCli => run_codex_cli(app, spec, plan).await,
        ProviderKind::ClaudeCli => run_claude_cli(app, spec, plan).await,
    }
}

fn emit_provider_attempt<R: Runtime>(
    app: &AppHandle<R>,
    spec: &ComputeJobSpec,
    plan: &CodegenPlan,
    attempt: &ProviderAttemptLog,
) {
    let mut payload = json!({
        "jobId": spec.job_id,
        "task": spec.task,
        "provider": attempt.provider.as_str(),
        "requested": attempt.requested_label,
        "strategy": plan.strategy.as_str(),
        "success": attempt.success,
        "durationMs": attempt.duration_ms,
    });
    if let Some(err) = attempt.error.as_ref() {
        if let Some(obj) = payload.as_object_mut() {
            obj.insert("error".into(), Value::String(err.clone()));
        }
    }
    emit_or_log(app, "codegen.provider.attempt", payload);
}

fn enrich_artifact_meta(
    artifact: &mut NormalizedArtifact,
    selected_plan: &CodeProviderPlan,
    plan: &CodegenPlan,
    attempts: &[ProviderAttemptLog],
) {
    if let Value::Object(ref mut meta) = artifact.meta {
        meta.insert(
            "providerSelected".into(),
            Value::String(selected_plan.kind.as_str().into()),
        );
        meta.insert(
            "providerRequested".into(),
            Value::String(selected_plan.requested_label.clone()),
        );
        meta.insert(
            "providerRunner".into(),
            Value::String(selected_plan.kind.runner_label().into()),
        );
        meta.insert(
            "strategy".into(),
            Value::String(plan.strategy.as_str().into()),
        );
        let attempt_values = attempts
            .iter()
            .map(|attempt| {
                json!({
                    "provider": attempt.provider.as_str(),
                    "requested": attempt.requested_label,
                    "success": attempt.success,
                    "durationMs": attempt.duration_ms,
                    "error": attempt.error,
                })
            })
            .collect::<Vec<_>>();
        meta.insert("attempts".into(), Value::Array(attempt_values));
        let queue = attempts
            .iter()
            .map(|attempt| Value::String(attempt.requested_label.clone()))
            .collect::<Vec<_>>();
        if !queue.is_empty() {
            meta.insert("providerQueue".into(), Value::Array(queue));
        }
    }
}

fn choose_best_artifact(
    mut successes: Vec<(NormalizedArtifact, CodeProviderPlan, u64)>,
) -> Option<(NormalizedArtifact, CodeProviderPlan, u64)> {
    if successes.is_empty() {
        return None;
    }
    let mut best_index: Option<usize> = None;
    let mut best_score: i32 = i32::MIN;
    for (idx, (_, plan, _)) in successes.iter().enumerate() {
        let score = match plan.kind {
            ProviderKind::CodexCli => 100,
            ProviderKind::ClaudeCli => 80,
            ProviderKind::OpenAiApi => 10,
        };
        if score > best_score {
            best_score = score;
            best_index = Some(idx);
        }
    }
    best_index.map(|idx| successes.swap_remove(idx))
}

async fn run_openai_api(
    client: &reqwest::Client,
    plan: &CodegenPlan,
) -> Result<NormalizedArtifact, CodegenFailure> {
    let settings = resolve_provider_settings(plan)?;
    let value = call_openai(client, plan, &settings).await.map_err(|err| {
        CodegenFailure::provider(format!("{ERR_PROVIDER}: openai call failed: {err}"))
    })?;
    normalize_response(plan, ProviderKind::OpenAiApi, value, Vec::new())
        .map_err(|err| CodegenFailure::invalid(err.to_string()))
}

async fn create_job_workspace(
    job_id: &str,
    provider_label: &str,
) -> Result<PathBuf, CodegenFailure> {
    let base = env::temp_dir().join("uicp-code-providers").join(job_id);
    let workspace = base.join(format!("{}-{}", provider_label, Uuid::new_v4()));
    tokio::fs::create_dir_all(&workspace).await.map_err(|err| {
        CodegenFailure::provider(format!(
            "{ERR_PROVIDER}: create provider workspace failed: {err}"
        ))
    })?;
    Ok(workspace)
}

fn map_code_provider_error(err: CodeProviderError) -> CodegenFailure {
    CodegenFailure::provider(format!("{}: {}", err.code, err.message))
}

fn extract_allowed_tools(plan: &CodegenPlan) -> Vec<String> {
    let mut tools = Vec::new();
    if let Value::Object(map) = &plan.constraints {
        if let Some(Value::Array(arr)) = map.get("allowedTools") {
            for item in arr {
                if let Some(name) = item.as_str() {
                    let trimmed = name.trim();
                    if !trimmed.is_empty() {
                        tools.push(trimmed.to_string());
                    }
                }
            }
        }
    }
    tools
}

fn extract_usage(events: &[Value]) -> Option<Value> {
    for event in events.iter().rev() {
        if let Some(obj) = event.get("usage") {
            if obj.is_object() {
                return Some(obj.clone());
            }
        }
    }
    None
}

fn compose_normalized_from_artifacts(
    plan: &CodegenPlan,
    provider_kind: ProviderKind,
    artifacts: ProviderArtifacts,
) -> Result<NormalizedArtifact, CodegenFailure> {
    let ProviderArtifacts {
        run,
        session_path,
        session_events,
        diffs,
    } = artifacts;
    let parsed = run
        .parsed_output
        .clone()
        .or_else(|| {
            run.aggregated_output
                .as_ref()
                .and_then(|raw| serde_json::from_str(raw.trim()).ok())
        })
        .ok_or_else(|| {
            CodegenFailure::provider(format!(
                "{ERR_PROVIDER}: provider produced no structured artifact"
            ))
        })?;

    let mut normalized = normalize_response(plan, provider_kind, parsed, diffs)
        .map_err(|err| CodegenFailure::invalid(err.to_string()))?;

    if let Value::Object(ref mut meta) = normalized.meta {
        if let Some(usage) = extract_usage(&run.events) {
            meta.insert("usage".into(), usage);
        }
        meta.insert(
            "providerRunner".into(),
            Value::String(provider_kind.runner_label().into()),
        );
        if let Some(path) = session_path {
            meta.insert(
                "providerSessionPath".into(),
                Value::String(path.to_string_lossy().into()),
            );
            meta.insert(
                "providerSessionEvents".into(),
                Value::Number((session_events.len() as u64).into()),
            );
        }
        if !run.stdout.is_empty() {
            let preview = run.stdout.chars().take(2048).collect::<String>();
            meta.entry("stdoutPreview")
                .or_insert_with(|| Value::String(preview));
        }
        if !run.stderr.trim().is_empty() {
            let preview = run.stderr.trim().chars().take(512).collect::<String>();
            meta.insert("stderrPreview".into(), Value::String(preview));
        }
        meta.insert(
            "providerEventCount".into(),
            Value::Number((run.events.len() as u64).into()),
        );
    }

    Ok(normalized)
}

async fn run_codex_cli<R: Runtime>(
    _app: &AppHandle<R>,
    spec: &ComputeJobSpec,
    plan: &CodegenPlan,
) -> Result<NormalizedArtifact, CodegenFailure> {
    let workspace = create_job_workspace(&spec.job_id, "codex").await?;
    let mut extra_env: HashMap<String, String> = HashMap::new();
    if let Ok(key) = env::var("OPENAI_API_KEY") {
        extra_env.insert("OPENAI_API_KEY".into(), key);
    }
    if let Ok(key) = env::var("CODEX_API_KEY") {
        extra_env.insert("CODEX_API_KEY".into(), key);
    }

    let job = CodeProviderJob::new(&spec.job_id, plan.spec_text.clone(), workspace)
        .with_allowed_tools(extract_allowed_tools(plan))
        .with_extra_env(extra_env)
        .with_metadata(json!({
            "language": plan.language.as_str(),
        }));

    let mut provider = CodexProvider::new().with_model(plan.model_id.clone());
    let ctx = provider
        .prepare(&job)
        .await
        .map_err(map_code_provider_error)?;
    let run = provider
        .run(&job, &ctx)
        .await
        .map_err(map_code_provider_error)?;
    let artifacts = provider
        .finalize(&job, ctx, run)
        .await
        .map_err(map_code_provider_error)?;

    compose_normalized_from_artifacts(plan, ProviderKind::CodexCli, artifacts)
}

async fn run_claude_cli<R: Runtime>(
    _app: &AppHandle<R>,
    spec: &ComputeJobSpec,
    plan: &CodegenPlan,
) -> Result<NormalizedArtifact, CodegenFailure> {
    let workspace = create_job_workspace(&spec.job_id, "claude").await?;
    let mut extra_env: HashMap<String, String> = HashMap::new();
    if let Ok(key) = env::var("ANTHROPIC_API_KEY") {
        extra_env.insert("ANTHROPIC_API_KEY".into(), key);
    }

    let job = CodeProviderJob::new(&spec.job_id, plan.spec_text.clone(), workspace)
        .with_allowed_tools(extract_allowed_tools(plan))
        .with_extra_env(extra_env)
        .with_metadata(json!({
            "language": plan.language.as_str(),
        }));

    let provider = ClaudeProvider::new();
    let ctx = provider
        .prepare(&job)
        .await
        .map_err(map_code_provider_error)?;
    let run = provider
        .run(&job, &ctx)
        .await
        .map_err(map_code_provider_error)?;
    let artifacts = provider
        .finalize(&job, ctx, run)
        .await
        .map_err(map_code_provider_error)?;

    compose_normalized_from_artifacts(plan, ProviderKind::ClaudeCli, artifacts)
}
fn sanitize_constraints(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut filtered = Map::new();
            for (key, val) in map {
                if matches!(key.as_str(), "mockResponse" | "mockError") {
                    continue;
                }
                filtered.insert(key.clone(), sanitize_constraints(val));
            }
            Value::Object(filtered)
        }
        Value::Array(items) => {
            Value::Array(items.iter().map(sanitize_constraints).collect::<Vec<_>>())
        }
        other => other.clone(),
    }
}

// NOTE: Only OpenAI provider is supported in this module.

fn resolve_model_id(input: &CodegenJobInput, constraints: &Value) -> Option<String> {
    input
        .model_id
        .clone()
        .or_else(|| input.model.clone())
        .or_else(|| {
            constraints
                .get("modelId")
                .or_else(|| constraints.get("model"))
                .and_then(|v| v.as_str())
                .map(String::from)
        })
        .or_else(|| {
            input
                .caps
                .as_ref()
                .and_then(|caps| caps.get("model").or_else(|| caps.get("modelId")))
                .and_then(|v| v.as_str())
                .map(String::from)
        })
        .or_else(|| std::env::var("UICP_CODEGEN_OPENAI_MODEL").ok())
}

fn default_model() -> String {
    std::env::var("UICP_CODEGEN_OPENAI_MODEL").unwrap_or_else(|_| "o4-mini".to_string())
}

fn resolve_provider_settings(plan: &CodegenPlan) -> Result<ProviderSettings, CodegenFailure> {
    let api_key = std::env::var("OPENAI_API_KEY").map_err(|_| CodegenFailure::missing_key())?;
    Ok(ProviderSettings {
        model_id: plan.model_id.clone(),
        api_key,
    })
}

async fn call_openai(
    client: &reqwest::Client,
    plan: &CodegenPlan,
    settings: &ProviderSettings,
) -> anyhow::Result<Value> {
    let endpoint = std::env::var("UICP_CODEGEN_OPENAI_ENDPOINT")
        .unwrap_or_else(|_| "https://api.openai.com/v1/chat/completions".to_string());

    let system_prompt = format!(
        "You are a deterministic code generator. Return a strict JSON object with keys code, language, meta. \
Language must be {lang}. Include meta.modelId and meta.provider. Do not wrap output in markdown fencing or commentary.",
        lang = plan.language.as_str()
    );
    let user_prompt = plan.spec_text.clone();

    let mut messages = vec![
        json!({"role": "system", "content": system_prompt}),
        json!({"role": "user", "content": user_prompt}),
    ];
    if let Some(extra) = plan.constraints.get("messages").and_then(|v| v.as_array()) {
        for msg in extra {
            messages.push(msg.clone());
        }
    }

    let body = json!({
        "model": settings.model_id,
        "temperature": plan.temperature,
        "max_tokens": plan.max_output_tokens,
        "response_format": { "type": "json_object" },
        "messages": messages,
    });

    let response = client
        .post(endpoint)
        .header("Authorization", format!("Bearer {}", settings.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .context("send openai request")?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        anyhow::bail!("non-success status {}: {}", status, text);
    }

    let payload: Value = response
        .json()
        .await
        .context("parse openai response JSON")?;
    let content = payload
        .pointer("/choices/0/message/content")
        .ok_or_else(|| anyhow!("missing choices[0].message.content"))?;

    if let Some(obj) = content.as_object() {
        return Ok(Value::Object(obj.clone()));
    }
    if let Some(text) = content.as_str() {
        let trimmed = text.trim_matches('`').trim();
        let parsed: Value = serde_json::from_str(trimmed)
            .map_err(|err| anyhow!("parse JSON content: {err}. content={trimmed}"))?;
        return Ok(parsed);
    }
    anyhow::bail!("unexpected OpenAI content format");
}

fn normalize_response(
    plan: &CodegenPlan,
    provider_kind: ProviderKind,
    value: Value,
    diffs: Vec<ProviderDiff>,
) -> anyhow::Result<NormalizedArtifact> {
    if !value.is_object() {
        anyhow::bail!("{ERR_INPUT_INVALID}: provider response must be JSON object");
    }
    let mut map = value
        .as_object()
        .cloned()
        .ok_or_else(|| anyhow!("response payload empty"))?;
    let code = map
        .remove("code")
        .and_then(|v| v.as_str().map(String::from))
        .ok_or_else(|| anyhow!("{ERR_INPUT_INVALID}: response missing code string"))?;
    let language = plan.language.as_str().to_string();
    let meta_value = map
        .remove("meta")
        .unwrap_or_else(|| Value::Object(Map::new()));
    let mut meta = meta_value.as_object().cloned().unwrap_or_else(Map::new);
    meta.entry("modelId")
        .or_insert_with(|| Value::String(plan.model_id.clone()));
    meta.entry("provider")
        .and_modify(|val| *val = Value::String(provider_kind.as_str().into()))
        .or_insert_with(|| Value::String(provider_kind.as_str().into()));
    meta.insert(
        "validatorVersion".into(),
        Value::String(plan.validator_version.clone()),
    );

    Ok(NormalizedArtifact {
        code,
        language,
        meta: Value::Object(meta),
        diffs,
    })
}

fn validate_code(
    language: CodeLanguage,
    validator_version: &str,
    code: &str,
) -> Result<(), String> {
    if code.trim().is_empty() {
        return Err(format!("{ERR_INPUT_INVALID}: generated code is empty"));
    }

    run_common_guards(code)?;

    match language {
        CodeLanguage::Typescript => validate_typescript(code, validator_version),
        CodeLanguage::Rust => validate_rust(code),
        CodeLanguage::Python => validate_python(code),
    }
}

fn run_common_guards(code: &str) -> Result<(), String> {
    let lowered = code.to_ascii_lowercase();
    if lowered.contains("eval(") {
        return Err(format!("{ERR_CODE_UNSAFE}: usage of eval is forbidden"));
    }
    if lowered.contains("new function(") {
        return Err(format!(
            "{ERR_CODE_UNSAFE}: usage of new Function is forbidden"
        ));
    }
    if lowered.contains("xmlhttprequest")
        || lowered.contains("fetch(")
        || lowered.contains("websocket(")
    {
        return Err(format!(
            "{ERR_CODE_UNSAFE}: network primitives (fetch/XMLHttpRequest/WebSocket) are forbidden"
        ));
    }
    if lowered.contains("document.write") {
        return Err(format!("{ERR_CODE_UNSAFE}: document.write is forbidden"));
    }
    if lowered.contains("__proto__") || lowered.contains("prototype") {
        return Err(format!(
            "{ERR_CODE_UNSAFE}: prototype mutation is forbidden"
        ));
    }
    if lowered.contains("constructor.constructor") {
        return Err(format!(
            "{ERR_CODE_UNSAFE}: constructor.constructor is forbidden"
        ));
    }
    if SET_TIMEOUT_STRING_RE.is_match(code) {
        return Err(format!(
            "{ERR_CODE_UNSAFE}: setTimeout with string argument is forbidden"
        ));
    }
    if INNER_HTML_LITERAL_RE.is_match(code) {
        return Err(format!(
            "{ERR_CODE_UNSAFE}: assigning string literal to innerHTML is forbidden"
        ));
    }
    Ok(())
}

fn validate_typescript(code: &str, validator_version: &str) -> Result<(), String> {
    if validator_version == LEGACY_VALIDATOR_V0 {
        return legacy_typescript_export_check(code);
    }
    validate_typescript_structural(code)
}

fn legacy_typescript_export_check(code: &str) -> Result<(), String> {
    if !TS_RENDER_EXPORT_RE.is_match(code) {
        return Err(format!(
            "{ERR_INPUT_INVALID}: export render function missing (export function render)"
        ));
    }
    if !TS_ON_EVENT_EXPORT_RE.is_match(code) {
        return Err(format!(
            "{ERR_INPUT_INVALID}: export onEvent function missing"
        ));
    }
    Ok(())
}

fn validate_rust(code: &str) -> Result<(), String> {
    if !RS_RENDER_FN_RE.is_match(code) {
        return Err(format!(
            "{ERR_INPUT_INVALID}: pub fn render signature missing in Rust artifact"
        ));
    }
    if !RS_ON_EVENT_FN_RE.is_match(code) {
        return Err(format!(
            "{ERR_INPUT_INVALID}: pub fn on_event signature missing in Rust artifact"
        ));
    }
    Ok(())
}

fn validate_python(code: &str) -> Result<(), String> {
    let lowered = code.to_ascii_lowercase();
    if !PY_RENDER_DEF_RE.is_match(&lowered) {
        return Err(format!(
            "{ERR_INPUT_INVALID}: def render(...) missing in Python artifact"
        ));
    }
    if !PY_ON_EVENT_DEF_RE.is_match(&lowered) {
        return Err(format!(
            "{ERR_INPUT_INVALID}: def on_event(...) missing in Python artifact"
        ));
    }
    Ok(())
}

fn validate_typescript_structural(code: &str) -> Result<(), String> {
    let tree = parse_typescript_tree(code)?;
    let metadata = gather_ts_metadata(&tree, code)?;

    if metadata.has_imports {
        return Err(format!(
            "{ERR_INPUT_INVALID}: imports are not allowed in generated code"
        ));
    }
    if metadata.has_reexports {
        return Err(format!(
            "{ERR_INPUT_INVALID}: re-exports are not allowed in generated code"
        ));
    }

    for required in ["render", "onEvent"] {
        if !metadata.exports.contains(required) {
            return Err(format!(
                "{ERR_INPUT_INVALID}: export {required} function missing"
            ));
        }
        if !metadata.fn_like.contains(required) {
            return Err(format!(
                "{ERR_INPUT_INVALID}: export {required} must be a function"
            ));
        }
    }

    let violations = detect_ts_identifier_violations(&tree, code, &metadata.declared);
    if !violations.is_empty() {
        let mut names: Vec<_> = violations.into_iter().collect();
        names.sort();
        let joined = names
            .into_iter()
            .map(|name| format!("identifier '{name}' is not in the allowlist"))
            .collect::<Vec<_>>()
            .join("; ");
        return Err(format!("{ERR_CODE_UNSAFE}: {joined}"));
    }

    Ok(())
}

#[derive(Default)]
struct TsMetadata {
    exports: HashSet<String>,
    fn_like: HashSet<String>,
    declared: HashSet<String>,
    has_imports: bool,
    has_reexports: bool,
}

fn parse_typescript_tree(code: &str) -> Result<Tree, String> {
    let mut parser = Parser::new();
    let language = LANGUAGE_TYPESCRIPT;
    parser.set_language(&language.into()).map_err(|err| {
        format!("{ERR_INPUT_INVALID}: failed to initialize TypeScript parser: {err}")
    })?;
    let tree = parser
        .parse(code, None)
        .ok_or_else(|| format!("{ERR_INPUT_INVALID}: failed to parse TypeScript"))?;
    if tree.root_node().has_error() {
        return Err(format!(
            "{ERR_INPUT_INVALID}: failed to parse TypeScript: syntax error"
        ));
    }
    Ok(tree)
}

fn gather_ts_metadata(tree: &Tree, code: &str) -> Result<TsMetadata, String> {
    let mut metadata = TsMetadata::default();
    gather_ts_node(tree.root_node(), code, &mut metadata)?;
    Ok(metadata)
}

fn gather_ts_node(node: Node, code: &str, meta: &mut TsMetadata) -> Result<(), String> {
    match node.kind() {
        "import_statement" => meta.has_imports = true,
        "export_statement" => process_export_statement(node, code, meta)?,
        "function_declaration" => process_function_declaration_node(node, code, meta),
        "lexical_declaration" | "variable_declaration" | "variable_statement" => {
            process_variable_declaration_node(node, code, meta, false)
        }
        "class_declaration" => {
            if let Some(name_node) = node.child_by_field_name("name") {
                meta.declared.insert(node_text(name_node, code));
            }
        }
        _ => {}
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        gather_ts_node(child, code, meta)?;
    }
    Ok(())
}

fn process_export_statement(node: Node, code: &str, meta: &mut TsMetadata) -> Result<(), String> {
    if node.child_by_field_name("source").is_some() {
        meta.has_reexports = true;
    }

    if let Some(decl) = node.child_by_field_name("declaration") {
        match decl.kind() {
            "function_declaration" => {
                if let Some(name_node) = decl.child_by_field_name("name") {
                    let name = node_text(name_node, code);
                    meta.exports.insert(name.clone());
                    meta.fn_like.insert(name.clone());
                    meta.declared.insert(name.clone());
                }
                process_function_declaration_node(decl, code, meta);
            }
            "lexical_declaration" | "variable_declaration" | "variable_statement" => {
                process_variable_declaration_node(decl, code, meta, true);
            }
            "class_declaration" => {
                if let Some(name_node) = decl.child_by_field_name("name") {
                    let name = node_text(name_node, code);
                    meta.exports.insert(name.clone());
                    meta.declared.insert(name);
                }
            }
            _ => {}
        }
    } else if let Some(clause) = node.child_by_field_name("export_clause") {
        collect_export_clause_names(clause, code, &mut meta.exports);
    }

    Ok(())
}

fn process_function_declaration_node(node: Node, code: &str, meta: &mut TsMetadata) {
    if let Some(name_node) = node.child_by_field_name("name") {
        let name = node_text(name_node, code);
        meta.declared.insert(name.clone());
        meta.fn_like.insert(name);
    }
    if let Some(params) = node.child_by_field_name("parameters") {
        let mut names = Vec::new();
        collect_binding_names(params, code, &mut names);
        for name in names {
            meta.declared.insert(name);
        }
    }
}

fn process_variable_declaration_node(
    node: Node,
    code: &str,
    meta: &mut TsMetadata,
    mark_export: bool,
) {
    let kind = node.kind();
    if kind == "variable_statement" {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if child.kind() == "variable_declaration" {
                process_variable_declaration_node(child, code, meta, mark_export);
            }
        }
        return;
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if child.kind() == "variable_declarator" {
            process_variable_declarator(child, code, meta, mark_export);
        }
    }
}

fn process_variable_declarator(node: Node, code: &str, meta: &mut TsMetadata, mark_export: bool) {
    let mut names = Vec::new();
    if let Some(name_node) = node.child_by_field_name("name") {
        collect_binding_names(name_node, code, &mut names);
    }
    for name in &names {
        meta.declared.insert(name.clone());
    }
    if mark_export {
        for name in &names {
            meta.exports.insert(name.clone());
        }
    }
    if let Some(value_node) = node.child_by_field_name("value") {
        if is_function_like_node(&value_node) {
            for name in &names {
                meta.fn_like.insert(name.clone());
            }
            collect_function_like_params(&value_node, code, &mut meta.declared);
        }
    }
}

fn collect_binding_names(node: Node, code: &str, out: &mut Vec<String>) {
    match node.kind() {
        "identifier" | "shorthand_property_identifier_pattern" | "private_property_identifier" => {
            out.push(node_text(node, code));
            return;
        }
        "rest_pattern"
        | "array_pattern"
        | "object_pattern"
        | "assignment_pattern"
        | "pair_pattern"
        | "required_parameter"
        | "optional_parameter"
        | "rest_parameter"
        | "parenthesized_parameter"
        | "formal_parameters"
        | "parameter"
        | "tuple_pattern" => {}
        _ => return,
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_binding_names(child, code, out);
    }
}

fn collect_function_like_params(node: &Node, code: &str, declared: &mut HashSet<String>) {
    if let Some(params) = node.child_by_field_name("parameters") {
        let mut names = Vec::new();
        collect_binding_names(params, code, &mut names);
        for name in names {
            declared.insert(name);
        }
    } else if let Some(param) = node.child_by_field_name("parameter") {
        let mut names = Vec::new();
        collect_binding_names(param, code, &mut names);
        for name in names {
            declared.insert(name);
        }
    }
}

fn is_function_like_node(node: &Node) -> bool {
    matches!(node.kind(), "arrow_function" | "function_expression")
}

fn collect_export_clause_names(node: Node, code: &str, exports: &mut HashSet<String>) {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "export_specifier" => {
                if let Some(alias) = child.child_by_field_name("alias") {
                    exports.insert(node_text(alias, code));
                } else if let Some(name_node) = child.child_by_field_name("name") {
                    exports.insert(node_text(name_node, code));
                } else if let Some(local) = child.child_by_field_name("local") {
                    exports.insert(node_text(local, code));
                }
            }
            "namespace_export" => {
                if let Some(name_node) = child.child_by_field_name("name") {
                    exports.insert(node_text(name_node, code));
                }
            }
            _ => {}
        }
    }
}

fn node_text(node: Node, code: &str) -> String {
    node.utf8_text(code.as_bytes())
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn detect_ts_identifier_violations(
    tree: &Tree,
    code: &str,
    declared: &HashSet<String>,
) -> HashSet<String> {
    let mut violations = HashSet::new();
    usage_traverse(tree.root_node(), code, declared, &mut violations, false);
    violations
}

fn usage_traverse(
    node: Node,
    code: &str,
    declared: &HashSet<String>,
    violations: &mut HashSet<String>,
    inside_type: bool,
) {
    let kind = node.kind();
    let next_inside_type = inside_type || is_type_context_kind(kind);

    if kind == "identifier" {
        if !inside_type && !should_ignore_identifier(&node) {
            let name = node_text(node, code);
            if !declared.contains(&name)
                && !TS_ALLOWED_GLOBALS.contains(name.as_str())
                && !name.starts_with("__")
                && name != "undefined"
            {
                violations.insert(name);
            }
        }
        return;
    }

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        usage_traverse(child, code, declared, violations, next_inside_type);
    }
}

fn is_type_context_kind(kind: &str) -> bool {
    matches!(
        kind,
        "type_annotation"
            | "type_arguments"
            | "type_parameters"
            | "type_parameter"
            | "type_alias_declaration"
            | "interface_declaration"
            | "type_identifier"
            | "predefined_type"
            | "object_type"
            | "tuple_type"
            | "union_type"
            | "intersection_type"
            | "conditional_type"
            | "indexed_access_type"
            | "implements_clause"
            | "extends_clause"
            | "infer_type"
            | "type_predicate"
    )
}

fn should_ignore_identifier(node: &Node) -> bool {
    if let Some(parent) = node.parent() {
        let parent_kind = parent.kind();
        if matches!(
            parent_kind,
            "export_specifier"
                | "namespace_export"
                | "import_specifier"
                | "named_imports"
                | "namespace_import"
                | "type_identifier"
                | "predefined_type"
                | "type_annotation"
        ) {
            return true;
        }
        if parent.child_by_field_name("property").map(|n| n.id()) == Some(node.id())
            || parent.child_by_field_name("key").map(|n| n.id()) == Some(node.id())
            || parent.child_by_field_name("label").map(|n| n.id()) == Some(node.id())
        {
            return true;
        }
    }
    false
}

static INNER_HTML_LITERAL_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?i)innerhtml\s*=\s*(?:'[^']*'|"[^"]*")"#).expect("inner html literal regex")
});
static SET_TIMEOUT_STRING_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"setTimeout\s*\(\s*(['"])"#).expect("setTimeout string regex"));
static TS_RENDER_EXPORT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?m)^\s*export\s+(?:async\s+)?(?:function|const)\s+render\b")
        .expect("ts render export regex")
});
static TS_ON_EVENT_EXPORT_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?m)^\s*export\s+(?:async\s+)?(?:function|const)\s+onEvent\b")
        .expect("ts onEvent export regex")
});
static RS_RENDER_FN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?m)^\s*pub\s+(?:async\s+)?fn\s+render\b").expect("rust render fn regex")
});
static RS_ON_EVENT_FN_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?m)^\s*pub\s+(?:async\s+)?fn\s+on[_]?event\b").expect("rust on_event fn regex")
});
static PY_RENDER_DEF_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)^\s*def\s+render\b").expect("py render def regex"));
static PY_ON_EVENT_DEF_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)^\s*def\s+on_event\b").expect("py on_event def regex"));

static TS_ALLOWED_GLOBALS: Lazy<HashSet<&'static str>> = Lazy::new(|| {
    [
        "Array",
        "ArrayBuffer",
        "BigInt",
        "Boolean",
        "DataView",
        "Date",
        "Error",
        "Infinity",
        "JSON",
        "Map",
        "Math",
        "NaN",
        "Number",
        "Object",
        "Promise",
        "RangeError",
        "RegExp",
        "Set",
        "String",
        "Symbol",
        "TypeError",
        "Uint8Array",
        "WeakMap",
        "WeakSet",
        "decodeURIComponent",
        "encodeURIComponent",
        "parseFloat",
        "parseInt",
    ]
    .into_iter()
    .collect()
});

/// Whether the task should be handled by this module.
pub fn is_codegen_task(task: &str) -> bool {
    task.starts_with(TASK_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::{ComputeCapabilitiesSpec, ComputeJobSpec, ComputeProvenanceSpec};
    use serde_json::json;

    #[test]
    fn typescript_validator_accepts_minimal_exports() {
        let code = r#"
            export function render() {
                return { html: "<div>ok</div>" };
            }

            export function onEvent() {
                return null;
            }
        "#;
        assert!(validate_code(CodeLanguage::Typescript, VALIDATOR_VERSION, code).is_ok());
    }

    #[test]
    fn typescript_validator_rejects_eval_and_missing_exports() {
        let code = r#"
            export function render() {
                return eval("console.log('nope')");
            }
        "#;
        let err = validate_code(CodeLanguage::Typescript, VALIDATOR_VERSION, code).unwrap_err();
        assert!(
            err.contains("E-UICP-1301"),
            "expected unsafe eval rejection, got {err}"
        );
    }

    #[test]
    fn typescript_validator_v1_rejects_window_usage() {
        let code = r#"
            export function render() {
                return { html: window.location.href };
            }

            export function onEvent() {
                return null;
            }
        "#;
        assert!(
            validate_code(CodeLanguage::Typescript, LEGACY_VALIDATOR_V0, code).is_ok(),
            "Legacy validator should continue to accept historical artifacts"
        );
        let err = validate_code(CodeLanguage::Typescript, VALIDATOR_VERSION, code).unwrap_err();
        assert!(
            err.contains("allowlist"),
            "expected allowlist violation, got {err}"
        );
    }

    #[test]
    fn typescript_validator_v1_allows_json_and_math() {
        let code = r#"
            export const render = (state: string) => {
                const model = JSON.parse(state || "{}");
                const score = Math.max(0, model.count ?? 0);
                return { html: `<div>${score}</div>` };
            };

            export const onEvent = (action: string, payload: string, state: string) => {
                const current = JSON.parse(state || "{}");
                const delta = action === "increment" ? 1 : -1;
                const next = { ...current, count: (current.count ?? 0) + delta };
                return { next_state: JSON.stringify(next) };
            };
        "#;
        assert!(validate_code(CodeLanguage::Typescript, VALIDATOR_VERSION, code).is_ok());
    }

    #[test]
    fn golden_key_changes_with_validator_version() {
        let spec_v1 = make_codegen_spec(None);
        let plan_v1 = build_plan(&spec_v1).expect("plan v1");
        assert_eq!(plan_v1.validator_version, VALIDATOR_VERSION);

        let spec_v0 = make_codegen_spec(Some(LEGACY_VALIDATOR_V0));
        let plan_v0 = build_plan(&spec_v0).expect("plan v0");
        assert_eq!(plan_v0.validator_version, LEGACY_VALIDATOR_V0);

        assert_ne!(
            plan_v1.golden_key, plan_v0.golden_key,
            "golden keys must differ once validator version diverges"
        );
    }

    #[test]
    fn normalize_response_sets_provider_and_model() {
        let plan = CodegenPlan {
            spec_text: "spec".into(),
            language: CodeLanguage::Python,
            constraints: Value::Null,
            validator_version: VALIDATOR_VERSION.into(),
            model_id: "o4-mini".into(),
            temperature: 0.1,
            max_output_tokens: 128,
            mock_response: None,
            mock_error: None,
            golden_key: "abc".into(),
            provider_label: "auto".into(),
            providers: vec![],
            strategy: ExecutionStrategy::SequentialFallback,
            install: None,
        };
        let raw = json!({
            "code": "def render():\n    return {}\n\ndef on_event():\n    return {}",
            "language": "python",
            "meta": {}
        });
        let normalized =
            normalize_response(&plan, ProviderKind::OpenAiApi, raw, Vec::new()).expect("normalize");
        let provider = match &normalized.meta {
            Value::Object(map) => map.get("provider").and_then(|v| v.as_str()).unwrap_or(""),
            _ => "",
        };
        assert_eq!(provider, "openai");
        let model = match &normalized.meta {
            Value::Object(map) => map.get("modelId").and_then(|v| v.as_str()).unwrap_or(""),
            _ => "",
        };
        assert_eq!(model, "o4-mini");
    }

    fn make_codegen_spec(validator: Option<&str>) -> ComputeJobSpec {
        let input = match validator {
            Some(v) => json!({
                "spec": "export const render = () => ({ html: '<div></div>' });\nexport const onEvent = () => ({ next_state: '{}' });",
                "language": "ts",
                "validatorVersion": v
            }),
            None => json!({
                "spec": "export const render = () => ({ html: '<div></div>' });\nexport const onEvent = () => ({ next_state: '{}' });",
                "language": "ts"
            }),
        };

        ComputeJobSpec {
            job_id: "00000000-0000-4000-8000-000000000002".into(),
            task: "codegen.run@0.1.0".into(),
            input,
            timeout_ms: Some(30_000),
            fuel: None,
            mem_limit_mb: None,
            bind: vec![],
            cache: "readwrite".into(),
            capabilities: ComputeCapabilitiesSpec::default(),
            replayable: true,
            workspace_id: "default".into(),
            provenance: ComputeProvenanceSpec {
                env_hash: "test-env".into(),
                agent_trace_id: None,
            },
            golden_key: None,
            artifact_id: None,
            expect_golden: false,
        }
    }
}
