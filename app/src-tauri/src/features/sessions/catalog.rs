use super::{pane_output_signature, remote_session_activity_samples, session_agent_running};
use crate::config::{load_hosts, trimmed_non_empty_string};
use crate::features::control_plane::{resolve_local_tw_rpc_runtime, run_local_tw_rpc_runtime};
use crate::ipc::{
    DashboardCatalogSnapshot, Session, TmuxTerminal, TwRpcListResponse, TwRpcSession,
};
use crate::remote::{run_remote_tw_check, HostConfig};
use crate::support::app_home_dir;

fn parse_tw_rpc_v2_list(output: &str, runtime_label: &str) -> Result<TwRpcListResponse, String> {
    let response: TwRpcListResponse = serde_json::from_str(output)
        .map_err(|error| format!("parse {runtime_label} rpc-v2 list: {error}"))?;
    if response.protocol_version != 2
        || response.sessions.iter().any(|session| {
            !session.lifecycle_marked
                || (session.kind != "worktree" && session.kind != "terminal")
                || session.name.trim().is_empty()
        })
    {
        return Err(format!(
            "{runtime_label} returned a non-authoritative TW RPC v2 catalog"
        ));
    }
    Ok(response)
}

fn local_tw_rpc_list(app: &tauri::AppHandle) -> Result<TwRpcListResponse, String> {
    let home = app_home_dir().ok_or("home dir not found")?;
    let runtime = resolve_local_tw_rpc_runtime(app, &home)?;
    let args = vec!["rpc-v2".to_string(), "list".to_string()];
    let output = run_local_tw_rpc_runtime(&runtime, &args, "list")?;
    parse_tw_rpc_v2_list(&output, runtime.audit_label())
}

fn remote_tw_rpc_list(host: &HostConfig) -> Result<TwRpcListResponse, String> {
    let output = run_remote_tw_check(host, &["rpc-v2", "list"])?;
    parse_tw_rpc_v2_list(&output, "remote tw")
}

fn local_catalog_from_rpc(
    app: &tauri::AppHandle,
) -> Result<(Vec<Session>, Vec<TmuxTerminal>), String> {
    Ok(partition_local_catalog(local_tw_rpc_list(app)?.sessions))
}

fn partition_local_catalog(sessions: Vec<TwRpcSession>) -> (Vec<Session>, Vec<TmuxTerminal>) {
    let mut worktrees = Vec::new();
    let mut terminals = Vec::new();
    for session in sessions {
        if session.kind == "worktree" {
            let target = format!("={}", session.name);
            worktrees.push(Session {
                name: session.name.clone(),
                attached: session.attached,
                window_count: session.windows,
                created: session.created,
                activity: session.activity,
                output_signature: pane_output_signature(&target),
                agent_running: session_agent_running(&target),
                host_id: None,
                raw_name: session.name,
                project: session
                    .project
                    .and_then(|project| trimmed_non_empty_string(&project)),
                managed: true,
            });
        } else {
            let label = session
                .label
                .as_deref()
                .and_then(trimmed_non_empty_string)
                .unwrap_or_else(|| session.name.clone());
            terminals.push(TmuxTerminal {
                id: format!("tmux:{}", session.name),
                label,
                cwd: session.cwd,
                tmux_name: session.name.clone(),
                host_id: None,
                raw_name: session.name,
                managed: true,
            });
        }
    }
    (worktrees, terminals)
}

fn partition_remote_catalog(
    host: &HostConfig,
    sessions: Vec<TwRpcSession>,
) -> (Vec<Session>, Vec<TmuxTerminal>) {
    let worktree_names = sessions
        .iter()
        .filter(|session| session.kind == "worktree")
        .map(|session| session.name.clone())
        .collect::<Vec<_>>();
    let activity_samples =
        remote_session_activity_samples(host, &worktree_names).unwrap_or_default();
    let mut worktrees = Vec::new();
    let mut terminals = Vec::new();
    for session in sessions {
        if session.kind == "worktree" {
            let activity = activity_samples
                .get(&session.name)
                .cloned()
                .unwrap_or_default();
            worktrees.push(Session {
                name: format!("{}:{}", host.id, session.name),
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
            });
        } else {
            let label = session
                .label
                .as_deref()
                .and_then(trimmed_non_empty_string)
                .unwrap_or_else(|| session.name.clone());
            terminals.push(TmuxTerminal {
                id: format!("ssh:{}:{}", host.id, session.name),
                label,
                cwd: session.cwd,
                tmux_name: format!("{}:{}", host.id, session.name),
                host_id: Some(host.id.clone()),
                raw_name: session.name,
                managed: true,
            });
        }
    }
    (worktrees, terminals)
}

#[tauri::command]
pub(crate) async fn list_sessions(app: tauri::AppHandle) -> Result<Vec<Session>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (mut sessions, _) = local_catalog_from_rpc(&app)?;
        for host in load_hosts().unwrap_or_default() {
            if let Ok(response) = remote_tw_rpc_list(&host) {
                sessions.extend(partition_remote_catalog(&host, response.sessions).0);
            }
        }
        Ok(sessions)
    })
    .await
    .map_err(|error| format!("list sessions task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn list_dashboard_catalog(
    app: tauri::AppHandle,
) -> Result<DashboardCatalogSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (mut sessions, mut terminals) = local_catalog_from_rpc(&app)?;
        let mut failed_session_host_ids = Vec::new();
        let mut failed_terminal_host_ids = Vec::new();
        for host in load_hosts()? {
            match remote_tw_rpc_list(&host) {
                Ok(response) => {
                    let (remote_sessions, remote_terminals) =
                        partition_remote_catalog(&host, response.sessions);
                    sessions.extend(remote_sessions);
                    terminals.extend(remote_terminals);
                }
                Err(_) => {
                    failed_session_host_ids.push(host.id.clone());
                    failed_terminal_host_ids.push(host.id);
                }
            }
        }
        Ok(DashboardCatalogSnapshot {
            sessions,
            terminals,
            failed_session_host_ids,
            failed_terminal_host_ids,
        })
    })
    .await
    .map_err(|error| format!("list dashboard catalog task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn list_local_dashboard_catalog(
    app: tauri::AppHandle,
) -> Result<DashboardCatalogSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (sessions, terminals) = local_catalog_from_rpc(&app)?;
        let host_ids = load_hosts()?
            .into_iter()
            .map(|host| host.id)
            .collect::<Vec<_>>();
        Ok(DashboardCatalogSnapshot {
            sessions,
            terminals,
            failed_session_host_ids: host_ids.clone(),
            failed_terminal_host_ids: host_ids,
        })
    })
    .await
    .map_err(|error| format!("list local dashboard catalog task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn list_tmux_terminals(
    app: tauri::AppHandle,
) -> Result<Vec<TmuxTerminal>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (_, mut terminals) = local_catalog_from_rpc(&app)?;
        for host in load_hosts().unwrap_or_default() {
            if let Ok(response) = remote_tw_rpc_list(&host) {
                terminals.extend(partition_remote_catalog(&host, response.sessions).1);
            }
        }
        Ok(terminals)
    })
    .await
    .map_err(|error| format!("list tmux terminals task failed: {error}"))?
}
