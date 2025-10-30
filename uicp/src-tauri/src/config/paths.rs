//! Path and directory configuration

/// Directory names
pub const KEYSTORE_DIR: &str = "keystore";

/// Database constants
pub const KEYSTORE_DB: &str = "keystore.db";
pub const META_TABLE: &str = "meta";

/// Security constants
// #[allow(dead_code)]
// pub const SENTINEL_ACCOUNT: &str = "keystore:sentinel";
// pub const SENTINEL_PLAINTEXT: &str = "uicp-sentinel-v1";
pub const HKDF_PREFIX: &str = "uicp:secret:";
pub const AAD_SUFFIX: &str = ":v1";
pub const SALT_KEY: &str = "app_salt";
pub const SCHEMA_KEY: &str = "schema_version";
pub const SCHEMA_VERSION: &str = "1";
