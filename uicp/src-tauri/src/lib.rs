pub mod policy;

pub use policy::{
    enforce_compute_policy, ComputeBindSpec, ComputeCapabilitiesSpec, ComputeFinalErr,
    ComputeFinalOk, ComputeJobSpec, ComputePartialEvent, ComputeProvenanceSpec,
};

pub mod compute;
pub mod compute_cache;
pub mod core;
pub mod registry;

pub use core::{
    configure_sqlite, emit_or_log, ensure_default_workspace, files_dir_path, init_database,
    remove_compute_job, AppState, DATA_DIR, FILES_DIR, LOGS_DIR,
};

pub mod commands;
pub use commands::{
    clear_compute_cache, compute_call, compute_cancel, copy_into_files, get_modules_info,
    load_workspace, save_workspace,
};
use serde_json::Value;
use sha2::{Digest as Sha2Digest, Sha256 as Sha2_256};

fn canonicalize_for_key(value: &Value) -> String {
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
                    write(&Value::String(k.to_string()), out);
                    out.push(':');
                    write(map.get(k).unwrap(), out);
                }
                out.push('}');
            }
        }
    }
    let mut out = String::with_capacity(256);
    write(value, &mut out);
    out
}

#[cfg(any(
    all(feature = "wasm_compute", feature = "uicp_wasi_enable"),
    test,
    feature = "compute_harness"
))]
pub fn compute_cache_key(task: &str, input: &Value, env_hash: &str) -> String {
    let canonical = canonicalize_for_key(input);
    let mut hasher = Sha2_256::new();
    hasher.update(b"v1|");
    hasher.update(task.as_bytes());
    hasher.update(b"|env|");
    hasher.update(env_hash.as_bytes());
    hasher.update(b"|input|");
    hasher.update(canonical.as_bytes());
    hex::encode(hasher.finalize())
}

#[cfg(any(
    all(feature = "wasm_compute", feature = "uicp_wasi_enable"),
    test,
    feature = "compute_harness"
))]
mod harness;

#[cfg(any(
    all(feature = "wasm_compute", feature = "uicp_wasi_enable"),
    test,
    feature = "compute_harness"
))]
pub mod test_support {
    pub use crate::harness::ComputeTestHarness;
}
