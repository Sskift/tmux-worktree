use crate::support::{app_home_dir_or_tmp, atomic_write_file};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

fn dashboard_layout_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn layout_path() -> PathBuf {
    app_home_dir_or_tmp().join(".tw-dashboard-layout.json")
}

pub(crate) fn layout_backup_path(path: &Path, schema_version: u64) -> PathBuf {
    path.with_extension(format!("v{schema_version}.backup.json"))
}

pub(crate) fn layout_schema_version(layout: &serde_json::Value) -> u64 {
    ["schemaVersion", "version"]
        .into_iter()
        .find_map(|key| {
            layout
                .get(key)
                .and_then(serde_json::Value::as_u64)
                .filter(|version| *version > 0)
        })
        .unwrap_or(1)
}

fn backup_layout_before_schema_migration(
    path: &Path,
    next_layout: &serde_json::Value,
) -> Result<Option<PathBuf>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let current_text = std::fs::read_to_string(path)
        .map_err(|error| format!("read layout for backup: {error}"))?;
    let current_layout: serde_json::Value = serde_json::from_str(&current_text)
        .map_err(|error| format!("parse layout for backup: {error}"))?;
    let current_version = layout_schema_version(&current_layout);
    if layout_schema_version(next_layout) <= current_version {
        return Ok(None);
    }

    let backup_path = layout_backup_path(path, current_version);
    if !backup_path.exists() {
        atomic_write_file(&backup_path, current_text.as_bytes())
            .map_err(|error| format!("write layout migration backup: {error}"))?;
    }
    Ok(Some(backup_path))
}

#[derive(Deserialize)]
struct SavedWindowLayout {
    width: f64,
    height: f64,
    x: f64,
    y: f64,
    maximized: bool,
}

pub(crate) fn restore_window_layout(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let path = layout_path();
    if !path.exists() {
        return;
    }
    let Some(saved) = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value.get("window").cloned())
        .and_then(|value| serde_json::from_value::<SavedWindowLayout>(value).ok())
    else {
        return;
    };

    let _ = window.set_size(tauri::LogicalSize::new(
        saved.width.max(960.0),
        saved.height.max(600.0),
    ));
    let _ = window.set_position(tauri::LogicalPosition::new(saved.x, saved.y));
    if saved.maximized {
        let _ = window.maximize();
    }
}

#[tauri::command]
pub(crate) fn load_layout() -> Result<serde_json::Value, String> {
    let path = layout_path();
    if !path.exists() {
        return Ok(serde_json::json!({}));
    }
    let text = std::fs::read_to_string(&path).map_err(|error| format!("read: {error}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| format!("parse: {error}"))?;
    Ok(value)
}

#[tauri::command]
pub(crate) fn save_layout(layout: serde_json::Value) -> Result<(), String> {
    let text =
        serde_json::to_string_pretty(&layout).map_err(|error| format!("serialize: {error}"))?;
    let _guard = dashboard_layout_write_lock()
        .lock()
        .map_err(|_| "dashboard layout write lock poisoned".to_string())?;
    let path = layout_path();
    backup_layout_before_schema_migration(&path, &layout)?;
    atomic_write_file(&path, text.as_bytes()).map_err(|error| format!("write: {error}"))?;
    Ok(())
}
