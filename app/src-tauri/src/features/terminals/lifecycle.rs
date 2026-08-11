use crate::config::find_host;
use crate::features::control_plane::{
    build_tw_rpc_v2_args, parse_session_key, parse_tw_rpc_v2_create_response,
    resolve_local_tw_rpc_runtime, run_local_tw_rpc_runtime, LocalTwRpcRuntime,
};
use crate::features::sessions::{setup_clipboard_bindings, tmux_session_is_missing_error};
use crate::features::{kill_managed_session_with_control, PtyState, TerminalControlState};
use crate::ipc::{CreateTerminalArgs, CreatedTerminal, EnsureTerminalArgs};
use crate::remote::{
    run_remote_tmux_check, run_remote_tmux_quiet, run_remote_tw_check, HostConfig,
};
use crate::support::{app_home_dir, command_then_login_shell, run_check, run_quiet};

pub(crate) fn build_terminal_rpc_args(args: &CreateTerminalArgs) -> Result<Vec<String>, String> {
    let cwd = args.cwd.trim();
    if cwd.is_empty() {
        return Err("cwd required".to_string());
    }
    let ai_command = args.ai_cmd.trim();
    let mut arguments = serde_json::Map::new();
    arguments.insert(
        "cwd".to_string(),
        serde_json::Value::String(cwd.to_string()),
    );
    if !ai_command.is_empty() {
        arguments.insert(
            "aiCommand".to_string(),
            serde_json::Value::String(ai_command.to_string()),
        );
    }
    Ok(build_tw_rpc_v2_args(
        "create-terminal",
        serde_json::json!({
            "arguments": arguments,
            "reservationCorrelation": null
        }),
    ))
}

fn start_local_terminal_session(raw_name: &str, cwd: &str, ai_cmd: &str) -> Result<(), String> {
    let command = command_then_login_shell(ai_cmd);
    run_check(&[
        "tmux",
        "new-session",
        "-d",
        "-s",
        raw_name,
        "-c",
        cwd,
        &command,
    ])?;
    setup_clipboard_bindings();
    Ok(())
}

fn start_remote_terminal_session(
    host: &HostConfig,
    raw_name: &str,
    cwd: &str,
    ai_cmd: &str,
) -> Result<(), String> {
    let command = command_then_login_shell(ai_cmd);
    run_remote_tmux_check(
        host,
        &["new-session", "-d", "-s", raw_name, "-c", cwd, &command],
    )?;
    Ok(())
}

pub(crate) fn create_local_terminal_via_runtime(
    runtime: &LocalTwRpcRuntime,
    args: &CreateTerminalArgs,
) -> Result<CreatedTerminal, String> {
    let rpc_args = build_terminal_rpc_args(args)?;
    let output = run_local_tw_rpc_runtime(runtime, &rpc_args, "create-terminal")?;
    let response = parse_tw_rpc_v2_create_response(
        &output,
        runtime.audit_label(),
        "create-terminal",
        "terminal",
    )?;
    let raw_name = response.name;
    Ok(CreatedTerminal {
        tmux_name: raw_name.clone(),
        host_id: None,
        raw_name,
        cwd: response.cwd,
        managed: true,
    })
}

fn remote_terminal_rpc_unavailable(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    (lower.contains("tw") && lower.contains("command not found"))
        || lower.contains("tw: not found")
        || (lower.contains("unknown") && lower.contains("create-terminal"))
        || lower.contains("incompatible tw rpc v2")
        || lower.contains("parse remote tw create-terminal")
}

pub(crate) fn create_remote_terminal_via_tw_rpc(
    host: &HostConfig,
    args: &CreateTerminalArgs,
) -> Result<CreatedTerminal, String> {
    let rpc_args = build_terminal_rpc_args(args)?;
    let refs = rpc_args.iter().map(String::as_str).collect::<Vec<_>>();
    let output = run_remote_tw_check(host, &refs)?;
    let response =
        parse_tw_rpc_v2_create_response(&output, "remote tw", "create-terminal", "terminal")?;
    let raw_name = response.name;
    Ok(CreatedTerminal {
        tmux_name: format!("{}:{}", host.id, raw_name),
        host_id: Some(host.id.clone()),
        raw_name,
        cwd: response.cwd,
        managed: true,
    })
}

#[tauri::command]
pub(crate) fn create_terminal(
    app: tauri::AppHandle,
    args: CreateTerminalArgs,
) -> Result<CreatedTerminal, String> {
    match args.host_id.as_deref().filter(|id| !id.trim().is_empty()) {
        Some(host_id) => {
            let host = find_host(host_id)?;
            create_remote_terminal_via_tw_rpc(&host, &args).map_err(|error| {
                if remote_terminal_rpc_unavailable(&error) {
                    format!(
                        "Remote host {} does not have a compatible `tw rpc-v2 create-terminal`. Install or upgrade remote tw to {} or newer with that capability. Original error: {error}",
                        host.label,
                        env!("CARGO_PKG_VERSION")
                    )
                } else {
                    error
                }
            })
        }
        None => {
            let home = app_home_dir().ok_or("home dir not found")?;
            let runtime = resolve_local_tw_rpc_runtime(&app, &home)?;
            create_local_terminal_via_runtime(&runtime, &args)
        }
    }
}

#[tauri::command]
pub(crate) fn ensure_terminal_session(args: EnsureTerminalArgs) -> Result<(), String> {
    let (parsed_host_id, parsed_raw_name) = parse_session_key(&args.name);
    let host_id = args
        .host_id
        .as_deref()
        .filter(|id| !id.trim().is_empty())
        .or(parsed_host_id);
    let raw_name = args
        .raw_name
        .as_deref()
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(parsed_raw_name);
    let exact = format!("={}", raw_name);
    let ai_cmd = args.ai_cmd.as_deref().unwrap_or("");

    match host_id {
        Some(host_id) => {
            let host = find_host(host_id)?;
            if run_remote_tmux_quiet(&host, &["has-session", "-t", &exact]).is_some() {
                return Ok(());
            }
            start_remote_terminal_session(&host, raw_name, &args.cwd, ai_cmd)
        }
        None => {
            if run_quiet(&["tmux", "has-session", "-t", &exact]).is_some() {
                return Ok(());
            }
            start_local_terminal_session(raw_name, &args.cwd, ai_cmd)
        }
    }
}

pub(crate) fn kill_legacy_plain_terminal(name: &str) -> Result<(), String> {
    let (host_id, raw_name) = parse_session_key(name);
    let exact = format!("={}", raw_name);
    let result = match host_id {
        Some(host_id) => {
            let host = find_host(host_id)?;
            run_remote_tmux_check(&host, &["kill-session", "-t", &exact]).map(|_| ())
        }
        None => run_check(&["tmux", "kill-session", "-t", &exact]).map(|_| ()),
    };
    match result {
        Ok(()) => Ok(()),
        // Closing stale persisted metadata is intentionally idempotent. Only a
        // verified "already gone" response is treated as success; SSH, auth,
        // executable, and other tmux failures must reach the UI.
        Err(error) if tmux_session_is_missing_error(&error) => Ok(()),
        Err(error) => Err(error),
    }
}

#[tauri::command]
pub(crate) async fn kill_plain_terminal(
    app: tauri::AppHandle,
    pty_state: tauri::State<'_, std::sync::Arc<PtyState>>,
    control_state: tauri::State<'_, std::sync::Arc<TerminalControlState>>,
    name: String,
    managed: Option<bool>,
) -> Result<(), String> {
    let pty_state = std::sync::Arc::clone(pty_state.inner());
    let control_state = std::sync::Arc::clone(control_state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let (host_id, raw_name) = parse_session_key(&name);
        if managed.unwrap_or(false) {
            kill_managed_session_with_control(
                &app,
                pty_state.as_ref(),
                control_state.as_ref(),
                raw_name,
                host_id,
            )
        } else {
            kill_legacy_plain_terminal(&name)
        }
    })
    .await
    .map_err(|error| format!("terminal kill task failed: {error}"))?
}
