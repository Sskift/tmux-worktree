use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::net::ToSocketAddrs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
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

fn dashboard_config_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn dashboard_layout_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn atomic_write_file_with<F>(path: &Path, contents: &[u8], before_rename: F) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("invalid file path: {}", path.display()))?;
    let temp_path = parent.join(format!(
        ".{file_name}.tmp-{}",
        uuid::Uuid::new_v4().simple()
    ));

    let result = (|| -> Result<(), String> {
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp_path)
            .map_err(|err| format!("create {}: {err}", temp_path.display()))?;
        file.write_all(contents)
            .map_err(|err| format!("write {}: {err}", temp_path.display()))?;
        file.flush()
            .map_err(|err| format!("flush {}: {err}", temp_path.display()))?;
        file.sync_all()
            .map_err(|err| format!("sync {}: {err}", temp_path.display()))?;
        drop(file);

        before_rename(&temp_path)?;
        std::fs::rename(&temp_path, path).map_err(|err| {
            format!(
                "rename {} to {}: {err}",
                temp_path.display(),
                path.display()
            )
        })?;
        if let Ok(directory) = std::fs::File::open(parent) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    result
}

fn atomic_write_file(path: &Path, contents: &[u8]) -> Result<(), String> {
    atomic_write_file_with(path, contents, |_| Ok(()))
}

fn expand_home_path_with_home(value: &str, home: &str) -> String {
    let trimmed = value.trim();
    if trimmed == "~" {
        return home.to_string();
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        return Path::new(home).join(rest).to_string_lossy().to_string();
    }
    trimmed.to_string()
}

fn expand_home_path(value: &str) -> String {
    let home = app_home_dir_or_tmp().to_string_lossy().to_string();
    expand_home_path_with_home(value, &home)
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
    output_signature: Option<String>,
    agent_running: Option<bool>,
    #[serde(default, rename = "hostId")]
    host_id: Option<String>,
    #[serde(default, rename = "rawName")]
    raw_name: String,
    #[serde(default)]
    project: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct HostConfig {
    id: String,
    label: String,
    host: String,
    user: Option<String>,
    port: Option<u16>,
    identity_file: Option<String>,
    #[serde(default)]
    worktree_base: Option<String>,
    #[serde(default)]
    tmux_path: Option<String>,
    #[serde(default)]
    tw_path: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HostStatus {
    id: String,
    label: String,
    reachable: bool,
    latency_ms: Option<u64>,
    error: Option<String>,
    tw_available: bool,
    tw_version: Option<String>,
    tw_error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TmuxTerminal {
    id: String,
    label: String,
    cwd: String,
    tmux_name: String,
    host_id: Option<String>,
    raw_name: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CreatedTerminal {
    tmux_name: String,
    host_id: Option<String>,
    raw_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TwRpcListResponse {
    protocol_version: u32,
    sessions: Vec<TwRpcSession>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TwRpcSession {
    name: String,
    kind: String,
    #[serde(default)]
    project: Option<String>,
    attached: bool,
    windows: u32,
    created: u64,
    activity: u64,
    #[serde(default)]
    cwd: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TwRpcCreateWorktreeResponse {
    protocol_version: u32,
    session: String,
}

#[derive(Clone, Default)]
struct RemoteSessionActivitySample {
    output_signature: Option<String>,
    agent_running: Option<bool>,
}

struct CachedHostStatus {
    status: HostStatus,
    checked_at: Instant,
}

#[derive(Default)]
struct HostState {
    statuses: Mutex<HashMap<String, CachedHostStatus>>,
}

#[derive(Serialize, Clone)]
struct Project {
    name: String,
    path: String,
    branch: Option<String>,
}

const GIT_FETCH_INTERVAL_SECONDS: u64 = 5 * 60;

#[derive(Default)]
struct GitFetchTracker {
    last_started: HashMap<String, u64>,
    in_flight: HashSet<String>,
}

#[derive(Default)]
struct GitFetchState {
    tracker: Mutex<GitFetchTracker>,
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

struct MobileRelayState {
    process: Mutex<Option<std::process::Child>>,
    serve_process: Mutex<Option<std::process::Child>>,
    relay_url: Mutex<String>,
    host_id: Mutex<String>,
    secret: Mutex<String>,
    token: Mutex<String>,
    last_error: Mutex<Option<String>>,
}

impl Default for MobileRelayState {
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
            serve_process: Mutex::new(None),
            relay_url: Mutex::new("wss://relay.example.com".to_string()),
            host_id: Mutex::new("mac-admin".to_string()),
            secret: Mutex::new(String::new()),
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
    id: Option<String>,
    cmd: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    env: Option<HashMap<String, String>>,
}

#[derive(Deserialize)]
struct CreateTerminalArgs {
    cwd: String,
    #[serde(rename = "aiCmd")]
    ai_cmd: String,
    #[serde(rename = "hostId", default)]
    host_id: Option<String>,
}

#[derive(Deserialize)]
struct EnsureTerminalArgs {
    name: String,
    cwd: String,
    #[serde(rename = "aiCmd", default)]
    ai_cmd: Option<String>,
    #[serde(rename = "hostId", default)]
    host_id: Option<String>,
    #[serde(rename = "rawName", default)]
    raw_name: Option<String>,
}

#[tauri::command]
async fn list_sessions() -> Result<Vec<Session>, String> {
    tauri::async_runtime::spawn_blocking(list_sessions_blocking)
        .await
        .map_err(|e| format!("list sessions task failed: {e}"))?
}

fn list_sessions_blocking() -> Result<Vec<Session>, String> {
    let mut all = list_local_sessions()?;
    let hosts = load_hosts().unwrap_or_default();
    for host in &hosts {
        if let Ok(sessions) = list_remote_sessions(host) {
            all.extend(sessions);
        }
    }
    Ok(all)
}

fn trimmed_non_empty_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn local_managed_projects_by_session() -> HashMap<String, String> {
    let path = app_home_dir_or_tmp()
        .join(".tmux-worktree")
        .join("state.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return HashMap::new();
    };
    let Some(sessions) = value.get("sessions").and_then(|value| value.as_array()) else {
        return HashMap::new();
    };
    sessions
        .iter()
        .filter_map(|session| {
            let name = session.get("name")?.as_str()?;
            let project = session.get("project")?.as_str()?;
            Some((name.to_string(), trimmed_non_empty_string(project)?))
        })
        .collect()
}

fn project_from_worktree_path(path: &str, worktree_base: &str) -> Option<String> {
    let normalized = path.trim_end_matches('/');
    let base = worktree_base.trim_end_matches('/');
    if !base.is_empty() {
        let prefix = format!("{base}/");
        if let Some(rest) = normalized.strip_prefix(&prefix) {
            return rest.split('/').next().and_then(trimmed_non_empty_string);
        }
    }

    let marker = "/.tmux-worktree/worktrees/";
    normalized
        .split_once(marker)
        .and_then(|(_, rest)| rest.split('/').next())
        .and_then(trimmed_non_empty_string)
}

fn list_local_sessions() -> Result<Vec<Session>, String> {
    let config_path = app_home_dir_or_tmp().join(".tmux-worktree.json");
    let worktree_base = std::fs::read_to_string(&config_path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|config| config_worktree_base(&config))
        .unwrap_or_else(|| "/private/tmp/tmux-worktree/projects".to_string());
    let managed_projects = local_managed_projects_by_session();
    let fmt = "#{session_id}\x1f#{session_name}\x1f#{session_attached}\x1f#{session_windows}\x1f#{session_created}\x1f#{session_activity}\x1f#{pane_current_path}";
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
            let session_id = parts.next()?.to_string();
            let name = parts.next()?.to_string();
            if name.starts_with("tw-term-") || name.starts_with("tw-mobile-") {
                return None;
            }
            if !local_tmux_session_is_worktree(&name) {
                return None;
            }
            let attached = parts.next()? == "1";
            let window_count = parts.next()?.parse().ok()?;
            let created = parts.next()?.parse().ok()?;
            let activity = parts.next()?.parse().ok()?;
            let cwd = parts.next()?.to_string();
            if !is_managed_worktree_session(&name, &cwd, &worktree_base) {
                return None;
            }
            let output_signature = pane_output_signature(&session_id);
            let agent_running = session_agent_running(&session_id);
            let project = managed_projects
                .get(&name)
                .cloned()
                .or_else(|| project_from_worktree_path(&cwd, &worktree_base));
            Some(Session {
                name: name.clone(),
                attached,
                window_count,
                created,
                activity,
                output_signature,
                agent_running,
                host_id: None,
                raw_name: name,
                project,
            })
        })
        .collect();

    Ok(sessions)
}

fn list_remote_sessions(host: &HostConfig) -> Result<Vec<Session>, String> {
    if let Ok(sessions) = list_remote_sessions_from_tw_rpc(host) {
        return Ok(sessions);
    }
    list_remote_sessions_via_tmux(host)
}

fn list_remote_sessions_from_tw_rpc(host: &HostConfig) -> Result<Vec<Session>, String> {
    let response = remote_tw_rpc_list(host)?;
    let sessions = response
        .sessions
        .into_iter()
        .filter(|session| session.kind == "worktree")
        .collect::<Vec<_>>();
    let raw_names = sessions
        .iter()
        .map(|session| session.name.clone())
        .collect::<Vec<_>>();
    let activity_samples = remote_session_activity_samples(host, &raw_names).unwrap_or_default();

    Ok(sessions
        .into_iter()
        .map(|session| {
            let composite_name = format!("{}:{}", host.id, session.name);
            let activity = activity_samples
                .get(&session.name)
                .cloned()
                .unwrap_or_default();
            Session {
                name: composite_name,
                attached: session.attached,
                window_count: session.windows,
                created: session.created,
                activity: session.activity,
                output_signature: activity.output_signature,
                agent_running: activity.agent_running,
                host_id: Some(host.id.clone()),
                raw_name: session.name,
                project: session
                    .project
                    .and_then(|project| trimmed_non_empty_string(&project)),
            }
        })
        .collect())
}

fn remote_tw_rpc_list(host: &HostConfig) -> Result<TwRpcListResponse, String> {
    let output = run_remote_tw_check(host, &["rpc", "list"])?;
    let response: TwRpcListResponse =
        serde_json::from_str(&output).map_err(|e| format!("parse tw rpc list: {e}"))?;
    if response.protocol_version != 1 {
        return Err(format!(
            "unsupported tw rpc protocol: {}",
            response.protocol_version
        ));
    }
    Ok(response)
}

fn list_remote_sessions_via_tmux(host: &HostConfig) -> Result<Vec<Session>, String> {
    let fmt = "#{session_name}\x1f#{session_attached}\x1f#{session_windows}\x1f#{session_created}\x1f#{session_activity}";
    let output = run_remote_tmux_check(host, &["list-sessions", "-F", fmt])?;
    let remote_worktree_base = host
        .worktree_base
        .as_deref()
        .unwrap_or("/tmp/tmux-worktree/projects")
        .to_string();

    let rows = output
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let mut parts = line.split('\x1f');
            let raw_name = parts.next()?.to_string();
            if raw_name.starts_with("tw-term-") || raw_name.starts_with("tw-mobile-") {
                return None;
            }
            if !remote_tmux_session_is_worktree(host, &raw_name) {
                return None;
            }
            let attached = parts.next()? == "1";
            let window_count = parts.next()?.parse().ok()?;
            let created = parts.next()?.parse().ok()?;
            let activity = parts.next()?.parse().ok()?;
            Some((raw_name, attached, window_count, created, activity))
        })
        .collect::<Vec<_>>();
    let raw_names = rows
        .iter()
        .map(|(raw_name, _, _, _, _)| raw_name.clone())
        .collect::<Vec<_>>();
    let activity_samples = remote_session_activity_samples(host, &raw_names).unwrap_or_default();

    let sessions = rows
        .into_iter()
        .map(|(raw_name, attached, window_count, created, activity)| {
            let activity_sample = activity_samples.get(&raw_name).cloned().unwrap_or_default();
            let composite_name = format!("{}:{}", host.id, raw_name);
            let project = remote_session_active_cwd(host, &raw_name)
                .and_then(|cwd| remote_git_root(host, &cwd))
                .and_then(|git_root| project_from_worktree_path(&git_root, &remote_worktree_base));
            Session {
                name: composite_name,
                attached,
                window_count,
                created,
                activity,
                output_signature: activity_sample.output_signature,
                agent_running: activity_sample.agent_running,
                host_id: Some(host.id.clone()),
                raw_name,
                project,
            }
        })
        .collect();

    Ok(sessions)
}

fn remote_session_activity_samples(
    host: &HostConfig,
    raw_names: &[String],
) -> Result<HashMap<String, RemoteSessionActivitySample>, String> {
    if raw_names.is_empty() {
        return Ok(HashMap::new());
    }
    let script = r##"for session do
  target="=$session:"
  signature=$(tmux capture-pane -p -e -J -S -200 -t "$target" 2>/dev/null | cksum | awk '{print $1 ":" $2}')
  title=$(tmux display-message -p -t "$target" "#{pane_title}" 2>/dev/null || true)
  printf '%s\037%s\037%s\n' "$session" "$signature" "$title"
done"##;
    let mut remote_cmd = vec![
        "sh".to_string(),
        "-c".to_string(),
        script.to_string(),
        "sh".to_string(),
    ];
    remote_cmd.extend(raw_names.iter().cloned());
    let output = run_remote_cmd_check_strings(host, &remote_cmd)?;
    let mut samples = HashMap::new();
    for line in output.lines().filter(|line| !line.is_empty()) {
        let mut parts = line.splitn(3, '\x1f');
        let Some(raw_name) = parts.next().map(str::trim).filter(|name| !name.is_empty()) else {
            continue;
        };
        let output_signature = parts
            .next()
            .map(str::trim)
            .filter(|signature| !signature.is_empty())
            .map(|signature| format!("remote:{signature}"));
        let agent_running = parts.next().map(agent_running_from_pane_title);
        samples.insert(
            raw_name.to_string(),
            RemoteSessionActivitySample {
                output_signature,
                agent_running,
            },
        );
    }
    Ok(samples)
}

fn tmux_list_sessions_fmt() -> &'static str {
    "#{session_name}\x1f#{session_attached}\x1f#{session_windows}\x1f#{session_created}\x1f#{session_activity}"
}

fn session_name_matches_git_root(session_name: &str, git_root: &str) -> bool {
    let Some(dirname) = std::path::Path::new(git_root)
        .file_name()
        .and_then(|name| name.to_str())
    else {
        return false;
    };
    derive_session_name(dirname) == session_name
}

fn tmux_session_pane_target(raw_name: &str) -> String {
    format!("={}:", raw_name)
}

fn local_session_active_cwd(raw_name: &str) -> Option<String> {
    let target = tmux_session_pane_target(raw_name);
    run_quiet(&[
        "tmux",
        "display-message",
        "-p",
        "-t",
        &target,
        "#{pane_current_path}",
    ])
}

fn remote_session_active_cwd(host: &HostConfig, raw_name: &str) -> Option<String> {
    let target = tmux_session_pane_target(raw_name);
    run_remote_tmux_quiet(
        host,
        &[
            "display-message",
            "-p",
            "-t",
            &target,
            "#{pane_current_path}",
        ],
    )
}

fn local_git_root(cwd: &str) -> Option<String> {
    run_quiet(&["git", "-C", cwd, "rev-parse", "--show-toplevel"])
}

fn remote_git_root(host: &HostConfig, cwd: &str) -> Option<String> {
    run_remote_cmd_quiet(host, &["git", "-C", cwd, "rev-parse", "--show-toplevel"])
}

fn local_tmux_session_is_worktree(raw_name: &str) -> bool {
    let Some(cwd) = local_session_active_cwd(raw_name) else {
        return false;
    };
    let Some(git_root) = local_git_root(&cwd) else {
        return false;
    };
    session_name_matches_git_root(raw_name, &git_root)
}

fn remote_tmux_session_is_worktree(host: &HostConfig, raw_name: &str) -> bool {
    let Some(cwd) = remote_session_active_cwd(host, raw_name) else {
        return false;
    };
    let Some(git_root) = remote_git_root(host, &cwd) else {
        return false;
    };
    session_name_matches_git_root(raw_name, &git_root)
}

#[tauri::command]
async fn list_tmux_terminals() -> Result<Vec<TmuxTerminal>, String> {
    tauri::async_runtime::spawn_blocking(list_tmux_terminals_blocking)
        .await
        .map_err(|e| format!("list tmux terminals task failed: {e}"))?
}

fn list_tmux_terminals_blocking() -> Result<Vec<TmuxTerminal>, String> {
    let mut terminals = list_local_tmux_terminals()?;
    let hosts = load_hosts().unwrap_or_default();
    for host in &hosts {
        if let Ok(remote) = list_remote_tmux_terminals(host) {
            terminals.extend(remote);
        }
    }
    Ok(terminals)
}

fn list_local_tmux_terminals() -> Result<Vec<TmuxTerminal>, String> {
    let output = std::process::Command::new(tmux_bin())
        .args(["list-sessions", "-F", tmux_list_sessions_fmt()])
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
    Ok(stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\x1f');
            let raw_name = parts.next()?.to_string();
            if !raw_name.starts_with("tw-term-") || raw_name.starts_with("tw-mobile-") {
                return None;
            }
            if local_tmux_session_is_worktree(&raw_name) {
                return None;
            }
            let cwd = local_session_active_cwd(&raw_name).unwrap_or_default();
            Some(TmuxTerminal {
                id: format!("tmux:{}", raw_name),
                label: raw_name.clone(),
                cwd,
                tmux_name: raw_name.clone(),
                host_id: None,
                raw_name,
            })
        })
        .collect())
}

fn list_remote_tmux_terminals(host: &HostConfig) -> Result<Vec<TmuxTerminal>, String> {
    if let Ok(terminals) = list_remote_tmux_terminals_from_tw_rpc(host) {
        return Ok(terminals);
    }
    list_remote_tmux_terminals_via_tmux(host)
}

fn list_remote_tmux_terminals_from_tw_rpc(host: &HostConfig) -> Result<Vec<TmuxTerminal>, String> {
    let response = remote_tw_rpc_list(host)?;
    Ok(response
        .sessions
        .into_iter()
        .filter(|session| session.kind == "terminal")
        .map(|session| {
            let raw_name = session.name;
            TmuxTerminal {
                id: format!("ssh:{}:{}", host.id, raw_name),
                label: raw_name.clone(),
                cwd: session.cwd.unwrap_or_default(),
                tmux_name: format!("{}:{}", host.id, raw_name),
                host_id: Some(host.id.clone()),
                raw_name,
            }
        })
        .collect())
}

fn list_remote_tmux_terminals_via_tmux(host: &HostConfig) -> Result<Vec<TmuxTerminal>, String> {
    let output = run_remote_tmux_check(host, &["list-sessions", "-F", tmux_list_sessions_fmt()])?;
    Ok(output
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\x1f');
            let raw_name = parts.next()?.to_string();
            if !raw_name.starts_with("tw-term-") || raw_name.starts_with("tw-mobile-") {
                return None;
            }
            if remote_tmux_session_is_worktree(host, &raw_name) {
                return None;
            }
            let cwd = remote_session_active_cwd(host, &raw_name).unwrap_or_default();
            Some(TmuxTerminal {
                id: format!("ssh:{}:{}", host.id, raw_name),
                label: raw_name.clone(),
                cwd,
                tmux_name: format!("{}:{}", host.id, raw_name),
                host_id: Some(host.id.clone()),
                raw_name,
            })
        })
        .collect())
}

fn is_managed_worktree_session(name: &str, cwd: &str, worktree_base: &str) -> bool {
    if cwd.trim().is_empty() {
        return false;
    }
    let cwd_path = std::path::Path::new(cwd);
    if !is_git_worktree_dir(cwd_path) {
        return false;
    }

    let base = worktree_base.trim_end_matches('/');
    let under_base = cwd == base || cwd.starts_with(&format!("{base}/"));
    if !under_base && !cwd.contains("/.tmux-worktree/worktrees/") {
        return false;
    }

    let Some(dirname) = cwd_path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    tw_session_name_from_worktree_dir(dirname).is_some_and(|session_name| session_name == name)
}

fn pane_output_signature(name: &str) -> Option<String> {
    let output = std::process::Command::new(tmux_bin())
        .args(["capture-pane", "-p", "-e", "-J", "-S", "-200", "-t", name])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let trimmed = text.trim_end_matches('\n');
    Some(stable_output_signature(trimmed))
}

fn session_agent_running(target: &str) -> Option<bool> {
    let output = std::process::Command::new(tmux_bin())
        .args([
            "list-panes",
            "-t",
            target,
            "-F",
            "#{pane_active}\x1f#{pane_title}",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut first_title = None;
    for line in stdout.lines().filter(|line| !line.is_empty()) {
        let mut parts = line.splitn(2, '\x1f');
        let active = parts.next().unwrap_or_default();
        let title = parts.next().unwrap_or_default();
        if first_title.is_none() {
            first_title = Some(title.to_string());
        }
        if active == "1" {
            return Some(agent_running_from_pane_title(title));
        }
    }

    first_title.as_deref().map(agent_running_from_pane_title)
}

fn agent_running_from_pane_title(title: &str) -> bool {
    let mut chars = title.trim_start().chars();
    let Some(first) = chars.next() else {
        return false;
    };
    ('\u{2800}'..='\u{28ff}').contains(&first)
        && chars.next().is_some_and(|next| next.is_whitespace())
}

fn stable_output_signature(text: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[tauri::command]
fn tmux_session_exists(name: String) -> Result<bool, String> {
    let (host_id, raw_name) = parse_session_key(&name);
    let exact = format!("={}", raw_name);
    match host_id {
        Some(hid) => {
            let host = find_host(hid)?;
            Ok(run_remote_tmux_quiet(&host, &["has-session", "-t", &exact]).is_some())
        }
        None => Ok(run_quiet(&["tmux", "has-session", "-t", &exact]).is_some()),
    }
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
    #[serde(rename = "hostId", default)]
    host_id: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum AutomationTriggerType {
    Manual,
    Schedule,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum AutomationOverlap {
    Queue,
    Skip,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum AutomationStatus {
    Idle,
    Queued,
    Running,
    Success,
    Failed,
    Skipped,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Automation {
    id: String,
    name: String,
    enabled: bool,
    trigger_type: AutomationTriggerType,
    schedule: Option<String>,
    timezone: Option<String>,
    project: Option<String>,
    path: Option<String>,
    ai_cmd: String,
    instruction: String,
    overlap: AutomationOverlap,
    last_run_at: Option<String>,
    last_status: AutomationStatus,
    last_session: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AutomationRun {
    id: String,
    automation_id: String,
    started_at: String,
    finished_at: Option<String>,
    status: AutomationStatus,
    session_name: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SaveAutomationInput {
    id: Option<String>,
    name: Option<String>,
    enabled: Option<bool>,
    trigger_type: Option<AutomationTriggerType>,
    schedule: Option<Option<String>>,
    timezone: Option<Option<String>>,
    project: Option<Option<String>>,
    path: Option<Option<String>>,
    ai_cmd: Option<String>,
    instruction: Option<String>,
    overlap: Option<AutomationOverlap>,
}

struct UpsertAutomationResult {
    automations: Vec<Automation>,
    automation: Automation,
}

const AUTOMATION_RUN_LIMIT: usize = 200;

fn automations_path() -> std::path::PathBuf {
    app_home_dir_or_tmp().join(".tw-dashboard-automations.json")
}

fn automation_runs_path() -> std::path::PathBuf {
    app_home_dir_or_tmp().join(".tw-dashboard-automation-runs.json")
}

fn trimmed_non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn optional_string_patch(
    existing: Option<String>,
    patch: Option<Option<String>>,
) -> Option<String> {
    match patch {
        Some(Some(value)) => trimmed_non_empty(value),
        Some(None) => None,
        None => existing,
    }
}

fn new_prefixed_id(prefix: &str) -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    format!("{}-{}", prefix, &id[..12])
}

fn unix_seconds_to_rfc3339(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let seconds_of_day = secs % 86_400;
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn now_rfc3339() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    unix_seconds_to_rfc3339(secs)
}

fn shell_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }
    let mut quoted = String::from("'");
    for ch in value.chars() {
        if ch == '\'' {
            quoted.push_str("'\\''");
        } else {
            quoted.push(ch);
        }
    }
    quoted.push('\'');
    quoted
}

fn user_bin_path_prefix() -> &'static str {
    "export PATH=\"$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\""
}

fn automation_command_with_instruction(ai_cmd: &str, instruction: &str) -> String {
    let command = ai_cmd.trim();
    let instruction = instruction.trim();
    if instruction.is_empty() {
        return command.to_string();
    }
    if command.is_empty() {
        return shell_quote(instruction);
    }
    format!("{} {}", command, shell_quote(instruction))
}

fn should_skip_automation_overlap(automation: &Automation, session_exists: bool) -> bool {
    automation.overlap == AutomationOverlap::Skip
        && matches!(
            automation.last_status,
            AutomationStatus::Queued | AutomationStatus::Running
        )
        && automation.last_session.is_some()
        && session_exists
}

fn upsert_automation_from_input(
    mut automations: Vec<Automation>,
    input: SaveAutomationInput,
    now: &str,
) -> Result<UpsertAutomationResult, String> {
    let input_id = input.id.and_then(trimmed_non_empty);
    let existing_index = input_id.as_deref().and_then(|id| {
        automations
            .iter()
            .position(|automation| automation.id == id)
    });
    let existing = existing_index.map(|index| automations[index].clone());

    let id = existing
        .as_ref()
        .map(|automation| automation.id.clone())
        .or(input_id)
        .unwrap_or_else(|| new_prefixed_id("auto"));
    let name = input
        .name
        .and_then(trimmed_non_empty)
        .or_else(|| existing.as_ref().map(|automation| automation.name.clone()))
        .unwrap_or_else(|| "Untitled automation".to_string());
    let enabled = input
        .enabled
        .or_else(|| existing.as_ref().map(|automation| automation.enabled))
        .unwrap_or(true);
    let trigger_type = input
        .trigger_type
        .or_else(|| existing.as_ref().map(|automation| automation.trigger_type))
        .unwrap_or(AutomationTriggerType::Manual);
    let schedule = optional_string_patch(
        existing
            .as_ref()
            .and_then(|automation| automation.schedule.clone()),
        input.schedule,
    );
    let timezone = optional_string_patch(
        existing
            .as_ref()
            .and_then(|automation| automation.timezone.clone()),
        input.timezone,
    );
    let project = optional_string_patch(
        existing
            .as_ref()
            .and_then(|automation| automation.project.clone()),
        input.project,
    );
    let path = optional_string_patch(
        existing
            .as_ref()
            .and_then(|automation| automation.path.clone()),
        input.path,
    );
    let ai_cmd = input
        .ai_cmd
        .and_then(trimmed_non_empty)
        .or_else(|| {
            existing
                .as_ref()
                .map(|automation| automation.ai_cmd.clone())
        })
        .unwrap_or_else(|| "claude".to_string());
    let instruction = input
        .instruction
        .map(|value| value.trim().to_string())
        .or_else(|| {
            existing
                .as_ref()
                .map(|automation| automation.instruction.clone())
        })
        .unwrap_or_default();
    let overlap = input
        .overlap
        .or_else(|| existing.as_ref().map(|automation| automation.overlap))
        .unwrap_or(AutomationOverlap::Queue);
    let created_at = existing
        .as_ref()
        .map(|automation| automation.created_at.clone())
        .unwrap_or_else(|| now.to_string());

    let automation = Automation {
        id,
        name,
        enabled,
        trigger_type,
        schedule,
        timezone,
        project,
        path,
        ai_cmd,
        instruction,
        overlap,
        last_run_at: existing
            .as_ref()
            .and_then(|automation| automation.last_run_at.clone()),
        last_status: existing
            .as_ref()
            .map(|automation| automation.last_status)
            .unwrap_or(AutomationStatus::Idle),
        last_session: existing
            .as_ref()
            .and_then(|automation| automation.last_session.clone()),
        created_at,
        updated_at: now.to_string(),
    };

    if let Some(index) = existing_index {
        automations[index] = automation.clone();
    } else {
        automations.push(automation.clone());
    }

    Ok(UpsertAutomationResult {
        automations,
        automation,
    })
}

fn delete_automation_from_list(mut automations: Vec<Automation>, id: &str) -> Vec<Automation> {
    automations.retain(|automation| automation.id != id);
    automations
}

fn append_automation_run(runs: &mut Vec<AutomationRun>, run: AutomationRun) {
    runs.insert(0, run);
    runs.truncate(AUTOMATION_RUN_LIMIT);
}

fn load_automations_from_disk() -> Result<Vec<Automation>, String> {
    let path = automations_path();
    if !path.exists() {
        return Ok(vec![]);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("parse: {e}"))
}

fn save_automations_to_disk(automations: &[Automation]) -> Result<(), String> {
    let path = automations_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let text = serde_json::to_string_pretty(automations).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(path, text).map_err(|e| format!("write: {e}"))
}

fn load_automation_runs_from_disk() -> Result<Vec<AutomationRun>, String> {
    let path = automation_runs_path();
    if !path.exists() {
        return Ok(vec![]);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("parse: {e}"))
}

fn save_automation_runs_to_disk(runs: &[AutomationRun]) -> Result<(), String> {
    let path = automation_runs_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {e}"))?;
    }
    let text = serde_json::to_string_pretty(runs).map_err(|e| format!("serialize: {e}"))?;
    std::fs::write(path, text).map_err(|e| format!("write: {e}"))
}

fn string_field<'a>(value: &'a serde_json::Value, names: &[&str]) -> Option<&'a str> {
    names
        .iter()
        .find_map(|name| value.get(name).and_then(|v| v.as_str()))
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn expand_config_path(value: &str, home: Option<&str>) -> String {
    match home {
        Some(home) => expand_home_path_with_home(value, home),
        None => expand_home_path(value),
    }
}

fn project_from_value_with_home(
    name: String,
    value: &serde_json::Value,
    home: Option<&str>,
) -> Option<Project> {
    if let Some(path) = value.as_str().map(str::trim).filter(|s| !s.is_empty()) {
        return Some(Project {
            name,
            path: expand_config_path(path, home),
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
        path: expand_config_path(path, home),
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
    projects_from_config_with_home(config, None)
}

fn projects_from_config_with_home(config: &serde_json::Value, home: Option<&str>) -> Vec<Project> {
    match projects_value(config) {
        Some(serde_json::Value::Object(obj)) => obj
            .iter()
            .filter_map(|(name, value)| project_from_value_with_home(name.clone(), value, home))
            .collect(),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|value| {
                if let Some(path) = value.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                    let expanded = expand_config_path(path, home);
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
                project_from_value_with_home(name, value, home)
            })
            .collect(),
        _ => vec![],
    }
}

fn project_from_config(config: &serde_json::Value, name: &str) -> Option<Project> {
    project_from_config_with_home(config, name, None)
}

fn project_from_config_with_home(
    config: &serde_json::Value,
    name: &str,
    home: Option<&str>,
) -> Option<Project> {
    projects_value(config).and_then(|projects| match projects {
        serde_json::Value::Object(obj) => obj
            .get(name)
            .and_then(|value| project_from_value_with_home(name.to_string(), value, home)),
        serde_json::Value::Array(items) => items.iter().find_map(|value| {
            let project_name = string_field(value, &["name", "key", "id", "label"])?;
            if project_name == name {
                project_from_value_with_home(name.to_string(), value, home)
            } else {
                None
            }
        }),
        _ => None,
    })
}

fn config_worktree_base(config: &serde_json::Value) -> Option<String> {
    config_worktree_base_with_home(config, None)
}

fn config_worktree_base_with_home(
    config: &serde_json::Value,
    home: Option<&str>,
) -> Option<String> {
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
    .map(|path| expand_config_path(path, home))
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

fn run_git_output(
    host_id: Option<&str>,
    git_args: &[&str],
) -> Result<std::process::Output, String> {
    match host_id.filter(|id| !id.trim().is_empty()) {
        Some(hid) => {
            let host = find_host(hid)?;
            let mut remote_cmd = Vec::with_capacity(git_args.len() + 1);
            remote_cmd.push("git");
            remote_cmd.extend_from_slice(git_args);
            run_remote_cmd_output(&host, &remote_cmd)
        }
        None => std::process::Command::new(git_bin())
            .args(git_args)
            .output()
            .map_err(|e| format!("spawn git: {e}")),
    }
}

fn run_git_quiet(host_id: Option<&str>, git_args: &[&str]) -> Option<String> {
    let output = run_git_output(host_id, git_args).ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

// ── SSH remote execution ──────────────────────────────────────────────

/// Parse a composite session key into (host_id, raw_name).
/// - "hostid:rawname" → (Some("hostid"), "rawname")
/// - "rawname"        → (None, "rawname")  (local session, backward compat)
fn parse_session_key(key: &str) -> (Option<&str>, &str) {
    match key.split_once(':') {
        Some((host_id, raw_name)) => (Some(host_id), raw_name),
        None => (None, key),
    }
}

/// Build an SSH command that runs `remote_cmd` on `host` non-interactively.
/// Uses BatchMode=yes to avoid hanging on password prompts.
fn ssh_command(host: &HostConfig, remote_cmd: &[&str]) -> std::process::Command {
    let mut cmd = std::process::Command::new("ssh");
    cmd.arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-o")
        .arg("ConnectTimeout=5");
    if let Some(port) = host.port {
        cmd.arg("-p").arg(port.to_string());
    }
    if let Some(key) = &host.identity_file {
        cmd.arg("-i").arg(key);
    }
    let target = match &host.user {
        Some(u) => format!("{}@{}", u, host.host),
        None => host.host.clone(),
    };
    cmd.arg(&target).arg("--");
    if !remote_cmd.is_empty() {
        cmd.arg(format!(
            "{}; {}",
            user_bin_path_prefix(),
            shell_join(remote_cmd)
        ));
    }
    cmd
}

fn shell_join(args: &[&str]) -> String {
    args.iter()
        .map(|arg| shell_quote(arg))
        .collect::<Vec<_>>()
        .join(" ")
}

fn remote_path_expr(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed == "~" {
        return "\"$HOME\"".to_string();
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        let escaped = rest
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('$', "\\$")
            .replace('`', "\\`");
        return format!("\"$HOME/{escaped}\"");
    }
    shell_quote(trimmed)
}

fn remote_tmux_cmd(host: &HostConfig) -> String {
    remote_path_expr(host.tmux_path.as_deref().unwrap_or("tmux"))
}

fn remote_tw_cmd(host: &HostConfig) -> String {
    remote_path_expr(host.tw_path.as_deref().unwrap_or("tw"))
}

fn has_custom_tmux_path(host: &HostConfig) -> bool {
    host.tmux_path
        .as_deref()
        .is_some_and(|path| !path.trim().is_empty())
}

fn has_custom_tw_path(host: &HostConfig) -> bool {
    host.tw_path
        .as_deref()
        .is_some_and(|path| !path.trim().is_empty())
}

/// Build an SSH command for interactive PTY use (no BatchMode, force TTY with -tt).
#[allow(dead_code)]
fn ssh_command_interactive(host: &HostConfig, remote_cmd: &[&str]) -> std::process::Command {
    let mut cmd = std::process::Command::new("ssh");
    cmd.arg("-tt")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-o")
        .arg("ConnectTimeout=10");
    if let Some(port) = host.port {
        cmd.arg("-p").arg(port.to_string());
    }
    if let Some(key) = &host.identity_file {
        cmd.arg("-i").arg(key);
    }
    let target = match &host.user {
        Some(u) => format!("{}@{}", u, host.host),
        None => host.host.clone(),
    };
    cmd.arg(&target).arg("--");
    if !remote_cmd.is_empty() {
        cmd.arg(shell_join(remote_cmd));
    }
    cmd
}

/// Run a command on a remote host and return stdout.
fn run_remote_cmd_output(
    host: &HostConfig,
    remote_cmd: &[&str],
) -> Result<std::process::Output, String> {
    ssh_command(host, remote_cmd)
        .output()
        .map_err(|e| format!("ssh spawn: {e}"))
}

fn run_remote_cmd_with_input(
    host: &HostConfig,
    remote_cmd: &[&str],
    input: &[u8],
) -> Result<std::process::Output, String> {
    let mut child = ssh_command(host, remote_cmd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("ssh spawn: {e}"))?;

    let write_result = child
        .stdin
        .take()
        .ok_or_else(|| "ssh stdin unavailable".to_string())
        .and_then(|mut stdin| {
            stdin
                .write_all(input)
                .map_err(|e| format!("write ssh stdin: {e}"))
        });
    if let Err(error) = write_result {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }

    child
        .wait_with_output()
        .map_err(|e| format!("wait for ssh: {e}"))
}

fn run_remote_cmd_check(host: &HostConfig, remote_cmd: &[&str]) -> Result<String, String> {
    let output = run_remote_cmd_output(host, remote_cmd)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ssh on {} failed: {}", host.label, stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_remote_cmd_check_strings(
    host: &HostConfig,
    remote_cmd: &[String],
) -> Result<String, String> {
    let refs = remote_cmd.iter().map(String::as_str).collect::<Vec<_>>();
    run_remote_cmd_check(host, &refs)
}

fn run_remote_cmd_quiet(host: &HostConfig, remote_cmd: &[&str]) -> Option<String> {
    run_remote_cmd_check(host, remote_cmd).ok()
}

/// Run a tw subcommand on a remote host and return stdout.
fn run_remote_tw_check(host: &HostConfig, tw_args: &[&str]) -> Result<String, String> {
    if !has_custom_tmux_path(host) && !has_custom_tw_path(host) {
        let mut full_args = Vec::with_capacity(tw_args.len() + 1);
        full_args.push("tw");
        full_args.extend_from_slice(tw_args);
        return run_remote_cmd_check(host, &full_args);
    }

    let mut command = String::new();
    if has_custom_tmux_path(host) {
        command.push_str("TW_TMUX=");
        command.push_str(&remote_tmux_cmd(host));
        command.push(' ');
    }
    command.push_str(&remote_tw_cmd(host));
    for arg in tw_args {
        command.push(' ');
        command.push_str(&shell_quote(arg));
    }
    run_remote_cmd_check(host, &["sh", "-c", &command])
}

/// Run a tmux subcommand on a remote host and return stdout.
fn run_remote_tmux_check(host: &HostConfig, tmux_args: &[&str]) -> Result<String, String> {
    if !has_custom_tmux_path(host) {
        let mut full_args = Vec::with_capacity(tmux_args.len() + 1);
        full_args.push("tmux");
        full_args.extend_from_slice(tmux_args);
        return run_remote_cmd_check(host, &full_args);
    }

    let mut command = remote_tmux_cmd(host);
    for arg in tmux_args {
        command.push(' ');
        command.push_str(&shell_quote(arg));
    }
    run_remote_cmd_check(host, &["sh", "-c", &command])
}

fn run_remote_tmux_output(
    host: &HostConfig,
    tmux_args: &[&str],
) -> Result<std::process::Output, String> {
    if !has_custom_tmux_path(host) {
        let mut full_args = Vec::with_capacity(tmux_args.len() + 1);
        full_args.push("tmux");
        full_args.extend_from_slice(tmux_args);
        return run_remote_cmd_output(host, &full_args);
    }

    let mut command = remote_tmux_cmd(host);
    for arg in tmux_args {
        command.push(' ');
        command.push_str(&shell_quote(arg));
    }
    run_remote_cmd_output(host, &["sh", "-c", &command])
}

/// Quiet variant that returns None on failure.
fn run_remote_tmux_quiet(host: &HostConfig, tmux_args: &[&str]) -> Option<String> {
    run_remote_tmux_check(host, tmux_args).ok()
}

fn load_configured_hosts() -> Result<Vec<HostConfig>, String> {
    let home = app_home_dir().ok_or("home dir not found")?;
    let config_path = home.join(".tmux-worktree.json");
    if !config_path.exists() {
        return Ok(vec![]);
    }
    let content = std::fs::read_to_string(&config_path).map_err(|e| format!("read config: {e}"))?;
    let config: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("parse config: {e}"))?;
    Ok(hosts_from_config(&config))
}

/// Load explicitly connected host configurations from ~/.tmux-worktree.json.
fn load_hosts() -> Result<Vec<HostConfig>, String> {
    load_configured_hosts()
}

fn hosts_from_config(config: &serde_json::Value) -> Vec<HostConfig> {
    match config.get("hosts") {
        Some(serde_json::Value::Array(arr)) => {
            arr.iter().filter_map(host_from_config_value).collect()
        }
        Some(serde_json::Value::Object(map)) => map
            .iter()
            .filter_map(|(id, value)| host_from_named_config_value(id, value))
            .collect(),
        _ => vec![],
    }
}

fn host_from_alias(alias: &str) -> Option<HostConfig> {
    let trimmed = alias.trim();
    if trimmed.is_empty() || trimmed.contains(':') {
        return None;
    }
    Some(HostConfig {
        id: trimmed.to_string(),
        label: trimmed.to_string(),
        host: trimmed.to_string(),
        user: None,
        port: None,
        identity_file: None,
        worktree_base: None,
        tmux_path: None,
        tw_path: None,
    })
}

fn host_from_config_value(value: &serde_json::Value) -> Option<HostConfig> {
    match value {
        serde_json::Value::String(alias) => host_from_alias(alias),
        serde_json::Value::Object(_) => serde_json::from_value::<HostConfig>(value.clone()).ok(),
        _ => None,
    }
}

fn host_from_named_config_value(id: &str, value: &serde_json::Value) -> Option<HostConfig> {
    match value {
        serde_json::Value::String(host) => {
            let mut config = host_from_alias(id)?;
            config.host = host.trim().to_string();
            Some(config)
        }
        serde_json::Value::Object(map) => {
            let mut object = map.clone();
            object
                .entry("id".to_string())
                .or_insert_with(|| serde_json::Value::String(id.to_string()));
            object
                .entry("label".to_string())
                .or_insert_with(|| serde_json::Value::String(id.to_string()));
            object
                .entry("host".to_string())
                .or_insert_with(|| serde_json::Value::String(id.to_string()));
            serde_json::from_value::<HostConfig>(serde_json::Value::Object(object)).ok()
        }
        _ => None,
    }
}

fn load_ssh_host_candidates() -> Vec<HostConfig> {
    let Some(home) = dirs::home_dir() else {
        return vec![];
    };
    let path = home.join(".ssh").join("config");
    let Ok(text) = std::fs::read_to_string(path) else {
        return vec![];
    };
    ssh_host_candidates_from_config_text(&text)
}

fn ssh_host_candidates_from_config_text(text: &str) -> Vec<HostConfig> {
    ssh_hosts_from_config_text(text, |_| true)
}

#[derive(Default)]
struct SshHostBlock {
    aliases: Vec<String>,
    user: Option<String>,
    port: Option<u16>,
    host_name: Option<String>,
    proxy_jump: Option<String>,
}

fn ssh_hosts_from_config_text(text: &str, include_alias: fn(&str) -> bool) -> Vec<HostConfig> {
    let mut blocks = Vec::new();
    let mut current = SshHostBlock::default();

    for raw_line in text.lines() {
        let line = raw_line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        let key = key.to_ascii_lowercase();
        let value = value.trim();
        match key.as_str() {
            "host" => {
                if !current.aliases.is_empty() {
                    blocks.push(current);
                }
                current = SshHostBlock {
                    aliases: value
                        .split_whitespace()
                        .filter(|alias| ssh_host_alias_is_literal(alias))
                        .map(str::to_string)
                        .collect(),
                    ..SshHostBlock::default()
                };
            }
            "match" => {
                if !current.aliases.is_empty() {
                    blocks.push(current);
                }
                current = SshHostBlock::default();
            }
            "user" => {
                if !value.is_empty() {
                    current.user = Some(value.to_string());
                }
            }
            "port" => {
                current.port = value.parse::<u16>().ok();
            }
            "hostname" => {
                if !value.is_empty() {
                    current.host_name = Some(value.to_string());
                }
            }
            "proxyjump" => {
                if !value.is_empty() {
                    current.proxy_jump = Some(value.to_string());
                }
            }
            _ => {}
        }
    }
    if !current.aliases.is_empty() {
        blocks.push(current);
    }

    let jump_targets = blocks
        .iter()
        .filter_map(|block| block.proxy_jump.as_deref())
        .flat_map(ssh_proxy_jump_targets)
        .collect::<HashSet<_>>();
    let mut seen_ids = HashSet::new();
    let mut seen_physical_targets = HashSet::new();
    let mut hosts = Vec::new();

    for block in blocks {
        for alias in &block.aliases {
            if !include_alias(alias)
                || !seen_ids.insert(alias.clone())
                || jump_targets.contains(alias)
                || ssh_host_block_is_service(&block, alias)
            {
                continue;
            }
            let physical_target = ssh_host_physical_target(&block, alias);
            if !seen_physical_targets.insert(physical_target) {
                continue;
            }
            if let Some(mut host) = host_from_alias(alias) {
                host.user = block.user.clone();
                host.port = block.port;
                hosts.push(host);
            }
        }
    }

    hosts
}

fn ssh_host_alias_is_literal(alias: &str) -> bool {
    !alias.is_empty()
        && !alias
            .chars()
            .any(|ch| matches!(ch, '*' | '?' | '[' | ']' | '!'))
}

fn ssh_proxy_jump_targets(value: &str) -> Vec<String> {
    value
        .split(',')
        .filter_map(|target| {
            let target = target.trim();
            if target.is_empty() || target.eq_ignore_ascii_case("none") || target.contains('%') {
                return None;
            }
            let host = target
                .rsplit_once('@')
                .map(|(_, host)| host)
                .unwrap_or(target);
            let host = if let Some(rest) = host.strip_prefix('[') {
                rest.split(']').next().unwrap_or(rest)
            } else if host.matches(':').count() == 1 {
                host.split(':').next().unwrap_or(host)
            } else {
                host
            };
            if ssh_host_alias_is_literal(host) {
                Some(host.to_string())
            } else {
                None
            }
        })
        .collect()
}

fn ssh_host_block_is_service(block: &SshHostBlock, alias: &str) -> bool {
    block
        .user
        .as_deref()
        .is_some_and(|user| user.eq_ignore_ascii_case("git"))
        || block.port == Some(29418)
        || ssh_host_name(block, alias)
            .to_ascii_lowercase()
            .starts_with("git.")
}

fn ssh_host_name<'a>(block: &'a SshHostBlock, alias: &'a str) -> &'a str {
    block.host_name.as_deref().unwrap_or(alias).trim()
}

fn ssh_host_physical_target(block: &SshHostBlock, alias: &str) -> String {
    ssh_host_name(block, alias).to_ascii_lowercase()
}

/// Save hosts to ~/.tmux-worktree.json (read-modify-write).
#[cfg(test)]
fn save_hosts_config(hosts: &[HostConfig]) -> Result<(), String> {
    let _guard = dashboard_config_write_lock()
        .lock()
        .map_err(|_| "dashboard config write lock poisoned".to_string())?;
    save_hosts_config_unlocked(hosts)
}

fn save_hosts_config_unlocked(hosts: &[HostConfig]) -> Result<(), String> {
    let home = app_home_dir().ok_or("home dir not found")?;
    let config_path = home.join(".tmux-worktree.json");
    let mut config: serde_json::Value = if config_path.exists() {
        let text =
            std::fs::read_to_string(&config_path).map_err(|e| format!("read config: {e}"))?;
        serde_json::from_str(&text).map_err(|e| format!("parse config: {e}"))?
    } else {
        serde_json::json!({})
    };
    let root = config
        .as_object_mut()
        .ok_or("config root is not an object")?;
    root.insert(
        "hosts".to_string(),
        serde_json::to_value(hosts).map_err(|e| format!("serialize hosts: {e}"))?,
    );
    let pretty =
        serde_json::to_string_pretty(&config).map_err(|e| format!("serialize config: {e}"))?;
    atomic_write_file(&config_path, pretty.as_bytes()).map_err(|e| format!("write config: {e}"))?;
    Ok(())
}

/// Find a host by ID from the config.
fn find_host(host_id: &str) -> Result<HostConfig, String> {
    let hosts = load_hosts()?;
    hosts
        .into_iter()
        .find(|h| h.id == host_id)
        .ok_or_else(|| format!("unknown host: {host_id}"))
}

const HOST_STATUS_CACHE_MS: u64 = 5000;

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
    list_local_sessions()
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.raw_name)
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

fn worktree_has_uncommitted_changes(path: &str) -> Option<bool> {
    let worktree_path = std::path::Path::new(path);
    if !worktree_path.exists() {
        return Some(false);
    }
    let output = std::process::Command::new(git_bin())
        .args(["-C", path, "status", "--porcelain"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(!output.stdout.is_empty())
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
fn copy_mode_cancel_if_active(name: String) -> Result<bool, String> {
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TmuxStatusTheme {
    status_bg: String,
    status_fg: String,
    active_bg: String,
    active_fg: String,
    inactive_fg: String,
    accent: String,
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
fn apply_tmux_theme(name: String, theme: TmuxStatusTheme) -> Result<(), String> {
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
fn copy_tmux_selection(name: String) -> Result<bool, String> {
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

fn remote_unique_session_name(host: &HostConfig, base: &str) -> String {
    let mut name = base.to_string();
    let mut i = 1;
    while run_remote_tmux_quiet(host, &["has-session", "-t", &format!("={}", name)]).is_some() {
        name = format!("{}-{}", base, i);
        i += 1;
    }
    name
}

fn random_id() -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    id.chars().take(5).collect()
}

fn command_then_login_shell(command: &str) -> String {
    let path = user_bin_path_prefix();
    let shell = "exec \"${SHELL:-/bin/zsh}\" -l";
    if command.trim().is_empty() {
        format!("{path}; {shell}")
    } else {
        format!("{path}; {command}; {shell}")
    }
}

fn start_dashboard_worktree_session(
    session: &str,
    work_dir: &str,
    ai_cmd: &str,
) -> Result<(), String> {
    let ai_command = command_then_login_shell(ai_cmd);
    run_check(&[
        "tmux",
        "new-session",
        "-d",
        "-s",
        session,
        "-c",
        work_dir,
        &ai_command,
    ])?;
    setup_clipboard_bindings();
    Ok(())
}

/// tmux session 名的最大长度，与 CLI (`src/dev.ts` 的 `SESSION_NAME_MAX_LEN`) 对齐。
const SESSION_NAME_MAX_LEN: usize = 20;

#[tauri::command]
fn create_worktree(args: CreateArgs) -> Result<String, String> {
    if let Some(host_id) = args.host_id.as_deref() {
        let host = find_host(host_id)?;
        return create_remote_worktree(&host, args);
    }
    create_local_worktree(args)
}

fn create_local_worktree(args: CreateArgs) -> Result<String, String> {
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

    let mut created_worktree: Option<(String, String)> = None;
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

        created_worktree = Some((worktree_dir.clone(), branch_name.clone()));
        worktree_dir
    } else {
        project_dir.clone()
    };

    if let Err(err) = start_dashboard_worktree_session(&session, &work_dir, &args.ai_cmd) {
        let _ = run_quiet(&["tmux", "kill-session", "-t", &format!("={}", session)]);
        if let Some((worktree_dir, branch_name)) = created_worktree {
            let _ = try_cleanup_worktree(&worktree_dir, true);
            let _ = run_quiet(&["git", "-C", &project_dir, "branch", "-D", &branch_name]);
        }
        return Err(err);
    }

    Ok(session)
}

fn create_remote_worktree(host: &HostConfig, args: CreateArgs) -> Result<String, String> {
    match create_remote_worktree_via_tw_rpc(host, &args) {
        Ok(session) => Ok(session),
        Err(err) if remote_tw_rpc_create_unavailable(&err) => {
            create_remote_worktree_via_tmux(host, args)
        }
        Err(err) => Err(err),
    }
}

fn remote_tw_rpc_create_unavailable(err: &str) -> bool {
    let lower = err.to_lowercase();
    lower.contains("tw: command not found")
        || lower.contains("tw: not found")
        || lower.contains("command not found: tw")
        || lower.contains("unknown rpc command")
        || lower.contains("unknown create-worktree option")
        || lower.contains("unsupported tw rpc protocol")
}

#[derive(Clone)]
struct RemoteWorktreeTarget {
    label: String,
    project_dir: String,
    branch: Option<String>,
    worktree_base: Option<String>,
}

fn resolve_remote_worktree_target(
    host: &HostConfig,
    args: &CreateArgs,
    include_config_worktree_base: bool,
) -> Result<RemoteWorktreeTarget, String> {
    let project_name = args
        .project
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty());
    let needs_config =
        project_name.is_some() || (include_config_worktree_base && host.worktree_base.is_none());
    let remote_config = if needs_config {
        remote_config_for_host(host)?
    } else {
        None
    };

    let configured_project = if let Some(name) = project_name {
        let Some((config, home)) = remote_config.as_ref() else {
            return Err(format!(
                "project '{name}' not in ~/.tmux-worktree.json on {}",
                host.label
            ));
        };
        Some(
            project_from_config_with_home(config, name, Some(home.as_str())).ok_or_else(|| {
                format!(
                    "project '{name}' not in ~/.tmux-worktree.json on {}",
                    host.label
                )
            })?,
        )
    } else {
        None
    };

    let project_dir = args
        .path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            configured_project
                .as_ref()
                .map(|project| project.path.clone())
        })
        .ok_or("remote path or project required for creating worktrees on remote hosts")?;

    let label = project_name.map(ToString::to_string).unwrap_or_else(|| {
        Path::new(&project_dir)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("project")
            .to_string()
    });
    let branch = args
        .branch
        .as_deref()
        .map(str::trim)
        .filter(|branch| !branch.is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            configured_project
                .as_ref()
                .and_then(|project| project.branch.clone())
        });
    let worktree_base = host.worktree_base.clone().or_else(|| {
        if !include_config_worktree_base {
            return None;
        }
        let (config, home) = remote_config.as_ref()?;
        config_worktree_base_with_home(config, Some(home.as_str()))
    });

    Ok(RemoteWorktreeTarget {
        label,
        project_dir,
        branch,
        worktree_base,
    })
}

fn create_remote_worktree_via_tw_rpc(
    host: &HostConfig,
    args: &CreateArgs,
) -> Result<String, String> {
    let target = resolve_remote_worktree_target(host, args, false)?;

    let mut remote_cmd = vec![
        "tw".to_string(),
        "rpc".to_string(),
        "create-worktree".to_string(),
        "--path".to_string(),
        target.project_dir.clone(),
        "--ai-command".to_string(),
        args.ai_cmd.clone(),
    ];
    remote_cmd.push("--project".to_string());
    remote_cmd.push(target.label.clone());
    if let Some(worktree_base) = target.worktree_base.as_deref() {
        remote_cmd.push("--worktree-base".to_string());
        remote_cmd.push(worktree_base.to_string());
    }
    if let Some(name) = args
        .name
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        remote_cmd.push("--name".to_string());
        remote_cmd.push(name.to_string());
    }
    if let Some(branch) = target.branch.as_deref() {
        remote_cmd.push("--branch".to_string());
        remote_cmd.push(branch.to_string());
    }

    let output = run_remote_cmd_check_strings(host, &remote_cmd)?;
    let response: TwRpcCreateWorktreeResponse =
        serde_json::from_str(&output).map_err(|e| format!("parse tw rpc create-worktree: {e}"))?;
    if response.protocol_version != 1 {
        return Err(format!(
            "unsupported tw rpc protocol: {}",
            response.protocol_version
        ));
    }
    let session = response.session.trim();
    if session.is_empty() {
        return Err("tw rpc create-worktree returned empty session".to_string());
    }
    Ok(format!("{}:{}", host.id, session))
}

fn create_remote_worktree_via_tmux(host: &HostConfig, args: CreateArgs) -> Result<String, String> {
    let target = resolve_remote_worktree_target(host, &args, true)?;
    let project_dir = target.project_dir.as_str();
    let worktree_base = target
        .worktree_base
        .as_deref()
        .unwrap_or("/tmp/tmux-worktree/projects");

    let trimmed_name = args.name.as_deref().map(str::trim).unwrap_or("");
    let label = target.label.clone();
    let base_session = if trimmed_name.is_empty() {
        label.clone()
    } else {
        format!("{}-{}", label, trimmed_name)
    };
    let base_session: String = base_session.chars().take(SESSION_NAME_MAX_LEN).collect();
    let session_name = remote_unique_session_name(host, &base_session);

    // Check if project is a git repo on remote
    let is_git = run_remote_cmd_check(
        host,
        &[
            "git",
            "-C",
            project_dir,
            "rev-parse",
            "--is-inside-work-tree",
        ],
    )
    .map(|s| s.trim() == "true")
    .unwrap_or(false);

    if is_git {
        let branch_id = random_id();
        let branch_name = format!("{}-{}", session_name, branch_id);
        let project_worktree_root = format!("{}/{}", worktree_base, label);
        let worktree_dir = format!("{}/{}", project_worktree_root, branch_name);

        // Create worktree directory on remote
        run_remote_cmd_check(host, &["mkdir", "-p", &project_worktree_root])
            .map_err(|e| format!("mkdir on remote: {e}"))?;

        // Detect default branch on remote
        let target_branch = args
            .branch
            .as_deref()
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .map(|s| s.to_string())
            .or_else(|| target.branch.clone())
            .unwrap_or_else(|| {
                run_remote_cmd_quiet(
                    host,
                    &[
                        "git",
                        "-C",
                        project_dir,
                        "symbolic-ref",
                        "refs/remotes/origin/HEAD",
                    ],
                )
                .and_then(|s| {
                    s.strip_prefix("refs/remotes/origin/")
                        .map(|s| s.to_string())
                })
                .unwrap_or_else(|| "main".to_string())
            });

        // Fetch on remote
        let _ = run_remote_cmd_quiet(
            host,
            &[
                "git",
                "-C",
                project_dir,
                "fetch",
                "origin",
                &target_branch,
                "--quiet",
            ],
        );

        // Create worktree on remote
        run_remote_cmd_check(
            host,
            &[
                "git",
                "-C",
                project_dir,
                "worktree",
                "add",
                "-b",
                &branch_name,
                &worktree_dir,
                &format!("origin/{}", target_branch),
                "--quiet",
            ],
        )
        .map_err(|e| format!("git worktree add on remote: {e}"))?;

        // Start tmux session on remote
        let ai_cmd = command_then_login_shell(&args.ai_cmd);
        if let Err(err) = run_remote_tmux_check(
            host,
            &[
                "new-session",
                "-d",
                "-s",
                &session_name,
                "-c",
                &worktree_dir,
                &ai_cmd,
            ],
        ) {
            let _ =
                run_remote_tmux_quiet(host, &["kill-session", "-t", &format!("={}", session_name)]);
            let _ = run_remote_cmd_quiet(
                host,
                &[
                    "git",
                    "-C",
                    project_dir,
                    "worktree",
                    "remove",
                    "--force",
                    &worktree_dir,
                ],
            );
            let _ = run_remote_cmd_quiet(
                host,
                &["git", "-C", project_dir, "branch", "-D", &branch_name],
            );
            return Err(format!("tmux new-session on remote: {err}"));
        }
    } else {
        let ai_cmd = command_then_login_shell(&args.ai_cmd);
        run_remote_tmux_check(
            host,
            &[
                "new-session",
                "-d",
                "-s",
                &session_name,
                "-c",
                project_dir,
                &ai_cmd,
            ],
        )
        .map_err(|e| format!("tmux new-session on remote: {e}"))?;
    }

    Ok(format!("{}:{}", host.id, session_name))
}

#[tauri::command]
fn kill_session(name: String) -> Result<(), String> {
    let (host_id, raw_name) = parse_session_key(&name);
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
    tw_session_name_from_worktree_dir(dirname).unwrap_or_else(|| dirname.to_string())
}

fn tw_session_name_from_worktree_dir(dirname: &str) -> Option<String> {
    let bytes = dirname.as_bytes();
    if bytes.len() > 6 && bytes[bytes.len() - 6] == b'-' {
        let suffix = &dirname[dirname.len() - 5..];
        if suffix.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(dirname[..dirname.len() - 6].to_string());
        }
    }
    None
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
    start_dashboard_worktree_session(&session, &args.path, &args.ai_cmd)?;

    remove_pending_cleanup_path(&args.path);

    Ok(session)
}

#[tauri::command]
fn delete_worktree(args: DeleteWorktreeArgs) -> Result<(), String> {
    if !args.force && worktree_has_uncommitted_changes(&args.path).unwrap_or(false) {
        return Err(format!("worktree has uncommitted changes: {}", args.path));
    }
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
fn session_root(name: String) -> Result<String, String> {
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
    let _guard = dashboard_config_write_lock()
        .lock()
        .map_err(|_| "dashboard config write lock poisoned".to_string())?;

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
    atomic_write_file(&config_path, pretty.as_bytes()).map_err(|e| format!("write config: {e}"))?;

    list_projects()
}

// ── Host management commands ──────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddHostArgs {
    id: String,
    label: String,
    host: String,
    #[serde(default)]
    user: Option<String>,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    identity_file: Option<String>,
    #[serde(default)]
    worktree_base: Option<String>,
    #[serde(default)]
    tmux_path: Option<String>,
    #[serde(default)]
    tw_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateHostArgs {
    id: String,
    label: String,
    host: String,
    #[serde(default)]
    user: Option<String>,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    identity_file: Option<String>,
    #[serde(default)]
    worktree_base: Option<String>,
    #[serde(default)]
    tmux_path: Option<String>,
    #[serde(default)]
    tw_path: Option<String>,
}

const TW_GITHUB_REPO: &str = "https://github.com/Sskift/tmux-worktree.git";

#[tauri::command]
fn list_hosts() -> Result<Vec<HostConfig>, String> {
    load_hosts()
}

#[tauri::command]
fn list_ssh_host_candidates() -> Result<Vec<HostConfig>, String> {
    Ok(load_ssh_host_candidates())
}

fn add_host_config(args: AddHostArgs) -> Result<Vec<HostConfig>, String> {
    let id = args.id.trim();
    let label = args.label.trim();
    let host = args.host.trim();
    if id.is_empty() {
        return Err("id required".into());
    }
    if label.is_empty() {
        return Err("label required".into());
    }
    if host.is_empty() {
        return Err("host required".into());
    }
    if id.contains(':') {
        return Err("host id cannot contain ':'".into());
    }

    let _guard = dashboard_config_write_lock()
        .lock()
        .map_err(|_| "dashboard config write lock poisoned".to_string())?;
    let mut configured_hosts = load_configured_hosts()?;
    if configured_hosts.iter().any(|h| h.id == id) {
        return Err(format!("host id '{id}' already exists"));
    }

    let new_host = HostConfig {
        id: id.to_string(),
        label: label.to_string(),
        host: host.to_string(),
        user: args
            .user
            .filter(|u| !u.trim().is_empty())
            .map(|u| u.trim().to_string()),
        port: args.port,
        identity_file: args
            .identity_file
            .filter(|p| !p.trim().is_empty())
            .map(|p| expand_home_path(p.trim())),
        worktree_base: args
            .worktree_base
            .as_deref()
            .and_then(trimmed_non_empty_string),
        tmux_path: args.tmux_path.as_deref().and_then(trimmed_non_empty_string),
        tw_path: args.tw_path.as_deref().and_then(trimmed_non_empty_string),
    };

    configured_hosts.push(new_host);
    save_hosts_config_unlocked(&configured_hosts)?;
    load_hosts()
}

fn update_host_config(args: UpdateHostArgs) -> Result<Vec<HostConfig>, String> {
    let id = args.id.trim();
    let label = args.label.trim();
    let host = args.host.trim();
    if id.is_empty() {
        return Err("host id required".into());
    }
    if label.is_empty() {
        return Err("host label required".into());
    }
    if host.is_empty() {
        return Err("host target required".into());
    }
    if id.contains(':') {
        return Err("host id cannot contain ':'".into());
    }

    let _guard = dashboard_config_write_lock()
        .lock()
        .map_err(|_| "dashboard config write lock poisoned".to_string())?;
    let mut hosts = load_configured_hosts()?;
    let matching = hosts
        .iter()
        .filter(|configured| configured.id == id)
        .count();
    if matching == 0 {
        return Err(format!("host id '{id}' not found"));
    }
    if matching > 1 {
        return Err(format!("host id '{id}' is duplicated in config"));
    }

    let optional = |value: Option<String>| value.as_deref().and_then(trimmed_non_empty_string);
    let identity_file = optional(args.identity_file).map(|path| expand_home_path(&path));
    let updated = HostConfig {
        id: id.to_string(),
        label: label.to_string(),
        host: host.to_string(),
        user: optional(args.user),
        port: args.port,
        identity_file,
        worktree_base: optional(args.worktree_base),
        tmux_path: optional(args.tmux_path),
        tw_path: optional(args.tw_path),
    };
    let index = hosts
        .iter()
        .position(|configured| configured.id == id)
        .expect("matching host index");
    hosts[index] = updated;
    save_hosts_config_unlocked(&hosts)?;
    load_hosts()
}

fn invalidate_host_status_cache(state: &HostState, id: &str) -> Result<(), String> {
    state
        .statuses
        .lock()
        .map_err(|_| "host status cache lock poisoned".to_string())?
        .remove(id);
    Ok(())
}

fn add_host_with_state(args: AddHostArgs, state: &HostState) -> Result<Vec<HostConfig>, String> {
    let id = args.id.trim().to_string();
    let hosts = add_host_config(args)?;
    invalidate_host_status_cache(state, &id)?;
    Ok(hosts)
}

#[tauri::command]
fn add_host(
    args: AddHostArgs,
    state: State<'_, Arc<HostState>>,
) -> Result<Vec<HostConfig>, String> {
    add_host_with_state(args, state.inner().as_ref())
}

#[tauri::command]
fn update_host(
    args: UpdateHostArgs,
    state: State<'_, Arc<HostState>>,
) -> Result<Vec<HostConfig>, String> {
    let id = args.id.trim().to_string();
    let hosts = update_host_config(args)?;
    invalidate_host_status_cache(state.inner().as_ref(), &id)?;
    Ok(hosts)
}

fn remove_host_config(id: &str) -> Result<Vec<HostConfig>, String> {
    let _guard = dashboard_config_write_lock()
        .lock()
        .map_err(|_| "dashboard config write lock poisoned".to_string())?;
    let mut hosts = load_configured_hosts()?;
    hosts.retain(|h| h.id != id);
    save_hosts_config_unlocked(&hosts)?;
    load_hosts()
}

fn remove_host_with_state(id: String, state: &HostState) -> Result<Vec<HostConfig>, String> {
    let id = id.trim().to_string();
    let hosts = remove_host_config(&id)?;
    invalidate_host_status_cache(state, &id)?;
    Ok(hosts)
}

#[tauri::command]
fn remove_host(id: String, state: State<'_, Arc<HostState>>) -> Result<Vec<HostConfig>, String> {
    remove_host_with_state(id, state.inner().as_ref())
}

fn remote_tw_version(host: &HostConfig) -> Result<String, String> {
    run_remote_tw_check(host, &["version"])
        .map(|version| version.lines().next().unwrap_or("").trim().to_string())
}

#[tauri::command]
async fn remote_home_dir(host_id: String) -> Result<String, String> {
    let host_id = host_id.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let host = find_host(&host_id)?;
        remote_home_dir_for_host(&host)
    })
    .await
    .map_err(|e| format!("remote home task failed: {e}"))?
}

fn remote_home_dir_for_host(host: &HostConfig) -> Result<String, String> {
    let home = run_remote_cmd_check(
        host,
        &[
            "sh",
            "-c",
            "cd \"${HOME:-.}\" 2>/dev/null && pwd -P || printf %s \"${HOME:-/}\"",
        ],
    )
    .map_err(|e| format!("read remote home on {}: {e}", host.label))?;
    let home = home.trim();
    if home.is_empty() {
        return Err(format!("remote home on {} is empty", host.label));
    }
    Ok(home.to_string())
}

fn remote_config_for_host(
    host: &HostConfig,
) -> Result<Option<(serde_json::Value, String)>, String> {
    let home = remote_home_dir_for_host(host)?;
    let text = run_remote_cmd_check(
        host,
        &[
            "sh",
            "-c",
            r#"home=${1:-${HOME:-.}}; config="${home%/}/.tmux-worktree.json"; if [ -f "$config" ]; then cat "$config"; fi"#,
            "sh",
            &home,
        ],
    )
    .map_err(|e| format!("read remote config on {}: {e}", host.label))?;
    let text = text.trim();
    if text.is_empty() {
        return Ok(None);
    }
    let config: serde_json::Value = serde_json::from_str(text)
        .map_err(|e| format!("parse remote config on {}: {e}", host.label))?;
    Ok(Some((config, home)))
}

#[tauri::command]
async fn list_remote_projects(host_id: String) -> Result<Vec<Project>, String> {
    let host_id = host_id.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let host = find_host(&host_id)?;
        let Some((config, home)) = remote_config_for_host(&host)? else {
            return Ok(vec![]);
        };
        Ok(projects_from_config_with_home(&config, Some(home.as_str())))
    })
    .await
    .map_err(|e| format!("remote projects task failed: {e}"))?
}

#[tauri::command]
async fn remote_read_dir(host_id: String, path: String) -> Result<Vec<DirEntry>, String> {
    let host_id = host_id.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let host = find_host(&host_id)?;
        remote_read_dirs_for_host(&host, &path)
    })
    .await
    .map_err(|e| format!("remote read dir task failed: {e}"))?
}

fn remote_read_dirs_for_host(host: &HostConfig, path: &str) -> Result<Vec<DirEntry>, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("remote path required".to_string());
    }
    let script = r#"dir=${1:-$HOME}; LC_ALL=C find -L "$dir" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null | sort -z"#;
    let output = run_remote_cmd_check(host, &["sh", "-c", script, "sh", path])
        .map_err(|e| format!("read remote directory on {}: {e}", host.label))?;
    let entries = output
        .split('\0')
        .map(str::trim)
        .filter(|entry_path| !entry_path.is_empty())
        .map(|entry_path| {
            let name = entry_path
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .filter(|name| !name.is_empty())
                .unwrap_or(entry_path)
                .to_string();
            DirEntry {
                is_hidden: name.starts_with('.'),
                name,
                path: entry_path.to_string(),
                is_dir: true,
                is_symlink: false,
                size: 0,
            }
        })
        .collect();
    Ok(entries)
}

fn probe_host_status(host: &HostConfig) -> HostStatus {
    let start = Instant::now();
    let result = run_remote_tmux_check(host, &["-V"]);
    let latency = start.elapsed().as_millis() as u64;
    match result {
        Ok(_) => match remote_tw_version(host) {
            Ok(version) => HostStatus {
                id: host.id.clone(),
                label: host.label.clone(),
                reachable: true,
                latency_ms: Some(latency),
                error: None,
                tw_available: true,
                tw_version: Some(version),
                tw_error: None,
            },
            Err(err) => HostStatus {
                id: host.id.clone(),
                label: host.label.clone(),
                reachable: true,
                latency_ms: Some(latency),
                error: None,
                tw_available: false,
                tw_version: None,
                tw_error: Some(err),
            },
        },
        Err(e) => HostStatus {
            id: host.id.clone(),
            label: host.label.clone(),
            reachable: false,
            latency_ms: None,
            error: Some(e),
            tw_available: false,
            tw_version: None,
            tw_error: None,
        },
    }
}

#[tauri::command]
fn test_host(args: AddHostArgs) -> Result<HostStatus, String> {
    let host = HostConfig {
        id: args.id.trim().to_string(),
        label: args.label.trim().to_string(),
        host: args.host.trim().to_string(),
        user: args
            .user
            .filter(|u| !u.trim().is_empty())
            .map(|u| u.trim().to_string()),
        port: args.port,
        identity_file: args
            .identity_file
            .filter(|p| !p.trim().is_empty())
            .map(|p| expand_home_path(p.trim())),
        worktree_base: args
            .worktree_base
            .as_deref()
            .and_then(trimmed_non_empty_string),
        tmux_path: args.tmux_path.as_deref().and_then(trimmed_non_empty_string),
        tw_path: args.tw_path.as_deref().and_then(trimmed_non_empty_string),
    };
    Ok(probe_host_status(&host))
}

#[tauri::command]
fn install_host_tw(host_id: String) -> Result<HostStatus, String> {
    let host = find_host(host_id.trim())?;
    let script = format!(
        r#"set -e
repo={}
root="$HOME/.local/src/tmux-worktree"
mkdir -p "$HOME/.local/src"
if [ -d "$root/.git" ]; then
  git -C "$root" fetch --all --tags --prune
  git -C "$root" checkout master
  git -C "$root" pull --ff-only
else
  rm -rf "$root"
  git clone --depth 1 "$repo" "$root"
fi
cd "$root"
npm install
npm run build
npm link --prefix "$HOME/.local"
"#,
        shell_quote(TW_GITHUB_REPO)
    );
    run_remote_cmd_check(&host, &["sh", "-lc", &script])
        .map_err(|e| format!("install remote tw on {}: {e}", host.label))?;
    Ok(probe_host_status(&host))
}

#[tauri::command]
async fn host_statuses(state: State<'_, Arc<HostState>>) -> Result<Vec<HostStatus>, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || host_statuses_blocking(state))
        .await
        .map_err(|e| format!("host statuses task failed: {e}"))?
}

fn host_statuses_blocking(state: Arc<HostState>) -> Result<Vec<HostStatus>, String> {
    let hosts = load_hosts()?;
    let now = Instant::now();
    let mut statuses = Vec::new();

    for host in &hosts {
        // Check cache first
        {
            let cached = state.statuses.lock().unwrap();
            if let Some(cached_status) = cached.get(&host.id) {
                if now.duration_since(cached_status.checked_at).as_millis()
                    < HOST_STATUS_CACHE_MS as u128
                {
                    statuses.push(cached_status.status.clone());
                    continue;
                }
            }
        }

        let status = probe_host_status(host);

        // Cache the result
        {
            let mut cached = state.statuses.lock().unwrap();
            cached.insert(
                host.id.clone(),
                CachedHostStatus {
                    status: status.clone(),
                    checked_at: now,
                },
            );
        }

        statuses.push(status);
    }

    Ok(statuses)
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
fn git_log(
    cwd: String,
    limit: Option<u32>,
    host_id: Option<String>,
) -> Result<Vec<GitCommit>, String> {
    let host = host_id.as_deref();
    let inside = run_git_quiet(host, &["-C", &cwd, "rev-parse", "--is-inside-work-tree"]);
    if inside.as_deref() != Some("true") {
        return Ok(vec![]);
    }

    let n = limit.unwrap_or(80).min(500);
    let n_str = n.to_string();
    let fmt = "%H\x1f%h\x1f%P\x1f%s\x1f%an\x1f%ar\x1f%D";
    let pretty = format!("--pretty=format:{}", fmt);
    let output = run_git_output(
        host,
        &[
            "-C",
            &cwd,
            "log",
            "--all",
            "--topo-order",
            "--decorate=short",
            "-n",
            &n_str,
            &pretty,
        ],
    )?;
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

fn now_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn is_fetchable_git_repo(path: &str) -> bool {
    run_git_quiet(None, &["-C", path, "rev-parse", "--is-inside-work-tree"]).as_deref()
        == Some("true")
}

fn fetchable_project_paths(projects: &[Project]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut paths = Vec::new();

    for project in projects {
        let raw = project.path.trim();
        if raw.is_empty() || !is_fetchable_git_repo(raw) {
            continue;
        }
        let canonical = std::fs::canonicalize(raw)
            .unwrap_or_else(|_| PathBuf::from(raw))
            .to_string_lossy()
            .to_string();
        if seen.insert(canonical.clone()) {
            paths.push(canonical);
        }
    }

    paths
}

fn reserve_git_fetch_target(tracker: &mut GitFetchTracker, target: &str, now: u64) -> bool {
    if tracker.in_flight.contains(target) {
        return false;
    }
    if tracker
        .last_started
        .get(target)
        .is_some_and(|last| now.saturating_sub(*last) < GIT_FETCH_INTERVAL_SECONDS)
    {
        return false;
    }

    tracker.last_started.insert(target.to_string(), now);
    tracker.in_flight.insert(target.to_string());
    true
}

fn finish_git_fetch_target(tracker: &mut GitFetchTracker, target: &str) {
    tracker.in_flight.remove(target);
}

fn git_fetch_args(path: &str) -> [&str; 6] {
    ["-C", path, "fetch", "--all", "--prune", "--quiet"]
}

fn git_fetch_project_root(path: &str) {
    let _ = std::process::Command::new(git_bin())
        .args(git_fetch_args(path))
        .env("GIT_TERMINAL_PROMPT", "0")
        .output();
}

#[tauri::command]
fn git_fetch_project_roots(state: State<'_, Arc<GitFetchState>>) -> Result<(), String> {
    let projects = list_projects()?;
    let paths = fetchable_project_paths(&projects);
    if paths.is_empty() {
        return Ok(());
    }

    let now = now_unix_seconds();
    let targets = {
        let mut tracker = state.tracker.lock().unwrap();
        paths
            .into_iter()
            .filter(|path| reserve_git_fetch_target(&mut tracker, path, now))
            .collect::<Vec<_>>()
    };

    for target in targets {
        let state = state.inner().clone();
        thread::spawn(move || {
            git_fetch_project_root(&target);
            let mut tracker = state.tracker.lock().unwrap();
            finish_git_fetch_target(&mut tracker, &target);
        });
    }

    Ok(())
}

#[tauri::command]
fn git_status(cwd: String, host_id: Option<String>) -> Result<Option<GitStatus>, String> {
    let host = host_id.as_deref();
    let inside = run_git_quiet(host, &["-C", &cwd, "rev-parse", "--is-inside-work-tree"]);
    if inside.as_deref() != Some("true") {
        return Ok(None);
    }

    let output = run_git_output(host, &["-C", &cwd, "status", "--porcelain=v2", "--branch"])?;
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
fn git_diff(cwd: String, path: String, host_id: Option<String>) -> Result<String, String> {
    let host = host_id.as_deref();
    // Try unstaged diff first
    let output = run_git_output(host, &["-C", &cwd, "diff", "--", &path])?;
    if !output.status.success() {
        return Err(format!(
            "git diff failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let diff = String::from_utf8_lossy(&output.stdout).to_string();

    if !diff.trim().is_empty() {
        return Ok(diff);
    }

    // Try staged diff
    let output2 = run_git_output(host, &["-C", &cwd, "diff", "--cached", "--", &path])?;
    if !output2.status.success() {
        return Err(format!(
            "git diff --cached failed: {}",
            String::from_utf8_lossy(&output2.stderr).trim()
        ));
    }

    let staged = String::from_utf8_lossy(&output2.stdout).to_string();

    if !staged.trim().is_empty() {
        return Ok(staged);
    }

    // For untracked files, show entire file as addition
    let output3 = run_git_output(
        host,
        &["-C", &cwd, "diff", "--no-index", "/dev/null", &path],
    );

    if let Ok(o) = output3 {
        if !o.status.success() && o.status.code() != Some(1) {
            return Err(format!(
                "git diff --no-index failed: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            ));
        }
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

fn unique_terminal_name() -> String {
    loop {
        let name = format!("tw-term-{}", random_id());
        if run_quiet(&["tmux", "has-session", "-t", &format!("={}", name)]).is_none() {
            return name;
        }
    }
}

fn remote_unique_terminal_name(host: &HostConfig) -> String {
    loop {
        let name = format!("tw-term-{}", random_id());
        if run_remote_tmux_quiet(host, &["has-session", "-t", &format!("={}", name)]).is_none() {
            return name;
        }
    }
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

#[tauri::command]
fn create_terminal(args: CreateTerminalArgs) -> Result<CreatedTerminal, String> {
    let cwd = args.cwd.trim();
    if cwd.is_empty() {
        return Err("cwd required".to_string());
    }
    let ai_cmd = args.ai_cmd.trim();
    if ai_cmd.is_empty() {
        return Err("ai command required".to_string());
    }

    match args.host_id.as_deref().filter(|id| !id.trim().is_empty()) {
        Some(host_id) => {
            let host = find_host(host_id)?;
            let raw_name = remote_unique_terminal_name(&host);
            start_remote_terminal_session(&host, &raw_name, cwd, ai_cmd)?;
            Ok(CreatedTerminal {
                tmux_name: format!("{}:{}", host.id, raw_name),
                host_id: Some(host.id),
                raw_name,
            })
        }
        None => {
            let raw_name = unique_terminal_name();
            start_local_terminal_session(&raw_name, cwd, ai_cmd)?;
            Ok(CreatedTerminal {
                tmux_name: raw_name.clone(),
                host_id: None,
                raw_name,
            })
        }
    }
}

#[tauri::command]
fn capture_pane_history(name: String, lines: Option<u16>) -> Result<String, String> {
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

#[tauri::command]
fn ensure_terminal_session(args: EnsureTerminalArgs) -> Result<(), String> {
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

#[tauri::command]
fn kill_plain_terminal(name: String) -> Result<(), String> {
    let (host_id, raw_name) = parse_session_key(&name);
    let exact = format!("={}", raw_name);
    match host_id {
        Some(host_id) => {
            let host = find_host(host_id)?;
            let _ = run_remote_tmux_quiet(&host, &["kill-session", "-t", &exact]);
        }
        None => {
            let _ = run_quiet(&["tmux", "kill-session", "-t", &exact]);
        }
    }
    Ok(())
}

fn terminals_path() -> std::path::PathBuf {
    app_home_dir_or_tmp().join(".tw-dashboard-terminals.json")
}

fn layout_path() -> std::path::PathBuf {
    app_home_dir_or_tmp().join(".tw-dashboard-layout.json")
}

fn layout_backup_path(path: &Path, schema_version: u64) -> PathBuf {
    path.with_extension(format!("v{schema_version}.backup.json"))
}

fn layout_schema_version(layout: &serde_json::Value) -> u64 {
    ["schemaVersion", "version"]
        .into_iter()
        .find_map(|key| {
            layout
                .get(key)
                .and_then(serde_json::Value::as_u64)
                .filter(|version| *version > 0)
        })
        .unwrap_or(1)
}

fn backup_layout_before_schema_migration(
    path: &Path,
    next_layout: &serde_json::Value,
) -> Result<Option<PathBuf>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let current_text =
        std::fs::read_to_string(path).map_err(|e| format!("read layout for backup: {e}"))?;
    let current_layout: serde_json::Value =
        serde_json::from_str(&current_text).map_err(|e| format!("parse layout for backup: {e}"))?;
    let current_version = layout_schema_version(&current_layout);
    if layout_schema_version(next_layout) <= current_version {
        return Ok(None);
    }

    let backup_path = layout_backup_path(path, current_version);
    if !backup_path.exists() {
        atomic_write_file(&backup_path, current_text.as_bytes())
            .map_err(|e| format!("write layout migration backup: {e}"))?;
    }
    Ok(Some(backup_path))
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
    let _guard = dashboard_layout_write_lock()
        .lock()
        .map_err(|_| "dashboard layout write lock poisoned".to_string())?;
    let path = layout_path();
    backup_layout_before_schema_migration(&path, &layout)?;
    atomic_write_file(&path, text.as_bytes()).map_err(|e| format!("write: {e}"))?;
    Ok(())
}

#[tauri::command]
fn list_automations() -> Result<Vec<Automation>, String> {
    load_automations_from_disk()
}

#[tauri::command]
fn save_automation(input: SaveAutomationInput) -> Result<Automation, String> {
    let automations = load_automations_from_disk()?;
    let now = now_rfc3339();
    let result = upsert_automation_from_input(automations, input, &now)?;
    save_automations_to_disk(&result.automations)?;
    Ok(result.automation)
}

#[tauri::command]
fn delete_automation(id: String) -> Result<(), String> {
    let automations = load_automations_from_disk()?;
    let next = delete_automation_from_list(automations, id.trim());
    save_automations_to_disk(&next)
}

#[tauri::command]
fn trigger_automation(id: String) -> Result<AutomationRun, String> {
    let mut automations = load_automations_from_disk()?;
    let index = automations
        .iter()
        .position(|automation| automation.id == id)
        .ok_or_else(|| format!("automation not found: {id}"))?;
    let automation = automations[index].clone();
    let now = now_rfc3339();
    let session_exists = automation
        .last_session
        .as_ref()
        .map(|session| tmux_session_exists(session.clone()).unwrap_or(false))
        .unwrap_or(false);

    if should_skip_automation_overlap(&automation, session_exists) {
        let run = AutomationRun {
            id: new_prefixed_id("run"),
            automation_id: automation.id.clone(),
            started_at: now.clone(),
            finished_at: Some(now),
            status: AutomationStatus::Skipped,
            session_name: automation.last_session.clone(),
            error: Some("automation already has a live running session".to_string()),
        };
        let mut runs = load_automation_runs_from_disk()?;
        append_automation_run(&mut runs, run.clone());
        save_automation_runs_to_disk(&runs)?;
        return Ok(run);
    }

    let ai_cmd = automation_command_with_instruction(&automation.ai_cmd, &automation.instruction);
    let start_result = create_worktree(CreateArgs {
        project: automation.project.clone().and_then(trimmed_non_empty),
        path: automation.path.clone().and_then(trimmed_non_empty),
        ai_cmd,
        name: Some(automation.name.clone()),
        branch: None,
        host_id: None,
    });

    let mut runs = load_automation_runs_from_disk()?;
    let run = match start_result {
        Ok(session) => {
            automations[index].last_run_at = Some(now.clone());
            automations[index].last_status = AutomationStatus::Running;
            automations[index].last_session = Some(session.clone());
            AutomationRun {
                id: new_prefixed_id("run"),
                automation_id: automation.id,
                started_at: now,
                finished_at: None,
                status: AutomationStatus::Running,
                session_name: Some(session),
                error: None,
            }
        }
        Err(error) => {
            automations[index].last_run_at = Some(now.clone());
            automations[index].last_status = AutomationStatus::Failed;
            AutomationRun {
                id: new_prefixed_id("run"),
                automation_id: automation.id,
                started_at: now.clone(),
                finished_at: Some(now),
                status: AutomationStatus::Failed,
                session_name: None,
                error: Some(error),
            }
        }
    };

    append_automation_run(&mut runs, run.clone());
    save_automations_to_disk(&automations)?;
    save_automation_runs_to_disk(&runs)?;
    Ok(run)
}

#[tauri::command]
fn list_automation_runs(automation_id: Option<String>) -> Result<Vec<AutomationRun>, String> {
    let mut runs = load_automation_runs_from_disk()?;
    if let Some(id) = automation_id.and_then(trimmed_non_empty) {
        runs.retain(|run| run.automation_id == id);
    }
    runs.truncate(AUTOMATION_RUN_LIMIT);
    Ok(runs)
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
    if meta.len() > MAX_EDITABLE_FILE_SIZE {
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

const MAX_EDITABLE_FILE_SIZE: u64 = 5 * 1024 * 1024;

const REMOTE_READ_FILE_SCRIPT: &str = r#"path=$1
if [ ! -f "$path" ]; then
  printf 'not a file: %s\n' "$path" >&2
  exit 44
fi
size=$(wc -c < "$path") || exit 45
case "$size" in
  ''|*[!0-9]*) printf 'invalid file size: %s\n' "$path" >&2; exit 45 ;;
esac
if [ "$size" -gt 5242880 ]; then
  printf 'file too large (>5 MB): %s\n' "$path" >&2
  exit 46
fi
cat "$path""#;

const REMOTE_WRITE_FILE_SCRIPT: &str = r#"path=$1
if [ -z "$path" ]; then
  printf 'remote path required\n' >&2
  exit 43
fi
if [ -e "$path" ] && [ ! -f "$path" ]; then
  printf 'not a file: %s\n' "$path" >&2
  exit 44
fi
dir=${path%/*}
if [ "$dir" != "$path" ] && [ ! -d "$dir" ]; then
  printf 'parent directory does not exist: %s\n' "$dir" >&2
  exit 45
fi
tmp=$(mktemp "${path}.tw-dashboard-write.XXXXXX") || exit 46
cleanup() { rm -f "$tmp"; }
trap cleanup 0 HUP INT TERM
if [ -e "$path" ]; then
  cp -p "$path" "$tmp" || exit 46
fi
cat > "$tmp" || exit 47
mv "$tmp" "$path" || exit 48
trap - 0 HUP INT TERM"#;

fn remote_file_error(host: &HostConfig, action: &str, output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = stderr.trim();
    if detail.is_empty() {
        format!("{action} on {} failed with {}", host.label, output.status)
    } else {
        format!("{action} on {} failed: {detail}", host.label)
    }
}

fn remote_file_exists_for_host(host: &HostConfig, path: &str) -> Result<bool, String> {
    if path.trim().is_empty() {
        return Ok(false);
    }
    let output = run_remote_cmd_output(host, &["sh", "-c", "test -f \"$1\"", "sh", path])?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(remote_file_error(host, "check remote file", &output)),
    }
}

fn remote_read_file_bytes_for_host(host: &HostConfig, path: &str) -> Result<Vec<u8>, String> {
    if path.trim().is_empty() {
        return Err("remote path required".to_string());
    }
    let output = run_remote_cmd_output(host, &["sh", "-c", REMOTE_READ_FILE_SCRIPT, "sh", path])?;
    if !output.status.success() {
        return Err(remote_file_error(host, "read remote file", &output));
    }
    if output.stdout.len() as u64 > MAX_EDITABLE_FILE_SIZE {
        return Err("file too large (>5 MB)".to_string());
    }
    Ok(output.stdout)
}

fn remote_write_file_for_host(host: &HostConfig, path: &str, content: &[u8]) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("remote path required".to_string());
    }
    if content.len() as u64 > MAX_EDITABLE_FILE_SIZE {
        return Err("file too large (>5 MB)".to_string());
    }
    let output = run_remote_cmd_with_input(
        host,
        &["sh", "-c", REMOTE_WRITE_FILE_SCRIPT, "sh", path],
        content,
    )?;
    if !output.status.success() {
        return Err(remote_file_error(host, "write remote file", &output));
    }
    Ok(())
}

#[tauri::command]
async fn remote_file_exists(host_id: String, path: String) -> Result<bool, String> {
    let host_id = host_id.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let host = find_host(&host_id)?;
        remote_file_exists_for_host(&host, &path)
    })
    .await
    .map_err(|e| format!("remote file check task failed: {e}"))?
}

#[tauri::command]
async fn remote_read_file(host_id: String, path: String) -> Result<String, String> {
    let host_id = host_id.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let host = find_host(&host_id)?;
        let bytes = remote_read_file_bytes_for_host(&host, &path)?;
        String::from_utf8(bytes).map_err(|_| format!("remote file is not UTF-8: {path}"))
    })
    .await
    .map_err(|e| format!("remote file read task failed: {e}"))?
}

#[tauri::command]
async fn remote_read_file_base64(host_id: String, path: String) -> Result<String, String> {
    let host_id = host_id.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let host = find_host(&host_id)?;
        let bytes = remote_read_file_bytes_for_host(&host, &path)?;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    })
    .await
    .map_err(|e| format!("remote image read task failed: {e}"))?
}

#[tauri::command]
async fn remote_write_file(host_id: String, path: String, content: String) -> Result<(), String> {
    let host_id = host_id.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let host = find_host(&host_id)?;
        remote_write_file_for_host(&host, &path, content.as_bytes())
    })
    .await
    .map_err(|e| format!("remote file write task failed: {e}"))?
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

// ── Mobile relay connector ──

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

fn tcp_addr_open(host: &str, port: u16) -> bool {
    let Ok(addrs) = (host, port).to_socket_addrs() else {
        return false;
    };
    addrs
        .into_iter()
        .any(|addr| std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok())
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
        "Failed to start mobile relay serve backend. {}. Install Node.js 20+ and install `tw` from https://github.com/Sskift/tmux-worktree.",
        failures.join("; ")
    ))
}

fn set_mobile_relay_error(state: &MobileRelayState, message: Option<String>) {
    let mut last_error = state.last_error.lock().unwrap();
    *last_error = message;
}

fn stop_managed_serve(state: &MobileRelayState) {
    let mut serve_proc = state.serve_process.lock().unwrap();
    if let Some(ref mut child) = *serve_proc {
        let _ = child.kill();
        let _ = child.wait();
    }
    *serve_proc = None;
}

fn stop_mobile_relay_connector(state: &MobileRelayState) {
    let mut proc = state.process.lock().unwrap();
    if let Some(ref mut child) = *proc {
        let _ = child.kill();
        let _ = child.wait();
    }
    *proc = None;
    let _ = std::fs::remove_file(mobile_relay_status_file());
}

fn stop_mobile_relay_processes(state: &MobileRelayState) {
    stop_mobile_relay_connector(state);
    stop_managed_serve(state);
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MobileRelayStatus {
    active: bool,
    connected: bool,
    connection_state: String,
    relay_url: String,
    host_id: String,
    secret: String,
    token: String,
    connected_at: Option<u64>,
    updated_at: Option<u64>,
    retry_in_ms: Option<u64>,
    error: Option<String>,
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct RelayHostRuntimeStatus {
    state: String,
    relay_url: String,
    host_id: String,
    connected_at: Option<u64>,
    updated_at: Option<u64>,
    retry_in_ms: Option<u64>,
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobileRelayConfigInput {
    relay_url: String,
    host_id: String,
    secret: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobileRelayBrokerInput {
    host_id: String,
    port: Option<u16>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct MobileRelayConfig {
    relay_url: String,
    host_id: String,
    display_name: String,
    secret: String,
}

fn config_string_field(config: &serde_json::Value, fields: &[&str]) -> Option<String> {
    let object = config.as_object()?;
    fields.iter().find_map(|field| {
        object
            .get(*field)
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn mobile_relay_config_from_value(config: &serde_json::Value) -> MobileRelayConfig {
    let relay = config
        .get("mobileRelay")
        .or_else(|| config.get("relay"))
        .unwrap_or(config);
    MobileRelayConfig {
        relay_url: config_string_field(relay, &["relayUrl", "url", "broker", "brokerUrl"])
            .or_else(|| config_string_field(config, &["mobileRelayUrl", "relayUrl"]))
            .unwrap_or_default(),
        host_id: config_string_field(relay, &["hostId", "host", "adminHostId"])
            .or_else(|| config_string_field(config, &["mobileRelayHostId", "relayHostId"]))
            .unwrap_or_default(),
        display_name: config_string_field(relay, &["displayName", "name", "label"])
            .or_else(|| {
                config_string_field(config, &["mobileRelayDisplayName", "relayDisplayName"])
            })
            .unwrap_or_default(),
        secret: config_string_field(relay, &["secret", "token", "relaySecret"])
            .or_else(|| config_string_field(config, &["mobileRelaySecret", "relaySecret"]))
            .unwrap_or_default(),
    }
}

fn load_mobile_relay_config_file() -> MobileRelayConfig {
    let Some(home) = app_home_dir() else {
        return MobileRelayConfig::default();
    };
    let config_path = home.join(".tmux-worktree.json");
    let Ok(content) = std::fs::read_to_string(config_path) else {
        return MobileRelayConfig::default();
    };
    let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) else {
        return MobileRelayConfig::default();
    };
    mobile_relay_config_from_value(&config)
}

fn env_non_empty(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn config_or_default(value: &str, default: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        default.to_string()
    } else {
        trimmed.to_string()
    }
}

fn mobile_relay_config() -> MobileRelayConfig {
    let file = load_mobile_relay_config_file();
    MobileRelayConfig {
        relay_url: env_non_empty("TW_RELAY_URL")
            .unwrap_or_else(|| config_or_default(&file.relay_url, "wss://relay.example.com")),
        host_id: env_non_empty("TW_RELAY_HOST_ID")
            .unwrap_or_else(|| config_or_default(&file.host_id, "mac-admin")),
        display_name: env_non_empty("TW_RELAY_DISPLAY_NAME")
            .unwrap_or_else(|| config_or_default(&file.display_name, "Mac Admin")),
        secret: env_non_empty("TW_RELAY_SECRET").unwrap_or_else(|| file.secret.trim().to_string()),
    }
}

fn save_mobile_relay_config_file(
    args: &MobileRelayConfigInput,
) -> Result<MobileRelayConfig, String> {
    let home = app_home_dir().ok_or("home dir not found")?;
    let config_path = home.join(".tmux-worktree.json");
    let _guard = dashboard_config_write_lock()
        .lock()
        .map_err(|_| "dashboard config write lock poisoned".to_string())?;
    let mut config: serde_json::Value = if config_path.exists() {
        let text =
            std::fs::read_to_string(&config_path).map_err(|e| format!("read config: {e}"))?;
        serde_json::from_str(&text).map_err(|e| format!("parse config: {e}"))?
    } else {
        serde_json::json!({})
    };
    let root = config
        .as_object_mut()
        .ok_or("config root is not an object")?;
    let existing_display_name = root
        .get("mobileRelay")
        .and_then(|value| config_string_field(value, &["displayName", "name", "label"]))
        .unwrap_or_else(|| "Mac Admin".to_string());
    root.insert(
        "mobileRelay".to_string(),
        serde_json::json!({
            "relayUrl": args.relay_url.trim(),
            "hostId": args.host_id.trim(),
            "displayName": existing_display_name,
            "secret": args.secret.trim(),
        }),
    );
    let pretty =
        serde_json::to_string_pretty(&config).map_err(|e| format!("serialize config: {e}"))?;
    atomic_write_file(&config_path, format!("{pretty}\n").as_bytes())
        .map_err(|e| format!("write config: {e}"))?;
    Ok(MobileRelayConfig {
        relay_url: args.relay_url.trim().to_string(),
        host_id: args.host_id.trim().to_string(),
        display_name: existing_display_name,
        secret: args.secret.trim().to_string(),
    })
}

fn mobile_relay_secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn mobile_relay_status_file() -> PathBuf {
    app_home_dir_or_tmp()
        .join(".tmux-worktree")
        .join("mobile-relay-status.json")
}

fn load_mobile_relay_runtime_status() -> Option<RelayHostRuntimeStatus> {
    let content = std::fs::read_to_string(mobile_relay_status_file()).ok()?;
    serde_json::from_str(&content).ok()
}

fn scp_remote_target(host: &HostConfig, remote_path: &str) -> String {
    let target = match &host.user {
        Some(user) => format!("{user}@{}", host.host),
        None => host.host.clone(),
    };
    format!("{target}:{remote_path}")
}

fn scp_cli_to_host(host: &HostConfig, cli: &Path, remote_path: &str) -> Result<(), String> {
    let mut cmd = std::process::Command::new("scp");
    cmd.arg("-q")
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-o")
        .arg("ConnectTimeout=5");
    if let Some(port) = host.port {
        cmd.arg("-P").arg(port.to_string());
    }
    if let Some(key) = &host.identity_file {
        cmd.arg("-i").arg(key);
    }
    cmd.arg(cli).arg(scp_remote_target(host, remote_path));
    let output = cmd.output().map_err(|e| format!("scp spawn: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("scp to {} failed: {}", host.label, stderr.trim()));
    }
    Ok(())
}

fn ssh_target(host: &HostConfig) -> String {
    match &host.user {
        Some(user) => format!("{user}@{}", host.host),
        None => host.host.clone(),
    }
}

fn direct_mobile_relay_url_for_host(host: &HostConfig, port: u16) -> String {
    let target = host.host.trim();
    let host_part = if target.contains(':') && !target.starts_with('[') {
        format!("[{target}]")
    } else {
        target.to_string()
    };
    format!("ws://{host_part}:{port}")
}

fn local_lan_ip() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let addr = socket.local_addr().ok()?;
    let ip = addr.ip();
    if ip.is_loopback() {
        None
    } else {
        Some(ip.to_string())
    }
}

fn normalize_local_mdns_name(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    let name = normalized.trim_end_matches(".local");
    if name.is_empty()
        || name.len() > 63
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return None;
    }
    Some(format!("{name}.local"))
}

fn local_mdns_name() -> Option<String> {
    let output = std::process::Command::new("/usr/sbin/scutil")
        .args(["--get", "LocalHostName"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    normalize_local_mdns_name(&String::from_utf8_lossy(&output.stdout))
}

fn start_mobile_relay_ssh_forward(
    host: &HostConfig,
    bind_host: &str,
    probe_host: &str,
    port: u16,
) -> Result<(), String> {
    if tcp_addr_open(probe_host, port) {
        return Ok(());
    }

    let mut cmd = std::process::Command::new("ssh");
    cmd.arg("-fN")
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ExitOnForwardFailure=yes")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-o")
        .arg("ConnectTimeout=5")
        .arg("-o")
        .arg("ServerAliveInterval=15")
        .arg("-o")
        .arg("ServerAliveCountMax=3")
        .arg("-L")
        .arg(format!("{bind_host}:{port}:127.0.0.1:{port}"));
    if let Some(remote_port) = host.port {
        cmd.arg("-p").arg(remote_port.to_string());
    }
    if let Some(key) = &host.identity_file {
        cmd.arg("-i").arg(key);
    }
    cmd.arg(ssh_target(host));

    let output = cmd
        .output()
        .map_err(|err| format!("ssh forward spawn: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "start relay forward through {} failed: {}",
            host.label,
            stderr.trim()
        ));
    }

    std::thread::sleep(Duration::from_millis(250));
    if tcp_addr_open(probe_host, port) {
        Ok(())
    } else {
        Err(format!(
            "relay forward through {} did not open {}:{}",
            host.label, bind_host, port
        ))
    }
}

fn mobile_relay_forward_url_for_host(host: &HostConfig, port: u16) -> Result<String, String> {
    let advertised_host = local_mdns_name().or_else(local_lan_ip).ok_or_else(|| {
        "could not determine this Mac's local hostname or LAN IP for Android relay URL".to_string()
    })?;
    start_mobile_relay_ssh_forward(host, "0.0.0.0", "127.0.0.1", port)?;
    Ok(format!("ws://{advertised_host}:{port}"))
}

fn should_preserve_mobile_relay_url(current: &str, host: &HostConfig, port: u16) -> bool {
    let trimmed = current.trim();
    !trimmed.is_empty()
        && !trimmed.contains("example.com")
        && trimmed != direct_mobile_relay_url_for_host(host, port)
}

fn start_mobile_relay_broker_on_host(
    app: &tauri::AppHandle,
    host: &HostConfig,
    port: u16,
    secret: &str,
) -> Result<(), String> {
    if port == 0 {
        return Err("relay broker port must be greater than zero".to_string());
    }
    let cli = bundled_cli_path(app).ok_or("bundled CLI resource not found")?;
    run_remote_cmd_check_strings(
        host,
        &[
            "sh".into(),
            "-lc".into(),
            "mkdir -p \"$HOME/.tmux-worktree\"".into(),
        ],
    )?;
    scp_cli_to_host(host, &cli, ".tmux-worktree/tw-cli.js")?;
    let script = format!(
        r#"set -e
mkdir -p "$HOME/.tmux-worktree"
printf %s {} > "$HOME/.tmux-worktree/relay-secret"
chmod 600 "$HOME/.tmux-worktree/relay-secret"
cat > "$HOME/.tmux-worktree/relay-server.sh" <<'EOF'
#!/bin/sh
export TW_RELAY_SECRET="$(cat "$HOME/.tmux-worktree/relay-secret")"
exec /usr/bin/env node "$HOME/.tmux-worktree/tw-cli.js" relay-server --host 0.0.0.0 --port {}
EOF
chmod 700 "$HOME/.tmux-worktree/relay-server.sh"
{} kill-session -t tw-relay-server 2>/dev/null || true
{} new-session -d -s tw-relay-server "$HOME/.tmux-worktree/relay-server.sh"
sleep 1
{} has-session -t tw-relay-server
"#,
        shell_quote(secret),
        port,
        remote_tmux_cmd(host),
        remote_tmux_cmd(host),
        remote_tmux_cmd(host),
    );
    run_remote_cmd_check_strings(host, &["sh".into(), "-lc".into(), script])?;
    Ok(())
}

fn spawn_relay_host(
    app: &tauri::AppHandle,
    relay_url: &str,
    host_id: &str,
    display_name: &str,
    secret: &str,
    token: &str,
) -> Result<std::process::Child, String> {
    let mut failures = Vec::new();
    let status_file = mobile_relay_status_file().to_string_lossy().to_string();
    let args = vec![
        "relay-host".to_string(),
        "--relay".to_string(),
        relay_url.to_string(),
        "--host-id".to_string(),
        host_id.to_string(),
        "--display-name".to_string(),
        display_name.to_string(),
        "--local".to_string(),
        "http://127.0.0.1:8311".to_string(),
        "--status-file".to_string(),
        status_file,
    ];

    if let Some(cli) = bundled_cli_path(app) {
        if let Some(node) = node_bin() {
            let cli_arg = cli.to_string_lossy().to_string();
            let mut command = std::process::Command::new(&node);
            command
                .arg(cli_arg)
                .args(&args)
                .env("TW_RELAY_SECRET", secret)
                .env("TW_TOKEN", token)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            match command.spawn() {
                Ok(child) => return Ok(child),
                Err(err) => failures.push(format!("spawn bundled relay-host: {err}")),
            }
        } else {
            failures.push("Node.js not found for bundled CLI".to_string());
        }
    } else {
        failures.push("bundled CLI resource not found".to_string());
    }

    if let Some(tw) = installed_tw_command() {
        let mut command = std::process::Command::new(&tw);
        command
            .args(&args)
            .env("TW_RELAY_SECRET", secret)
            .env("TW_TOKEN", token)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        match command.spawn() {
            Ok(child) => return Ok(child),
            Err(err) => failures.push(format!("spawn installed relay-host: {err}")),
        }
    } else {
        failures.push("installed tw/tmux-worktree command not found".to_string());
    }

    Err(format!(
        "Failed to start mobile relay connector. {}",
        failures.join("; ")
    ))
}

#[tauri::command]
fn mobile_relay_start(
    app: tauri::AppHandle,
    state: State<'_, Arc<MobileRelayState>>,
) -> Result<(), String> {
    set_mobile_relay_error(state.inner(), None);
    let mut proc = state.process.lock().unwrap();
    if proc.is_some() {
        return Ok(());
    }

    if !tcp_port_open(8311) {
        let child = spawn_serve(&app).map_err(|err| {
            set_mobile_relay_error(state.inner(), Some(err.clone()));
            err
        })?;
        let mut serve = state.serve_process.lock().unwrap();
        *serve = Some(child);
    }

    let tok = read_serve_token();
    {
        let mut t = state.token.lock().unwrap();
        *t = tok.clone();
    }

    let config = mobile_relay_config();
    if config.secret.trim().is_empty() {
        let message = "Relay token is required before Android can connect".to_string();
        set_mobile_relay_error(state.inner(), Some(message.clone()));
        stop_managed_serve(state.inner());
        return Err(message);
    }

    let _ = std::fs::remove_file(mobile_relay_status_file());

    let child = spawn_relay_host(
        &app,
        &config.relay_url,
        &config.host_id,
        &config.display_name,
        &config.secret,
        &tok,
    )
    .map_err(|err| {
        set_mobile_relay_error(state.inner(), Some(err.clone()));
        stop_managed_serve(state.inner());
        err
    })?;

    *state.relay_url.lock().unwrap() = config.relay_url;
    *state.host_id.lock().unwrap() = config.host_id;
    *state.secret.lock().unwrap() = config.secret;
    *proc = Some(child);

    Ok(())
}

#[tauri::command]
fn mobile_relay_save_config(
    args: MobileRelayConfigInput,
    state: State<'_, Arc<MobileRelayState>>,
) -> Result<MobileRelayStatus, String> {
    let config = save_mobile_relay_config_file(&args)?;
    *state.relay_url.lock().unwrap() = config.relay_url;
    *state.host_id.lock().unwrap() = config.host_id;
    *state.secret.lock().unwrap() = config.secret;
    set_mobile_relay_error(state.inner(), None);
    Ok(mobile_relay_status(state))
}

#[tauri::command]
fn mobile_relay_start_broker(
    app: tauri::AppHandle,
    args: MobileRelayBrokerInput,
    state: State<'_, Arc<MobileRelayState>>,
) -> Result<MobileRelayStatus, String> {
    let host = find_host(args.host_id.trim())?;
    let port = args.port.unwrap_or(8787);
    let secret = mobile_relay_secret();
    start_mobile_relay_broker_on_host(&app, &host, port, &secret).map_err(|err| {
        set_mobile_relay_error(state.inner(), Some(err.clone()));
        err
    })?;
    let current_config = mobile_relay_config();
    let relay_url = match mobile_relay_forward_url_for_host(&host, port) {
        Ok(url) => url,
        Err(_) if should_preserve_mobile_relay_url(&current_config.relay_url, &host, port) => {
            current_config.relay_url
        }
        Err(err) => {
            set_mobile_relay_error(state.inner(), Some(err.clone()));
            return Err(err);
        }
    };
    let config = MobileRelayConfigInput {
        relay_url,
        host_id: "mac-admin".to_string(),
        secret,
    };
    let saved = save_mobile_relay_config_file(&config)?;
    *state.relay_url.lock().unwrap() = saved.relay_url;
    *state.host_id.lock().unwrap() = saved.host_id;
    *state.secret.lock().unwrap() = saved.secret;
    set_mobile_relay_error(state.inner(), None);
    Ok(mobile_relay_status(state))
}

#[tauri::command]
fn mobile_relay_stop(state: State<'_, Arc<MobileRelayState>>) -> Result<(), String> {
    stop_mobile_relay_processes(state.inner());
    set_mobile_relay_error(state.inner(), None);
    Ok(())
}

#[tauri::command]
fn mobile_relay_status(state: State<'_, Arc<MobileRelayState>>) -> MobileRelayStatus {
    let mut proc = state.process.lock().unwrap();
    let mut process_error = None;
    if let Some(ref mut child) = *proc {
        match child.try_wait() {
            Ok(Some(status)) => {
                *proc = None;
                process_error = Some(format!("Mobile relay connector exited: {status}"));
            }
            _ => {}
        }
    }
    if let Some(message) = process_error {
        set_mobile_relay_error(state.inner(), Some(message));
    }
    let active = proc.is_some();
    let default_config = mobile_relay_config();
    let relay_url = state.relay_url.lock().unwrap();
    let host_id = state.host_id.lock().unwrap();
    let secret = state.secret.lock().unwrap();
    let token = state.token.lock().unwrap();
    let resolved_relay_url = if relay_url.is_empty() {
        default_config.relay_url
    } else {
        relay_url.clone()
    };
    let resolved_host_id = if host_id.is_empty() {
        default_config.host_id
    } else {
        host_id.clone()
    };
    let runtime = active
        .then(load_mobile_relay_runtime_status)
        .flatten()
        .filter(|status| {
            status.relay_url == resolved_relay_url && status.host_id == resolved_host_id
        });
    let connection_state = if !active {
        "stopped".to_string()
    } else {
        runtime
            .as_ref()
            .map(|status| status.state.clone())
            .filter(|status| !status.is_empty())
            .unwrap_or_else(|| "starting".to_string())
    };
    let connected = active && connection_state == "connected";
    let runtime_error = runtime.as_ref().and_then(|status| status.error.clone());
    let error = state.last_error.lock().unwrap().clone().or(runtime_error);
    MobileRelayStatus {
        active,
        connected,
        connection_state,
        relay_url: resolved_relay_url,
        host_id: resolved_host_id,
        secret: if secret.is_empty() {
            default_config.secret
        } else {
            secret.clone()
        },
        token: token.clone(),
        connected_at: runtime.as_ref().and_then(|status| status.connected_at),
        updated_at: runtime.as_ref().and_then(|status| status.updated_at),
        retry_in_ms: runtime.as_ref().and_then(|status| status.retry_in_ms),
        error,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    inherit_shell_env();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(Arc::new(PtyState::default()));
            app.manage(Arc::new(MobileRelayState::default()));
            app.manage(Arc::new(GitFetchState::default()));
            app.manage(Arc::new(HostState::default()));
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
            copy_mode_cancel_if_active,
            apply_tmux_theme,
            copy_tmux_selection,
            capture_pane_history,
            git_status,
            git_fetch_project_roots,
            git_log,
            git_diff,
            list_tmux_terminals,
            create_terminal,
            create_plain_terminal,
            ensure_terminal_session,
            kill_plain_terminal,
            load_terminals,
            save_terminals,
            load_layout,
            save_layout,
            list_automations,
            save_automation,
            delete_automation,
            trigger_automation,
            list_automation_runs,
            home_dir,
            pty_open,
            pty_write,
            pty_resize,
            pty_kill,
            read_dir,
            read_file,
            write_file,
            remote_read_file,
            remote_read_file_base64,
            remote_write_file,
            search_files,
            open_url,
            file_exists,
            remote_file_exists,
            list_hosts,
            list_ssh_host_candidates,
            add_host,
            update_host,
            remove_host,
            test_host,
            install_host_tw,
            host_statuses,
            list_remote_projects,
            remote_home_dir,
            remote_read_dir,
            mobile_relay_start,
            mobile_relay_start_broker,
            mobile_relay_save_config,
            mobile_relay_stop,
            mobile_relay_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                cleanup_pending_worktrees();
                let relay_state = app.state::<Arc<MobileRelayState>>();
                stop_mobile_relay_processes(relay_state.inner().as_ref());
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::{
        add_host_with_state, agent_running_from_pane_title, append_automation_run,
        atomic_write_file_with, automation_command_with_instruction, cleanup_pending_worktrees,
        config_worktree_base, config_worktree_base_with_home, create_remote_worktree,
        create_terminal, create_worktree, delete_automation_from_list, delete_worktree,
        derive_session_name, ensure_terminal_session, fetchable_project_paths,
        finish_git_fetch_target, git_fetch_args, hosts_from_config, install_host_tw,
        invalidate_host_status_cache, is_git_worktree_dir, is_managed_worktree_session,
        kill_plain_terminal, kill_session, layout_backup_path, layout_schema_version,
        list_automation_runs, list_remote_sessions, list_remote_tmux_terminals, load_hosts,
        load_pending_cleanup, mobile_relay_config_from_value, normalize_local_mdns_name,
        orphaned_worktrees, parse_session_key, project_from_config, project_from_worktree_path,
        projects_from_config, projects_from_config_with_home, remote_file_exists_for_host,
        remote_home_dir_for_host, remote_read_dirs_for_host, remote_read_file_bytes_for_host,
        remote_write_file_for_host, remove_host_with_state, reserve_git_fetch_target,
        restore_worktree, run_check, run_remote_tmux_check, run_remote_tw_check, save_automation,
        save_hosts_config, save_layout, save_pending_cleanup, should_skip_automation_overlap,
        ssh_host_candidates_from_config_text, stable_output_signature, test_host,
        tmux_session_exists, trigger_automation, try_cleanup_worktree, update_host_config,
        upsert_automation_from_input, worktree_has_uncommitted_changes, worktrees_for_session,
        AddHostArgs, Automation, AutomationOverlap, AutomationRun, AutomationStatus,
        AutomationTriggerType, CachedHostStatus, CreateArgs, CreateTerminalArgs,
        DeleteWorktreeArgs, EnsureTerminalArgs, GitFetchTracker, HostConfig, HostState, HostStatus,
        OrphanedWorktree, Project, RestoreArgs, SaveAutomationInput, UpdateHostArgs,
        AUTOMATION_RUN_LIMIT, GIT_FETCH_INTERVAL_SECONDS,
    };
    use std::collections::HashSet;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::sync::{Mutex, OnceLock};
    use std::time::Instant;

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

    fn restore_env(name: &str, value: Option<String>) {
        if let Some(value) = value {
            unsafe {
                std::env::set_var(name, value);
            }
        } else {
            unsafe {
                std::env::remove_var(name);
            }
        }
    }

    #[test]
    fn remote_commands_use_configured_tmux_and_tw_paths() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"
case "$1" in
  *'.local/bin/tmux'*'has-session'*)
    exit 0
    ;;
  *'TW_TMUX='*'.local/bin/tmux'*'.local/bin/tw'*'version'*)
    printf '0.12.6\n'
    exit 0
    ;;
esac
printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
        }

        let host = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: Some("~/.local/bin/tmux".to_string()),
            tw_path: Some("~/.local/bin/tw".to_string()),
        };

        run_remote_tmux_check(&host, &["has-session", "-t", "=x-cloud"]).expect("configured tmux");
        let version = run_remote_tw_check(&host, &["version"]).expect("configured tw");

        assert_eq!(version, "0.12.6");
        let log = fs::read_to_string(&log_path).expect("ssh log");
        assert!(log.contains("$HOME/.local/bin/tmux"), "ssh log:\n{log}");
        assert!(log.contains("$HOME/.local/bin/tw"), "ssh log:\n{log}");
        assert!(log.contains("TW_TMUX="), "ssh log:\n{log}");

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
    }

    fn sample_automation() -> Automation {
        Automation {
            id: "auto-1".to_string(),
            name: "Nightly".to_string(),
            enabled: true,
            trigger_type: AutomationTriggerType::Manual,
            schedule: None,
            timezone: None,
            project: None,
            path: Some("/repo/app".to_string()),
            ai_cmd: "codex".to_string(),
            instruction: String::new(),
            overlap: AutomationOverlap::Queue,
            last_run_at: None,
            last_status: AutomationStatus::Idle,
            last_session: None,
            created_at: "2026-06-11T00:00:00Z".to_string(),
            updated_at: "2026-06-11T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn stable_output_signature_is_deterministic_and_content_sensitive() {
        let first = stable_output_signature("agent output\nline 2");
        let second = stable_output_signature("agent output\nline 2");
        let changed = stable_output_signature("agent output\nline 3");

        assert_eq!(first, second);
        assert_ne!(first, changed);
        assert_eq!(first.len(), 16);
    }

    #[test]
    fn fetchable_project_paths_dedupes_configured_git_roots() {
        let temp = tempfile::tempdir().expect("tempdir");
        let repo = temp.path().join("repo");
        let non_repo = temp.path().join("not-git");
        fs::create_dir_all(&repo).expect("repo");
        fs::create_dir_all(&non_repo).expect("non repo");
        git(&["init", repo.to_str().expect("repo str")]);

        let repo_path = repo.to_string_lossy().to_string();
        let projects = vec![
            Project {
                name: "repo".to_string(),
                path: repo_path.clone(),
                branch: None,
            },
            Project {
                name: "repo-duplicate".to_string(),
                path: format!("{repo_path}/"),
                branch: None,
            },
            Project {
                name: "not-git".to_string(),
                path: non_repo.to_string_lossy().to_string(),
                branch: None,
            },
            Project {
                name: "blank".to_string(),
                path: " ".to_string(),
                branch: None,
            },
        ];

        let expected = std::fs::canonicalize(&repo)
            .expect("canonical repo")
            .to_string_lossy()
            .to_string();
        assert_eq!(fetchable_project_paths(&projects), vec![expected]);
    }

    #[test]
    fn reserve_git_fetch_target_throttles_and_tracks_in_flight_fetches() {
        let mut tracker = GitFetchTracker::default();

        assert!(reserve_git_fetch_target(&mut tracker, "/repo", 100));
        assert!(!reserve_git_fetch_target(&mut tracker, "/repo", 101));

        finish_git_fetch_target(&mut tracker, "/repo");

        assert!(!reserve_git_fetch_target(
            &mut tracker,
            "/repo",
            100 + GIT_FETCH_INTERVAL_SECONDS - 1,
        ));
        assert!(reserve_git_fetch_target(
            &mut tracker,
            "/repo",
            100 + GIT_FETCH_INTERVAL_SECONDS,
        ));
    }

    #[test]
    fn git_fetch_args_runs_fetch_from_the_project_root() {
        assert_eq!(
            git_fetch_args("/repo/root"),
            ["-C", "/repo/root", "fetch", "--all", "--prune", "--quiet"],
        );
    }

    #[test]
    fn agent_running_from_pane_title_detects_codex_spinner_prefix() {
        assert!(agent_running_from_pane_title("⠴ money-run-goal-e8654"));
        assert!(agent_running_from_pane_title(" ⠇ another-worktree"));
        assert!(!agent_running_from_pane_title("x-pipeline-bf6d9"));
        assert!(!agent_running_from_pane_title("⠴not-a-status-prefix"));
    }

    #[test]
    fn automation_serializes_with_frontend_contract_field_names() {
        let automation = Automation {
            trigger_type: AutomationTriggerType::Schedule,
            schedule: Some("0 9 * * *".to_string()),
            timezone: Some("Asia/Shanghai".to_string()),
            project: Some("dashboard".to_string()),
            path: None,
            ai_cmd: "claude".to_string(),
            instruction: "Summarize failures".to_string(),
            overlap: AutomationOverlap::Skip,
            last_run_at: Some("2026-06-11T01:00:00Z".to_string()),
            last_status: AutomationStatus::Running,
            last_session: Some("dashboard-nightly".to_string()),
            ..sample_automation()
        };

        let value = serde_json::to_value(&automation).expect("serialize automation");

        assert_eq!(value["id"], "auto-1");
        assert_eq!(value["triggerType"], "schedule");
        assert_eq!(value["aiCmd"], "claude");
        assert_eq!(value["lastRunAt"], "2026-06-11T01:00:00Z");
        assert_eq!(value["lastStatus"], "running");
        assert_eq!(value["lastSession"], "dashboard-nightly");
        assert_eq!(value["createdAt"], "2026-06-11T00:00:00Z");
        assert_eq!(value["updatedAt"], "2026-06-11T00:00:00Z");
    }

    #[test]
    fn upsert_automation_defaults_create_and_preserves_created_at_on_update() {
        let created = upsert_automation_from_input(
            Vec::new(),
            SaveAutomationInput {
                id: Some("auto-1".to_string()),
                name: Some("Nightly".to_string()),
                path: Some(Some("/repo/app".to_string())),
                ai_cmd: Some("codex".to_string()),
                ..Default::default()
            },
            "2026-06-11T00:00:00Z",
        )
        .expect("create automation");

        assert_eq!(created.automation.id, "auto-1");
        assert_eq!(created.automation.name, "Nightly");
        assert!(created.automation.enabled);
        assert_eq!(
            created.automation.trigger_type,
            AutomationTriggerType::Manual
        );
        assert_eq!(created.automation.path.as_deref(), Some("/repo/app"));
        assert_eq!(created.automation.ai_cmd, "codex");
        assert_eq!(created.automation.overlap, AutomationOverlap::Queue);
        assert_eq!(created.automation.last_status, AutomationStatus::Idle);
        assert_eq!(created.automation.created_at, "2026-06-11T00:00:00Z");
        assert_eq!(created.automation.updated_at, "2026-06-11T00:00:00Z");

        let updated = upsert_automation_from_input(
            created.automations,
            SaveAutomationInput {
                id: Some("auto-1".to_string()),
                name: Some("Weekday schedule".to_string()),
                trigger_type: Some(AutomationTriggerType::Schedule),
                schedule: Some(Some("0 9 * * 1-5".to_string())),
                timezone: Some(Some("Asia/Shanghai".to_string())),
                overlap: Some(AutomationOverlap::Skip),
                ..Default::default()
            },
            "2026-06-11T02:00:00Z",
        )
        .expect("update automation");

        assert_eq!(updated.automations.len(), 1);
        assert_eq!(updated.automation.name, "Weekday schedule");
        assert_eq!(
            updated.automation.trigger_type,
            AutomationTriggerType::Schedule
        );
        assert_eq!(updated.automation.schedule.as_deref(), Some("0 9 * * 1-5"));
        assert_eq!(
            updated.automation.timezone.as_deref(),
            Some("Asia/Shanghai")
        );
        assert_eq!(updated.automation.overlap, AutomationOverlap::Skip);
        assert_eq!(updated.automation.ai_cmd, "codex");
        assert_eq!(updated.automation.created_at, "2026-06-11T00:00:00Z");
        assert_eq!(updated.automation.updated_at, "2026-06-11T02:00:00Z");
    }

    #[test]
    fn delete_automation_from_list_removes_only_matching_id() {
        let other = Automation {
            id: "auto-2".to_string(),
            name: "Other".to_string(),
            ..sample_automation()
        };

        let remaining = delete_automation_from_list(vec![sample_automation(), other], "auto-1");

        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, "auto-2");
    }

    #[test]
    fn automation_command_shell_quotes_non_empty_instruction() {
        let command =
            automation_command_with_instruction("codex", "Fix Bob's bug && rm -rf /tmp/demo");

        assert_eq!(command, "codex 'Fix Bob'\\''s bug && rm -rf /tmp/demo'");
        assert_eq!(automation_command_with_instruction("codex", "  "), "codex");
    }

    #[test]
    fn overlap_skip_requires_running_or_queued_status_with_live_session() {
        let running = Automation {
            overlap: AutomationOverlap::Skip,
            last_status: AutomationStatus::Running,
            last_session: Some("dashboard-nightly".to_string()),
            ..sample_automation()
        };
        let queued = Automation {
            last_status: AutomationStatus::Queued,
            ..running.clone()
        };
        let failed = Automation {
            last_status: AutomationStatus::Failed,
            ..running.clone()
        };

        assert!(should_skip_automation_overlap(&running, true));
        assert!(should_skip_automation_overlap(&queued, true));
        assert!(!should_skip_automation_overlap(&running, false));
        assert!(!should_skip_automation_overlap(&failed, true));
        assert!(!should_skip_automation_overlap(
            &Automation {
                overlap: AutomationOverlap::Queue,
                ..running
            },
            true,
        ));
    }

    #[test]
    fn append_automation_run_keeps_newest_first_and_bounded() {
        let mut runs = (0..AUTOMATION_RUN_LIMIT)
            .map(|index| AutomationRun {
                id: format!("run-{index}"),
                automation_id: "auto-1".to_string(),
                started_at: format!("2026-06-11T00:{index:02}:00Z"),
                finished_at: None,
                status: AutomationStatus::Running,
                session_name: None,
                error: None,
            })
            .collect::<Vec<_>>();
        let newest = AutomationRun {
            id: "run-new".to_string(),
            automation_id: "auto-1".to_string(),
            started_at: "2026-06-11T02:00:00Z".to_string(),
            finished_at: Some("2026-06-11T02:01:00Z".to_string()),
            status: AutomationStatus::Failed,
            session_name: Some("dashboard-nightly".to_string()),
            error: Some("start failed".to_string()),
        };

        append_automation_run(&mut runs, newest.clone());

        assert_eq!(runs.len(), AUTOMATION_RUN_LIMIT);
        assert_eq!(runs[0], newest);
        assert_eq!(runs.last().expect("last").id, "run-198");
    }

    #[test]
    #[ignore = "starts a real tmux session and git worktree; run manually for smoke validation"]
    fn automation_trigger_smoke_creates_real_tmux_session_and_run_record() {
        let _guard = test_env_lock().lock().expect("lock");
        if std::process::Command::new("tmux")
            .arg("-V")
            .status()
            .map(|status| !status.success())
            .unwrap_or(true)
        {
            panic!("tmux is required for automation smoke validation");
        }

        let original_home = std::env::var("HOME").ok();
        let original_dashboard_home = std::env::var("TW_DASHBOARD_HOME").ok();
        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("home");
        let remote = temp.path().join("remote.git");
        let repo = temp.path().join("repo");
        let worktree_base = temp.path().join("worktrees");
        let marker = temp.path().join("automation-smoke-marker");
        fs::create_dir_all(&home).expect("home");

        git(&["init", "--bare", remote.to_str().expect("remote str")]);
        git(&[
            "clone",
            remote.to_str().expect("remote str"),
            repo.to_str().expect("repo str"),
        ]);
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
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "branch",
            "-M",
            "main",
        ]);
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "push",
            "-u",
            "origin",
            "main",
        ]);

        let config = serde_json::json!({
            "projects": {
                "smoke": repo.to_string_lossy()
            },
            "worktreeBase": worktree_base.to_string_lossy()
        });
        fs::write(
            home.join(".tmux-worktree.json"),
            serde_json::to_string_pretty(&config).expect("config json"),
        )
        .expect("write config");

        unsafe {
            std::env::set_var("TW_DASHBOARD_HOME", &home);
            std::env::set_var("HOME", &home);
        }

        let saved = save_automation(SaveAutomationInput {
            id: Some("auto-smoke".to_string()),
            name: Some("Smoke".to_string()),
            enabled: Some(true),
            trigger_type: Some(AutomationTriggerType::Manual),
            schedule: Some(None),
            timezone: Some(None),
            project: Some(Some("smoke".to_string())),
            path: Some(None),
            ai_cmd: Some(format!("touch {}", marker.to_string_lossy())),
            instruction: Some(String::new()),
            overlap: Some(AutomationOverlap::Skip),
        })
        .expect("save automation");

        let run = trigger_automation(saved.id.clone()).expect("trigger automation");
        let session = run.session_name.clone().expect("session name");
        assert_eq!(run.status, AutomationStatus::Running);
        assert!(tmux_session_exists(session.clone()).expect("tmux session exists check"));

        for _ in 0..20 {
            if marker.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        assert!(marker.exists(), "automation command did not create marker");

        let runs = list_automation_runs(Some(saved.id.clone())).expect("list runs");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].id, run.id);
        assert_eq!(runs[0].status, AutomationStatus::Running);

        let cwd = run_check(&[
            "tmux",
            "display-message",
            "-p",
            "-t",
            &session,
            "#{pane_current_path}",
        ])
        .expect("pane cwd");
        assert!(Path::new(&cwd).join(".git").exists());

        let _ = std::process::Command::new("tmux")
            .args(["kill-session", "-t", &format!("={session}")])
            .status();

        restore_env("TW_DASHBOARD_HOME", original_dashboard_home);
        restore_env("HOME", original_home);
    }

    #[test]
    fn derive_session_name_strips_random_suffix() {
        assert_eq!(derive_session_name("demo-abc12"), "demo");
        assert_eq!(derive_session_name("demo"), "demo");
        assert_eq!(derive_session_name("demo-nothex"), "demo-nothex");
    }

    #[test]
    fn project_from_worktree_path_reads_project_segment() {
        assert_eq!(
            project_from_worktree_path(
                "/tmp/tmux-worktree/projects/coco/fix-auth-abc12",
                "/tmp/tmux-worktree/projects",
            )
            .as_deref(),
            Some("coco"),
        );
        assert_eq!(
            project_from_worktree_path(
                "/home/dev/.tmux-worktree/worktrees/api/refactor-def34",
                "/tmp/other",
            )
            .as_deref(),
            Some("api"),
        );
    }

    #[test]
    fn managed_worktree_session_requires_tw_name_and_git_worktree_shape() {
        let temp = tempfile::tempdir().expect("tempdir");
        let base = temp.path().join("worktrees");
        let project = base.join("demo");
        let managed = project.join("demo-task-abc12");
        let plain = project.join("demo-task");
        let mismatched = project.join("other-task-abc12");
        fs::create_dir_all(&managed).expect("managed");
        fs::create_dir_all(&plain).expect("plain");
        fs::create_dir_all(&mismatched).expect("mismatched");
        fs::write(
            managed.join(".git"),
            "gitdir: /repo/.git/worktrees/demo-task-abc12",
        )
        .expect("managed git file");
        fs::write(plain.join(".git"), "gitdir: /repo/.git/worktrees/demo-task")
            .expect("plain git file");
        fs::write(
            mismatched.join(".git"),
            "gitdir: /repo/.git/worktrees/other-task-abc12",
        )
        .expect("mismatched git file");

        let base = base.to_string_lossy().to_string();
        assert!(is_managed_worktree_session(
            "demo-task",
            managed.to_str().expect("managed path"),
            &base,
        ));
        assert!(!is_managed_worktree_session(
            "demo-task",
            plain.to_str().expect("plain path"),
            &base,
        ));
        assert!(!is_managed_worktree_session(
            "demo-task",
            mismatched.to_str().expect("mismatched path"),
            &base,
        ));
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
    fn config_parses_remote_home_relative_paths() {
        let config = serde_json::json!({
            "projects": {
                "demo": { "directory": "~/code/demo", "defaultBranch": "develop" }
            },
            "worktreeBase": "~/.tmux-worktree/worktrees"
        });

        let projects = projects_from_config_with_home(&config, Some("/data/home/dev"));
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "demo");
        assert_eq!(projects[0].path, "/data/home/dev/code/demo");
        assert_eq!(projects[0].branch.as_deref(), Some("develop"));
        assert_eq!(
            config_worktree_base_with_home(&config, Some("/data/home/dev")).as_deref(),
            Some("/data/home/dev/.tmux-worktree/worktrees")
        );
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
    fn worktree_dirty_check_detects_untracked_changes() {
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

        let worktree = temp.path().join("wt-clean");
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "worktree",
            "add",
            "-b",
            "dirty-check",
            worktree.to_str().expect("worktree str"),
        ]);
        let path = worktree.to_string_lossy().to_string();

        assert_eq!(worktree_has_uncommitted_changes(&path), Some(false));
        fs::write(worktree.join("dirty.txt"), "uncommitted\n").expect("dirty file");
        assert_eq!(worktree_has_uncommitted_changes(&path), Some(true));
    }

    #[test]
    fn create_worktree_starts_dashboard_single_pane_session() {
        let _guard = test_env_lock().lock().expect("lock");
        let original_home = std::env::var("HOME").ok();
        let original_tw_home = std::env::var("TW_DASHBOARD_HOME").ok();

        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("home");
        let base = temp.path().join("worktrees");
        let remote = temp.path().join("remote.git");
        let repo = temp.path().join("repo");
        fs::create_dir_all(&home).expect("home");
        fs::create_dir_all(&base).expect("base");

        git(&["init", "--bare", remote.to_str().expect("remote str")]);
        git(&[
            "clone",
            remote.to_str().expect("remote str"),
            repo.to_str().expect("repo str"),
        ]);
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "checkout",
            "-b",
            "main",
        ]);
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
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "push",
            "-u",
            "origin",
            "main",
        ]);

        fs::write(
            home.join(".tmux-worktree.json"),
            serde_json::json!({
                "projects": {
                    "demo": {
                        "path": repo,
                        "branch": "main"
                    }
                },
                "worktreeBase": base
            })
            .to_string(),
        )
        .expect("config");

        unsafe {
            std::env::set_var("HOME", &home);
            std::env::set_var("TW_DASHBOARD_HOME", &home);
        }

        let marker = temp.path().join("ai-started");
        let session = create_worktree(CreateArgs {
            project: Some("demo".to_string()),
            path: None,
            ai_cmd: format!("touch {}", marker.to_string_lossy()),
            name: Some("layout".to_string()),
            branch: Some("main".to_string()),
            host_id: None,
        })
        .expect("create worktree");

        let project_worktrees = fs::read_dir(base.join("demo"))
            .expect("worktree project dir")
            .collect::<Result<Vec<_>, _>>()
            .expect("worktree entries");
        assert_eq!(project_worktrees.len(), 1);
        let worktree_path = project_worktrees[0].path();
        assert!(worktree_path.join(".git").exists());

        for _ in 0..20 {
            if marker.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        let ai_started = marker.exists();

        let output = std::process::Command::new("tmux")
            .args([
                "list-panes",
                "-t",
                &format!("={session}"),
                "-F",
                "#{pane_current_path}",
            ])
            .output()
            .expect("tmux list-panes");
        assert!(
            output.status.success(),
            "tmux list-panes failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let panes = String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::to_string)
            .collect::<Vec<_>>();
        let pane_count = panes.len();
        let expected_cwd = fs::canonicalize(&worktree_path).expect("canonical worktree");
        let pane_cwds = panes
            .iter()
            .map(|cwd| fs::canonicalize(cwd).unwrap_or_else(|_| cwd.into()))
            .collect::<Vec<_>>();
        let panes_in_worktree = pane_cwds.iter().filter(|cwd| *cwd == &expected_cwd).count();

        let _ = std::process::Command::new("tmux")
            .args(["kill-session", "-t", &format!("={session}")])
            .status();
        restore_env("TW_DASHBOARD_HOME", original_tw_home);
        restore_env("HOME", original_home);

        assert_eq!(
            pane_count, 1,
            "dashboard-created worktrees should use a single tmux pane because Dashboard owns the layout"
        );
        assert!(
            ai_started,
            "AI command should start inside the new worktree"
        );
        assert!(
            panes_in_worktree == 1,
            "the Dashboard pane should start in the new worktree: {panes:?}"
        );
    }

    #[test]
    fn restore_worktree_starts_command_as_dashboard_pane_command() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let worktree = temp.path().join("restore-wt");
        fs::create_dir_all(&worktree).expect("worktree");
        let marker = temp.path().join("restore-started");
        let session_name = format!("restore-{}", uuid::Uuid::new_v4().simple());
        let session_name: String = session_name.chars().take(20).collect();

        let session = restore_worktree(RestoreArgs {
            path: worktree.to_string_lossy().to_string(),
            name: session_name,
            ai_cmd: format!("touch {}", marker.to_string_lossy()),
        })
        .expect("restore worktree");

        for _ in 0..20 {
            if marker.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }

        let output = std::process::Command::new("tmux")
            .args([
                "list-panes",
                "-t",
                &format!("={session}"),
                "-F",
                "#{pane_start_command}",
            ])
            .output()
            .expect("tmux list-panes");
        assert!(
            output.status.success(),
            "tmux list-panes failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let pane_commands = String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::to_string)
            .collect::<Vec<_>>();

        let _ = std::process::Command::new("tmux")
            .args(["kill-session", "-t", &format!("={session}")])
            .status();

        assert_eq!(pane_commands.len(), 1);
        assert!(marker.exists(), "restored AI command should run");
        assert!(
            pane_commands[0].contains("restore-started"),
            "restored worktree should start AI as the pane command, not inject it later: {pane_commands:?}"
        );
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

    #[test]
    fn create_remote_worktree_starts_plain_session_with_single_tmux_prefix() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"
if [ "$#" -eq 1 ]; then
  case "$1" in
    *"'tw'"*"'rpc'"*"'create-worktree'"*)
      printf 'tw: command not found\n' >&2
      exit 127
      ;;
    *"'tmux'"*"'has-session'"*)
      exit 1
      ;;
    *"'git'"*"'rev-parse'"*)
      exit 1
      ;;
    *"'tmux'"*"'new-session'"*)
      exit 0
      ;;
  esac
fi
if [ "$1" = "tmux" ] && [ "$2" = "has-session" ]; then
  exit 1
fi
if [ "$1" = "git" ] && [ "$4" = "rev-parse" ]; then
  exit 1
fi
if [ "$1" = "tmux" ] && [ "$2" = "new-session" ]; then
  exit 0
fi
printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
        }

        let host = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: Some("/tmp/tmux-worktree/projects".to_string()),
            tmux_path: None,
            tw_path: None,
        };
        let session = create_remote_worktree(
            &host,
            CreateArgs {
                project: None,
                path: Some("/remote/app".to_string()),
                ai_cmd: "echo ready".to_string(),
                name: None,
                branch: None,
                host_id: Some("dev".to_string()),
            },
        )
        .expect("remote worktree session");

        assert_eq!(session, "dev:app");
        let log = fs::read_to_string(&log_path).expect("ssh log");
        assert!(log.contains("'git' '-C' '/remote/app' 'rev-parse' '--is-inside-work-tree'"));
        assert!(log.contains("'tmux' 'has-session' '-t' '=app'"));
        assert!(log.contains("'tmux' 'new-session' '-d' '-s' 'app' '-c' '/remote/app'"));
        assert!(!log.contains("'tmux' 'tmux'"));
        assert!(!log.contains("'tmux' 'git'"));

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
    }

    #[test]
    fn create_remote_worktree_fallback_uses_remote_config_project() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"

if [ "$#" -eq 1 ]; then
  case "$1" in
    *"'tw'"*"'rpc'"*"'create-worktree'"*)
      printf 'tw: command not found\n' >&2
      exit 127
      ;;
    *'pwd -P'*)
      printf '/home/dev'
      exit 0
      ;;
    *'.tmux-worktree.json'*)
      cat <<'JSON'
{"projects":{"demo":{"directory":"~/src/demo","defaultBranch":"develop"}},"worktreeBase":"~/.tmux-worktree/worktrees"}
JSON
      exit 0
      ;;
    *"'tmux'"*"'has-session'"*)
      exit 1
      ;;
    *"'git'"*"'rev-parse'"*)
      printf 'true\n'
      exit 0
      ;;
    *"'mkdir'"*|*"'git'"*"'fetch'"*|*"'git'"*"'worktree'"*"'add'"*|*"'tmux'"*"'new-session'"*)
      exit 0
      ;;
  esac
fi

printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
        }

        let host = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        };
        let session = create_remote_worktree(
            &host,
            CreateArgs {
                project: Some("demo".to_string()),
                path: None,
                ai_cmd: "codex".to_string(),
                name: Some("fix".to_string()),
                branch: None,
                host_id: Some("dev".to_string()),
            },
        )
        .expect("remote config worktree session");

        assert_eq!(session, "dev:demo-fix");
        let log = fs::read_to_string(&log_path).expect("ssh log");
        assert!(log.contains("'--path' '/home/dev/src/demo'"));
        assert!(log.contains("'--project' 'demo'"));
        assert!(log.contains("'--branch' 'develop'"));
        assert!(
            log.contains("'git' '-C' '/home/dev/src/demo' 'fetch' 'origin' 'develop' '--quiet'")
        );
        assert!(log.contains("'mkdir' '-p' '/home/dev/.tmux-worktree/worktrees/demo'"));
        assert!(log.contains("'/home/dev/.tmux-worktree/worktrees/demo/demo-fix-"));
        assert!(log.contains("'tmux' 'new-session' '-d' '-s' 'demo-fix' '-c' '/home/dev/.tmux-worktree/worktrees/demo/demo-fix-"));

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
    }

    #[test]
    fn create_remote_worktree_prefers_remote_tw_rpc() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"

if [ "$#" -eq 1 ]; then
  case "$1" in
    *"'tw'"*"'rpc'"*"'create-worktree'"*)
      cat <<'JSON'
{"protocolVersion":1,"session":"app-fix","kind":"worktree"}
JSON
      exit 0
      ;;
    *"'git'"*|*"'tmux'"*)
      printf 'dashboard should not run git/tmux directly when tw rpc create-worktree works\n' >&2
      exit 12
      ;;
  esac
fi

printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
        }

        let host = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        };
        let session = create_remote_worktree(
            &host,
            CreateArgs {
                project: None,
                path: Some("/remote/app".to_string()),
                ai_cmd: "codex".to_string(),
                name: Some("fix".to_string()),
                branch: Some("develop".to_string()),
                host_id: Some("dev".to_string()),
            },
        )
        .expect("remote tw rpc worktree session");

        assert_eq!(session, "dev:app-fix");
        let log = fs::read_to_string(&log_path).expect("ssh log");
        assert!(log.contains("'tw' 'rpc' 'create-worktree'"));
        assert!(log.contains("'--path' '/remote/app'"));
        assert!(log.contains("'--project' 'app'"));
        assert!(log.contains("'--ai-command' 'codex'"));
        assert!(log.contains("'--name' 'fix'"));
        assert!(log.contains("'--branch' 'develop'"));
        assert!(!log.contains("'git'"));
        assert!(!log.contains("'tmux'"));

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
    }

    #[test]
    fn create_remote_worktree_does_not_fallback_when_remote_tw_rejects_create() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"

if [ "$#" -eq 1 ]; then
  case "$1" in
    *"'tw'"*"'rpc'"*"'create-worktree'"*)
      printf 'remote tw rejected request\n' >&2
      exit 9
      ;;
    *"'git'"*|*"'tmux'"*)
      printf 'dashboard should not bypass a present remote tw binary\n' >&2
      exit 12
      ;;
  esac
fi

printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
        }

        let host = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        };
        let err = create_remote_worktree(
            &host,
            CreateArgs {
                project: None,
                path: Some("/remote/app".to_string()),
                ai_cmd: "codex".to_string(),
                name: Some("fix".to_string()),
                branch: None,
                host_id: Some("dev".to_string()),
            },
        )
        .expect_err("remote tw rejection should be returned");

        let log = fs::read_to_string(&log_path).expect("ssh log");
        assert!(err.contains("remote tw rejected request"), "{err}");
        assert!(log.contains("'tw' 'rpc' 'create-worktree'"));
        assert!(!log.contains("'git'"));
        assert!(!log.contains("'tmux'"));

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
    }

    #[test]
    fn list_remote_sessions_quotes_tmux_format_for_remote_shell() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"

if [ "$#" -eq 1 ]; then
  case "$1" in
    *"'tmux'"*"'list-sessions'"*"'#{session_name}"*)
      printf 'dev-session\0370\0371\03710\03720\n'
      exit 0
      ;;
    *"tmux capture-pane"*)
      printf 'dev-session\037123:45\037 ⠇ dev-session\n'
      exit 0
      ;;
    *"'tmux'"*"'display-message'"*"'=dev-session:'"*)
      printf '/remote/worktrees/dev-session-abc12\n'
      exit 0
      ;;
    *"'git'"*"'rev-parse'"*"'--show-toplevel'"*)
      printf '/remote/worktrees/dev-session-abc12\n'
      exit 0
      ;;
  esac
fi

if [ "$1" = "tmux" ] && [ "$2" = "list-sessions" ] && [ "$3" = "-F" ]; then
  printf 'tmux: option requires an argument -- F\n' >&2
  exit 1
fi

printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
        }

        let host = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        };

        let sessions = list_remote_sessions(&host).expect("remote sessions");

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].name, "dev:dev-session");
        assert_eq!(sessions[0].host_id.as_deref(), Some("dev"));
        assert_eq!(sessions[0].raw_name, "dev-session");
        assert_eq!(
            sessions[0].output_signature.as_deref(),
            Some("remote:123:45")
        );
        assert_eq!(sessions[0].agent_running, Some(true));

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
    }

    #[test]
    fn list_remote_sessions_prefers_tw_rpc_managed_state() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"

if [ "$#" -eq 1 ]; then
  case "$1" in
    *"'tw'"*"'rpc'"*"'list'"*)
      cat <<'JSON'
{"protocolVersion":1,"sessions":[{"name":"managed-cli","kind":"worktree","profile":"cli","project":"coco","repoPath":"/remote/coco","worktreePath":"/home/dev/.tmux-worktree/worktrees/coco/managed-cli-a1b2c","branch":"managed-cli-a1b2c","baseBranch":"main","createdAt":"2026-07-02T00:00:00.000Z","attached":false,"windows":3,"created":1760000000,"activity":1760000100,"cwd":"/home/dev/.tmux-worktree/worktrees/coco/managed-cli-a1b2c"}]}
JSON
      exit 0
      ;;
    *"tmux capture-pane"*)
      printf 'managed-cli\037123:45\037 ⠇ managed-cli\n'
      exit 0
      ;;
    *"'tmux'"*"'list-sessions'"*)
      printf 'dashboard should not scan remote tmux when tw rpc list works\n' >&2
      exit 12
      ;;
  esac
fi

printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
        }

        let host = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        };

        let sessions = list_remote_sessions(&host).expect("remote rpc sessions");
        let log = fs::read_to_string(&log_path).expect("ssh log");

        assert_eq!(sessions.len(), 1, "ssh log:\n{log}");
        assert_eq!(sessions[0].name, "dev:managed-cli");
        assert_eq!(sessions[0].raw_name, "managed-cli");
        assert_eq!(sessions[0].window_count, 3);
        assert_eq!(sessions[0].host_id.as_deref(), Some("dev"));
        assert_eq!(sessions[0].project.as_deref(), Some("coco"));
        assert_eq!(
            sessions[0].output_signature.as_deref(),
            Some("remote:123:45")
        );
        assert_eq!(sessions[0].agent_running, Some(true));
        assert!(log.contains("'tw' 'rpc' 'list'"));
        assert!(log.contains("tmux capture-pane"));
        assert!(!log.contains("'tmux' 'list-sessions'"));

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
    }

    #[test]
    fn remote_tmux_terminal_listing_only_includes_tw_managed_sessions() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"

if [ "$#" -ne 1 ]; then
  printf 'unexpected remote command: %s\n' "$*" >&2
  exit 12
fi

case "$1" in
  *"'tmux'"*"'list-sessions'"*)
    printf 'demo\0370\0371\03710\03720\nplain-shell\0371\0371\03711\03721\ntw-term-shell\0371\0371\03712\03722\n'
    exit 0
    ;;
  *"tmux capture-pane"*)
    printf 'demo\037123:45\037 idle\n'
    exit 0
    ;;
  *"'tmux'"*"'display-message'"*"'=demo:'"*)
    printf '/remote/worktrees/demo-abc12\n'
    exit 0
    ;;
  *"'tmux'"*"'display-message'"*"'=plain-shell:'"*)
    printf '/home/dev\n'
    exit 0
    ;;
  *"'tmux'"*"'display-message'"*"'=tw-term-shell:'"*)
    printf '/home/dev/app\n'
    exit 0
    ;;
  *"'git'"*"demo-abc12"*"'rev-parse'"*"'--show-toplevel'"*)
    printf '/remote/worktrees/demo-abc12\n'
    exit 0
    ;;
  *"'git'"*"'rev-parse'"*"'--show-toplevel'"*)
    printf 'fatal: not a git repository\n' >&2
    exit 128
    ;;
esac

printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
        }

        let host = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        };

        let worktrees = list_remote_sessions(&host).expect("remote worktrees");
        let terminals = list_remote_tmux_terminals(&host).expect("remote terminals");
        let log = fs::read_to_string(&log_path).expect("ssh log");

        assert_eq!(worktrees.len(), 1, "ssh log:\n{log}");
        assert_eq!(worktrees[0].name, "dev:demo");
        assert_eq!(terminals.len(), 1, "ssh log:\n{log}");
        assert_eq!(terminals[0].id, "ssh:dev:tw-term-shell");
        assert_eq!(terminals[0].label, "tw-term-shell");
        assert_eq!(terminals[0].host_id.as_deref(), Some("dev"));
        assert_eq!(terminals[0].raw_name, "tw-term-shell");

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
    }

    #[test]
    fn remote_tmux_terminal_listing_prefers_tw_rpc_managed_state() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"

if [ "$#" -eq 1 ]; then
  case "$1" in
    *"'tw'"*"'rpc'"*"'list'"*)
      cat <<'JSON'
{"protocolVersion":1,"sessions":[{"name":"managed-cli","kind":"worktree","attached":false,"windows":1,"created":1760000000,"activity":1760000100,"cwd":"/remote/worktrees/managed-cli"},{"name":"tw-term-agent","kind":"terminal","attached":true,"windows":1,"created":1760000200,"activity":1760000300,"cwd":"/remote/app"}]}
JSON
      exit 0
      ;;
    *"'tmux'"*"'list-sessions'"*)
      printf 'dashboard should not scan remote tmux when tw rpc list works\n' >&2
      exit 12
      ;;
  esac
fi

printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
        }

        let host = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        };

        let terminals = list_remote_tmux_terminals(&host).expect("remote rpc terminals");
        let log = fs::read_to_string(&log_path).expect("ssh log");

        assert_eq!(terminals.len(), 1, "ssh log:\n{log}");
        assert_eq!(terminals[0].id, "ssh:dev:tw-term-agent");
        assert_eq!(terminals[0].label, "tw-term-agent");
        assert_eq!(terminals[0].tmux_name, "dev:tw-term-agent");
        assert_eq!(terminals[0].cwd, "/remote/app");
        assert_eq!(terminals[0].host_id.as_deref(), Some("dev"));
        assert_eq!(terminals[0].raw_name, "tw-term-agent");
        assert!(log.contains("'tw' 'rpc' 'list'"));
        assert!(!log.contains("'tmux' 'list-sessions'"));

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
    }

    #[test]
    fn remote_directory_picker_reads_home_and_directories_over_ssh() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"

if [ "$#" -eq 1 ]; then
  case "$1" in
    *'pwd -P'*)
      printf '/data/home/dev'
      exit 0
      ;;
    *"find -L"*"/home/dev"*)
      printf '/home/dev/.cache\0/home/dev/workspace\0/home/dev/workspace/x\0'
      exit 0
      ;;
  esac
fi

printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
        }

        let host = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        };

        let home = remote_home_dir_for_host(&host).expect("remote home");
        let entries = remote_read_dirs_for_host(&host, "/home/dev").expect("remote dirs");
        let paths = entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(home, "/data/home/dev");
        assert_eq!(
            paths,
            vec![
                "/home/dev/.cache",
                "/home/dev/workspace",
                "/home/dev/workspace/x",
            ]
        );
        assert!(entries.iter().all(|entry| entry.is_dir));
        assert!(entries[0].is_hidden);
        assert!(!entries[1].is_hidden);
        assert!(
            !fs::read_to_string(&log_path)
                .expect("ssh log")
                .contains("'sh' '-lc'"),
            "remote picker must not use a login sh; dash can choke on bash-only profile scripts"
        );

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
    }

    #[test]
    fn remote_file_editor_checks_reads_and_writes_over_ssh() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let input_path = temp.path().join("ssh-input");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    break
  fi
  shift
done

case "$1" in
  *"test -f"*)
    case "$1" in
      *"/workspace/src/main.rs"*) exit 0 ;;
      *) exit 1 ;;
    esac
    ;;
  *"tw-dashboard-write"*)
    cat > "${TW_FAKE_SSH_INPUT:?}"
    exit 0
    ;;
  *"wc -c"*)
    printf 'fn main() { println!("remote"); }\n'
    exit 0
    ;;
esac

printf 'unexpected remote command: %s\n' "$1" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_input = std::env::var("TW_FAKE_SSH_INPUT").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_INPUT", &input_path);
        }

        let host = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        };

        assert!(remote_file_exists_for_host(&host, "/workspace/src/main.rs")
            .expect("existing remote file"));
        assert!(
            !remote_file_exists_for_host(&host, "/workspace/src/missing.rs")
                .expect("missing remote file")
        );
        assert_eq!(
            remote_read_file_bytes_for_host(&host, "/workspace/src/main.rs")
                .expect("read remote file"),
            b"fn main() { println!(\"remote\"); }\n"
        );

        let replacement = b"fn main() { println!(\"saved\"); }\n";
        remote_write_file_for_host(&host, "/workspace/src/main.rs", replacement)
            .expect("write remote file");
        assert_eq!(
            fs::read(&input_path).expect("captured ssh input"),
            replacement
        );

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_INPUT", original_input);
    }

    #[test]
    fn create_remote_terminal_starts_tw_managed_session_with_ai_command() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"

case "$1" in
  *"'tmux'"*"'has-session'"*)
    exit 1
    ;;
  *"'tmux'"*"'new-session'"*)
    exit 0
    ;;
esac

printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        let original_home = std::env::var("HOME").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
            std::env::set_var("HOME", temp.path());
        }

        let host = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        };
        save_hosts_config(&[host]).expect("save hosts");

        let terminal = create_terminal(CreateTerminalArgs {
            cwd: "/remote/app".to_string(),
            ai_cmd: "codex --dangerously-bypass-approvals-and-sandbox".to_string(),
            host_id: Some("dev".to_string()),
        })
        .expect("remote terminal");

        assert_eq!(terminal.host_id.as_deref(), Some("dev"));
        assert!(terminal.raw_name.starts_with("tw-term-"));
        assert_eq!(terminal.tmux_name, format!("dev:{}", terminal.raw_name));

        let log = fs::read_to_string(&log_path).expect("ssh log");
        assert!(log.contains("'tmux' 'has-session' '-t' '=tw-term-"));
        assert!(log.contains("'tmux' 'new-session' '-d' '-s' 'tw-term-"));
        assert!(log.contains("'-c' '/remote/app'"));
        assert!(log.contains("codex --dangerously-bypass-approvals-and-sandbox"));
        assert!(log.contains("exec \"${SHELL:-/bin/zsh}\" -l"));

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
        restore_env("HOME", original_home);
    }

    #[test]
    fn ensure_and_kill_remote_terminal_use_the_configured_host() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"

case "$1" in
  *"'tmux'"*"'has-session'"*)
    exit 1
    ;;
  *"'tmux'"*"'new-session'"*)
    exit 0
    ;;
  *"'tmux'"*"'kill-session'"*)
    exit 0
    ;;
esac

printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        let original_home = std::env::var("HOME").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
            std::env::set_var("HOME", temp.path());
        }

        save_hosts_config(&[HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        }])
        .expect("save hosts");

        ensure_terminal_session(EnsureTerminalArgs {
            name: "dev:tw-term-dead1".to_string(),
            cwd: "/remote/app".to_string(),
            ai_cmd: Some("claude".to_string()),
            host_id: Some("dev".to_string()),
            raw_name: Some("tw-term-dead1".to_string()),
        })
        .expect("ensure remote terminal");
        kill_plain_terminal("dev:tw-term-dead1".to_string()).expect("kill remote terminal");

        let log = fs::read_to_string(&log_path).expect("ssh log");
        assert!(log.contains("'tmux' 'has-session' '-t' '=tw-term-dead1'"));
        assert!(log.contains("'tmux' 'new-session' '-d' '-s' 'tw-term-dead1'"));
        assert!(log.contains("'tmux' 'kill-session' '-t' '=tw-term-dead1'"));
        assert!(log.contains(
            "'export PATH=\"$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"; claude; exec \"${SHELL:-/bin/zsh}\" -l'"
        ));

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
        restore_env("HOME", original_home);
    }

    #[test]
    fn test_host_reports_remote_tw_version() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"

case "$1" in
  *"'tmux'"*"'-V'"*)
    printf 'tmux 3.4\n'
    exit 0
    ;;
  *"'tw'"*"'version'"*)
    printf '0.11.1\n'
    exit 0
    ;;
esac

printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
        }

        let status = test_host(AddHostArgs {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        })
        .expect("host status");

        assert!(status.reachable);
        assert!(status.tw_available);
        assert_eq!(status.tw_version.as_deref(), Some("0.11.1"));
        assert_eq!(status.tw_error, None);

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
    }

    #[test]
    fn test_host_reports_missing_remote_tw_without_marking_ssh_down() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    break
  fi
  shift
done

case "$1" in
  *"'tmux'"*"'-V'"*)
    printf 'tmux 3.4\n'
    exit 0
    ;;
  *"'tw'"*"'version'"*)
    printf 'tw: command not found\n' >&2
    exit 127
    ;;
esac

printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
        }

        let status = test_host(AddHostArgs {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        })
        .expect("host status");

        assert!(status.reachable);
        assert!(!status.tw_available);
        assert_eq!(status.tw_version, None);
        assert!(status
            .tw_error
            .as_deref()
            .unwrap_or_default()
            .contains("tw: command not found"));

        restore_env("PATH", original_path);
    }

    #[test]
    fn install_host_tw_uses_github_source_install() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"

case "$1" in
  *"git clone --depth 1"*"npm link --prefix"*)
    printf 'installed\n'
    exit 0
    ;;
  *"'tmux'"*"'-V'"*)
    printf 'tmux 3.4\n'
    exit 0
    ;;
  *"'tw'"*"'version'"*)
    printf '0.11.1\n'
    exit 0
    ;;
esac

printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        let original_home = std::env::var("HOME").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
            std::env::set_var("HOME", temp.path());
        }

        save_hosts_config(&[HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        }])
        .expect("save hosts");

        let status = install_host_tw("dev".to_string()).expect("install remote tw");
        assert!(status.reachable);
        assert!(status.tw_available);
        assert_eq!(status.tw_version.as_deref(), Some("0.11.1"));

        let log = fs::read_to_string(&log_path).expect("ssh log");
        assert!(log.contains("git clone --depth 1"));
        assert!(log.contains("https://github.com/Sskift/tmux-worktree.git"));
        assert!(log.contains("npm link --prefix"));

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
        restore_env("HOME", original_home);
    }

    #[test]
    fn test_parse_session_key() {
        // Local session (no colon)
        assert_eq!(parse_session_key("myproject"), (None, "myproject"));
        assert_eq!(parse_session_key("simple"), (None, "simple"));
        // Remote session (host:name)
        assert_eq!(
            parse_session_key("ssh-host1:myproject"),
            (Some("ssh-host1"), "myproject")
        );
        assert_eq!(
            parse_session_key("my-host:session-name"),
            (Some("my-host"), "session-name")
        );
        // Edge cases
        assert_eq!(parse_session_key("a:b:c"), (Some("a"), "b:c"));
    }

    #[test]
    fn hosts_from_config_accepts_string_and_object_shorthand() {
        let hosts = hosts_from_config(&serde_json::json!({
            "hosts": [
                "ssh-host",
                { "id": "gpu", "host": "gpu-host", "label": "GPU" }
            ]
        }));

        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].id, "ssh-host");
        assert_eq!(hosts[0].label, "ssh-host");
        assert_eq!(hosts[0].host, "ssh-host");
        assert_eq!(hosts[1].id, "gpu");
        assert_eq!(hosts[1].label, "GPU");
        assert_eq!(hosts[1].host, "gpu-host");
    }

    #[test]
    fn add_host_args_accepts_missing_optional_fields() {
        let args = serde_json::from_value::<AddHostArgs>(serde_json::json!({
            "id": "remote-dev",
            "label": "remote-dev",
            "host": "remote-dev"
        }))
        .expect("deserialize add host args");

        assert_eq!(args.id, "remote-dev");
        assert_eq!(args.port, None);
        assert_eq!(args.user, None);
        assert_eq!(args.identity_file, None);
        assert_eq!(args.worktree_base, None);
        assert_eq!(args.tmux_path, None);
        assert_eq!(args.tw_path, None);
    }

    #[test]
    fn atomic_write_failure_preserves_existing_file_and_cleans_temp() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("state.json");
        fs::write(&path, "old state").expect("write old state");

        let error = atomic_write_file_with(&path, b"new state", |temp_path| {
            assert_eq!(temp_path.parent(), path.parent());
            assert_eq!(fs::read(temp_path).expect("read synced temp"), b"new state");
            assert_eq!(
                fs::metadata(temp_path)
                    .expect("temp metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            Err("injected failure before rename".to_string())
        })
        .expect_err("injected failure");

        assert!(error.contains("injected failure before rename"));
        assert_eq!(
            fs::read_to_string(&path).expect("old state intact"),
            "old state"
        );
        let leftovers = fs::read_dir(temp.path())
            .expect("read tempdir")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn update_host_is_transactional_preserves_other_config_and_is_idempotent() {
        let _guard = test_env_lock().lock().expect("lock");
        let original_home = std::env::var("HOME").ok();
        let original_dashboard_home = std::env::var("TW_DASHBOARD_HOME").ok();
        let temp = tempfile::tempdir().expect("tempdir");
        unsafe {
            std::env::set_var("HOME", temp.path());
            std::env::set_var("TW_DASHBOARD_HOME", temp.path());
        }
        let config_path = temp.path().join(".tmux-worktree.json");
        fs::write(
            &config_path,
            serde_json::to_string_pretty(&serde_json::json!({
                "projects": {
                    "dashboard": { "path": "/repo/dashboard" }
                },
                "mobileRelay": {
                    "relayUrl": "wss://relay.example.test",
                    "secret": "keep-me"
                },
                "hosts": [
                    {
                        "id": "builder",
                        "label": "Old builder",
                        "host": "old.example.test",
                        "user": "old-user",
                        "worktreeBase": "/old/worktrees",
                        "tmuxPath": "/old/tmux",
                        "twPath": "/old/tw"
                    },
                    {
                        "id": "spare",
                        "label": "Spare",
                        "host": "spare.example.test"
                    }
                ]
            }))
            .expect("serialize initial config"),
        )
        .expect("write initial config");

        let args = || UpdateHostArgs {
            id: "builder".to_string(),
            label: "  Build host  ".to_string(),
            host: "  builder.example.test  ".to_string(),
            user: Some("  alice  ".to_string()),
            port: Some(2222),
            identity_file: Some("  ~/keys/builder  ".to_string()),
            worktree_base: Some("  ~/worktrees  ".to_string()),
            tmux_path: Some("  ~/.local/bin/tmux  ".to_string()),
            tw_path: Some("  ~/.local/bin/tw  ".to_string()),
        };

        let hosts = update_host_config(args()).expect("update host");
        let builder = hosts
            .iter()
            .find(|host| host.id == "builder")
            .expect("updated builder");
        assert_eq!(builder.label, "Build host");
        assert_eq!(builder.host, "builder.example.test");
        assert_eq!(builder.user.as_deref(), Some("alice"));
        assert_eq!(builder.port, Some(2222));
        assert_eq!(
            builder.identity_file.as_deref(),
            Some(temp.path().join("keys/builder").to_string_lossy().as_ref())
        );
        assert_eq!(builder.worktree_base.as_deref(), Some("~/worktrees"));
        assert_eq!(builder.tmux_path.as_deref(), Some("~/.local/bin/tmux"));
        assert_eq!(builder.tw_path.as_deref(), Some("~/.local/bin/tw"));
        assert!(hosts.iter().any(|host| host.id == "spare"));

        let saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&config_path).expect("read updated config"))
                .expect("parse updated config");
        assert_eq!(saved["projects"]["dashboard"]["path"], "/repo/dashboard");
        assert_eq!(saved["mobileRelay"]["secret"], "keep-me");

        let first_write = fs::read(&config_path).expect("first update bytes");
        assert_eq!(
            fs::metadata(&config_path)
                .expect("config metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        update_host_config(args()).expect("repeat update");
        assert_eq!(
            fs::read(&config_path).expect("second update bytes"),
            first_write
        );

        let cleared = update_host_config(UpdateHostArgs {
            id: "builder".to_string(),
            label: "Build host".to_string(),
            host: "builder.example.test".to_string(),
            user: Some(" ".to_string()),
            port: None,
            identity_file: None,
            worktree_base: Some("".to_string()),
            tmux_path: None,
            tw_path: Some("  ".to_string()),
        })
        .expect("clear optional host fields");
        let builder = cleared
            .iter()
            .find(|host| host.id == "builder")
            .expect("cleared builder");
        assert_eq!(builder.user, None);
        assert_eq!(builder.port, None);
        assert_eq!(builder.identity_file, None);
        assert_eq!(builder.worktree_base, None);
        assert_eq!(builder.tmux_path, None);
        assert_eq!(builder.tw_path, None);

        restore_env("TW_DASHBOARD_HOME", original_dashboard_home);
        restore_env("HOME", original_home);
    }

    #[test]
    fn update_host_rejects_missing_and_duplicate_stable_ids_without_writing() {
        let _guard = test_env_lock().lock().expect("lock");
        let original_home = std::env::var("HOME").ok();
        let original_dashboard_home = std::env::var("TW_DASHBOARD_HOME").ok();
        let temp = tempfile::tempdir().expect("tempdir");
        unsafe {
            std::env::set_var("HOME", temp.path());
            std::env::set_var("TW_DASHBOARD_HOME", temp.path());
        }
        let config_path = temp.path().join(".tmux-worktree.json");
        let host_value = serde_json::json!({
            "id": "builder",
            "label": "Builder",
            "host": "builder.example.test"
        });
        fs::write(
            &config_path,
            serde_json::to_string_pretty(&serde_json::json!({
                "other": { "preserved": true },
                "hosts": [host_value.clone()]
            }))
            .expect("serialize config"),
        )
        .expect("write config");
        let missing_before = fs::read(&config_path).expect("missing before");

        let missing = update_host_config(UpdateHostArgs {
            id: "missing".to_string(),
            label: "Missing".to_string(),
            host: "missing.example.test".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        })
        .expect_err("missing id must fail");
        assert_eq!(missing, "host id 'missing' not found");
        assert_eq!(
            fs::read(&config_path).expect("missing after"),
            missing_before
        );

        fs::write(
            &config_path,
            serde_json::to_string_pretty(&serde_json::json!({
                "other": { "preserved": true },
                "hosts": [host_value.clone(), host_value]
            }))
            .expect("serialize duplicate config"),
        )
        .expect("write duplicate config");
        let duplicate_before = fs::read(&config_path).expect("duplicate before");
        let duplicate = update_host_config(UpdateHostArgs {
            id: "builder".to_string(),
            label: "Builder".to_string(),
            host: "builder.example.test".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        })
        .expect_err("duplicate id must fail");
        assert_eq!(duplicate, "host id 'builder' is duplicated in config");
        assert_eq!(
            fs::read(&config_path).expect("duplicate after"),
            duplicate_before
        );

        restore_env("TW_DASHBOARD_HOME", original_dashboard_home);
        restore_env("HOME", original_home);
    }

    #[test]
    fn update_host_invalidates_only_its_cached_status() {
        let state = HostState::default();
        let status = |id: &str| CachedHostStatus {
            status: HostStatus {
                id: id.to_string(),
                label: id.to_string(),
                reachable: true,
                latency_ms: Some(1),
                error: None,
                tw_available: true,
                tw_version: Some("1.0.3".to_string()),
                tw_error: None,
            },
            checked_at: Instant::now(),
        };
        {
            let mut statuses = state.statuses.lock().expect("cache lock");
            statuses.insert("builder".to_string(), status("builder"));
            statuses.insert("spare".to_string(), status("spare"));
        }

        invalidate_host_status_cache(&state, "builder").expect("invalidate builder");

        let statuses = state.statuses.lock().expect("cache lock");
        assert!(!statuses.contains_key("builder"));
        assert!(statuses.contains_key("spare"));
    }

    #[test]
    fn remove_then_readd_same_host_id_never_reuses_cached_status() {
        let _guard = test_env_lock().lock().expect("lock");
        let original_home = std::env::var("HOME").ok();
        let original_dashboard_home = std::env::var("TW_DASHBOARD_HOME").ok();
        let temp = tempfile::tempdir().expect("tempdir");
        unsafe {
            std::env::set_var("HOME", temp.path());
            std::env::set_var("TW_DASHBOARD_HOME", temp.path());
        }
        let config_path = temp.path().join(".tmux-worktree.json");
        fs::write(
            &config_path,
            serde_json::to_string_pretty(&serde_json::json!({
                "hosts": [{
                    "id": "builder",
                    "label": "Old builder",
                    "host": "old.example.test"
                }]
            }))
            .expect("serialize config"),
        )
        .expect("write config");

        let state = HostState::default();
        let stale_status = || CachedHostStatus {
            status: HostStatus {
                id: "builder".to_string(),
                label: "Old builder".to_string(),
                reachable: false,
                latency_ms: None,
                error: Some("stale failure".to_string()),
                tw_available: false,
                tw_version: None,
                tw_error: None,
            },
            checked_at: Instant::now(),
        };
        state
            .statuses
            .lock()
            .expect("cache lock")
            .insert("builder".to_string(), stale_status());

        let after_remove =
            remove_host_with_state(" builder ".to_string(), &state).expect("remove host");
        assert!(after_remove.iter().all(|host| host.id != "builder"));
        assert!(!state
            .statuses
            .lock()
            .expect("cache lock")
            .contains_key("builder"));

        state
            .statuses
            .lock()
            .expect("cache lock")
            .insert("builder".to_string(), stale_status());
        let after_add = add_host_with_state(
            AddHostArgs {
                id: " builder ".to_string(),
                label: " New builder ".to_string(),
                host: " new.example.test ".to_string(),
                user: Some(" alice ".to_string()),
                port: Some(2222),
                identity_file: Some(" ~/.ssh/builder ".to_string()),
                worktree_base: Some(" ~/worktrees ".to_string()),
                tmux_path: Some(" ~/.local/bin/tmux ".to_string()),
                tw_path: Some(" ~/.local/bin/tw ".to_string()),
            },
            &state,
        )
        .expect("re-add host");
        let builder = after_add
            .iter()
            .find(|host| host.id == "builder")
            .expect("new builder");
        assert_eq!(builder.label, "New builder");
        assert_eq!(builder.host, "new.example.test");
        assert_eq!(builder.user.as_deref(), Some("alice"));
        assert_eq!(builder.port, Some(2222));
        assert_eq!(builder.worktree_base.as_deref(), Some("~/worktrees"));
        assert_eq!(builder.tmux_path.as_deref(), Some("~/.local/bin/tmux"));
        assert_eq!(builder.tw_path.as_deref(), Some("~/.local/bin/tw"));
        assert!(!state
            .statuses
            .lock()
            .expect("cache lock")
            .contains_key("builder"));

        restore_env("TW_DASHBOARD_HOME", original_dashboard_home);
        restore_env("HOME", original_home);
    }

    #[test]
    fn layout_schema_migration_backup_is_created_once_and_save_is_idempotent() {
        let _guard = test_env_lock().lock().expect("lock");
        let original_home = std::env::var("HOME").ok();
        let original_dashboard_home = std::env::var("TW_DASHBOARD_HOME").ok();
        let temp = tempfile::tempdir().expect("tempdir");
        unsafe {
            std::env::set_var("HOME", temp.path());
            std::env::set_var("TW_DASHBOARD_HOME", temp.path());
        }
        let path = temp.path().join(".tw-dashboard-layout.json");
        let legacy = serde_json::json!({
            "left": 240,
            "selection": { "kind": "session", "name": "dashboard" }
        });
        let legacy_text = serde_json::to_string_pretty(&legacy).expect("serialize legacy");
        fs::write(&path, &legacy_text).expect("write legacy layout");

        let first_v2 = serde_json::json!({
            "schemaVersion": 2,
            "sidebar": { "width": 280 },
            "selection": { "kind": "session", "id": "local:dashboard" }
        });
        assert_eq!(layout_schema_version(&first_v2), 2);
        assert_eq!(
            layout_schema_version(&serde_json::json!({ "version": 2 })),
            2
        );
        save_layout(first_v2.clone()).expect("save migrated layout");
        let backup_path = layout_backup_path(&path, 1);
        assert_eq!(
            backup_path.file_name().and_then(|name| name.to_str()),
            Some(".tw-dashboard-layout.v1.backup.json")
        );
        assert_eq!(
            fs::read_to_string(&backup_path).expect("read migration backup"),
            legacy_text
        );
        let backup_once = fs::read(&backup_path).expect("backup bytes");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &fs::read_to_string(&path).expect("read v2 layout")
            )
            .expect("parse v2 layout"),
            first_v2
        );

        let updated_v2 = serde_json::json!({
            "schemaVersion": 2,
            "sidebar": { "width": 300 },
            "selection": { "kind": "session", "id": "local:dashboard" }
        });
        save_layout(updated_v2.clone()).expect("repeat v2 save");
        save_layout(updated_v2.clone()).expect("idempotent v2 save");
        assert_eq!(
            fs::read(&backup_path).expect("backup unchanged"),
            backup_once
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &fs::read_to_string(&path).expect("read updated v2")
            )
            .expect("parse updated v2"),
            updated_v2
        );

        fs::write(&path, "{ invalid layout").expect("write malformed layout");
        let malformed_before = fs::read(&path).expect("malformed before");
        let error = save_layout(serde_json::json!({ "schemaVersion": 3 }))
            .expect_err("malformed source must block migration");
        assert!(error.contains("parse layout for backup"));
        assert_eq!(fs::read(&path).expect("malformed after"), malformed_before);

        restore_env("TW_DASHBOARD_HOME", original_dashboard_home);
        restore_env("HOME", original_home);
    }

    #[test]
    fn ssh_config_aliases_are_candidates_not_auto_connected_hosts() {
        let hosts = ssh_host_candidates_from_config_text(
            r#"
Host oncall-host
  HostName 192.0.2.10
  User alice

Host ssh-host
  HostName 192.0.2.11
  User alice

Host github.com
  HostName github.com
  User git
"#,
        );

        let ids = hosts
            .iter()
            .map(|host| host.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["oncall-host", "ssh-host"]);
        assert!(hosts_from_config(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn load_hosts_does_not_auto_connect_ssh_config_aliases() {
        let _guard = test_env_lock().lock().unwrap();
        let original_home = std::env::var("HOME").ok();
        let original_tw_home = std::env::var("TW_DASHBOARD_HOME").ok();
        let temp = tempfile::tempdir().expect("tempdir");
        let ssh_dir = temp.path().join(".ssh");
        fs::create_dir_all(&ssh_dir).expect("mkdir .ssh");
        fs::write(
            ssh_dir.join("config"),
            r#"
Host ssh-host
  HostName 192.0.2.11
  User alice
"#,
        )
        .expect("write ssh config");
        unsafe {
            std::env::set_var("HOME", temp.path());
            std::env::set_var("TW_DASHBOARD_HOME", temp.path());
        }

        let hosts = load_hosts().expect("load hosts");

        restore_env("TW_DASHBOARD_HOME", original_tw_home);
        restore_env("HOME", original_home);
        assert!(hosts.is_empty());
    }

    #[test]
    fn ssh_host_candidates_filter_non_machine_aliases() {
        let hosts = ssh_host_candidates_from_config_text(
            r#"
Host github.com
  User git
Host ssh-host gpu-box staging.example
  User dev
  Port 2200
Host *.example
  User ignored
Host build?
  User ignored
"#,
        );

        let ids = hosts
            .iter()
            .map(|host| host.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["ssh-host", "gpu-box", "staging.example"]);
        let gpu = hosts
            .iter()
            .find(|host| host.id == "gpu-box")
            .expect("gpu host");
        assert_eq!(gpu.user.as_deref(), Some("dev"));
        assert_eq!(gpu.port, Some(2200));
    }

    #[test]
    fn ssh_host_candidates_skip_git_jump_and_duplicate_root_entries() {
        let hosts = ssh_host_candidates_from_config_text(
            r#"
Host remote-dev
  HostName 192.0.2.10
  User alice

Host git.example.com
  HostName git.example.com
  Port 29418
  User alice

Host build-cloud
  HostName 192.0.2.12
  User alice

Host ssh-host
  HostName 192.0.2.11
  User alice

Host gpu-worker
  HostName 2605:340:cd51:7702:caa9:5514:509e:3464
  User tiger
  ProxyJump jump-proxy

Host gpu-worker-root
  HostName 2605:340:cd51:7702:caa9:5514:509e:3464
  User root
  ProxyJump jump-proxy

Host jump-proxy
  HostName jump.example.com
  User alice
"#,
        );

        let ids = hosts
            .iter()
            .map(|host| host.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            vec!["remote-dev", "build-cloud", "ssh-host", "gpu-worker"]
        );
    }

    #[test]
    fn mobile_relay_config_accepts_nested_and_flat_fields() {
        let nested = mobile_relay_config_from_value(&serde_json::json!({
            "mobileRelay": {
                "relayUrl": "wss://relay.example.net",
                "hostId": "macbook",
                "displayName": "Desk Mac",
                "secret": "token-1"
            }
        }));
        assert_eq!(nested.relay_url, "wss://relay.example.net");
        assert_eq!(nested.host_id, "macbook");
        assert_eq!(nested.display_name, "Desk Mac");
        assert_eq!(nested.secret, "token-1");

        let flat = mobile_relay_config_from_value(&serde_json::json!({
            "mobileRelayUrl": "wss://relay.example.org",
            "mobileRelayHostId": "laptop",
            "mobileRelaySecret": "token-2"
        }));
        assert_eq!(flat.relay_url, "wss://relay.example.org");
        assert_eq!(flat.host_id, "laptop");
        assert_eq!(flat.secret, "token-2");
    }

    #[test]
    fn mobile_relay_uses_a_stable_local_mdns_name() {
        assert_eq!(
            normalize_local_mdns_name("Desk-Mac\n"),
            Some("desk-mac.local".to_string())
        );
        assert_eq!(
            normalize_local_mdns_name("desk-mac.local"),
            Some("desk-mac.local".to_string())
        );
        assert_eq!(normalize_local_mdns_name("bad host"), None);
    }
}
