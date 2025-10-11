//! Integration tests for persistence layer - validates production DB operations.

#[path = "integration_persistence/command_persistence.rs"]
mod command_persistence;
#[path = "integration_persistence/schema_integrity.rs"]
mod schema_integrity;
#[path = "integration_persistence/workspace_persistence.rs"]
mod workspace_persistence;
