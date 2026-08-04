use crate::config::trimmed_non_empty_string;
use crate::support::LEGACY_DEFAULT_WORKTREE_BASE;

pub(crate) fn project_from_worktree_path(path: &str, worktree_base: &str) -> Option<String> {
    let normalized = path.trim_end_matches('/');
    let base = worktree_base.trim_end_matches('/');
    if !base.is_empty() {
        let prefix = format!("{base}/");
        if let Some(rest) = normalized.strip_prefix(&prefix) {
            return rest.split('/').next().and_then(trimmed_non_empty_string);
        }
    }

    let marker = "/.tmux-worktree/worktrees/";
    if let Some(project) = normalized
        .split_once(marker)
        .and_then(|(_, rest)| rest.split('/').next())
        .and_then(trimmed_non_empty_string)
    {
        return Some(project);
    }
    normalized
        .strip_prefix(&format!("{}/", LEGACY_DEFAULT_WORKTREE_BASE))
        .and_then(|rest| rest.split('/').next())
        .and_then(trimmed_non_empty_string)
}

/// A worktree directory is a real git worktree if it contains a `.git` entry
/// (a file for linked worktrees, a directory for a plain clone). Plain
/// subdirectories that merely live under the worktree base (e.g. a checked-out
/// repo's own `app/` or `src/`) have no `.git` and must not be treated as
/// worktrees, otherwise they pollute orphan recovery and risk wrong cleanup.
pub(crate) fn is_git_worktree_dir(path: &std::path::Path) -> bool {
    path.join(".git").exists()
}

/// Strip trailing `-{5 hex chars}` random suffix to recover session name.
pub(crate) fn derive_session_name(dirname: &str) -> String {
    tw_session_name_from_worktree_dir(dirname).unwrap_or_else(|| dirname.to_string())
}

pub(crate) fn tw_session_name_from_worktree_dir(dirname: &str) -> Option<String> {
    let bytes = dirname.as_bytes();
    if bytes.len() > 6 && bytes[bytes.len() - 6] == b'-' {
        let suffix = &dirname[dirname.len() - 5..];
        if suffix.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(dirname[..dirname.len() - 6].to_string());
        }
    }
    None
}

pub(crate) fn session_name_matches_git_root(session_name: &str, git_root: &str) -> bool {
    let Some(dirname) = std::path::Path::new(git_root)
        .file_name()
        .and_then(|name| name.to_str())
    else {
        return false;
    };
    derive_session_name(dirname) == session_name
}

pub(crate) fn is_managed_worktree_session(name: &str, cwd: &str, worktree_base: &str) -> bool {
    if cwd.trim().is_empty() {
        return false;
    }
    let cwd_path = std::path::Path::new(cwd);
    let base = worktree_base.trim_end_matches('/');
    let under_base = cwd == base || cwd.starts_with(&format!("{base}/"));
    let under_legacy_default = cwd == LEGACY_DEFAULT_WORKTREE_BASE
        || cwd.starts_with(&format!("{LEGACY_DEFAULT_WORKTREE_BASE}/"));
    if !under_base && !under_legacy_default && !cwd.contains("/.tmux-worktree/worktrees/") {
        return false;
    }
    if !is_git_worktree_dir(cwd_path) {
        return false;
    }

    let Some(dirname) = cwd_path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    tw_session_name_from_worktree_dir(dirname).is_some_and(|session_name| session_name == name)
}

pub(crate) fn managed_worktree_root_for_session(
    name: &str,
    cwd: &str,
    worktree_base: &str,
) -> Option<String> {
    std::path::Path::new(cwd)
        .ancestors()
        .filter_map(|path| path.to_str())
        .find(|path| is_managed_worktree_session(name, path, worktree_base))
        .map(ToString::to_string)
}
