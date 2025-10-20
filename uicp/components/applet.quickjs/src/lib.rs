//! applet.quickjs@0.1.0 component entrypoint.
//! Executes bundled JavaScript (compiled via build-applet.mjs) inside a sandboxed interpreter.

#![allow(clippy::missing_errors_doc)]

mod bindings;

use base64::engine::general_purpose::STANDARD as BASE64_ENGINE;
use base64::Engine as _;
use bindings::export;
#[allow(unused_imports)]
use bindings::exports;
use bindings::exports::uicp::applet_script::script::Guest;
use boa_engine::{context::ContextBuilder, Source};
use once_cell::sync::OnceCell;

const ENV_SOURCE_B64: &str = "UICP_SCRIPT_SOURCE_B64";
const EXPORT_GLOBAL: &str = "__uicpApplet";

#[derive(Clone, Copy)]
enum ScriptFunc<'a> {
    Init,
    Render { state: &'a str },
    OnEvent {
        action: &'a str,
        payload: &'a str,
        state: &'a str,
    },
}

struct Component;

impl Component {
    fn script_source() -> Result<&'static str, String> {
        static SOURCE: OnceCell<String> = OnceCell::new();
        SOURCE
            .get_or_try_init(|| {
                let encoded = std::env::var(ENV_SOURCE_B64)
                    .map_err(|_| format!("JS source missing (expected {ENV_SOURCE_B64} env var)"))?;
                let decoded = BASE64_ENGINE
                    .decode(encoded.trim())
                    .map_err(|err| format!("invalid base64 in {ENV_SOURCE_B64}: {err}"))?;
                String::from_utf8(decoded)
                    .map_err(|err| format!("JS source not utf8 after decode: {err}"))
            })
            .map(|s| s.as_str())
    }

    fn call(func: ScriptFunc<'_>) -> Result<String, String> {
        let source = Self::script_source()?;
        let mut context = ContextBuilder::new().build().map_err(|err| {
            format!(
                "E-UICP-0600: failed to construct JS context: {err}",
            )
        })?;

        context
            .eval(Source::from_bytes(source.as_bytes()))
            .map_err(|err| format!("E-UICP-0601: evaluating bundled script failed: {err}"))?;

        let (fn_name, args) = match func {
            ScriptFunc::Init => ("init", Vec::new()),
            ScriptFunc::Render { state } => (
                "render",
                vec![Self::js_string_literal(state)],
            ),
            ScriptFunc::OnEvent {
                action,
                payload,
                state,
            } => (
                "onEvent",
                vec![
                    Self::js_string_literal(action),
                    Self::js_string_literal(payload),
                    Self::js_string_literal(state),
                ],
            ),
        };

        let call_expr = Self::build_call_expr(fn_name, &args);

        let value = context
            .eval(Source::from_bytes(call_expr.as_bytes()))
            .map_err(|err| {
                let func_name = match func {
                    ScriptFunc::Init => "init",
                    ScriptFunc::Render { .. } => "render",
                    ScriptFunc::OnEvent { .. } => "onEvent",
                };
                format!("E-UICP-0602: calling {func_name} failed: {err}")
            })?;

        value
            .to_string(&mut context)
            .map_err(|err| format!("E-UICP-0603: stringify JS result failed: {err}"))
            .map(|s| s.to_std_string().unwrap_or_default())
    }

    fn js_string_literal(value: &str) -> String {
        serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into())
    }

    fn build_call_expr(func_name: &str, args: &[String]) -> String {
        let joined = if args.is_empty() {
            String::new()
        } else {
            args.join(", ")
        };
        format!(
            "(function() {{
                const host = globalThis.{g};
                if (!host || typeof host.{func} !== 'function') {{ return undefined; }}
                const result = host.{func}({args});
                if (typeof result === 'string') {{ return result; }}
                try {{
                    return JSON.stringify(result);
                }} catch (_) {{
                    return String(result);
                }}
            }})()",
            g = EXPORT_GLOBAL,
            func = func_name,
            args = joined
        )
    }
}

impl Guest for Component {
    fn render(state: String) -> Result<String, String> {
        Self::call(ScriptFunc::Render { state: &state })
    }

    fn on_event(action: String, payload: String, state: String) -> Result<String, String> {
        Self::call(ScriptFunc::OnEvent {
            action: &action,
            payload: &payload,
            state: &state,
        })
    }

    fn init() -> Result<String, String> {
        Self::call(ScriptFunc::Init)
    }
}

export!(Component);
