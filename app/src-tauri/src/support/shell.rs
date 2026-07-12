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

pub(crate) fn user_bin_path_prefix() -> &'static str {
    "export PATH=\"$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\""
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
