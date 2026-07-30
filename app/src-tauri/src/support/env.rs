use std::path::{Path, PathBuf};

const SEALED_LAUNCHER_ENV: [&str; 2] = ["TW_DASHBOARD_HOME", "TMUX_TMPDIR"];
const CLEARED_LAUNCHER_ENV: [&str; 5] = [
    "TMUX",
    "TMUX_PANE",
    "TW_TERMINAL_CONTROL_SOCKET",
    "TW_TERMINAL_CONTROL_STATE",
    "TW_TERMINAL_CONTROL_OUTPUT_DIR",
];

fn is_protected_login_shell_env(key: &str) -> bool {
    SEALED_LAUNCHER_ENV.contains(&key) || CLEARED_LAUNCHER_ENV.contains(&key)
}

/// macOS .app launches with a minimal environment. Inherit the user's login
/// shell environment before resolving tmux, git, SSH, and agent binaries.
pub(crate) fn inherit_shell_env() {
    let sealed_namespace = match (
        std::env::var_os("TW_DASHBOARD_HOME"),
        std::env::var_os("TMUX_TMPDIR"),
    ) {
        (Some(home), Some(tmux_tmpdir)) => Some((home, tmux_tmpdir)),
        _ => None,
    };
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = std::process::Command::new(&shell)
        .args(["-l", "-c", "env -0"])
        .output();
    if let Ok(output) = output {
        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for entry in stdout.split('\0') {
                if let Some((key, value)) = entry.split_once('=') {
                    if matches!(key, "PWD" | "OLDPWD" | "_" | "SHLVL")
                        || (sealed_namespace.is_some() && is_protected_login_shell_env(key))
                    {
                        continue;
                    }
                    unsafe {
                        std::env::set_var(key, value);
                    }
                }
            }
        }
    }
    if let Some((home, tmux_tmpdir)) = sealed_namespace {
        unsafe {
            std::env::set_var("TW_DASHBOARD_HOME", home);
            std::env::set_var("TMUX_TMPDIR", tmux_tmpdir);
            for key in CLEARED_LAUNCHER_ENV {
                std::env::remove_var(key);
            }
        }
    }
}

pub(crate) fn app_home_dir() -> Option<PathBuf> {
    std::env::var_os("TW_DASHBOARD_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
}

pub(crate) fn app_home_dir_or_tmp() -> PathBuf {
    app_home_dir().unwrap_or_else(|| PathBuf::from("/tmp"))
}

pub(crate) const LEGACY_DEFAULT_WORKTREE_BASE: &str = "/private/tmp/tmux-worktree/projects";

pub(crate) fn default_worktree_base() -> String {
    app_home_dir_or_tmp()
        .join(".tmux-worktree")
        .join("worktrees")
        .to_string_lossy()
        .to_string()
}

pub(crate) fn expand_home_path_with_home(value: &str, home: &str) -> String {
    let trimmed = value.trim();
    if trimmed == "~" {
        return home.to_string();
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        return Path::new(home).join(rest).to_string_lossy().to_string();
    }
    trimmed.to_string()
}

pub(crate) fn expand_home_path(value: &str) -> String {
    let home = app_home_dir_or_tmp().to_string_lossy().to_string();
    expand_home_path_with_home(value, &home)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::os::unix::fs::PermissionsExt;

    fn restore_env(name: &str, value: Option<OsString>) {
        unsafe {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }

    #[test]
    fn login_shell_cannot_replace_or_escape_a_sealed_dashboard_namespace() {
        let _guard = crate::tests::test_env_lock().lock().expect("test env lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let shell = temp.path().join("hostile-login-shell");
        std::fs::write(
            &shell,
            concat!(
                "#!/bin/sh\n",
                "printf 'TW_DASHBOARD_HOME=/hostile/home\\0",
                "TMUX_TMPDIR=/hostile/tmux\\0",
                "TMUX=/hostile/tmux/default,9,0\\0",
                "TMUX_PANE=%%9\\0",
                "TW_TERMINAL_CONTROL_SOCKET=/hostile/control.sock\\0",
                "TW_TERMINAL_CONTROL_STATE=/hostile/control.json\\0",
                "TW_TERMINAL_CONTROL_OUTPUT_DIR=/hostile/output\\0",
                "TW_LOGIN_SHELL_TEST=imported\\0'\n",
            ),
        )
        .expect("write hostile shell");
        let mut permissions = std::fs::metadata(&shell)
            .expect("hostile shell metadata")
            .permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&shell, permissions).expect("chmod hostile shell");

        let variables = [
            "SHELL",
            "TW_DASHBOARD_HOME",
            "TMUX_TMPDIR",
            "TMUX",
            "TMUX_PANE",
            "TW_TERMINAL_CONTROL_SOCKET",
            "TW_TERMINAL_CONTROL_STATE",
            "TW_TERMINAL_CONTROL_OUTPUT_DIR",
            "TW_LOGIN_SHELL_TEST",
        ];
        let original = variables
            .iter()
            .map(|name| (*name, std::env::var_os(name)))
            .collect::<Vec<_>>();
        let sealed_home = temp.path().join("sealed-home").into_os_string();
        let sealed_tmux = temp.path().join("sealed-tmux").into_os_string();

        unsafe {
            std::env::set_var("SHELL", &shell);
            std::env::set_var("TW_DASHBOARD_HOME", &sealed_home);
            std::env::set_var("TMUX_TMPDIR", &sealed_tmux);
            std::env::set_var("TMUX", "/inherited/tmux/default,8,0");
            std::env::set_var("TMUX_PANE", "%8");
            std::env::set_var("TW_TERMINAL_CONTROL_SOCKET", "/inherited/control.sock");
            std::env::set_var("TW_TERMINAL_CONTROL_STATE", "/inherited/control.json");
            std::env::set_var("TW_TERMINAL_CONTROL_OUTPUT_DIR", "/inherited/output");
            std::env::remove_var("TW_LOGIN_SHELL_TEST");
        }

        inherit_shell_env();

        assert_eq!(std::env::var_os("TW_DASHBOARD_HOME"), Some(sealed_home));
        assert_eq!(std::env::var_os("TMUX_TMPDIR"), Some(sealed_tmux));
        for key in CLEARED_LAUNCHER_ENV {
            assert_eq!(std::env::var_os(key), None, "{key} must be removed");
        }
        assert_eq!(
            std::env::var_os("TW_LOGIN_SHELL_TEST"),
            Some(OsString::from("imported"))
        );

        for (name, value) in original {
            restore_env(name, value);
        }
    }

    #[test]
    fn login_shell_imports_dashboard_namespace_when_launch_is_not_sealed() {
        let _guard = crate::tests::test_env_lock().lock().expect("test env lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let shell = temp.path().join("login-shell");
        std::fs::write(
            &shell,
            concat!(
                "#!/bin/sh\n",
                "printf 'TW_DASHBOARD_HOME=/login/home\\0",
                "TMUX_TMPDIR=/login/tmux\\0",
                "TW_TERMINAL_CONTROL_SOCKET=/login/control.sock\\0",
                "TW_TERMINAL_CONTROL_STATE=/login/control.json\\0",
                "TW_TERMINAL_CONTROL_OUTPUT_DIR=/login/output\\0'\n",
            ),
        )
        .expect("write login shell");
        let mut permissions = std::fs::metadata(&shell)
            .expect("login shell metadata")
            .permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&shell, permissions).expect("chmod login shell");

        let variables = [
            "SHELL",
            "TW_DASHBOARD_HOME",
            "TMUX_TMPDIR",
            "TW_TERMINAL_CONTROL_SOCKET",
            "TW_TERMINAL_CONTROL_STATE",
            "TW_TERMINAL_CONTROL_OUTPUT_DIR",
        ];
        let original = variables
            .iter()
            .map(|name| (*name, std::env::var_os(name)))
            .collect::<Vec<_>>();

        unsafe {
            std::env::set_var("SHELL", &shell);
            for key in &variables[1..] {
                std::env::remove_var(key);
            }
        }

        inherit_shell_env();

        assert_eq!(
            std::env::var_os("TW_DASHBOARD_HOME"),
            Some(OsString::from("/login/home"))
        );
        assert_eq!(
            std::env::var_os("TMUX_TMPDIR"),
            Some(OsString::from("/login/tmux"))
        );
        assert_eq!(
            std::env::var_os("TW_TERMINAL_CONTROL_SOCKET"),
            Some(OsString::from("/login/control.sock"))
        );
        assert_eq!(
            std::env::var_os("TW_TERMINAL_CONTROL_STATE"),
            Some(OsString::from("/login/control.json"))
        );
        assert_eq!(
            std::env::var_os("TW_TERMINAL_CONTROL_OUTPUT_DIR"),
            Some(OsString::from("/login/output"))
        );

        for (name, value) in original {
            restore_env(name, value);
        }
    }
}
