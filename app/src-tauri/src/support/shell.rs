use std::ffi::OsStr;
use std::path::{Path, PathBuf};

const USER_HOME_BIN_PATHS: [&str; 3] = [".local/bin", ".npm-global/bin", ".bun/bin"];
const USER_ABSOLUTE_BIN_PATHS: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];

pub(crate) fn shell_quote(value: &str) -> String {
    if value.is_empty() {
        return "''".to_string();
    }
    let mut quoted = String::from("'");
    for character in value.chars() {
        if character == '\'' {
            quoted.push_str("'\\''");
        } else {
            quoted.push(character);
        }
    }
    quoted.push('\'');
    quoted
}

pub(crate) fn user_bin_path_prefix() -> String {
    let entries = USER_HOME_BIN_PATHS
        .iter()
        .map(|path| format!("$HOME/{path}"))
        .chain(
            USER_ABSOLUTE_BIN_PATHS
                .iter()
                .map(|path| (*path).to_string()),
        )
        .collect::<Vec<_>>()
        .join(":");
    format!("export PATH=\"{entries}:$PATH\"")
}

pub(crate) fn user_bin_search_paths(
    home: Option<&Path>,
    inherited_path: Option<&OsStr>,
) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut push_unique = |path: PathBuf| {
        if !paths.contains(&path) {
            paths.push(path);
        }
    };

    if let Some(home) = home {
        for relative in USER_HOME_BIN_PATHS {
            push_unique(home.join(relative));
        }
    }
    for absolute in USER_ABSOLUTE_BIN_PATHS {
        push_unique(PathBuf::from(absolute));
    }
    if let Some(inherited_path) = inherited_path {
        for path in std::env::split_paths(inherited_path) {
            push_unique(path);
        }
    }
    paths
}

pub(crate) fn shell_join(args: &[&str]) -> String {
    args.iter()
        .map(|argument| shell_quote(argument))
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn remote_path_expr(value: &str) -> String {
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

pub(crate) fn command_then_login_shell(command: &str) -> String {
    let path = user_bin_path_prefix();
    let shell = "exec \"${SHELL:-/bin/zsh}\" -l";
    if command.trim().is_empty() {
        format!("{path}; {shell}")
    } else {
        format!("{path}; {command}; {shell}")
    }
}
