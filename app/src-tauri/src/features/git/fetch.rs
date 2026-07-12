use super::runner::run_git_quiet;
use crate::config::list_projects;
use crate::ipc::Project;
use crate::support::git_bin;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

pub(crate) const GIT_FETCH_INTERVAL_SECONDS: u64 = 5 * 60;

#[derive(Default)]
pub(crate) struct GitFetchTracker {
    last_started: HashMap<String, u64>,
    in_flight: HashSet<String>,
}

#[derive(Default)]
pub(crate) struct GitFetchState {
    tracker: Mutex<GitFetchTracker>,
}

fn now_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn is_fetchable_git_repo(path: &str) -> bool {
    run_git_quiet(None, &["-C", path, "rev-parse", "--is-inside-work-tree"]).as_deref()
        == Some("true")
}

pub(crate) fn fetchable_project_paths(projects: &[Project]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut paths = Vec::new();

    for project in projects {
        let raw = project.path.trim();
        if raw.is_empty() || !is_fetchable_git_repo(raw) {
            continue;
        }
        let canonical = std::fs::canonicalize(raw)
            .unwrap_or_else(|_| PathBuf::from(raw))
            .to_string_lossy()
            .to_string();
        if seen.insert(canonical.clone()) {
            paths.push(canonical);
        }
    }

    paths
}

pub(crate) fn reserve_git_fetch_target(
    tracker: &mut GitFetchTracker,
    target: &str,
    now: u64,
) -> bool {
    if tracker.in_flight.contains(target) {
        return false;
    }
    if tracker
        .last_started
        .get(target)
        .is_some_and(|last| now.saturating_sub(*last) < GIT_FETCH_INTERVAL_SECONDS)
    {
        return false;
    }

    tracker.last_started.insert(target.to_string(), now);
    tracker.in_flight.insert(target.to_string());
    true
}

pub(crate) fn finish_git_fetch_target(tracker: &mut GitFetchTracker, target: &str) {
    tracker.in_flight.remove(target);
}

pub(crate) fn git_fetch_args(path: &str) -> [&str; 6] {
    ["-C", path, "fetch", "--all", "--prune", "--quiet"]
}

fn git_fetch_project_root(path: &str) {
    let _ = std::process::Command::new(git_bin())
        .args(git_fetch_args(path))
        .env("GIT_TERMINAL_PROMPT", "0")
        .output();
}

fn git_fetch_project_roots_blocking(state: Arc<GitFetchState>) -> Result<(), String> {
    let projects = list_projects()?;
    let paths = fetchable_project_paths(&projects);
    if paths.is_empty() {
        return Ok(());
    }

    let now = now_unix_seconds();
    let targets = {
        let mut tracker = state.tracker.lock().unwrap();
        paths
            .into_iter()
            .filter(|path| reserve_git_fetch_target(&mut tracker, path, now))
            .collect::<Vec<_>>()
    };

    for target in targets {
        let state = state.clone();
        thread::spawn(move || {
            git_fetch_project_root(&target);
            let mut tracker = state.tracker.lock().unwrap();
            finish_git_fetch_target(&mut tracker, &target);
        });
    }

    Ok(())
}

#[tauri::command]
pub(crate) async fn git_fetch_project_roots(
    state: State<'_, Arc<GitFetchState>>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || git_fetch_project_roots_blocking(state))
        .await
        .map_err(|error| format!("git fetch discovery task failed: {error}"))?
}
