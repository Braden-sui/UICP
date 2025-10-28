
use once_cell::sync::Lazy;
use parking_lot::RwLock;
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::Manager;
use url::Url;
use crate::hostctx::{PolicyMap as StorePolicyMap, PolicyStore};

// In-memory decision cache: key -> "allow" | "deny"
static POLICIES: Lazy<RwLock<HashMap<String, String>>> = Lazy::new(|| RwLock::new(HashMap::new()));

fn appdata_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn policy_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(appdata_root(app)?.join("uicp").join("permissions.json"))
}

fn set_cache(map: HashMap<String, String>) {
    let mut guard = POLICIES.write();
    *guard = map;
}

fn normalize_key(raw: &str) -> String {
    if let Some(rest) = raw.strip_prefix("api:NET:") {
        let host = rest.trim().trim_end_matches('.').to_ascii_lowercase();
        return if host.is_empty() {
            raw.to_string()
        } else {
            format!("api:NET:{}", host)
        };
    }

    if let Some(rest) = raw.strip_prefix("api:") {
        if let Some((_, origin)) = rest.split_once(':') {
            let trimmed = origin.trim();
            if trimmed.is_empty() {
                return raw.to_string();
            }

            let host = if let Ok(url) = Url::parse(trimmed) {
                url.host_str().map(|s| s.to_string()).unwrap_or_else(|| trimmed.to_string())
            } else if let Ok(url) = Url::parse(&format!("https://{}", trimmed)) {
                url.host_str().map(|s| s.to_string()).unwrap_or_else(|| trimmed.to_string())
            } else {
                trimmed.to_string()
            };

            let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
            if host.is_empty() {
                return raw.to_string();
            }
            return format!("api:NET:{}", host);
        }
    }

    raw.to_string()
}

fn parse_policies(json: &Value) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    if let Value::Object(root) = json {
        for (k, v) in root.iter() {
            let key = normalize_key(k);
            match v {
                Value::String(s) if matches!(s.as_str(), "allow" | "deny") => {
                    out.insert(key, s.clone());
                }
                Value::Object(obj) => {
                    if let Some(Value::String(dec)) = obj.get("decision") {
                        if matches!(dec.as_str(), "allow" | "deny") {
                            out.insert(key, dec.clone());
                        }
                    }
                }
                _ => {}
            }
        }
    }
    out
}

// ----------------------------------------------------------------------------
// Pure, store-based policy path for tests and host-core usage
// ----------------------------------------------------------------------------

fn load_map<S: PolicyStore + ?Sized>(store: &S) -> StorePolicyMap {
    store
        .load()
        .into_iter()
        .map(|(k, v)| (normalize_key(&k), v))
        .collect()
}

/// Pure decision using an injected PolicyStore (no global cache).
/// Returns (is_allowed, policy_label) for receipts/logging.
pub fn net_decision_with<S: PolicyStore + ?Sized>(
    store: &S,
    host: &str,
    https_only: bool,
    is_private: bool,
    is_ip: bool,
) -> (bool, String) {
    let map = load_map(store);
    let key = format!("api:NET:{}", host.to_ascii_lowercase());
    if !https_only || is_private || is_ip {
        if let Some(e) = map.get(&key) {
            if e.decision == "allow" {
                return (true, format!("user-allow:{}", key));
            }
        }
        return (false, "default-deny".into());
    }
    if let Some(e) = map.get(&key) {
        if e.decision == "deny" {
            return (false, format!("user-deny:{}", key));
        }
        if e.decision == "allow" {
            return (true, format!("user-allow:{}", key));
        }
    }
    (true, "default-allow".into())
}

/// Reload host permission policies from AppData/uicp/permissions.json into the in-memory cache.
pub fn reload_policies(app: &tauri::AppHandle) -> Result<(), String> {
    let path = policy_file_path(app)?;
    let text = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => {
            set_cache(HashMap::new());
            return Ok(());
        }
    };
    let parsed: Value =
        serde_json::from_str(&text).unwrap_or(Value::Object(serde_json::Map::new()));
    let map = parse_policies(&parsed);
    set_cache(map);
    Ok(())
}

fn allow_key(key: &str, default_allow: bool) -> bool {
    let guard = POLICIES.read();
    match guard.get(key).map(|s| s.as_str()) {
        Some("allow") => true,
        Some("deny") => false,
        _ => default_allow,
    }
}

/// compute:<taskName>@<major>
pub fn allow_compute(task_key: &str) -> bool {
    let key = format!("compute:{}", task_key);
    allow_key(&key, true)
}

/// api:NET:<host>
/// Returns (is_allowed, policy_label) for receipts/logging.
pub fn net_decision(host: &str, https_only: bool, is_private: bool, is_ip: bool) -> (bool, String) {
    let key = format!("api:NET:{}", host.to_ascii_lowercase());
    let guard = POLICIES.read();

    if !https_only || is_private || is_ip {
        match guard.get(&key).map(|s| s.as_str()) {
            Some("allow") => (true, format!("user-allow:{}", key)),
            _ => (false, "default-deny".into()),
        }
    } else {
        match guard.get(&key).map(|s| s.as_str()) {
            Some("deny") => (false, format!("user-deny:{}", key)),
            Some("allow") => (true, format!("user-allow:{}", key)),
            _ => (true, "default-allow".into()),
        }
    }
}

/// api:NET:<host>
/// Defaults: allow public HTTPS, deny LAN/IP-literal unless explicitly allowed.
pub fn allow_net(host: &str, https_only: bool, is_private: bool, is_ip: bool) -> bool {
    net_decision(host, https_only, is_private, is_ip).0
}

/// secret:<provider>:api_key
/// Defaults: allow (wire so it can be flipped later).
pub fn allow_secret(provider: &str) -> bool {
    let key = format!("secret:{}:api_key", provider.to_ascii_lowercase());
    allow_key(&key, true)
}

/// fs_dialog:<open|save> (OS dialogs). Defaults: allow.
pub fn allow_fs_dialog(kind: &str) -> bool {
    let key = format!("fs_dialog:{}", kind);
    allow_key(&key, true)
}

#[cfg(test)]
pub(crate) fn set_policy_for_test(key: &str, decision: &str) {
    let mut guard = POLICIES.write();
    guard.insert(normalize_key(key), decision.to_string());
}

#[cfg(test)]
pub(crate) fn clear_policies_for_test() {
    POLICIES.write().clear();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hostctx::{PolicyEntry, PolicyStore, PolicyMap};

    struct MapStore(pub PolicyMap);

    impl PolicyStore for MapStore {
        fn load(&self) -> PolicyMap {
            self.0.clone()
        }
    }

    #[test]
    fn net_decision_with_normalizes_get_entry() {
        let mut map = PolicyMap::new();
        map.insert(
            "api:GET:https://10.0.0.5".to_string(),
            PolicyEntry {
                decision: "allow".into(),
                duration: String::new(),
                createdAt: 0,
                sessionOnly: false,
            },
        );
        let store = MapStore(map);
        let (allowed, label) = net_decision_with(&store, "10.0.0.5", true, true, true);
        assert!(allowed);
        assert_eq!(label, "user-allow:api:NET:10.0.0.5");
    }
}
