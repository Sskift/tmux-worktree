use crate::config::config_worktree_base;
use crate::features::sessions::{derive_session_name, is_git_worktree_dir, list_local_sessions};
use crate::ipc::OrphanedWorktree;
use crate::support::{
    app_home_dir, app_home_dir_or_tmp, default_worktree_base, git_bin, run_check,
    LEGACY_DEFAULT_WORKTREE_BASE,
};
use std::collections::HashSet;

fn pending_cleanup_path() -> std::path::PathBuf {
    app_home_dir_or_tmp().join(".tw-dashboard-pending-worktree-cleanup.json")
}

pub(crate) fn load_pending_cleanup() -> Vec<OrphanedWorktree> {
    let path = pending_cleanup_path();
    if !path.exists() {
        return vec![];
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<OrphanedWorktree>>(&text).ok())
        .unwrap_or_default()
}

pub(crate) fn save_pending_cleanup(entries: &[OrphanedWorktree]) {
    let path = pending_cleanup_path();
    if entries.is_empty() {
        let _ = std::fs::remove_file(path);
        return;
    }
    if let Ok(text) = serde_json::to_string_pretty(entries) {
        let _ = std::fs::write(path, text);
    }
}

pub(crate) fn remove_pending_cleanup_path(path: &str) {
    let mut pending = load_pending_cleanup();
    pending.retain(|entry| entry.path != path);
    save_pending_cleanup(&pending);
}

fn live_session_names() -> HashSet<String> {
    list_local_sessions()
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.raw_name)
        .collect()
}

pub(crate) fn orphaned_worktrees(
    base_path: &std::path::Path,
    live_sessions: &HashSet<String>,
) -> Vec<OrphanedWorktree> {
    if !base_path.exists() {
        return vec![];
    }

    let project_dirs = match std::fs::read_dir(base_path) {
        Ok(rd) => rd,
        Err(_) => return vec![],
    };

    let mut orphans = Vec::new();
    for project_entry in project_dirs.flatten() {
        if !project_entry.path().is_dir() {
            continue;
        }
        let project = project_entry.file_name().to_string_lossy().to_string();
        let wt_dirs = match std::fs::read_dir(project_entry.path()) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for wt_entry in wt_dirs.flatten() {
            let wt_path = wt_entry.path();
            if !wt_path.is_dir() {
                continue;
            }
            if !is_git_worktree_dir(&wt_path) {
                continue;
            }
            let dirname = wt_entry.file_name().to_string_lossy().to_string();
            let session_name = derive_session_name(&dirname);
            if live_sessions.contains(&session_name) {
                continue;
            }
            orphans.push(OrphanedWorktree {
                project: project.clone(),
                path: wt_path.to_string_lossy().to_string(),
                name: session_name,
            });
        }
    }
    orphans
}

#[cfg(test)]
pub(crate) fn worktrees_for_session(
    base_path: &std::path::Path,
    session_name: &str,
) -> Vec<OrphanedWorktree> {
    if !base_path.exists() {
        return vec![];
    }

    let project_dirs = match std::fs::read_dir(base_path) {
        Ok(rd) => rd,
        Err(_) => return vec![],
    };

    let mut matches = Vec::new();
    for project_entry in project_dirs.flatten() {
        if !project_entry.path().is_dir() {
            continue;
        }
        let project = project_entry.file_name().to_string_lossy().to_string();
        let wt_dirs = match std::fs::read_dir(project_entry.path()) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for wt_entry in wt_dirs.flatten() {
            let wt_path = wt_entry.path();
            if !wt_path.is_dir() {
                continue;
            }
            if !is_git_worktree_dir(&wt_path) {
                continue;
            }
            let dirname = wt_entry.file_name().to_string_lossy().to_string();
            if derive_session_name(&dirname) != session_name {
                continue;
            }
            matches.push(OrphanedWorktree {
                project: project.clone(),
                path: wt_path.to_string_lossy().to_string(),
                name: session_name.to_string(),
            });
        }
    }
    matches
}

fn repo_root_for_worktree(path: &str) -> Option<String> {
    let common_dir = run_check(&[
        "git",
        "-C",
        path,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
    ])
    .ok()?;
    let common_path = std::path::Path::new(&common_dir);
    if common_path.file_name().and_then(|n| n.to_str()) == Some(".git") {
        return common_path
            .parent()
            .map(|p| p.to_string_lossy().to_string());
    }
    None
}

pub(crate) fn try_cleanup_worktree(path: &str, force: bool) -> bool {
    let worktree_path = std::path::Path::new(path);
    if !worktree_path.exists() {
        return true;
    }
    let Some(repo_root) = repo_root_for_worktree(path) else {
        return false;
    };
    let mut args = vec!["-C", &repo_root, "worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(path);
    let output = std::process::Command::new(git_bin()).args(args).output();
    let Ok(output) = output else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    if worktree_path.exists() {
        let _ = std::fs::remove_dir_all(worktree_path);
    }
    !worktree_path.exists()
}

pub(crate) fn worktree_has_uncommitted_changes(path: &str) -> Option<bool> {
    let worktree_path = std::path::Path::new(path);
    if !worktree_path.exists() {
        return Some(false);
    }
    let output = std::process::Command::new(git_bin())
        .args(["-C", path, "status", "--porcelain"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(!output.stdout.is_empty())
}

pub(crate) fn cleanup_pending_worktrees() {
    let live_sessions = live_session_names();
    let mut remaining = Vec::new();
    for entry in load_pending_cleanup() {
        if !std::path::Path::new(&entry.path).exists() {
            continue;
        }
        if live_sessions.contains(&entry.name) {
            continue;
        }
        if !try_cleanup_worktree(&entry.path, false) {
            remaining.push(entry);
        }
    }
    save_pending_cleanup(&remaining);
}

#[tauri::command]
pub(crate) fn list_orphaned_worktrees() -> Result<Vec<OrphanedWorktree>, String> {
    let home = app_home_dir().ok_or("home dir not found")?;
    let config_path = home.join(".tmux-worktree.json");
    let config: serde_json::Value = if config_path.exists() {
        let text =
            std::fs::read_to_string(&config_path).map_err(|e| format!("read config: {e}"))?;
        serde_json::from_str(&text).map_err(|e| format!("parse config: {e}"))?
    } else {
        serde_json::json!({})
    };

    let worktree_base = config_worktree_base(&config).unwrap_or_else(default_worktree_base);
    let live = live_session_names();
    let mut orphans = orphaned_worktrees(std::path::Path::new(&worktree_base), &live);
    if worktree_base != LEGACY_DEFAULT_WORKTREE_BASE {
        let mut seen = orphans
            .iter()
            .map(|orphan| orphan.path.clone())
            .collect::<HashSet<_>>();
        orphans.extend(
            orphaned_worktrees(std::path::Path::new(LEGACY_DEFAULT_WORKTREE_BASE), &live)
                .into_iter()
                .filter(|orphan| seen.insert(orphan.path.clone())),
        );
    }
    Ok(orphans)
}
