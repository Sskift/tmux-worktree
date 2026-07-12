mod hosts;
mod projects;

pub(crate) use hosts::*;
pub(crate) use projects::*;

use crate::support::app_home_dir_or_tmp;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(crate) fn string_field<'a>(value: &'a serde_json::Value, names: &[&str]) -> Option<&'a str> {
    names
        .iter()
        .find_map(|name| value.get(name).and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub(crate) fn trimmed_non_empty_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub(crate) fn dashboard_config_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub(crate) struct DashboardConfigFileLock {
    pub(crate) path: PathBuf,
    pub(crate) owner: String,
}

impl Drop for DashboardConfigFileLock {
    fn drop(&mut self) {
        let is_current_owner = read_dashboard_config_lock_owner(&self.path)
            .is_some_and(|record| record.owner == self.owner);
        if is_current_owner {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}

const DASHBOARD_CONFIG_LOCK_OWNER_FILE: &str = "owner.json";
const DASHBOARD_CONFIG_LOCK_STALE_MS: u64 = 60_000;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardConfigLockOwner {
    pub(crate) owner: String,
    pub(crate) created_at: u64,
}

fn dashboard_config_lock_owner_path(path: &Path) -> PathBuf {
    path.join(DASHBOARD_CONFIG_LOCK_OWNER_FILE)
}

pub(crate) fn read_dashboard_config_lock_owner(path: &Path) -> Option<DashboardConfigLockOwner> {
    let text = std::fs::read_to_string(dashboard_config_lock_owner_path(path)).ok()?;
    serde_json::from_str(&text).ok()
}

fn dashboard_config_lock_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn dashboard_config_lock_is_stale(path: &Path) -> bool {
    if let Some(record) = read_dashboard_config_lock_owner(path) {
        return dashboard_config_lock_now_ms().saturating_sub(record.created_at)
            > DASHBOARD_CONFIG_LOCK_STALE_MS;
    }
    std::fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age > Duration::from_millis(DASHBOARD_CONFIG_LOCK_STALE_MS))
}

fn write_dashboard_config_lock_owner(
    path: &Path,
    record: &DashboardConfigLockOwner,
) -> Result<(), String> {
    let owner_path = dashboard_config_lock_owner_path(path);
    let contents = serde_json::to_vec(record)
        .map_err(|error| format!("serialize dashboard config lock owner: {error}"))?;
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&owner_path)
        .map_err(|error| format!("create dashboard config lock owner: {error}"))?;
    file.write_all(&contents)
        .map_err(|error| format!("write dashboard config lock owner: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("sync dashboard config lock owner: {error}"))?;
    Ok(())
}

pub(crate) fn acquire_dashboard_file_lock(
    path: PathBuf,
    description: &str,
) -> Result<DashboardConfigFileLock, String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let owner = format!("{}-{}", std::process::id(), uuid::Uuid::new_v4().simple());
    loop {
        let create_result = {
            let mut builder = std::fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder.create(&path)
        };
        match create_result {
            Ok(()) => {
                let record = DashboardConfigLockOwner {
                    owner: owner.clone(),
                    created_at: dashboard_config_lock_now_ms(),
                };
                if let Err(error) = write_dashboard_config_lock_owner(&path, &record) {
                    let _ = std::fs::remove_dir_all(&path);
                    return Err(error);
                }
                return Ok(DashboardConfigFileLock {
                    path,
                    owner: owner.clone(),
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if dashboard_config_lock_is_stale(&path) {
                    let _ = std::fs::remove_dir_all(&path);
                    continue;
                }
                if Instant::now() >= deadline {
                    return Err(format!(
                        "timed out waiting for {description} lock: {}",
                        path.display()
                    ));
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => {
                return Err(format!(
                    "create {description} lock {}: {error}",
                    path.display()
                ));
            }
        }
    }
}

/// Coordinate ~/.tmux-worktree.json writes with the `tw host` process.
/// The in-process mutex alone cannot prevent CLI/Dashboard lost updates.
pub(crate) fn acquire_dashboard_config_file_lock() -> Result<DashboardConfigFileLock, String> {
    acquire_dashboard_file_lock(
        app_home_dir_or_tmp().join(".tmux-worktree.json.lock"),
        "dashboard config",
    )
}
