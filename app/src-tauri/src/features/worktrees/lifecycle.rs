use super::model::RemoteWorktreeTarget;
use super::{
    remove_pending_cleanup_path, try_cleanup_remote_worktree, try_cleanup_worktree,
    worktree_has_uncommitted_changes,
};
use crate::config::{
    config_worktree_base, find_host, project_from_config_with_home, remote_config_for_host,
};
use crate::features::control_plane::{
    build_tw_rpc_v2_args, parse_tw_rpc_v2_create_response, resolve_local_tw_rpc_runtime,
    run_local_tw_rpc_runtime, LocalTwRpcRuntime,
};
use crate::ipc::{CreateArgs, DeleteWorktreeArgs, RestoreArgs};
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
    build_worktree_rpc_args(args, Some(worktree_base))
}

fn build_worktree_rpc_args(
    args: &CreateArgs,
    worktree_base: Option<&str>,
) -> Result<Vec<String>, String> {
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
    let ai_command = args.ai_cmd.trim();
    if ai_command.is_empty() {
        return Err("ai command required".to_string());
    }
    let mut arguments = serde_json::Map::new();
    for (key, value) in [
        ("path", path),
        ("project", project),
        (
            "name",
            args.name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty()),
        ),
        (
            "branch",
            args.branch
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty()),
        ),
    ] {
        if let Some(value) = value {
            arguments.insert(
                key.to_string(),
                serde_json::Value::String(value.to_string()),
            );
        }
    }
    if let Some(worktree_base) = worktree_base {
        arguments.insert(
            "worktreeBase".to_string(),
            serde_json::Value::String(worktree_base.to_string()),
        );
    }
    arguments.insert(
        "aiCommand".to_string(),
        serde_json::Value::String(ai_command.to_string()),
    );
    Ok(build_tw_rpc_v2_args(
        "create-worktree",
        serde_json::json!({
            "arguments": arguments,
            "reservationCorrelation": null
        }),
    ))
}

pub(crate) fn parse_local_worktree_rpc_response(
    output: &str,
    runtime_label: &str,
) -> Result<String, String> {
    parse_tw_rpc_v2_create_response(output, runtime_label, "create-worktree", "worktree")
        .map(|session| session.name)
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
    let mut arguments = serde_json::Map::new();
    arguments.insert(
        "path".to_string(),
        serde_json::Value::String(path.to_string()),
    );
    arguments.insert(
        "name".to_string(),
        serde_json::Value::String(name.to_string()),
    );
    let ai_command = args.ai_cmd.trim();
    if !ai_command.is_empty() {
        arguments.insert(
            "aiCommand".to_string(),
            serde_json::Value::String(ai_command.to_string()),
        );
    }
    Ok(build_tw_rpc_v2_args(
        "restore-worktree",
        serde_json::json!({
            "arguments": arguments,
            "reservationCorrelation": null
        }),
    ))
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
            "Remote host {} does not have a compatible `tw rpc-v2 create-worktree`. Install or upgrade remote tw to {} (the Dashboard version), then retry. Original error: {err}",
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
        || (lower.contains("unknown") && lower.contains("rpc-v2"))
        || lower.contains("incompatible tw rpc v2")
        || lower.contains("parse remote tw create-worktree")
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
    let direct = CreateArgs {
        project: Some(target.label.clone()),
        path: Some(target.project_dir.clone()),
        ai_cmd: args.ai_cmd.clone(),
        name: args.name.clone(),
        branch: target.branch.clone(),
        host_id: None,
    };
    let remote_cmd = build_worktree_rpc_args(&direct, target.worktree_base.as_deref())?;
    let remote_args = remote_cmd.iter().map(String::as_str).collect::<Vec<_>>();
    let output = run_remote_tw_check(host, &remote_args)?;
    let session =
        parse_tw_rpc_v2_create_response(&output, "remote tw", "create-worktree", "worktree")?;
    Ok(format!("{}:{}", host.id, session.name))
}

pub(crate) fn restore_local_worktree_via_runtime(
    runtime: &LocalTwRpcRuntime,
    args: &RestoreArgs,
) -> Result<String, String> {
    let rpc_args = build_restore_worktree_rpc_args(args)?;
    let output = run_local_tw_rpc_runtime(runtime, &rpc_args, "restore-worktree")?;
    parse_tw_rpc_v2_create_response(
        &output,
        runtime.audit_label(),
        "restore-worktree",
        "worktree",
    )
    .map(|session| session.name)
}

fn restore_remote_worktree(host: &HostConfig, args: &RestoreArgs) -> Result<String, String> {
    let rpc_args = build_restore_worktree_rpc_args(args)?;
    let refs = rpc_args.iter().map(String::as_str).collect::<Vec<_>>();
    let output = run_remote_tw_check(host, &refs)?;
    let session =
        parse_tw_rpc_v2_create_response(&output, "remote tw", "restore-worktree", "worktree")?;
    Ok(format!("{}:{}", host.id, session.name))
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
