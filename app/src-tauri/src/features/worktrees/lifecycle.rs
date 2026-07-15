use super::model::RemoteWorktreeTarget;
use super::{
    remove_pending_cleanup_path, try_cleanup_remote_worktree, try_cleanup_worktree,
    worktree_has_uncommitted_changes,
};
use crate::config::{
    config_worktree_base, find_host, project_from_config_with_home, remote_config_for_host,
};
use crate::features::control_plane::{
    resolve_local_tw_rpc_runtime, run_local_tw_rpc_runtime, LocalTwRpcRuntime,
};
use crate::ipc::{CreateArgs, DeleteWorktreeArgs, RestoreArgs, TwRpcCreateWorktreeResponse};
use crate::remote::{run_remote_tw_check, HostConfig};
use crate::support::{app_home_dir, default_worktree_base};
use std::path::Path;

fn local_worktree_base_for_rpc() -> Result<String, String> {
    let home = app_home_dir().ok_or("home dir not found")?;
    let config_path = home.join(".tmux-worktree.json");
    let config: serde_json::Value = if config_path.exists() {
        let config_text = std::fs::read_to_string(&config_path)
            .map_err(|error| format!("read {}: {error}", config_path.display()))?;
        serde_json::from_str(&config_text).map_err(|error| format!("parse config: {error}"))?
    } else {
        serde_json::json!({})
    };
    Ok(config_worktree_base(&config).unwrap_or_else(default_worktree_base))
}

pub(crate) fn build_local_worktree_rpc_args(
    args: &CreateArgs,
    worktree_base: &str,
) -> Result<Vec<String>, String> {
    let mut rpc_args = vec!["rpc".to_string(), "create-worktree".to_string()];
    let path = args
        .path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty());
    let project = args
        .project
        .as_deref()
        .map(str::trim)
        .filter(|project| !project.is_empty());
    if path.is_none() && project.is_none() {
        return Err("project or path required".to_string());
    }
    if let Some(path) = path {
        rpc_args.extend(["--path".to_string(), path.to_string()]);
    }
    if let Some(project) = project {
        rpc_args.extend(["--project".to_string(), project.to_string()]);
    }

    let ai_command = args.ai_cmd.trim();
    if ai_command.is_empty() {
        return Err("ai command required".to_string());
    }
    rpc_args.extend(["--ai-command".to_string(), ai_command.to_string()]);
    if let Some(name) = args
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        rpc_args.extend(["--name".to_string(), name.to_string()]);
    }
    if let Some(branch) = args
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|branch| !branch.is_empty())
    {
        rpc_args.extend(["--branch".to_string(), branch.to_string()]);
    }
    rpc_args.extend(["--worktree-base".to_string(), worktree_base.to_string()]);
    Ok(rpc_args)
}

pub(crate) fn parse_local_worktree_rpc_response(
    output: &str,
    runtime_label: &str,
) -> Result<String, String> {
    let response: TwRpcCreateWorktreeResponse = serde_json::from_str(output.trim())
        .map_err(|error| format!("parse {runtime_label} create-worktree response: {error}"))?;
    if response.protocol_version != 1 {
        return Err(format!(
            "unsupported {runtime_label} TW RPC protocol: {}",
            response.protocol_version
        ));
    }
    if response
        .kind
        .as_deref()
        .is_some_and(|kind| kind != "worktree")
    {
        return Err(format!(
            "{runtime_label} returned unexpected create kind: {}",
            response.kind.as_deref().unwrap_or_default()
        ));
    }
    let session = response.session.trim();
    if session.is_empty() {
        return Err(format!(
            "{runtime_label} returned an empty worktree session name"
        ));
    }
    Ok(session.to_string())
}

pub(crate) fn build_restore_worktree_rpc_args(args: &RestoreArgs) -> Result<Vec<String>, String> {
    let path = args.path.trim();
    let name = args.name.trim();
    if path.is_empty() {
        return Err("worktree path required".to_string());
    }
    if name.is_empty() {
        return Err("session name required".to_string());
    }
    let mut rpc_args = vec![
        "rpc".to_string(),
        "restore-worktree".to_string(),
        "--path".to_string(),
        path.to_string(),
        "--name".to_string(),
        name.to_string(),
    ];
    let ai_command = args.ai_cmd.trim();
    if !ai_command.is_empty() {
        rpc_args.extend(["--ai-command".to_string(), ai_command.to_string()]);
    }
    Ok(rpc_args)
}

pub(crate) fn create_local_worktree_via_runtime(
    runtime: &LocalTwRpcRuntime,
    args: CreateArgs,
) -> Result<String, String> {
    let worktree_base = local_worktree_base_for_rpc()?;
    let rpc_args = build_local_worktree_rpc_args(&args, &worktree_base)?;
    let output = run_local_tw_rpc_runtime(runtime, &rpc_args, "create-worktree")?;
    parse_local_worktree_rpc_response(&output, runtime.audit_label())
}

fn create_local_worktree_via_tw_rpc(
    app: &tauri::AppHandle,
    args: CreateArgs,
) -> Result<String, String> {
    let home = app_home_dir().ok_or("home dir not found")?;
    let runtime = resolve_local_tw_rpc_runtime(app, &home)?;
    create_local_worktree_via_runtime(&runtime, args)
}

#[tauri::command]
pub(crate) fn create_worktree(app: tauri::AppHandle, args: CreateArgs) -> Result<String, String> {
    if let Some(host_id) = args.host_id.as_deref() {
        let host = find_host(host_id)?;
        return create_remote_worktree(&host, args);
    }
    create_local_worktree_via_tw_rpc(&app, args)
}

pub(crate) fn create_remote_worktree(
    host: &HostConfig,
    args: CreateArgs,
) -> Result<String, String> {
    match create_remote_worktree_via_tw_rpc(host, &args) {
        Ok(session) => Ok(session),
        Err(err) if remote_tw_rpc_create_unavailable(&err) => Err(format!(
            "Remote host {} does not have a compatible `tw rpc create-worktree`. Install or upgrade remote tw to {} (the Dashboard version), then retry. Dashboard will not fall back to direct remote git/tmux creation. Original error: {err}",
            host.label,
            env!("CARGO_PKG_VERSION")
        )),
        Err(err) => Err(err),
    }
}

fn remote_tw_rpc_create_unavailable(err: &str) -> bool {
    let lower = err.to_lowercase();
    (lower.contains("tw") && lower.contains("command not found"))
        || lower.contains("tw: not found")
        || (lower.contains("unknown") && lower.contains("rpc"))
        || lower.contains("unknown create-worktree option")
        || lower.contains("unsupported tw rpc protocol")
        || lower.contains("parse tw rpc create-worktree")
}

fn resolve_remote_worktree_target(
    host: &HostConfig,
    args: &CreateArgs,
) -> Result<RemoteWorktreeTarget, String> {
    let project_name = args
        .project
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty());
    let remote_config = if project_name.is_some() {
        remote_config_for_host(host)?
    } else {
        None
    };

    let configured_project = if let Some(name) = project_name {
        let Some((config, home)) = remote_config.as_ref() else {
            return Err(format!(
                "project '{name}' not in ~/.tmux-worktree.json on {}",
                host.label
            ));
        };
        Some(
            project_from_config_with_home(config, name, Some(home.as_str())).ok_or_else(|| {
                format!(
                    "project '{name}' not in ~/.tmux-worktree.json on {}",
                    host.label
                )
            })?,
        )
    } else {
        None
    };

    let project_dir = args
        .path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            configured_project
                .as_ref()
                .map(|project| project.path.clone())
        })
        .ok_or("remote path or project required for creating worktrees on remote hosts")?;

    let label = project_name.map(ToString::to_string).unwrap_or_else(|| {
        Path::new(&project_dir)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("project")
            .to_string()
    });
    let branch = args
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|branch| !branch.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            configured_project
                .as_ref()
                .and_then(|project| project.branch.clone())
        });
    let worktree_base = host.worktree_base.clone();

    Ok(RemoteWorktreeTarget {
        label,
        project_dir,
        branch,
        worktree_base,
    })
}

fn create_remote_worktree_via_tw_rpc(
    host: &HostConfig,
    args: &CreateArgs,
) -> Result<String, String> {
    let target = resolve_remote_worktree_target(host, args)?;

    let mut remote_cmd = vec![
        "rpc".to_string(),
        "create-worktree".to_string(),
        "--path".to_string(),
        target.project_dir.clone(),
        "--ai-command".to_string(),
        args.ai_cmd.clone(),
    ];
    remote_cmd.push("--project".to_string());
    remote_cmd.push(target.label.clone());
    if let Some(worktree_base) = target.worktree_base.as_deref() {
        remote_cmd.push("--worktree-base".to_string());
        remote_cmd.push(worktree_base.to_string());
    }
    if let Some(name) = args
        .name
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        remote_cmd.push("--name".to_string());
        remote_cmd.push(name.to_string());
    }
    if let Some(branch) = target.branch.as_deref() {
        remote_cmd.push("--branch".to_string());
        remote_cmd.push(branch.to_string());
    }

    let remote_args = remote_cmd.iter().map(String::as_str).collect::<Vec<_>>();
    let output = run_remote_tw_check(host, &remote_args)?;
    // Intentionally keep the remote parser separate from the local parser:
    // their accepted response shapes and audit labels are frozen independently.
    let response: TwRpcCreateWorktreeResponse =
        serde_json::from_str(&output).map_err(|e| format!("parse tw rpc create-worktree: {e}"))?;
    if response.protocol_version != 1 {
        return Err(format!(
            "unsupported tw rpc protocol: {}",
            response.protocol_version
        ));
    }
    let session = response.session.trim();
    if session.is_empty() {
        return Err("tw rpc create-worktree returned empty session".to_string());
    }
    Ok(format!("{}:{}", host.id, session))
}

pub(crate) fn restore_local_worktree_via_runtime(
    runtime: &LocalTwRpcRuntime,
    args: &RestoreArgs,
) -> Result<String, String> {
    let rpc_args = build_restore_worktree_rpc_args(args)?;
    let output = run_local_tw_rpc_runtime(runtime, &rpc_args, "restore-worktree")?;
    parse_local_worktree_rpc_response(&output, runtime.audit_label())
}

fn restore_remote_worktree(host: &HostConfig, args: &RestoreArgs) -> Result<String, String> {
    let rpc_args = build_restore_worktree_rpc_args(args)?;
    let refs = rpc_args.iter().map(String::as_str).collect::<Vec<_>>();
    let output = run_remote_tw_check(host, &refs)?;
    let session = parse_local_worktree_rpc_response(&output, "remote tw")?;
    Ok(format!("{}:{session}", host.id))
}

#[tauri::command]
pub(crate) fn restore_worktree(app: tauri::AppHandle, args: RestoreArgs) -> Result<String, String> {
    if let Some(host_id) = args
        .host_id
        .as_deref()
        .map(str::trim)
        .filter(|host_id| !host_id.is_empty())
    {
        let host = find_host(host_id)?;
        return restore_remote_worktree(&host, &args);
    }
    let home = app_home_dir().ok_or("home dir not found")?;
    let runtime = resolve_local_tw_rpc_runtime(&app, &home)?;
    let session = restore_local_worktree_via_runtime(&runtime, &args)?;
    remove_pending_cleanup_path(&args.path);
    Ok(session)
}

pub(crate) fn delete_worktree_blocking(args: DeleteWorktreeArgs) -> Result<(), String> {
    if let Some(host_id) = args
        .host_id
        .as_deref()
        .map(str::trim)
        .filter(|host_id| !host_id.is_empty())
    {
        let host = find_host(host_id)?;
        return try_cleanup_remote_worktree(&host, &args.path, args.force);
    }
    if !args.force && worktree_has_uncommitted_changes(&args.path).unwrap_or(false) {
        return Err(format!("worktree has uncommitted changes: {}", args.path));
    }
    if try_cleanup_worktree(&args.path, args.force) {
        remove_pending_cleanup_path(&args.path);
        return Ok(());
    }
    if args.force {
        Err(format!("failed to delete worktree: {}", args.path))
    } else {
        Err(format!("worktree has uncommitted changes: {}", args.path))
    }
}

#[tauri::command]
pub(crate) async fn delete_worktree(args: DeleteWorktreeArgs) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_worktree_blocking(args))
        .await
        .map_err(|error| format!("worktree delete task failed: {error}"))?
}
