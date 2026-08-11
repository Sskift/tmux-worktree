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
