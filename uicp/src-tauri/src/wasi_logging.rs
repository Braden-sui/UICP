pub mod wasi_logging_shim {
    // Generates a module tree: `wasi::logging::logging::{Level, Host, add_to_linker, ...}`
    wasmtime::component::bindgen!({
        inline: r#"
            package wasi:logging;

            interface logging {
                enum level { trace, debug, info, warn, error, critical }
                log: func(level: level, context: string, message: string);
            }

            world host {
                import wasi:logging/logging;
            }
        "#,
        require_store_data_send: true,
    });

    pub use self::wasi::logging::logging;
}
