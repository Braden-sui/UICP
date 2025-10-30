#![deny(clippy::print_stderr)]

pub mod action_log;

pub mod anthropic;
pub mod apppack;
pub mod authz;
pub mod chaos;
pub mod circuit;
pub mod code_provider;
pub mod codegen;
pub mod compute;
pub mod compute_cache;
pub mod compute_input;
pub mod config;
pub mod core;
pub mod events;
pub mod hostctx;
pub mod keystore;
pub mod policy;
pub mod provider_adapters;
pub mod provider_circuit;
pub mod providers;
pub mod registry;
pub mod resilience;

pub use action_log::{
    ensure_action_log_schema, parse_pubkey, parse_seed, verify_chain, ActionLogHandle,
    ActionLogService, ActionLogVerifyReport,
};
pub use policy::{
    enforce_compute_policy, ComputeBindSpec, ComputeCapabilitiesSpec, ComputeFinalErr,
    ComputeFinalOk, ComputeJobSpec, ComputePartialEvent, ComputeProvenanceSpec,
};

// WHY: Keep compute event channel names consistent across host layers (commands, runtime, bridge).
pub use events::EVENT_COMPUTE_RESULT_FINAL;
#[cfg(any(test, feature = "wasm_compute", feature = "compute_harness"))]
pub use events::EVENT_COMPUTE_RESULT_PARTIAL;

#[cfg(any(test, feature = "compute_harness"))]
pub mod provider_cli;

#[cfg(feature = "wasm_compute")]
pub mod wasi_logging;

#[cfg(feature = "wasm_compute")]
pub mod component_bindings;

#[cfg(any(
    all(feature = "wasm_compute", feature = "uicp_wasi_enable"),
    test,
    feature = "compute_harness"
))]
use serde::{Deserialize, Serialize};
use serde_json::Value; // WHY: compute_cache_key is exercised in harness/tests; import serde_json value there.

pub use core::{
    configure_sqlite, emit_or_log, ensure_default_workspace, files_dir_path, init_database,
    init_tracing, log_error, log_info, log_warn, remove_compute_job, AppState, DATA_DIR, FILES_DIR,
    LOGS_DIR,
};

// Re-export path constants from main.rs
pub use main_rs_shim::{DB_PATH, ENV_PATH};

// Shim module to re-export main.rs constants
mod main_rs_shim {
    use once_cell::sync::Lazy;
    use std::path::PathBuf;

    pub static DB_PATH: Lazy<PathBuf> = Lazy::new(|| super::core::DATA_DIR.join("data.db"));
    pub static ENV_PATH: Lazy<PathBuf> = Lazy::new(|| super::core::DATA_DIR.join(".env"));
}

// Chat completion request type (mirrored from main.rs)
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatCompletionRequest {
    pub model: Option<String>,
    pub messages: Vec<ChatMessageInput>,
    pub stream: Option<bool>,
    pub tools: Option<serde_json::Value>,
    pub format: Option<serde_json::Value>,
    #[serde(rename = "response_format")]
    pub response_format: Option<serde_json::Value>,
    #[serde(rename = "tool_choice")]
    pub tool_choice: Option<serde_json::Value>,
    pub reasoning: Option<serde_json::Value>,
    pub options: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageInput {
    pub role: String,
    pub content: String,
}

// WHY: Restrict harness-only commands to tests or the explicit compute_harness feature to avoid dead code warnings in wasm-only builds.
#[cfg(any(test, feature = "compute_harness"))]
pub mod commands;
#[cfg(any(test, feature = "compute_harness"))]
pub mod commands_harness;
#[cfg(any(test, feature = "compute_harness"))]
pub use commands_harness::{
    clear_compute_cache, compute_call, compute_cancel, copy_into_files, get_modules_info,
    load_workspace, save_workspace,
};

#[cfg(any(
    all(feature = "wasm_compute", feature = "uicp_wasi_enable"),
    test,
    feature = "compute_harness"
))]
pub fn compute_cache_key(task: &str, input: &Value, env_hash: &str) -> String {
    crate::compute_cache::compute_key(task, input, env_hash)
}

// Test support infrastructure (test_support/) is only compiled when running tests
// or when the compute_harness feature is enabled. It is excluded from release builds.
#[cfg(any(test, feature = "compute_harness"))]
pub mod test_support;

// WHY: Windows test/harness binaries require comctl32.dll for SetWindowSubclass/TaskDialogIndirect but
// some hosts ship only the v5 assembly. Delay-load the DLL and provide a fallback hook so startup does
// not fail before Rust code runs. Application binaries still resolve the real exports via the manifest.
#[cfg(all(target_os = "windows", any(test, feature = "compute_harness")))]
mod windows_taskdialog_delayload {
    use std::ffi::{c_char, c_void, CStr};
    use std::mem;
    use std::sync::OnceLock;

    const DLI_FAIL_GETPROC: u32 = 4;
    const S_OK: i32 = 0;

    #[repr(C)]
    #[allow(non_snake_case)]
    pub(crate) struct DelayLoadInfo {
        cb: u32,
        pidd: *const c_void,
        ppfn: *mut *mut c_void,
        szDll: *const c_char,
        dlp: DelayLoadProc,
        hmodCur: *mut c_void,
        pfnCur: *mut c_void,
        dwLastError: u32,
    }

    #[repr(C)]
    #[allow(non_snake_case)]
    union DelayLoadNameOrOrdinal {
        szProcName: *const c_char,
        dwOrdinal: u32,
    }

    #[repr(C)]
    #[allow(non_snake_case)]
    #[repr(C)]
    struct DelayLoadProc {
        fImportByName: i32,
        name_or_ordinal: DelayLoadNameOrOrdinal,
    }

    extern "C" {
        fn uicp_force_comctl32_delayload();
    }

    #[used]
    #[allow(non_upper_case_globals)]
    static FORCE_DELAYLOAD_LINK: unsafe extern "C" fn() = uicp_force_comctl32_delayload;

    type TaskDialogProc =
        unsafe extern "system" fn(*const c_void, *mut i32, *mut i32, *mut i32) -> i32;

    static TASK_DIALOG: OnceLock<TaskDialogProc> = OnceLock::new();

    #[allow(non_snake_case, unused_mut)]
    unsafe extern "system" fn task_dialog_stub(
        _config: *const c_void,
        pnButton: *mut i32,
        pnRadioButton: *mut i32,
        pfVerificationFlagChecked: *mut i32,
    ) -> i32 {
        if let Some(slot) = pnButton.as_mut() {
            *slot = 0;
        }
        if let Some(slot) = pnRadioButton.as_mut() {
            *slot = 0;
        }
        if let Some(slot) = pfVerificationFlagChecked.as_mut() {
            *slot = 0;
        }
        S_OK
    }

    unsafe fn resolve_task_dialog() -> TaskDialogProc {
        use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryA};

        const DLL_NAME: &[u8] = b"comctl32.dll\0";
        const PROC_NAME: &[u8] = b"TaskDialogIndirect\0";

        let module = LoadLibraryA(DLL_NAME.as_ptr() as _);
        if !module.is_null() {
            if let Some(proc) = GetProcAddress(module, PROC_NAME.as_ptr() as _) {
                return mem::transmute(proc);
            }
        }
        task_dialog_stub
    }

    unsafe extern "system" fn task_dialog_loader(
        config: *const c_void,
        pn_button: *mut i32,
        pn_radio: *mut i32,
        pf_verified: *mut i32,
    ) -> i32 {
        let proc = *TASK_DIALOG.get_or_init(|| unsafe { resolve_task_dialog() });
        proc(config, pn_button, pn_radio, pf_verified)
    }

    #[no_mangle]
    pub static mut __imp_TaskDialogIndirect: TaskDialogProc = task_dialog_loader;

    #[allow(non_snake_case)]
    #[no_mangle]
    pub unsafe extern "system" fn __pfnDliFailureHook2(
        notification: u32,
        data: *mut DelayLoadInfo,
    ) -> *mut c_void {
        if notification != DLI_FAIL_GETPROC || data.is_null() {
            return std::ptr::null_mut();
        }

        let info = &*data;
        let module = CStr::from_ptr(info.szDll);
        if !module.to_bytes().eq_ignore_ascii_case(b"comctl32.dll") {
            return std::ptr::null_mut();
        }

        if info.dlp.fImportByName == 0 {
            return std::ptr::null_mut();
        }
        let name_ptr = unsafe { info.dlp.name_or_ordinal.szProcName };
        if name_ptr.is_null() {
            return std::ptr::null_mut();
        }
        let proc_name = CStr::from_ptr(name_ptr);
        if proc_name
            .to_bytes()
            .eq_ignore_ascii_case(b"TaskDialogIndirect")
        {
            return task_dialog_stub as *mut c_void;
        }

        std::ptr::null_mut()
    }
}
