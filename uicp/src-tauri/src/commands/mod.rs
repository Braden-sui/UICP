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


// Re-exports
pub use files::*;
pub use debug::*;
pub use agents::*;
pub use apppack::*;
pub use modules::*;
pub use network::*;
pub use api_keys::*;
pub use keystore::*;
pub use persistence::*;
pub use providers::*;
pub use recovery::*;
pub use compute::*;
pub use chat::*;
