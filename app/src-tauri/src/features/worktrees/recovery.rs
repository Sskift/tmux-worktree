use crate::config::{config_worktree_base, config_worktree_base_with_home, remote_config_for_host};
use crate::features::sessions::{derive_session_name, is_git_worktree_dir, list_local_sessions};
use crate::ipc::OrphanedWorktree;
use crate::remote::{
    remote_home_dir_for_host, run_remote_cmd_output, run_remote_tmux_output, HostConfig,
};
use crate::support::{
    app_home_dir, app_home_dir_or_tmp, default_worktree_base, expand_home_path_with_home, git_bin,
    run_check, LEGACY_DEFAULT_WORKTREE_BASE,
};
use std::collections::HashSet;

fn pending_cleanup_path() -> std::path::PathBuf {
    app_home_dir_or_tmp().join(".tw-dashboard-pending-worktree-cleanup.json")
}

pub(crate) fn load_pending_cleanup() -> Vec<OrphanedWorktree> {
    let path = pending_cleanup_path();
    if !path.exists() {
        return vec![];
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<Vec<OrphanedWorktree>>(&text).ok())
        .unwrap_or_default()
}

pub(crate) fn save_pending_cleanup(entries: &[OrphanedWorktree]) {
    let path = pending_cleanup_path();
    if entries.is_empty() {
        let _ = std::fs::remove_file(path);
        return;
    }
    if let Ok(text) = serde_json::to_string_pretty(entries) {
        let _ = std::fs::write(path, text);
    }
}

pub(crate) fn remove_pending_cleanup_path(path: &str) {
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

pub(crate) fn orphaned_worktrees(
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
                host_id: None,
            });
        }
    }
    orphans
}

#[cfg(test)]
pub(crate) fn worktrees_for_session(
    base_path: &std::path::Path,
    session_name: &str,
) -> Vec<OrphanedWorktree> {
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
                host_id: None,
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

pub(crate) fn try_cleanup_worktree(path: &str, force: bool) -> bool {
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

pub(crate) fn worktree_has_uncommitted_changes(path: &str) -> Option<bool> {
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

pub(crate) fn cleanup_pending_worktrees() {
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

fn remote_worktree_base(host: &HostConfig) -> Result<String, String> {
    let home = remote_home_dir_for_host(host)?;
    if let Some(base) = host
        .worktree_base
        .as_deref()
        .map(str::trim)
        .filter(|base| !base.is_empty())
    {
        return Ok(expand_home_path_with_home(base, &home));
    }
    if let Some((config, config_home)) = remote_config_for_host(host)? {
        if let Some(base) = config_worktree_base_with_home(&config, Some(&config_home)) {
            return Ok(base);
        }
    }
    Ok(format!(
        "{}/.tmux-worktree/worktrees",
        home.trim_end_matches('/')
    ))
}

fn remote_live_session_names(host: &HostConfig) -> Result<HashSet<String>, String> {
    let output = run_remote_tmux_output(host, &["list-sessions", "-F", "#{session_name}"])?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .collect());
    }
    let detail = String::from_utf8_lossy(&output.stderr);
    if detail.contains("no server running") || detail.contains("no current server") {
        return Ok(HashSet::new());
    }
    Err(format!(
        "remote tmux catalog on {} failed ({}): {}",
        host.label,
        output.status,
        detail.trim()
    ))
}

pub(crate) fn remote_orphaned_worktrees(
    host: &HostConfig,
) -> Result<Vec<OrphanedWorktree>, String> {
    let base = remote_worktree_base(host)?;
    let output = run_remote_cmd_output(
        host,
        &[
            "sh",
            "-c",
            r#"
base=$1
[ -d "$base" ] || exit 0
find "$base" -mindepth 2 -maxdepth 2 -type d -exec sh -c '
  for path do
    [ ! -L "$path" ] || continue
    [ -e "$path/.git" ] || continue
    physical=$(cd "$path" 2>/dev/null && pwd -P) || continue
    top=$(git -C "$physical" rev-parse --show-toplevel 2>/dev/null) || continue
    top=$(cd "$top" 2>/dev/null && pwd -P) || continue
    [ "$top" = "$physical" ] || continue
    printf "%s\000" "$physical"
  done
' sh {} +
"#,
            "sh",
            &base,
        ],
    )?;
    if !output.status.success() {
        return Err(format!(
            "scan remote worktrees on {} failed ({}): {}",
            host.label,
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let live = remote_live_session_names(host)?;
    let mut orphans = Vec::new();
    for raw_path in output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
    {
        let path = String::from_utf8(raw_path.to_vec())
            .map_err(|_| format!("remote worktree path on {} is not UTF-8", host.label))?;
        let worktree_path = std::path::Path::new(&path);
        let Some(dirname) = worktree_path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let name = derive_session_name(dirname);
        if live.contains(&name) {
            continue;
        }
        let project = worktree_path
            .parent()
            .and_then(std::path::Path::file_name)
            .and_then(|name| name.to_str())
            .unwrap_or("remote")
            .to_string();
        orphans.push(OrphanedWorktree {
            project,
            path,
            name,
            host_id: Some(host.id.clone()),
        });
    }
    orphans.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(orphans)
}

pub(crate) fn try_cleanup_remote_worktree(
    host: &HostConfig,
    path: &str,
    force: bool,
) -> Result<(), String> {
    if path.is_empty()
        || path
            .chars()
            .any(|character| matches!(character, '\0' | '\r' | '\n'))
    {
        return Err("remote worktree path is invalid".to_string());
    }
    let base = remote_worktree_base(host)?;
    let force_flag = if force { "1" } else { "0" };
    let output = run_remote_cmd_output(
        host,
        &[
            "sh",
            "-c",
            r#"
set -u
path=$1
base=$2
force=$3
die() { printf '%s\n' "$1" >&2; exit 1; }

[ -d "$base" ] || die "configured remote worktree base does not exist"
base=$(cd "$base" 2>/dev/null && pwd -P) || die "cannot resolve remote worktree base"
case "$path" in "$base"/*/*) ;; *) die "refusing path outside remote worktree base" ;; esac
relative=${path#"$base"/}
case "$relative" in */*) ;; *) die "remote worktree path is not project/worktree" ;; esac
tail=${relative#*/}
case "$tail" in ''|*/*) die "remote worktree path is not an immediate project child" ;; esac
[ -e "$path" ] || exit 0
[ ! -L "$path" ] || die "refusing symlink remote worktree"
physical=$(cd "$path" 2>/dev/null && pwd -P) || die "cannot resolve remote worktree"
[ "$physical" = "$path" ] || die "remote worktree path is not canonical"
top=$(git -C "$path" rev-parse --show-toplevel 2>/dev/null) || die "remote path is not a git worktree"
top=$(cd "$top" 2>/dev/null && pwd -P) || die "cannot resolve git worktree root"
[ "$top" = "$path" ] || die "remote path is not the git worktree root"

if [ "$force" != 1 ]; then
  changes=$(git -C "$path" status --porcelain --untracked-files=all) || die "cannot inspect remote worktree status"
  [ -z "$changes" ] || die "remote worktree has uncommitted changes"
fi

common=$(git -C "$path" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || die "cannot resolve remote repository"
case "$common" in */.git) repo=${common%/.git} ;; *) die "remote git common directory is unsupported" ;; esac
[ -n "$repo" ] && [ "$repo" != "$path" ] || die "remote repository identity is invalid"

if [ "$force" = 1 ] && [ -d /proc ]; then
  pids=''
  for link in /proc/[0-9]*/cwd; do
    [ -L "$link" ] || continue
    cwd=$(readlink "$link" 2>/dev/null || true)
    case "$cwd" in
      "$path"|"$path"/*)
        pid=${link#/proc/}
        pid=${pid%/cwd}
        if [ "$pid" != "$$" ] && [ "$pid" != "$PPID" ]; then
          kill -TERM "$pid" 2>/dev/null || true
          pids="$pids $pid"
        fi
        ;;
    esac
  done
  attempts=0
  while [ -n "$pids" ] && [ "$attempts" -lt 20 ]; do
    alive=''
    for pid in $pids; do
      cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
      case "$cwd" in "$path"|"$path"/*) alive="$alive $pid" ;; esac
    done
    pids=$alive
    [ -z "$pids" ] || sleep 0.1
    attempts=$((attempts + 1))
  done
  for pid in $pids; do
    cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
    case "$cwd" in "$path"|"$path"/*) kill -KILL "$pid" 2>/dev/null || true ;; esac
  done
fi

if [ "$force" = 1 ]; then
  git -C "$repo" worktree remove --force "$path"
else
  git -C "$repo" worktree remove "$path"
fi
remove_status=$?
if [ "$remove_status" -ne 0 ]; then
  git -C "$repo" worktree list --porcelain | grep -Fqx "worktree $path" \
    && die "git still owns the remote worktree after removal failed"
fi
if [ -e "$path" ]; then
  rm -rf -- "$path" || die "cannot remove residual remote worktree directory"
fi
[ ! -e "$path" ] || die "remote worktree directory still exists"
"#,
            "sh",
            path,
            &base,
            force_flag,
        ],
    )?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "delete remote worktree on {} failed ({}): {}",
            host.label,
            output.status,
            detail.trim()
        ));
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn list_orphaned_worktrees(
    host_id: Option<String>,
) -> Result<Vec<OrphanedWorktree>, String> {
    if let Some(host_id) = host_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        let host = crate::config::find_host(host_id)?;
        return remote_orphaned_worktrees(&host);
    }
    let home = app_home_dir().ok_or("home dir not found")?;
    let config_path = home.join(".tmux-worktree.json");
    let config: serde_json::Value = if config_path.exists() {
        let text =
            std::fs::read_to_string(&config_path).map_err(|e| format!("read config: {e}"))?;
        serde_json::from_str(&text).map_err(|e| format!("parse config: {e}"))?
    } else {
        serde_json::json!({})
    };

    let worktree_base = config_worktree_base(&config).unwrap_or_else(default_worktree_base);
    let live = live_session_names();
    let mut orphans = orphaned_worktrees(std::path::Path::new(&worktree_base), &live);
    if worktree_base != LEGACY_DEFAULT_WORKTREE_BASE {
        let mut seen = orphans
            .iter()
            .map(|orphan| orphan.path.clone())
            .collect::<HashSet<_>>();
        orphans.extend(
            orphaned_worktrees(std::path::Path::new(LEGACY_DEFAULT_WORKTREE_BASE), &live)
                .into_iter()
                .filter(|orphan| seen.insert(orphan.path.clone())),
        );
    }
    Ok(orphans)
}
