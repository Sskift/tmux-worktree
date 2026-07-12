use super::{validate_ssh_host_fields, HostConfig};
use crate::support::{
    app_home_dir_or_tmp, remote_path_expr, shell_join, shell_quote, user_bin_path_prefix,
};
use std::io::Write;

fn ssh_control_path() -> Option<String> {
    let directory = app_home_dir_or_tmp().join(".tmux-worktree").join("ssh");
    std::fs::create_dir_all(&directory).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = std::fs::metadata(&directory).ok()?.permissions();
        permissions.set_mode(0o700);
        std::fs::set_permissions(&directory, permissions).ok()?;
    }
    Some(directory.join("%C").to_string_lossy().to_string())
}

pub(crate) fn apply_ssh_multiplex_options(command: &mut std::process::Command) {
    let Some(control_path) = ssh_control_path() else {
        return;
    };
    command
        .arg("-o")
        .arg("ControlMaster=auto")
        .arg("-o")
        .arg("ControlPersist=600")
        .arg("-o")
        .arg(format!("ControlPath={control_path}"));
}

/// Build an SSH command that runs `remote_cmd` on `host` non-interactively.
/// Uses BatchMode=yes to avoid hanging on password prompts.
pub(crate) fn ssh_command(
    host: &HostConfig,
    remote_cmd: &[&str],
) -> Result<std::process::Command, String> {
    validate_ssh_host_fields(host)?;
    let mut cmd = std::process::Command::new("ssh");
    cmd.arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-o")
        .arg("ConnectTimeout=5")
        .arg("-o")
        .arg("ServerAliveInterval=15")
        .arg("-o")
        .arg("ServerAliveCountMax=3");
    apply_ssh_multiplex_options(&mut cmd);
    if let Some(port) = host.port {
        cmd.arg("-p").arg(port.to_string());
    }
    if let Some(key) = &host.identity_file {
        cmd.arg("-i").arg(key);
    }
    if let Some(user) = &host.user {
        cmd.arg("-l").arg(user);
    }
    // End local option parsing before the destination. Validation above is a
    // second line of defence for callers loading hand-edited legacy config.
    cmd.arg("--").arg(&host.host);
    if !remote_cmd.is_empty() {
        cmd.arg(format!(
            "{}; {}",
            user_bin_path_prefix(),
            shell_join(remote_cmd)
        ));
    }
    Ok(cmd)
}

pub(crate) fn remote_tmux_cmd(host: &HostConfig) -> String {
    remote_path_expr(host.tmux_path.as_deref().unwrap_or("tmux"))
}

pub(crate) fn remote_tw_cmd(host: &HostConfig) -> String {
    remote_path_expr(host.tw_path.as_deref().unwrap_or("tw"))
}

fn has_custom_tmux_path(host: &HostConfig) -> bool {
    host.tmux_path
        .as_deref()
        .is_some_and(|path| !path.trim().is_empty())
}

fn has_custom_tw_path(host: &HostConfig) -> bool {
    host.tw_path
        .as_deref()
        .is_some_and(|path| !path.trim().is_empty())
}

/// Build an SSH command for interactive PTY use (no BatchMode, force TTY with -tt).
#[allow(dead_code)]
pub(crate) fn ssh_command_interactive(
    host: &HostConfig,
    remote_cmd: &[&str],
) -> Result<std::process::Command, String> {
    validate_ssh_host_fields(host)?;
    let mut cmd = std::process::Command::new("ssh");
    cmd.arg("-tt")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-o")
        .arg("ConnectTimeout=10")
        .arg("-o")
        .arg("ServerAliveInterval=15")
        .arg("-o")
        .arg("ServerAliveCountMax=3");
    apply_ssh_multiplex_options(&mut cmd);
    if let Some(port) = host.port {
        cmd.arg("-p").arg(port.to_string());
    }
    if let Some(key) = &host.identity_file {
        cmd.arg("-i").arg(key);
    }
    if let Some(user) = &host.user {
        cmd.arg("-l").arg(user);
    }
    cmd.arg("--").arg(&host.host);
    if !remote_cmd.is_empty() {
        cmd.arg(shell_join(remote_cmd));
    }
    Ok(cmd)
}

/// Run a command on a remote host and return stdout.
pub(crate) fn run_remote_cmd_output(
    host: &HostConfig,
    remote_cmd: &[&str],
) -> Result<std::process::Output, String> {
    ssh_command(host, remote_cmd)?
        .output()
        .map_err(|error| format!("ssh spawn: {error}"))
}

pub(crate) fn run_remote_cmd_with_input(
    host: &HostConfig,
    remote_cmd: &[&str],
    input: &[u8],
) -> Result<std::process::Output, String> {
    let mut child = ssh_command(host, remote_cmd)?
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("ssh spawn: {error}"))?;

    let write_result = child
        .stdin
        .take()
        .ok_or_else(|| "ssh stdin unavailable".to_string())
        .and_then(|mut stdin| {
            stdin
                .write_all(input)
                .map_err(|error| format!("write ssh stdin: {error}"))
        });
    if let Err(error) = write_result {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }

    child
        .wait_with_output()
        .map_err(|error| format!("wait for ssh: {error}"))
}

pub(crate) fn run_remote_cmd_check(
    host: &HostConfig,
    remote_cmd: &[&str],
) -> Result<String, String> {
    let output = run_remote_cmd_output(host, remote_cmd)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ssh on {} failed: {}", host.label, stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub(crate) fn run_remote_cmd_check_strings(
    host: &HostConfig,
    remote_cmd: &[String],
) -> Result<String, String> {
    let refs = remote_cmd.iter().map(String::as_str).collect::<Vec<_>>();
    run_remote_cmd_check(host, &refs)
}

pub(crate) fn run_remote_cmd_quiet(host: &HostConfig, remote_cmd: &[&str]) -> Option<String> {
    run_remote_cmd_check(host, remote_cmd).ok()
}

/// Run a tw subcommand on a remote host and return stdout.
pub(crate) fn run_remote_tw_check(host: &HostConfig, tw_args: &[&str]) -> Result<String, String> {
    if !has_custom_tmux_path(host) && !has_custom_tw_path(host) {
        let mut full_args = Vec::with_capacity(tw_args.len() + 1);
        full_args.push("tw");
        full_args.extend_from_slice(tw_args);
        return run_remote_cmd_check(host, &full_args);
    }

    let mut command = String::new();
    if has_custom_tmux_path(host) {
        command.push_str("TW_TMUX=");
        command.push_str(&remote_tmux_cmd(host));
        command.push(' ');
    }
    command.push_str(&remote_tw_cmd(host));
    for arg in tw_args {
        command.push(' ');
        command.push_str(&shell_quote(arg));
    }
    run_remote_cmd_check(host, &["sh", "-c", &command])
}

/// Run a tmux subcommand on a remote host and return stdout.
pub(crate) fn run_remote_tmux_check(
    host: &HostConfig,
    tmux_args: &[&str],
) -> Result<String, String> {
    if !has_custom_tmux_path(host) {
        let mut full_args = Vec::with_capacity(tmux_args.len() + 1);
        full_args.push("tmux");
        full_args.extend_from_slice(tmux_args);
        return run_remote_cmd_check(host, &full_args);
    }

    let mut command = remote_tmux_cmd(host);
    for arg in tmux_args {
        command.push(' ');
        command.push_str(&shell_quote(arg));
    }
    run_remote_cmd_check(host, &["sh", "-c", &command])
}

pub(crate) fn run_remote_tmux_output(
    host: &HostConfig,
    tmux_args: &[&str],
) -> Result<std::process::Output, String> {
    if !has_custom_tmux_path(host) {
        let mut full_args = Vec::with_capacity(tmux_args.len() + 1);
        full_args.push("tmux");
        full_args.extend_from_slice(tmux_args);
        return run_remote_cmd_output(host, &full_args);
    }

    let mut command = remote_tmux_cmd(host);
    for arg in tmux_args {
        command.push(' ');
        command.push_str(&shell_quote(arg));
    }
    run_remote_cmd_output(host, &["sh", "-c", &command])
}

/// Quiet variant that returns None on failure.
pub(crate) fn run_remote_tmux_quiet(host: &HostConfig, tmux_args: &[&str]) -> Option<String> {
    run_remote_tmux_check(host, tmux_args).ok()
}

pub(crate) fn remote_home_dir_for_host(host: &HostConfig) -> Result<String, String> {
    let home = run_remote_cmd_check(
        host,
        &[
            "sh",
            "-c",
            "cd \"${HOME:-.}\" 2>/dev/null && pwd -P || printf %s \"${HOME:-/}\"",
        ],
    )
    .map_err(|error| format!("read remote home on {}: {error}", host.label))?;
    let home = home.trim();
    if home.is_empty() {
        return Err(format!("remote home on {} is empty", host.label));
    }
    Ok(home.to_string())
}
