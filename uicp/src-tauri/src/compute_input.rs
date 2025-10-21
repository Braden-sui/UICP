#![cfg_attr(not(feature = "wasm_compute"), allow(dead_code))]
// WHY: compute_input helpers back the wasm runtime; keep them compiling (and testable) even when
// WHY: the runtime feature is disabled without surfacing dead_code warnings during desktop builds.

use std::path::PathBuf;
#[cfg(test)]
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64_ENGINE;
use base64::Engine as _;
use sha2::{Digest as _, Sha256};

use crate::compute::error_codes;
use crate::ComputeJobSpec;

const DETAIL_CSV_INPUT: &str = "E-UICP-0401";
const DETAIL_TABLE_INPUT: &str = "E-UICP-0402";
const DETAIL_SCRIPT_INPUT: &str = "E-UICP-0406";
const DETAIL_CODEGEN_INPUT: &str = "E-UICP-0407";
const DETAIL_WS_PATH: &str = "E-UICP-0403";
const DETAIL_FS_CAP: &str = "E-UICP-0404";
const DETAIL_IO: &str = "E-UICP-0405";

#[derive(Debug, Clone)]
pub struct TaskInputError {
    pub code: &'static str,
    pub message: String,
}

impl TaskInputError {
    pub fn new(code: &'static str, detail_code: &str, message: impl Into<String>) -> Self {
        let msg = message.into();
        let composed = format!("{detail_code}: {msg}");
        Self {
            code,
            message: composed,
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(error_codes::INPUT_INVALID, DETAIL_CSV_INPUT, message)
    }
}

impl std::fmt::Display for TaskInputError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for TaskInputError {}

/// WHY: csv.parse accepts multiple casings for `hasHeader`; normalize + validate once for reuse.
/// INVARIANT: Returned source is the exact string provided and `hasHeader` defaults to true.
pub fn extract_csv_input(input: &serde_json::Value) -> Result<(String, bool), TaskInputError> {
    let obj = input
        .as_object()
        .ok_or_else(|| TaskInputError::invalid("csv.parse input must be an object"))?;
    let source = obj
        .get("source")
        .and_then(|v| v.as_str())
        .ok_or_else(|| TaskInputError::invalid("csv.parse input.source must be a string"))?
        .to_string();
    let has_header = obj
        .get("hasHeader")
        .and_then(|v| v.as_bool())
        .or_else(|| obj.get("has_header").and_then(|v| v.as_bool()))
        .or_else(|| obj.get("has-header").and_then(|v| v.as_bool()))
        .unwrap_or(true);
    Ok((source, has_header))
}

/// WHY: table.query inputs arrive from orchestrators; enforce schema + keep canonical casing.
/// INVARIANT: Returned rows retain ordering; select values are u32; where clause mirrors optional input.
pub fn extract_table_query_input(
    input: &serde_json::Value,
) -> Result<(Vec<Vec<String>>, Vec<u32>, Option<(u32, String)>), TaskInputError> {
    let obj = input.as_object().ok_or_else(|| {
        TaskInputError::new(
            error_codes::INPUT_INVALID,
            DETAIL_TABLE_INPUT,
            "table.query input must be an object",
        )
    })?;
    let rows_val = obj.get("rows").ok_or_else(|| {
        TaskInputError::new(
            error_codes::INPUT_INVALID,
            DETAIL_TABLE_INPUT,
            "table.query input.rows required",
        )
    })?;
    let rows = rows_val
        .as_array()
        .ok_or_else(|| {
            TaskInputError::new(
                error_codes::INPUT_INVALID,
                DETAIL_TABLE_INPUT,
                "table.query input.rows must be an array",
            )
        })?
        .iter()
        .map(|row| {
            let arr = row.as_array().ok_or_else(|| {
                TaskInputError::new(
                    error_codes::INPUT_INVALID,
                    DETAIL_TABLE_INPUT,
                    "table.query row must be an array",
                )
            })?;
            Ok(arr
                .iter()
                .map(|cell| cell.as_str().unwrap_or("").to_string())
                .collect::<Vec<String>>())
        })
        .collect::<Result<Vec<Vec<String>>, TaskInputError>>()?;

    let select_val = obj.get("select").ok_or_else(|| {
        TaskInputError::new(
            error_codes::INPUT_INVALID,
            DETAIL_TABLE_INPUT,
            "table.query input.select required",
        )
    })?;
    let select = select_val
        .as_array()
        .ok_or_else(|| {
            TaskInputError::new(
                error_codes::INPUT_INVALID,
                DETAIL_TABLE_INPUT,
                "table.query input.select must be an array",
            )
        })?
        .iter()
        .map(|v| {
            v.as_u64()
                .ok_or_else(|| {
                    TaskInputError::new(
                        error_codes::INPUT_INVALID,
                        DETAIL_TABLE_INPUT,
                        "table.query select entries must be non-negative integers",
                    )
                })
                .map(|u| u as u32)
        })
        .collect::<Result<Vec<u32>, TaskInputError>>()?;

    let where_opt = if let Some(w) = obj.get("where_contains") {
        if w.is_null() {
            None
        } else {
            let wobj = w.as_object().ok_or_else(|| {
                TaskInputError::new(
                    error_codes::INPUT_INVALID,
                    DETAIL_TABLE_INPUT,
                    "table.query where_contains must be an object",
                )
            })?;
            let col = wobj.get("col").and_then(|v| v.as_u64()).ok_or_else(|| {
                TaskInputError::new(
                    error_codes::INPUT_INVALID,
                    DETAIL_TABLE_INPUT,
                    "table.query where_contains.col must be u32",
                )
            })? as u32;
            let needle = wobj
                .get("needle")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    TaskInputError::new(
                        error_codes::INPUT_INVALID,
                        DETAIL_TABLE_INPUT,
                        "table.query where_contains.needle must be string",
                    )
                })?
                .to_string();
            Some((col, needle))
        }
    } else {
        None
    };

    Ok((rows, select, where_opt))
}

/// Input parser for the `script` applet world.
/// INVARIANT: Returns a normalized mode and required fields for that mode.
/// - render: requires `state` string
/// - on-event: requires `action` string, `payload` string, and `state` string
/// - init: no fields required, `state` is returned as empty string
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScriptMode {
    Render,
    OnEvent,
    Init,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptInput {
    pub mode: ScriptMode,
    pub state: String,
    pub action: Option<String>,
    pub payload: Option<String>,
    pub source: Option<String>,
}

pub fn extract_script_input(input: &serde_json::Value) -> Result<ScriptInput, TaskInputError> {
    let obj = input.as_object().ok_or_else(|| {
        TaskInputError::new(
            error_codes::INPUT_INVALID,
            DETAIL_SCRIPT_INPUT,
            "script input must be an object",
        )
    })?;
    let mode_raw = obj
        .get("mode")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            TaskInputError::new(
                error_codes::INPUT_INVALID,
                DETAIL_SCRIPT_INPUT,
                "script input.mode must be one of 'render' | 'on-event' | 'init'",
            )
        })?
        .to_ascii_lowercase();
    match mode_raw.as_str() {
        "render" => {
            let state = obj
                .get("state")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    TaskInputError::new(
                        error_codes::INPUT_INVALID,
                        DETAIL_SCRIPT_INPUT,
                        "script render requires state (string)",
                    )
                })?
                .to_string();
            Ok(ScriptInput {
                mode: ScriptMode::Render,
                state,
                action: None,
                payload: None,
                source: obj
                    .get("source")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            })
        }
        "on-event" => {
            let action = obj
                .get("action")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    TaskInputError::new(
                        error_codes::INPUT_INVALID,
                        DETAIL_SCRIPT_INPUT,
                        "script on-event requires action (string)",
                    )
                })?
                .to_string();
            let payload = obj
                .get("payload")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    TaskInputError::new(
                        error_codes::INPUT_INVALID,
                        DETAIL_SCRIPT_INPUT,
                        "script on-event requires payload (string)",
                    )
                })?
                .to_string();
            let state = obj
                .get("state")
                .and_then(|v| v.as_str())
                .ok_or_else(|| {
                    TaskInputError::new(
                        error_codes::INPUT_INVALID,
                        DETAIL_SCRIPT_INPUT,
                        "script on-event requires state (string)",
                    )
                })?
                .to_string();
            Ok(ScriptInput {
                mode: ScriptMode::OnEvent,
                state,
                action: Some(action),
                payload: Some(payload),
                source: obj
                    .get("source")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            })
        }
        "init" => Ok(ScriptInput {
            mode: ScriptMode::Init,
            state: String::new(),
            action: None,
            payload: None,
            source: obj
                .get("source")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
        }),
        _ => Err(TaskInputError::new(
            error_codes::INPUT_INVALID,
            DETAIL_SCRIPT_INPUT,
            format!("unsupported script mode: {mode_raw}"),
        )),
    }
}

/// WHY: Workspace paths must remain inside `files_dir_path`; reject traversal or malformed segments.
/// INVARIANT: Successful result always resides under FILES_DIR (existing or future file).
pub fn sanitize_ws_files_path(ws_path: &str) -> Result<PathBuf, TaskInputError> {
    let prefix = "ws:/files/";
    if !ws_path.starts_with(prefix) {
        return Err(TaskInputError::new(
            error_codes::IO_DENIED,
            DETAIL_WS_PATH,
            "path must start with ws:/files/",
        ));
    }
    let rel = &ws_path[prefix.len()..];
    if rel.is_empty() {
        return Err(TaskInputError::new(
            error_codes::IO_DENIED,
            DETAIL_WS_PATH,
            "path missing trailing file segment",
        ));
    }
    let base = crate::files_dir_path();
    let base_canonical = base.canonicalize().map_err(|err| {
        TaskInputError::new(
            error_codes::IO_DENIED,
            DETAIL_WS_PATH,
            format!("files directory unavailable: {err}"),
        )
    })?;
    let mut buf = PathBuf::from(base);
    for seg in rel.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return Err(TaskInputError::new(
                error_codes::IO_DENIED,
                DETAIL_WS_PATH,
                "parent traversal not allowed",
            ));
        }
        if seg.contains('\\') {
            return Err(TaskInputError::new(
                error_codes::IO_DENIED,
                DETAIL_WS_PATH,
                "invalid separator in path",
            ));
        }
        buf.push(seg);
    }
    let candidate = buf;
    match candidate.canonicalize() {
        Ok(canonical) => {
            if !canonical.starts_with(&base_canonical) {
                return Err(TaskInputError::new(
                    error_codes::IO_DENIED,
                    DETAIL_WS_PATH,
                    "path escapes workspace files directory",
                ));
            }
            Ok(candidate)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            if let Some(parent) = candidate.parent() {
                if let Ok(parent_canon) = parent.canonicalize() {
                    if !parent_canon.starts_with(&base_canonical) {
                        return Err(TaskInputError::new(
                            error_codes::IO_DENIED,
                            DETAIL_WS_PATH,
                            "path escapes workspace files directory",
                        ));
                    }
                }
            }
            Ok(candidate)
        }
        Err(err) => Err(TaskInputError::new(
            error_codes::IO_DENIED,
            DETAIL_WS_PATH,
            format!("canonicalize failed: {err}"),
        )),
    }
}

/// WHY: Capabilities gate ensures harness + host agree on allowed workspace reads.
/// INVARIANT: Supports literal and `/**` glob suffix pattern.
pub fn fs_read_allowed(spec: &ComputeJobSpec, ws_path: &str) -> bool {
    if spec.capabilities.fs_read.is_empty() {
        return false;
    }
    for pat in spec.capabilities.fs_read.iter() {
        let p = pat.as_str();
        if let Some(base) = p.strip_suffix("/**") {
            if ws_path.starts_with(base) {
                return true;
            }
        } else if p == ws_path {
            return true;
        }
    }
    false
}

/// WHY: Convert workspace references to data URIs eagerly so downstream caching sees canonical input.
/// INVARIANT: Returns unchanged source for non-`ws:/files/` strings.
pub fn resolve_csv_source(spec: &ComputeJobSpec, source: &str) -> Result<String, TaskInputError> {
    if !source.starts_with("ws:/files/") {
        return Ok(source.to_string());
    }
    if !fs_read_allowed(spec, source) {
        return Err(TaskInputError::new(
            error_codes::CAPABILITY_DENIED,
            DETAIL_FS_CAP,
            "fs_read does not allow this path",
        ));
    }
    let host_path = sanitize_ws_files_path(source)?;
    match std::fs::read(host_path) {
        Ok(bytes) => Ok(format!(
            "data:text/csv;base64,{}",
            BASE64_ENGINE.encode(bytes)
        )),
        Err(err) => Err(TaskInputError::new(
            error_codes::IO_DENIED,
            DETAIL_IO,
            format!("read failed: {err}"),
        )),
    }
}

/// WHY: Seeds must be stable across replays regardless of platform, feature flags, or pipelines.
/// INVARIANT: Same (job_id, env_hash) => same seed; changing either flips the digest.
pub fn derive_job_seed(job_id: &str, env_hash: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"UICP-SEED\x00");
    hasher.update(job_id.as_bytes());
    hasher.update(b"|");
    hasher.update(env_hash.as_bytes());
    hasher.finalize().into()
}

fn canonicalize_codegen_input(input: &serde_json::Value) -> Result<serde_json::Value, TaskInputError> {
    let obj = input.as_object().ok_or_else(|| {
        TaskInputError::new(
            error_codes::INPUT_INVALID,
            DETAIL_CODEGEN_INPUT,
            "needs.code input must be an object",
        )
    })?;

    let spec_text = obj
        .get("spec")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            TaskInputError::new(
                error_codes::INPUT_INVALID,
                DETAIL_CODEGEN_INPUT,
                "needs.code spec must be a non-empty string",
            )
        })?
        .to_string();

    let language_raw = obj
        .get("language")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("ts");
    let language_normalized = match language_raw.to_ascii_lowercase().as_str() {
        "ts" | "tsx" | "typescript" => "ts",
        "rust" | "rs" => "rust",
        "python" | "py" => "python",
        other => {
            return Err(TaskInputError::new(
                error_codes::INPUT_INVALID,
                DETAIL_CODEGEN_INPUT,
                format!("needs.code language '{other}' unsupported"),
            ))
        }
    };

    let constraints_value = match obj.get("constraints") {
        Some(serde_json::Value::Object(map)) => serde_json::Value::Object(map.clone()),
        Some(serde_json::Value::Null) | None => serde_json::Value::Object(serde_json::Map::new()),
        Some(_) => {
            return Err(TaskInputError::new(
                error_codes::INPUT_INVALID,
                DETAIL_CODEGEN_INPUT,
                "needs.code constraints must be an object",
            ))
        }
    };

    let caps_value = match obj.get("caps") {
        Some(serde_json::Value::Object(map)) => serde_json::Value::Object(map.clone()),
        Some(serde_json::Value::Null) | None => serde_json::Value::Object(serde_json::Map::new()),
        Some(_) => {
            return Err(TaskInputError::new(
                error_codes::INPUT_INVALID,
                DETAIL_CODEGEN_INPUT,
                "needs.code caps must be an object",
            ))
        }
    };

    let provider_normalized = obj
        .get("provider")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "auto".to_string());
    let provider_value = match provider_normalized.as_str() {
        "auto" | "" => "auto",
        "codex" => "codex",
        "claude" => "claude",
        other => {
            return Err(TaskInputError::new(
                error_codes::INPUT_INVALID,
                DETAIL_CODEGEN_INPUT,
                format!("needs.code provider '{other}' unsupported"),
            ))
        }
    };

    let mut providers_list: Vec<String> = Vec::new();
    if let Some(arr) = obj.get("providers").and_then(|v| v.as_array()) {
        for entry in arr {
            if let Some(raw) = entry.as_str() {
                let candidate = raw.trim().to_ascii_lowercase();
                let allowed = matches!(candidate.as_str(), "codex" | "claude");
                if allowed && !providers_list.iter().any(|existing| existing == &candidate) {
                    providers_list.push(candidate);
                }
            }
        }
    }
    if providers_list.len() > 2 {
        providers_list.truncate(2);
    }

    let strategy_value = obj
        .get("strategy")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "sequential-fallback".to_string());
    let strategy_normalized = match strategy_value.as_str() {
        "sequential-fallback" => "sequential-fallback",
        "first-ok" => "first-ok",
        "best-of-both" => "best-of-both",
        other => {
            return Err(TaskInputError::new(
                error_codes::INPUT_INVALID,
                DETAIL_CODEGEN_INPUT,
                format!("needs.code strategy '{other}' unsupported"),
            ))
        }
    };

    let coerce_string = |key: &str| -> Option<String> {
        obj.get(key)
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
    };

    let cache_policy = obj.get("cachePolicy").and_then(|v| v.as_str()).map(|s| s.trim());
    let cache_policy_normalized = match cache_policy {
        Some("readwrite") | Some("readOnly") | Some("bypass") => cache_policy.map(|s| s.to_string()),
        Some(other) => {
            return Err(TaskInputError::new(
                error_codes::INPUT_INVALID,
                DETAIL_CODEGEN_INPUT,
                format!("needs.code cachePolicy '{other}' unsupported"),
            ))
        }
        None => None,
    };

    let install_value = match obj.get("install") {
        Some(serde_json::Value::Object(map)) => {
            let panel_id = map
                .get("panelId")
                .and_then(|v| v.as_str())
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    TaskInputError::new(
                        error_codes::INPUT_INVALID,
                        DETAIL_CODEGEN_INPUT,
                        "needs.code install.panelId required when install is provided",
                    )
                })?;
            let window_id = map
                .get("windowId")
                .and_then(|v| v.as_str())
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    TaskInputError::new(
                        error_codes::INPUT_INVALID,
                        DETAIL_CODEGEN_INPUT,
                        "needs.code install.windowId required when install is provided",
                    )
                })?;
            let target = map
                .get("target")
                .and_then(|v| v.as_str())
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| {
                    TaskInputError::new(
                        error_codes::INPUT_INVALID,
                        DETAIL_CODEGEN_INPUT,
                        "needs.code install.target required when install is provided",
                    )
                })?;
            let state_key = map
                .get("stateKey")
                .and_then(|v| v.as_str())
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let mut install_map = serde_json::Map::new();
            install_map.insert("panelId".into(), serde_json::Value::String(panel_id.to_string()));
            install_map.insert("windowId".into(), serde_json::Value::String(window_id.to_string()));
            install_map.insert("target".into(), serde_json::Value::String(target.to_string()));
            if let Some(sk) = state_key {
                install_map.insert("stateKey".into(), serde_json::Value::String(sk));
            }
            Some(serde_json::Value::Object(install_map))
        }
        Some(_) => {
            return Err(TaskInputError::new(
                error_codes::INPUT_INVALID,
                DETAIL_CODEGEN_INPUT,
                "needs.code install must be an object when present",
            ))
        }
        None => None,
    };

    let mut normalized = serde_json::Map::new();
    normalized.insert("spec".into(), serde_json::Value::String(spec_text));
    normalized.insert(
        "language".into(),
        serde_json::Value::String(language_normalized.to_string()),
    );
    normalized.insert("constraints".into(), constraints_value);
    normalized.insert("caps".into(), caps_value);
    normalized.insert("provider".into(), serde_json::Value::String(provider_value.to_string()));
    if !providers_list.is_empty() {
        normalized.insert(
            "providers".into(),
            serde_json::Value::Array(
                providers_list
                    .into_iter()
                    .map(|p| serde_json::Value::String(p))
                    .collect(),
            ),
        );
    }
    normalized.insert(
        "strategy".into(),
        serde_json::Value::String(strategy_normalized.to_string()),
    );
    if let Some(value) = coerce_string("artifactId") {
        normalized.insert("artifactId".into(), serde_json::Value::String(value));
    }
    if let Some(value) = coerce_string("goldenKey") {
        normalized.insert("goldenKey".into(), serde_json::Value::String(value));
    }
    if let Some(value) = coerce_string("progressWindowId") {
        normalized.insert("progressWindowId".into(), serde_json::Value::String(value));
    }
    if let Some(value) = coerce_string("progressSelector") {
        normalized.insert("progressSelector".into(), serde_json::Value::String(value));
    }
    if let Some(policy) = cache_policy_normalized {
        normalized.insert("cachePolicy".into(), serde_json::Value::String(policy));
    }
    if let Some(install) = install_value {
        normalized.insert("install".into(), install);
    }

    Ok(serde_json::Value::Object(normalized))
}

/// WHY: Normalize task input so caching + runtime share the same canonical payload.
/// INVARIANT: Unknown tasks pass through unchanged.
#[cfg_attr(not(any(test, feature = "compute_harness")), allow(dead_code))]
pub fn canonicalize_task_input(spec: &ComputeJobSpec) -> Result<serde_json::Value, TaskInputError> {
    let task_name = spec.task.split('@').next().unwrap_or("");
    match task_name {
        "csv.parse" => {
            let (source, has_header) = extract_csv_input(&spec.input)?;
            let resolved = resolve_csv_source(spec, &source)?;
            Ok(serde_json::json!({
                "source": resolved,
                "hasHeader": has_header,
            }))
        }
        "table.query" => {
            let (rows, select, where_opt) = extract_table_query_input(&spec.input)?;
            let mut obj = serde_json::json!({
                "rows": rows,
                "select": select,
            });
            if let Some((col, needle)) = where_opt {
                // SAFETY: json! macro with object literal always creates Value::Object
                obj.as_object_mut()
                    .expect("json! object literal must be Value::Object")
                    .insert(
                        "where_contains".into(),
                        serde_json::json!({ "col": col, "needle": needle }),
                    );
            }
            Ok(obj)
        }
        "codegen.run" => canonicalize_codegen_input(&spec.input),
        _ => Ok(spec.input.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base_spec() -> ComputeJobSpec {
        ComputeJobSpec {
            job_id: "00000000-0000-4000-8000-000000000002".into(),
            task: "csv.parse@1.2.0".into(),
            input: json!({}),
            timeout_ms: Some(Duration::from_secs(1).as_millis() as u64),
            fuel: None,
            mem_limit_mb: None,
            bind: vec![],
            cache: "readwrite".into(),
            capabilities: crate::policy::ComputeCapabilitiesSpec {
                fs_read: vec![],
                fs_write: vec![],
                net: vec![],
                long_run: false,
                mem_high: false,
            },
            replayable: true,
            workspace_id: "default".into(),
            provenance: crate::policy::ComputeProvenanceSpec {
                env_hash: "env-hash".into(),
                agent_trace_id: None,
            },
            golden_key: None,
            artifact_id: None,
            expect_golden: false,
        }
    }

    #[test]
    fn extract_csv_input_supports_has_header_variants() {
        let v1 = serde_json::json!({"source":"x","hasHeader":true});
        let (s1, h1) = extract_csv_input(&v1).unwrap();
        assert_eq!(s1, "x");
        assert!(h1);

        let v2 = serde_json::json!({"source":"y","has-header":false});
        let (s2, h2) = extract_csv_input(&v2).unwrap();
        assert_eq!(s2, "y");
        assert!(!h2);
    }

    #[test]
    fn extract_table_query_input_parses_rows_select_and_where() {
        let v = serde_json::json!({
            "rows": [["a","b"],["c","d"]],
            "select": [1u32,0u32],
            "where_contains": {"col": 0u32, "needle": "a"}
        });
        let (rows, sel, where_opt) = extract_table_query_input(&v).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], vec!["a".to_string(), "b".to_string()]);
        assert_eq!(sel, vec![1u32, 0u32]);
        assert_eq!(where_opt, Some((0u32, "a".into())));
    }

    #[test]
    fn extract_script_input_captures_source_when_present() {
        let v = serde_json::json!({
            "mode": "render",
            "state": "{}",
            "source": "export function render(state){ return state; }"
        });
        let script = extract_script_input(&v).expect("script input");
        assert_eq!(script.mode, ScriptMode::Render);
        assert_eq!(script.state, "{}");
        assert_eq!(
            script.source.as_deref(),
            Some("export function render(state){ return state; }")
        );
    }

    #[test]
    fn derive_job_seed_is_stable_and_unique_per_env() {
        let a1 = derive_job_seed("00000000-0000-4000-8000-000000000001", "env-a");
        let a2 = derive_job_seed("00000000-0000-4000-8000-000000000001", "env-a");
        let b = derive_job_seed("00000000-0000-4000-8000-000000000002", "env-a");
        let c = derive_job_seed("00000000-0000-4000-8000-000000000001", "env-b");
        assert_eq!(a1, a2, "seed must be deterministic for same (job, env)");
        assert_ne!(a1, b, "seed must vary across job ids");
        assert_ne!(a1, c, "seed must vary across env hashes");
    }

    #[test]
    fn sanitize_ws_paths_blocks_traversal_and_maps_under_files_dir() {
        let base = crate::files_dir_path();
        let _ = std::fs::create_dir_all(base);
        let ok = sanitize_ws_files_path("ws:/files/some/dir/data.csv").expect("ok");
        assert!(ok.starts_with(base));

        let err = sanitize_ws_files_path("/absolute/bad").unwrap_err();
        assert!(err.message.contains("ws:/files"));

        let err = sanitize_ws_files_path("ws:/files/../../escape").unwrap_err();
        assert!(err.message.contains("parent traversal"));

        let err = sanitize_ws_files_path("ws:/files/bad\\slash.csv").unwrap_err();
        assert!(err.message.contains("invalid separator"));
    }

    #[test]
    fn resolve_source_ws_and_plain() {
        let mut spec = base_spec();
        let s = resolve_csv_source(&spec, "data:text/csv,hello").expect("ok");
        assert_eq!(s, "data:text/csv,hello");

        spec.capabilities.fs_read = vec!["ws:/files/**".into()];
        let base = crate::files_dir_path();
        let _ = std::fs::create_dir_all(base);
        let f = base.join("u_test_compute.csv");
        std::fs::write(&f, b"a,b\n1,2\n").expect("write");
        let out = resolve_csv_source(&spec, "ws:/files/u_test_compute.csv").expect("ok");
        assert!(out.starts_with("data:text/csv;base64,"));
        let _ = std::fs::remove_file(&f);
    }

    #[test]
    fn fs_read_allowed_matches_exact_and_glob() {
        let mut spec = base_spec();
        assert!(!fs_read_allowed(&spec, "ws:/files/foo.csv"));
        spec.capabilities.fs_read = vec!["ws:/files/**".into()];
        assert!(fs_read_allowed(&spec, "ws:/files/foo/bar.csv"));
        spec.capabilities.fs_read = vec!["ws:/files/a.csv".into()];
        assert!(fs_read_allowed(&spec, "ws:/files/a.csv"));
        assert!(!fs_read_allowed(&spec, "ws:/files/b.csv"));
    }

    #[test]
    fn canonicalize_csv_input_normalizes_shape() {
        let base = crate::files_dir_path();
        let _ = std::fs::create_dir_all(base);
        std::fs::write(base.join("norm.csv"), b"a,b\n1,2\n").unwrap();
        let mut spec = base_spec();
        spec.capabilities.fs_read = vec!["ws:/files/**".into()];
        spec.input = json!({"source":"ws:/files/norm.csv","has_header":true});

        let normalized = canonicalize_task_input(&spec).unwrap();
        assert_eq!(normalized["hasHeader"], json!(true));
        assert!(normalized["source"]
            .as_str()
            .unwrap()
            .starts_with("data:text/csv;base64,"));
    }

    #[test]
    fn canonicalize_table_query_preserves_semantics() {
        let mut spec = base_spec();
        spec.task = "table.query@0.1.0".into();
        spec.input = json!({
            "rows": [["a","b"],["c","d"]],
            "select": [1, 0],
            "where_contains": {"col": 1, "needle": "d"}
        });
        let normalized = canonicalize_task_input(&spec).unwrap();
        assert_eq!(normalized["rows"].as_array().unwrap().len(), 2);
        assert_eq!(normalized["select"], json!([1, 0]));
        assert_eq!(normalized["where_contains"], json!({"col":1,"needle":"d"}));
    }

    #[test]
    fn canonicalize_csv_rejects_disallowed_ws_path() {
        let mut spec = base_spec();
        spec.input = json!({"source":"ws:/files/blocked.csv","hasHeader":true});
        spec.capabilities.fs_read = vec![];
        let err = canonicalize_task_input(&spec).unwrap_err();
        assert_eq!(err.code, crate::compute::error_codes::CAPABILITY_DENIED);
        assert!(
            err.message.contains("E-UICP-0404"),
            "expected capability error code detail"
        );
    }

    #[test]
    fn canonicalize_codegen_normalizes_provider_and_strategy() {
        let mut spec = base_spec();
        spec.task = "codegen.run@0.1.0".into();
        spec.input = json!({
            "spec": "export const demo = () => null;",
            "language": "TS",
            "provider": "claude",
            "providers": ["codex", "claude", "codex"],
            "strategy": "best-of-both",
            "constraints": { "maxTokens": 256 },
            "caps": { "net": ["https://api.anthropic.com"] },
            "install": {
                "panelId": "panel-demo",
                "windowId": "demo-window",
                "target": "#root",
            },
        });

        let normalized = canonicalize_task_input(&spec).expect("normalize");
        assert_eq!(
            normalized
                .get("language")
                .and_then(|v| v.as_str())
                .unwrap_or_default(),
            "ts"
        );
        assert_eq!(
            normalized
                .get("provider")
                .and_then(|v| v.as_str())
                .unwrap_or_default(),
            "claude"
        );
        let providers = normalized
            .get("providers")
            .and_then(|v| v.as_array())
            .expect("providers array");
        assert_eq!(providers.len(), 2);
        assert_eq!(providers[0].as_str(), Some("codex"));
        assert_eq!(providers[1].as_str(), Some("claude"));
        assert_eq!(
            normalized
                .get("strategy")
                .and_then(|v| v.as_str())
                .unwrap_or_default(),
            "best-of-both"
        );
        let install = normalized
            .get("install")
            .and_then(|v| v.as_object())
            .expect("install present");
        assert_eq!(install.get("panelId").and_then(|v| v.as_str()), Some("panel-demo"));
        assert_eq!(install.get("windowId").and_then(|v| v.as_str()), Some("demo-window"));
        assert_eq!(install.get("target").and_then(|v| v.as_str()), Some("#root"));
    }

    #[test]
    fn canonicalize_codegen_rejects_invalid_provider() {
        let mut spec = base_spec();
        spec.task = "codegen.run@0.1.0".into();
        spec.input = json!({
            "spec": "export const demo = () => null;",
            "language": "ts",
            "provider": "watson",
        });
        let err = canonicalize_task_input(&spec).unwrap_err();
        assert_eq!(err.code, crate::compute::error_codes::INPUT_INVALID);
        assert!(
            err.message.contains(DETAIL_CODEGEN_INPUT),
            "expected codegen detail tag"
        );
    }
}
