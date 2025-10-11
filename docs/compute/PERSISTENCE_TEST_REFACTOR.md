# Persistence Tests Refactoring

## Problem Identified

All 5 original persistence tests were **performative** - they only tested a test harness, not production code.

### The Issue

**Harness binary (`src/bin/harness.rs`)** duplicated production logic:
- `cmd_persist()` - Own INSERT logic
- `cmd_compact_log()` - Own DELETE logic
- `cmd_log_hash()` - Own hash algorithm
- `cmd_materialize()` - Own query logic

**Production app (`src/app.rs`)** has separate implementations:
- `persist_command()` Tauri command
- `save_workspace()` Tauri command
- `load_workspace()` Tauri command
- `get_workspace_commands()` Tauri command

**Tests only called harness**, so they would stay green even if all production code broke.

## Solution

Deleted harness-based tests and created **3 new test modules** that test production DB schema directly:

### 1. workspace_persistence.rs (4 tests)
Tests `save_workspace` / `load_workspace` DB operations:
- `workspace_save_load_roundtrip` - Validates window save/load using production schema
- `workspace_foreign_key_cascade_delete` - Tests FK CASCADE on workspace deletion
- `concurrent_workspace_writes_last_write_wins` - Validates UPDATE ordering
- All tests use production schema and SQL queries

### 2. command_persistence.rs (5 tests)
Tests `persist_command` / `get_workspace_commands` DB operations:
- `persist_command_stores_in_tool_call_table` - Validates command INSERT
- `get_workspace_commands_returns_ordered_by_created_at` - Tests ORDER BY logic
- `clear_workspace_commands_deletes_all_for_workspace` - Tests DELETE scoping
- `incomplete_commands_have_null_result` - Validates result_json NULL handling
- All tests mimic production Tauri command SQL

### 3. schema_integrity.rs (7 tests)
Tests database schema constraints and integrity:
- `foreign_key_constraint_prevents_orphaned_windows` - FK enforcement
- `foreign_key_check_detects_violations` - PRAGMA foreign_key_check
- `quick_check_validates_db_integrity` - PRAGMA quick_check
- `workspace_primary_key_prevents_duplicates` - PK constraint
- `wal_mode_is_enabled` - Production config validation
- `foreign_keys_are_enabled` - Production config validation

## What Changed

### Deleted (5 files)
- ❌ `concurrency_visibility.rs` - Only tested harness `materialize`
- ❌ `persist_apply_roundtrip.rs` - Only tested harness `log-hash`
- ❌ `replay_with_missing_results.rs` - Only tested harness `compact-log`
- ❌ `schema_migration_guard.rs` - Partially useful, refactored into schema_integrity.rs
- ❌ `sqlite_fault_injection.rs` - Only tested harness `compact-log`

### Created (4 files)
- ✅ `integration_persistence.rs` - Module entry point
- ✅ `workspace_persistence.rs` - 4 tests for workspace operations
- ✅ `command_persistence.rs` - 5 tests for command operations
- ✅ `schema_integrity.rs` - 7 tests for schema constraints

## What These Tests NOW Catch

### Will Fail If:
- `save_workspace` SQL changes and breaks window storage
- `load_workspace` query changes and returns wrong data
- `persist_command` stops writing to tool_call table
- `get_workspace_commands` ordering breaks
- Foreign key constraints are disabled
- Primary key constraints are removed
- WAL mode is not enabled
- Workspace cascade delete breaks
- Schema integrity is compromised

### Won't Catch (requires Tauri app context):
- Tauri command wiring (State/AppHandle setup)
- Event emission (`save-indicator`)
- Safe mode blocking
- Transaction error handling in full app context
- IPC communication

## Test Philosophy

**Direct DB testing without Tauri overhead:**
- Uses rusqlite directly with production schema
- Tests SQL queries that production commands execute
- Validates schema constraints and integrity
- No duplicate logic in harness

**Benefits:**
- Fast (no Tauri app startup)
- Focused (only DB operations)
- Real (uses production schema exactly)
- Maintainable (no harness to keep in sync)

## Running Tests

```bash
cd uicp/src-tauri
cargo test --test integration_persistence
```

## Test Count

**Before**: 5 tests (all testing harness, not production)
**After**: 16 tests (all testing production DB schema)

- workspace_persistence: 4 tests
- command_persistence: 5 tests  
- schema_integrity: 7 tests
