#[cfg(target_os = "windows")]
fn compile_windows_resources() {
    // WHY: Embed v6 common-controls manifest so TaskDialogIndirect resolves when tests run standalone.
    println!("cargo:rerun-if-changed=windows.rc");
    println!("cargo:rerun-if-changed=windows.manifest");
    embed_resource::compile_for_everything("windows.rc", embed_resource::NONE);
}

#[cfg(not(target_os = "windows"))]
fn compile_windows_resources() {}

#[cfg(target_os = "windows")]
use std::env;
use std::fs;

#[cfg(target_os = "windows")]
fn add_delayload_for_tests_and_harness() {
    // WHY: On some Windows hosts the loader picks comctl32 v5.82; delay-loading avoids process-start failure
    // when the symbol is never called (our harness doesn't show native dialogs).
    let is_harness = env::var("CARGO_FEATURE_COMPUTE_HARNESS").is_ok();
    let is_test = env::var("CARGO_CFG_TEST").is_ok();
    if is_harness || is_test {
        // Target only test executables and the harness binary; avoid leaking delay-load into the main app binary.
        println!("cargo:rustc-link-arg-tests=/DELAYLOAD:comctl32.dll");
        println!("cargo:rustc-link-arg-bin=compute_harness=/DELAYLOAD:comctl32.dll");
    }
}

#[cfg(not(target_os = "windows"))]
fn add_delayload_for_tests_and_harness() {}

fn assert_sanitized_wit(
    src: &str,
    sanitized_path: &str,
    strip_imports: bool,
) -> std::io::Result<()> {
    println!("cargo:rerun-if-changed={src}");
    println!("cargo:rerun-if-changed={sanitized_path}");
    let contents = fs::read_to_string(src)?;
    let mut expected = if strip_imports {
        contents
            .lines()
            .filter(|line| !line.trim_start().starts_with("import "))
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        contents
    };
    if !expected.ends_with('\n') {
        expected.push('\n');
    }
    let actual = fs::read_to_string(sanitized_path)?;
    if actual != expected {
        panic!("Sanitized WIT '{sanitized_path}' is stale; regenerate from {src}");
    }
    Ok(())
}

fn main() {
    compile_windows_resources();
    // WHY: Ensure delay-load hint for comctl32.dll is applied in test and harness builds on Windows.
    add_delayload_for_tests_and_harness();
    // WHY: Resolve __delayLoadHelper2 when /DELAYLOAD is in effect; safe to link for all targets.
    #[cfg(target_os = "windows")]
    println!("cargo:rustc-link-lib=dylib=delayimp");
    assert_sanitized_wit(
        "../components/csv.parse/csv-parse/wit/world.wit",
        "wit/csv.parse.host.wit",
        false,
    )
    .expect("validate csv.parse host WIT");
    assert_sanitized_wit(
        "../components/table.query/wit/world.wit",
        "wit/table.query.host.wit",
        true,
    )
    .expect("validate table.query host WIT");
    tauri_build::build();
}
