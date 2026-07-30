use super::model::MobileRelayState;
use super::network::tcp_port_open;
use super::persistence::mobile_relay_status_file;
use crate::features::control_plane::{bundled_cli_path, installed_tw_command, node_bin};
use crate::support::app_home_dir;
use std::path::{Path, PathBuf};

pub(super) fn read_serve_token() -> String {
    let path = app_home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".tw-serve-token");
    std::fs::read_to_string(&path)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn apply_local_runtime_namespace(command: &mut std::process::Command, home: &Path) {
    command.env("HOME", &home).env("TW_DASHBOARD_HOME", &home);
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
    let home = app_home_dir().ok_or("home dir not found")?;
    let mut failures = Vec::new();

    if let Some(cli) = bundled_cli_path(app) {
        if let Some(node) = node_bin() {
            let cli_arg = cli.to_string_lossy().to_string();
            let mut command = std::process::Command::new(&node);
            apply_local_runtime_namespace(&mut command, &home);
            match command
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
        let mut command = std::process::Command::new(&tw);
        apply_local_runtime_namespace(&mut command, &home);
        match command
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
    let home = app_home_dir().ok_or("home dir not found")?;
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
            apply_local_runtime_namespace(&mut command, &home);
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
        apply_local_runtime_namespace(&mut command, &home);
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn restore_env(name: &str, value: Option<OsString>) {
        unsafe {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }

    #[test]
    fn relay_v1_token_and_children_share_the_dashboard_runtime_home() {
        let _guard = crate::tests::test_env_lock().lock().expect("test env lock");
        let account_home = tempfile::tempdir().expect("account home");
        let dashboard_home = tempfile::tempdir().expect("dashboard home");
        std::fs::write(
            account_home.path().join(".tw-serve-token"),
            "account-token\n",
        )
        .expect("account token");
        std::fs::write(
            dashboard_home.path().join(".tw-serve-token"),
            "dashboard-token\n",
        )
        .expect("dashboard token");
        let original_home = std::env::var_os("HOME");
        let original_dashboard_home = std::env::var_os("TW_DASHBOARD_HOME");

        unsafe {
            std::env::set_var("HOME", account_home.path());
            std::env::set_var("TW_DASHBOARD_HOME", dashboard_home.path());
        }

        assert_eq!(read_serve_token(), "dashboard-token");
        let mut command = std::process::Command::new("/bin/sh");
        apply_local_runtime_namespace(&mut command, dashboard_home.path());
        let output = command
            .args(["-c", "printf '%s\\n%s\\n' \"$HOME\" \"$TW_DASHBOARD_HOME\""])
            .output()
            .expect("run child");
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout).expect("child output"),
            format!(
                "{}\n{}\n",
                dashboard_home.path().display(),
                dashboard_home.path().display()
            )
        );

        restore_env("HOME", original_home);
        restore_env("TW_DASHBOARD_HOME", original_dashboard_home);
    }
}
