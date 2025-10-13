pub mod wasi_logging_shim {
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
        require_store_data_send: true,
    });

    pub use bindings::imports::logging;
}
