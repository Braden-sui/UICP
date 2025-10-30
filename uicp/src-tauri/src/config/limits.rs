//! System limits and capacity configuration

/// System limits and constraints.
/// Memory limits.
pub const DEFAULT_MEMORY_LIMIT_MB: u64 = 256;
// pub const MAX_MEMORY_LIMIT_MB: u64 = 1024;
// pub const MIN_MEMORY_LIMIT_MB: u64 = 64;

/// Compute limits.
pub const DEFAULT_RUNTIME_FUEL: u64 = 10_000_000;
// pub const MAX_RUNTIME_FUEL: u64 = 100_000_000;
// pub const MIN_RUNTIME_FUEL: u64 = 1_000_000;

/// Logging limits.
// pub const MAX_LOG_BYTES: usize = 256 * 1024; // 256 KiB
pub const MAX_LOG_BYTES: usize = 10 * 1024; // 10 KiB
                                            // pub const MAX_LOG_CHARS: usize = MAX_LOG_BYTES / 4; // Approximate
                                            // pub const MAX_LOG_ENTRIES_PER_SECOND: u32 = 100;

/// Stdio limits.
// pub const MAX_STDIO_CHARS: usize = 4_096;
// pub const MAX_STDOUT_BYTES: usize = 10 * 1024 * 1024; // 10 MiB
// pub const MAX_STDERR_BYTES: usize = 10 * 1024 * 1024; // 10 MiB
/// Partial frame limits (for streaming).
pub const MAX_PARTIAL_FRAME_BYTES: usize = 64 * 1024; // 64 KiB
                                                      // pub const MAX_PARTIAL_FRAMES_PER_SECOND: u32 = 50;

// /// Rate limiting
// pub const DEFAULT_RATE_LIMIT_RPS: f64 = 5.0;
// pub const DEFAULT_RATE_LIMIT_BURST: f64 = 10.0;
// pub const MAX_CONCURRENT_REQUESTS: usize = 10;

// /// File size limits
// pub const MAX_CONFIG_FILE_SIZE_BYTES: usize = 512 * 1024; // 512 KiB
// pub const MAX_UPLOAD_SIZE_BYTES: usize = 100 * 1024 * 1024; // 100 MiB

// /// Queue limits
// pub const DEFAULT_QUEUE_DEPTH: usize = 256;
// pub const ACTION_LOG_QUEUE_DEPTH: usize = 16;

// /// Network limits
// pub const MAX_REDIRECTS: u8 = 5;
// pub const MAX_HEADERS_SIZE_BYTES: usize = 8 * 1024; // 8 KiB
// pub const MAX_URL_LENGTH_BYTES: usize = 2048;

// /// Security limits
// #[allow(dead_code)]
// pub const MAX_SECRET_LENGTH_BYTES: usize = 1024;
// pub const MAX_KEY_ID_LENGTH_BYTES: usize = 256;
// pub const MAX_PROVIDER_NAME_LENGTH_BYTES: usize = 64;
