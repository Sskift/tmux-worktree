use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use tauri::{Emitter, Manager, State};

/// macOS .app 包启动时环境变量极少，从用户登录 shell 继承完整环境
/// （PATH、TMUX_TMPDIR、LANG 等），这样 tmux/git 子进程才能正常工作。
fn inherit_shell_env() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = std::process::Command::new(&shell)
        .args(["-l", "-c", "env -0"])
        .output();
    let output = match output {
        Ok(o) if o.status.success() => o,
        _ => return,
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    for entry in stdout.split('\0') {
        if let Some((key, val)) = entry.split_once('=') {
            if matches!(key, "PWD" | "OLDPWD" | "_" | "SHLVL") {
                continue;
            }
            unsafe {
                std::env::set_var(key, val);
            }
        }
    }
}

fn app_home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("TW_DASHBOARD_HOME")
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(dirs::home_dir)
}

fn app_home_dir_or_tmp() -> std::path::PathBuf {
    app_home_dir().unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
}

fn expand_home_path(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed == "~" {
        return app_home_dir_or_tmp().to_string_lossy().to_string();
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        return app_home_dir_or_tmp()
            .join(rest)
            .to_string_lossy()
            .to_string();
    }
    trimmed.to_string()
}

fn tmux_bin() -> &'static str {
    static BIN: OnceLock<String> = OnceLock::new();
    BIN.get_or_init(|| {
        for p in [
            "/opt/homebrew/bin/tmux",
            "/usr/local/bin/tmux",
            "/usr/bin/tmux",
        ] {
            if std::path::Path::new(p).exists() {
                return p.to_string();
            }
        }
        "tmux".to_string()
    })
}

fn git_bin() -> &'static str {
    static BIN: OnceLock<String> = OnceLock::new();
    BIN.get_or_init(|| {
        for p in [
            "/opt/homebrew/bin/git",
            "/usr/local/bin/git",
            "/usr/bin/git",
        ] {
            if std::path::Path::new(p).exists() {
                return p.to_string();
            }
        }
        "git".to_string()
    })
}

fn resolve_cmd(name: &str) -> &str {
    match name {
        "tmux" => tmux_bin(),
        "git" => git_bin(),
        _ => name,
    }
}

#[derive(Serialize, Clone)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    is_symlink: bool,
    is_hidden: bool,
    size: u64,
}

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
    branch: Option<String>,
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

struct TunnelState {
    process: Mutex<Option<std::process::Child>>,
    serve_process: Mutex<Option<std::process::Child>>,
    url: Mutex<Option<String>>,
    token: Mutex<String>,
    last_error: Mutex<Option<String>>,
}

impl Default for TunnelState {
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
            serve_process: Mutex::new(None),
            url: Mutex::new(None),
            token: Mutex::new(String::new()),
            last_error: Mutex::new(None),
        }
    }
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
    let output = std::process::Command::new(tmux_bin())
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
            if name.starts_with("tw-term-") || name.starts_with("tw-mobile-") {
                return None;
            }
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
fn tmux_session_exists(name: String) -> Result<bool, String> {
    let exact = format!("={}", name);
    Ok(run_quiet(&["tmux", "has-session", "-t", &exact]).is_some())
}

#[tauri::command]
fn list_projects() -> Result<Vec<Project>, String> {
    let home = app_home_dir().ok_or("home dir not found")?;
    let config_path = home.join(".tmux-worktree.json");

    if !config_path.exists() {
        return Ok(vec![]);
    }

    let content = std::fs::read_to_string(&config_path).map_err(|e| format!("read config: {e}"))?;
    let config: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("parse config: {e}"))?;

    Ok(projects_from_config(&config))
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
struct OrphanedWorktree {
    project: String,
    path: String,
    name: String,
}

#[derive(Deserialize)]
struct CreateArgs {
    project: Option<String>,
    path: Option<String>,
    #[serde(rename = "aiCmd")]
    ai_cmd: String,
    name: Option<String>,
    branch: Option<String>,
}

fn string_field<'a>(value: &'a serde_json::Value, names: &[&str]) -> Option<&'a str> {
    names
        .iter()
        .find_map(|name| value.get(name).and_then(|v| v.as_str()))
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn project_from_value(name: String, value: &serde_json::Value) -> Option<Project> {
    if let Some(path) = value.as_str().map(str::trim).filter(|s| !s.is_empty()) {
        return Some(Project {
            name,
            path: expand_home_path(path),
            branch: None,
        });
    }

    let path = string_field(
        value,
        &[
            "path",
            "dir",
            "directory",
            "root",
            "repo",
            "repoPath",
            "repository",
            "repositoryPath",
        ],
    )?;
    let branch = string_field(
        value,
        &[
            "branch",
            "targetBranch",
            "target_branch",
            "defaultBranch",
            "default_branch",
        ],
    )
    .map(ToString::to_string);
    Some(Project {
        name,
        path: expand_home_path(path),
        branch,
    })
}

fn projects_value(config: &serde_json::Value) -> Option<&serde_json::Value> {
    if config.is_array() {
        return Some(config);
    }
    ["projects", "repositories", "repos"]
        .iter()
        .find_map(|key| config.get(key))
}

fn projects_from_config(config: &serde_json::Value) -> Vec<Project> {
    match projects_value(config) {
        Some(serde_json::Value::Object(obj)) => obj
            .iter()
            .filter_map(|(name, value)| project_from_value(name.clone(), value))
            .collect(),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|value| {
                if let Some(path) = value.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    let expanded = expand_home_path(path);
                    let name = Path::new(&expanded)
                        .file_name()
                        .and_then(|s| s.to_str())
                        .unwrap_or(&expanded)
                        .to_string();
                    return Some(Project {
                        name,
                        path: expanded,
                        branch: None,
                    });
                }
                let name = string_field(value, &["name", "key", "id", "label"])?.to_string();
                project_from_value(name, value)
            })
            .collect(),
        _ => vec![],
    }
}

fn project_from_config(config: &serde_json::Value, name: &str) -> Option<Project> {
    projects_value(config).and_then(|projects| match projects {
        serde_json::Value::Object(obj) => obj
            .get(name)
            .and_then(|value| project_from_value(name.to_string(), value)),
        serde_json::Value::Array(items) => items.iter().find_map(|value| {
            let project_name = string_field(value, &["name", "key", "id", "label"])?;
            if project_name == name {
                project_from_value(name.to_string(), value)
            } else {
                None
            }
        }),
        _ => None,
    })
}

fn config_worktree_base(config: &serde_json::Value) -> Option<String> {
    string_field(
        config,
        &[
            "worktreeBase",
            "worktree_base",
            "worktreeDir",
            "worktreeRoot",
            "worktreesDir",
            "worktreesRoot",
        ],
    )
    .map(expand_home_path)
}

fn run_check(args: &[&str]) -> Result<String, String> {
    let bin = resolve_cmd(args[0]);
    let output = std::process::Command::new(bin)
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
    let bin = resolve_cmd(args[0]);
    let output = std::process::Command::new(bin)
        .args(&args[1..])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn pending_cleanup_path() -> std::path::PathBuf {
    app_home_dir_or_tmp().join(".tw-dashboard-pending-worktree-cleanup.json")
}

fn load_pending_cleanup() -> Vec<OrphanedWorktree> {
    let path = pending_cleanup_path();
    if !path.exists() {
        return vec![];
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<OrphanedWorktree>>(&text).ok())
        .unwrap_or_default()
}

fn save_pending_cleanup(entries: &[OrphanedWorktree]) {
    let path = pending_cleanup_path();
    if entries.is_empty() {
        let _ = std::fs::remove_file(path);
        return;
    }
    if let Ok(text) = serde_json::to_string_pretty(entries) {
        let _ = std::fs::write(path, text);
    }
}

fn remove_pending_cleanup_path(path: &str) {
    let mut pending = load_pending_cleanup();
    pending.retain(|entry| entry.path != path);
    save_pending_cleanup(&pending);
}

fn live_session_names() -> HashSet<String> {
    list_sessions()
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.name)
        .collect()
}

fn orphaned_worktrees(
    base_path: &std::path::Path,
    live_sessions: &HashSet<String>,
) -> Vec<OrphanedWorktree> {
    if !base_path.exists() {
        return vec![];
    }

    let project_dirs = match std::fs::read_dir(base_path) {
        Ok(rd) => rd,
        Err(_) => return vec![],
    };

    let mut orphans = Vec::new();
    for project_entry in project_dirs.flatten() {
        if !project_entry.path().is_dir() {
            continue;
        }
        let project = project_entry.file_name().to_string_lossy().to_string();
        let wt_dirs = match std::fs::read_dir(project_entry.path()) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for wt_entry in wt_dirs.flatten() {
            let wt_path = wt_entry.path();
            if !wt_path.is_dir() {
                continue;
            }
            if !is_git_worktree_dir(&wt_path) {
                continue;
            }
            let dirname = wt_entry.file_name().to_string_lossy().to_string();
            let session_name = derive_session_name(&dirname);
            if live_sessions.contains(&session_name) {
                continue;
            }
            orphans.push(OrphanedWorktree {
                project: project.clone(),
                path: wt_path.to_string_lossy().to_string(),
                name: session_name,
            });
        }
    }
    orphans
}

#[cfg(test)]
fn worktrees_for_session(base_path: &std::path::Path, session_name: &str) -> Vec<OrphanedWorktree> {
    if !base_path.exists() {
        return vec![];
    }

    let project_dirs = match std::fs::read_dir(base_path) {
        Ok(rd) => rd,
        Err(_) => return vec![],
    };

    let mut matches = Vec::new();
    for project_entry in project_dirs.flatten() {
        if !project_entry.path().is_dir() {
            continue;
        }
        let project = project_entry.file_name().to_string_lossy().to_string();
        let wt_dirs = match std::fs::read_dir(project_entry.path()) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for wt_entry in wt_dirs.flatten() {
            let wt_path = wt_entry.path();
            if !wt_path.is_dir() {
                continue;
            }
            if !is_git_worktree_dir(&wt_path) {
                continue;
            }
            let dirname = wt_entry.file_name().to_string_lossy().to_string();
            if derive_session_name(&dirname) != session_name {
                continue;
            }
            matches.push(OrphanedWorktree {
                project: project.clone(),
                path: wt_path.to_string_lossy().to_string(),
                name: session_name.to_string(),
            });
        }
    }
    matches
}

fn repo_root_for_worktree(path: &str) -> Option<String> {
    let common_dir = run_check(&[
        "git",
        "-C",
        path,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
    ])
    .ok()?;
    let common_path = std::path::Path::new(&common_dir);
    if common_path.file_name().and_then(|n| n.to_str()) == Some(".git") {
        return common_path
            .parent()
            .map(|p| p.to_string_lossy().to_string());
    }
    None
}

fn try_cleanup_worktree(path: &str, force: bool) -> bool {
    let worktree_path = std::path::Path::new(path);
    if !worktree_path.exists() {
        return true;
    }
    let Some(repo_root) = repo_root_for_worktree(path) else {
        return false;
    };
    let mut args = vec!["-C", &repo_root, "worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(path);
    let output = std::process::Command::new(git_bin()).args(args).output();
    let Ok(output) = output else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    if worktree_path.exists() {
        let _ = std::fs::remove_dir_all(worktree_path);
    }
    !worktree_path.exists()
}

fn cleanup_pending_worktrees() {
    let live_sessions = live_session_names();
    let mut remaining = Vec::new();
    for entry in load_pending_cleanup() {
        if !std::path::Path::new(&entry.path).exists() {
            continue;
        }
        if live_sessions.contains(&entry.name) {
            continue;
        }
        if !try_cleanup_worktree(&entry.path, false) {
            remaining.push(entry);
        }
    }
    save_pending_cleanup(&remaining);
}

// 优化 tmux 鼠标选择体验（server-global，幂等）：
//  1. MouseDragEnd1Pane → copy-pipe-no-clear "pbcopy"：松手保留高亮 + 进系统剪贴板
//  2. MouseDown1Pane → clear selection but stay in copy-mode (don't cancel/jump to bottom)
fn setup_clipboard_bindings() {
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
fn cancel_copy_mode(name: String) -> Result<(), String> {
    let _ = run_quiet(&["tmux", "send-keys", "-t", &name, "-X", "cancel"]);
    Ok(())
}

#[tauri::command]
fn copy_tmux_selection(_name: String) -> Result<bool, String> {
    let output = std::process::Command::new("tmux")
        .args(["save-buffer", "-"])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() || output.stdout.is_empty() {
        return Ok(false);
    }
    let mut pbcopy = std::process::Command::new("pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(mut stdin) = pbcopy.stdin.take() {
        use std::io::Write;
        let _ = stdin.write_all(&output.stdout);
    }
    let _ = pbcopy.wait();
    Ok(true)
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

/// tmux session 名的最大长度，与 CLI (`src/dev.ts` 的 `SESSION_NAME_MAX_LEN`) 对齐。
const SESSION_NAME_MAX_LEN: usize = 20;

#[tauri::command]
fn create_worktree(args: CreateArgs) -> Result<String, String> {
    let home = app_home_dir().ok_or("home dir not found")?;
    let config_path = home.join(".tmux-worktree.json");
    let config: serde_json::Value = if config_path.exists() {
        let config_text = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("read {}: {e}", config_path.display()))?;
        serde_json::from_str(&config_text).map_err(|e| format!("parse config: {e}"))?
    } else {
        serde_json::json!({})
    };

    let (project_label, project_dir, project_branch) = if let Some(name) = args.project.as_deref() {
        let project = project_from_config(&config, name)
            .ok_or_else(|| format!("project '{name}' not in ~/.tmux-worktree.json"))?;
        (project.name, project.path, project.branch)
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
        (label, p.to_string(), None)
    } else {
        return Err("project or path required".into());
    };

    if !std::path::Path::new(&project_dir).exists() {
        return Err(format!("project dir does not exist: {project_dir}"));
    }

    let worktree_base = config_worktree_base(&config)
        .unwrap_or_else(|| "/private/tmp/tmux-worktree/projects".to_string());

    let trimmed_name = args.name.as_deref().map(str::trim).unwrap_or("");
    let base_session = if trimmed_name.is_empty() {
        project_label.clone()
    } else {
        format!("{}-{}", project_label, trimmed_name)
    };
    // 截断到 SESSION_NAME_MAX_LEN，与 CLI (src/dev.ts) 对齐，否则两边对同一
    // project+title 生成的 session/分支名会分叉，破坏 session↔worktree 关联。
    let base_session: String = base_session.chars().take(SESSION_NAME_MAX_LEN).collect();
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
        let target_branch = args
            .branch
            .as_deref()
            .map(str::trim)
            .filter(|branch| !branch.is_empty())
            .map(ToString::to_string)
            .or(project_branch)
            .unwrap_or_else(|| detect_default_branch(&project_dir));
        let _ = run_quiet(&[
            "git",
            "-C",
            &project_dir,
            "fetch",
            "origin",
            &target_branch,
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
            &format!("origin/{}", target_branch),
            "--quiet",
        ])?;

        worktree_dir
    } else {
        project_dir
    };

    run_check(&["tmux", "new-session", "-d", "-s", &session, "-c", &work_dir])?;
    setup_clipboard_bindings();
    run_check(&["tmux", "send-keys", "-t", &session, &args.ai_cmd, "C-m"])?;

    Ok(session)
}

#[tauri::command]
fn kill_session(name: String) -> Result<(), String> {
    let exact = format!("={}", name);
    run_check(&["tmux", "kill-session", "-t", &exact])?;
    Ok(())
}

/// A worktree directory is a real git worktree if it contains a `.git` entry
/// (a file for linked worktrees, a directory for a plain clone). Plain
/// subdirectories that merely live under the worktree base (e.g. a checked-out
/// repo's own `app/` or `src/`) have no `.git` and must not be treated as
/// worktrees, otherwise they pollute orphan recovery and risk wrong cleanup.
fn is_git_worktree_dir(path: &std::path::Path) -> bool {
    path.join(".git").exists()
}

/// Strip trailing `-{5 hex chars}` random suffix to recover session name.
fn derive_session_name(dirname: &str) -> String {
    let bytes = dirname.as_bytes();
    if bytes.len() > 6 && bytes[bytes.len() - 6] == b'-' {
        let suffix = &dirname[dirname.len() - 5..];
        if suffix.chars().all(|c| c.is_ascii_hexdigit()) {
            return dirname[..dirname.len() - 6].to_string();
        }
    }
    dirname.to_string()
}

#[tauri::command]
fn list_orphaned_worktrees() -> Result<Vec<OrphanedWorktree>, String> {
    let home = app_home_dir().ok_or("home dir not found")?;
    let config_path = home.join(".tmux-worktree.json");
    let config: serde_json::Value = if config_path.exists() {
        let text =
            std::fs::read_to_string(&config_path).map_err(|e| format!("read config: {e}"))?;
        serde_json::from_str(&text).map_err(|e| format!("parse config: {e}"))?
    } else {
        return Ok(vec![]);
    };

    let worktree_base = config_worktree_base(&config)
        .unwrap_or_else(|| "/private/tmp/tmux-worktree/projects".to_string());

    let base_path = std::path::Path::new(&worktree_base);
    Ok(orphaned_worktrees(base_path, &live_session_names()))
}

#[derive(Deserialize)]
struct RestoreArgs {
    path: String,
    name: String,
    #[serde(rename = "aiCmd", default)]
    ai_cmd: String,
}

#[derive(Deserialize)]
struct DeleteWorktreeArgs {
    path: String,
    #[serde(default)]
    force: bool,
}

#[tauri::command]
fn restore_worktree(args: RestoreArgs) -> Result<String, String> {
    let dir = std::path::Path::new(&args.path);
    if !dir.exists() {
        return Err(format!("directory does not exist: {}", args.path));
    }

    let session = unique_session_name(&args.name);
    run_check(&[
        "tmux",
        "new-session",
        "-d",
        "-s",
        &session,
        "-c",
        &args.path,
    ])?;
    setup_clipboard_bindings();

    if !args.ai_cmd.is_empty() {
        run_check(&["tmux", "send-keys", "-t", &session, &args.ai_cmd, "C-m"])?;
    }

    remove_pending_cleanup_path(&args.path);

    Ok(session)
}

#[tauri::command]
fn delete_worktree(args: DeleteWorktreeArgs) -> Result<(), String> {
    if try_cleanup_worktree(&args.path, args.force) {
        remove_pending_cleanup_path(&args.path);
        return Ok(());
    }
    if args.force {
        Err(format!("failed to delete worktree: {}", args.path))
    } else {
        Err(format!("worktree has uncommitted changes: {}", args.path))
    }
}

#[tauri::command]
fn session_cwd(name: String) -> Result<String, String> {
    let exact = format!("={}", name);
    let fmt = "#{pane_active}\x1f#{pane_current_path}";
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

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut first_path: Option<String> = None;
    for line in stdout.lines() {
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
fn session_root(name: String) -> Result<String, String> {
    let fmt = "#{session_name}\x1f#{session_path}";
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

    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        let mut parts = line.splitn(2, '\x1f');
        let session_name = parts.next().unwrap_or_default();
        let path = parts.next().unwrap_or_default().trim();
        if session_name == name && !path.is_empty() {
            return Ok(path.to_string());
        }
    }

    session_cwd(name)
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

    let home = app_home_dir().ok_or("home dir not found")?;
    let config_path = home.join(".tmux-worktree.json");

    let mut config: serde_json::Value = if config_path.exists() {
        let text =
            std::fs::read_to_string(&config_path).map_err(|e| format!("read config: {e}"))?;
        serde_json::from_str(&text).map_err(|e| format!("parse config: {e}"))?
    } else {
        serde_json::json!({ "projects": {} })
    };

    let root = config
        .as_object_mut()
        .ok_or("config root is not an object")?;
    let projects_key = if root.contains_key("projects") {
        "projects"
    } else if root.contains_key("repositories") {
        "repositories"
    } else if root.contains_key("repos") {
        "repos"
    } else {
        "projects"
    };
    match root
        .entry(projects_key)
        .or_insert_with(|| serde_json::json!({}))
    {
        serde_json::Value::Object(projects) => {
            projects.insert(
                name.to_string(),
                serde_json::Value::String(path.to_string()),
            );
        }
        serde_json::Value::Array(projects) => {
            if let Some(existing) = projects.iter_mut().find(|item| {
                string_field(item, &["name", "key", "id", "label"]).as_deref() == Some(name)
            }) {
                *existing = serde_json::json!({ "name": name, "path": path });
            } else {
                projects.push(serde_json::json!({ "name": name, "path": path }));
            }
        }
        _ => return Err("projects is not an object or array".into()),
    }

    let pretty =
        serde_json::to_string_pretty(&config).map_err(|e| format!("serialize config: {e}"))?;
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

#[derive(Serialize, Clone)]
struct GitCommit {
    hash: String,
    short: String,
    parents: Vec<String>,
    subject: String,
    author: String,
    rel_time: String,
    refs: Vec<String>,
}

#[tauri::command]
fn git_log(cwd: String, limit: Option<u32>) -> Result<Vec<GitCommit>, String> {
    let inside = run_quiet(&["git", "-C", &cwd, "rev-parse", "--is-inside-work-tree"]);
    if inside.as_deref() != Some("true") {
        return Ok(vec![]);
    }

    let n = limit.unwrap_or(80).min(500);
    let n_str = n.to_string();
    let fmt = "%H\x1f%h\x1f%P\x1f%s\x1f%an\x1f%ar\x1f%D";
    let pretty = format!("--pretty=format:{}", fmt);
    let output = std::process::Command::new(git_bin())
        .args([
            "-C",
            &cwd,
            "log",
            "--all",
            "--topo-order",
            "--decorate=short",
            "-n",
            &n_str,
            &pretty,
        ])
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("does not have any commits yet") {
            return Ok(vec![]);
        }
        return Err(format!("git log failed: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let commits = stdout
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let mut parts = line.splitn(7, '\x1f');
            let hash = parts.next()?.to_string();
            let short = parts.next()?.to_string();
            let parents_raw = parts.next()?;
            let subject = parts.next()?.to_string();
            let author = parts.next()?.to_string();
            let rel_time = parts.next()?.to_string();
            let refs_raw = parts.next().unwrap_or("");
            let parents = if parents_raw.is_empty() {
                Vec::new()
            } else {
                parents_raw.split(' ').map(|s| s.to_string()).collect()
            };
            let refs = if refs_raw.is_empty() {
                Vec::new()
            } else {
                refs_raw.split(", ").map(|s| s.to_string()).collect()
            };
            Some(GitCommit {
                hash,
                short,
                parents,
                subject,
                author,
                rel_time,
                refs,
            })
        })
        .collect();

    Ok(commits)
}

#[tauri::command]
fn git_status(cwd: String) -> Result<Option<GitStatus>, String> {
    let inside = run_quiet(&["git", "-C", &cwd, "rev-parse", "--is-inside-work-tree"]);
    if inside.as_deref() != Some("true") {
        return Ok(None);
    }

    let output = std::process::Command::new(git_bin())
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
            let mut parts = rest.splitn(8, ' ');
            let xy = parts.next().unwrap_or("..");
            let path = parts.nth(6).unwrap_or("").to_string();
            let (x, y) = (
                xy.chars().next().unwrap_or('.'),
                xy.chars().nth(1).unwrap_or('.'),
            );
            if x != '.' {
                status.staged += 1;
            }
            if y != '.' {
                status.unstaged += 1;
            }
            status.files.push(GitFile {
                code: xy.to_string(),
                path,
            });
        } else if let Some(rest) = line.strip_prefix("2 ") {
            // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X-score> <path><tab><origPath>
            let mut parts = rest.splitn(9, ' ');
            let xy = parts.next().unwrap_or("..");
            let tail = parts.nth(7).unwrap_or("");
            let path = tail.split('\t').next().unwrap_or("").to_string();
            let (x, y) = (
                xy.chars().next().unwrap_or('.'),
                xy.chars().nth(1).unwrap_or('.'),
            );
            if x != '.' {
                status.staged += 1;
            }
            if y != '.' {
                status.unstaged += 1;
            }
            status.files.push(GitFile {
                code: xy.to_string(),
                path,
            });
        } else if let Some(rest) = line.strip_prefix("u ") {
            // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            let mut parts = rest.splitn(10, ' ');
            let xy = parts.next().unwrap_or("UU");
            let path = parts.nth(8).unwrap_or("").to_string();
            status.conflicts += 1;
            status.files.push(GitFile {
                code: xy.to_string(),
                path,
            });
        } else if let Some(rest) = line.strip_prefix("? ") {
            status.untracked += 1;
            status.files.push(GitFile {
                code: "??".to_string(),
                path: rest.to_string(),
            });
        }
    }

    Ok(Some(status))
}

#[tauri::command]
fn git_diff(cwd: String, path: String) -> Result<String, String> {
    // Try unstaged diff first
    let output = std::process::Command::new(git_bin())
        .args(["-C", &cwd, "diff", "--", &path])
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;

    let diff = String::from_utf8_lossy(&output.stdout).to_string();

    if !diff.trim().is_empty() {
        return Ok(diff);
    }

    // Try staged diff
    let output2 = std::process::Command::new(git_bin())
        .args(["-C", &cwd, "diff", "--cached", "--", &path])
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;

    let staged = String::from_utf8_lossy(&output2.stdout).to_string();

    if !staged.trim().is_empty() {
        return Ok(staged);
    }

    // For untracked files, show entire file as addition
    let full_path = std::path::Path::new(&cwd).join(&path);
    let full_path_str = full_path.to_string_lossy().to_string();
    let output3 = std::process::Command::new(git_bin())
        .args([
            "-C",
            &cwd,
            "diff",
            "--no-index",
            "/dev/null",
            &full_path_str,
        ])
        .output();

    if let Ok(o) = output3 {
        let untracked = String::from_utf8_lossy(&o.stdout).to_string();
        if !untracked.trim().is_empty() {
            return Ok(untracked);
        }
    }

    Ok(String::new())
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

    let resolved_cmd = resolve_cmd(&args.cmd);
    let mut cmd = CommandBuilder::new(resolved_cmd);
    for a in &args.args {
        cmd.arg(a);
    }
    if let Some(cwd) = args.cwd.as_ref() {
        cmd.cwd(cwd);
    } else if let Some(home) = app_home_dir() {
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
    state.ptys.lock().unwrap().insert(id.clone(), handle);

    let id_for_thread = id.clone();
    let app_for_thread = app.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let valid_up_to = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(e) => e.valid_up_to(),
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
        let code = handle
            .as_mut()
            .and_then(|h| h.child.wait().ok())
            .map(|s| s.exit_code() as i32)
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

#[tauri::command]
fn create_plain_terminal(cwd: String) -> Result<String, String> {
    let name = format!("tw-term-{}", random_id());
    run_check(&["tmux", "new-session", "-d", "-s", &name, "-c", &cwd])?;
    setup_clipboard_bindings();
    Ok(name)
}

#[tauri::command]
fn capture_pane_history(name: String) -> Result<String, String> {
    let exact = format!("={}", name);
    let output = std::process::Command::new(tmux_bin())
        .args([
            "capture-pane",
            "-p",
            "-e",
            "-J",
            "-S",
            "-5000",
            "-t",
            &exact,
        ])
        .output()
        .map_err(|e| format!("spawn tmux: {e}"))?;
    if !output.status.success() {
        return Ok(String::new());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let trimmed = text.trim_end_matches('\n');
    Ok(trimmed.to_string())
}

#[tauri::command]
fn ensure_terminal_session(name: String, cwd: String) -> Result<(), String> {
    if run_quiet(&["tmux", "has-session", "-t", &format!("={}", name)]).is_some() {
        return Ok(());
    }
    run_check(&["tmux", "new-session", "-d", "-s", &name, "-c", &cwd])?;
    setup_clipboard_bindings();
    Ok(())
}

#[tauri::command]
fn kill_plain_terminal(name: String) -> Result<(), String> {
    let _ = run_quiet(&["tmux", "kill-session", "-t", &format!("={}", name)]);
    Ok(())
}

fn terminals_path() -> std::path::PathBuf {
    app_home_dir_or_tmp().join(".tw-dashboard-terminals.json")
}

fn layout_path() -> std::path::PathBuf {
    app_home_dir_or_tmp().join(".tw-dashboard-layout.json")
}

#[derive(Deserialize)]
struct SavedWindowLayout {
    width: f64,
    height: f64,
    x: f64,
    y: f64,
    maximized: bool,
}

fn restore_window_layout(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let path = layout_path();
    if !path.exists() {
        return;
    }
    let Some(saved) = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value.get("window").cloned())
        .and_then(|value| serde_json::from_value::<SavedWindowLayout>(value).ok())
    else {
        return;
    };

    let _ = window.set_size(tauri::LogicalSize::new(
        saved.width.max(960.0),
        saved.height.max(600.0),
    ));
    let _ = window.set_position(tauri::LogicalPosition::new(saved.x, saved.y));
    if saved.maximized {
        let _ = window.maximize();
    }
}

#[tauri::command]
fn load_terminals() -> Result<Vec<serde_json::Value>, String> {
    let p = terminals_path();
    if !p.exists() {
        return Ok(vec![]);
    }
    let text = std::fs::read_to_string(&p).map_err(|e| format!("read: {e}"))?;
    let arr: Vec<serde_json::Value> =
        serde_json::from_str(&text).map_err(|e| format!("parse: {e}"))?;
    Ok(arr)
}

#[tauri::command]
fn save_terminals(terminals: Vec<serde_json::Value>) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&terminals).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(terminals_path(), text).map_err(|e| format!("write: {e}"))?;
    Ok(())
}

#[tauri::command]
fn load_layout() -> Result<serde_json::Value, String> {
    let p = layout_path();
    if !p.exists() {
        return Ok(serde_json::json!({}));
    }
    let text = std::fs::read_to_string(&p).map_err(|e| format!("read: {e}"))?;
    let val: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("parse: {e}"))?;
    Ok(val)
}

#[tauri::command]
fn home_dir() -> Result<String, String> {
    app_home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "home dir not found".into())
}

#[tauri::command]
fn save_layout(layout: serde_json::Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&layout).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(layout_path(), text).map_err(|e| format!("write: {e}"))?;
    Ok(())
}

#[tauri::command]
fn read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let dir = std::path::Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let rd = std::fs::read_dir(dir).map_err(|e| format!("read_dir: {e}"))?;
    let mut entries = Vec::new();
    for entry in rd {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let entry_path = entry.path().to_string_lossy().to_string();
        let is_symlink = std::fs::symlink_metadata(entry.path())
            .map(|m| m.is_symlink())
            .unwrap_or(false);
        let (is_dir, size) = match entry.metadata() {
            Ok(m) => (m.is_dir(), m.len()),
            Err(_) => continue,
        };
        let is_hidden = name.starts_with('.');
        entries.push(DirEntry {
            name,
            path: entry_path,
            is_dir,
            is_symlink,
            is_hidden,
            size,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    if !p.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let meta = std::fs::metadata(p).map_err(|e| format!("metadata: {e}"))?;
    if meta.len() > 5 * 1024 * 1024 {
        return Err("file too large (>5 MB)".into());
    }
    std::fs::read_to_string(p).map_err(|e| format!("read: {e}"))
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, &content).map_err(|e| format!("write: {e}"))
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("open url: {e}"))?;
    Ok(())
}

#[tauri::command]
fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[derive(Serialize, Clone)]
struct SearchResult {
    path: String,
    file_name: String,
    line_number: Option<usize>,
    line_content: Option<String>,
}

const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".DS_Store",
    "dist",
    "__pycache__",
    ".next",
    ".turbo",
];

fn walk_search(
    dir: &std::path::Path,
    query_lower: &str,
    mode: &str,
    root: &std::path::Path,
    results: &mut Vec<SearchResult>,
    limit: usize,
) {
    if results.len() >= limit {
        return;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        let path = entry.path();
        let is_dir = path.is_dir();
        if is_dir {
            dirs.push(path);
        } else {
            files.push((path, name));
        }
    }
    for (path, name) in files {
        if results.len() >= limit {
            return;
        }
        let rel_path = path.to_string_lossy().to_string();
        let file_name = name;
        if mode == "filename" {
            if file_name.to_lowercase().contains(query_lower) {
                results.push(SearchResult {
                    path: rel_path,
                    file_name,
                    line_number: None,
                    line_content: None,
                });
            }
        } else {
            // content mode
            let meta = match std::fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.len() > 1024 * 1024 {
                continue;
            }
            let text = match std::fs::read_to_string(&path) {
                Ok(t) => t,
                Err(_) => continue,
            };
            for (i, line) in text.lines().enumerate() {
                if results.len() >= limit {
                    return;
                }
                if line.to_lowercase().contains(query_lower) {
                    let trimmed = if line.len() > 200 { &line[..200] } else { line };
                    results.push(SearchResult {
                        path: rel_path.clone(),
                        file_name: file_name.clone(),
                        line_number: Some(i + 1),
                        line_content: Some(trimmed.to_string()),
                    });
                }
            }
        }
    }
    for d in dirs {
        if results.len() >= limit {
            return;
        }
        walk_search(&d, query_lower, mode, root, results, limit);
    }
}

#[tauri::command]
fn search_files(root: String, query: String, mode: String) -> Result<Vec<SearchResult>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let root_path = std::path::Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();
    walk_search(root_path, &query_lower, &mode, root_path, &mut results, 100);
    Ok(results)
}

// ── Remote tunnel (cloudflared) ──

fn read_serve_token() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let path = format!("{home}/.tw-serve-token");
    std::fs::read_to_string(&path)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn tcp_port_open(port: u16) -> bool {
    std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
}

fn executable_exists(path: &Path) -> bool {
    path.is_file()
}

fn which_cmd(name: &str) -> Option<String> {
    let output = std::process::Command::new("/usr/bin/which")
        .arg(name)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

fn first_existing_command(candidates: &[&str], name: &str) -> Option<String> {
    candidates
        .iter()
        .find(|path| executable_exists(Path::new(path)))
        .map(|path| path.to_string())
        .or_else(|| which_cmd(name))
}

fn node_bin() -> Option<String> {
    first_existing_command(
        &[
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ],
        "node",
    )
}

fn bundled_cli_candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(path) = std::env::var_os("TW_DASHBOARD_CLI").filter(|v| !v.is_empty()) {
        paths.push(PathBuf::from(path));
    }
    if let Ok(resources) = app.path().resource_dir() {
        paths.push(resources.join("tw-cli").join("cli.js"));
        paths.push(resources.join("dist").join("cli.js"));
        paths.push(resources.join("cli.js"));
    }
    paths.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../dist/cli.js"));
    paths
}

fn bundled_cli_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    bundled_cli_candidates(app)
        .into_iter()
        .find(|path| executable_exists(path))
}

fn installed_tw_command() -> Option<String> {
    first_existing_command(
        &[
            "/opt/homebrew/bin/tw",
            "/usr/local/bin/tw",
            "/opt/homebrew/bin/tmux-worktree",
            "/usr/local/bin/tmux-worktree",
        ],
        "tw",
    )
    .or_else(|| which_cmd("tmux-worktree"))
}

fn wait_for_serve(mut child: std::process::Child) -> Option<std::process::Child> {
    for _ in 0..40 {
        if tcp_port_open(8311) {
            return Some(child);
        }
        if matches!(child.try_wait(), Ok(Some(_))) {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    let _ = child.kill();
    let _ = child.wait();
    None
}

fn spawn_serve(app: &tauri::AppHandle) -> Result<std::process::Child, String> {
    let mut failures = Vec::new();

    if let Some(cli) = bundled_cli_path(app) {
        if let Some(node) = node_bin() {
            let cli_arg = cli.to_string_lossy().to_string();
            match std::process::Command::new(&node)
                .args([cli_arg.as_str(), "serve"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
            {
                Ok(child) => {
                    if let Some(child) = wait_for_serve(child) {
                        return Ok(child);
                    }
                    failures.push(format!(
                        "bundled CLI did not open port 8311: {}",
                        cli.display()
                    ));
                }
                Err(err) => failures.push(format!("spawn bundled CLI: {err}")),
            }
        } else {
            failures.push("Node.js not found for bundled CLI".to_string());
        }
    } else {
        failures.push("bundled CLI resource not found".to_string());
    }

    if let Some(tw) = installed_tw_command() {
        match std::process::Command::new(&tw)
            .arg("serve")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            Ok(child) => {
                if let Some(child) = wait_for_serve(child) {
                    return Ok(child);
                }
                failures.push(format!("installed tw did not open port 8311: {tw}"));
            }
            Err(err) => failures.push(format!("spawn installed tw: {err}")),
        }
    } else {
        failures.push("installed tw/tmux-worktree command not found".to_string());
    }

    Err(format!(
        "Failed to start remote serve backend. {}. Install Node.js 20+ or run `npm i -g @byted-codebase/tmux-worktree --registry=https://bnpm.byted.org`.",
        failures.join("; ")
    ))
}

fn managed_cloudflared_path() -> PathBuf {
    let base = if std::env::var_os("TW_DASHBOARD_HOME").is_some() {
        app_home_dir_or_tmp().join(".tw-dashboard")
    } else {
        dirs::data_local_dir()
            .unwrap_or_else(app_home_dir_or_tmp)
            .join("tw-dashboard")
    };
    base.join("bin").join("cloudflared")
}

fn find_cloudflared() -> Option<String> {
    let managed = managed_cloudflared_path();
    if executable_exists(&managed) {
        return Some(managed.to_string_lossy().to_string());
    }
    first_existing_command(
        &[
            "/opt/homebrew/bin/cloudflared",
            "/usr/local/bin/cloudflared",
            "/usr/bin/cloudflared",
        ],
        "cloudflared",
    )
}

fn download_cloudflared() -> Result<String, String> {
    if std::env::consts::OS != "macos" {
        return Err("automatic cloudflared download is only supported on macOS".into());
    }
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "amd64",
        other => return Err(format!("unsupported macOS arch for cloudflared: {other}")),
    };
    let url = format!(
        "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-{arch}.tgz"
    );
    let bin_path = managed_cloudflared_path();
    let bin_dir = bin_path
        .parent()
        .ok_or_else(|| "invalid managed cloudflared path".to_string())?;
    std::fs::create_dir_all(bin_dir).map_err(|e| format!("mkdir {}: {e}", bin_dir.display()))?;
    let archive = bin_dir.join(format!("cloudflared-darwin-{arch}.tgz"));
    let curl = first_existing_command(&["/usr/bin/curl", "/opt/homebrew/bin/curl"], "curl")
        .unwrap_or_else(|| "curl".to_string());
    let archive_arg = archive.to_string_lossy().to_string();
    let curl_output = std::process::Command::new(&curl)
        .args(["-fsSL", "--retry", "2", "-o", archive_arg.as_str(), &url])
        .output()
        .map_err(|e| format!("spawn curl: {e}"))?;
    if !curl_output.status.success() {
        return Err(format!(
            "download cloudflared failed: {}",
            String::from_utf8_lossy(&curl_output.stderr).trim()
        ));
    }

    let tar = first_existing_command(&["/usr/bin/tar"], "tar").unwrap_or_else(|| "tar".to_string());
    let bin_dir_arg = bin_dir.to_string_lossy().to_string();
    let tar_output = std::process::Command::new(&tar)
        .args(["-xzf", archive_arg.as_str(), "-C", bin_dir_arg.as_str()])
        .output()
        .map_err(|e| format!("spawn tar: {e}"))?;
    if !tar_output.status.success() {
        return Err(format!(
            "unpack cloudflared failed: {}",
            String::from_utf8_lossy(&tar_output.stderr).trim()
        ));
    }

    if !bin_path.exists() {
        return Err(format!(
            "cloudflared was not found after unpacking {}",
            archive.display()
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&bin_path)
            .map_err(|e| format!("metadata {}: {e}", bin_path.display()))?
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&bin_path, permissions)
            .map_err(|e| format!("chmod {}: {e}", bin_path.display()))?;
    }
    let _ = std::fs::remove_file(&archive);
    Ok(bin_path.to_string_lossy().to_string())
}

fn ensure_cloudflared() -> Result<String, String> {
    if let Some(path) = find_cloudflared() {
        return Ok(path);
    }
    download_cloudflared().map_err(|err| {
        format!(
            "Failed to prepare cloudflared automatically: {err}. You can also install it with `brew install cloudflared`."
        )
    })
}

fn set_tunnel_error(state: &TunnelState, message: Option<String>) {
    let mut last_error = state.last_error.lock().unwrap();
    *last_error = message;
}

fn stop_managed_serve(state: &TunnelState) {
    let mut serve_proc = state.serve_process.lock().unwrap();
    if let Some(ref mut child) = *serve_proc {
        let _ = child.kill();
        let _ = child.wait();
    }
    *serve_proc = None;
}

#[derive(Serialize, Clone)]
struct TunnelStatus {
    active: bool,
    url: Option<String>,
    token: String,
    error: Option<String>,
}

#[tauri::command]
fn remote_start(app: tauri::AppHandle, state: State<'_, Arc<TunnelState>>) -> Result<(), String> {
    set_tunnel_error(state.inner(), None);
    let mut proc = state.process.lock().unwrap();
    if proc.is_some() {
        return Ok(());
    }

    // Ensure serve process is running on port 8311
    if !tcp_port_open(8311) {
        let child = spawn_serve(&app).map_err(|err| {
            set_tunnel_error(state.inner(), Some(err.clone()));
            err
        })?;
        let mut serve = state.serve_process.lock().unwrap();
        *serve = Some(child);
    }

    // Read token from serve process
    let tok = read_serve_token();
    {
        let mut t = state.token.lock().unwrap();
        *t = tok;
    }

    let cf_bin = ensure_cloudflared().map_err(|err| {
        set_tunnel_error(state.inner(), Some(err.clone()));
        stop_managed_serve(state.inner());
        err
    })?;

    let mut child = std::process::Command::new(&cf_bin)
        .args(["tunnel", "--url", "http://localhost:8311"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            let message = format!("Failed to start cloudflared: {e}");
            set_tunnel_error(state.inner(), Some(message.clone()));
            stop_managed_serve(state.inner());
            message
        })?;

    // Take stderr before storing child
    let stderr = child.stderr.take();
    *proc = Some(child);
    drop(proc);

    // Spawn a thread to read stderr and capture the URL
    if let Some(stderr) = stderr {
        let tunnel_state = Arc::clone(state.inner());
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stderr);
            let mut found = false;
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                if !found {
                    if let Some(start) = line.find("https://") {
                        let rest = &line[start..];
                        if rest.contains(".trycloudflare.com") {
                            let end = rest.find(|c: char| c.is_whitespace()).unwrap_or(rest.len());
                            let url = &rest[..end];
                            let mut u = tunnel_state.url.lock().unwrap();
                            *u = Some(url.to_string());
                            found = true;
                        }
                    }
                }
                // Keep draining stderr so cloudflared doesn't get SIGPIPE
            }
        });
    }

    Ok(())
}

#[tauri::command]
fn remote_stop(state: State<'_, Arc<TunnelState>>) -> Result<(), String> {
    let mut proc = state.process.lock().unwrap();
    if let Some(ref mut child) = *proc {
        let _ = child.kill();
        let _ = child.wait();
    }
    *proc = None;
    stop_managed_serve(state.inner());
    let mut url = state.url.lock().unwrap();
    *url = None;
    set_tunnel_error(state.inner(), None);
    Ok(())
}

#[tauri::command]
fn remote_status(state: State<'_, Arc<TunnelState>>) -> TunnelStatus {
    let mut proc = state.process.lock().unwrap();
    // Check if process has exited
    if let Some(ref mut child) = *proc {
        match child.try_wait() {
            Ok(Some(_)) => {
                // Process exited, clean up
                *proc = None;
                let mut url = state.url.lock().unwrap();
                *url = None;
                let token = state.token.lock().unwrap();
                let error = state.last_error.lock().unwrap();
                return TunnelStatus {
                    active: false,
                    url: None,
                    token: token.clone(),
                    error: error.clone(),
                };
            }
            _ => {}
        }
    }
    let url = state.url.lock().unwrap();
    let token = state.token.lock().unwrap();
    let error = state.last_error.lock().unwrap();
    TunnelStatus {
        active: proc.is_some(),
        url: url.clone(),
        token: token.clone(),
        error: error.clone(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    inherit_shell_env();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(Arc::new(PtyState::default()));
            app.manage(Arc::new(TunnelState::default()));
            setup_clipboard_bindings();
            restore_window_layout(&app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            tmux_session_exists,
            list_projects,
            add_project,
            create_worktree,
            kill_session,
            list_orphaned_worktrees,
            restore_worktree,
            delete_worktree,
            session_cwd,
            session_root,
            cancel_copy_mode,
            copy_tmux_selection,
            capture_pane_history,
            git_status,
            git_log,
            git_diff,
            create_plain_terminal,
            ensure_terminal_session,
            kill_plain_terminal,
            load_terminals,
            save_terminals,
            load_layout,
            save_layout,
            home_dir,
            pty_open,
            pty_write,
            pty_resize,
            pty_kill,
            read_dir,
            read_file,
            write_file,
            search_files,
            open_url,
            file_exists,
            remote_start,
            remote_stop,
            remote_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_, event| match event {
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                cleanup_pending_worktrees();
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::{
        cleanup_pending_worktrees, config_worktree_base, delete_worktree, derive_session_name,
        is_git_worktree_dir, kill_session, load_pending_cleanup, orphaned_worktrees,
        project_from_config, projects_from_config, save_pending_cleanup, try_cleanup_worktree,
        worktrees_for_session, DeleteWorktreeArgs, OrphanedWorktree,
    };
    use std::collections::HashSet;
    use std::fs;
    use std::path::Path;
    use std::sync::{Mutex, OnceLock};

    fn test_env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn git(args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .status()
            .expect("spawn git");
        assert!(status.success(), "git command failed: {:?}", args);
    }

    #[test]
    fn derive_session_name_strips_random_suffix() {
        assert_eq!(derive_session_name("demo-abc12"), "demo");
        assert_eq!(derive_session_name("demo"), "demo");
        assert_eq!(derive_session_name("demo-nothex"), "demo-nothex");
    }

    #[test]
    fn config_parses_legacy_string_projects() {
        let config = serde_json::json!({
            "projects": {
                "frontend": "/repo/frontend"
            },
            "worktreeBase": "/tmp/tw"
        });

        let projects = projects_from_config(&config);
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "frontend");
        assert_eq!(projects[0].path, "/repo/frontend");
        assert_eq!(projects[0].branch, None);
        assert_eq!(config_worktree_base(&config).as_deref(), Some("/tmp/tw"));
    }

    #[test]
    fn config_parses_object_projects_with_aliases() {
        let config = serde_json::json!({
            "repositories": {
                "api": {
                    "repoPath": "/repo/api",
                    "target_branch": "develop"
                }
            },
            "worktreeRoot": "/tmp/worktrees"
        });

        let project = project_from_config(&config, "api").expect("project");
        assert_eq!(project.path, "/repo/api");
        assert_eq!(project.branch.as_deref(), Some("develop"));
        assert_eq!(
            config_worktree_base(&config).as_deref(),
            Some("/tmp/worktrees")
        );
    }

    #[test]
    fn config_parses_array_projects() {
        let config = serde_json::json!({
            "projects": [
                { "key": "web", "directory": "/repo/web", "defaultBranch": "main" }
            ]
        });

        let project = project_from_config(&config, "web").expect("project");
        assert_eq!(project.name, "web");
        assert_eq!(project.path, "/repo/web");
        assert_eq!(project.branch.as_deref(), Some("main"));
    }

    #[test]
    fn orphaned_worktrees_excludes_live_sessions() {
        let temp = tempfile::tempdir().expect("tempdir");
        let project_dir = temp.path().join("proj");
        fs::create_dir_all(project_dir.join("live-abc12")).expect("create live");
        fs::write(project_dir.join("live-abc12").join(".git"), "gitdir: x").expect("live .git");
        fs::create_dir_all(project_dir.join("orphan-def34")).expect("create orphan");
        fs::write(project_dir.join("orphan-def34").join(".git"), "gitdir: x").expect("orphan .git");
        // A plain subdirectory without `.git` (e.g. a checked-out repo's own
        // `src/`) must NOT be treated as a worktree.
        fs::create_dir_all(project_dir.join("src")).expect("create src");
        fs::write(project_dir.join("README.txt"), "ignore").expect("write file");

        let live_sessions = HashSet::from([String::from("live")]);
        let mut orphans = orphaned_worktrees(temp.path(), &live_sessions);
        orphans.sort_by(|a, b| a.name.cmp(&b.name));

        assert_eq!(orphans.len(), 1);
        assert_eq!(orphans[0].project, "proj");
        assert_eq!(orphans[0].name, "orphan");
        assert!(orphans[0].path.ends_with("/proj/orphan-def34"));
    }

    #[test]
    fn worktrees_for_session_returns_only_matching_session() {
        let temp = tempfile::tempdir().expect("tempdir");
        let project_dir = temp.path().join("proj");
        fs::create_dir_all(project_dir.join("demo-abc12")).expect("create demo");
        fs::write(project_dir.join("demo-abc12").join(".git"), "gitdir: x").expect("demo .git");
        fs::create_dir_all(project_dir.join("other-def34")).expect("create other");
        fs::write(project_dir.join("other-def34").join(".git"), "gitdir: x").expect("other .git");

        let matches = worktrees_for_session(temp.path(), "demo");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].project, "proj");
        assert_eq!(matches[0].name, "demo");
        assert!(matches[0].path.ends_with("/proj/demo-abc12"));
    }

    #[test]
    fn is_git_worktree_dir_requires_git_entry() {
        let temp = tempfile::tempdir().expect("tempdir");
        // Linked worktree: `.git` is a file.
        let linked = temp.path().join("linked");
        fs::create_dir_all(&linked).expect("linked");
        fs::write(linked.join(".git"), "gitdir: /repo/.git/worktrees/linked").expect("git file");
        assert!(is_git_worktree_dir(&linked));

        // Plain clone: `.git` is a directory.
        let clone = temp.path().join("clone");
        fs::create_dir_all(clone.join(".git")).expect("git dir");
        assert!(is_git_worktree_dir(&clone));

        // Plain subdirectory: no `.git`.
        let plain = temp.path().join("src");
        fs::create_dir_all(&plain).expect("plain");
        assert!(!is_git_worktree_dir(&plain));
    }

    #[test]
    fn try_cleanup_worktree_refuses_dirty_without_force() {
        let temp = tempfile::tempdir().expect("tempdir");
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).expect("repo");
        git(&["init", repo.to_str().expect("repo str")]);
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "config",
            "user.name",
            "test",
        ]);
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "config",
            "user.email",
            "test@example.com",
        ]);
        fs::write(repo.join("README.md"), "hello\n").expect("write repo file");
        git(&["-C", repo.to_str().expect("repo str"), "add", "README.md"]);
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "commit",
            "-m",
            "init",
        ]);

        let worktree = temp.path().join("wt-dirty");
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "worktree",
            "add",
            "-b",
            "dirty-branch",
            worktree.to_str().expect("worktree str"),
        ]);
        fs::write(worktree.join("dirty.txt"), "uncommitted\n").expect("dirty file");

        let path = worktree.to_string_lossy().to_string();
        assert!(!try_cleanup_worktree(&path, false));
        assert!(Path::new(&worktree).exists());
        assert!(try_cleanup_worktree(&path, true));
        assert!(!Path::new(&worktree).exists());
    }

    #[test]
    fn kill_session_does_not_register_worktree_for_cleanup() {
        let _guard = test_env_lock().lock().expect("lock");
        let original_home = std::env::var("HOME").ok();
        let original_tw_home = std::env::var("TW_DASHBOARD_HOME").ok();

        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("home");
        let base = temp.path().join("worktrees");
        fs::create_dir_all(&home).expect("home");
        fs::create_dir_all(&base).expect("base");
        fs::write(
            home.join(".tmux-worktree.json"),
            serde_json::json!({ "projects": {}, "worktreeBase": base }).to_string(),
        )
        .expect("config");

        let session = format!("tw-test-{}", uuid::Uuid::new_v4().simple());
        let session: String = session.chars().take(20).collect();
        let worktree = base.join("demo").join(format!("{session}-abc12"));
        fs::create_dir_all(&worktree).expect("worktree");
        fs::write(worktree.join(".git"), "gitdir: /not/a/repo").expect(".git");

        unsafe {
            std::env::set_var("HOME", &home);
            std::env::set_var("TW_DASHBOARD_HOME", &home);
        }

        git(&["init", temp.path().join("repo").to_str().expect("repo str")]);
        let tmux_status = std::process::Command::new("tmux")
            .args([
                "new-session",
                "-d",
                "-s",
                &session,
                "-c",
                temp.path().to_str().expect("temp path"),
            ])
            .status()
            .expect("spawn tmux");
        assert!(tmux_status.success(), "tmux new-session failed");

        kill_session(session.clone()).expect("kill session");
        std::thread::sleep(std::time::Duration::from_millis(300));

        assert!(load_pending_cleanup().is_empty());

        let _ = std::process::Command::new("tmux")
            .args(["kill-session", "-t", &format!("={session}")])
            .status();
        if let Some(home) = original_home {
            unsafe {
                std::env::set_var("HOME", home);
            }
        } else {
            unsafe {
                std::env::remove_var("HOME");
            }
        }
        if let Some(home) = original_tw_home {
            unsafe {
                std::env::set_var("TW_DASHBOARD_HOME", home);
            }
        } else {
            unsafe {
                std::env::remove_var("TW_DASHBOARD_HOME");
            }
        }
    }

    #[test]
    fn delete_worktree_requires_force_for_dirty_worktree() {
        let _guard = test_env_lock().lock().expect("lock");
        let original_home = std::env::var("HOME").ok();
        let original_tw_home = std::env::var("TW_DASHBOARD_HOME").ok();

        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("home");
        fs::create_dir_all(&home).expect("home");
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).expect("repo");
        git(&["init", repo.to_str().expect("repo str")]);
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "config",
            "user.name",
            "test",
        ]);
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "config",
            "user.email",
            "test@example.com",
        ]);
        fs::write(repo.join("README.md"), "hello\n").expect("write repo file");
        git(&["-C", repo.to_str().expect("repo str"), "add", "README.md"]);
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "commit",
            "-m",
            "init",
        ]);
        let worktree = temp.path().join("wt-delete-dirty");
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "worktree",
            "add",
            "-b",
            "delete-dirty",
            worktree.to_str().expect("worktree str"),
        ]);
        fs::write(worktree.join("dirty.txt"), "uncommitted\n").expect("dirty file");

        unsafe {
            std::env::set_var("HOME", &home);
            std::env::set_var("TW_DASHBOARD_HOME", &home);
        }
        let path = worktree.to_string_lossy().to_string();
        save_pending_cleanup(&[OrphanedWorktree {
            project: "demo".to_string(),
            path: path.clone(),
            name: "delete-dirty".to_string(),
        }]);

        let err = delete_worktree(DeleteWorktreeArgs {
            path: path.clone(),
            force: false,
        })
        .expect_err("dirty delete should require force");
        assert!(err.contains("uncommitted changes"));
        assert!(Path::new(&worktree).exists());
        assert_eq!(load_pending_cleanup().len(), 1);

        delete_worktree(DeleteWorktreeArgs {
            path: path.clone(),
            force: true,
        })
        .expect("forced delete");
        assert!(!Path::new(&worktree).exists());
        assert!(load_pending_cleanup().is_empty());

        if let Some(home) = original_home {
            unsafe {
                std::env::set_var("HOME", home);
            }
        } else {
            unsafe {
                std::env::remove_var("HOME");
            }
        }
        if let Some(home) = original_tw_home {
            unsafe {
                std::env::set_var("TW_DASHBOARD_HOME", home);
            }
        } else {
            unsafe {
                std::env::remove_var("TW_DASHBOARD_HOME");
            }
        }
    }

    #[test]
    fn cleanup_pending_worktrees_removes_registered_worktree() {
        let _guard = test_env_lock().lock().expect("lock");
        let original_home = std::env::var("HOME").ok();

        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("home");
        fs::create_dir_all(&home).expect("home");

        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).expect("repo");
        git(&["init", repo.to_str().expect("repo str")]);
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "config",
            "user.name",
            "test",
        ]);
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "config",
            "user.email",
            "test@example.com",
        ]);
        fs::write(repo.join("README.md"), "hello\n").expect("write repo file");
        git(&["-C", repo.to_str().expect("repo str"), "add", "README.md"]);
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "commit",
            "-m",
            "init",
        ]);

        let worktree = temp.path().join("wt-cleanup");
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "worktree",
            "add",
            "-b",
            "ghost-branch",
            worktree.to_str().expect("worktree str"),
        ]);

        unsafe {
            std::env::set_var("HOME", &home);
        }
        save_pending_cleanup(&[OrphanedWorktree {
            project: "demo".to_string(),
            path: worktree.to_string_lossy().to_string(),
            name: "ghost".to_string(),
        }]);

        cleanup_pending_worktrees();

        assert!(!Path::new(&worktree).exists());
        assert!(load_pending_cleanup().is_empty());
        let list = std::process::Command::new("git")
            .args([
                "-C",
                repo.to_str().expect("repo str"),
                "worktree",
                "list",
                "--porcelain",
            ])
            .output()
            .expect("git worktree list");
        let stdout = String::from_utf8_lossy(&list.stdout);
        assert!(!stdout.contains("wt-cleanup"));

        if let Some(home) = original_home {
            unsafe {
                std::env::set_var("HOME", home);
            }
        } else {
            unsafe {
                std::env::remove_var("HOME");
            }
        }
    }
}
