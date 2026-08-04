use super::session_name_matches_git_root;
use crate::remote::{run_remote_cmd_quiet, run_remote_tmux_quiet, HostConfig};
use crate::support::run_quiet;

pub(crate) fn tmux_list_sessions_fmt() -> &'static str {
    "#{session_name}\x1f#{session_attached}\x1f#{session_windows}\x1f#{session_created}\x1f#{session_activity}"
}

pub(crate) fn tmux_session_pane_target(raw_name: &str) -> String {
    format!("={}:", raw_name)
}

pub(crate) fn local_session_active_cwd(raw_name: &str) -> Option<String> {
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

pub(crate) fn remote_session_active_cwd(host: &HostConfig, raw_name: &str) -> Option<String> {
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

pub(crate) fn remote_git_root(host: &HostConfig, cwd: &str) -> Option<String> {
    run_remote_cmd_quiet(host, &["git", "-C", cwd, "rev-parse", "--show-toplevel"])
}

pub(crate) fn remote_tmux_session_is_worktree(host: &HostConfig, raw_name: &str) -> bool {
    let Some(cwd) = remote_session_active_cwd(host, raw_name) else {
        return false;
    };
    let Some(git_root) = remote_git_root(host, &cwd) else {
        return false;
    };
    session_name_matches_git_root(raw_name, &git_root)
}

pub(crate) fn tmux_session_is_missing_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("can't find session")
        || lower.contains("no server running")
        || lower.contains("no current server")
        || lower.contains("no sessions")
}
