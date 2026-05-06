use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{Emitter, Manager, State};

#[derive(Serialize, Clone)]
struct Session {
    name: String,
    attached: bool,
    window_count: u32,
    created: u64,
    activity: u64,
}

#[derive(Serialize, Clone)]
struct Project {
    name: String,
    path: String,
}

struct PtyHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

#[derive(Default)]
struct PtyState {
    ptys: Mutex<HashMap<String, PtyHandle>>,
}

#[derive(Serialize, Clone)]
struct PtyChunk {
    id: String,
    data: String,
}

#[derive(Serialize, Clone)]
struct PtyExit {
    id: String,
    code: i32,
}

#[derive(Deserialize)]
struct OpenArgs {
    cmd: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    env: Option<HashMap<String, String>>,
}

#[tauri::command]
fn list_sessions() -> Result<Vec<Session>, String> {
    let fmt = "#{session_name}\x1f#{session_attached}\x1f#{session_windows}\x1f#{session_created}\x1f#{session_activity}";
    let output = std::process::Command::new("tmux")
        .args(["list-sessions", "-F", fmt])
        .output()
        .map_err(|e| format!("spawn tmux: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("no server running") || stderr.contains("no current server") {
            return Ok(vec![]);
        }
        return Err(format!("tmux exited {}: {}", output.status, stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let sessions = stdout
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let mut parts = line.split('\x1f');
            let name = parts.next()?.to_string();
            let attached = parts.next()? == "1";
            let window_count = parts.next()?.parse().ok()?;
            let created = parts.next()?.parse().ok()?;
            let activity = parts.next()?.parse().ok()?;
            Some(Session {
                name,
                attached,
                window_count,
                created,
                activity,
            })
        })
        .collect();

    Ok(sessions)
}

#[tauri::command]
fn list_projects() -> Result<Vec<Project>, String> {
    let home = dirs::home_dir().ok_or("home dir not found")?;
    let config_path = home.join(".tmux-worktree.json");

    if !config_path.exists() {
        return Ok(vec![]);
    }

    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("read config: {e}"))?;
    let config: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("parse config: {e}"))?;

    let projects = config
        .get("projects")
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(name, path)| {
                    Some(Project {
                        name: name.clone(),
                        path: path.as_str()?.to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(projects)
}

#[derive(Deserialize)]
struct CreateArgs {
    project: String,
    #[serde(rename = "aiCmd")]
    ai_cmd: String,
    name: Option<String>,
}

#[tauri::command]
fn create_worktree(args: CreateArgs) -> Result<String, String> {
    let before: std::collections::HashSet<String> =
        list_sessions()?.into_iter().map(|s| s.name).collect();

    let mut tw_args = vec![args.ai_cmd.clone(), args.project.clone()];
    if let Some(n) = args.name.as_ref() {
        let trimmed = n.trim();
        if !trimmed.is_empty() {
            tw_args.push(trimmed.to_string());
        }
    }

    let output = std::process::Command::new("tw")
        .args(&tw_args)
        .output()
        .map_err(|e| format!("spawn tw: {e}"))?;

    let after = list_sessions()?;
    if let Some(s) = after.iter().find(|s| !before.contains(&s.name)) {
        return Ok(s.name.clone());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    Err(format!(
        "tw exited {} — stderr: {} stdout: {}",
        output.status,
        stderr.trim(),
        stdout.trim()
    ))
}

#[tauri::command]
fn pty_open(
    app: tauri::AppHandle,
    state: State<'_, Arc<PtyState>>,
    args: OpenArgs,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: args.rows,
            cols: args.cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let mut cmd = CommandBuilder::new(&args.cmd);
    for a in &args.args {
        cmd.arg(a);
    }
    if let Some(cwd) = args.cwd.as_ref() {
        cmd.cwd(cwd);
    } else if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }

    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Some(env) = args.env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn: {e}"))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer: {e}"))?;

    let id = uuid::Uuid::new_v4().to_string();

    let handle = PtyHandle {
        master: pair.master,
        writer,
        child,
    };
    state
        .ptys
        .lock()
        .unwrap()
        .insert(id.clone(), handle);

    let id_for_thread = id.clone();
    let app_for_thread = app.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_for_thread.emit(
                        &format!("pty:{}", id_for_thread),
                        PtyChunk {
                            id: id_for_thread.clone(),
                            data: chunk,
                        },
                    );
                }
                Err(_) => break,
            }
        }
        let state = app_for_thread.state::<Arc<PtyState>>();
        let mut map = state.ptys.lock().unwrap();
        let code = map
            .get_mut(&id_for_thread)
            .and_then(|h| h.child.try_wait().ok().flatten())
            .map(|s| s.exit_code() as i32)
            .unwrap_or(0);
        map.remove(&id_for_thread);
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
fn pty_write(state: State<'_, Arc<PtyState>>, id: String, data: String) -> Result<(), String> {
    let mut map = state.ptys.lock().unwrap();
    let handle = map.get_mut(&id).ok_or("pty not found")?;
    handle
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write: {e}"))?;
    Ok(())
}

#[tauri::command]
fn pty_resize(
    state: State<'_, Arc<PtyState>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = state.ptys.lock().unwrap();
    let handle = map.get(&id).ok_or("pty not found")?;
    handle
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize: {e}"))?;
    Ok(())
}

#[tauri::command]
fn pty_kill(state: State<'_, Arc<PtyState>>, id: String) -> Result<(), String> {
    let mut map = state.ptys.lock().unwrap();
    if let Some(mut handle) = map.remove(&id) {
        let _ = handle.child.kill();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(Arc::new(PtyState::default()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            list_projects,
            create_worktree,
            pty_open,
            pty_write,
            pty_resize,
            pty_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
