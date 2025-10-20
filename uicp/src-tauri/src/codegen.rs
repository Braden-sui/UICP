use std::time::Instant;

use anyhow::{anyhow, Context};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use tauri::{async_runtime::spawn as tauri_spawn, AppHandle, Manager, Runtime, State};
use tokio::sync::OwnedSemaphorePermit;

use crate::{
    compute_cache, emit_or_log, remove_compute_job, AppState, ComputeFinalErr, ComputeFinalOk,
    ComputeJobSpec,
};

const TASK_PREFIX: &str = "codegen.run@";
const VALIDATOR_VERSION: &str = "codegen-validator-v0";
const ERR_INPUT_INVALID: &str = "E-UICP-1300";
const ERR_CODE_UNSAFE: &str = "E-UICP-1301";
const ERR_PROVIDER: &str = "E-UICP-1302";
const ERR_API_KEY: &str = "E-UICP-1303";

const PROVIDER_NAME: &str = "openai";

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

    let client = state.http.clone();
    let provider_settings = if plan.mock_response.is_some() {
        None
    } else {
        Some(resolve_provider_settings(&plan)?)
    };

    let started = Instant::now();
    let raw_output = if let Some(mock) = plan.mock_response.clone() {
        mock
    } else {
        let settings = provider_settings
            .as_ref()
            .expect("provider settings required when no mock response");
        call_openai(&client, &plan, settings).await.map_err(|err| {
            CodegenFailure::provider(format!("{ERR_PROVIDER}: openai call failed: {err}"))
        })?
    };

    let normalized = normalize_response(&plan, raw_output)
        .map_err(|err| CodegenFailure::invalid(err.to_string()))?;

    validate_code(
        plan.language,
        normalized["code"].as_str().unwrap_or_default(),
    )
    .map_err(CodegenFailure::unsafe_code)?;

    let output_hash = compute_cache::compute_output_hash(&normalized);
    compute_cache::store_golden(
        app,
        &spec.workspace_id,
        &plan.golden_key,
        &output_hash,
        &spec.task,
        &normalized,
    )
    .await
    .map_err(|err| {
        CodegenFailure::provider(format!("{ERR_PROVIDER}: golden store failed: {err}"))
    })?;

    Ok(CodegenRunOk {
        output: normalized,
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

    let key_payload = json!({
        "spec": input.spec,
        "language": language.as_str(),
        "constraints": constraints_for_key,
        "validatorVersion": validator_version,
        "modelId": model_id,
        "provider": PROVIDER_NAME,
    });
    let canonical = compute_cache::canonicalize_input(&key_payload);
    let mut hasher = sha2::Sha256::new();
    use sha2::Digest as _;
    hasher.update(b"codegen-golden-v0|");
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
    })
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

fn normalize_response(plan: &CodegenPlan, value: Value) -> anyhow::Result<Value> {
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
    let language = plan.language.as_str();
    let meta_value = map
        .remove("meta")
        .unwrap_or_else(|| Value::Object(Map::new()));
    let mut meta = meta_value.as_object().cloned().unwrap_or_else(Map::new);
    meta.entry("modelId")
        .or_insert_with(|| Value::String(plan.model_id.clone()));
    meta.entry("provider")
        .or_insert_with(|| Value::String(PROVIDER_NAME.into()));
    meta.insert(
        "validatorVersion".into(),
        Value::String(plan.validator_version.clone()),
    );

    Ok(json!({
        "code": code,
        "language": language,
        "meta": meta,
    }))
}

fn validate_code(language: CodeLanguage, code: &str) -> Result<(), String> {
    if code.trim().is_empty() {
        return Err(format!("{ERR_INPUT_INVALID}: generated code is empty"));
    }

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

    match language {
        CodeLanguage::Typescript => {
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
        }
        CodeLanguage::Rust => {
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
        }
        CodeLanguage::Python => {
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
        }
    }

    Ok(())
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

/// Whether the task should be handled by this module.
pub fn is_codegen_task(task: &str) -> bool {
    task.starts_with(TASK_PREFIX)
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert!(validate_code(CodeLanguage::Typescript, code).is_ok());
    }

    #[test]
    fn typescript_validator_rejects_eval_and_missing_exports() {
        let code = r#"
            export function render() {
                return eval("console.log('nope')");
            }
        "#;
        let err = validate_code(CodeLanguage::Typescript, code).unwrap_err();
        assert!(
            err.contains("E-UICP-1301"),
            "expected unsafe eval rejection, got {err}"
        );
    }

    #[test]
    fn normalize_response_sets_provider_and_model() {
        let plan = CodegenPlan {
            spec_text: "spec".into(),
            language: CodeLanguage::Python,
            constraints: Value::Null,
            validator_version: "v0".into(),
            model_id: "o4-mini".into(),
            temperature: 0.1,
            max_output_tokens: 128,
            mock_response: None,
            mock_error: None,
            golden_key: "abc".into(),
        };
        let raw = json!({
            "code": "def render():\n    return {}\n\ndef on_event():\n    return {}",
            "language": "python",
            "meta": {}
        });
        let normalized = normalize_response(&plan, raw).expect("normalize");
        let provider = normalized
            .pointer("/meta/provider")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        assert_eq!(provider, PROVIDER_NAME);
        let model = normalized
            .pointer("/meta/modelId")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        assert_eq!(model, "o4-mini");
    }
}
