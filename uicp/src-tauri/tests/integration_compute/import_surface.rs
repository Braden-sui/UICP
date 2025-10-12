//! Import surface enumeration for the log.test component.
//! Ensures it imports wasi:logging but not wasi:http or wasi:sockets.

use std::path::PathBuf;
use std::process::Command;

fn comp_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("components").join("log.test")
}

fn csv_parse_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("components").join("csv.parse")
}

fn table_query_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("components").join("table.query")
}

fn wit_of_component(dir: PathBuf, artifact: &str) -> String {
    use std::process::Command as Cmd;
    let manifest = dir.join("Cargo.toml");
    let status = Cmd::new("cargo")
        .args(["component", "build", "--release", "--manifest-path"])
        .arg(&manifest)
        .status()
        .expect("spawn cargo component");
    assert!(status.success(), "cargo component build failed");
    let wasm = dir
        .join("target")
        .join("wasm32-wasi")
        .join("release")
        .join(artifact);
    assert!(wasm.exists(), "component artifact missing: {}", wasm.display());
    let output = Cmd::new("wit-component")
        .args(["wit"]) // prints WIT
        .arg(&wasm)
        .output()
        .expect("spawn wit-component");
    assert!(output.status.success(), "wit-component execution failed");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

#[test]
fn csv_parse_component_imports_expected() {
    let wit = wit_of_component(csv_parse_dir(), "uicp_task_csv_parse.wasm");
    // Should include wasi:io and wasi:logging
    assert!(wit.contains("wasi:io"));
    assert!(wit.contains("wasi:logging"));
    // Should not include networking/http surfaces
    assert!(!wit.contains("wasi:http"), "unexpected wasi:http in imports: \n{}", wit);
    assert!(
        !wit.contains("wasi:sockets"),
        "unexpected wasi:sockets in imports: \n{}",
        wit
    );
}

#[test]
fn table_query_component_imports_expected() {
    let wit = wit_of_component(table_query_dir(), "uicp_task_table_query.wasm");
    // Should include wasi:io and wasi:logging
    assert!(wit.contains("wasi:io"));
    assert!(wit.contains("wasi:logging"));
    // Should not include networking/http surfaces
    assert!(!wit.contains("wasi:http"), "unexpected wasi:http in imports: \n{}", wit);
    assert!(
        !wit.contains("wasi:sockets"),
        "unexpected wasi:sockets in imports: \n{}",
        wit
    );
}

#[test]
fn log_test_component_imports_logging_only() {
    // Build the component (release to ensure stable path)
    let manifest = comp_dir().join("Cargo.toml");
    let status = Command::new("cargo")
        .args(["component", "build", "--release", "--manifest-path"])
        .arg(&manifest)
        .status()
        .expect("spawn cargo component");
    assert!(status.success(), "cargo component build failed");

    let wasm = comp_dir()
        .join("target")
        .join("wasm32-wasi")
        .join("release")
        .join("uicp_task_log_test.wasm");
    assert!(wasm.exists(), "component artifact missing: {}", wasm.display());

    // Enumerate imports via wit-component CLI
    let output = Command::new("wit-component")
        .args(["wit"]) // prints WIT
        .arg(&wasm)
        .output()
        .expect("spawn wit-component");
    assert!(output.status.success(), "wit-component execution failed");
    let wit = String::from_utf8_lossy(&output.stdout);

    // Should include wasi:logging
    assert!(wit.contains("import wasi:logging/logging"));
    // Should not include networking/http surfaces
    assert!(!wit.contains("wasi:http"), "unexpected wasi:http in imports: \n{}", wit);
    assert!(!wit.contains("wasi:sockets"), "unexpected wasi:sockets in imports: \n{}", wit);
}

