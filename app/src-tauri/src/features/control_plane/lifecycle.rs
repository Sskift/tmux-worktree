use super::{resolve_local_tw_rpc_runtime, run_local_tw_rpc_runtime};
use crate::config::find_host;
use crate::ipc::TwRpcKillSessionResponse;
use crate::remote::run_remote_tw_check;
use crate::support::app_home_dir;

/// Parse a composite session key into (host_id, raw_name).
/// - "hostid:rawname" -> (Some("hostid"), "rawname")
/// - "rawname"        -> (None, "rawname")  (local session, backward compat)
pub(crate) fn parse_session_key(key: &str) -> (Option<&str>, &str) {
    match key.split_once(':') {
        Some((host_id, raw_name)) => (Some(host_id), raw_name),
        None => (None, key),
    }
}

pub(crate) fn parse_kill_session_rpc_response(
    output: &str,
    runtime_label: &str,
    expected_session: &str,
) -> Result<(), String> {
    let response: TwRpcKillSessionResponse = serde_json::from_str(output.trim())
        .map_err(|error| format!("parse {runtime_label} kill-session response: {error}"))?;
    if response.protocol_version != 1 {
        return Err(format!(
            "unsupported {runtime_label} TW RPC protocol: {}",
            response.protocol_version
        ));
    }
    if response.kind != "session-killed" || response.session != expected_session {
        return Err(format!(
            "{runtime_label} returned an unexpected kill-session response"
        ));
    }
    Ok(())
}

pub(crate) fn kill_managed_session_via_tw_rpc(
    app: &tauri::AppHandle,
    name: &str,
) -> Result<(), String> {
    let (host_id, raw_name) = parse_session_key(name);
    let rpc_args = ["rpc", "kill-session", "--name", raw_name];
    let (output, runtime_label) = match host_id {
        Some(host_id) => {
            let host = find_host(host_id)?;
            (run_remote_tw_check(&host, &rpc_args)?, "remote tw")
        }
        None => {
            let home = app_home_dir().ok_or("home dir not found")?;
            let runtime = resolve_local_tw_rpc_runtime(app, &home)?;
            let owned_args = rpc_args
                .iter()
                .map(|arg| (*arg).to_string())
                .collect::<Vec<_>>();
            let output = run_local_tw_rpc_runtime(&runtime, &owned_args, "kill-session")?;
            (output, runtime.audit_label())
        }
    };
    parse_kill_session_rpc_response(&output, runtime_label, raw_name)
}

pub(crate) fn kill_rpc_explicitly_allows_legacy_fallback(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    if lower.contains("session is not tw-managed") {
        return true;
    }

    // Only an explicit old-CLI compatibility signal may authorize bypassing
    // managed state. Do not broadly match words such as "invalid": state
    // corruption errors intentionally contain that word and must fail closed.
    let unsupported = lower.contains("unknown")
        || lower.contains("unrecognized")
        || lower.contains("unsupported")
        || lower.contains("invalid");
    let unsupported_kill_command = unsupported
        && lower.contains("kill-session")
        && (lower.contains("rpc command")
            || lower.contains("rpc subcommand")
            || lower.contains("subcommand")
            || lower.contains("command: kill-session")
            || lower.contains("command 'kill-session'")
            || lower.contains("command \"kill-session\"")
            || lower.contains("command `kill-session`")
            || lower.contains("kill-session command")
            || lower.contains("kill-session option"));
    let unsupported_rpc_command = unsupported
        && (lower.contains("unknown rpc")
            || lower.contains("unrecognized rpc")
            || lower.contains("unsupported rpc")
            || lower.contains("invalid rpc")
            || lower.contains("rpc command is unknown")
            || lower.contains("rpc command is unrecognized")
            || lower.contains("rpc command is unsupported")
            || lower.contains("rpc command is invalid")
            || lower.contains("command: rpc")
            || lower.contains("command 'rpc'")
            || lower.contains("command \"rpc\"")
            || lower.contains("command `rpc`"));
    let remote_tw_missing = lower.contains("tw: not found")
        || lower.contains("tw: command not found")
        || lower.contains("command not found: tw")
        || lower.contains("tw: no such file or directory");

    unsupported_kill_command || unsupported_rpc_command || remote_tw_missing
}

pub(crate) fn kill_canonical_first<C, L>(
    managed_hint: Option<bool>,
    canonical_kill: C,
    legacy_kill: L,
) -> Result<(), String>
where
    C: FnOnce() -> Result<(), String>,
    L: FnOnce() -> Result<(), String>,
{
    // `managed` comes from a cached UI catalog and can be stale. It must not
    // decide which mutation owns the session; canonical TW state does that.
    let _ = managed_hint;
    match canonical_kill() {
        Ok(()) => Ok(()),
        Err(error) if kill_rpc_explicitly_allows_legacy_fallback(&error) => legacy_kill(),
        Err(error) => Err(error),
    }
}
