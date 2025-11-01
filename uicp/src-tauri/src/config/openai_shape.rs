//! Configuration for the Ollama OpenAI-compatible formatting rollout flags.
//!
//! Step 0 of the OpenAI formatting migration wires three environment flags that gate
//! the upcoming adapter and streaming changes. Reading them once at startup keeps
//! downstream code fast and deterministic.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenAIShapeConfig {
    openai_shape_enabled: bool,
    openai_shape_force: bool,
    native_path_disabled: bool,
}

impl OpenAIShapeConfig {
    /// Construct a config snapshot from process environment variables.
    pub fn from_env() -> Self {
        Self {
            openai_shape_enabled: read_bool_env("UICP_OPENAI_SHAPE"),
            openai_shape_force: read_bool_env("UICP_OPENAI_FORCE"),
            native_path_disabled: read_bool_env("UICP_DISABLE_NATIVE_OLLAMA"),
        }
    }

    /// Returns true when the OpenAI-compatible request/stream shape should be preferred.
    ///
    /// FORCE takes precedence over heuristics to make the kill switch deterministic.
    pub fn should_use_openai_shape(&self) -> bool {
        self.openai_shape_enabled || self.openai_shape_force
    }

    /// Returns true when operators have explicitly forced OpenAI shape regardless of detection.
    pub fn is_force_enabled(&self) -> bool {
        self.openai_shape_force
    }

    /// Returns true when the legacy native `/api/chat` path must be disabled.
    pub fn is_native_path_disabled(&self) -> bool {
        self.native_path_disabled
    }

    /// Returns true when the feature flag was enabled without forcing.
    pub fn is_openai_shape_enabled(&self) -> bool {
        self.openai_shape_enabled
    }

    /// Human-readable summary for diagnostics.
    pub fn summary(&self) -> String {
        format!(
            "openai_shape_enabled={}, openai_shape_force={}, native_path_disabled={}",
            self.openai_shape_enabled, self.openai_shape_force, self.native_path_disabled,
        )
    }
}

fn read_bool_env(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|value| match value.trim() {
            "1" | "true" | "TRUE" | "yes" | "on" | "ON" => true,
            _ => false,
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct EnvGuard {
        key: &'static str,
        previous: Option<String>,
    }

    impl EnvGuard {
        fn set(key: &'static str, value: Option<&str>) -> Self {
            let previous = std::env::var(key).ok();
            match value {
                Some(v) => std::env::set_var(key, v),
                None => std::env::remove_var(key),
            }
            Self { key, previous }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.previous {
                Some(v) => std::env::set_var(self.key, v),
                None => std::env::remove_var(self.key),
            }
        }
    }

    #[test]
    fn defaults_to_disabled_when_env_missing() {
        let _shape = EnvGuard::set("UICP_OPENAI_SHAPE", None);
        let _force = EnvGuard::set("UICP_OPENAI_FORCE", None);
        let _native = EnvGuard::set("UICP_DISABLE_NATIVE_OLLAMA", None);

        let cfg = OpenAIShapeConfig::from_env();
        assert!(!cfg.is_openai_shape_enabled());
        assert!(!cfg.is_force_enabled());
        assert!(!cfg.is_native_path_disabled());
        assert!(!cfg.should_use_openai_shape());
    }

    #[test]
    fn interprets_truthy_values_case_insensitively() {
        let _shape = EnvGuard::set("UICP_OPENAI_SHAPE", Some("TRUE"));
        let _force = EnvGuard::set("UICP_OPENAI_FORCE", Some("on"));
        let _native = EnvGuard::set("UICP_DISABLE_NATIVE_OLLAMA", Some("1"));

        let cfg = OpenAIShapeConfig::from_env();
        assert!(cfg.is_openai_shape_enabled());
        assert!(cfg.is_force_enabled());
        assert!(cfg.is_native_path_disabled());
        assert!(cfg.should_use_openai_shape());
    }

    #[test]
    fn summary_includes_flag_states() {
        let _shape = EnvGuard::set("UICP_OPENAI_SHAPE", Some("1"));
        let _force = EnvGuard::set("UICP_OPENAI_FORCE", Some("0"));
        let _native = EnvGuard::set("UICP_DISABLE_NATIVE_OLLAMA", Some("no"));

        let summary = OpenAIShapeConfig::from_env().summary();
        assert!(summary.contains("openai_shape_enabled=true"));
        assert!(summary.contains("openai_shape_force=false"));
        assert!(summary.contains("native_path_disabled=false"));
    }
}
