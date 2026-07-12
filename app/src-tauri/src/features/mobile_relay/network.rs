use crate::remote::{apply_ssh_multiplex_options, validate_ssh_host_fields, HostConfig};
use std::net::ToSocketAddrs;
use std::time::Duration;

pub(super) fn tcp_port_open(port: u16) -> bool {
    std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
}

fn tcp_addr_open(host: &str, port: u16) -> bool {
    let Ok(addrs) = (host, port).to_socket_addrs() else {
        return false;
    };
    addrs
        .into_iter()
        .any(|addr| std::net::TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok())
}

pub(super) fn direct_mobile_relay_url_for_host(host: &HostConfig, port: u16) -> String {
    let target = host.host.trim();
    let host_part = if target.contains(':') && !target.starts_with('[') {
        format!("[{target}]")
    } else {
        target.to_string()
    };
    format!("ws://{host_part}:{port}")
}

fn local_lan_ip() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let addr = socket.local_addr().ok()?;
    let ip = addr.ip();
    if ip.is_loopback() {
        None
    } else {
        Some(ip.to_string())
    }
}

fn normalize_local_mdns_name(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    let name = normalized.trim_end_matches(".local");
    if name.is_empty()
        || name.len() > 63
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return None;
    }
    Some(format!("{name}.local"))
}

fn local_mdns_name() -> Option<String> {
    let output = std::process::Command::new("/usr/sbin/scutil")
        .args(["--get", "LocalHostName"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    normalize_local_mdns_name(&String::from_utf8_lossy(&output.stdout))
}

fn start_mobile_relay_ssh_forward(
    host: &HostConfig,
    bind_host: &str,
    probe_host: &str,
    port: u16,
) -> Result<(), String> {
    validate_ssh_host_fields(host)?;
    if tcp_addr_open(probe_host, port) {
        return Ok(());
    }

    let mut cmd = mobile_relay_ssh_forward_command(host, bind_host, port)?;
    let output = cmd
        .output()
        .map_err(|err| format!("ssh forward spawn: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "start relay forward through {} failed: {}",
            host.label,
            stderr.trim()
        ));
    }

    std::thread::sleep(Duration::from_millis(250));
    if tcp_addr_open(probe_host, port) {
        Ok(())
    } else {
        Err(format!(
            "relay forward through {} did not open {}:{}",
            host.label, bind_host, port
        ))
    }
}

fn mobile_relay_ssh_forward_command(
    host: &HostConfig,
    bind_host: &str,
    port: u16,
) -> Result<std::process::Command, String> {
    validate_ssh_host_fields(host)?;
    let mut cmd = std::process::Command::new("ssh");
    cmd.arg("-fN")
        .arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ExitOnForwardFailure=yes")
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-o")
        .arg("ConnectTimeout=5")
        .arg("-o")
        .arg("ServerAliveInterval=15")
        .arg("-o")
        .arg("ServerAliveCountMax=3")
        .arg("-L")
        .arg(format!("{bind_host}:{port}:127.0.0.1:{port}"));
    apply_ssh_multiplex_options(&mut cmd);
    if let Some(remote_port) = host.port {
        cmd.arg("-p").arg(remote_port.to_string());
    }
    if let Some(key) = &host.identity_file {
        cmd.arg("-i").arg(key);
    }
    if let Some(user) = &host.user {
        cmd.arg("-l").arg(user);
    }
    cmd.arg("--").arg(&host.host);
    Ok(cmd)
}

pub(super) fn mobile_relay_forward_url_for_host(
    host: &HostConfig,
    port: u16,
) -> Result<String, String> {
    let advertised_host = local_mdns_name().or_else(local_lan_ip).ok_or_else(|| {
        "could not determine this Mac's local hostname or LAN IP for Android relay URL".to_string()
    })?;
    start_mobile_relay_ssh_forward(host, "0.0.0.0", "127.0.0.1", port)?;
    Ok(format!("ws://{advertised_host}:{port}"))
}

pub(super) fn should_preserve_mobile_relay_url(
    current: &str,
    host: &HostConfig,
    port: u16,
) -> bool {
    let trimmed = current.trim();
    !trimmed.is_empty()
        && !trimmed.contains("example.com")
        && trimmed != direct_mobile_relay_url_for_host(host, port)
}

#[cfg(test)]
mod tests {
    use super::{
        direct_mobile_relay_url_for_host, mobile_relay_ssh_forward_command,
        normalize_local_mdns_name, should_preserve_mobile_relay_url,
    };
    use crate::remote::HostConfig;

    fn host(address: &str) -> HostConfig {
        HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: address.to_string(),
            user: Some("alice".to_string()),
            port: Some(2222),
            identity_file: Some("/tmp/dev key".to_string()),
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        }
    }

    #[test]
    fn mobile_relay_uses_a_stable_local_mdns_name() {
        assert_eq!(
            normalize_local_mdns_name("Desk-Mac\n"),
            Some("desk-mac.local".to_string())
        );
        assert_eq!(
            normalize_local_mdns_name("desk-mac.local"),
            Some("desk-mac.local".to_string())
        );
        assert_eq!(normalize_local_mdns_name("bad host"), None);
    }

    #[test]
    fn mobile_relay_direct_url_brackets_ipv6_hosts() {
        assert_eq!(
            direct_mobile_relay_url_for_host(&host("2605:340::1"), 8787),
            "ws://[2605:340::1]:8787"
        );
        assert_eq!(
            direct_mobile_relay_url_for_host(&host("[2605:340::1]"), 8787),
            "ws://[2605:340::1]:8787"
        );
    }

    #[test]
    fn mobile_relay_preserves_only_non_default_non_direct_urls() {
        let host = host("relay.example.net");
        assert!(should_preserve_mobile_relay_url(
            "ws://desk-mac.local:8787",
            &host,
            8787
        ));
        assert!(!should_preserve_mobile_relay_url("", &host, 8787));
        assert!(!should_preserve_mobile_relay_url(
            "wss://relay.example.com",
            &host,
            8787
        ));
        assert!(!should_preserve_mobile_relay_url(
            "ws://relay.example.net:8787",
            &host,
            8787
        ));
    }

    #[test]
    fn mobile_relay_ssh_forward_ends_options_before_destination() {
        let command = mobile_relay_ssh_forward_command(&host("ssh-host"), "127.0.0.1", 8787)
            .expect("relay forward command");
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        let separator = args.iter().position(|arg| arg == "--").expect("relay --");
        assert_eq!(
            args.get(separator + 1).map(String::as_str),
            Some("ssh-host")
        );
        assert!(args.windows(2).any(|pair| pair == ["-l", "alice"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["-L", "127.0.0.1:8787:127.0.0.1:8787"]));
        assert!(!args.iter().any(|arg| arg == "alice@ssh-host"));
    }
}
