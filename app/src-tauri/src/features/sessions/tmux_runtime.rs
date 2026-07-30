use super::session_name_matches_git_root;
use crate::remote::{run_remote_cmd_quiet, run_remote_tmux_quiet, HostConfig};
use crate::support::run_quiet;
use std::ffi::OsStr;
use std::io::ErrorKind;
use std::path::Path;

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

pub(crate) fn local_tmux_catalog_failure_is_empty(stdout: &[u8], stderr: &str) -> bool {
    let tmux_tmpdir = std::env::var_os("TMUX_TMPDIR");
    local_tmux_catalog_failure_is_empty_for(stdout, stderr, tmux_tmpdir.as_deref(), unsafe {
        libc::geteuid()
    })
}

fn local_tmux_catalog_failure_is_empty_for(
    stdout: &[u8],
    stderr: &str,
    tmux_tmpdir: Option<&OsStr>,
    effective_uid: libc::uid_t,
) -> bool {
    if stderr.contains("no server running") || stderr.contains("no current server") {
        return true;
    }
    if !stdout.is_empty() {
        return false;
    }
    let Some(tmux_tmpdir) = tmux_tmpdir.filter(|value| !value.is_empty()) else {
        return false;
    };
    let Ok(tmux_tmpdir) = std::fs::canonicalize(Path::new(tmux_tmpdir)) else {
        return false;
    };
    let socket_path = tmux_tmpdir
        .join(format!("tmux-{effective_uid}"))
        .join("default");
    let Some(socket_path_text) = socket_path.to_str() else {
        return false;
    };
    if stderr.trim()
        != format!("error connecting to {socket_path_text} (No such file or directory)")
    {
        return false;
    }
    matches!(
        std::fs::symlink_metadata(socket_path),
        Err(error) if error.kind() == ErrorKind::NotFound
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;

    #[test]
    fn local_tmux_catalog_empty_classifier_is_exact() {
        let temp = tempfile::tempdir().expect("tempdir");
        let tmux_tmpdir = temp.path().join("private tmux");
        std::fs::create_dir(&tmux_tmpdir).expect("tmux tmpdir");
        let effective_uid = unsafe { libc::geteuid() };
        let socket_path = std::fs::canonicalize(&tmux_tmpdir)
            .expect("canonical tmux tmpdir")
            .join(format!("tmux-{effective_uid}"))
            .join("default");
        let exact_enoent = format!(
            "error connecting to {} (No such file or directory)\n",
            socket_path.to_string_lossy()
        );
        let unexpected_path = tmux_tmpdir.join("tmux-unexpected").join("default");

        let cases = [
            ("no server running on fake", &[][..], true),
            ("no current server", &[][..], true),
            (exact_enoent.as_str(), &[][..], true),
            (exact_enoent.as_str(), b"unexpected output", false),
            (
                &format!(
                    "error connecting to {} (Connection refused)",
                    socket_path.to_string_lossy()
                ),
                &[][..],
                false,
            ),
            (
                &format!(
                    "error connecting to {} (Permission denied)",
                    socket_path.to_string_lossy()
                ),
                &[][..],
                false,
            ),
            (
                &format!(
                    "error connecting to {} (No such file or directory)",
                    unexpected_path.to_string_lossy()
                ),
                &[][..],
                false,
            ),
            (&format!("tmux: {exact_enoent}"), &[][..], false),
        ];
        for (stderr, stdout, expected) in cases {
            assert_eq!(
                local_tmux_catalog_failure_is_empty_for(
                    stdout,
                    stderr,
                    Some(tmux_tmpdir.as_os_str()),
                    effective_uid,
                ),
                expected,
                "stderr: {stderr:?}"
            );
        }

        assert!(!local_tmux_catalog_failure_is_empty_for(
            &[],
            &exact_enoent,
            None,
            effective_uid,
        ));
        assert!(!local_tmux_catalog_failure_is_empty_for(
            &[],
            &exact_enoent,
            Some(OsStr::new("")),
            effective_uid,
        ));

        std::fs::create_dir(socket_path.parent().expect("socket parent"))
            .expect("tmux socket parent");
        let _socket = UnixListener::bind(&socket_path).expect("stale tmux socket");
        assert!(!local_tmux_catalog_failure_is_empty_for(
            &[],
            &exact_enoent,
            Some(tmux_tmpdir.as_os_str()),
            effective_uid,
        ));
    }
}
