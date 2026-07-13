use super::tmux_session_is_missing_error;
use crate::config::find_host;
use crate::features::control_plane::{
    kill_canonical_first, kill_managed_session_via_tw_rpc, parse_session_key,
};
use crate::features::{kill_managed_session_with_control, PtyState, TerminalControlState};
use crate::remote::{run_remote_tmux_check, run_remote_tmux_output};
use crate::support::{run_check, run_quiet, tmux_bin};

#[tauri::command]
pub(crate) fn tmux_session_exists(name: String) -> Result<bool, String> {
    let (host_id, raw_name) = parse_session_key(&name);
    let exact = format!("={}", raw_name);
    match host_id {
        Some(hid) => {
            let host = find_host(hid)?;
            let output = run_remote_tmux_output(&host, &["has-session", "-t", &exact])?;
            if output.status.success() {
                return Ok(true);
            }
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail = stderr.trim();
            if tmux_session_is_missing_error(detail) {
                return Ok(false);
            }
            Err(format!(
                "tmux has-session on {} failed ({}): {}",
                host.label, output.status, detail
            ))
        }
        None => Ok(run_quiet(&["tmux", "has-session", "-t", &exact]).is_some()),
    }
}

pub(crate) fn kill_legacy_session(name: &str) -> Result<(), String> {
    let (host_id, raw_name) = parse_session_key(name);
    let exact = format!("={}", raw_name);
    match host_id {
        Some(hid) => {
            let host = find_host(hid)?;
            run_remote_tmux_check(&host, &["kill-session", "-t", &exact])?;
        }
        None => {
            run_check(&["tmux", "kill-session", "-t", &exact])?;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn kill_session(
    app: tauri::AppHandle,
    pty_state: tauri::State<'_, std::sync::Arc<PtyState>>,
    control_state: tauri::State<'_, std::sync::Arc<TerminalControlState>>,
    name: String,
    managed: Option<bool>,
) -> Result<(), String> {
    let (host_id, raw_name) = parse_session_key(&name);
    if managed == Some(true) {
        return kill_managed_session_with_control(
            &app,
            pty_state.inner().as_ref(),
            control_state.inner().as_ref(),
            raw_name,
            host_id,
        );
    }
    kill_canonical_first(
        managed,
        || kill_managed_session_via_tw_rpc(&app, &name),
        || kill_legacy_session(&name),
    )
}

#[tauri::command]
pub(crate) fn session_cwd(name: String) -> Result<String, String> {
    let (host_id, raw_name) = parse_session_key(&name);
    let exact = format!("={}", raw_name);
    let fmt = "#{pane_active}\x1f#{pane_current_path}";

    let output_str = match host_id {
        Some(hid) => {
            let host = find_host(hid)?;
            run_remote_tmux_check(&host, &["list-panes", "-t", &exact, "-F", fmt])?
        }
        None => {
            let output = std::process::Command::new(tmux_bin())
                .args(["list-panes", "-t", &exact, "-F", fmt])
                .output()
                .map_err(|e| format!("spawn tmux: {e}"))?;
            if !output.status.success() {
                return Err(format!(
                    "tmux list-panes failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
            String::from_utf8_lossy(&output.stdout).to_string()
        }
    };

    let mut first_path: Option<String> = None;
    for line in output_str.lines() {
        let mut parts = line.splitn(2, '\x1f');
        let active = parts.next().unwrap_or_default() == "1";
        let path = parts.next().unwrap_or_default().trim();
        if path.is_empty() {
            continue;
        }
        if first_path.is_none() {
            first_path = Some(path.to_string());
        }
        if active {
            return Ok(path.to_string());
        }
    }

    first_path.ok_or_else(|| format!("tmux session has no panes: {name}"))
}

#[tauri::command]
pub(crate) fn session_root(name: String) -> Result<String, String> {
    let (host_id, raw_name) = parse_session_key(&name);
    let fmt = "#{session_name}\x1f#{session_path}";

    let output_str = match host_id {
        Some(hid) => {
            let host = find_host(hid)?;
            match run_remote_tmux_check(&host, &["list-sessions", "-F", fmt]) {
                Ok(s) => s,
                Err(_) => return session_cwd(name),
            }
        }
        None => {
            let output = std::process::Command::new(tmux_bin())
                .args(["list-sessions", "-F", fmt])
                .output()
                .map_err(|e| format!("spawn tmux: {e}"))?;
            if !output.status.success() {
                return Err(format!(
                    "tmux list-sessions failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
            String::from_utf8_lossy(&output.stdout).to_string()
        }
    };

    for line in output_str.lines() {
        let mut parts = line.splitn(2, '\x1f');
        let session_name = parts.next().unwrap_or_default();
        let path = parts.next().unwrap_or_default().trim();
        if session_name == raw_name && !path.is_empty() {
            return Ok(path.to_string());
        }
    }

    session_cwd(name)
}

#[tauri::command]
pub(crate) fn capture_pane_history(name: String, lines: Option<u16>) -> Result<String, String> {
    let (host_id, raw_name) = parse_session_key(&name);
    let exact = format!("={}", raw_name);
    let start = format!("-{}", lines.unwrap_or(5000).clamp(1, 5000));
    let args = &["capture-pane", "-p", "-e", "-J", "-S", &start, "-t", &exact];

    let text = match host_id {
        Some(hid) => {
            let host = find_host(hid)?;
            match run_remote_tmux_check(&host, args) {
                Ok(s) => s,
                Err(_) => return Ok(String::new()),
            }
        }
        None => {
            let output = std::process::Command::new(tmux_bin())
                .args(args)
                .output()
                .map_err(|e| format!("spawn tmux: {e}"))?;
            if !output.status.success() {
                return Ok(String::new());
            }
            String::from_utf8_lossy(&output.stdout).to_string()
        }
    };
    let trimmed = text.trim_end_matches('\n');
    Ok(trimmed.to_string())
}
