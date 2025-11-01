//! Configuration constants and structures for the UICP application
//!
//! This module centralizes all configuration values to improve maintainability
//! and make it easier to adjust system behavior.

pub mod errors;
pub mod limits;
pub mod openai_shape;
pub mod paths;
pub mod resilience;
pub mod timeouts;

// Re-export commonly used configuration
// pub use resilience::*;
// pub use timeouts::*;
// pub use limits::*;
// pub use paths::*;
// pub use errors::*;
