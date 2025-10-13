pub mod wasi_logging_shim {
    pub mod bindings {
        // Generates a module tree: `wasi::logging::logging::{Level, Host, add_to_linker, ...}`
        wasmtime::component::bindgen!({
            inline: r#"
                package uicp:wasi-log-bridge@0.1.0;

                interface logging {
                    enum level { trace, debug, info, warn, error, critical }
                    log: func(level: level, context: string, message: string);
                }

                world host {
                    import logging;
                }
            "#,
            // WHY: `Ctx` embeds `ResourceTable` which is !Send; logging hostcalls operate on the same thread.
            require_store_data_send: false,
        });

        pub mod imports {
            pub use super::uicp::wasi_log_bridge::logging;
        }
    }

    // WHY: Surface the generated logging interface under a stable module path for compute hostcalls.
    // INVARIANT: Package path `uicp:wasi-log-bridge@0.1.0` must stay in sync with the WIT schema version.
    pub use bindings::imports::logging;
    #[cfg(feature = "uicp_wasi_enable")]
    pub use bindings::imports::logging::add_to_linker;
}

#[cfg(all(test, feature = "wasm_compute"))]
mod tests {
    use super::wasi_logging_shim;

    #[test]
    fn exposes_logging_level_enum() {
        // WHY: Asserts bindgen wiring exposes the expected enum variants; compile will fail if the package path shifts.
        assert!(
            matches!(
                wasi_logging_shim::logging::Level::Info,
                wasi_logging_shim::logging::Level::Info
            ),
            "E-UICP-901: logging level Info should be re-exported via wasi_logging_shim"
        );
    }
}
