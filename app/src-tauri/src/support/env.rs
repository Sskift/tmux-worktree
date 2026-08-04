use std::path::{Path, PathBuf};

/// macOS .app launches with a minimal environment. Inherit the user's login
/// shell environment before resolving tmux, git, SSH, and agent binaries.
pub(crate) fn inherit_shell_env() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let output = std::process::Command::new(&shell)
        .args(["-l", "-c", "env -0"])
        .output();
    let output = match output {
        Ok(output) if output.status.success() => output,
        _ => return,
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    for entry in stdout.split('\0') {
        if let Some((key, value)) = entry.split_once('=') {
            if matches!(key, "PWD" | "OLDPWD" | "_" | "SHLVL") {
                continue;
            }
            unsafe {
                std::env::set_var(key, value);
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
