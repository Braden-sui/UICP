use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use parking_lot::Mutex;
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::authz::net_decision_with;
use crate::hostctx::HostCtx;
use crate::{
    net::{is_ip_literal as net_is_ip_literal, is_private_ip as net_is_private_ip, parse_host},
    AppState,
};

#[derive(Clone, Copy)]
struct Bucket {
    tokens: f64,
    last: Instant,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authz::{clear_policies_for_test, net_decision, set_policy_for_test};
    use crate::hostctx::{HostCtx, InMemorySink, Limits, PolicyEntry, PolicyMap, PolicyStore};
    use httpmock::MockServer;
    use parking_lot::RwLock;
    use std::sync::Arc;

    #[test]
    fn rate_limit_blocks_after_burst() {
        std::env::set_var("UICP_EGRESS_BURST", "1");
        std::env::set_var("UICP_EGRESS_RPS_DEFAULT", "1");
        reset_limiters_for_test();
        let installed = "app1";
        let host = "example.com";
        assert!(rate_limit_take(installed, host).is_ok());
        let err = rate_limit_take(installed, host).unwrap_err();
        assert_eq!(err, "RateLimited");
        reset_limiters_for_test();
        std::env::remove_var("UICP_EGRESS_BURST");
        std::env::remove_var("UICP_EGRESS_RPS_DEFAULT");
    }

    #[test]
    fn concurrency_limit_blocks_when_full() {
        std::env::set_var("UICP_EGRESS_CONCURRENCY_MAX", "1");
        reset_limiters_for_test();
        let installed = "app1";
        let host = "example.com";
        assert!(conc_enter(installed, host).is_ok());
        let err = conc_enter(installed, host).unwrap_err();
        assert_eq!(err, "ConcurrencyLimited");
        conc_leave(installed, host);
        reset_limiters_for_test();
        std::env::remove_var("UICP_EGRESS_CONCURRENCY_MAX");
    }

    #[test]
    fn sha256_is_hex_64chars() {
        let digest = body_sha256(b"hello world");
        assert_eq!(digest.len(), 64);
        assert!(digest.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(
            digest,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[test]
    fn policy_labels_default_and_user_allow() {
        clear_policies_for_test();
        let (allow, label) = net_decision("example.com", true, false, false);
        assert!(allow);
        assert_eq!(label, "default-allow");

        set_policy_for_test("api:NET:example.com", "allow");
        let (allow, label) = net_decision("example.com", true, false, false);
        assert!(allow);
        assert_eq!(label, "user-allow:api:NET:example.com");

        clear_policies_for_test();
    }

    struct StaticPolicyStore(pub PolicyMap);

    impl PolicyStore for StaticPolicyStore {
        fn load(&self) -> PolicyMap {
            self.0.clone()
        }
    }

    #[tokio::test]
    async fn receipt_captures_policy_and_sha256() {
        std::env::set_var("UICP_EGRESS_RL_ENABLED", "0");
        reset_limiters_for_test();

        let server = MockServer::start_async().await;
        let body = "ok";
        let _mock = server
            .mock_async(|when, then| {
                when.method("GET").path("/data");
                then.status(200)
                    .header("Content-Type", "text/plain")
                    .body(body);
            })
            .await;

        let host = server.host();
        let mut policies = PolicyMap::new();
        policies.insert(
            format!("api:NET:{host}"),
            PolicyEntry {
                decision: "allow".into(),
                duration: String::new(),
                created_at: 0,
                session_only: false,
            },
        );
        let policy_store = Arc::new(StaticPolicyStore(policies));
        let receipts_store = Arc::new(RwLock::new(Vec::new()));
        let receipts_sink = Arc::new(InMemorySink(receipts_store.clone()));
        let ctx = HostCtx::test(
            reqwest::Client::new(),
            policy_store,
            receipts_sink,
            Limits::default(),
        );

        let url = server.url("/data");
        let req = EgressRequest {
            method: "GET".into(),
            url,
            headers: None,
            body: None,
        };

        let response = egress_fetch_core(&ctx, "app", &req).await.unwrap();
        assert_eq!(response.status, 200);
        assert_eq!(response.body, body.as_bytes());

        let entries = receipts_store.read();
        assert_eq!(entries.len(), 1);
        let (_, payload) = &entries[0];
        let policy = payload.get("policy").and_then(|v| v.as_str()).unwrap();
        assert_eq!(policy, format!("user-allow:api:NET:{host}"));
        let sha = payload.get("sha256").and_then(|v| v.as_str()).unwrap();
        assert_eq!(sha.len(), 64);
        assert!(sha.chars().all(|c| c.is_ascii_hexdigit()));

        std::env::remove_var("UICP_EGRESS_RL_ENABLED");
        reset_limiters_for_test();
    }
}

static RL: std::sync::LazyLock<Mutex<HashMap<(String, String), Bucket>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static CONC: std::sync::LazyLock<Mutex<HashMap<(String, String), usize>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn cfg_rl_enabled() -> bool {
    std::env::var("UICP_EGRESS_RL_ENABLED")
        .map(|v| v != "0")
        .unwrap_or(true)
}

fn cfg_rps() -> f64 {
    std::env::var("UICP_EGRESS_RPS_DEFAULT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(5.0)
}

fn cfg_burst() -> f64 {
    std::env::var("UICP_EGRESS_BURST")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(10.0)
}

fn cfg_conc_max() -> usize {
    std::env::var("UICP_EGRESS_CONCURRENCY_MAX")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(10)
}

fn rate_limit_take(installed_id: &str, host: &str) -> Result<(), String> {
    if !cfg_rl_enabled() {
        return Ok(());
    }
    let key = (installed_id.to_string(), host.to_string());
    let mut map = RL.lock();
    let now = Instant::now();
    let mut bucket = map.get(&key).cloned().unwrap_or(Bucket {
        tokens: cfg_burst(),
        last: now,
    });
    let elapsed = (now - bucket.last).as_secs_f64();
    bucket.tokens = (bucket.tokens + elapsed * cfg_rps()).min(cfg_burst());
    bucket.last = now;
    if bucket.tokens < 1.0 {
        return Err("RateLimited".into());
    }
    bucket.tokens -= 1.0;
    map.insert(key, bucket);
    Ok(())
}

fn conc_enter(installed_id: &str, host: &str) -> Result<(), String> {
    if !cfg_rl_enabled() {
        return Ok(());
    }
    let key = (installed_id.to_string(), host.to_string());
    let mut map = CONC.lock();
    let current = map.get(&key).cloned().unwrap_or(0);
    if current >= cfg_conc_max() {
        return Err("ConcurrencyLimited".into());
    }
    map.insert(key, current + 1);
    Ok(())
}

fn conc_leave(installed_id: &str, host: &str) {
    if !cfg_rl_enabled() {
        return;
    }
    let key = (installed_id.to_string(), host.to_string());
    let mut map = CONC.lock();
    if let Some(entry) = map.get_mut(&key) {
        if *entry > 0 {
            *entry -= 1;
        }
    }
}

fn body_sha256(body: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(body);
    format!("{:x}", hasher.finalize())
}

#[cfg(test)]
fn reset_limiters_for_test() {
    RL.lock().clear();
    CONC.lock().clear();
}

#[derive(Debug, Deserialize)]
pub struct EgressRequest {
    pub method: String,
    pub url: String,
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<Vec<u8>>,
}

#[derive(Debug, Serialize)]
pub struct EgressResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

// -----------------------------------------------------------------------------
// Core egress function (pure host-core using injected HostCtx)
// -----------------------------------------------------------------------------

pub async fn egress_fetch_core(
    ctx: &HostCtx,
    installed_id: &str,
    req: &EgressRequest,
) -> Result<EgressResponse, String> {
    // Host + policy checks
    let host = parse_host(&req.url).map_err(|e| e.to_string())?;
    let https_only = req.url.starts_with("https://");
    let (allowed, policy_label) = net_decision_with(
        &*ctx.policy,
        &host,
        https_only,
        net_is_private_ip(&host),
        net_is_ip_literal(&host),
    );
    if !allowed {
        return Err(format!("PolicyDenied: api:NET:{host}"));
    }

    rate_limit_take(installed_id, &host)?;
    conc_enter(installed_id, &host)?;

    // Build request
    let method = Method::from_bytes(req.method.as_bytes()).map_err(|e| e.to_string())?;
    let client: &Client = &ctx.http;
    let mut builder = client
        .request(method, &req.url)
        .timeout(Duration::from_secs(30));

    if let Some(h) = &req.headers {
        for (k, v) in h {
            builder = builder.header(k, v);
        }
    }
    if let Some(b) = &req.body {
        builder = builder.body(b.clone());
    }

    let t0 = Instant::now();
    let resp = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            conc_leave(installed_id, &host);
            return Err(e.to_string());
        }
    };
    let status = resp.status().as_u16();
    let mut out_headers = HashMap::new();
    for (k, v) in resp.headers() {
        if let Ok(s) = v.to_str() {
            out_headers.insert(k.to_string(), s.to_string());
        }
    }
    let body = match resp.bytes().await {
        Ok(b) => b,
        Err(e) => {
            conc_leave(installed_id, &host);
            return Err(e.to_string());
        }
    };
    if body.len() > ctx.limits.resp_max_bytes {
        conc_leave(installed_id, &host);
        return Err("PolicyDenied: response too large".into());
    }

    let sha256 = body_sha256(&body);
    let body_vec = body.to_vec();

    // Receipt via injected sink (best-effort)
    let receipt = serde_json::json!({
        "ts": chrono::Utc::now().timestamp_millis(),
        "type": "egress",
        "app": installed_id,
        "url": req.url,
        "host": host,
        "policy": policy_label,
        "status": status,
        "ms": t0.elapsed().as_millis(),
        "bytes_out": req.body.as_ref().map(|b| b.len()).unwrap_or(0),
        "bytes_in": body.len(),
        "sha256": sha256,
    });
    ctx.receipts.append("egress", &receipt);

    conc_leave(installed_id, &host);
    Ok(EgressResponse {
        status,
        headers: out_headers,
        body: body_vec,
    })
}

// -----------------------------------------------------------------------------
// Tauri command: egress_fetch (thin wrapper)
// -----------------------------------------------------------------------------

#[tauri::command]
pub async fn egress_fetch(
    app: AppHandle,
    state: State<'_, AppState>,
    installed_id: String,
    req: EgressRequest,
) -> Result<EgressResponse, String> {
    let appdata_root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let ctx = HostCtx::from_app(&state, appdata_root);
    egress_fetch_core(&ctx, &installed_id, &req).await
}
