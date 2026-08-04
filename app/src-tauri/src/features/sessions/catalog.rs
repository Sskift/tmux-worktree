use super::{
    local_session_active_cwd, managed_worktree_root_for_session, pane_output_signature,
    project_from_worktree_path, remote_git_root, remote_session_active_cwd,
    remote_session_activity_samples, remote_tmux_session_is_worktree, session_agent_running,
    tmux_list_sessions_fmt,
};
use crate::config::{config_worktree_base, load_hosts, trimmed_non_empty_string};
use crate::ipc::{DashboardCatalogSnapshot, Session, TmuxTerminal, TwRpcListResponse};
use crate::remote::{run_remote_tmux_check, run_remote_tw_check, HostConfig};
use crate::support::{app_home_dir_or_tmp, default_worktree_base, tmux_bin};
use std::collections::{HashMap, HashSet};

#[tauri::command]
pub(crate) async fn list_sessions() -> Result<Vec<Session>, String> {
    tauri::async_runtime::spawn_blocking(list_sessions_blocking)
        .await
        .map_err(|e| format!("list sessions task failed: {e}"))?
}

#[tauri::command]
pub(crate) async fn list_dashboard_catalog() -> Result<DashboardCatalogSnapshot, String> {
    tauri::async_runtime::spawn_blocking(list_dashboard_catalog_blocking)
        .await
        .map_err(|e| format!("list dashboard catalog task failed: {e}"))?
}

#[tauri::command]
pub(crate) async fn list_local_dashboard_catalog() -> Result<DashboardCatalogSnapshot, String> {
    tauri::async_runtime::spawn_blocking(list_local_dashboard_catalog_blocking)
        .await
        .map_err(|e| format!("list local dashboard catalog task failed: {e}"))?
}

fn list_local_dashboard_catalog_blocking() -> Result<DashboardCatalogSnapshot, String> {
    let host_ids = load_hosts()?
        .into_iter()
        .map(|host| host.id)
        .collect::<Vec<_>>();
    Ok(DashboardCatalogSnapshot {
        sessions: list_local_sessions()?,
        terminals: list_local_tmux_terminals()?,
        failed_session_host_ids: host_ids.clone(),
        failed_terminal_host_ids: host_ids,
    })
}

fn list_dashboard_catalog_blocking() -> Result<DashboardCatalogSnapshot, String> {
    let mut sessions = list_local_sessions()?;
    let mut terminals = list_local_tmux_terminals()?;
    let mut failed_session_host_ids = Vec::new();
    let mut failed_terminal_host_ids = Vec::new();

    for host in load_hosts()? {
        match list_remote_sessions(&host) {
            Ok(remote) => sessions.extend(remote),
            Err(_) => failed_session_host_ids.push(host.id.clone()),
        }
        match list_remote_tmux_terminals(&host) {
            Ok(remote) => terminals.extend(remote),
            Err(_) => failed_terminal_host_ids.push(host.id.clone()),
        }
    }

    Ok(DashboardCatalogSnapshot {
        sessions,
        terminals,
        failed_session_host_ids,
        failed_terminal_host_ids,
    })
}

fn list_sessions_blocking() -> Result<Vec<Session>, String> {
    let mut all = list_local_sessions()?;
    let hosts = load_hosts().unwrap_or_default();
    for host in &hosts {
        if let Ok(sessions) = list_remote_sessions(host) {
            all.extend(sessions);
        }
    }
    Ok(all)
}

fn local_managed_projects_by_session() -> HashMap<String, String> {
    let path = app_home_dir_or_tmp()
        .join(".tmux-worktree")
        .join("state.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return HashMap::new();
    };
    let Some(sessions) = value.get("sessions").and_then(|value| value.as_array()) else {
        return HashMap::new();
    };
    sessions
        .iter()
        .filter_map(|session| {
            let name = session.get("name")?.as_str()?;
            let project = session.get("project")?.as_str()?;
            Some((name.to_string(), trimmed_non_empty_string(project)?))
        })
        .collect()
}

fn local_managed_session_names(kind: &str) -> HashSet<String> {
    let path = app_home_dir_or_tmp()
        .join(".tmux-worktree")
        .join("state.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        return HashSet::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return HashSet::new();
    };
    value
        .get("sessions")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter(|session| session.get("kind").and_then(serde_json::Value::as_str) == Some(kind))
        .filter_map(|session| session.get("name")?.as_str().map(ToString::to_string))
        .collect()
}

pub(crate) fn list_local_sessions() -> Result<Vec<Session>, String> {
    let config_path = app_home_dir_or_tmp().join(".tmux-worktree.json");
    let worktree_base = std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|config| config_worktree_base(&config))
        .unwrap_or_else(default_worktree_base);
    let managed_projects = local_managed_projects_by_session();
    let managed_names = local_managed_session_names("worktree");
    let fmt = "#{session_id}\x1f#{session_name}\x1f#{session_attached}\x1f#{session_windows}\x1f#{session_created}\x1f#{session_activity}\x1f#{pane_current_path}";
    let output = std::process::Command::new(tmux_bin())
        .args(["list-sessions", "-F", fmt])
        .output()
        .map_err(|e| format!("spawn tmux: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("no server running") || stderr.contains("no current server") {
            return Ok(vec![]);
        }
        return Err(format!("tmux exited {}: {}", output.status, stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let sessions = stdout
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let mut parts = line.split('\x1f');
            let session_id = parts.next()?.to_string();
            let name = parts.next()?.to_string();
            if name.starts_with("tw-term-") || name.starts_with("tw-mobile-") {
                return None;
            }
            let attached = parts.next()? == "1";
            let window_count = parts.next()?.parse().ok()?;
            let created = parts.next()?.parse().ok()?;
            let activity = parts.next()?.parse().ok()?;
            let cwd = parts.next()?.to_string();
            let worktree_root = managed_worktree_root_for_session(&name, &cwd, &worktree_base)?;
            let output_signature = pane_output_signature(&session_id);
            let agent_running = session_agent_running(&session_id);
            let project = managed_projects
                .get(&name)
                .cloned()
                .or_else(|| project_from_worktree_path(&worktree_root, &worktree_base));
            Some(Session {
                name: name.clone(),
                attached,
                window_count,
                created,
                activity,
                output_signature,
                agent_running,
                host_id: None,
                raw_name: name.clone(),
                project,
                managed: managed_names.contains(&name),
            })
        })
        .collect();

    Ok(sessions)
}

pub(crate) fn list_remote_sessions(host: &HostConfig) -> Result<Vec<Session>, String> {
    let managed = list_remote_sessions_from_tw_rpc(host);
    let discovered = list_remote_sessions_via_tmux(host);
    match (managed, discovered) {
        (Ok(mut managed), Ok(discovered)) => {
            let mut seen = managed
                .iter()
                .map(|session| session.raw_name.clone())
                .collect::<HashSet<_>>();
            managed.extend(
                discovered
                    .into_iter()
                    .filter(|session| seen.insert(session.raw_name.clone())),
            );
            Ok(managed)
        }
        (Ok(managed), Err(_)) => Ok(managed),
        (Err(_), Ok(discovered)) => Ok(discovered),
        (Err(rpc_error), Err(tmux_error)) => Err(format!(
            "remote session catalog failed via tw rpc ({rpc_error}) and tmux ({tmux_error})"
        )),
    }
}

fn list_remote_sessions_from_tw_rpc(host: &HostConfig) -> Result<Vec<Session>, String> {
    let response = remote_tw_rpc_list(host)?;
    let sessions = response
        .sessions
        .into_iter()
        .filter(|session| session.kind == "worktree")
        .collect::<Vec<_>>();
    let raw_names = sessions
        .iter()
        .map(|session| session.name.clone())
        .collect::<Vec<_>>();
    let activity_samples = remote_session_activity_samples(host, &raw_names).unwrap_or_default();

    Ok(sessions
        .into_iter()
        .map(|session| {
            let composite_name = format!("{}:{}", host.id, session.name);
            let activity = activity_samples
                .get(&session.name)
                .cloned()
                .unwrap_or_default();
            Session {
                name: composite_name,
                attached: session.attached,
                window_count: session.windows,
                created: session.created,
                activity: session.activity,
                output_signature: activity.output_signature,
                agent_running: activity.agent_running,
                host_id: Some(host.id.clone()),
                raw_name: session.name,
                project: session
                    .project
                    .and_then(|project| trimmed_non_empty_string(&project)),
                managed: true,
            }
        })
        .collect())
}

fn remote_tw_rpc_list(host: &HostConfig) -> Result<TwRpcListResponse, String> {
    let output = run_remote_tw_check(host, &["rpc", "list"])?;
    let response: TwRpcListResponse =
        serde_json::from_str(&output).map_err(|e| format!("parse tw rpc list: {e}"))?;
    if response.protocol_version != 1 {
        return Err(format!(
            "unsupported tw rpc protocol: {}",
            response.protocol_version
        ));
    }
    Ok(response)
}

fn list_remote_sessions_via_tmux(host: &HostConfig) -> Result<Vec<Session>, String> {
    let fmt = "#{session_name}\x1f#{session_attached}\x1f#{session_windows}\x1f#{session_created}\x1f#{session_activity}";
    let output = run_remote_tmux_check(host, &["list-sessions", "-F", fmt])?;
    let remote_worktree_base = host
        .worktree_base
        .as_deref()
        .unwrap_or("~/.tmux-worktree/worktrees")
        .to_string();

    let rows = output
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let mut parts = line.split('\x1f');
            let raw_name = parts.next()?.to_string();
            if raw_name.starts_with("tw-term-") || raw_name.starts_with("tw-mobile-") {
                return None;
            }
            if !remote_tmux_session_is_worktree(host, &raw_name) {
                return None;
            }
            let attached = parts.next()? == "1";
            let window_count = parts.next()?.parse().ok()?;
            let created = parts.next()?.parse().ok()?;
            let activity = parts.next()?.parse().ok()?;
            Some((raw_name, attached, window_count, created, activity))
        })
        .collect::<Vec<_>>();
    let raw_names = rows
        .iter()
        .map(|(raw_name, _, _, _, _)| raw_name.clone())
        .collect::<Vec<_>>();
    let activity_samples = remote_session_activity_samples(host, &raw_names).unwrap_or_default();

    let sessions = rows
        .into_iter()
        .map(|(raw_name, attached, window_count, created, activity)| {
            let activity_sample = activity_samples.get(&raw_name).cloned().unwrap_or_default();
            let composite_name = format!("{}:{}", host.id, raw_name);
            let project = remote_session_active_cwd(host, &raw_name)
                .and_then(|cwd| remote_git_root(host, &cwd))
                .and_then(|git_root| project_from_worktree_path(&git_root, &remote_worktree_base));
            Session {
                name: composite_name,
                attached,
                window_count,
                created,
                activity,
                output_signature: activity_sample.output_signature,
                agent_running: activity_sample.agent_running,
                host_id: Some(host.id.clone()),
                raw_name,
                project,
                managed: false,
            }
        })
        .collect();

    Ok(sessions)
}

#[tauri::command]
pub(crate) async fn list_tmux_terminals() -> Result<Vec<TmuxTerminal>, String> {
    tauri::async_runtime::spawn_blocking(list_tmux_terminals_blocking)
        .await
        .map_err(|e| format!("list tmux terminals task failed: {e}"))?
}

fn list_tmux_terminals_blocking() -> Result<Vec<TmuxTerminal>, String> {
    let mut terminals = list_local_tmux_terminals()?;
    let hosts = load_hosts().unwrap_or_default();
    for host in &hosts {
        if let Ok(remote) = list_remote_tmux_terminals(host) {
            terminals.extend(remote);
        }
    }
    Ok(terminals)
}

fn list_local_tmux_terminals() -> Result<Vec<TmuxTerminal>, String> {
    let managed_names = local_managed_session_names("terminal");
    let output = std::process::Command::new(tmux_bin())
        .args(["list-sessions", "-F", tmux_list_sessions_fmt()])
        .output()
        .map_err(|e| format!("spawn tmux: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("no server running") || stderr.contains("no current server") {
            return Ok(vec![]);
        }
        return Err(format!("tmux exited {}: {}", output.status, stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\x1f');
            let raw_name = parts.next()?.to_string();
            if !raw_name.starts_with("tw-term-") || raw_name.starts_with("tw-mobile-") {
                return None;
            }
            let cwd = local_session_active_cwd(&raw_name).unwrap_or_default();
            Some(TmuxTerminal {
                id: format!("tmux:{}", raw_name),
                label: raw_name.clone(),
                cwd,
                tmux_name: raw_name.clone(),
                host_id: None,
                managed: managed_names.contains(&raw_name),
                raw_name,
            })
        })
        .collect())
}

pub(crate) fn list_remote_tmux_terminals(host: &HostConfig) -> Result<Vec<TmuxTerminal>, String> {
    let managed = list_remote_tmux_terminals_from_tw_rpc(host);
    let discovered = list_remote_tmux_terminals_via_tmux(host);
    match (managed, discovered) {
        (Ok(mut managed), Ok(discovered)) => {
            let mut seen = managed
                .iter()
                .map(|terminal| terminal.raw_name.clone())
                .collect::<HashSet<_>>();
            managed.extend(
                discovered
                    .into_iter()
                    .filter(|terminal| seen.insert(terminal.raw_name.clone())),
            );
            Ok(managed)
        }
        (Ok(managed), Err(_)) => Ok(managed),
        (Err(_), Ok(discovered)) => Ok(discovered),
        (Err(rpc_error), Err(tmux_error)) => Err(format!(
            "remote terminal catalog failed via tw rpc ({rpc_error}) and tmux ({tmux_error})"
        )),
    }
}

fn list_remote_tmux_terminals_from_tw_rpc(host: &HostConfig) -> Result<Vec<TmuxTerminal>, String> {
    let response = remote_tw_rpc_list(host)?;
    Ok(response
        .sessions
        .into_iter()
        .filter(|session| session.kind == "terminal")
        .map(|session| {
            let raw_name = session.name;
            TmuxTerminal {
                id: format!("ssh:{}:{}", host.id, raw_name),
                label: raw_name.clone(),
                cwd: session.cwd.unwrap_or_default(),
                tmux_name: format!("{}:{}", host.id, raw_name),
                host_id: Some(host.id.clone()),
                raw_name,
                managed: true,
            }
        })
        .collect())
}

fn list_remote_tmux_terminals_via_tmux(host: &HostConfig) -> Result<Vec<TmuxTerminal>, String> {
    let output = run_remote_tmux_check(host, &["list-sessions", "-F", tmux_list_sessions_fmt()])?;
    Ok(output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\x1f');
            let raw_name = parts.next()?.to_string();
            if !raw_name.starts_with("tw-term-") || raw_name.starts_with("tw-mobile-") {
                return None;
            }
            if remote_tmux_session_is_worktree(host, &raw_name) {
                return None;
            }
            let cwd = remote_session_active_cwd(host, &raw_name).unwrap_or_default();
            Some(TmuxTerminal {
                id: format!("ssh:{}:{}", host.id, raw_name),
                label: raw_name.clone(),
                cwd,
                tmux_name: format!("{}:{}", host.id, raw_name),
                host_id: Some(host.id.clone()),
                raw_name,
                managed: false,
            })
        })
        .collect())
}
