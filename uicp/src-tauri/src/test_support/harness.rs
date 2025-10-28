#![cfg(any(test, feature = "compute_harness"))]

use crate::action_log::ActionLogService;
use crate::{ensure_default_workspace, init_database, AppState, DATA_DIR, FILES_DIR, LOGS_DIR};
use anyhow::{Context, Result};
use reqwest::Client;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{
    test::{mock_builder, mock_context, noop_assets, MockRuntime},
    Listener, Manager,
};
use tempfile::TempDir;
use tokio::sync::{RwLock, Semaphore};
use tokio_rusqlite::Connection as AsyncConn;

/// Test harness that provisions an in-memory (tempdir-backed) app instance capable of running
/// real compute jobs against the Wasm runtime.
pub struct ComputeTestHarness {
    _temp: Option<TempDir>, // SAFETY: keep tempdir alive for harness lifetime; unused fields are intentional.
    data_dir: PathBuf,
    app: tauri::App<MockRuntime>,
    _window: tauri::WebviewWindow<MockRuntime>, // SAFETY: WebviewWindow must stay owned to keep runtime handles valid.
}

impl ComputeTestHarness {
    /// Build a new harness. Modules are resolved from `UICP_MODULES_DIR` if set, otherwise
    /// default to the checked-in `src-tauri/modules` directory.
    pub fn new() -> Result<Self> {
        // SAFETY: For non-async callers only. Prefer new_async() inside async tests to avoid nested runtime.
        tauri::async_runtime::block_on(Self::new_async())
    }

    /// Async constructor to avoid nested Tokio runtimes inside #[tokio::test].
    pub async fn new_async() -> Result<Self> {
        let temp = TempDir::new().context("create temp data dir")?;
        let data_dir = temp.path().to_path_buf();
        let (app, window) = Self::build_app_async(&data_dir).await?;

        Ok(Self {
            _temp: Some(temp),
            data_dir,
            app,
            _window: window,
        })
    }

    /// Reuse an existing data directory (e.g. to simulate process restart).
    pub fn with_data_dir<P: AsRef<Path>>(dir: P) -> Result<Self> {
        // SAFETY: For non-async callers only. Prefer with_data_dir_async() inside async tests.
        tauri::async_runtime::block_on(Self::with_data_dir_async(dir))
    }

    pub async fn with_data_dir_async<P: AsRef<Path>>(dir: P) -> Result<Self> {
        let data_dir = dir.as_ref().to_path_buf();
        let (app, window) = Self::build_app_async(&data_dir).await?;
        Ok(Self {
            _temp: None,
            data_dir,
            app,
            _window: window,
        })
    }

    async fn build_app_async(
        data_dir: &Path,
    ) -> Result<(tauri::App<MockRuntime>, tauri::WebviewWindow<MockRuntime>)> {
        std::fs::create_dir_all(data_dir).context("create data dir root")?;
        std::env::set_var("UICP_DATA_DIR", data_dir);
        if std::env::var("UICP_MODULES_DIR").is_err() {
            let modules_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("modules");
            std::env::set_var("UICP_MODULES_DIR", modules_dir.as_os_str());
        }

        let db_path = data_dir.join("data.db");

        init_database(&db_path).context("init test database")?;
        ensure_default_workspace(&db_path).context("ensure default workspace")?;

        // Initialize resident async SQLite connections for tests
        let db_rw = AsyncConn::open(&db_path)
            .await
            .expect("open sqlite rw (harness)");
        let db_ro =
            AsyncConn::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .await
                .expect("open sqlite ro (harness)");
        // Writer: full configuration (unwrap both layers: tokio_rusqlite and rusqlite)
        db_rw
            .call(
                |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
                    use std::time::Duration;
                    c.busy_timeout(Duration::from_millis(5_000))
                        .map_err(tokio_rusqlite::Error::from)?;
                    c.pragma_update(None, "journal_mode", "WAL")
                        .map_err(tokio_rusqlite::Error::from)?;
                    c.pragma_update(None, "synchronous", "NORMAL")
                        .map_err(tokio_rusqlite::Error::from)?;
                    c.pragma_update(None, "foreign_keys", "ON")
                        .map_err(tokio_rusqlite::Error::from)?;
                    Ok(())
                },
            )
            .await
            .expect("configure sqlite rw");
        // Reader: non-writing pragmas only
        db_ro
            .call(
                |c: &mut rusqlite::Connection| -> tokio_rusqlite::Result<()> {
                    use std::time::Duration;
                    c.busy_timeout(Duration::from_millis(5_000))
                        .map_err(tokio_rusqlite::Error::from)?;
                    c.pragma_update(None, "foreign_keys", "ON")
                        .map_err(tokio_rusqlite::Error::from)?;
                    Ok(())
                },
            )
            .await
            .expect("configure sqlite ro");

        let action_log =
            ActionLogService::start(&db_path).context("start action log service (harness)")?;

        let state = AppState {
            db_path: db_path.clone(),
            db_ro,
            db_rw,
            last_save_ok: RwLock::new(true),
            ollama_key: RwLock::new(None),
            use_direct_cloud: RwLock::new(true),
            allow_local_opt_in: RwLock::new({
                let raw = std::env::var("UICP_OLLAMA_LOCAL_OPTIN").unwrap_or_default();
                matches!(raw.as_str(), "1" | "true" | "TRUE" | "yes" | "on")
            }),
            debug_enabled: RwLock::new(false),
            http: Client::builder()
                .connect_timeout(Duration::from_secs(5))
                .pool_idle_timeout(Some(Duration::from_secs(5)))
                .tcp_keepalive(Some(Duration::from_secs(5)))
                .build()
                .context("build reqwest client")?,
            ongoing: RwLock::new(std::collections::HashMap::new()),
            compute_ongoing: RwLock::new(std::collections::HashMap::new()),
            compute_sem: Arc::new(Semaphore::new(2)),
            codegen_sem: Arc::new(Semaphore::new(2)),
            wasm_sem: Arc::new(Semaphore::new(2)),
            compute_cancel: RwLock::new(std::collections::HashMap::new()),
            safe_mode: RwLock::new(false),
            safe_reason: RwLock::new(None),
            circuit_breakers: Arc::new(RwLock::new(std::collections::HashMap::new())),
            circuit_config: crate::core::CircuitBreakerConfig::from_env(),
            action_log,
            job_token_key: [0u8; 32],
        };

        // database initialized above

        let mut builder = mock_builder();
        builder = builder
            .manage(state)
            .plugin(tauri_plugin_fs::init())
            .setup(|app| {
                if let Err(err) = std::fs::create_dir_all(&*DATA_DIR) {
                    tracing::error!("create data dir failed: {err:?}");
                }
                if let Err(err) = std::fs::create_dir_all(&*LOGS_DIR) {
                    tracing::error!("create logs dir failed: {err:?}");
                }
                if let Err(err) = std::fs::create_dir_all(&*FILES_DIR) {
                    tracing::error!("create files dir failed: {err:?}");
                }
                let handle = app.handle();
                if let Err(err) = crate::registry::install_bundled_modules_if_missing(&handle) {
                    tracing::error!("install modules failed: {err:?}");
                }
                Ok(())
            });

        let app = builder
            .build(mock_context(noop_assets()))
            .context("build test app")?;
        let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .context("create test window")?;

        Ok((app, window))
    }

    /// Run a compute job and return the final event payload as JSON.
    pub async fn run_job(&self, spec: crate::ComputeJobSpec) -> Result<Value> {
        use tokio::sync::oneshot;

        let (tx, rx) = oneshot::channel::<Value>();
        let job_id = spec.job_id.clone();
        let tx_arc = Arc::new(Mutex::new(Some(tx)));
        let handler_job_id = job_id.clone();
        let handler_tx = Arc::clone(&tx_arc);

        let listener_id =
            self.app
                .listen(crate::events::EVENT_COMPUTE_RESULT_FINAL, move |event| {
                    if let Ok(value) = serde_json::from_str::<Value>(event.payload()) {
                        let job_matches = value
                            .get("jobId")
                            .or_else(|| value.get("job_id"))
                            .and_then(|v| v.as_str())
                            .map(|id| id == handler_job_id)
                            .unwrap_or(false);
                        if job_matches {
                            if let Some(sender) =
                                handler_tx.lock().ok().and_then(|mut guard| guard.take())
                            {
                                let _ = sender.send(value);
                            }
                        }
                    }
                });

        let state: tauri::State<'_, AppState> = self.app.state();
        if let Err(err) =
            crate::commands::compute_call(self.app.handle().clone(), state, spec.clone()).await
        {
            self.app.unlisten(listener_id);
            return Err(anyhow::anyhow!(err));
        }

        let result = tokio::time::timeout(Duration::from_secs(30), async move {
            rx.await.map_err(|e| anyhow::anyhow!(e))
        })
        .await
        .map_err(|_| anyhow::anyhow!("timed out waiting for compute-result-final"));

        self.app.unlisten(listener_id);

        match result {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(err)) => Err(err),
            Err(err) => Err(err),
        }
    }

    /// Issue a cancellation for a running job.
    pub async fn cancel_job(&self, job_id: &str) -> Result<()> {
        let state: tauri::State<'_, AppState> = self.app.state();
        crate::commands::compute_cancel(self.app.handle().clone(), state, job_id.to_string())
            .await
            .map_err(|err| anyhow::anyhow!(err))
    }

    /// WHY: Surface admin-style commands through the harness so the shim implementations stay exercised and ready for future tests.
    pub async fn modules_info(&self) -> Result<Value> {
        crate::commands::get_modules_info(self.app.handle().clone())
            .await
            .map_err(|err| {
                anyhow::anyhow!("E-UICP-0410: get_modules_info via harness failed: {err}")
            })
    }

    /// WHY: Allow harness callers to copy fixtures into the workspace files area without reimplementing the command logic.
    pub async fn copy_into_files<P>(&self, src: P) -> Result<String>
    where
        P: AsRef<Path>,
    {
        let src_str = src
            .as_ref()
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("E-UICP-0411: source path not valid UTF-8"))?;
        crate::commands::copy_into_files(self.app.handle().clone(), src_str.into())
            .await
            .map_err(|err| {
                anyhow::anyhow!("E-UICP-0412: copy_into_files via harness failed: {err}")
            })
    }

    /// WHY: Load workspace state through the command shim to ensure parity with the production entry point.
    pub async fn load_workspace(&self) -> Result<Vec<Value>> {
        let state: tauri::State<'_, AppState> = self.app.state();
        crate::commands::load_workspace(state)
            .await
            .map_err(|err| anyhow::anyhow!("E-UICP-0413: load_workspace via harness failed: {err}"))
    }

    /// WHY: Persist workspace state through the same code path the app uses, keeping invariants aligned.
    pub async fn save_workspace(&self, windows: Vec<Value>) -> Result<()> {
        let state: tauri::State<'_, AppState> = self.app.state();
        crate::commands::save_workspace((), state, windows)
            .await
            .map_err(|err| anyhow::anyhow!("E-UICP-0414: save_workspace via harness failed: {err}"))
    }

    /// WHY: Provide direct access to cache eviction so compute-focused tests can start from a known state.
    pub async fn clear_compute_cache(&self, workspace_id: Option<String>) -> Result<()> {
        crate::commands::clear_compute_cache(self.app.handle().clone(), workspace_id)
            .await
            .map_err(|err| {
                anyhow::anyhow!("E-UICP-0415: clear_compute_cache via harness failed: {err}")
            })
    }

    /// Return the temp workspace path backing this harness.
    pub fn workspace_dir(&self) -> &Path {
        &self.data_dir
    }
}
