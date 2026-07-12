use crate::config::{acquire_dashboard_file_lock, DashboardConfigFileLock};
use crate::support::{app_home_dir_or_tmp, atomic_write_file};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// Coordinate terminal metadata writes with Relay Host. Both processes use
/// the exact `<registry>.lock/owner.json` owner-token protocol.
fn acquire_terminal_registry_file_lock() -> Result<DashboardConfigFileLock, String> {
    let registry = terminals_path();
    acquire_dashboard_file_lock(
        PathBuf::from(format!("{}.lock", registry.display())),
        "terminal registry",
    )
}

fn dashboard_terminal_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn terminals_path() -> std::path::PathBuf {
    app_home_dir_or_tmp().join(".tw-dashboard-terminals.json")
}

#[tauri::command]
pub(crate) fn load_terminals() -> Result<Vec<serde_json::Value>, String> {
    let p = terminals_path();
    if !p.exists() {
        return Ok(vec![]);
    }
    let text = std::fs::read_to_string(&p).map_err(|e| format!("read: {e}"))?;
    let arr: Vec<serde_json::Value> =
        serde_json::from_str(&text).map_err(|e| format!("parse: {e}"))?;
    Ok(arr)
}

#[tauri::command]
pub(crate) fn save_terminals(terminals: Vec<serde_json::Value>) -> Result<(), String> {
    let mut text = serde_json::to_string_pretty(&terminals)
        .map_err(|e| format!("serialize terminal registry: {e}"))?;
    text.push('\n');
    let _guard = dashboard_terminal_write_lock()
        .lock()
        .map_err(|_| "dashboard terminal write lock poisoned".to_string())?;
    let _file_guard = acquire_terminal_registry_file_lock()?;
    atomic_write_file(&terminals_path(), text.as_bytes())
}
