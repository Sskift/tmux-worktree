use std::sync::OnceLock;

/// Whether a process with `pid` is currently alive. Uses `kill(pid, 0)`
/// (no signal is actually delivered): success or EPERM means the process
/// exists (EPERM = it belongs to another user but is definitely running),
/// ESRCH means it is gone. Any other probe error is treated as alive:
/// a transient permission/environment failure must never let one writer
/// steal a lock a live holder may still own. Mirrors Node
/// `processExists()` in src/state.ts / src/feishuBridgeStorage.ts; if
/// the lock owner record format ever changes, both sides move together.
#[cfg(unix)]
pub(crate) fn process_exists(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if result == 0 {
        return true;
    }
    // ESRCH = no such process => dead. Any other error (EPERM etc.)
    // is conservatively alive: fail-closed so a probe glitch never
    // authorizes stealing a live holder's lock.
    !matches!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(code) if code == libc::ESRCH
    )
}

/// The Dashboard ships on macOS/Unix only; off-unix there is no
/// signal probe, so fail closed (assume alive) and never reclaim a
/// pid-bearing lock based on this check.
#[cfg(not(unix))]
pub(crate) fn process_exists(_pid: u32) -> bool {
    true
}

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

pub(crate) fn run_check(args: &[&str]) -> Result<String, String> {
    let bin = resolve_cmd(args[0]);
    let output = std::process::Command::new(bin)
        .args(&args[1..])
        .output()
        .map_err(|e| format!("spawn {}: {e}", args[0]))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "{} failed ({}): {}",
            args[0],
            output.status,
            stderr.trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub(crate) fn run_quiet(args: &[&str]) -> Option<String> {
    let bin = resolve_cmd(args[0]);
    let output = std::process::Command::new(bin)
        .args(&args[1..])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
