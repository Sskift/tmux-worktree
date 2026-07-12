use crate::remote::{apply_ssh_multiplex_options, validate_ssh_host_fields, HostConfig};
use std::path::Path;

fn scp_remote_target(host: &HostConfig, remote_path: &str) -> String {
    let target = match &host.user {
        Some(user) => format!("{user}@{}", host.host),
        None => host.host.clone(),
    };
    format!("{target}:{remote_path}")
}

pub(crate) fn scp_cli_command(
    host: &HostConfig,
    cli: &Path,
    remote_path: &str,
) -> Result<std::process::Command, String> {
    validate_ssh_host_fields(host)?;
    let mut cmd = std::process::Command::new("scp");
    cmd.arg("-q")
        .arg("-o")
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
        cmd.arg("-P").arg(port.to_string());
    }
    if let Some(key) = &host.identity_file {
        cmd.arg("-i").arg(key);
    }
    // scp does not use ssh's `-l <user>` spelling (`scp -l` is a bandwidth
    // limit), so retain the validated user@host destination and terminate
    // option parsing before both operands.
    cmd.arg("--")
        .arg(cli)
        .arg(scp_remote_target(host, remote_path));
    Ok(cmd)
}

pub(crate) fn scp_cli_to_host(
    host: &HostConfig,
    cli: &Path,
    remote_path: &str,
) -> Result<(), String> {
    let output = scp_cli_command(host, cli, remote_path)?
        .output()
        .map_err(|e| format!("scp spawn: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("scp to {} failed: {}", host.label, stderr.trim()));
    }
    Ok(())
}
