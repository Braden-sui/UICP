#![cfg(feature = "compute_harness")]

use std::fs;

use tempfile::tempdir;
use uicp::test_support::ComputeTestHarness;

#[tokio::test]
async fn harness_command_shims_cover_admin_ops() {
    let harness = ComputeTestHarness::new_async().await.expect("compute harness");

    // Exercise modules info shim
    let info = harness.modules_info().await.expect("modules info");
    assert!(
        info.get("dir")
            .and_then(|v| v.as_str())
            .map(|p| !p.is_empty())
            .unwrap_or(false),
        "module info should surface module dir"
    );

    // Load/save workspace round-trip (stubs return empty vec but must succeed).
    let windows = harness.load_workspace().await.expect("load workspace");
    assert!(
        windows.is_empty(),
        "initial workspace load should return no windows in harness stub"
    );
    harness
        .save_workspace(Vec::new())
        .await
        .expect("save workspace");

    // Clear compute cache (idempotent if nothing cached).
    harness
        .clear_compute_cache(None)
        .await
        .expect("clear compute cache");

    // Copy a temp file into the workspace and verify it materializes.
    let tmp_dir = tempdir().expect("temp dir");
    let src_path = tmp_dir.path().join("sample.txt");
    fs::write(&src_path, "shim copy payload").expect("write sample file");
    let dest_uri = harness
        .copy_into_files(&src_path)
        .await
        .expect("copy into files");
    assert!(
        dest_uri.starts_with("ws:/files/"),
        "copy result should be workspace URI, got {dest_uri}"
    );
    let dest_name = dest_uri.trim_start_matches("ws:/files/");
    let dest_fs = harness.workspace_dir().join("files").join(dest_name);
    assert!(
        dest_fs.exists(),
        "copied file should exist at {}",
        dest_fs.display()
    );
}
