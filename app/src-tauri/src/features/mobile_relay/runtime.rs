use super::model::MobileRelayState;
use super::network::tcp_port_open;
use super::persistence::mobile_relay_status_file;
use crate::features::control_plane::{bundled_cli_path, installed_tw_command, node_bin};

pub(super) fn read_serve_token() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let path = format!("{home}/.tw-serve-token");
    std::fs::read_to_string(&path)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn wait_for_serve(mut child: std::process::Child) -> Option<std::process::Child> {
    for _ in 0..40 {
        if tcp_port_open(8311) {
            return Some(child);
        }
        if matches!(child.try_wait(), Ok(Some(_))) {
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    let _ = child.kill();
    let _ = child.wait();
    None
}

pub(super) fn spawn_serve(app: &tauri::AppHandle) -> Result<std::process::Child, String> {
    let mut failures = Vec::new();

    if let Some(cli) = bundled_cli_path(app) {
        if let Some(node) = node_bin() {
            let cli_arg = cli.to_string_lossy().to_string();
            match std::process::Command::new(&node)
                .args([cli_arg.as_str(), "serve", "--host", "127.0.0.1"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
            {
                Ok(child) => {
                    if let Some(child) = wait_for_serve(child) {
                        return Ok(child);
                    }
                    failures.push(format!(
                        "bundled CLI did not open port 8311: {}",
                        cli.display()
                    ));
                }
                Err(err) => failures.push(format!("spawn bundled CLI: {err}")),
            }
        } else {
            failures.push("Node.js not found for bundled CLI".to_string());
        }
    } else {
        failures.push("bundled CLI resource not found".to_string());
    }

    if let Some(tw) = installed_tw_command() {
        match std::process::Command::new(&tw)
            .args(["serve", "--host", "127.0.0.1"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            Ok(child) => {
                if let Some(child) = wait_for_serve(child) {
                    return Ok(child);
                }
                failures.push(format!("installed tw did not open port 8311: {tw}"));
            }
            Err(err) => failures.push(format!("spawn installed tw: {err}")),
        }
    } else {
        failures.push("installed tw/tmux-worktree command not found".to_string());
    }

    Err(format!(
        "Failed to start mobile relay serve backend. {}. Install Node.js 20+ and install `tw` from https://github.com/Sskift/tmux-worktree.",
        failures.join("; ")
    ))
}

pub(super) fn stop_managed_serve(state: &MobileRelayState) {
    let mut serve_proc = state.serve_process.lock().unwrap();
    if let Some(ref mut child) = *serve_proc {
        let _ = child.kill();
        let _ = child.wait();
    }
    *serve_proc = None;
}

fn stop_mobile_relay_connector(state: &MobileRelayState) {
    let mut proc = state.process.lock().unwrap();
    if let Some(ref mut child) = *proc {
        let _ = child.kill();
        let _ = child.wait();
    }
    *proc = None;
    let _ = std::fs::remove_file(mobile_relay_status_file());
}

pub(crate) fn stop_mobile_relay_processes(state: &MobileRelayState) {
    stop_mobile_relay_connector(state);
    stop_managed_serve(state);
}

pub(super) fn spawn_relay_host(
    app: &tauri::AppHandle,
    relay_url: &str,
    host_id: &str,
    display_name: &str,
    secret: &str,
    token: &str,
) -> Result<std::process::Child, String> {
    let mut failures = Vec::new();
    let status_file = mobile_relay_status_file().to_string_lossy().to_string();
    let args = vec![
        "relay-host".to_string(),
        "--relay".to_string(),
        relay_url.to_string(),
        "--host-id".to_string(),
        host_id.to_string(),
        "--display-name".to_string(),
        display_name.to_string(),
        "--local".to_string(),
        "http://127.0.0.1:8311".to_string(),
        "--status-file".to_string(),
        status_file,
    ];

    if let Some(cli) = bundled_cli_path(app) {
        if let Some(node) = node_bin() {
            let cli_arg = cli.to_string_lossy().to_string();
            let mut command = std::process::Command::new(&node);
            command
                .arg(&cli_arg)
                .args(&args)
                .env("TW_DASHBOARD_CLI", &cli_arg)
                .env("TW_RELAY_SECRET", secret)
                .env("TW_TOKEN", token)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            match command.spawn() {
                Ok(child) => return Ok(child),
                Err(err) => failures.push(format!("spawn bundled relay-host: {err}")),
            }
        } else {
            failures.push("Node.js not found for bundled CLI".to_string());
        }
    } else {
        failures.push("bundled CLI resource not found".to_string());
    }

    if let Some(tw) = installed_tw_command() {
        let mut command = std::process::Command::new(&tw);
        command
            .args(&args)
            .env("TW_RELAY_SECRET", secret)
            .env("TW_TOKEN", token)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        match command.spawn() {
            Ok(child) => return Ok(child),
            Err(err) => failures.push(format!("spawn installed relay-host: {err}")),
        }
    } else {
        failures.push("installed tw/tmux-worktree command not found".to_string());
    }

    Err(format!(
        "Failed to start mobile relay connector. {}",
        failures.join("; ")
    ))
}
