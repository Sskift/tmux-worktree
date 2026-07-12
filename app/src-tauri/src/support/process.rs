use std::sync::OnceLock;

pub(crate) fn tmux_bin() -> &'static str {
    static BIN: OnceLock<String> = OnceLock::new();
    BIN.get_or_init(|| {
        for path in [
            "/opt/homebrew/bin/tmux",
            "/usr/local/bin/tmux",
            "/usr/bin/tmux",
        ] {
            if std::path::Path::new(path).exists() {
                return path.to_string();
            }
        }
        "tmux".to_string()
    })
}

pub(crate) fn git_bin() -> &'static str {
    static BIN: OnceLock<String> = OnceLock::new();
    BIN.get_or_init(|| {
        for path in [
            "/opt/homebrew/bin/git",
            "/usr/local/bin/git",
            "/usr/bin/git",
        ] {
            if std::path::Path::new(path).exists() {
                return path.to_string();
            }
        }
        "git".to_string()
    })
}

pub(crate) fn resolve_cmd(name: &str) -> &str {
    match name {
        "tmux" => tmux_bin(),
        "git" => git_bin(),
        _ => name,
    }
}
