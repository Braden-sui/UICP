//! Tauri command handlers organized by domain.

// Phase 1 modules
pub mod files;
pub mod debug;
pub mod agents;
pub mod apppack;
pub mod modules;
pub mod network;
pub mod api_keys;
pub mod keystore;
pub mod persistence;

// Phase 2 modules
pub mod providers;
pub mod recovery;
pub mod compute;
pub mod chat;

// Intentionally do not re-export modules here; callers import specific submodules directly.
