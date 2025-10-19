# SQLite Cache Maintenance & Schema Versioning

## Overview

The compute cache uses SQLite with optimizations to prevent fragmentation and ensure reliable schema evolution. This document describes the maintenance system, schema versioning, and recovery procedures.

## Architecture

### WAL Mode Configuration

**Location**: `core.rs::configure_sqlite()` and `main.rs::configure_sqlite()`

All database connections are configured with:
- **journal_mode = WAL**: Write-Ahead Logging for better concurrency and crash recovery
- **synchronous = NORMAL**: Desktop-optimized I/O (safe on non-critical cache data)
- **foreign_keys = ON**: Referential integrity enforcement

### Periodic Maintenance Task

**Location**: `main.rs::spawn_db_maintenance()`

Runs automatically every 24 hours (configurable via `UICP_DB_MAINTENANCE_INTERVAL_HOURS`):

1. **WAL Checkpoint (TRUNCATE)**: Flushes WAL to main database and truncates WAL file
   - Prevents unbounded WAL growth
   - Frees disk space
   
2. **PRAGMA optimize**: Updates query planner statistics for better performance

3. **VACUUM** (every 7 days, configurable via `UICP_DB_VACUUM_INTERVAL_DAYS`):
   - Reclaims fragmented space
   - Defragments pages
   - Rebuilds indexes

### Schema Versioning

**Location**: `core.rs` and `main.rs` (both have independent implementations)

#### Schema Version Table

```sql
CREATE TABLE IF NOT EXISTS schema_version (
    component TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    applied_at INTEGER NOT NULL
);
```

Tracks migrations per component to:
- Prevent re-running completed migrations
- Detect version drift
- Enable rollback planning

#### Current Version

`SCHEMA_VERSION = 1` (defined in both `core.rs` and `main.rs`)

When incrementing:
1. Update the constant
2. Add migration logic in `migrate_compute_cache()`
3. Test with existing databases

### Migration Flow

**Location**: `core.rs::migrate_compute_cache()` and `main.rs::migrate_compute_cache()`

```rust
fn migrate_compute_cache(conn: &Connection) -> anyhow::Result<()> {
    // 1. Check if migration already applied
    if let Ok(Some(version)) = get_schema_version(conn, "compute_cache") {
        if version >= SCHEMA_VERSION {
            return Ok(());
        }
    }
    
    // 2. Inspect current schema
    // 3. Apply incremental changes
    // 4. Execute full migration in transaction if needed
    // 5. Record new version
}
```

Current migration (v1):
- Adds `workspace_id` column for multi-workspace support
- Rebuilds table with composite primary key `(workspace_id, key)`
- Deduplicates entries using `ROW_NUMBER() OVER (PARTITION BY ...)`

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `UICP_DB_MAINTENANCE_INTERVAL_HOURS` | 24 | Hours between maintenance runs |
| `UICP_DB_VACUUM_INTERVAL_DAYS` | 7 | Days between VACUUM operations |

### Maintenance Timing

Maintenance runs:
- On first tick after app start (immediate)
- Every N hours thereafter
- Skipped when in Safe Mode

## Error Handling

### Migration Failures

If `migrate_compute_cache()` fails, the error message includes recovery instructions:

```
compute_cache migration failed. Recovery: Stop all UICP instances, backup data.db, 
then run 'PRAGMA integrity_check' manually. If corrupt, restore from backup or 
delete compute_cache table to rebuild cache from scratch.
```

**Why this is safe**: The compute cache is purely performance-optimizing. Deleting it causes a cold start but no data loss.

### Maintenance Failures

On maintenance failure:
1. Error logged to console and tracing (if enabled)
2. Event emitted: `db-maintenance-error` with diagnostic payload
3. Recommendation: Run `health_quick_check` command

## Monitoring

### Telemetry Events (otel_spans feature)

**Maintenance**:
```rust
tracing::info!(
    target = "uicp",
    duration_ms = ms,
    vacuumed = bool,
    "db maintenance completed"
);
```

**Migration**:
- Recorded via `schema_version` table with `applied_at` timestamp

### UI Events

- `db-maintenance-error`: Emitted on failure with error and recommendation

## Recovery Procedures

### Scenario 1: Migration Stuck

**Symptoms**: App fails to start, error mentions `compute_cache`

**Steps**:
1. Stop all UICP instances
2. Backup `data.db`
3. Open database with sqlite3:
   ```bash
   sqlite3 data.db "PRAGMA integrity_check;"
   ```
4. If OK, manually delete helper table:
   ```bash
   sqlite3 data.db "DROP TABLE IF EXISTS compute_cache_new;"
   ```
5. Restart app

### Scenario 2: Corruption Detected

**Symptoms**: `PRAGMA integrity_check` returns errors

**Steps**:
1. Stop all UICP instances
2. Backup `data.db`
3. Clear cache (safe, rebuilds automatically):
   ```bash
   sqlite3 data.db "DELETE FROM compute_cache;"
   ```
4. Restart app

### Scenario 3: Unbounded WAL Growth

**Symptoms**: `data.db-wal` file grows beyond 100MB

**Cause**: Maintenance task stopped or disabled

**Steps**:
1. Verify maintenance is running (check logs)
2. Manually checkpoint:
   ```bash
   sqlite3 data.db "PRAGMA wal_checkpoint(TRUNCATE);"
   ```
3. Check `UICP_DB_MAINTENANCE_INTERVAL_HOURS` setting

## Testing

### Manual Maintenance Trigger

Not exposed via command interface. Use environment variable to shorten interval:

```bash
export UICP_DB_MAINTENANCE_INTERVAL_HOURS=1
./uicp
```

### Schema Version Query

```sql
SELECT * FROM schema_version;
```

Expected output:
```
component      | version | applied_at
---------------|---------|------------
compute_cache  | 1       | 1729180800
```

### WAL Status

```sql
PRAGMA journal_mode;
PRAGMA wal_checkpoint;
```

## Win

Prevents:
- **Slow accretion of rubble**: VACUUM reclaims fragmented space
- **Mysterious cache stalls**: Regular checkpoints prevent WAL bloat
- **Schema drift nightmares**: Version tracking ensures clean migrations
- **"Catacombs closed"**: Clear recovery instructions prevent panic

## Future Work

Moved to `docs/PROPOSALS.md` (Observability, Developer Experience, Persistence & Replay sections).
