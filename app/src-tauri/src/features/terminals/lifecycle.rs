use crate::config::find_host;
use crate::features::control_plane::{
    kill_canonical_first, kill_managed_session_via_tw_rpc, parse_session_key,
    resolve_local_tw_rpc_runtime, run_local_tw_rpc_runtime, LocalTwRpcRuntime,
};
use crate::features::sessions::{setup_clipboard_bindings, tmux_session_is_missing_error};
use crate::ipc::{
    CreateTerminalArgs, CreatedTerminal, EnsureTerminalArgs, TwRpcCreateTerminalResponse,
};
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
    let mut rpc_args = vec![
        "rpc".to_string(),
        "create-terminal".to_string(),
        "--cwd".to_string(),
        cwd.to_string(),
    ];
    if !ai_command.is_empty() {
        rpc_args.extend(["--ai-command".to_string(), ai_command.to_string()]);
    }
    Ok(rpc_args)
}

fn parse_terminal_rpc_response(
    output: &str,
    runtime_label: &str,
) -> Result<TwRpcCreateTerminalResponse, String> {
    let response: TwRpcCreateTerminalResponse = serde_json::from_str(output.trim())
        .map_err(|error| format!("parse {runtime_label} create-terminal response: {error}"))?;
    if response.protocol_version != 1 {
        return Err(format!(
            "unsupported {runtime_label} TW RPC protocol: {}",
            response.protocol_version
        ));
    }
    if response.kind != "terminal" {
        return Err(format!(
            "{runtime_label} returned unexpected create kind: {}",
            response.kind
        ));
    }
    if response.session.trim().is_empty() {
        return Err(format!(
            "{runtime_label} returned an empty terminal session name"
        ));
    }
    if response.cwd.trim().is_empty() {
        return Err(format!("{runtime_label} returned an empty terminal cwd"));
    }
    Ok(response)
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
    let response = parse_terminal_rpc_response(&output, runtime.audit_label())?;
    let raw_name = response.session.trim().to_string();
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
        || lower.contains("unsupported tw rpc protocol")
        || lower.contains("parse remote tw create-terminal")
}

pub(crate) fn create_remote_terminal_via_tw_rpc(
    host: &HostConfig,
    args: &CreateTerminalArgs,
) -> Result<CreatedTerminal, String> {
    let rpc_args = build_terminal_rpc_args(args)?;
    let refs = rpc_args.iter().map(String::as_str).collect::<Vec<_>>();
    let output = run_remote_tw_check(host, &refs)?;
    let response = parse_terminal_rpc_response(&output, "remote tw")?;
    let raw_name = response.session.trim().to_string();
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
                        "Remote host {} does not have a compatible `tw rpc create-terminal`. Install or upgrade remote tw to {} or newer with that capability. Dashboard will not fall back to direct tmux creation. Original error: {error}",
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
pub(crate) fn kill_plain_terminal(
    app: tauri::AppHandle,
    name: String,
    managed: Option<bool>,
) -> Result<(), String> {
    kill_canonical_first(
        managed,
        || kill_managed_session_via_tw_rpc(&app, &name),
        || kill_legacy_plain_terminal(&name),
    )
}
