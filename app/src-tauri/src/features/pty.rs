use super::{
    kill_pty_controlled_session, open_pty_control, refresh_pty_control_status, release_pty_control,
    request_pty_control_takeover, resize_pty_control, resolve_pty_control_target,
    write_pty_control, PtyControl, PtyControlStatus, TerminalControlState,
};
use crate::config::{find_host, load_hosts};
use crate::ipc::{OpenArgs, PtyChunk, PtyExit};
use crate::remote::HostConfig;
use crate::support::{app_home_dir, resolve_cmd};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{Emitter, Manager, State};

struct PtyHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    control: Option<PtyControl>,
}

#[derive(Default)]
pub(crate) struct PtyState {
    ptys: Mutex<HashMap<String, PtyHandle>>,
}

fn command_name(command: &str) -> &str {
    Path::new(command)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(command)
}

fn target_from_tmux_args(args: &[String]) -> Option<String> {
    let index = args.iter().rposition(|value| value == "-t")?;
    args.get(index + 1)
        .map(|value| value.trim().trim_start_matches('=').to_string())
        .filter(|value| !value.is_empty())
}

fn target_from_remote_shell(command: &str) -> Option<String> {
    if !command.contains("attach-session") {
        return None;
    }
    let (_, suffix) = command.rsplit_once(" -t ")?;
    let suffix = suffix.trim_start();
    let token = if let Some(quoted) = suffix.strip_prefix('\'') {
        quoted.split('\'').next().unwrap_or_default()
    } else {
        suffix
            .split(|value: char| value.is_ascii_whitespace() || value == ';')
            .next()
            .unwrap_or_default()
    };
    let target = token.trim().trim_start_matches('=');
    (!target.is_empty()).then(|| target.to_string())
}

fn ssh_destination(args: &[String]) -> Option<&str> {
    let marker = args.iter().position(|value| value == "--")?;
    args.get(marker + 1).map(String::as_str)
}

fn shell_quote_arg(value: &str) -> String {
    if value.is_empty() {
        "''".to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

fn remote_shell_path_expr(value: &str) -> String {
    let trimmed = value.trim();
    let trimmed = if trimmed.is_empty() { "tmux" } else { trimmed };
    if trimmed == "~" {
        return "\"$HOME\"".to_string();
    }
    if let Some(path) = trimmed.strip_prefix("~/") {
        let mut escaped = String::new();
        for character in path.chars() {
            if matches!(character, '"' | '\\' | '$' | '`') {
                escaped.push('\\');
            }
            escaped.push(character);
        }
        return format!("\"$HOME/{escaped}\"");
    }
    shell_quote_arg(trimmed)
}

fn managed_ssh_attach_args(host: &HostConfig, session: &str) -> Vec<String> {
    let mut args = vec![
        "-tt".to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=accept-new".to_string(),
        "-o".to_string(),
        "ConnectTimeout=10".to_string(),
        "-o".to_string(),
        "ServerAliveInterval=15".to_string(),
        "-o".to_string(),
        "ServerAliveCountMax=3".to_string(),
        "-o".to_string(),
        "ControlMaster=auto".to_string(),
        "-o".to_string(),
        "ControlPersist=600".to_string(),
        "-o".to_string(),
        "ControlPath=~/.tmux-worktree/ssh/%C".to_string(),
    ];
    if let Some(port) = host.port {
        args.extend(["-p".to_string(), port.to_string()]);
    }
    if let Some(identity_file) = host.identity_file.as_deref() {
        args.extend(["-i".to_string(), identity_file.to_string()]);
    }
    if let Some(user) = host.user.as_deref() {
        args.extend(["-l".to_string(), user.to_string()]);
    }
    let exact = shell_quote_arg(&format!("={session}"));
    let tmux = remote_shell_path_expr(host.tmux_path.as_deref().unwrap_or("tmux"));
    args.extend([
        "--".to_string(),
        host.host.clone(),
        [
            "set -e".to_string(),
            "export TERM=xterm-256color".to_string(),
            format!("{tmux} has-session -t {exact}"),
            format!("{tmux} set-option -g mouse on >/dev/null 2>&1 || true"),
            format!("{tmux} bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-selection-and-cancel >/dev/null 2>&1 || true"),
            format!("{tmux} bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-selection-and-cancel >/dev/null 2>&1 || true"),
            format!("exec {tmux} attach-session -r -f ignore-size -t {exact}"),
        ]
        .join("; "),
    ]);
    args
}

fn attachment_identity(args: &OpenArgs) -> Result<Option<(String, Option<String>)>, String> {
    match command_name(&args.cmd) {
        "tmux" => Ok(target_from_tmux_args(&args.args).map(|target| (target, None))),
        "ssh" => {
            let Some(shell) = args.args.last() else {
                return Ok(None);
            };
            let Some(target) = target_from_remote_shell(shell) else {
                return Ok(None);
            };
            let destination = ssh_destination(&args.args)
                .ok_or("remote tmux attachment is missing its SSH destination")?;
            let host = load_hosts()?
                .into_iter()
                .find(|host| host.host == destination)
                .ok_or_else(|| {
                    "remote tmux attachment does not match a configured Dashboard Host".to_string()
                })?;
            Ok(Some((target, Some(host.id))))
        }
        _ => Ok(None),
    }
}

fn validate_managed_open(args: &OpenArgs) -> Result<(String, Option<String>), String> {
    let session = args
        .control_session
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("managed PTY requires controlSession")?
        .to_string();
    let host_id = args
        .control_host_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    if let Some(host_id) = host_id.as_deref() {
        let host = find_host(host_id)?;
        if command_name(&args.cmd) != "ssh" || args.args != managed_ssh_attach_args(&host, &session)
        {
            return Err(
                "managed remote PTY must use the canonical read-only SSH tmux attachment"
                    .to_string(),
            );
        }
    } else {
        let expected = [
            "attach-session",
            "-r",
            "-f",
            "ignore-size",
            "-t",
            session.as_str(),
        ];
        if command_name(&args.cmd) != "tmux" || args.args.iter().map(String::as_str).ne(expected) {
            return Err(
                "managed local PTY must use the canonical read-only tmux attachment".to_string(),
            );
        }
    }
    Ok((session, host_id))
}

fn validate_generic_open(
    app: &tauri::AppHandle,
    control_state: &TerminalControlState,
    args: &OpenArgs,
) -> Result<(), String> {
    if args.control_session.is_some() || args.control_host_id.is_some() {
        return Err("generic PTY must not include managed control fields".to_string());
    }
    let Some((session, host_id)) = attachment_identity(args)? else {
        return Ok(());
    };
    match resolve_pty_control_target(app, control_state, &session, host_id.as_deref()) {
        Ok(_) => {
            Err("generic PTY cannot attach a TW-managed session; use pty_open_managed".to_string())
        }
        Err(error) if error.code == "TARGET_NOT_FOUND" => Ok(()),
        Err(error) => Err(format!(
            "cannot prove tmux target is unmanaged; generic PTY fails closed: {error}"
        )),
    }
}

/// Runs a terminal ownership transfer while holding the same mutex used by
/// pty_write/resize/kill.  Callers must perform the complete bridge request in
/// this closure; exporting a lease and dropping the lock first would allow a
/// concurrent PTY write to reacquire ownership between drain and commit.
pub(crate) fn with_pty_control<R>(
    state: &PtyState,
    id: &str,
    operation: impl FnOnce(&mut PtyControl) -> Result<R, String>,
) -> Result<R, String> {
    let mut map = state.ptys.lock().unwrap();
    let control = map
        .get_mut(id)
        .and_then(|handle| handle.control.as_mut())
        .ok_or("pty is not a controlled managed terminal")?;
    operation(control)
}

pub(crate) fn kill_managed_session_with_control(
    app: &tauri::AppHandle,
    state: &PtyState,
    control_state: &TerminalControlState,
    session_name: &str,
    host_id: Option<&str>,
) -> Result<(), String> {
    let mut map = state.ptys.lock().unwrap();
    let matching_id = map
        .iter()
        .filter_map(|(id, handle)| handle.control.as_ref().map(|control| (id, control)))
        .filter(|(_, control)| {
            control.session_name == session_name && control.host_id.as_deref() == host_id
        })
        .max_by_key(|(_, control)| control.lease.is_some())
        .map(|(id, _)| id.clone());
    if let Some(id) = matching_id {
        let control = map
            .get_mut(&id)
            .and_then(|handle| handle.control.as_mut())
            .ok_or("managed terminal control disappeared")?;
        return kill_pty_controlled_session(app, control_state, control)
            .map_err(|error| error.to_string());
    }
    drop(map);

    let transient_id = format!("lifecycle-{}", uuid::Uuid::new_v4());
    let mut control = open_pty_control(app, control_state, &transient_id, session_name, host_id);
    match kill_pty_controlled_session(app, control_state, &mut control) {
        Ok(()) => Ok(()),
        Err(error) => {
            release_pty_control(app, control_state, &mut control);
            Err(error.to_string())
        }
    }
}

#[tauri::command]
pub(crate) fn pty_open(
    app: tauri::AppHandle,
    state: State<'_, Arc<PtyState>>,
    control_state: State<'_, Arc<TerminalControlState>>,
    args: OpenArgs,
) -> Result<String, String> {
    validate_generic_open(&app, control_state.inner(), &args)?;
    pty_open_impl(app, state.inner(), control_state.inner(), args, None)
}

#[tauri::command]
pub(crate) fn pty_open_managed(
    app: tauri::AppHandle,
    state: State<'_, Arc<PtyState>>,
    control_state: State<'_, Arc<TerminalControlState>>,
    args: OpenArgs,
) -> Result<String, String> {
    let control_target = validate_managed_open(&args)?;
    pty_open_impl(
        app,
        state.inner(),
        control_state.inner(),
        args,
        Some(control_target),
    )
}

fn pty_open_impl(
    app: tauri::AppHandle,
    state: &PtyState,
    control_state: &TerminalControlState,
    args: OpenArgs,
    control_target: Option<(String, Option<String>)>,
) -> Result<String, String> {
    let id = args
        .id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if state.ptys.lock().unwrap().contains_key(&id) {
        return Err(format!("pty id already exists: {id}"));
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: args.rows,
            cols: args.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("openpty: {error}"))?;

    let resolved_cmd = resolve_cmd(&args.cmd);
    let mut cmd = CommandBuilder::new(resolved_cmd);
    for argument in &args.args {
        cmd.arg(argument);
    }
    if let Some(cwd) = args.cwd.as_ref() {
        cmd.cwd(cwd);
    } else if let Some(home) = app_home_dir() {
        cmd.cwd(home);
    }

    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(env) = args.env {
        for (key, value) in env {
            cmd.env(key, value);
        }
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|error| format!("spawn: {error}"))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("clone reader: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("take writer: {error}"))?;

    let control = if let Some((session, host_id)) = control_target {
        let mut control = open_pty_control(&app, control_state, &id, &session, host_id.as_deref());
        if control.control_target_id.is_none() {
            let detail = control
                .last_error
                .clone()
                .unwrap_or_else(|| "managed control target is unresolved".to_string());
            let _ = child.kill();
            release_pty_control(&app, control_state, &mut control);
            return Err(format!("managed PTY fails closed: {detail}"));
        }
        Some(control)
    } else {
        None
    };
    let handle = PtyHandle {
        master: pair.master,
        writer,
        child,
        control,
    };
    state.ptys.lock().unwrap().insert(id.clone(), handle);

    let id_for_thread = id.clone();
    let app_for_thread = app.clone();
    thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => {
                    pending.extend_from_slice(&buffer[..read]);
                    let valid_up_to = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(error) => error.valid_up_to(),
                    };
                    if valid_up_to > 0 {
                        let valid: Vec<u8> = pending.drain(..valid_up_to).collect();
                        let chunk = String::from_utf8(valid).expect("validated above");
                        let _ = app_for_thread.emit(
                            &format!("pty:{}", id_for_thread),
                            PtyChunk {
                                id: id_for_thread.clone(),
                                data: chunk,
                            },
                        );
                    }
                    // Max valid UTF-8 sequence is 4 bytes; anything longer in pending
                    // is genuine garbage, not a chunk boundary — flush lossy and reset.
                    if pending.len() > 4 {
                        let chunk = String::from_utf8_lossy(&pending).to_string();
                        let _ = app_for_thread.emit(
                            &format!("pty:{}", id_for_thread),
                            PtyChunk {
                                id: id_for_thread.clone(),
                                data: chunk,
                            },
                        );
                        pending.clear();
                    }
                }
                Err(_) => break,
            }
        }
        let mut handle = {
            let state = app_for_thread.state::<Arc<PtyState>>();
            let mut map = state.ptys.lock().unwrap();
            map.remove(&id_for_thread)
        };
        if let Some(handle) = handle.as_mut() {
            if let Some(control) = handle.control.as_mut() {
                let control_state = app_for_thread.state::<Arc<TerminalControlState>>();
                release_pty_control(&app_for_thread, control_state.inner(), control);
            }
        }
        let code = handle
            .as_mut()
            .and_then(|handle| handle.child.wait().ok())
            .map(|status| status.exit_code() as i32)
            .unwrap_or(0);
        let _ = app_for_thread.emit(
            &format!("pty-exit:{}", id_for_thread),
            PtyExit {
                id: id_for_thread.clone(),
                code,
            },
        );
    });

    Ok(id)
}

#[tauri::command]
pub(crate) fn pty_write(
    app: tauri::AppHandle,
    state: State<'_, Arc<PtyState>>,
    control_state: State<'_, Arc<TerminalControlState>>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut map = state.ptys.lock().unwrap();
    let handle = map.get_mut(&id).ok_or("pty not found")?;
    if let Some(control) = handle.control.as_mut() {
        return write_pty_control(&app, control_state.inner(), control, data.as_bytes())
            .map_err(|error| error.to_string());
    }
    handle
        .writer
        .write_all(data.as_bytes())
        .map_err(|error| format!("write: {error}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn pty_resize(
    app: tauri::AppHandle,
    state: State<'_, Arc<PtyState>>,
    control_state: State<'_, Arc<TerminalControlState>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut map = state.ptys.lock().unwrap();
    let handle = map.get_mut(&id).ok_or("pty not found")?;
    handle
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("resize: {error}"))?;
    if let Some(control) = handle.control.as_mut() {
        resize_pty_control(&app, control_state.inner(), control, cols, rows)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn pty_kill(
    app: tauri::AppHandle,
    state: State<'_, Arc<PtyState>>,
    control_state: State<'_, Arc<TerminalControlState>>,
    id: String,
) -> Result<(), String> {
    let mut map = state.ptys.lock().unwrap();
    if let Some(mut handle) = map.remove(&id) {
        if let Some(control) = handle.control.as_mut() {
            release_pty_control(&app, control_state.inner(), control);
        }
        let _ = handle.child.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        managed_ssh_attach_args, target_from_remote_shell, target_from_tmux_args,
        validate_managed_open,
    };
    use crate::ipc::OpenArgs;
    use crate::remote::HostConfig;

    fn open_args(control_session: Option<&str>) -> OpenArgs {
        OpenArgs {
            id: Some("pty-test".to_string()),
            cmd: "tmux".to_string(),
            args: vec![
                "attach-session".to_string(),
                "-r".to_string(),
                "-f".to_string(),
                "ignore-size".to_string(),
                "-t".to_string(),
                "managed-one".to_string(),
            ],
            cwd: None,
            cols: 120,
            rows: 40,
            env: None,
            control_session: control_session.map(str::to_string),
            control_host_id: None,
        }
    }

    #[test]
    fn managed_pty_requires_control_fields_and_an_exact_command_target() {
        assert!(validate_managed_open(&open_args(None))
            .unwrap_err()
            .contains("requires controlSession"));
        assert_eq!(
            validate_managed_open(&open_args(Some("managed-one"))).unwrap(),
            ("managed-one".to_string(), None)
        );
        assert!(validate_managed_open(&open_args(Some("another-session")))
            .unwrap_err()
            .contains("canonical read-only"));
        let mut destructive = open_args(Some("managed-one"));
        destructive.args = vec![
            "kill-session".to_string(),
            "-t".to_string(),
            "managed-one".to_string(),
        ];
        assert!(validate_managed_open(&destructive)
            .unwrap_err()
            .contains("canonical read-only"));
    }

    #[test]
    fn attachment_target_parsers_keep_local_and_remote_identity_exact() {
        assert_eq!(
            target_from_tmux_args(&[
                "attach-session".to_string(),
                "-t".to_string(),
                "=managed-one".to_string(),
            ]),
            Some("managed-one".to_string())
        );
        assert_eq!(
            target_from_remote_shell(
                "set -e; 'tmux' has-session -t '=managed-one'; exec 'tmux' attach-session -r -f ignore-size -t '=managed-one'"
            ),
            Some("managed-one".to_string())
        );
    }

    #[test]
    fn managed_remote_attachment_is_rebuilt_from_the_configured_host() {
        let host = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "devbox".to_string(),
            user: Some("alice".to_string()),
            port: Some(2222),
            identity_file: Some("~/.ssh/dev key".to_string()),
            worktree_base: None,
            tmux_path: Some("~/bin/tmux".to_string()),
            tw_path: None,
        };
        let args = managed_ssh_attach_args(&host, "managed-one");
        assert_eq!(args[0], "-tt");
        assert_eq!(&args[args.len() - 2], "devbox");
        assert_eq!(
            args.last().unwrap(),
            "set -e; export TERM=xterm-256color; \"$HOME/bin/tmux\" has-session -t '=managed-one'; \"$HOME/bin/tmux\" set-option -g mouse on >/dev/null 2>&1 || true; \"$HOME/bin/tmux\" bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-selection-and-cancel >/dev/null 2>&1 || true; \"$HOME/bin/tmux\" bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-selection-and-cancel >/dev/null 2>&1 || true; exec \"$HOME/bin/tmux\" attach-session -r -f ignore-size -t '=managed-one'"
        );
    }
}

#[tauri::command]
pub(crate) fn pty_control_status(
    app: tauri::AppHandle,
    state: State<'_, Arc<PtyState>>,
    control_state: State<'_, Arc<TerminalControlState>>,
    id: String,
) -> Result<PtyControlStatus, String> {
    let mut map = state.ptys.lock().unwrap();
    let handle = map.get_mut(&id).ok_or("pty not found")?;
    let Some(control) = handle.control.as_mut() else {
        return Ok(PtyControlStatus {
            controlled: false,
            read_only: false,
            state: "UNCONTROLLED".to_string(),
            owner_kind: None,
            can_take_over: false,
            message: None,
        });
    };
    Ok(refresh_pty_control_status(
        &app,
        control_state.inner(),
        control,
    ))
}

#[tauri::command]
pub(crate) fn pty_control_takeover(
    app: tauri::AppHandle,
    state: State<'_, Arc<PtyState>>,
    control_state: State<'_, Arc<TerminalControlState>>,
    id: String,
) -> Result<PtyControlStatus, String> {
    let mut map = state.ptys.lock().unwrap();
    let handle = map.get_mut(&id).ok_or("pty not found")?;
    let control = handle
        .control
        .as_mut()
        .ok_or("pty is not a controlled managed terminal")?;
    Ok(request_pty_control_takeover(
        &app,
        control_state.inner(),
        control,
    ))
}
