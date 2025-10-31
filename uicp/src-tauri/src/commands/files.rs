//! File system operations and path management.
use crate::{files_dir_path, DATA_DIR, FILES_DIR};

#[tauri::command]
pub async fn get_paths() -> Result<serde_json::Value, String> {
    // Return canonical string paths so downstream logic receives stable values.
    Ok(serde_json::json!({
        "dataDir": DATA_DIR.display().to_string(),
        "dbPath": crate::DB_PATH.display().to_string(),
        "envPath": crate::ENV_PATH.display().to_string(),
        "filesDir": FILES_DIR.display().to_string(),
    }))
}

#[tauri::command]
pub async fn copy_into_files(_app: tauri::AppHandle, src_path: String) -> Result<String, String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("copy_into_files");
    let p = std::path::Path::new(&src_path);
    if !p.exists() {
        return Err(format!("Source path does not exist: {src_path}"));
    }

    // Only allow regular files; reject symlinks and directories.
    let meta = std::fs::symlink_metadata(p).map_err(|e| format!("stat failed: {e}"))?;
    if !meta.file_type().is_file() {
        return Err("Source must be a regular file".into());
    }

    // Sanitize filename (no directory traversal, keep base name)
    let fname = p
        .file_name()
        .ok_or_else(|| "Invalid source file name".to_string())?
        .to_string_lossy()
        .to_string();
    if fname.trim().is_empty() {
        return Err("Empty file name".into());
    }

    // Map to workspace files dir
    let dest_dir = files_dir_path();
    if let Err(e) = std::fs::create_dir_all(dest_dir) {
        return Err(format!("Failed to create files dir: {e}"));
    }
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ts = chrono::Utc::now().timestamp();
    let dest_with_ts = if let Some(ext) = p.extension().and_then(|s| s.to_str()) {
        format!("{stem}-{ts}.{ext}")
    } else {
        format!("{stem}-{ts}")
    };
    let mut dest: std::path::PathBuf = dest_dir.join(&fname);
    if dest.exists() {
        dest = dest.with_file_name(dest_with_ts);
    }

    std::fs::copy(p, &dest).map_err(|e| format!("Copy failed: {e}"))?;
    Ok(format!(
        "ws:/files/{}",
        dest.file_name().and_then(|s| s.to_str()).unwrap_or("")
    ))
}

#[tauri::command]
pub async fn export_from_files(ws_path: String, dest_path: String) -> Result<String, String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("export_from_files");
    let src_buf: std::path::PathBuf =
        match crate::compute::compute_input::sanitize_ws_files_path(&ws_path) {
            Ok(p) => p,
            Err(e) => return Err(e.message.to_string()),
        };
    if !src_buf.exists() {
        return Err(format!("Source not found: {ws_path}"));
    }
    let meta = std::fs::symlink_metadata(&src_buf).map_err(|e| format!("stat failed: {e}"))?;
    if !meta.file_type().is_file() {
        return Err("Source must be a regular file".into());
    }

    let dest_input = std::path::Path::new(&dest_path);
    let mut dest_final: std::path::PathBuf = if dest_input.is_dir() {
        let fname = src_buf
            .file_name()
            .ok_or_else(|| "Invalid source file name".to_string())?
            .to_string_lossy()
            .to_string();
        dest_input.join(fname)
    } else {
        dest_input.to_path_buf()
    };

    if let Some(parent) = dest_final.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return Err(format!("Failed to create destination dir: {e}"));
        }
    }

    if dest_final.exists() {
        let stem = dest_final
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("file");
        let ext = dest_final
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        let ts = chrono::Utc::now().timestamp();
        let new_name = if ext.is_empty() {
            format!("{stem}-{ts}")
        } else {
            format!("{stem}-{ts}.{ext}")
        };
        let parent = dest_final.parent().map_or_else(
            || std::path::PathBuf::from("."),
            std::path::Path::to_path_buf,
        );
        dest_final = parent.join(new_name);
    }

    std::fs::copy(&src_buf, &dest_final).map_err(|e| format!("Copy failed: {e}"))?;
    Ok(dest_final.display().to_string())
}

#[tauri::command]
pub async fn open_path(path: String) -> Result<(), String> {
    #[cfg(feature = "otel_spans")]
    let _span = tracing::info_span!("open_path");
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {path}"));
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(p)
            .spawn()
            .map_err(|e| format!("Failed to open explorer: {e}"))?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(p)
            .spawn()
            .map_err(|e| format!("Failed to open path: {e}"))?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(p)
            .spawn()
            .map_err(|e| format!("Failed to open path: {e}"))?;
        Ok(())
    }
}
