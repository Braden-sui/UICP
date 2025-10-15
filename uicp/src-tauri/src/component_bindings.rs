//! Generated bindings for vendored compute components.
//!
//! WHY: Host must share identical type identity with Wasm components. Using `wasmtime::component::bindgen!`
//! guarantees that the Rust side uses the exact WIT definitions we ship, eliminating the ad-hoc typed ladder.

#![cfg(feature = "wasm_compute")]

/// Typed bindings for the `uicp:task-csv-parse@1.2.0` package.
/// INVARIANT: The WIT path matches the vendored component source of truth.
pub mod csv_parse {
    wasmtime::component::bindgen!({
        path: "wit/csv.parse.host.wit",
        world: "task",
        exports: {
            default: async,
        },
    });
}

/// Typed bindings for the `uicp:task-table-query@0.1.0` package.
/// INVARIANT: The WIT path matches the vendored component source of truth.
pub mod table_query {
    wasmtime::component::bindgen!({
        path: "wit/table.query.host.wit",
        world: "task",
        exports: {
            default: async,
        },
    });
}
