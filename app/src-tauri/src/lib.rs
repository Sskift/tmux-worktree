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
    project: Option<String>,
    path: Option<String>,
    #[serde(rename = "aiCmd")]
    ai_cmd: String,
    name: Option<String>,
}

fn run_check(args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new(args[0])
        .args(&args[1..])
        .output()
        .map_err(|e| format!("spawn {}: {e}", args[0]))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "{} failed ({}): {}",
            args[0],
            output.status,
            stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_quiet(args: &[&str]) -> Option<String> {
    let output = std::process::Command::new(args[0])
        .args(&args[1..])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn detect_default_branch(repo: &str) -> String {
    if let Some(s) = run_quiet(&[
        "git",
        "-C",
        repo,
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
    ]) {
        if let Some(b) = s.strip_prefix("refs/remotes/origin/") {
            return b.to_string();
        }
    }
    if run_quiet(&[
        "git",
        "-C",
        repo,
        "ls-remote",
        "--heads",
        "origin",
        "master",
    ])
    .map(|s| !s.is_empty())
    .unwrap_or(false)
    {
        return "master".to_string();
    }
    "main".to_string()
}

fn unique_session_name(base: &str) -> String {
    let mut name = base.to_string();
    let mut i = 1;
    while run_quiet(&["tmux", "has-session", "-t", &format!("={}", name)]).is_some() {
        name = format!("{}-{}", base, i);
        i += 1;
    }
    name
}

fn random_id() -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    id.chars().take(5).collect()
}

#[tauri::command]
fn create_worktree(args: CreateArgs) -> Result<String, String> {
    let home = dirs::home_dir().ok_or("home dir not found")?;
    let config_path = home.join(".tmux-worktree.json");
    let config: serde_json::Value = if config_path.exists() {
        let config_text = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("read {}: {e}", config_path.display()))?;
        serde_json::from_str(&config_text).map_err(|e| format!("parse config: {e}"))?
    } else {
        serde_json::json!({})
    };

    let (project_label, project_dir) = if let Some(name) = args.project.as_deref() {
        let dir = config
            .get("projects")
            .and_then(|v| v.get(name))
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("project '{name}' not in ~/.tmux-worktree.json"))?
            .to_string();
        (name.to_string(), dir)
    } else if let Some(path) = args.path.as_deref() {
        let p = path.trim();
        if p.is_empty() {
            return Err("project or path required".into());
        }
        let label = std::path::Path::new(p)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("project")
            .to_string();
        (label, p.to_string())
    } else {
        return Err("project or path required".into());
    };

    if !std::path::Path::new(&project_dir).exists() {
        return Err(format!("project dir does not exist: {project_dir}"));
    }

    let worktree_base = config
        .get("worktreeBase")
        .and_then(|v| v.as_str())
        .unwrap_or("/private/tmp/tmux-worktree/projects")
        .to_string();

    let trimmed_name = args.name.as_deref().map(str::trim).unwrap_or("");
    let base_session = if trimmed_name.is_empty() {
        project_label.clone()
    } else {
        format!("{}-{}", project_label, trimmed_name)
    };
    let session = unique_session_name(&base_session);

    let work_dir = if run_quiet(&[
        "git",
        "-C",
        &project_dir,
        "rev-parse",
        "--is-inside-work-tree",
    ])
    .as_deref()
        == Some("true")
    {
        let default_branch = detect_default_branch(&project_dir);
        let _ = run_quiet(&[
            "git",
            "-C",
            &project_dir,
            "fetch",
            "origin",
            &default_branch,
            "--quiet",
        ]);

        let branch_id = random_id();
        let branch_name = format!("{}-{}", session, branch_id);
        let project_worktree_root = format!("{}/{}", worktree_base, project_label);
        std::fs::create_dir_all(&project_worktree_root)
            .map_err(|e| format!("mkdir {project_worktree_root}: {e}"))?;
        let worktree_dir = format!("{}/{}", project_worktree_root, branch_name);

        run_check(&[
            "git",
            "-C",
            &project_dir,
            "worktree",
            "add",
            "-b",
            &branch_name,
            &worktree_dir,
            &format!("origin/{}", default_branch),
            "--quiet",
        ])?;

        worktree_dir
    } else {
        project_dir
    };

    run_check(&["tmux", "new-session", "-d", "-s", &session, "-c", &work_dir])?;
    run_check(&[
        "tmux",
        "send-keys",
        "-t",
        &session,
        &args.ai_cmd,
        "C-m",
    ])?;

    Ok(session)
}

#[tauri::command]
fn kill_session(name: String) -> Result<(), String> {
    run_check(&["tmux", "kill-session", "-t", &name])?;
    Ok(())
}

#[tauri::command]
fn session_cwd(name: String) -> Result<String, String> {
    let output = std::process::Command::new("tmux")
        .args([
            "display-message",
            "-p",
            "-t",
            &name,
            "#{pane_current_path}",
        ])
        .output()
        .map_err(|e| format!("spawn tmux: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "tmux display-message failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[derive(Deserialize)]
struct AddProjectArgs {
    name: String,
    path: String,
}

#[tauri::command]
fn add_project(args: AddProjectArgs) -> Result<Vec<Project>, String> {
    let name = args.name.trim();
    let path = args.path.trim();
    if name.is_empty() {
        return Err("name required".into());
    }
    if path.is_empty() {
        return Err("path required".into());
    }
    if !std::path::Path::new(path).is_dir() {
        return Err(format!("not a directory: {path}"));
    }

    let home = dirs::home_dir().ok_or("home dir not found")?;
    let config_path = home.join(".tmux-worktree.json");

    let mut config: serde_json::Value = if config_path.exists() {
        let text = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("read config: {e}"))?;
        serde_json::from_str(&text).map_err(|e| format!("parse config: {e}"))?
    } else {
        serde_json::json!({ "projects": {} })
    };

    let projects = config
        .as_object_mut()
        .ok_or("config root is not an object")?
        .entry("projects")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or("projects is not an object")?;
    projects.insert(name.to_string(), serde_json::Value::String(path.to_string()));

    let pretty = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("serialize config: {e}"))?;
    std::fs::write(&config_path, pretty).map_err(|e| format!("write config: {e}"))?;

    list_projects()
}

#[derive(Serialize, Clone)]
struct GitStatus {
    branch: String,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    staged: u32,
    unstaged: u32,
    untracked: u32,
    conflicts: u32,
    files: Vec<GitFile>,
}

#[derive(Serialize, Clone)]
struct GitFile {
    code: String,
    path: String,
}

#[tauri::command]
fn git_status(cwd: String) -> Result<Option<GitStatus>, String> {
    let inside = run_quiet(&[
        "git",
        "-C",
        &cwd,
        "rev-parse",
        "--is-inside-work-tree",
    ]);
    if inside.as_deref() != Some("true") {
        return Ok(None);
    }

    let output = std::process::Command::new("git")
        .args(["-C", &cwd, "status", "--porcelain=v2", "--branch"])
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "git status failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut status = GitStatus {
        branch: String::new(),
        upstream: None,
        ahead: 0,
        behind: 0,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicts: 0,
        files: Vec::new(),
    };

    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            status.branch = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            status.upstream = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            let mut parts = rest.split_whitespace();
            if let Some(a) = parts.next() {
                status.ahead = a.trim_start_matches('+').parse().unwrap_or(0);
            }
            if let Some(b) = parts.next() {
                status.behind = b.trim_start_matches('-').parse().unwrap_or(0);
            }
        } else if let Some(rest) = line.strip_prefix("1 ") {
            // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            let mut parts = rest.splitn(9, ' ');
            let xy = parts.next().unwrap_or("..");
            let path = parts.nth(7).unwrap_or("").to_string();
            let (x, y) = (xy.chars().next().unwrap_or('.'), xy.chars().nth(1).unwrap_or('.'));
            if x != '.' { status.staged += 1; }
            if y != '.' { status.unstaged += 1; }
            status.files.push(GitFile { code: xy.to_string(), path });
        } else if let Some(rest) = line.strip_prefix("2 ") {
            // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X-score> <path><tab><origPath>
            let mut parts = rest.splitn(10, ' ');
            let xy = parts.next().unwrap_or("..");
            let tail = parts.nth(8).unwrap_or("");
            let path = tail.split('\t').next().unwrap_or("").to_string();
            let (x, y) = (xy.chars().next().unwrap_or('.'), xy.chars().nth(1).unwrap_or('.'));
            if x != '.' { status.staged += 1; }
            if y != '.' { status.unstaged += 1; }
            status.files.push(GitFile { code: xy.to_string(), path });
        } else if let Some(rest) = line.strip_prefix("u ") {
            let mut parts = rest.splitn(11, ' ');
            let xy = parts.next().unwrap_or("UU");
            let path = parts.nth(9).unwrap_or("").to_string();
            status.conflicts += 1;
            status.files.push(GitFile { code: xy.to_string(), path });
        } else if let Some(rest) = line.strip_prefix("? ") {
            status.untracked += 1;
            status.files.push(GitFile { code: "??".to_string(), path: rest.to_string() });
        }
    }

    Ok(Some(status))
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
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(Arc::new(PtyState::default()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            list_projects,
            add_project,
            create_worktree,
            kill_session,
            session_cwd,
            git_status,
            pty_open,
            pty_write,
            pty_resize,
            pty_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
