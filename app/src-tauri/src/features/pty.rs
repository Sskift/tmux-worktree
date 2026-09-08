use super::{
    kill_pty_controlled_session, open_pty_control, recover_pty_control, refresh_pty_control_status,
    release_pty_control, request_pty_control_takeover, resize_pty_control,
    resolve_pty_control_target, scroll_pty_control, write_pty_control, PtyControl,
    PtyControlStatus, TerminalControlState,
};
use crate::config::{find_host, load_hosts};
use crate::features::control_plane::parse_session_key;
use crate::ipc::{OpenArgs, PtyChunk, PtyExit};
use crate::remote::HostConfig;
use crate::support::{app_home_dir, remote_path_expr, resolve_cmd, shell_quote};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{Emitter, Manager, State};

struct PtyHandle {
    instance_id: String,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    control: Option<PtyControl>,
    control_pending: bool,
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
    let exact = shell_quote(&format!("={session}"));
    let tmux_path = host.tmux_path.as_deref().unwrap_or("tmux");
    let tmux = remote_path_expr(if tmux_path.trim().is_empty() {
        "tmux"
    } else {
        tmux_path
    });
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
    let handle = map.get_mut(id).ok_or("pty not found")?;
    if handle.control_pending {
        return Err("managed PTY control is still initializing".to_string());
    }
    let control = handle
        .control
        .as_mut()
        .ok_or("pty is not a controlled managed terminal")?;
    operation(control)
}

/// A copy of a managed PTY's control state, taken under the global map lock
/// and refreshed outside it.  Observation-only status polling must not hold the
/// single `ptys` mutex across a remote terminal-control RPC: a slow or dead
/// SSH host (up to the 15s proxy timeout plus connect latency) would otherwise
/// freeze input to every other terminal.  The snapshot is never written back
/// while this PTY holds a lease, and never writes back lease/hand-off fields,
/// so an out-of-lock refresh cannot revive an ownership transfer another path
/// fenced while the RPC was in flight.
struct ControlSnapshot {
    instance_id: String,
    control_target_id: Option<String>,
    control: PtyControl,
}

fn snapshot_control_for_refresh(state: &PtyState, id: &str) -> Option<ControlSnapshot> {
    let mut map = state.ptys.lock().unwrap();
    let handle = map.get_mut(id)?;
    if handle.control_pending {
        return None;
    }
    let control = handle.control.as_mut()?;
    // A live lease means this PTY is the interactive owner: status refresh
    // then runs `lease.renew`, an ownership operation that may rewrite the
    // lease. Keep that path under the global lock exactly like pty_write so a
    // concurrent write cannot fence the lease between drain and commit.
    if control.lease.is_some() {
        return None;
    }
    Some(ControlSnapshot {
        instance_id: handle.instance_id.clone(),
        control_target_id: control.control_target_id.clone(),
        control: control.clone(),
    })
}

/// Run an observation-only refresh against the snapshot without the global map
/// lock, then merge the result back under the lock. The commit is rejected if
/// the PTY instance changed (removed/reopened) or its control target changed,
/// and whenever the live control holds a lease or a hand-off — observation
/// results must never touch ownership state.
fn refresh_control_snapshot<R>(
    state: &PtyState,
    id: &str,
    snapshot: ControlSnapshot,
    refresh: impl FnOnce(&mut PtyControl) -> R,
) -> Option<R> {
    let mut refreshed = snapshot.control;
    let result = refresh(&mut refreshed);
    let mut map = state.ptys.lock().unwrap();
    let handle = map.get_mut(id)?;
    if handle.instance_id != snapshot.instance_id {
        return None;
    }
    let live = handle.control.as_mut()?;
    if live.control_target_id != snapshot.control_target_id
        || live.lease.is_some()
        || live.pending_handoff_id.is_some()
    {
        return None;
    }
    live.control_epoch = refreshed.control_epoch;
    live.last_state = std::mem::take(&mut refreshed.last_state);
    live.last_owner_kind = refreshed.last_owner_kind.take();
    live.last_error = refreshed.last_error.take();
    Some(result)
}

pub(crate) fn kill_managed_session_with_control(
    app: &tauri::AppHandle,
    state: &PtyState,
    control_state: &TerminalControlState,
    session_name: &str,
    host_id: Option<&str>,
) -> Result<(), String> {
    // Locate a mounted managed terminal for this session under the map lock,
    // then drop the lock before the remote kill RPC: lifecycle.kill goes over
    // the same slow SSH lane as status polling, and holding the global map
    // lock across it would block every other terminal (including the user's
    // attempt to close other tabs). Ownership transfer inside
    // kill_pty_controlled_session operates on the cloned control; pty_write
    // on the same handle still serializes through the map lock, and a
    // conflicting writer either fences this kill via the terminal-control
    // authority (fail-closed) or the kill wins — both safe for a kill tab.
    let (matching_id, mut control) = {
        let map = state.ptys.lock().unwrap();
        let found = map
            .iter()
            .filter_map(|(id, handle)| handle.control.as_ref().map(|control| (id, control)))
            .filter(|(_, control)| {
                control.session_name == session_name && control.host_id.as_deref() == host_id
            })
            .max_by_key(|(_, control)| control.lease.is_some())
            .map(|(id, control)| (id.clone(), control.clone()));
        match found {
            Some(found) => found,
            None => {
                drop(map);
                let transient_id = format!("lifecycle-{}", uuid::Uuid::new_v4());
                let mut control =
                    open_pty_control(app, control_state, &transient_id, session_name, host_id);
                return match kill_pty_controlled_session(app, control_state, &mut control) {
                    Ok(()) => Ok(()),
                    Err(error) => {
                        release_pty_control(app, control_state, &mut control);
                        Err(error.to_string())
                    }
                };
            }
        }
    };

    let result = kill_pty_controlled_session(app, control_state, &mut control);
    // Mirror the terminal state onto the live handle if it is still the same
    // PTY and still points at the same control target; otherwise the result is
    // stale and is discarded. On success the kill won server-side, so clear the
    // live ownership fields. On failure a concurrent pty_write may have taken
    // ownership of the live handle while the RPC was in flight; leave that
    // lease fenced by the writer instead of overwriting it with stale fields.
    let mut map = state.ptys.lock().unwrap();
    if let Some(handle) = map.get_mut(&matching_id) {
        let target_matches = handle
            .control
            .as_ref()
            .is_some_and(|live| live.control_target_id == control.control_target_id);
        if target_matches {
            if result.is_ok() {
                if let Some(live) = handle.control.as_mut() {
                    live.lease = None;
                    live.pending_handoff_id = None;
                    live.last_state = "TARGET_GONE".to_string();
                    live.last_owner_kind = None;
                    live.last_error = None;
                }
            } else if let Some(live) = handle.control.as_mut() {
                if live.lease.is_none() && live.pending_handoff_id.is_none() {
                    live.last_state = std::mem::take(&mut control.last_state);
                    live.last_owner_kind = control.last_owner_kind.take();
                    live.last_error = control.last_error.take();
                }
            }
        }
    }
    drop(map);
    result.map_err(|error| error.to_string())
}

/// Shared body of the `kill_session` and `kill_plain_terminal` commands:
/// run on the blocking pool, dispatching to the managed control path when
/// requested and to the caller's legacy fallback otherwise.
pub(crate) async fn kill_with_managed_fallback<F>(
    app: tauri::AppHandle,
    pty_state: &std::sync::Arc<PtyState>,
    control_state: &std::sync::Arc<TerminalControlState>,
    name: String,
    managed: Option<bool>,
    kind: &str,
    legacy: F,
) -> Result<(), String>
where
    F: FnOnce(&str) -> Result<(), String> + Send + 'static,
{
    let pty_state = std::sync::Arc::clone(pty_state);
    let control_state = std::sync::Arc::clone(control_state);
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
            legacy(&name)
        }
    })
    .await
    .map_err(|error| format!("{kind} kill task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn pty_open(
    app: tauri::AppHandle,
    state: State<'_, Arc<PtyState>>,
    control_state: State<'_, Arc<TerminalControlState>>,
    args: OpenArgs,
) -> Result<String, String> {
    let state = Arc::clone(state.inner());
    let control_state = Arc::clone(control_state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        validate_generic_open(&app, control_state.as_ref(), &args)?;
        pty_open_impl(app, state.as_ref(), control_state.as_ref(), args, None)
    })
    .await
    .map_err(|error| format!("PTY open task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn pty_open_managed(
    app: tauri::AppHandle,
    state: State<'_, Arc<PtyState>>,
    control_state: State<'_, Arc<TerminalControlState>>,
    args: OpenArgs,
) -> Result<String, String> {
    let state = Arc::clone(state.inner());
    let control_state = Arc::clone(control_state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let control_target = validate_managed_open(&args)?;
        pty_open_impl(
            app,
            state.as_ref(),
            control_state.as_ref(),
            args,
            Some(control_target),
        )
    })
    .await
    .map_err(|error| format!("managed PTY open task failed: {error}"))?
}

fn start_pty_reader(
    app: tauri::AppHandle,
    id: String,
    instance_id: String,
    mut reader: Box<dyn Read + Send>,
) -> Result<(), String> {
    let (started_tx, started_rx) = mpsc::sync_channel(0);
    thread::Builder::new()
        .name("tw-pty-reader".to_string())
        .spawn(move || {
            // A zero-capacity channel is a startup barrier: pty_open_impl cannot
            // begin terminal-control RPCs until this drain thread is scheduled.
            if started_tx.send(()).is_err() {
                return;
            }
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
                            let _ = app.emit(
                                &format!("pty:{id}"),
                                PtyChunk {
                                    id: id.clone(),
                                    data: chunk,
                                },
                            );
                        }
                        // Max valid UTF-8 sequence is 4 bytes; anything longer in pending
                        // is genuine garbage, not a chunk boundary — flush lossy and reset.
                        if pending.len() > 4 {
                            let chunk = String::from_utf8_lossy(&pending).to_string();
                            let _ = app.emit(
                                &format!("pty:{id}"),
                                PtyChunk {
                                    id: id.clone(),
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
                let state = app.state::<Arc<PtyState>>();
                remove_pty_instance(state.inner(), &id, &instance_id)
            };
            if let Some(handle) = handle.as_mut() {
                if let Some(control) = handle.control.as_mut() {
                    let control_state = app.state::<Arc<TerminalControlState>>();
                    release_pty_control(&app, control_state.inner(), control);
                }
            }
            let code = handle
                .as_mut()
                .and_then(|handle| handle.child.wait().ok())
                .map(|status| status.exit_code() as i32)
                .unwrap_or(0);
            let _ = app.emit(
                &format!("pty-exit:{id}"),
                PtyExit {
                    id: id.clone(),
                    code,
                },
            );
        })
        .map_err(|error| format!("start PTY reader: {error}"))?;
    started_rx
        .recv_timeout(Duration::from_secs(1))
        .map_err(|error| format!("start PTY reader barrier: {error}"))
}

fn remove_pty_instance(state: &PtyState, id: &str, instance_id: &str) -> Option<PtyHandle> {
    let mut map = state.ptys.lock().unwrap();
    if map.get(id).map(|handle| handle.instance_id.as_str()) != Some(instance_id) {
        return None;
    }
    map.remove(id)
}

fn abort_pty_open(state: &PtyState, id: &str, instance_id: &str) {
    let handle = remove_pty_instance(state, id, instance_id);
    if let Some(mut handle) = handle {
        let _ = handle.child.kill();
        let _ = handle.child.wait();
    }
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

    // Resolve and size a managed target before tmux attaches. The attachment
    // uses `ignore-size`, so resizing its PTY after spawn cannot prevent the
    // first frame from being rendered at tmux's previous window geometry.
    // terminal-control has a dedicated SSH lane, and no interactive child has
    // been spawned yet, so this preflight cannot be blocked by PTY output.
    let mut prepared_control = if let Some((session, host_id)) = control_target.as_ref() {
        let mut control = open_pty_control(&app, control_state, &id, session, host_id.as_deref());
        if control.control_target_id.is_none() {
            let detail = control
                .last_error
                .clone()
                .unwrap_or_else(|| "managed control target is unresolved".to_string());
            release_pty_control(&app, control_state, &mut control);
            return Err(format!("managed PTY fails closed: {detail}"));
        }
        if let Err(error) =
            resize_pty_control(&app, control_state, &mut control, args.cols, args.rows)
        {
            control.last_error = Some(error.to_string());
            control.last_state = "RECOVERY_REQUIRED".to_string();
            control.last_owner_kind = None;
        }
        Some(control)
    } else {
        None
    };

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

    let child = match pair.slave.spawn_command(cmd) {
        Ok(child) => child,
        Err(error) => {
            if let Some(control) = prepared_control.as_mut() {
                release_pty_control(&app, control_state, control);
            }
            return Err(format!("spawn: {error}"));
        }
    };
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("clone reader: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("take writer: {error}"))?;

    let instance_id = uuid::Uuid::new_v4().to_string();
    let mut handle = PtyHandle {
        instance_id: instance_id.clone(),
        master: pair.master,
        writer,
        child,
        control: prepared_control,
        control_pending: false,
    };
    {
        let mut map = state.ptys.lock().unwrap();
        if map.contains_key(&id) {
            drop(map);
            let _ = handle.child.kill();
            let _ = handle.child.wait();
            return Err(format!("pty id already exists: {id}"));
        }
        map.insert(id.clone(), handle);
    }

    // Start draining immediately after spawn so tmux/SSH can never block on a
    // full PTY while the frontend establishes its event listeners.
    if let Err(error) = start_pty_reader(app.clone(), id.clone(), instance_id.clone(), reader) {
        abort_pty_open(state, &id, &instance_id);
        return Err(error);
    }

    Ok(id)
}

#[tauri::command]
pub(crate) async fn pty_write(
    app: tauri::AppHandle,
    state: State<'_, Arc<PtyState>>,
    control_state: State<'_, Arc<TerminalControlState>>,
    id: String,
    data: String,
) -> Result<(), String> {
    let state = Arc::clone(state.inner());
    let control_state = Arc::clone(control_state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let mut map = state.ptys.lock().unwrap();
        let handle = map.get_mut(&id).ok_or("pty not found")?;
        if handle.control_pending {
            return Err("managed PTY control is still initializing".to_string());
        }
        if let Some(control) = handle.control.as_mut() {
            return write_pty_control(&app, control_state.as_ref(), control, data.as_bytes())
                .map_err(|error| error.to_string());
        }
        handle
            .writer
            .write_all(data.as_bytes())
            .map_err(|error| format!("write: {error}"))?;
        Ok(())
    })
    .await
    .map_err(|error| format!("join PTY write: {error}"))?
}

const MAX_TERMINAL_REPLY_BYTES: usize = 8 * 1024;

fn valid_csi_reply(sequence: &[u8]) -> bool {
    let Some((&final_byte, body)) = sequence.split_last() else {
        return false;
    };
    if body.is_empty() || body.iter().any(|byte| !(0x20..=0x3f).contains(byte)) {
        return false;
    }
    let body = String::from_utf8_lossy(body);
    let numeric = |value: &str| {
        !value.is_empty()
            && value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b';' | b':'))
    };
    match final_byte {
        b'c' => matches!(body.as_bytes().first(), Some(b'?' | b'>' | b'=')) && numeric(&body[1..]),
        b'R' => {
            let value = body.strip_prefix('?').unwrap_or(&body);
            value.split_once(';').is_some_and(|(row, col)| {
                !row.is_empty()
                    && !col.is_empty()
                    && row.bytes().all(|byte| byte.is_ascii_digit())
                    && col.bytes().all(|byte| byte.is_ascii_digit())
            })
        }
        b'n' => {
            body == "0"
                || body.strip_prefix('?').is_some_and(|value| {
                    matches!(value, "0" | "10" | "11" | "13" | "20" | "21" | "53")
                        || value.strip_prefix("27;").is_some_and(&numeric)
                })
        }
        b't' => {
            matches!(body.as_ref(), "1" | "2")
                || body.split_once(';').is_some_and(|(kind, rest)| {
                    matches!(kind, "3" | "4" | "6" | "8" | "9")
                        && rest.split_once(';').is_some_and(|(first, second)| {
                            !first.is_empty()
                                && !second.is_empty()
                                && first.bytes().all(|byte| byte.is_ascii_digit())
                                && second.bytes().all(|byte| byte.is_ascii_digit())
                        })
                })
        }
        b'x' => {
            let values = body.split(';').collect::<Vec<_>>();
            values.len() == 7
                && matches!(values[0], "2" | "3")
                && values[1..].iter().all(|value| {
                    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
                })
        }
        b'y' => body
            .strip_suffix('$')
            .map(|value| value.strip_prefix('?').unwrap_or(value))
            .is_some_and(numeric),
        b'u' => body.strip_prefix('?').is_some_and(numeric),
        _ => false,
    }
}

fn valid_string_reply(kind: u8, payload: &[u8]) -> bool {
    match kind {
        b']' => {
            let Some(separator) = payload.iter().position(|byte| *byte == b';') else {
                return false;
            };
            let code = &payload[..separator];
            [
                "4", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "50", "52",
            ]
            .iter()
            .any(|candidate| code == candidate.as_bytes())
        }
        b'P' => {
            payload.starts_with(b"1+r")
                || payload.starts_with(b"0+r")
                || payload.starts_with(b"1$r")
                || payload.starts_with(b"0$r")
                || payload.starts_with(b">|")
        }
        _ => false,
    }
}

fn consume_terminal_reply(data: &[u8], offset: usize) -> Option<usize> {
    if data.get(offset..offset + 2)?.first() != Some(&0x1b) {
        return None;
    }
    let kind = data[offset + 1];
    if kind == b'[' {
        for index in offset + 2..data.len() {
            let byte = data[index];
            if (0x40..=0x7e).contains(&byte) {
                return valid_csi_reply(&data[offset + 2..=index]).then_some(index + 1);
            }
            if !(0x20..=0x3f).contains(&byte) {
                return None;
            }
        }
        return None;
    }
    if !matches!(kind, b']' | b'P') {
        return None;
    }
    for index in offset + 2..data.len() {
        if kind == b']' && data[index] == 0x07 {
            return valid_string_reply(kind, &data[offset + 2..index]).then_some(index + 1);
        }
        if data[index] == 0x1b && data.get(index + 1) == Some(&b'\\') {
            return valid_string_reply(kind, &data[offset + 2..index]).then_some(index + 2);
        }
    }
    None
}

fn valid_terminal_reply(data: &[u8]) -> bool {
    if data.is_empty() || data.len() > MAX_TERMINAL_REPLY_BYTES || !data.is_ascii() {
        return false;
    }
    let mut offset = 0;
    while offset < data.len() {
        let Some(next) = consume_terminal_reply(data, offset) else {
            return false;
        };
        offset = next;
    }
    true
}

#[tauri::command]
pub(crate) async fn pty_write_terminal_reply(
    state: State<'_, Arc<PtyState>>,
    id: String,
    data: String,
) -> Result<(), String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        if !valid_terminal_reply(data.as_bytes()) {
            return Err("invalid terminal protocol reply".to_string());
        }
        let mut map = state.ptys.lock().unwrap();
        let handle = map.get_mut(&id).ok_or("pty not found")?;
        if handle.control_pending {
            return Err("managed PTY control is still initializing".to_string());
        }
        if handle.control.is_none() {
            return Err("terminal protocol reply requires a controlled attachment".to_string());
        }
        handle
            .writer
            .write_all(data.as_bytes())
            .map_err(|error| format!("write terminal protocol reply: {error}"))
    })
    .await
    .map_err(|error| format!("join terminal protocol reply write: {error}"))?
}

#[tauri::command]
pub(crate) async fn pty_control_scroll(
    app: tauri::AppHandle,
    state: State<'_, Arc<PtyState>>,
    control_state: State<'_, Arc<TerminalControlState>>,
    id: String,
    direction: String,
    lines: u16,
) -> Result<(), String> {
    let state = Arc::clone(state.inner());
    let control_state = Arc::clone(control_state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let mut map = state.ptys.lock().unwrap();
        let handle = map.get_mut(&id).ok_or("pty not found")?;
        if handle.control_pending {
            return Err("managed PTY control is still initializing".to_string());
        }
        let control = handle
            .control
            .as_mut()
            .ok_or("pty is not a controlled managed terminal")?;
        scroll_pty_control(&app, control_state.as_ref(), control, &direction, lines)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("join PTY scroll: {error}"))?
}

#[tauri::command]
pub(crate) async fn pty_resize(
    app: tauri::AppHandle,
    state: State<'_, Arc<PtyState>>,
    control_state: State<'_, Arc<TerminalControlState>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let state = Arc::clone(state.inner());
    let control_state = Arc::clone(control_state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let mut map = state.ptys.lock().unwrap();
        let handle = map.get_mut(&id).ok_or("pty not found")?;
        if handle.control_pending {
            return Err("managed PTY control is still initializing".to_string());
        }
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
            resize_pty_control(&app, control_state.as_ref(), control, cols, rows)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("join PTY resize: {error}"))?
}

#[tauri::command]
pub(crate) async fn pty_kill(
    app: tauri::AppHandle,
    state: State<'_, Arc<PtyState>>,
    control_state: State<'_, Arc<TerminalControlState>>,
    id: String,
) -> Result<(), String> {
    let state = Arc::clone(state.inner());
    let control_state = Arc::clone(control_state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        // Remove the handle under the map lock, then run the remote lease
        // release without it: a dead SSH host must not keep the global pty map
        // locked for 15s+ while users keep typing into other terminals.
        let handle = {
            let mut map = state.ptys.lock().unwrap();
            map.remove(&id)
        };
        if let Some(mut handle) = handle {
            if let Some(control) = handle.control.as_mut() {
                release_pty_control(&app, control_state.as_ref(), control);
            }
            let _ = handle.child.kill();
            let _ = handle.child.wait();
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("PTY kill task failed: {error}"))?
}

pub(crate) fn release_all_pty_controls(
    app: &tauri::AppHandle,
    state: &PtyState,
    control_state: &TerminalControlState,
) {
    // Detach every managed control under the map lock, then issue lease
    // releases without it so a slow remote host cannot stretch shutdown into a
    // 15s-per-host stall while other terminal commands queue on the same lock.
    let mut controls: Vec<PtyControl> = {
        let mut map = state.ptys.lock().unwrap();
        map.values_mut()
            .filter_map(|handle| handle.control.take())
            .collect()
    };
    for control in &mut controls {
        release_pty_control(app, control_state, control);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        managed_ssh_attach_args, refresh_control_snapshot, snapshot_control_for_refresh,
        target_from_remote_shell, target_from_tmux_args, valid_terminal_reply,
        validate_managed_open, PtyHandle, PtyState,
    };
    use crate::features::PtyControl;
    use crate::ipc::OpenArgs;
    use crate::remote::HostConfig;
    use portable_pty::{native_pty_system, PtySize};
    use serde_json::json;
    use std::sync::mpsc;
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};

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
    fn only_terminal_protocol_replies_can_enter_the_attachment_lane() {
        for reply in [
            b"\x1b[?1;2c".as_slice(),
            b"\x1b[>0;276;0c".as_slice(),
            b"\x1b[24;80R".as_slice(),
            b"\x1b[0n".as_slice(),
            b"\x1b[8;24;80t".as_slice(),
            b"\x1b[?2026;1$y".as_slice(),
            b"\x1b]11;rgb:0d0d/0e0e/1010\x1b\\".as_slice(),
            b"\x1bP1+r544e=787465726d2d323536636f6c6f72\x1b\\".as_slice(),
        ] {
            assert!(valid_terminal_reply(reply), "{reply:?}");
        }
        for input in [
            b"hello".as_slice(),
            b"\x1b[A".as_slice(),
            b"\x1b[15~".as_slice(),
            b"\x1b[6n".as_slice(),
            b"\x1b[18t".as_slice(),
            b"\x1b[1;2x".as_slice(),
            b"\x1b[<0;10;5M".as_slice(),
            b"\x1b[200~pasted\x1b[201~".as_slice(),
            b"\x1b]2;title\x07".as_slice(),
        ] {
            assert!(!valid_terminal_reply(input), "{input:?}");
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

    fn test_control(target_id: &str, lease: Option<serde_json::Value>) -> PtyControl {
        PtyControl {
            session_name: "tw-term-test".to_string(),
            host_id: None,
            control_target_id: Some(target_id.to_string()),
            control_epoch: Some("epoch-one".to_string()),
            owner: json!({
                "kind": "dashboard",
                "instanceId": "dashboard:instance:pty-test",
            }),
            lease,
            desired_size: None,
            applied_size: None,
            next_operation: 0,
            pending_handoff_id: None,
            last_state: "FREE".to_string(),
            last_owner_kind: None,
            last_error: None,
        }
    }

    /// A no-op stand-in for `Box<dyn portable_pty::Child>`: the regression
    /// tests only need a live pty master/writer to prove lock behaviour, not a
    /// real subprocess. Spawning a process here made the tests flaky under the
    /// parallel integration binaries (portable-pty closes inherited fds in
    /// pre_exec), so the fake keeps them hermetic.
    #[derive(Debug)]
    struct FakeChild {
        killed: std::sync::atomic::AtomicBool,
    }

    impl portable_pty::ChildKiller for FakeChild {
        fn kill(&mut self) -> std::io::Result<()> {
            self.killed.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }

        fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
            Box::new(FakeChild {
                killed: std::sync::atomic::AtomicBool::new(
                    self.killed.load(std::sync::atomic::Ordering::SeqCst),
                ),
            })
        }
    }

    impl portable_pty::Child for FakeChild {
        fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
            Ok(self
                .killed
                .load(std::sync::atomic::Ordering::SeqCst)
                .then(|| portable_pty::ExitStatus::with_exit_code(0)))
        }

        fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
            self.killed.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(portable_pty::ExitStatus::with_exit_code(0))
        }

        fn process_id(&self) -> Option<u32> {
            Some(0)
        }
    }

    fn test_pty_handle(instance_id: &str, control: Option<PtyControl>) -> PtyHandle {
        let system = native_pty_system();
        let pair = system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let writer = pair.master.take_writer().unwrap();
        PtyHandle {
            instance_id: instance_id.to_string(),
            master: pair.master,
            writer,
            child: Box::new(FakeChild {
                killed: std::sync::atomic::AtomicBool::new(false),
            }),
            control,
            control_pending: false,
        }
    }

    fn insert_handle(state: &PtyState, id: &str, handle: PtyHandle) {
        state.ptys.lock().unwrap().insert(id.to_string(), handle);
    }

    fn kill_all_handles(state: &PtyState) {
        for (_, mut handle) in state.ptys.lock().unwrap().drain() {
            let _ = handle.child.kill();
            let _ = handle.child.wait();
        }
    }

    fn test_lease() -> serde_json::Value {
        json!({
            "controlTargetId": "target-one",
            "controlEpoch": "epoch-one",
            "leaseId": "lease-one",
            "fence": "12",
            "owner": {
                "kind": "dashboard",
                "instanceId": "dashboard:instance:pty-test",
            },
            "expiresAt": "2030-07-13T12:00:00.000Z",
        })
    }

    #[test]
    fn status_refresh_snapshot_runs_without_holding_the_global_map_lock() {
        // C008 regression: observation-only status polling must clone the
        // control and release the global map lock before its (potentially
        // 15s+) remote RPC, so another thread can take the lock for a
        // different PTY while the refresh closure is still running.
        let state = Arc::new(PtyState::default());
        insert_handle(
            &state,
            "remote",
            test_pty_handle("inst-remote", Some(test_control("target-remote", None))),
        );
        insert_handle(
            &state,
            "other",
            test_pty_handle("inst-other", Some(test_control("target-other", None))),
        );

        let snapshot = snapshot_control_for_refresh(&state, "remote")
            .expect("lease-less control must be snapshotted");

        let (in_rpc_tx, in_rpc_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let slow_state = Arc::clone(&state);
        thread::spawn(move || {
            // Simulate the slow remote RPC from inside the refresh closure:
            // this is exactly the window during which the global map lock must
            // NOT be held.
            refresh_control_snapshot(slow_state.as_ref(), "remote", snapshot, |control| {
                in_rpc_tx.send(()).unwrap();
                thread::sleep(Duration::from_millis(400));
                control.last_state = "HELD".to_string();
            });
            done_tx.send(()).unwrap();
        });
        in_rpc_rx.recv().unwrap();

        // A different PTY must be reachable while the refresh RPC is in
        // flight. The bug held the global map lock for the whole RPC, so
        // acquiring it here (as pty_write for another id would) blocks until
        // the slow refresh finished.
        let start = Instant::now();
        let _map = state
            .ptys
            .lock()
            .expect("different-id pty lock must not block on the remote status RPC");
        let elapsed = start.elapsed();
        assert!(
            elapsed < Duration::from_millis(200),
            "different-id pty access blocked for {elapsed:?} while status RPC was in flight"
        );
        drop(_map);
        done_rx.recv().unwrap();

        // The snapshot merge landed observation fields on the right handle.
        let map = state.ptys.lock().unwrap();
        let live = map.get("remote").unwrap().control.as_ref().unwrap();
        assert_eq!(live.last_state, "HELD");
        assert!(live.lease.is_none());
        drop(map);
        kill_all_handles(state.as_ref());
    }

    #[test]
    fn status_snapshot_merge_is_rejected_when_the_pty_instance_changed() {
        // C008 fence: the PTY tab may have been killed and reopened (new
        // instance_id) while the refresh RPC was in flight; the stale
        // observation must be discarded rather than written onto the new
        // handle.
        let state = PtyState::default();
        let snapshot = snapshot_control_for_refresh(&state, "remote");
        assert!(snapshot.is_none());

        insert_handle(
            &state,
            "remote",
            test_pty_handle("inst-one", Some(test_control("target-one", None))),
        );
        let snapshot = snapshot_control_for_refresh(&state, "remote").unwrap();

        // Simulate pty_kill + reopen: remove and insert a fresh instance.
        state.ptys.lock().unwrap().remove("remote");
        insert_handle(
            &state,
            "remote",
            test_pty_handle("inst-two", Some(test_control("target-one", None))),
        );

        let merged = refresh_control_snapshot(&state, "remote", snapshot, |control| {
            control.last_state = "HELD".to_string();
        });
        assert!(
            merged.is_none(),
            "stale snapshot must not merge onto a new instance"
        );
        let map = state.ptys.lock().unwrap();
        let handle = map.get("remote").unwrap();
        assert_eq!(handle.instance_id, "inst-two");
        assert_eq!(
            handle.control.as_ref().unwrap().last_state,
            "FREE",
            "new instance state must be untouched"
        );
        drop(map);
        kill_all_handles(&state);
    }

    #[test]
    fn status_snapshot_is_refused_while_the_pty_holds_a_lease() {
        // lease.renew is an ownership operation: it must stay on the locked
        // path (with_pty_control semantics), never on the lock-free snapshot
        // path, so a concurrent write cannot fence the lease between drain
        // and commit.
        let state = PtyState::default();
        insert_handle(
            &state,
            "remote",
            test_pty_handle(
                "inst-one",
                Some(test_control("target-one", Some(test_lease()))),
            ),
        );
        assert!(snapshot_control_for_refresh(&state, "remote").is_none());
        kill_all_handles(&state);
    }

    #[test]
    fn status_snapshot_never_writes_lease_or_handoff_fields_back() {
        // Even if the remote response (or a forged in-test closure) tries to
        // populate lease/handoff state on the snapshot, the merge must not
        // propagate them: observation results cannot revive ownership.
        let state = PtyState::default();
        insert_handle(
            &state,
            "remote",
            test_pty_handle("inst-one", Some(test_control("target-one", None))),
        );
        let snapshot = snapshot_control_for_refresh(&state, "remote").unwrap();
        let merged = refresh_control_snapshot(&state, "remote", snapshot, |control| {
            control.lease = Some(test_lease());
            control.pending_handoff_id = Some("handoff-stale".to_string());
            control.last_state = "HELD".to_string();
        });
        assert!(merged.is_some());
        let map = state.ptys.lock().unwrap();
        let live = map.get("remote").unwrap().control.as_ref().unwrap();
        assert_eq!(live.last_state, "HELD", "observation field must merge");
        assert!(live.lease.is_none(), "snapshot must never revive a lease");
        assert!(
            live.pending_handoff_id.is_none(),
            "snapshot must never set a hand-off id"
        );
        drop(map);
        kill_all_handles(&state);
    }
}

#[tauri::command]
pub(crate) async fn pty_control_status(
    app: tauri::AppHandle,
    state: State<'_, Arc<PtyState>>,
    control_state: State<'_, Arc<TerminalControlState>>,
    id: String,
) -> Result<PtyControlStatus, String> {
    let state = Arc::clone(state.inner());
    let control_state = Arc::clone(control_state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let uncontrolled = PtyControlStatus {
            controlled: false,
            read_only: false,
            state: "UNCONTROLLED".to_string(),
            owner_kind: None,
            can_take_over: false,
            can_recover: false,
            message: None,
        };
        // Observation-only path: clone the control under the map lock, run the
        // remote RPC outside it, and merge back with identity fencing. This
        // keeps a slow remote status poll (15s+ on an unreachable host) from
        // blocking input to every other terminal.
        if let Some(snapshot) = snapshot_control_for_refresh(state.as_ref(), &id) {
            let merged = refresh_control_snapshot(state.as_ref(), &id, snapshot, |control| {
                refresh_pty_control_status(&app, control_state.as_ref(), control)
            });
            return Ok(merged.unwrap_or_else(|| {
                // The PTY was removed/reopened or ownership changed while the
                // RPC was in flight. Report the current cached status without
                // issuing another remote call.
                let map = state.ptys.lock().unwrap();
                map.get(&id)
                    .and_then(|handle| handle.control.as_ref())
                    .map(PtyControl::status)
                    .unwrap_or(uncontrolled)
            }));
        }
        let mut map = state.ptys.lock().unwrap();
        let handle = map.get_mut(&id).ok_or("pty not found")?;
        if handle.control_pending {
            return Err("managed PTY control is still initializing".to_string());
        }
        let Some(control) = handle.control.as_mut() else {
            return Ok(uncontrolled);
        };
        Ok(refresh_pty_control_status(
            &app,
            control_state.as_ref(),
            control,
        ))
    })
    .await
    .map_err(|error| format!("join PTY control status: {error}"))?
}

#[tauri::command]
pub(crate) async fn pty_control_release(
    app: tauri::AppHandle,
    state: State<'_, Arc<PtyState>>,
    control_state: State<'_, Arc<TerminalControlState>>,
    id: String,
) -> Result<PtyControlStatus, String> {
    let state = Arc::clone(state.inner());
    let control_state = Arc::clone(control_state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let mut map = state.ptys.lock().unwrap();
        let handle = map.get_mut(&id).ok_or("pty not found")?;
        if handle.control_pending {
            return Err("managed PTY control is still initializing".to_string());
        }
        let control = handle
            .control
            .as_mut()
            .ok_or("pty is not a controlled managed terminal")?;
        release_pty_control(&app, control_state.as_ref(), control);
        Ok(control.status())
    })
    .await
    .map_err(|error| format!("join PTY control release: {error}"))?
}

#[tauri::command]
pub(crate) async fn pty_control_takeover(
    app: tauri::AppHandle,
    state: State<'_, Arc<PtyState>>,
    control_state: State<'_, Arc<TerminalControlState>>,
    id: String,
) -> Result<PtyControlStatus, String> {
    let state = Arc::clone(state.inner());
    let control_state = Arc::clone(control_state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let mut map = state.ptys.lock().unwrap();
        let handle = map.get_mut(&id).ok_or("pty not found")?;
        if handle.control_pending {
            return Err("managed PTY control is still initializing".to_string());
        }
        let control = handle
            .control
            .as_mut()
            .ok_or("pty is not a controlled managed terminal")?;
        Ok(request_pty_control_takeover(
            &app,
            control_state.as_ref(),
            control,
        ))
    })
    .await
    .map_err(|error| format!("join PTY takeover: {error}"))?
}

#[tauri::command]
pub(crate) async fn pty_control_recover(
    app: tauri::AppHandle,
    state: State<'_, Arc<PtyState>>,
    control_state: State<'_, Arc<TerminalControlState>>,
    id: String,
) -> Result<PtyControlStatus, String> {
    let state = Arc::clone(state.inner());
    let control_state = Arc::clone(control_state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let mut map = state.ptys.lock().unwrap();
        let handle = map.get_mut(&id).ok_or("pty not found")?;
        if handle.control_pending {
            return Err("managed PTY control is still initializing".to_string());
        }
        let control = handle
            .control
            .as_mut()
            .ok_or("pty is not a controlled managed terminal")?;
        Ok(recover_pty_control(&app, control_state.as_ref(), control))
    })
    .await
    .map_err(|error| format!("join PTY recovery: {error}"))?
}
