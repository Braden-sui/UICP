#[cfg(test)]
use parking_lot::RwLock;
use std::{collections::HashMap, path::PathBuf, sync::Arc};

use reqwest::Client;
use serde_json::Value;

use crate::infrastructure::action_log::ActionLogHandle;

pub type PolicyMap = HashMap<String, PolicyEntry>;

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub struct PolicyEntry {
    pub decision: String, // "allow" | "deny"
    #[serde(default, alias = "duration")]
    pub duration: String, // "session" | "forever" | ""
    #[serde(default, alias = "createdAt")]
    pub created_at: i64,
    #[serde(default, alias = "sessionOnly")]
    pub session_only: bool,
}

pub trait PolicyStore: Send + Sync {
    fn load(&self) -> PolicyMap;
}

pub trait ReceiptSink: Send + Sync {
    fn append(&self, kind: &str, value: &Value);
}

// Default file-based policy store (reads permissions.json)
pub struct FilePolicyStore {
    pub appdata_root: PathBuf,
}

impl PolicyStore for FilePolicyStore {
    fn load(&self) -> PolicyMap {
        let p = self.appdata_root.join("uicp").join("permissions.json");
        let txt = match std::fs::read_to_string(&p) {
            Ok(s) => s,
            Err(_) => return PolicyMap::new(),
        };
        let parsed: Value = serde_json::from_str(&txt).unwrap_or(Value::Null);
        let mut out: PolicyMap = PolicyMap::new();
        if let Value::Object(root) = parsed {
            for (k, v) in root.into_iter() {
                match v {
                    Value::String(s) if matches!(s.as_str(), "allow" | "deny") => {
                        out.insert(
                            k,
                            PolicyEntry {
                                decision: s,
                                duration: String::new(),
                                created_at: 0,
                                session_only: false,
                            },
                        );
                    }
                    Value::Object(obj) => {
                        let decision = obj
                            .get("decision")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                            .unwrap_or_default();
                        if decision == "allow" || decision == "deny" {
                            let duration = obj
                                .get("duration")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let created_at =
                                obj.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(0);
                            let session_only = obj
                                .get("sessionOnly")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);
                            out.insert(
                                k,
                                PolicyEntry {
                                    decision,
                                    duration,
                                    created_at,
                                    session_only,
                                },
                            );
                        }
                    }
                    _ => {}
                }
            }
        }
        out
    }
}

// Default sink that forwards to action_log (fire-and-forget)
pub struct ActionLogSink {
    pub action_log: ActionLogHandle,
}

impl ReceiptSink for ActionLogSink {
    fn append(&self, kind: &str, value: &Value) {
        let kind = kind.to_string();
        let payload = value.clone();
        let handle = self.action_log.clone();
        tauri::async_runtime::spawn(async move {
            let _ = handle.append_json(&kind, &payload).await;
        });
    }
}

#[derive(Clone)]
pub struct HostCtx {
    pub http: Client,
    pub policy: Arc<dyn PolicyStore>,
    pub receipts: Arc<dyn ReceiptSink>,
    pub limits: Limits,
}

#[derive(Clone, Copy)]
pub struct Limits {
    pub resp_max_bytes: usize,
    #[allow(dead_code)]
    pub rps_default: f64,
    #[allow(dead_code)]
    pub burst: f64,
    #[allow(dead_code)]
    pub conc_max: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            resp_max_bytes: 50 * 1024 * 1024,
            rps_default: 5.0,
            burst: 10.0,
            conc_max: 10,
        }
    }
}

impl HostCtx {
    pub fn from_app(state: &crate::AppState, appdata_root: PathBuf) -> Self {
        Self {
            http: state.http.clone(),
            policy: Arc::new(FilePolicyStore { appdata_root }),
            receipts: Arc::new(ActionLogSink {
                action_log: state.action_log.clone(),
            }),
            limits: Limits::default(),
        }
    }

    #[cfg(test)]
    // Test helper
    pub fn test(
        http: Client,
        policy: Arc<dyn PolicyStore>,
        receipts: Arc<dyn ReceiptSink>,
        limits: Limits,
    ) -> Self {
        Self {
            http,
            policy,
            receipts,
            limits,
        }
    }
}

#[cfg(test)]
// In-memory receipt sink for tests
pub struct InMemorySink(pub Arc<RwLock<Vec<(String, Value)>>>);

#[cfg(test)]
impl ReceiptSink for InMemorySink {
    fn append(&self, kind: &str, value: &Value) {
        self.0.write().push((kind.to_string(), value.clone()));
    }
}
