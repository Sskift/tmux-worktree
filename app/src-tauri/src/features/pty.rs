use super::{
    kill_pty_controlled_session, open_pty_control, refresh_pty_control_status, release_pty_control,
    request_pty_control_takeover, resize_pty_control, write_pty_control, PtyControl,
    PtyControlStatus, TerminalControlState,
};
use crate::ipc::{OpenArgs, PtyChunk, PtyExit};
use crate::support::{app_home_dir, resolve_cmd};
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
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

    let child = pair
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

    let control = args
        .control_session
        .as_deref()
        .map(str::trim)
        .filter(|session| !session.is_empty())
        .map(|session| {
            open_pty_control(
                &app,
                control_state.inner(),
                &id,
                session,
                args.control_host_id.as_deref(),
            )
        });
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
