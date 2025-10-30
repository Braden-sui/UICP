//! Error code constants

/// Provider CLI error codes (1500-1599)
pub const ERR_PROVIDER_INVALID: &str = "E-UICP-1500";
pub const ERR_PROGRAM_NOT_FOUND: &str = "E-UICP-1501";
pub const ERR_NOT_AUTHENTICATED: &str = "E-UICP-1502";
pub const ERR_KEYCHAIN_LOCKED: &str = "E-UICP-1503";
pub const ERR_NETWORK_DENIED: &str = "E-UICP-1504";
pub const ERR_TIMEOUT: &str = "E-UICP-1506";
pub const ERR_SPAWN: &str = "E-UICP-1507";

/// Compute input error detail codes (0400-0499)
pub const DETAIL_CSV_INPUT: &str = "E-UICP-0401";
pub const DETAIL_TABLE_INPUT: &str = "E-UICP-0402";
pub const DETAIL_WS_PATH: &str = "E-UICP-0403";
pub const DETAIL_FS_CAP: &str = "E-UICP-0404";
pub const DETAIL_IO: &str = "E-UICP-0405";
pub const DETAIL_SCRIPT_INPUT: &str = "E-UICP-0406";
pub const DETAIL_CODEGEN_INPUT: &str = "E-UICP-0407";

/// Security error codes (SEC-*)
pub const RNG_FAILURE_CODE: &str = "E-UICP-SEC-RNG";
