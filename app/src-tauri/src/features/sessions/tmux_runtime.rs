pub(crate) fn tmux_session_is_missing_error(error: &str) -> bool {
    let lower = error.to_ascii_lowercase();
    lower.contains("can't find session")
        || lower.contains("no server running")
        || lower.contains("no current server")
        || lower.contains("no sessions")
}
