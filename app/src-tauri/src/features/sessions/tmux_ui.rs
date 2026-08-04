use crate::config::find_host;
use crate::features::control_plane::parse_session_key;
use crate::ipc::TmuxStatusTheme;
use crate::remote::{
    run_remote_tmux_check, run_remote_tmux_output, run_remote_tmux_quiet, HostConfig,
};
use crate::support::{run_check, run_quiet, tmux_bin};
use std::io::Write;

// 优化 tmux 鼠标选择体验（server-global，幂等）：
//  1. MouseDragEnd1Pane -> copy-pipe-no-clear "pbcopy"：松手保留高亮 + 进系统剪贴板
//  2. MouseDown1Pane -> clear selection but stay in copy-mode (don't cancel/jump to bottom)
pub(crate) fn setup_clipboard_bindings() {
    if !cfg!(target_os = "macos") {
        return;
    }
    for table in ["copy-mode-vi", "copy-mode"] {
        let _ = run_quiet(&[
            "tmux",
            "bind-key",
            "-T",
            table,
            "MouseDragEnd1Pane",
            "send-keys",
            "-X",
            "copy-pipe-no-clear",
            "pbcopy",
        ]);
        let _ = run_quiet(&[
            "tmux",
            "bind-key",
            "-T",
            table,
            "MouseDown1Pane",
            "select-pane",
            "\\;",
            "send-keys",
            "-X",
            "clear-selection",
        ]);
    }
}

#[tauri::command]
pub(crate) fn cancel_copy_mode(name: String) -> Result<(), String> {
    let (host_id, raw_name) = parse_session_key(&name);
    match host_id {
        Some(hid) => {
            let host = find_host(hid)?;
            let _ = run_remote_tmux_quiet(&host, &["send-keys", "-t", raw_name, "-X", "cancel"]);
        }
        None => {
            let _ = run_quiet(&["tmux", "send-keys", "-t", &name, "-X", "cancel"]);
        }
    }
    Ok(())
}

/// Exit tmux copy-mode only if the pane is actually in a mode. Returns whether a
/// cancel was issued, so the frontend can tell "ESC consumed by copy-mode" apart
/// from "ESC should reach the TUI app running inside the pane".
#[tauri::command]
pub(crate) fn copy_mode_cancel_if_active(name: String) -> Result<bool, String> {
    let (host_id, raw_name) = parse_session_key(&name);
    let in_mode = match host_id {
        Some(hid) => {
            let host = find_host(hid)?;
            run_remote_tmux_quiet(
                &host,
                &["display-message", "-p", "-t", raw_name, "#{pane_in_mode}"],
            )
            .map(|s| s.trim() == "1")
            .unwrap_or(false)
        }
        None => run_quiet(&[
            "tmux",
            "display-message",
            "-p",
            "-t",
            &name,
            "#{pane_in_mode}",
        ])
        .map(|s| s.trim() == "1")
        .unwrap_or(false),
    };
    if in_mode {
        match host_id {
            Some(hid) => {
                let host = find_host(hid)?;
                let _ =
                    run_remote_tmux_quiet(&host, &["send-keys", "-t", raw_name, "-X", "cancel"]);
            }
            None => {
                let _ = run_quiet(&["tmux", "send-keys", "-t", &name, "-X", "cancel"]);
            }
        }
    }
    Ok(in_mode)
}

fn sanitize_tmux_color(color: &str) -> Result<String, String> {
    let trimmed = color.trim();
    let hex = trimmed.strip_prefix('#').unwrap_or(trimmed);
    if hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(format!("#{hex}"))
    } else {
        Err(format!("invalid tmux color: {color}"))
    }
}

fn apply_tmux_options(host: Option<&HostConfig>, args: &[&str]) -> Result<(), String> {
    match host {
        Some(host) => run_remote_tmux_check(host, args).map(|_| ()),
        None => {
            let mut full = Vec::with_capacity(args.len() + 1);
            full.push("tmux");
            full.extend_from_slice(args);
            run_check(&full).map(|_| ())
        }
    }
}

#[tauri::command]
pub(crate) fn apply_tmux_theme(name: String, theme: TmuxStatusTheme) -> Result<(), String> {
    let (host_id, raw_name) = parse_session_key(&name);
    let host = match host_id {
        Some(hid) => Some(find_host(hid)?),
        None => None,
    };
    let target = format!("={raw_name}");
    let status_bg = sanitize_tmux_color(&theme.status_bg)?;
    let status_fg = sanitize_tmux_color(&theme.status_fg)?;
    let active_bg = sanitize_tmux_color(&theme.active_bg)?;
    let active_fg = sanitize_tmux_color(&theme.active_fg)?;
    let inactive_fg = sanitize_tmux_color(&theme.inactive_fg)?;
    let accent = sanitize_tmux_color(&theme.accent)?;

    let status_style = format!("bg={status_bg},fg={status_fg}");
    let inactive_style = format!("bg={status_bg},fg={inactive_fg}");
    let active_style = format!("bg={active_bg},fg={active_fg},bold");
    let message_style = format!("bg={active_bg},fg={active_fg}");
    let mode_style = format!("bg={accent},fg={active_fg}");
    let border_style = format!("fg={inactive_fg}");
    let active_border_style = format!("fg={accent}");
    let host_ref = host.as_ref();
    apply_tmux_options(
        host_ref,
        &[
            "set-option",
            "-t",
            &target,
            "status",
            "on",
            ";",
            "set-option",
            "-t",
            &target,
            "status-style",
            &status_style,
            ";",
            "set-option",
            "-t",
            &target,
            "status-left-style",
            &status_style,
            ";",
            "set-option",
            "-t",
            &target,
            "status-right-style",
            &status_style,
            ";",
            "set-option",
            "-t",
            &target,
            "window-status-style",
            &inactive_style,
            ";",
            "set-option",
            "-t",
            &target,
            "window-status-current-style",
            &active_style,
            ";",
            "set-option",
            "-t",
            &target,
            "message-style",
            &message_style,
            ";",
            "set-window-option",
            "-t",
            &target,
            "mode-style",
            &mode_style,
            ";",
            "set-window-option",
            "-t",
            &target,
            "pane-border-style",
            &border_style,
            ";",
            "set-window-option",
            "-t",
            &target,
            "pane-active-border-style",
            &active_border_style,
        ],
    )
}

#[tauri::command]
pub(crate) fn copy_tmux_selection(name: String) -> Result<bool, String> {
    let (host_id, raw_name) = parse_session_key(&name);
    let exact = format!("={raw_name}");
    let output = match host_id {
        Some(hid) => {
            let host = find_host(hid)?;
            let _ = run_remote_tmux_quiet(
                &host,
                &["send-keys", "-t", &exact, "-X", "copy-selection-no-clear"],
            );
            run_remote_tmux_output(&host, &["save-buffer", "-"])?
        }
        None => {
            let _ = run_quiet(&[
                "tmux",
                "send-keys",
                "-t",
                &exact,
                "-X",
                "copy-selection-no-clear",
            ]);
            std::process::Command::new(tmux_bin())
                .args(["save-buffer", "-"])
                .output()
                .map_err(|e| e.to_string())?
        }
    };
    if !output.status.success() || output.stdout.is_empty() {
        return Ok(false);
    }
    copy_bytes_to_clipboard(&output.stdout)?;
    Ok(true)
}

fn copy_bytes_to_clipboard(bytes: &[u8]) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("system clipboard copy is only supported on macOS".to_string());
    }
    let mut pbcopy = std::process::Command::new("pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(mut stdin) = pbcopy.stdin.take() {
        stdin.write_all(bytes).map_err(|e| e.to_string())?;
    }
    let status = pbcopy.wait().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("pbcopy exited {status}"))
    }
}
