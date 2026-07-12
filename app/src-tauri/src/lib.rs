mod config;
mod features;
mod ipc;
mod remote;
mod support;

use config::*;
use features::*;
use ipc::*;
use remote::*;
use support::*;

use serde::{Deserialize, Serialize};
use std::net::ToSocketAddrs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Manager, State};

struct MobileRelayState {
    process: Mutex<Option<std::process::Child>>,
    serve_process: Mutex<Option<std::process::Child>>,
    relay_url: Mutex<String>,
    host_id: Mutex<String>,
    secret: Mutex<String>,
    token: Mutex<String>,
    last_error: Mutex<Option<String>>,
}

impl Default for MobileRelayState {
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
            serve_process: Mutex::new(None),
            relay_url: Mutex::new("wss://relay.example.com".to_string()),
            host_id: Mutex::new("mac-admin".to_string()),
            secret: Mutex::new(String::new()),
            token: Mutex::new(String::new()),
            last_error: Mutex::new(None),
        }
    }
}

#[tauri::command]
fn trigger_automation(app: tauri::AppHandle, id: String) -> Result<AutomationRun, String> {
    trigger_automation_with_creator(id, |args| create_worktree(app, args))
}

fn trigger_automation_with_creator<F>(id: String, create: F) -> Result<AutomationRun, String>
where
    F: FnOnce(CreateArgs) -> Result<String, String>,
{
    let mut automations = load_automations_from_disk()?;
    let index = automations
        .iter()
        .position(|automation| automation.id == id)
        .ok_or_else(|| format!("automation not found: {id}"))?;
    let automation = automations[index].clone();
    let now = now_rfc3339();
    let session_exists = automation
        .last_session
        .as_ref()
        .map(|session| tmux_session_exists(session.clone()).unwrap_or(false))
        .unwrap_or(false);

    if should_skip_automation_overlap(&automation, session_exists) {
        let run = AutomationRun {
            id: new_prefixed_id("run"),
            automation_id: automation.id.clone(),
            started_at: now.clone(),
            finished_at: Some(now),
            status: AutomationStatus::Skipped,
            session_name: automation.last_session.clone(),
            error: Some("automation already has a live running session".to_string()),
        };
        let mut runs = load_automation_runs_from_disk()?;
        append_automation_run(&mut runs, run.clone());
        save_automation_runs_to_disk(&runs)?;
        return Ok(run);
    }

    let ai_cmd = automation_command_with_instruction(&automation.ai_cmd, &automation.instruction);
    let start_result = create(CreateArgs {
        project: automation.project.clone().and_then(trimmed_non_empty),
        path: automation.path.clone().and_then(trimmed_non_empty),
        ai_cmd,
        name: Some(automation.name.clone()),
        branch: None,
        host_id: None,
    });

    let mut runs = load_automation_runs_from_disk()?;
    let run = match start_result {
        Ok(session) => {
            automations[index].last_run_at = Some(now.clone());
            automations[index].last_status = AutomationStatus::Running;
            automations[index].last_session = Some(session.clone());
            AutomationRun {
                id: new_prefixed_id("run"),
                automation_id: automation.id,
                started_at: now,
                finished_at: None,
                status: AutomationStatus::Running,
                session_name: Some(session),
                error: None,
            }
        }
        Err(error) => {
            automations[index].last_run_at = Some(now.clone());
            automations[index].last_status = AutomationStatus::Failed;
            AutomationRun {
                id: new_prefixed_id("run"),
                automation_id: automation.id,
                started_at: now.clone(),
                finished_at: Some(now),
                status: AutomationStatus::Failed,
                session_name: None,
                error: Some(error),
            }
        }
    };

    append_automation_run(&mut runs, run.clone());
    save_automations_to_disk(&automations)?;
    save_automation_runs_to_disk(&runs)?;
    Ok(run)
}

// ── Mobile relay connector ──

fn read_serve_token() -> String {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let path = format!("{home}/.tw-serve-token");
    std::fs::read_to_string(&path)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn tcp_port_open(port: u16) -> bool {
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

fn spawn_serve(app: &tauri::AppHandle) -> Result<std::process::Child, String> {
    let mut failures = Vec::new();

    if let Some(cli) = bundled_cli_path(app) {
        if let Some(node) = node_bin() {
            let cli_arg = cli.to_string_lossy().to_string();
            match std::process::Command::new(&node)
                .args([cli_arg.as_str(), "serve"])
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
            .arg("serve")
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

fn set_mobile_relay_error(state: &MobileRelayState, message: Option<String>) {
    let mut last_error = state.last_error.lock().unwrap();
    *last_error = message;
}

fn stop_managed_serve(state: &MobileRelayState) {
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

fn stop_mobile_relay_processes(state: &MobileRelayState) {
    stop_mobile_relay_connector(state);
    stop_managed_serve(state);
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MobileRelayStatus {
    active: bool,
    connected: bool,
    connection_state: String,
    relay_url: String,
    host_id: String,
    secret: String,
    token: String,
    connected_at: Option<u64>,
    updated_at: Option<u64>,
    retry_in_ms: Option<u64>,
    error: Option<String>,
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct RelayHostRuntimeStatus {
    state: String,
    relay_url: String,
    host_id: String,
    connected_at: Option<u64>,
    updated_at: Option<u64>,
    retry_in_ms: Option<u64>,
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobileRelayConfigInput {
    relay_url: String,
    host_id: String,
    secret: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MobileRelayBrokerInput {
    host_id: String,
    port: Option<u16>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct MobileRelayConfig {
    relay_url: String,
    host_id: String,
    display_name: String,
    secret: String,
}

fn config_string_field(config: &serde_json::Value, fields: &[&str]) -> Option<String> {
    let object = config.as_object()?;
    fields.iter().find_map(|field| {
        object
            .get(*field)
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn mobile_relay_config_from_value(config: &serde_json::Value) -> MobileRelayConfig {
    let relay = config
        .get("mobileRelay")
        .or_else(|| config.get("relay"))
        .unwrap_or(config);
    MobileRelayConfig {
        relay_url: config_string_field(relay, &["relayUrl", "url", "broker", "brokerUrl"])
            .or_else(|| config_string_field(config, &["mobileRelayUrl", "relayUrl"]))
            .unwrap_or_default(),
        host_id: config_string_field(relay, &["hostId", "host", "adminHostId"])
            .or_else(|| config_string_field(config, &["mobileRelayHostId", "relayHostId"]))
            .unwrap_or_default(),
        display_name: config_string_field(relay, &["displayName", "name", "label"])
            .or_else(|| {
                config_string_field(config, &["mobileRelayDisplayName", "relayDisplayName"])
            })
            .unwrap_or_default(),
        secret: config_string_field(relay, &["secret", "token", "relaySecret"])
            .or_else(|| config_string_field(config, &["mobileRelaySecret", "relaySecret"]))
            .unwrap_or_default(),
    }
}

fn load_mobile_relay_config_file() -> MobileRelayConfig {
    let Some(home) = app_home_dir() else {
        return MobileRelayConfig::default();
    };
    let config_path = home.join(".tmux-worktree.json");
    let Ok(content) = std::fs::read_to_string(config_path) else {
        return MobileRelayConfig::default();
    };
    let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) else {
        return MobileRelayConfig::default();
    };
    mobile_relay_config_from_value(&config)
}

fn env_non_empty(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn config_or_default(value: &str, default: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        default.to_string()
    } else {
        trimmed.to_string()
    }
}

fn mobile_relay_config() -> MobileRelayConfig {
    let file = load_mobile_relay_config_file();
    MobileRelayConfig {
        relay_url: env_non_empty("TW_RELAY_URL")
            .unwrap_or_else(|| config_or_default(&file.relay_url, "wss://relay.example.com")),
        host_id: env_non_empty("TW_RELAY_HOST_ID")
            .unwrap_or_else(|| config_or_default(&file.host_id, "mac-admin")),
        display_name: env_non_empty("TW_RELAY_DISPLAY_NAME")
            .unwrap_or_else(|| config_or_default(&file.display_name, "Mac Admin")),
        secret: env_non_empty("TW_RELAY_SECRET").unwrap_or_else(|| file.secret.trim().to_string()),
    }
}

fn save_mobile_relay_config_file(
    args: &MobileRelayConfigInput,
) -> Result<MobileRelayConfig, String> {
    let home = app_home_dir().ok_or("home dir not found")?;
    let config_path = home.join(".tmux-worktree.json");
    let _guard = dashboard_config_write_lock()
        .lock()
        .map_err(|_| "dashboard config write lock poisoned".to_string())?;
    let _file_guard = acquire_dashboard_config_file_lock()?;
    let mut config: serde_json::Value = if config_path.exists() {
        let text =
            std::fs::read_to_string(&config_path).map_err(|e| format!("read config: {e}"))?;
        serde_json::from_str(&text).map_err(|e| format!("parse config: {e}"))?
    } else {
        serde_json::json!({})
    };
    let root = config
        .as_object_mut()
        .ok_or("config root is not an object")?;
    let existing_display_name = root
        .get("mobileRelay")
        .and_then(|value| config_string_field(value, &["displayName", "name", "label"]))
        .unwrap_or_else(|| "Mac Admin".to_string());
    root.insert(
        "mobileRelay".to_string(),
        serde_json::json!({
            "relayUrl": args.relay_url.trim(),
            "hostId": args.host_id.trim(),
            "displayName": existing_display_name,
            "secret": args.secret.trim(),
        }),
    );
    let pretty =
        serde_json::to_string_pretty(&config).map_err(|e| format!("serialize config: {e}"))?;
    atomic_write_file(&config_path, format!("{pretty}\n").as_bytes())
        .map_err(|e| format!("write config: {e}"))?;
    Ok(MobileRelayConfig {
        relay_url: args.relay_url.trim().to_string(),
        host_id: args.host_id.trim().to_string(),
        display_name: existing_display_name,
        secret: args.secret.trim().to_string(),
    })
}

fn mobile_relay_secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn mobile_relay_status_file() -> PathBuf {
    app_home_dir_or_tmp()
        .join(".tmux-worktree")
        .join("mobile-relay-status.json")
}

fn load_mobile_relay_runtime_status() -> Option<RelayHostRuntimeStatus> {
    let content = std::fs::read_to_string(mobile_relay_status_file()).ok()?;
    serde_json::from_str(&content).ok()
}

fn direct_mobile_relay_url_for_host(host: &HostConfig, port: u16) -> String {
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

fn mobile_relay_forward_url_for_host(host: &HostConfig, port: u16) -> Result<String, String> {
    let advertised_host = local_mdns_name().or_else(local_lan_ip).ok_or_else(|| {
        "could not determine this Mac's local hostname or LAN IP for Android relay URL".to_string()
    })?;
    start_mobile_relay_ssh_forward(host, "0.0.0.0", "127.0.0.1", port)?;
    Ok(format!("ws://{advertised_host}:{port}"))
}

fn should_preserve_mobile_relay_url(current: &str, host: &HostConfig, port: u16) -> bool {
    let trimmed = current.trim();
    !trimmed.is_empty()
        && !trimmed.contains("example.com")
        && trimmed != direct_mobile_relay_url_for_host(host, port)
}

fn start_mobile_relay_broker_on_host(
    app: &tauri::AppHandle,
    host: &HostConfig,
    port: u16,
    secret: &str,
) -> Result<(), String> {
    if port == 0 {
        return Err("relay broker port must be greater than zero".to_string());
    }
    let cli = bundled_cli_path(app).ok_or("bundled CLI resource not found")?;
    run_remote_cmd_check_strings(
        host,
        &[
            "sh".into(),
            "-lc".into(),
            "mkdir -p \"$HOME/.tmux-worktree\"".into(),
        ],
    )?;
    scp_cli_to_host(host, &cli, ".tmux-worktree/tw-cli.js")?;
    let script = format!(
        r#"set -e
mkdir -p "$HOME/.tmux-worktree"
printf %s {} > "$HOME/.tmux-worktree/relay-secret"
chmod 600 "$HOME/.tmux-worktree/relay-secret"
cat > "$HOME/.tmux-worktree/relay-server.sh" <<'EOF'
#!/bin/sh
export TW_RELAY_SECRET="$(cat "$HOME/.tmux-worktree/relay-secret")"
exec /usr/bin/env node "$HOME/.tmux-worktree/tw-cli.js" relay-server --host 0.0.0.0 --port {}
EOF
chmod 700 "$HOME/.tmux-worktree/relay-server.sh"
{} kill-session -t tw-relay-server 2>/dev/null || true
{} new-session -d -s tw-relay-server "$HOME/.tmux-worktree/relay-server.sh"
sleep 1
{} has-session -t tw-relay-server
"#,
        shell_quote(secret),
        port,
        remote_tmux_cmd(host),
        remote_tmux_cmd(host),
        remote_tmux_cmd(host),
    );
    run_remote_cmd_check_strings(host, &["sh".into(), "-lc".into(), script])?;
    Ok(())
}

fn spawn_relay_host(
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
                .arg(cli_arg)
                .args(&args)
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

#[tauri::command]
fn mobile_relay_start(
    app: tauri::AppHandle,
    state: State<'_, Arc<MobileRelayState>>,
) -> Result<(), String> {
    set_mobile_relay_error(state.inner(), None);
    let mut proc = state.process.lock().unwrap();
    if proc.is_some() {
        return Ok(());
    }

    if !tcp_port_open(8311) {
        let child = spawn_serve(&app).map_err(|err| {
            set_mobile_relay_error(state.inner(), Some(err.clone()));
            err
        })?;
        let mut serve = state.serve_process.lock().unwrap();
        *serve = Some(child);
    }

    let tok = read_serve_token();
    {
        let mut t = state.token.lock().unwrap();
        *t = tok.clone();
    }

    let config = mobile_relay_config();
    if config.secret.trim().is_empty() {
        let message = "Relay token is required before Android can connect".to_string();
        set_mobile_relay_error(state.inner(), Some(message.clone()));
        stop_managed_serve(state.inner());
        return Err(message);
    }

    let _ = std::fs::remove_file(mobile_relay_status_file());

    let child = spawn_relay_host(
        &app,
        &config.relay_url,
        &config.host_id,
        &config.display_name,
        &config.secret,
        &tok,
    )
    .map_err(|err| {
        set_mobile_relay_error(state.inner(), Some(err.clone()));
        stop_managed_serve(state.inner());
        err
    })?;

    *state.relay_url.lock().unwrap() = config.relay_url;
    *state.host_id.lock().unwrap() = config.host_id;
    *state.secret.lock().unwrap() = config.secret;
    *proc = Some(child);

    Ok(())
}

#[tauri::command]
fn mobile_relay_save_config(
    args: MobileRelayConfigInput,
    state: State<'_, Arc<MobileRelayState>>,
) -> Result<MobileRelayStatus, String> {
    let config = save_mobile_relay_config_file(&args)?;
    *state.relay_url.lock().unwrap() = config.relay_url;
    *state.host_id.lock().unwrap() = config.host_id;
    *state.secret.lock().unwrap() = config.secret;
    set_mobile_relay_error(state.inner(), None);
    Ok(mobile_relay_status(state))
}

#[tauri::command]
fn mobile_relay_start_broker(
    app: tauri::AppHandle,
    args: MobileRelayBrokerInput,
    state: State<'_, Arc<MobileRelayState>>,
) -> Result<MobileRelayStatus, String> {
    let host = find_host(args.host_id.trim())?;
    let port = args.port.unwrap_or(8787);
    let secret = mobile_relay_secret();
    start_mobile_relay_broker_on_host(&app, &host, port, &secret).map_err(|err| {
        set_mobile_relay_error(state.inner(), Some(err.clone()));
        err
    })?;
    let current_config = mobile_relay_config();
    let relay_url = match mobile_relay_forward_url_for_host(&host, port) {
        Ok(url) => url,
        Err(_) if should_preserve_mobile_relay_url(&current_config.relay_url, &host, port) => {
            current_config.relay_url
        }
        Err(err) => {
            set_mobile_relay_error(state.inner(), Some(err.clone()));
            return Err(err);
        }
    };
    let config = MobileRelayConfigInput {
        relay_url,
        host_id: "mac-admin".to_string(),
        secret,
    };
    let saved = save_mobile_relay_config_file(&config)?;
    *state.relay_url.lock().unwrap() = saved.relay_url;
    *state.host_id.lock().unwrap() = saved.host_id;
    *state.secret.lock().unwrap() = saved.secret;
    set_mobile_relay_error(state.inner(), None);
    Ok(mobile_relay_status(state))
}

#[tauri::command]
fn mobile_relay_stop(state: State<'_, Arc<MobileRelayState>>) -> Result<(), String> {
    stop_mobile_relay_processes(state.inner());
    set_mobile_relay_error(state.inner(), None);
    Ok(())
}

#[tauri::command]
fn mobile_relay_status(state: State<'_, Arc<MobileRelayState>>) -> MobileRelayStatus {
    let mut proc = state.process.lock().unwrap();
    let mut process_error = None;
    if let Some(ref mut child) = *proc {
        match child.try_wait() {
            Ok(Some(status)) => {
                *proc = None;
                process_error = Some(format!("Mobile relay connector exited: {status}"));
            }
            _ => {}
        }
    }
    if let Some(message) = process_error {
        set_mobile_relay_error(state.inner(), Some(message));
    }
    let active = proc.is_some();
    let default_config = mobile_relay_config();
    let relay_url = state.relay_url.lock().unwrap();
    let host_id = state.host_id.lock().unwrap();
    let secret = state.secret.lock().unwrap();
    let token = state.token.lock().unwrap();
    let resolved_relay_url = if relay_url.is_empty() {
        default_config.relay_url
    } else {
        relay_url.clone()
    };
    let resolved_host_id = if host_id.is_empty() {
        default_config.host_id
    } else {
        host_id.clone()
    };
    let runtime = active
        .then(load_mobile_relay_runtime_status)
        .flatten()
        .filter(|status| {
            status.relay_url == resolved_relay_url && status.host_id == resolved_host_id
        });
    let connection_state = if !active {
        "stopped".to_string()
    } else {
        runtime
            .as_ref()
            .map(|status| status.state.clone())
            .filter(|status| !status.is_empty())
            .unwrap_or_else(|| "starting".to_string())
    };
    let connected = active && connection_state == "connected";
    let runtime_error = runtime.as_ref().and_then(|status| status.error.clone());
    let error = state.last_error.lock().unwrap().clone().or(runtime_error);
    MobileRelayStatus {
        active,
        connected,
        connection_state,
        relay_url: resolved_relay_url,
        host_id: resolved_host_id,
        secret: if secret.is_empty() {
            default_config.secret
        } else {
            secret.clone()
        },
        token: token.clone(),
        connected_at: runtime.as_ref().and_then(|status| status.connected_at),
        updated_at: runtime.as_ref().and_then(|status| status.updated_at),
        retry_in_ms: runtime.as_ref().and_then(|status| status.retry_in_ms),
        error,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    inherit_shell_env();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(Arc::new(PtyState::default()));
            app.manage(Arc::new(MobileRelayState::default()));
            app.manage(Arc::new(GitFetchState::default()));
            app.manage(Arc::new(HostState::default()));
            setup_clipboard_bindings();
            restore_window_layout(&app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_dashboard_catalog,
            list_local_dashboard_catalog,
            list_sessions,
            tmux_session_exists,
            list_projects,
            add_project,
            create_worktree,
            kill_session,
            list_orphaned_worktrees,
            restore_worktree,
            delete_worktree,
            session_cwd,
            session_root,
            cancel_copy_mode,
            copy_mode_cancel_if_active,
            apply_tmux_theme,
            copy_tmux_selection,
            capture_pane_history,
            git_status,
            git_fetch_project_roots,
            git_graph_refs,
            git_graph,
            git_diff,
            list_tmux_terminals,
            create_terminal,
            ensure_terminal_session,
            kill_plain_terminal,
            load_terminals,
            save_terminals,
            load_layout,
            save_layout,
            list_automations,
            save_automation,
            delete_automation,
            trigger_automation,
            list_automation_runs,
            home_dir,
            pty_open,
            pty_write,
            pty_resize,
            pty_kill,
            read_dir,
            read_file,
            write_file,
            remote_read_file,
            remote_read_file_base64,
            remote_write_file,
            search_files,
            open_url,
            file_exists,
            remote_file_exists,
            list_hosts,
            list_ssh_host_candidates,
            add_host,
            update_host,
            remove_host,
            test_host,
            install_host_tw,
            host_statuses,
            list_remote_projects,
            remote_home_dir,
            remote_read_dir,
            probe_agents,
            mobile_relay_start,
            mobile_relay_start_broker,
            mobile_relay_save_config,
            mobile_relay_stop,
            mobile_relay_status,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
                cleanup_pending_worktrees();
                let relay_state = app.state::<Arc<MobileRelayState>>();
                stop_mobile_relay_processes(relay_state.inner().as_ref());
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::{
        acquire_dashboard_config_file_lock, add_host_with_state, agent_running_from_pane_title,
        append_automation_run, atomic_write_file_with, automation_command_with_instruction,
        build_local_worktree_rpc_args, cleanup_pending_worktrees, config_worktree_base,
        config_worktree_base_with_home, create_local_terminal_via_runtime,
        create_local_worktree_via_runtime, create_remote_terminal_via_tw_rpc,
        create_remote_worktree, default_worktree_base, delete_automation_from_list,
        delete_worktree, derive_session_name, ensure_terminal_session, fetchable_project_paths,
        find_host, finish_git_fetch_target, git_fetch_args, git_graph_for, git_graph_refs_for,
        hosts_from_config, install_host_tw_from_source, invalidate_host_status_cache,
        is_git_worktree_dir, is_managed_worktree_session, kill_canonical_first,
        kill_legacy_plain_terminal, kill_legacy_session,
        kill_rpc_explicitly_allows_legacy_fallback, layout_backup_path, layout_schema_version,
        list_automation_runs, list_orphaned_worktrees, list_remote_sessions,
        list_remote_tmux_terminals, load_hosts, load_pending_cleanup, load_terminals,
        managed_worktree_root_for_session, mobile_relay_config_from_value,
        mobile_relay_ssh_forward_command, normalize_local_mdns_name, orphaned_worktrees,
        parse_kill_session_rpc_response, parse_local_worktree_rpc_response, parse_session_key,
        probe_local_agents_in_paths, project_from_config, project_from_worktree_path,
        projects_from_config, projects_from_config_with_home, read_dashboard_config_lock_owner,
        remote_file_exists_for_host, remote_home_dir_for_host, remote_read_dirs_for_host,
        remote_read_file_bytes_for_host, remote_write_file_for_host, remove_host_with_state,
        reserve_git_fetch_target, restore_local_worktree_via_runtime, run_remote_tmux_check,
        run_remote_tw_check, save_automation, save_hosts_config, save_layout, save_pending_cleanup,
        save_terminals, scp_cli_command, select_local_tw_rpc_runtime,
        should_skip_automation_overlap, ssh_command, ssh_host_candidates_from_config_text,
        stable_output_signature, test_host, tmux_session_exists, trigger_automation_with_creator,
        try_cleanup_worktree, tw_rpc_capabilities_compatible, update_host_config,
        upsert_automation_from_input, validate_ssh_host_fields, worktree_has_uncommitted_changes,
        worktrees_for_session, AddHostArgs, AgentProbeResult, Automation, AutomationOverlap,
        AutomationRun, AutomationStatus, AutomationTriggerType, CachedHostStatus, CreateArgs,
        CreateTerminalArgs, DashboardConfigLockOwner, DeleteWorktreeArgs, EnsureTerminalArgs,
        GitFetchTracker, GitGraphPreset, GitGraphQuery, GitGraphRefKind, HostConfig, HostState,
        HostStatus, LocalTwRpcRuntime, OrphanedWorktree, Project, RestoreArgs, SaveAutomationInput,
        UpdateHostArgs, AGENT_PROBE_SPECS, AUTOMATION_RUN_LIMIT, GIT_FETCH_INTERVAL_SECONDS,
    };
    use std::collections::HashSet;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use std::sync::{Mutex, OnceLock};
    use std::time::Instant;

    fn test_env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn git(args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .status()
            .expect("spawn git");
        assert!(status.success(), "git command failed: {:?}", args);
    }

    fn git_stdout(args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .args(args)
            .output()
            .expect("spawn git");
        assert!(
            output.status.success(),
            "git command failed: {:?}\n{}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn restore_env(name: &str, value: Option<String>) {
        if let Some(value) = value {
            unsafe {
                std::env::set_var(name, value);
            }
        } else {
            unsafe {
                std::env::remove_var(name);
            }
        }
    }

    #[test]
    fn agent_probe_uses_only_the_fixed_allowlist_and_checks_executable_bits() {
        let temp = tempfile::tempdir().expect("tempdir");
        let codex_path = temp.path().join("codex");
        let custom_path = temp.path().join("custom-agent --unsafe");
        fs::write(&codex_path, "#!/bin/sh\nexit 0\n").expect("write codex");
        fs::write(&custom_path, "#!/bin/sh\nexit 0\n").expect("write custom agent");

        let mut codex_permissions = fs::metadata(&codex_path)
            .expect("codex metadata")
            .permissions();
        codex_permissions.set_mode(0o755);
        fs::set_permissions(&codex_path, codex_permissions).expect("chmod codex");
        let mut custom_permissions = fs::metadata(&custom_path)
            .expect("custom metadata")
            .permissions();
        custom_permissions.set_mode(0o755);
        fs::set_permissions(&custom_path, custom_permissions).expect("chmod custom agent");

        let results = probe_local_agents_in_paths(&[temp.path().to_path_buf()]);
        assert_eq!(
            AGENT_PROBE_SPECS
                .iter()
                .map(|spec| spec.command)
                .collect::<Vec<_>>(),
            vec!["claude", "codex", "gemini", "opencode", "aider"]
        );
        assert_eq!(results.len(), AGENT_PROBE_SPECS.len());
        assert_eq!(
            results.iter().find(|result| result.id == "codex"),
            Some(&AgentProbeResult {
                id: "codex".into(),
                label: "Codex".into(),
                command: "codex".into(),
                available: true,
                executable_path: Some(codex_path.to_string_lossy().to_string()),
                error: None,
            })
        );
        assert!(results
            .iter()
            .all(|result| result.command != "custom-agent --unsafe"));
    }

    #[test]
    fn remote_commands_use_configured_tmux_and_tw_paths() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    if [ "$#" -gt 0 ]; then shift; fi
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"
case "$1" in
  *'.local/bin/tmux'*'has-session'*)
    exit 0
    ;;
  *'TW_TMUX='*'.local/bin/tmux'*'.local/bin/tw'*'version'*)
    printf '0.12.6\n'
    exit 0
    ;;
esac
printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
        }

        let host = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: Some("~/.local/bin/tmux".to_string()),
            tw_path: Some("~/.local/bin/tw".to_string()),
        };

        run_remote_tmux_check(&host, &["has-session", "-t", "=x-cloud"]).expect("configured tmux");
        let version = run_remote_tw_check(&host, &["version"]).expect("configured tw");

        assert_eq!(version, "0.12.6");
        let log = fs::read_to_string(&log_path).expect("ssh log");
        assert!(log.contains("$HOME/.local/bin/tmux"), "ssh log:\n{log}");
        assert!(log.contains("$HOME/.local/bin/tw"), "ssh log:\n{log}");
        assert!(log.contains("TW_TMUX="), "ssh log:\n{log}");

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
    }

    fn sample_automation() -> Automation {
        Automation {
            id: "auto-1".to_string(),
            name: "Nightly".to_string(),
            enabled: true,
            trigger_type: AutomationTriggerType::Manual,
            schedule: None,
            timezone: None,
            project: None,
            path: Some("/repo/app".to_string()),
            ai_cmd: "codex".to_string(),
            instruction: String::new(),
            overlap: AutomationOverlap::Queue,
            last_run_at: None,
            last_status: AutomationStatus::Idle,
            last_session: None,
            created_at: "2026-06-11T00:00:00Z".to_string(),
            updated_at: "2026-06-11T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn stable_output_signature_is_deterministic_and_content_sensitive() {
        let first = stable_output_signature("agent output\nline 2");
        let second = stable_output_signature("agent output\nline 2");
        let changed = stable_output_signature("agent output\nline 3");

        assert_eq!(first, second);
        assert_ne!(first, changed);
        assert_eq!(first.len(), 16);
    }

    #[test]
    fn fetchable_project_paths_dedupes_configured_git_roots() {
        let temp = tempfile::tempdir().expect("tempdir");
        let repo = temp.path().join("repo");
        let non_repo = temp.path().join("not-git");
        fs::create_dir_all(&repo).expect("repo");
        fs::create_dir_all(&non_repo).expect("non repo");
        git(&["init", repo.to_str().expect("repo str")]);

        let repo_path = repo.to_string_lossy().to_string();
        let projects = vec![
            Project {
                name: "repo".to_string(),
                path: repo_path.clone(),
                branch: None,
            },
            Project {
                name: "repo-duplicate".to_string(),
                path: format!("{repo_path}/"),
                branch: None,
            },
            Project {
                name: "not-git".to_string(),
                path: non_repo.to_string_lossy().to_string(),
                branch: None,
            },
            Project {
                name: "blank".to_string(),
                path: " ".to_string(),
                branch: None,
            },
        ];

        let expected = std::fs::canonicalize(&repo)
            .expect("canonical repo")
            .to_string_lossy()
            .to_string();
        assert_eq!(fetchable_project_paths(&projects), vec![expected]);
    }

    #[test]
    fn reserve_git_fetch_target_throttles_and_tracks_in_flight_fetches() {
        let mut tracker = GitFetchTracker::default();

        assert!(reserve_git_fetch_target(&mut tracker, "/repo", 100));
        assert!(!reserve_git_fetch_target(&mut tracker, "/repo", 101));

        finish_git_fetch_target(&mut tracker, "/repo");

        assert!(!reserve_git_fetch_target(
            &mut tracker,
            "/repo",
            100 + GIT_FETCH_INTERVAL_SECONDS - 1,
        ));
        assert!(reserve_git_fetch_target(
            &mut tracker,
            "/repo",
            100 + GIT_FETCH_INTERVAL_SECONDS,
        ));
    }

    #[test]
    fn git_fetch_args_runs_fetch_from_the_project_root() {
        assert_eq!(
            git_fetch_args("/repo/root"),
            ["-C", "/repo/root", "fetch", "--all", "--prune", "--quiet"],
        );
    }

    fn graph_test_repo() -> (tempfile::TempDir, String, String) {
        let temp = tempfile::tempdir().expect("tempdir");
        let repo = temp.path().join("graph-repo");
        let repo_str = repo.to_string_lossy().to_string();
        git(&["init", &repo_str]);
        git(&[
            "-C",
            &repo_str,
            "config",
            "user.email",
            "graph@test.invalid",
        ]);
        git(&["-C", &repo_str, "config", "user.name", "Graph Tester"]);
        git(&["-C", &repo_str, "branch", "-M", "main"]);

        fs::write(repo.join("base.txt"), "base\n").expect("base file");
        git(&["-C", &repo_str, "add", "base.txt"]);
        git(&["-C", &repo_str, "commit", "-m", "base commit"]);
        let base = git_stdout(&["-C", &repo_str, "rev-parse", "HEAD"]);
        git(&["-C", &repo_str, "tag", "-a", "v1", "-m", "version one"]);

        git(&["-C", &repo_str, "checkout", "-b", "feature"]);
        fs::write(repo.join("feature.txt"), "feature\n").expect("feature file");
        git(&["-C", &repo_str, "add", "feature.txt"]);
        git(&["-C", &repo_str, "commit", "-m", "feature commit"]);

        git(&["-C", &repo_str, "checkout", "main"]);
        fs::write(repo.join("main.txt"), "main\n").expect("main file");
        git(&["-C", &repo_str, "add", "main.txt"]);
        git(&["-C", &repo_str, "commit", "-m", "main commit"]);
        git(&[
            "-C",
            &repo_str,
            "merge",
            "--no-ff",
            "feature",
            "-m",
            "merge feature",
        ]);

        // Keep one unmerged branch so selectedRefs demonstrably expands a
        // Head graph. Commas are legal in refs and exercise decoration safety.
        git(&["-C", &repo_str, "checkout", "-b", "compare,comma", &base]);
        fs::write(repo.join("compare.txt"), "compare\n").expect("compare file");
        git(&["-C", &repo_str, "add", "compare.txt"]);
        git(&["-C", &repo_str, "commit", "-m", "compare commit"]);
        let compare = git_stdout(&["-C", &repo_str, "rev-parse", "HEAD"]);
        git(&["-C", &repo_str, "checkout", "main"]);

        git(&[
            "-C",
            &repo_str,
            "remote",
            "add",
            "origin",
            "https://example.invalid/repo.git",
        ]);
        git(&[
            "-C",
            &repo_str,
            "update-ref",
            "refs/remotes/origin/main",
            "HEAD",
        ]);
        git(&[
            "-C",
            &repo_str,
            "branch",
            "--set-upstream-to=refs/remotes/origin/main",
            "main",
        ]);

        (temp, repo_str, compare)
    }

    #[test]
    fn git_graph_enumerates_canonical_refs_and_preserves_merge_topology() {
        let (_temp, repo, _compare) = graph_test_repo();
        let refs = git_graph_refs_for(&repo, None).expect("graph refs");

        assert_eq!(refs.current.as_deref(), Some("refs/heads/main"));
        assert_eq!(refs.upstream.as_deref(), Some("refs/remotes/origin/main"));
        assert!(refs.refs.iter().any(|reference| {
            reference.name == "refs/heads/main"
                && reference.kind == GitGraphRefKind::Local
                && reference.current
                && reference.upstream.as_deref() == Some("refs/remotes/origin/main")
        }));
        assert!(refs.refs.iter().any(|reference| {
            reference.name == "refs/remotes/origin/main"
                && reference.kind == GitGraphRefKind::Remote
                && reference.upstream.is_none()
        }));
        assert!(refs.refs.iter().any(|reference| {
            reference.name == "refs/tags/v1" && reference.kind == GitGraphRefKind::Tag
        }));

        let graph = git_graph_for(
            &repo,
            None,
            GitGraphQuery {
                preset: GitGraphPreset::All,
                selected_refs: Vec::new(),
                limit: Some(100),
            },
        )
        .expect("all graph");
        let merge = graph
            .commits
            .iter()
            .find(|commit| commit.subject == "merge feature")
            .expect("merge commit");
        assert_eq!(merge.parents.len(), 2);
        assert!(merge.parents.iter().all(|parent| parent.len() == 40));
        assert_eq!(merge.hash.len(), 40);
        assert!(!merge.authored_at.is_empty());
        assert!(merge
            .decorations
            .iter()
            .any(|decoration| decoration.kind == GitGraphRefKind::Head));
        assert!(graph.commits.iter().any(|commit| commit
            .decorations
            .iter()
            .any(|decoration| decoration.name == "refs/tags/v1")));
    }

    #[test]
    fn git_graph_selected_refs_expand_head_and_limit_uses_one_extra_commit() {
        let (_temp, repo, compare) = graph_test_repo();
        let head_only = git_graph_for(
            &repo,
            None,
            GitGraphQuery {
                preset: GitGraphPreset::Head,
                selected_refs: Vec::new(),
                limit: Some(100),
            },
        )
        .expect("head graph");
        assert!(!head_only
            .commits
            .iter()
            .any(|commit| commit.hash == compare));

        let selected = git_graph_for(
            &repo,
            None,
            GitGraphQuery {
                preset: GitGraphPreset::Head,
                selected_refs: vec!["refs/heads/compare,comma".to_string()],
                limit: Some(100),
            },
        )
        .expect("selected graph");
        assert!(selected.commits.iter().any(|commit| commit.hash == compare));

        let limited = git_graph_for(
            &repo,
            None,
            GitGraphQuery {
                preset: GitGraphPreset::Current,
                selected_refs: Vec::new(),
                limit: Some(1),
            },
        )
        .expect("limited graph");
        assert_eq!(limited.commits.len(), 1);
        assert!(limited.has_more);
    }

    #[test]
    fn git_graph_preserves_control_characters_in_human_fields() {
        let (_temp, repo, _compare) = graph_test_repo();
        let subject = "control\u{1f}subject";
        let author = "Graph\u{1f}Author";
        let file = Path::new(&repo).join("control.txt");
        fs::write(&file, "control\n").expect("control file");
        git(&["-C", &repo, "add", "control.txt"]);
        git(&[
            "-C",
            &repo,
            "-c",
            &format!("user.name={author}"),
            "commit",
            "-m",
            subject,
        ]);

        let graph = git_graph_for(
            &repo,
            None,
            GitGraphQuery {
                preset: GitGraphPreset::Head,
                selected_refs: Vec::new(),
                limit: Some(100),
            },
        )
        .expect("control-character graph");
        let commit = graph
            .commits
            .iter()
            .find(|commit| commit.subject == subject)
            .expect("control-character commit");
        assert_eq!(commit.author, author);
    }

    #[test]
    fn git_graph_all_excludes_internal_stash_refs() {
        let (_temp, repo, _compare) = graph_test_repo();
        let tracked = Path::new(&repo).join("base.txt");
        fs::write(&tracked, "base\nstashed change\n").expect("stashed change");
        git(&["-C", &repo, "stash", "push", "-m", "hidden stash"]);
        let stash = git_stdout(&["-C", &repo, "rev-parse", "refs/stash"]);

        let graph = git_graph_for(
            &repo,
            None,
            GitGraphQuery {
                preset: GitGraphPreset::All,
                selected_refs: Vec::new(),
                limit: Some(100),
            },
        )
        .expect("all graph");
        assert!(!graph.commits.iter().any(|commit| commit.hash == stash));
        assert!(!graph
            .refs
            .iter()
            .any(|reference| reference.name == "refs/stash"));
    }

    #[test]
    fn git_graph_rejects_option_shaped_short_and_unknown_refs() {
        let (_temp, repo, _compare) = graph_test_repo();
        for rejected in ["--all", "main", "refs/heads/missing"] {
            let error = git_graph_for(
                &repo,
                None,
                GitGraphQuery {
                    preset: GitGraphPreset::Head,
                    selected_refs: vec![rejected.to_string()],
                    limit: None,
                },
            )
            .expect_err("ref must be rejected");
            assert!(
                error.contains("git ref"),
                "unexpected error for {rejected}: {error}"
            );
        }
    }

    #[test]
    fn agent_running_from_pane_title_detects_codex_spinner_prefix() {
        assert!(agent_running_from_pane_title("⠴ money-run-goal-e8654"));
        assert!(agent_running_from_pane_title(" ⠇ another-worktree"));
        assert!(!agent_running_from_pane_title("x-pipeline-bf6d9"));
        assert!(!agent_running_from_pane_title("⠴not-a-status-prefix"));
    }

    #[test]
    fn automation_serializes_with_frontend_contract_field_names() {
        let automation = Automation {
            trigger_type: AutomationTriggerType::Schedule,
            schedule: Some("0 9 * * *".to_string()),
            timezone: Some("Asia/Shanghai".to_string()),
            project: Some("dashboard".to_string()),
            path: None,
            ai_cmd: "claude".to_string(),
            instruction: "Summarize failures".to_string(),
            overlap: AutomationOverlap::Skip,
            last_run_at: Some("2026-06-11T01:00:00Z".to_string()),
            last_status: AutomationStatus::Running,
            last_session: Some("dashboard-nightly".to_string()),
            ..sample_automation()
        };

        let value = serde_json::to_value(&automation).expect("serialize automation");

        assert_eq!(value["id"], "auto-1");
        assert_eq!(value["triggerType"], "schedule");
        assert_eq!(value["aiCmd"], "claude");
        assert_eq!(value["lastRunAt"], "2026-06-11T01:00:00Z");
        assert_eq!(value["lastStatus"], "running");
        assert_eq!(value["lastSession"], "dashboard-nightly");
        assert_eq!(value["createdAt"], "2026-06-11T00:00:00Z");
        assert_eq!(value["updatedAt"], "2026-06-11T00:00:00Z");
    }

    #[test]
    fn upsert_automation_defaults_create_and_preserves_created_at_on_update() {
        let created = upsert_automation_from_input(
            Vec::new(),
            SaveAutomationInput {
                id: Some("auto-1".to_string()),
                name: Some("Nightly".to_string()),
                path: Some(Some("/repo/app".to_string())),
                ai_cmd: Some("codex".to_string()),
                ..Default::default()
            },
            "2026-06-11T00:00:00Z",
        )
        .expect("create automation");

        assert_eq!(created.automation.id, "auto-1");
        assert_eq!(created.automation.name, "Nightly");
        assert!(created.automation.enabled);
        assert_eq!(
            created.automation.trigger_type,
            AutomationTriggerType::Manual
        );
        assert_eq!(created.automation.path.as_deref(), Some("/repo/app"));
        assert_eq!(created.automation.ai_cmd, "codex");
        assert_eq!(created.automation.overlap, AutomationOverlap::Queue);
        assert_eq!(created.automation.last_status, AutomationStatus::Idle);
        assert_eq!(created.automation.created_at, "2026-06-11T00:00:00Z");
        assert_eq!(created.automation.updated_at, "2026-06-11T00:00:00Z");

        let updated = upsert_automation_from_input(
            created.automations,
            SaveAutomationInput {
                id: Some("auto-1".to_string()),
                name: Some("Weekday schedule".to_string()),
                trigger_type: Some(AutomationTriggerType::Schedule),
                schedule: Some(Some("0 9 * * 1-5".to_string())),
                timezone: Some(Some("Asia/Shanghai".to_string())),
                overlap: Some(AutomationOverlap::Skip),
                ..Default::default()
            },
            "2026-06-11T02:00:00Z",
        )
        .expect("update automation");

        assert_eq!(updated.automations.len(), 1);
        assert_eq!(updated.automation.name, "Weekday schedule");
        assert_eq!(
            updated.automation.trigger_type,
            AutomationTriggerType::Schedule
        );
        assert_eq!(updated.automation.schedule.as_deref(), Some("0 9 * * 1-5"));
        assert_eq!(
            updated.automation.timezone.as_deref(),
            Some("Asia/Shanghai")
        );
        assert_eq!(updated.automation.overlap, AutomationOverlap::Skip);
        assert_eq!(updated.automation.ai_cmd, "codex");
        assert_eq!(updated.automation.created_at, "2026-06-11T00:00:00Z");
        assert_eq!(updated.automation.updated_at, "2026-06-11T02:00:00Z");
    }

    #[test]
    fn delete_automation_from_list_removes_only_matching_id() {
        let other = Automation {
            id: "auto-2".to_string(),
            name: "Other".to_string(),
            ..sample_automation()
        };

        let remaining = delete_automation_from_list(vec![sample_automation(), other], "auto-1");

        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, "auto-2");
    }

    #[test]
    fn automation_command_shell_quotes_non_empty_instruction() {
        let command =
            automation_command_with_instruction("codex", "Fix Bob's bug && rm -rf /tmp/demo");

        assert_eq!(command, "codex 'Fix Bob'\\''s bug && rm -rf /tmp/demo'");
        assert_eq!(automation_command_with_instruction("codex", "  "), "codex");
    }

    #[test]
    fn overlap_skip_requires_running_or_queued_status_with_live_session() {
        let running = Automation {
            overlap: AutomationOverlap::Skip,
            last_status: AutomationStatus::Running,
            last_session: Some("dashboard-nightly".to_string()),
            ..sample_automation()
        };
        let queued = Automation {
            last_status: AutomationStatus::Queued,
            ..running.clone()
        };
        let failed = Automation {
            last_status: AutomationStatus::Failed,
            ..running.clone()
        };

        assert!(should_skip_automation_overlap(&running, true));
        assert!(should_skip_automation_overlap(&queued, true));
        assert!(!should_skip_automation_overlap(&running, false));
        assert!(!should_skip_automation_overlap(&failed, true));
        assert!(!should_skip_automation_overlap(
            &Automation {
                overlap: AutomationOverlap::Queue,
                ..running
            },
            true,
        ));
    }

    #[test]
    fn append_automation_run_keeps_newest_first_and_bounded() {
        let mut runs = (0..AUTOMATION_RUN_LIMIT)
            .map(|index| AutomationRun {
                id: format!("run-{index}"),
                automation_id: "auto-1".to_string(),
                started_at: format!("2026-06-11T00:{index:02}:00Z"),
                finished_at: None,
                status: AutomationStatus::Running,
                session_name: None,
                error: None,
            })
            .collect::<Vec<_>>();
        let newest = AutomationRun {
            id: "run-new".to_string(),
            automation_id: "auto-1".to_string(),
            started_at: "2026-06-11T02:00:00Z".to_string(),
            finished_at: Some("2026-06-11T02:01:00Z".to_string()),
            status: AutomationStatus::Failed,
            session_name: Some("dashboard-nightly".to_string()),
            error: Some("start failed".to_string()),
        };

        append_automation_run(&mut runs, newest.clone());

        assert_eq!(runs.len(), AUTOMATION_RUN_LIMIT);
        assert_eq!(runs[0], newest);
        assert_eq!(runs.last().expect("last").id, "run-198");
    }

    #[test]
    fn automation_trigger_delegates_to_canonical_worktree_creator() {
        let _guard = test_env_lock().lock().expect("lock");
        let original_home = std::env::var("HOME").ok();
        let original_dashboard_home = std::env::var("TW_DASHBOARD_HOME").ok();
        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("home");
        fs::create_dir_all(&home).expect("home");

        unsafe {
            std::env::set_var("TW_DASHBOARD_HOME", &home);
            std::env::set_var("HOME", &home);
        }

        let saved = save_automation(SaveAutomationInput {
            id: Some("auto-smoke".to_string()),
            name: Some("Smoke".to_string()),
            enabled: Some(true),
            trigger_type: Some(AutomationTriggerType::Manual),
            schedule: Some(None),
            timezone: Some(None),
            project: Some(Some("smoke".to_string())),
            path: Some(None),
            ai_cmd: Some("codex --quiet".to_string()),
            instruction: Some("review the current changes".to_string()),
            overlap: Some(AutomationOverlap::Skip),
        })
        .expect("save automation");

        let captured_args = Mutex::new(None);
        let run = trigger_automation_with_creator(saved.id.clone(), |args| {
            *captured_args.lock().expect("captured args lock") = Some(args);
            Ok("smoke-session".to_string())
        })
        .expect("trigger automation");
        assert_eq!(run.status, AutomationStatus::Running);
        assert_eq!(run.session_name.as_deref(), Some("smoke-session"));
        assert_eq!(
            captured_args.lock().expect("captured args lock").clone(),
            Some(CreateArgs {
                project: Some("smoke".to_string()),
                path: None,
                ai_cmd: "codex --quiet 'review the current changes'".to_string(),
                name: Some("Smoke".to_string()),
                branch: None,
                host_id: None,
            })
        );

        let runs = list_automation_runs(Some(saved.id.clone())).expect("list runs");
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].id, run.id);
        assert_eq!(runs[0].status, AutomationStatus::Running);

        restore_env("TW_DASHBOARD_HOME", original_dashboard_home);
        restore_env("HOME", original_home);
    }

    #[test]
    fn derive_session_name_strips_random_suffix() {
        assert_eq!(derive_session_name("demo-abc12"), "demo");
        assert_eq!(derive_session_name("demo"), "demo");
        assert_eq!(derive_session_name("demo-nothex"), "demo-nothex");
    }

    #[test]
    fn project_from_worktree_path_reads_project_segment() {
        assert_eq!(
            project_from_worktree_path(
                "/tmp/tmux-worktree/projects/coco/fix-auth-abc12",
                "/tmp/tmux-worktree/projects",
            )
            .as_deref(),
            Some("coco"),
        );
        assert_eq!(
            project_from_worktree_path(
                "/home/dev/.tmux-worktree/worktrees/api/refactor-def34",
                "/tmp/other",
            )
            .as_deref(),
            Some("api"),
        );
        assert_eq!(
            project_from_worktree_path(
                "/private/tmp/tmux-worktree/projects/legacy/legacy-fix-abc12",
                "/home/dev/.tmux-worktree/worktrees",
            )
            .as_deref(),
            Some("legacy"),
        );
    }

    #[test]
    fn no_config_orphan_scan_uses_canonical_home_default() {
        let _guard = test_env_lock().lock().expect("lock");
        let original_home = std::env::var("HOME").ok();
        let original_tw_home = std::env::var("TW_DASHBOARD_HOME").ok();
        let temp = tempfile::tempdir().expect("tempdir");
        unsafe {
            std::env::set_var("HOME", temp.path());
            std::env::set_var("TW_DASHBOARD_HOME", temp.path());
        }
        let base = default_worktree_base();
        let worktree = Path::new(&base).join("demo").join("demo-recover-abc12");
        fs::create_dir_all(&worktree).expect("worktree");
        fs::write(
            worktree.join(".git"),
            "gitdir: /repo/.git/worktrees/demo-recover-abc12",
        )
        .expect("git entry");

        let orphans = list_orphaned_worktrees().expect("orphan scan");
        assert!(orphans.iter().any(|orphan| {
            orphan.name == "demo-recover" && orphan.path == worktree.to_string_lossy()
        }));
        restore_env("TW_DASHBOARD_HOME", original_tw_home);
        restore_env("HOME", original_home);
    }

    #[test]
    fn managed_worktree_session_requires_tw_name_and_git_worktree_shape() {
        let temp = tempfile::tempdir().expect("tempdir");
        let base = temp.path().join("worktrees");
        let project = base.join("demo");
        let managed = project.join("demo-task-abc12");
        let plain = project.join("demo-task");
        let mismatched = project.join("other-task-abc12");
        let nested = managed.join("app/src");
        fs::create_dir_all(&managed).expect("managed");
        fs::create_dir_all(&plain).expect("plain");
        fs::create_dir_all(&mismatched).expect("mismatched");
        fs::create_dir_all(&nested).expect("nested");
        fs::write(
            managed.join(".git"),
            "gitdir: /repo/.git/worktrees/demo-task-abc12",
        )
        .expect("managed git file");
        fs::write(plain.join(".git"), "gitdir: /repo/.git/worktrees/demo-task")
            .expect("plain git file");
        fs::write(
            mismatched.join(".git"),
            "gitdir: /repo/.git/worktrees/other-task-abc12",
        )
        .expect("mismatched git file");

        let base = base.to_string_lossy().to_string();
        assert!(is_managed_worktree_session(
            "demo-task",
            managed.to_str().expect("managed path"),
            &base,
        ));
        assert!(!is_managed_worktree_session(
            "demo-task",
            plain.to_str().expect("plain path"),
            &base,
        ));
        assert!(!is_managed_worktree_session(
            "demo-task",
            mismatched.to_str().expect("mismatched path"),
            &base,
        ));
        assert_eq!(
            managed_worktree_root_for_session(
                "demo-task",
                nested.to_str().expect("nested path"),
                &base,
            )
            .as_deref(),
            managed.to_str(),
        );
    }

    #[test]
    fn config_parses_legacy_string_projects() {
        let config = serde_json::json!({
            "projects": {
                "frontend": "/repo/frontend"
            },
            "worktreeBase": "/tmp/tw"
        });

        let projects = projects_from_config(&config);
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "frontend");
        assert_eq!(projects[0].path, "/repo/frontend");
        assert_eq!(projects[0].branch, None);
        assert_eq!(config_worktree_base(&config).as_deref(), Some("/tmp/tw"));
    }

    #[test]
    fn config_parses_object_projects_with_aliases() {
        let config = serde_json::json!({
            "repositories": {
                "api": {
                    "repoPath": "/repo/api",
                    "target_branch": "develop"
                }
            },
            "worktreeRoot": "/tmp/worktrees"
        });

        let project = project_from_config(&config, "api").expect("project");
        assert_eq!(project.path, "/repo/api");
        assert_eq!(project.branch.as_deref(), Some("develop"));
        assert_eq!(
            config_worktree_base(&config).as_deref(),
            Some("/tmp/worktrees")
        );
    }

    #[test]
    fn config_parses_array_projects() {
        let config = serde_json::json!({
            "projects": [
                { "key": "web", "directory": "/repo/web", "defaultBranch": "main" }
            ]
        });

        let project = project_from_config(&config, "web").expect("project");
        assert_eq!(project.name, "web");
        assert_eq!(project.path, "/repo/web");
        assert_eq!(project.branch.as_deref(), Some("main"));
    }

    #[test]
    fn config_parses_remote_home_relative_paths() {
        let config = serde_json::json!({
            "projects": {
                "demo": { "directory": "~/code/demo", "defaultBranch": "develop" }
            },
            "worktreeBase": "~/.tmux-worktree/worktrees"
        });

        let projects = projects_from_config_with_home(&config, Some("/data/home/dev"));
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].name, "demo");
        assert_eq!(projects[0].path, "/data/home/dev/code/demo");
        assert_eq!(projects[0].branch.as_deref(), Some("develop"));
        assert_eq!(
            config_worktree_base_with_home(&config, Some("/data/home/dev")).as_deref(),
            Some("/data/home/dev/.tmux-worktree/worktrees")
        );
    }

    #[test]
    fn orphaned_worktrees_excludes_live_sessions() {
        let temp = tempfile::tempdir().expect("tempdir");
        let project_dir = temp.path().join("proj");
        fs::create_dir_all(project_dir.join("live-abc12")).expect("create live");
        fs::write(project_dir.join("live-abc12").join(".git"), "gitdir: x").expect("live .git");
        fs::create_dir_all(project_dir.join("orphan-def34")).expect("create orphan");
        fs::write(project_dir.join("orphan-def34").join(".git"), "gitdir: x").expect("orphan .git");
        // A plain subdirectory without `.git` (e.g. a checked-out repo's own
        // `src/`) must NOT be treated as a worktree.
        fs::create_dir_all(project_dir.join("src")).expect("create src");
        fs::write(project_dir.join("README.txt"), "ignore").expect("write file");

        let live_sessions = HashSet::from([String::from("live")]);
        let mut orphans = orphaned_worktrees(temp.path(), &live_sessions);
        orphans.sort_by(|a, b| a.name.cmp(&b.name));

        assert_eq!(orphans.len(), 1);
        assert_eq!(orphans[0].project, "proj");
        assert_eq!(orphans[0].name, "orphan");
        assert!(orphans[0].path.ends_with("/proj/orphan-def34"));
    }

    #[test]
    fn worktrees_for_session_returns_only_matching_session() {
        let temp = tempfile::tempdir().expect("tempdir");
        let project_dir = temp.path().join("proj");
        fs::create_dir_all(project_dir.join("demo-abc12")).expect("create demo");
        fs::write(project_dir.join("demo-abc12").join(".git"), "gitdir: x").expect("demo .git");
        fs::create_dir_all(project_dir.join("other-def34")).expect("create other");
        fs::write(project_dir.join("other-def34").join(".git"), "gitdir: x").expect("other .git");

        let matches = worktrees_for_session(temp.path(), "demo");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].project, "proj");
        assert_eq!(matches[0].name, "demo");
        assert!(matches[0].path.ends_with("/proj/demo-abc12"));
    }

    #[test]
    fn is_git_worktree_dir_requires_git_entry() {
        let temp = tempfile::tempdir().expect("tempdir");
        // Linked worktree: `.git` is a file.
        let linked = temp.path().join("linked");
        fs::create_dir_all(&linked).expect("linked");
        fs::write(linked.join(".git"), "gitdir: /repo/.git/worktrees/linked").expect("git file");
        assert!(is_git_worktree_dir(&linked));

        // Plain clone: `.git` is a directory.
        let clone = temp.path().join("clone");
        fs::create_dir_all(clone.join(".git")).expect("git dir");
        assert!(is_git_worktree_dir(&clone));

        // Plain subdirectory: no `.git`.
        let plain = temp.path().join("src");
        fs::create_dir_all(&plain).expect("plain");
        assert!(!is_git_worktree_dir(&plain));
    }

    #[test]
    fn try_cleanup_worktree_refuses_dirty_without_force() {
        let temp = tempfile::tempdir().expect("tempdir");
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).expect("repo");
        git(&["init", repo.to_str().expect("repo str")]);
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "config",
            "user.name",
            "test",
        ]);
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "config",
            "user.email",
            "test@example.com",
        ]);
        fs::write(repo.join("README.md"), "hello\n").expect("write repo file");
        git(&["-C", repo.to_str().expect("repo str"), "add", "README.md"]);
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "commit",
            "-m",
            "init",
        ]);

        let worktree = temp.path().join("wt-dirty");
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "worktree",
            "add",
            "-b",
            "dirty-branch",
            worktree.to_str().expect("worktree str"),
        ]);
        fs::write(worktree.join("dirty.txt"), "uncommitted\n").expect("dirty file");

        let path = worktree.to_string_lossy().to_string();
        assert!(!try_cleanup_worktree(&path, false));
        assert!(Path::new(&worktree).exists());
        assert!(try_cleanup_worktree(&path, true));
        assert!(!Path::new(&worktree).exists());
    }

    #[test]
    fn worktree_dirty_check_detects_untracked_changes() {
        let temp = tempfile::tempdir().expect("tempdir");
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).expect("repo");
        git(&["init", repo.to_str().expect("repo str")]);
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "config",
            "user.name",
            "test",
        ]);
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "config",
            "user.email",
            "test@example.com",
        ]);
        fs::write(repo.join("README.md"), "hello\n").expect("write repo file");
        git(&["-C", repo.to_str().expect("repo str"), "add", "README.md"]);
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "commit",
            "-m",
            "init",
        ]);

        let worktree = temp.path().join("wt-clean");
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "worktree",
            "add",
            "-b",
            "dirty-check",
            worktree.to_str().expect("worktree str"),
        ]);
        let path = worktree.to_string_lossy().to_string();

        assert_eq!(worktree_has_uncommitted_changes(&path), Some(false));
        fs::write(worktree.join("dirty.txt"), "uncommitted\n").expect("dirty file");
        assert_eq!(worktree_has_uncommitted_changes(&path), Some(true));
    }

    #[test]
    fn local_tw_rpc_argument_and_response_contract_is_strict() {
        let missing_target = build_local_worktree_rpc_args(
            &CreateArgs {
                project: Some("  ".to_string()),
                path: None,
                ai_cmd: "codex".to_string(),
                name: None,
                branch: None,
                host_id: None,
            },
            "/tmp/worktrees",
        )
        .expect_err("missing project and path");
        assert_eq!(missing_target, "project or path required");

        let missing_command = build_local_worktree_rpc_args(
            &CreateArgs {
                project: Some("demo".to_string()),
                path: None,
                ai_cmd: "  ".to_string(),
                name: None,
                branch: None,
                host_id: None,
            },
            "/tmp/worktrees",
        )
        .expect_err("missing ai command");
        assert_eq!(missing_command, "ai command required");

        assert_eq!(
            parse_local_worktree_rpc_response(
                r#"{"protocolVersion":1,"kind":"worktree","session":" demo-session ","worktreePath":"/tmp/demo"}"#,
                "test runtime",
            )
            .expect("valid response"),
            "demo-session"
        );
        assert!(parse_local_worktree_rpc_response(
            r#"{"protocolVersion":2,"kind":"worktree","session":"demo"}"#,
            "test runtime",
        )
        .expect_err("unsupported protocol")
        .contains("unsupported test runtime TW RPC protocol: 2"));
        assert!(parse_local_worktree_rpc_response(
            r#"{"protocolVersion":1,"kind":"terminal","session":"demo"}"#,
            "test runtime",
        )
        .expect_err("wrong kind")
        .contains("unexpected create kind: terminal"));
        assert!(parse_local_worktree_rpc_response(
            r#"{"protocolVersion":1,"kind":"worktree","session":"  "}"#,
            "test runtime",
        )
        .expect_err("empty session")
        .contains("empty worktree session name"));

        parse_kill_session_rpc_response(
            r#"{"protocolVersion":1,"kind":"session-killed","session":"demo"}"#,
            "test runtime",
            "demo",
        )
        .expect("valid managed kill response");
        assert!(parse_kill_session_rpc_response(
            r#"{"protocolVersion":1,"kind":"session-killed","session":"other"}"#,
            "test runtime",
            "demo",
        )
        .expect_err("mismatched managed kill response")
        .contains("unexpected kill-session response"));
    }

    #[test]
    fn canonical_kill_fails_closed_on_corrupt_managed_state_for_every_ui_hint() {
        let corrupt_state_error = "bundled TW RPC kill-session failed (exit status: 1): refusing to mutate invalid managed state: original file preserved";

        for managed_hint in [None, Some(false), Some(true)] {
            let canonical_called = std::cell::Cell::new(false);
            let legacy_called = std::cell::Cell::new(false);
            let error = kill_canonical_first(
                managed_hint,
                || {
                    canonical_called.set(true);
                    Err(corrupt_state_error.to_string())
                },
                || {
                    legacy_called.set(true);
                    Ok(())
                },
            )
            .expect_err("corrupt managed state must fail closed");

            assert!(canonical_called.get());
            assert!(!legacy_called.get());
            assert_eq!(error, corrupt_state_error);
        }
        assert!(!kill_rpc_explicitly_allows_legacy_fallback(
            corrupt_state_error
        ));
        assert!(!kill_rpc_explicitly_allows_legacy_fallback(
            "ssh on Dev failed: Connection reset by peer"
        ));
        assert!(!kill_rpc_explicitly_allows_legacy_fallback(
            "parse bundled TW RPC kill-session response: expected value"
        ));
        assert!(!kill_rpc_explicitly_allows_legacy_fallback(
            "unsupported bundled TW RPC protocol: 2"
        ));
    }

    #[test]
    fn canonical_kill_only_falls_back_for_explicit_legacy_compatibility() {
        for explicit_legacy_error in [
            "session is not TW-managed: legacy-session",
            "remote tw failed: unknown rpc command: kill-session",
            "remote tw failed: unknown subcommand kill-session",
            "remote tw failed: invalid kill-session option --name",
            "remote tw failed: unknown command: rpc",
            "ssh on Dev failed: sh: tw: command not found",
        ] {
            let legacy_called = std::cell::Cell::new(false);
            kill_canonical_first(
                Some(false),
                || Err(explicit_legacy_error.to_string()),
                || {
                    legacy_called.set(true);
                    Ok(())
                },
            )
            .expect("explicit old-runtime signal may use legacy tmux lifecycle");
            assert!(
                legacy_called.get(),
                "did not fall back for {explicit_legacy_error}"
            );
            assert!(kill_rpc_explicitly_allows_legacy_fallback(
                explicit_legacy_error
            ));
        }

        let legacy_called = std::cell::Cell::new(false);
        kill_canonical_first(
            Some(false),
            || Ok(()),
            || {
                legacy_called.set(true);
                Ok(())
            },
        )
        .expect("canonical kill");
        assert!(!legacy_called.get());
    }

    #[test]
    fn local_tw_rpc_runtime_requires_bundled_node_or_exact_installed_version() {
        let temp = tempfile::tempdir().expect("tempdir");
        let unavailable = select_local_tw_rpc_runtime(None, None, None, temp.path())
            .expect_err("no canonical runtime");
        assert!(unavailable.contains("Canonical local TW runtime unavailable"));
        assert!(
            unavailable.contains("Direct Rust/tmux lifecycle fallbacks are intentionally disabled")
        );

        let installed_tw = temp.path().join("tw");
        fs::write(
            &installed_tw,
            format!(
                "#!/bin/sh\nif [ \"$1\" = \"version\" ]; then\n  printf '%s\\n' '{}'\n  exit 0\nfi\nif [ \"$1 $2\" = \"rpc capabilities\" ]; then\n  printf '%s\\n' '{{\"protocolVersion\":1,\"capabilities\":[\"list\",\"create-worktree\",\"create-terminal\",\"restore-worktree\",\"kill-session\"]}}'\n  exit 0\nfi\nexit 2\n",
                env!("CARGO_PKG_VERSION")
            ),
        )
        .expect("fake installed tw");
        let mut permissions = fs::metadata(&installed_tw)
            .expect("fake installed tw metadata")
            .permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&installed_tw, permissions).expect("fake installed tw permissions");

        assert_eq!(
            select_local_tw_rpc_runtime(
                None,
                None,
                Some(installed_tw.to_string_lossy().to_string()),
                temp.path(),
            )
            .expect("same-version installed fallback"),
            LocalTwRpcRuntime::Installed {
                tw: installed_tw.to_string_lossy().to_string(),
            }
        );

        fs::write(
            &installed_tw,
            format!(
                "#!/bin/sh\nif [ \"$1\" = \"version\" ]; then printf '%s\\n' '{}'; exit 0; fi\nif [ \"$1 $2\" = \"rpc capabilities\" ]; then printf '%s\\n' '{{\"protocolVersion\":1,\"capabilities\":[\"list\",\"create-worktree\"]}}'; exit 0; fi\nexit 2\n",
                env!("CARGO_PKG_VERSION")
            ),
        )
        .expect("replace fake installed tw");
        let incompatible = select_local_tw_rpc_runtime(
            None,
            None,
            Some(installed_tw.to_string_lossy().to_string()),
            temp.path(),
        )
        .expect_err("same version without the lifecycle capabilities");
        assert!(incompatible.contains("complete Dashboard TW RPC contract"));
    }

    #[test]
    fn local_dashboard_create_delegates_every_field_to_bundled_tw_rpc() {
        let _guard = test_env_lock().lock().expect("lock");
        let original_home = std::env::var("HOME").ok();
        let original_tw_home = std::env::var("TW_DASHBOARD_HOME").ok();

        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("home");
        let base = temp.path().join("worktrees");
        fs::create_dir_all(&home).expect("home");
        fs::create_dir_all(&base).expect("base");

        fs::write(
            home.join(".tmux-worktree.json"),
            serde_json::json!({
                "worktreeBase": base
            })
            .to_string(),
        )
        .expect("config");

        unsafe {
            std::env::set_var("HOME", &home);
            std::env::set_var("TW_DASHBOARD_HOME", &home);
        }

        let fake_cli = temp.path().join("fake-tw-cli.sh");
        fs::write(
            &fake_cli,
            r#"#!/bin/sh
args_file="$HOME/rpc-args.txt"
: > "$args_file"
for arg in "$@"; do
  printf '%s\n' "$arg" >> "$args_file"
done
mkdir -p "$HOME/.tmux-worktree"
printf '%s\n' '{"version":1,"sessions":[{"name":"demo-layout","kind":"worktree","profile":"dashboard","createdAt":"2026-07-11T00:00:00Z"}]}' > "$HOME/.tmux-worktree/state.json"
printf '%s\n' '{"protocolVersion":1,"kind":"worktree","session":"demo-layout","worktreePath":"/tmp/demo-layout","branch":"develop"}'
"#,
        )
        .expect("fake cli");

        let runtime = LocalTwRpcRuntime::Bundled {
            node: "/bin/sh".to_string(),
            cli: fake_cli,
        };
        let session = create_local_worktree_via_runtime(
            &runtime,
            CreateArgs {
                project: Some("  demo  ".to_string()),
                path: Some("  /repo/path  ".to_string()),
                ai_cmd: "  codex --quiet  ".to_string(),
                name: Some("  layout  ".to_string()),
                branch: Some("  develop  ".to_string()),
                host_id: None,
            },
        )
        .expect("delegate create worktree");

        assert_eq!(session, "demo-layout");
        let forwarded = fs::read_to_string(home.join("rpc-args.txt")).expect("forwarded args");
        assert_eq!(
            forwarded.lines().collect::<Vec<_>>(),
            vec![
                "rpc",
                "create-worktree",
                "--path",
                "/repo/path",
                "--project",
                "demo",
                "--ai-command",
                "codex --quiet",
                "--name",
                "layout",
                "--branch",
                "develop",
                "--worktree-base",
                base.to_str().expect("base str"),
            ]
        );
        let state: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(home.join(".tmux-worktree/state.json")).expect("managed state"),
        )
        .expect("state json");
        assert_eq!(state["sessions"][0]["name"], "demo-layout");
        assert_eq!(state["sessions"][0]["profile"], "dashboard");

        restore_env("TW_DASHBOARD_HOME", original_tw_home);
        restore_env("HOME", original_home);
    }

    #[test]
    fn local_dashboard_terminal_delegates_to_bundled_tw_rpc() {
        let _guard = test_env_lock().lock().expect("lock");
        let original_home = std::env::var("HOME").ok();
        let original_tw_home = std::env::var("TW_DASHBOARD_HOME").ok();
        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("home");
        fs::create_dir_all(&home).expect("home");
        unsafe {
            std::env::set_var("HOME", &home);
            std::env::set_var("TW_DASHBOARD_HOME", &home);
        }
        let fake_cli = temp.path().join("fake-tw-cli.sh");
        fs::write(
            &fake_cli,
            r#"#!/bin/sh
: > "$HOME/terminal-rpc-args.txt"
for arg in "$@"; do
  printf '%s\n' "$arg" >> "$HOME/terminal-rpc-args.txt"
done
printf '%s\n' '{"protocolVersion":1,"kind":"terminal","session":"tw-term-abc12","cwd":"/repo/app"}'
"#,
        )
        .expect("fake cli");
        let runtime = LocalTwRpcRuntime::Bundled {
            node: "/bin/sh".to_string(),
            cli: fake_cli,
        };
        let terminal = create_local_terminal_via_runtime(
            &runtime,
            &CreateTerminalArgs {
                cwd: "/repo/app".to_string(),
                ai_cmd: "codex --quiet".to_string(),
                host_id: None,
            },
        )
        .expect("create terminal through rpc");
        assert_eq!(terminal.raw_name, "tw-term-abc12");
        assert_eq!(terminal.tmux_name, "tw-term-abc12");
        assert_eq!(terminal.host_id, None);
        assert_eq!(
            fs::read_to_string(home.join("terminal-rpc-args.txt"))
                .expect("terminal args")
                .lines()
                .collect::<Vec<_>>(),
            vec![
                "rpc",
                "create-terminal",
                "--cwd",
                "/repo/app",
                "--ai-command",
                "codex --quiet",
            ]
        );
        restore_env("TW_DASHBOARD_HOME", original_tw_home);
        restore_env("HOME", original_home);
    }

    #[test]
    fn restore_worktree_delegates_to_canonical_tw_rpc() {
        let _guard = test_env_lock().lock().expect("lock");
        let original_home = std::env::var("HOME").ok();
        let original_tw_home = std::env::var("TW_DASHBOARD_HOME").ok();
        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("home");
        fs::create_dir_all(&home).expect("home");
        unsafe {
            std::env::set_var("HOME", &home);
            std::env::set_var("TW_DASHBOARD_HOME", &home);
        }
        let fake_cli = temp.path().join("fake-tw-cli.sh");
        fs::write(
            &fake_cli,
            r#"#!/bin/sh
: > "$HOME/restore-rpc-args.txt"
for arg in "$@"; do
  printf '%s\n' "$arg" >> "$HOME/restore-rpc-args.txt"
done
printf '%s\n' '{"protocolVersion":1,"kind":"worktree","session":"demo-restored","worktreePath":"/tmp/demo-restored","branch":"demo-restored-abc12"}'
"#,
        )
        .expect("fake cli");
        let runtime = LocalTwRpcRuntime::Bundled {
            node: "/bin/sh".to_string(),
            cli: fake_cli,
        };
        let session = restore_local_worktree_via_runtime(
            &runtime,
            &RestoreArgs {
                path: "/tmp/demo-restored".to_string(),
                name: "demo-restored".to_string(),
                ai_cmd: "codex --quiet".to_string(),
            },
        )
        .expect("restore through rpc");
        assert_eq!(session, "demo-restored");
        assert_eq!(
            fs::read_to_string(home.join("restore-rpc-args.txt"))
                .expect("restore args")
                .lines()
                .collect::<Vec<_>>(),
            vec![
                "rpc",
                "restore-worktree",
                "--path",
                "/tmp/demo-restored",
                "--name",
                "demo-restored",
                "--ai-command",
                "codex --quiet",
            ]
        );
        restore_env("TW_DASHBOARD_HOME", original_tw_home);
        restore_env("HOME", original_home);
    }

    #[test]
    fn kill_session_does_not_register_worktree_for_cleanup() {
        let _guard = test_env_lock().lock().expect("lock");
        let original_home = std::env::var("HOME").ok();
        let original_tw_home = std::env::var("TW_DASHBOARD_HOME").ok();

        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("home");
        let base = temp.path().join("worktrees");
        fs::create_dir_all(&home).expect("home");
        fs::create_dir_all(&base).expect("base");
        fs::write(
            home.join(".tmux-worktree.json"),
            serde_json::json!({ "projects": {}, "worktreeBase": base }).to_string(),
        )
        .expect("config");

        let session = format!("tw-test-{}", uuid::Uuid::new_v4().simple());
        let session: String = session.chars().take(20).collect();
        let worktree = base.join("demo").join(format!("{session}-abc12"));
        fs::create_dir_all(&worktree).expect("worktree");
        fs::write(worktree.join(".git"), "gitdir: /not/a/repo").expect(".git");

        unsafe {
            std::env::set_var("HOME", &home);
            std::env::set_var("TW_DASHBOARD_HOME", &home);
        }

        git(&["init", temp.path().join("repo").to_str().expect("repo str")]);
        let tmux_status = std::process::Command::new("tmux")
            .args([
                "new-session",
                "-d",
                "-s",
                &session,
                "-c",
                temp.path().to_str().expect("temp path"),
            ])
            .status()
            .expect("spawn tmux");
        assert!(tmux_status.success(), "tmux new-session failed");

        kill_legacy_session(&session).expect("kill session");
        std::thread::sleep(std::time::Duration::from_millis(300));

        assert!(load_pending_cleanup().is_empty());

        let _ = std::process::Command::new("tmux")
            .args(["kill-session", "-t", &format!("={session}")])
            .status();
        if let Some(home) = original_home {
            unsafe {
                std::env::set_var("HOME", home);
            }
        } else {
            unsafe {
                std::env::remove_var("HOME");
            }
        }
        if let Some(home) = original_tw_home {
            unsafe {
                std::env::set_var("TW_DASHBOARD_HOME", home);
            }
        } else {
            unsafe {
                std::env::remove_var("TW_DASHBOARD_HOME");
            }
        }
    }

    #[test]
    fn delete_worktree_requires_force_for_dirty_worktree() {
        let _guard = test_env_lock().lock().expect("lock");
        let original_home = std::env::var("HOME").ok();
        let original_tw_home = std::env::var("TW_DASHBOARD_HOME").ok();

        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("home");
        fs::create_dir_all(&home).expect("home");
        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).expect("repo");
        git(&["init", repo.to_str().expect("repo str")]);
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "config",
            "user.name",
            "test",
        ]);
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "config",
            "user.email",
            "test@example.com",
        ]);
        fs::write(repo.join("README.md"), "hello\n").expect("write repo file");
        git(&["-C", repo.to_str().expect("repo str"), "add", "README.md"]);
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "commit",
            "-m",
            "init",
        ]);
        let worktree = temp.path().join("wt-delete-dirty");
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "worktree",
            "add",
            "-b",
            "delete-dirty",
            worktree.to_str().expect("worktree str"),
        ]);
        fs::write(worktree.join("dirty.txt"), "uncommitted\n").expect("dirty file");

        unsafe {
            std::env::set_var("HOME", &home);
            std::env::set_var("TW_DASHBOARD_HOME", &home);
        }
        let path = worktree.to_string_lossy().to_string();
        save_pending_cleanup(&[OrphanedWorktree {
            project: "demo".to_string(),
            path: path.clone(),
            name: "delete-dirty".to_string(),
        }]);

        let err = delete_worktree(DeleteWorktreeArgs {
            path: path.clone(),
            force: false,
        })
        .expect_err("dirty delete should require force");
        assert!(err.contains("uncommitted changes"));
        assert!(Path::new(&worktree).exists());
        assert_eq!(load_pending_cleanup().len(), 1);

        delete_worktree(DeleteWorktreeArgs {
            path: path.clone(),
            force: true,
        })
        .expect("forced delete");
        assert!(!Path::new(&worktree).exists());
        assert!(load_pending_cleanup().is_empty());

        if let Some(home) = original_home {
            unsafe {
                std::env::set_var("HOME", home);
            }
        } else {
            unsafe {
                std::env::remove_var("HOME");
            }
        }
        if let Some(home) = original_tw_home {
            unsafe {
                std::env::set_var("TW_DASHBOARD_HOME", home);
            }
        } else {
            unsafe {
                std::env::remove_var("TW_DASHBOARD_HOME");
            }
        }
    }

    #[test]
    fn cleanup_pending_worktrees_removes_registered_worktree() {
        let _guard = test_env_lock().lock().expect("lock");
        let original_home = std::env::var("HOME").ok();

        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join("home");
        fs::create_dir_all(&home).expect("home");

        let repo = temp.path().join("repo");
        fs::create_dir_all(&repo).expect("repo");
        git(&["init", repo.to_str().expect("repo str")]);
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "config",
            "user.name",
            "test",
        ]);
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "config",
            "user.email",
            "test@example.com",
        ]);
        fs::write(repo.join("README.md"), "hello\n").expect("write repo file");
        git(&["-C", repo.to_str().expect("repo str"), "add", "README.md"]);
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "commit",
            "-m",
            "init",
        ]);

        let worktree = temp.path().join("wt-cleanup");
        git(&[
            "-C",
            repo.to_str().expect("repo str"),
            "worktree",
            "add",
            "-b",
            "ghost-branch",
            worktree.to_str().expect("worktree str"),
        ]);

        unsafe {
            std::env::set_var("HOME", &home);
        }
        save_pending_cleanup(&[OrphanedWorktree {
            project: "demo".to_string(),
            path: worktree.to_string_lossy().to_string(),
            name: "ghost".to_string(),
        }]);

        cleanup_pending_worktrees();

        assert!(!Path::new(&worktree).exists());
        assert!(load_pending_cleanup().is_empty());
        let list = std::process::Command::new("git")
            .args([
                "-C",
                repo.to_str().expect("repo str"),
                "worktree",
                "list",
                "--porcelain",
            ])
            .output()
            .expect("git worktree list");
        let stdout = String::from_utf8_lossy(&list.stdout);
        assert!(!stdout.contains("wt-cleanup"));

        if let Some(home) = original_home {
            unsafe {
                std::env::set_var("HOME", home);
            }
        } else {
            unsafe {
                std::env::remove_var("HOME");
            }
        }
    }

    #[test]
    fn create_remote_worktree_requires_remote_tw_rpc_when_tw_is_missing() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    if [ "$#" -gt 0 ]; then shift; fi
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"
if [ "$#" -eq 1 ]; then
  case "$1" in
    *"'tw'"*"'rpc'"*"'create-worktree'"*)
      printf 'tw: command not found\n' >&2
      exit 127
      ;;
    *"'git'"*|*"'tmux'"*)
      printf 'dashboard must not use the legacy remote creator\n' >&2
      exit 12
      ;;
  esac
fi
printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
        }

        let host = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: Some("/tmp/tmux-worktree/projects".to_string()),
            tmux_path: None,
            tw_path: None,
        };
        let err = create_remote_worktree(
            &host,
            CreateArgs {
                project: None,
                path: Some("/remote/app".to_string()),
                ai_cmd: "echo ready".to_string(),
                name: None,
                branch: None,
                host_id: Some("dev".to_string()),
            },
        )
        .expect_err("missing remote tw must reject creation");

        let log = fs::read_to_string(&log_path).expect("ssh log");
        assert!(err.contains("does not have a compatible `tw rpc create-worktree`"));
        assert!(err.contains(&format!(
            "Install or upgrade remote tw to {}",
            env!("CARGO_PKG_VERSION")
        )));
        assert!(err.contains("will not fall back to direct remote git/tmux creation"));
        assert!(log.contains("'tw' 'rpc' 'create-worktree'"));
        assert!(!log.contains("'git'"));
        assert!(!log.contains("'tmux'"));

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
    }

    #[test]
    fn create_remote_worktree_with_config_project_still_requires_remote_tw_rpc() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    if [ "$#" -gt 0 ]; then shift; fi
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"

if [ "$#" -eq 1 ]; then
  case "$1" in
    *"'tw'"*"'rpc'"*"'create-worktree'"*)
      printf 'unknown rpc command: create-worktree\n' >&2
      exit 2
      ;;
    *'pwd -P'*)
      printf '/home/dev'
      exit 0
      ;;
    *'.tmux-worktree.json'*)
      cat <<'JSON'
{"projects":{"demo":{"directory":"~/src/demo","defaultBranch":"develop"}},"worktreeBase":"~/.tmux-worktree/worktrees"}
JSON
      exit 0
      ;;
    *"'git'"*|*"'tmux'"*|*"'mkdir'"*)
      printf 'dashboard must not use the legacy remote creator\n' >&2
      exit 12
      ;;
  esac
fi

printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
        }

        let host = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        };
        let err = create_remote_worktree(
            &host,
            CreateArgs {
                project: Some("demo".to_string()),
                path: None,
                ai_cmd: "codex".to_string(),
                name: Some("fix".to_string()),
                branch: None,
                host_id: Some("dev".to_string()),
            },
        )
        .expect_err("old remote tw must reject config-project creation");

        let log = fs::read_to_string(&log_path).expect("ssh log");
        assert!(err.contains("does not have a compatible `tw rpc create-worktree`"));
        assert!(log.contains("'--path' '/home/dev/src/demo'"));
        assert!(log.contains("'--project' 'demo'"));
        assert!(log.contains("'--branch' 'develop'"));
        assert!(!log.contains("'git'"));
        assert!(!log.contains("'tmux'"));
        assert!(!log.contains("'mkdir'"));

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
    }

    #[test]
    fn create_remote_worktree_prefers_remote_tw_rpc() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    if [ "$#" -gt 0 ]; then shift; fi
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"

if [ "$#" -eq 1 ]; then
  case "$1" in
    *"'tw'"*"'rpc'"*"'create-worktree'"*)
      cat <<'JSON'
{"protocolVersion":1,"session":"app-fix","kind":"worktree"}
JSON
      exit 0
      ;;
    *"'git'"*|*"'tmux'"*)
      printf 'dashboard should not run git/tmux directly when tw rpc create-worktree works\n' >&2
      exit 12
      ;;
  esac
fi

printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
        }

        let host = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        };
        let session = create_remote_worktree(
            &host,
            CreateArgs {
                project: None,
                path: Some("/remote/app".to_string()),
                ai_cmd: "codex".to_string(),
                name: Some("fix".to_string()),
                branch: Some("develop".to_string()),
                host_id: Some("dev".to_string()),
            },
        )
        .expect("remote tw rpc worktree session");

        assert_eq!(session, "dev:app-fix");
        let log = fs::read_to_string(&log_path).expect("ssh log");
        assert!(log.contains("'tw' 'rpc' 'create-worktree'"));
        assert!(log.contains("'--path' '/remote/app'"));
        assert!(log.contains("'--project' 'app'"));
        assert!(log.contains("'--ai-command' 'codex'"));
        assert!(log.contains("'--name' 'fix'"));
        assert!(log.contains("'--branch' 'develop'"));
        assert!(!log.contains("'git'"));
        assert!(!log.contains("'tmux'"));

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
    }

    #[test]
    fn create_remote_worktree_does_not_fallback_when_remote_tw_rejects_create() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    if [ "$#" -gt 0 ]; then shift; fi
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"

if [ "$#" -eq 1 ]; then
  case "$1" in
    *"'tw'"*"'rpc'"*"'create-worktree'"*)
      printf 'remote tw rejected request\n' >&2
      exit 9
      ;;
    *"'git'"*|*"'tmux'"*)
      printf 'dashboard should not bypass a present remote tw binary\n' >&2
      exit 12
      ;;
  esac
fi

printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
        }

        let host = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        };
        let err = create_remote_worktree(
            &host,
            CreateArgs {
                project: None,
                path: Some("/remote/app".to_string()),
                ai_cmd: "codex".to_string(),
                name: Some("fix".to_string()),
                branch: None,
                host_id: Some("dev".to_string()),
            },
        )
        .expect_err("remote tw rejection should be returned");

        let log = fs::read_to_string(&log_path).expect("ssh log");
        assert!(err.contains("remote tw rejected request"), "{err}");
        assert!(log.contains("'tw' 'rpc' 'create-worktree'"));
        assert!(!log.contains("'git'"));
        assert!(!log.contains("'tmux'"));

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
    }

    #[test]
    fn list_remote_sessions_quotes_tmux_format_for_remote_shell() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    if [ "$#" -gt 0 ]; then shift; fi
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"

if [ "$#" -eq 1 ]; then
  case "$1" in
    *"'tmux'"*"'list-sessions'"*"'#{session_name}"*)
      printf 'dev-session\0370\0371\03710\03720\n'
      exit 0
      ;;
    *"tmux capture-pane"*)
      printf 'dev-session\037123:45\037 ⠇ dev-session\n'
      exit 0
      ;;
    *"'tmux'"*"'display-message'"*"'=dev-session:'"*)
      printf '/remote/worktrees/dev-session-abc12\n'
      exit 0
      ;;
    *"'git'"*"'rev-parse'"*"'--show-toplevel'"*)
      printf '/remote/worktrees/dev-session-abc12\n'
      exit 0
      ;;
  esac
fi

if [ "$1" = "tmux" ] && [ "$2" = "list-sessions" ] && [ "$3" = "-F" ]; then
  printf 'tmux: option requires an argument -- F\n' >&2
  exit 1
fi

printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
        }

        let host = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        };

        let sessions = list_remote_sessions(&host).expect("remote sessions");

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].name, "dev:dev-session");
        assert_eq!(sessions[0].host_id.as_deref(), Some("dev"));
        assert_eq!(sessions[0].raw_name, "dev-session");
        assert_eq!(
            sessions[0].output_signature.as_deref(),
            Some("remote:123:45")
        );
        assert_eq!(sessions[0].agent_running, Some(true));

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
    }

    #[test]
    fn list_remote_sessions_merges_rpc_state_with_legacy_tw_shaped_tmux_sessions() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    if [ "$#" -gt 0 ]; then shift; fi
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"

if [ "$#" -eq 1 ]; then
  case "$1" in
    *"'tw'"*"'rpc'"*"'list'"*)
      cat <<'JSON'
{"protocolVersion":1,"sessions":[{"name":"managed-cli","kind":"worktree","profile":"cli","project":"coco","repoPath":"/remote/coco","worktreePath":"/home/dev/.tmux-worktree/worktrees/coco/managed-cli-a1b2c","branch":"managed-cli-a1b2c","baseBranch":"main","createdAt":"2026-07-02T00:00:00.000Z","attached":false,"windows":3,"created":1760000000,"activity":1760000100,"cwd":"/home/dev/.tmux-worktree/worktrees/coco/managed-cli-a1b2c"}]}
JSON
      exit 0
      ;;
    *"tmux capture-pane"*)
      printf 'managed-cli\037123:45\037 ⠇ managed-cli\nlegacy-cli\037456:78\037 idle\n'
      exit 0
      ;;
    *"'tmux'"*"'list-sessions'"*)
      printf 'managed-cli\0370\0373\0371760000000\0371760000100\nlegacy-cli\0370\0371\0371760000200\0371760000300\n'
      exit 0
      ;;
    *"'tmux'"*"'display-message'"*"'=managed-cli:'"*)
      printf '/home/dev/.tmux-worktree/worktrees/coco/managed-cli-a1b2c\n'
      exit 0
      ;;
    *"'tmux'"*"'display-message'"*"'=legacy-cli:'"*)
      printf '/home/dev/.tmux-worktree/worktrees/coco/legacy-cli-d3e4f\n'
      exit 0
      ;;
    *"'git'"*"managed-cli-a1b2c"*"'rev-parse'"*"'--show-toplevel'"*)
      printf '/home/dev/.tmux-worktree/worktrees/coco/managed-cli-a1b2c\n'
      exit 0
      ;;
    *"'git'"*"legacy-cli-d3e4f"*"'rev-parse'"*"'--show-toplevel'"*)
      printf '/home/dev/.tmux-worktree/worktrees/coco/legacy-cli-d3e4f\n'
      exit 0
      ;;
  esac
fi

printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
        }

        let host = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        };

        let sessions = list_remote_sessions(&host).expect("remote rpc sessions");
        let log = fs::read_to_string(&log_path).expect("ssh log");

        assert_eq!(sessions.len(), 2, "ssh log:\n{log}");
        assert_eq!(sessions[0].name, "dev:managed-cli");
        assert_eq!(sessions[0].raw_name, "managed-cli");
        assert_eq!(sessions[0].window_count, 3);
        assert_eq!(sessions[0].host_id.as_deref(), Some("dev"));
        assert_eq!(sessions[0].project.as_deref(), Some("coco"));
        assert_eq!(
            sessions[0].output_signature.as_deref(),
            Some("remote:123:45")
        );
        assert_eq!(sessions[0].agent_running, Some(true));
        assert_eq!(sessions[1].name, "dev:legacy-cli");
        assert_eq!(sessions[1].raw_name, "legacy-cli");
        assert_eq!(sessions[1].window_count, 1);
        assert!(log.contains("'tw' 'rpc' 'list'"));
        assert!(log.contains("tmux capture-pane"));
        assert!(log.contains("'tmux' 'list-sessions'"));

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
    }

    #[test]
    fn remote_tmux_terminal_listing_only_includes_tw_managed_sessions() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    if [ "$#" -gt 0 ]; then shift; fi
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"

if [ "$#" -ne 1 ]; then
  printf 'unexpected remote command: %s\n' "$*" >&2
  exit 12
fi

case "$1" in
  *"'tmux'"*"'list-sessions'"*)
    printf 'demo\0370\0371\03710\03720\nplain-shell\0371\0371\03711\03721\ntw-term-shell\0371\0371\03712\03722\n'
    exit 0
    ;;
  *"tmux capture-pane"*)
    printf 'demo\037123:45\037 idle\n'
    exit 0
    ;;
  *"'tmux'"*"'display-message'"*"'=demo:'"*)
    printf '/remote/worktrees/demo-abc12\n'
    exit 0
    ;;
  *"'tmux'"*"'display-message'"*"'=plain-shell:'"*)
    printf '/home/dev\n'
    exit 0
    ;;
  *"'tmux'"*"'display-message'"*"'=tw-term-shell:'"*)
    printf '/home/dev/app\n'
    exit 0
    ;;
  *"'git'"*"demo-abc12"*"'rev-parse'"*"'--show-toplevel'"*)
    printf '/remote/worktrees/demo-abc12\n'
    exit 0
    ;;
  *"'git'"*"'rev-parse'"*"'--show-toplevel'"*)
    printf 'fatal: not a git repository\n' >&2
    exit 128
    ;;
esac

printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
        }

        let host = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        };

        let worktrees = list_remote_sessions(&host).expect("remote worktrees");
        let terminals = list_remote_tmux_terminals(&host).expect("remote terminals");
        let log = fs::read_to_string(&log_path).expect("ssh log");

        assert_eq!(worktrees.len(), 1, "ssh log:\n{log}");
        assert_eq!(worktrees[0].name, "dev:demo");
        assert_eq!(terminals.len(), 1, "ssh log:\n{log}");
        assert_eq!(terminals[0].id, "ssh:dev:tw-term-shell");
        assert_eq!(terminals[0].label, "tw-term-shell");
        assert_eq!(terminals[0].host_id.as_deref(), Some("dev"));
        assert_eq!(terminals[0].raw_name, "tw-term-shell");

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
    }

    #[test]
    fn remote_tmux_terminal_listing_merges_rpc_state_with_dashboard_tmux_sessions() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    if [ "$#" -gt 0 ]; then shift; fi
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"

if [ "$#" -eq 1 ]; then
  case "$1" in
    *"'tw'"*"'rpc'"*"'list'"*)
      cat <<'JSON'
{"protocolVersion":1,"sessions":[{"name":"managed-cli","kind":"worktree","attached":false,"windows":1,"created":1760000000,"activity":1760000100,"cwd":"/remote/worktrees/managed-cli"},{"name":"tw-term-agent","kind":"terminal","attached":true,"windows":1,"created":1760000200,"activity":1760000300,"cwd":"/remote/app"}]}
JSON
      exit 0
      ;;
    *"'tmux'"*"'list-sessions'"*)
      printf 'tw-term-agent\0371\0371\0371760000200\0371760000300\ntw-term-direct\0370\0371\0371760000400\0371760000500\n'
      exit 0
      ;;
    *"'tmux'"*"'display-message'"*"'=tw-term-agent:'"*)
      printf '/remote/app\n'
      exit 0
      ;;
    *"'tmux'"*"'display-message'"*"'=tw-term-direct:'"*)
      printf '/remote/direct\n'
      exit 0
      ;;
    *"'git'"*"'rev-parse'"*"'--show-toplevel'"*)
      printf 'fatal: not a git repository\n' >&2
      exit 128
      ;;
  esac
fi

printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
        }

        let host = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        };

        let terminals = list_remote_tmux_terminals(&host).expect("remote rpc terminals");
        let log = fs::read_to_string(&log_path).expect("ssh log");

        assert_eq!(terminals.len(), 2, "ssh log:\n{log}");
        assert_eq!(terminals[0].id, "ssh:dev:tw-term-agent");
        assert_eq!(terminals[0].label, "tw-term-agent");
        assert_eq!(terminals[0].tmux_name, "dev:tw-term-agent");
        assert_eq!(terminals[0].cwd, "/remote/app");
        assert_eq!(terminals[0].host_id.as_deref(), Some("dev"));
        assert_eq!(terminals[0].raw_name, "tw-term-agent");
        assert_eq!(terminals[1].id, "ssh:dev:tw-term-direct");
        assert_eq!(terminals[1].cwd, "/remote/direct");
        assert_eq!(terminals[1].host_id.as_deref(), Some("dev"));
        assert!(log.contains("'tw' 'rpc' 'list'"));
        assert!(log.contains("'tmux' 'list-sessions'"));

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
    }

    #[test]
    fn remote_directory_picker_reads_home_and_directories_over_ssh() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    if [ "$#" -gt 0 ]; then shift; fi
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"

if [ "$#" -eq 1 ]; then
  case "$1" in
    *'pwd -P'*)
      printf '/data/home/dev'
      exit 0
      ;;
    *"find -L"*"/home/dev"*)
      printf '/home/dev/.cache\0/home/dev/workspace\0/home/dev/workspace/x\0'
      exit 0
      ;;
  esac
fi

printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
        }

        let host = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        };

        let home = remote_home_dir_for_host(&host).expect("remote home");
        let entries = remote_read_dirs_for_host(&host, "/home/dev").expect("remote dirs");
        let paths = entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(home, "/data/home/dev");
        assert_eq!(
            paths,
            vec![
                "/home/dev/.cache",
                "/home/dev/workspace",
                "/home/dev/workspace/x",
            ]
        );
        assert!(entries.iter().all(|entry| entry.is_dir));
        assert!(entries[0].is_hidden);
        assert!(!entries[1].is_hidden);
        assert!(
            !fs::read_to_string(&log_path)
                .expect("ssh log")
                .contains("'sh' '-lc'"),
            "remote picker must not use a login sh; dash can choke on bash-only profile scripts"
        );

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
    }

    #[test]
    fn remote_file_editor_checks_reads_and_writes_over_ssh() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let input_path = temp.path().join("ssh-input");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    if [ "$#" -gt 0 ]; then shift; fi
    break
  fi
  shift
done

case "$1" in
  *"test -f"*)
    case "$1" in
      *"/workspace/src/main.rs"*) exit 0 ;;
      *) exit 1 ;;
    esac
    ;;
  *"tw-dashboard-write"*)
    cat > "${TW_FAKE_SSH_INPUT:?}"
    exit 0
    ;;
  *"wc -c"*)
    printf 'fn main() { println!("remote"); }\n'
    exit 0
    ;;
esac

printf 'unexpected remote command: %s\n' "$1" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_input = std::env::var("TW_FAKE_SSH_INPUT").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_INPUT", &input_path);
        }

        let host = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        };

        assert!(remote_file_exists_for_host(&host, "/workspace/src/main.rs")
            .expect("existing remote file"));
        assert!(
            !remote_file_exists_for_host(&host, "/workspace/src/missing.rs")
                .expect("missing remote file")
        );
        assert_eq!(
            remote_read_file_bytes_for_host(&host, "/workspace/src/main.rs")
                .expect("read remote file"),
            b"fn main() { println!(\"remote\"); }\n"
        );

        let replacement = b"fn main() { println!(\"saved\"); }\n";
        remote_write_file_for_host(&host, "/workspace/src/main.rs", replacement)
            .expect("write remote file");
        assert_eq!(
            fs::read(&input_path).expect("captured ssh input"),
            replacement
        );

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_INPUT", original_input);
    }

    #[test]
    fn create_remote_terminal_delegates_to_tw_rpc_without_tmux_fallback() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    if [ "$#" -gt 0 ]; then shift; fi
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"

case "$1" in
  *"'tw' 'rpc' 'create-terminal'"*)
    printf '%s\n' '{"protocolVersion":1,"kind":"terminal","session":"tw-term-abc12","cwd":"/remote/app"}'
    exit 0
    ;;
esac

printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        let original_home = std::env::var("HOME").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
            std::env::set_var("HOME", temp.path());
        }

        let host = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        };
        save_hosts_config(&[host]).expect("save hosts");

        let terminal = create_remote_terminal_via_tw_rpc(
            &find_host("dev").expect("configured host"),
            &CreateTerminalArgs {
                cwd: "/remote/app".to_string(),
                ai_cmd: "codex --dangerously-bypass-approvals-and-sandbox".to_string(),
                host_id: Some("dev".to_string()),
            },
        )
        .expect("remote terminal");

        assert_eq!(terminal.host_id.as_deref(), Some("dev"));
        assert_eq!(terminal.raw_name, "tw-term-abc12");
        assert_eq!(terminal.tmux_name, format!("dev:{}", terminal.raw_name));

        let log = fs::read_to_string(&log_path).expect("ssh log");
        assert!(log.contains("'tw' 'rpc' 'create-terminal'"));
        assert!(log.contains("'--cwd' '/remote/app'"));
        assert!(log.contains("'--ai-command' 'codex --dangerously-bypass-approvals-and-sandbox'"));
        assert!(log.contains("codex --dangerously-bypass-approvals-and-sandbox"));
        assert!(!log.contains("'tmux' 'new-session'"));

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
        restore_env("HOME", original_home);
    }

    #[test]
    fn ensure_and_kill_remote_terminal_use_the_configured_host() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    if [ "$#" -gt 0 ]; then shift; fi
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"

case "$1" in
  *"'tmux'"*"'has-session'"*)
    exit 1
    ;;
  *"'tmux'"*"'new-session'"*)
    exit 0
    ;;
  *"'tmux'"*"'kill-session'"*)
    exit 0
    ;;
esac

printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        let original_home = std::env::var("HOME").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
            std::env::set_var("HOME", temp.path());
        }

        save_hosts_config(&[HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        }])
        .expect("save hosts");

        ensure_terminal_session(EnsureTerminalArgs {
            name: "dev:tw-term-dead1".to_string(),
            cwd: "/remote/app".to_string(),
            ai_cmd: Some("claude".to_string()),
            host_id: Some("dev".to_string()),
            raw_name: Some("tw-term-dead1".to_string()),
        })
        .expect("ensure remote terminal");
        kill_legacy_plain_terminal("dev:tw-term-dead1").expect("kill remote terminal");

        let log = fs::read_to_string(&log_path).expect("ssh log");
        assert!(log.contains("'tmux' 'has-session' '-t' '=tw-term-dead1'"));
        assert!(log.contains("'tmux' 'new-session' '-d' '-s' 'tw-term-dead1'"));
        assert!(log.contains("'tmux' 'kill-session' '-t' '=tw-term-dead1'"));
        assert!(log.contains(
            "'export PATH=\"$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"; claude; exec \"${SHELL:-/bin/zsh}\" -l'"
        ));

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
        restore_env("HOME", original_home);
    }

    #[test]
    fn remote_tmux_session_exists_distinguishes_missing_session_from_ssh_failure() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
case "${TW_FAKE_SSH_MODE:?}" in
  exists)
    exit 0
    ;;
  missing)
    printf "can't find session: tw-term-probe\n" >&2
    exit 1
    ;;
  remote_error)
    printf 'tmux: failed to connect to server\n' >&2
    exit 1
    ;;
  offline)
    printf 'ssh: connect to host ssh-host port 22: Operation timed out\n' >&2
    exit 255
    ;;
esac
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_mode = std::env::var("TW_FAKE_SSH_MODE").ok();
        let original_home = std::env::var("HOME").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("HOME", temp.path());
        }
        save_hosts_config(&[HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        }])
        .expect("save hosts");

        unsafe {
            std::env::set_var("TW_FAKE_SSH_MODE", "exists");
        }
        assert!(tmux_session_exists("dev:tw-term-probe".to_string()).expect("existing session"));

        unsafe {
            std::env::set_var("TW_FAKE_SSH_MODE", "missing");
        }
        assert!(!tmux_session_exists("dev:tw-term-probe".to_string()).expect("missing session"));

        unsafe {
            std::env::set_var("TW_FAKE_SSH_MODE", "remote_error");
        }
        let error = tmux_session_exists("dev:tw-term-probe".to_string())
            .expect_err("an arbitrary remote exit 1 must not look like a missing session");
        assert!(error.contains("failed to connect to server"), "{error}");

        unsafe {
            std::env::set_var("TW_FAKE_SSH_MODE", "offline");
        }
        let error = tmux_session_exists("dev:tw-term-probe".to_string())
            .expect_err("offline host must not look like a missing session");
        assert!(error.contains("Operation timed out"), "{error}");

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_MODE", original_mode);
        restore_env("HOME", original_home);
    }

    #[test]
    fn kill_remote_plain_terminal_surfaces_transport_failure_but_allows_already_missing() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
case "${TW_FAKE_SSH_MODE:?}" in
  missing)
    printf "can't find session: tw-term-dead\n" >&2
    exit 1
    ;;
  offline)
    printf 'ssh: connect to host ssh-host port 22: No route to host\n' >&2
    exit 255
    ;;
esac
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_mode = std::env::var("TW_FAKE_SSH_MODE").ok();
        let original_home = std::env::var("HOME").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("HOME", temp.path());
        }
        save_hosts_config(&[HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        }])
        .expect("save hosts");

        unsafe {
            std::env::set_var("TW_FAKE_SSH_MODE", "offline");
        }
        let error = kill_legacy_plain_terminal("dev:tw-term-dead")
            .expect_err("transport failure must reach the caller");
        assert!(error.contains("No route to host"), "{error}");

        unsafe {
            std::env::set_var("TW_FAKE_SSH_MODE", "missing");
        }
        kill_legacy_plain_terminal("dev:tw-term-dead")
            .expect("already missing terminal remains idempotent");

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_MODE", original_mode);
        restore_env("HOME", original_home);
    }

    #[test]
    fn test_host_reports_remote_tw_version() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    if [ "$#" -gt 0 ]; then shift; fi
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"

case "$1" in
  *"'true'"*)
    exit 0
    ;;
  *"'tmux'"*"'-V'"*)
    printf 'tmux 3.4\n'
    exit 0
    ;;
  *"'tw'"*"'version'"*)
    printf '0.11.1\n'
    exit 0
    ;;
  *"'tw'"*"'rpc'"*"'capabilities'"*)
    printf '%s\n' '{"protocolVersion":1,"capabilities":["list","create-worktree","create-terminal","kill-session"]}'
    exit 0
    ;;
esac

printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
        }

        let status = test_host(AddHostArgs {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        })
        .expect("host status");

        assert!(status.reachable);
        assert!(status.tmux_available);
        assert!(status.tw_available);
        assert!(status.tw_compatible);
        assert_eq!(status.tw_version.as_deref(), Some("0.11.1"));
        assert_eq!(status.tw_error, None);

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
    }

    #[test]
    fn test_host_reports_missing_remote_tw_without_marking_ssh_down() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    if [ "$#" -gt 0 ]; then shift; fi
    break
  fi
  shift
done

case "$1" in
  *"'true'"*)
    exit 0
    ;;
  *"'tmux'"*"'-V'"*)
    printf 'tmux 3.4\n'
    exit 0
    ;;
  *"'tw'"*"'version'"*)
    printf 'tw: command not found\n' >&2
    exit 127
    ;;
esac

printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
        }

        let status = test_host(AddHostArgs {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        })
        .expect("host status");

        assert!(status.reachable);
        assert!(!status.tw_available);
        assert_eq!(status.tw_version, None);
        assert!(status
            .tw_error
            .as_deref()
            .unwrap_or_default()
            .contains("tw: command not found"));

        restore_env("PATH", original_path);
    }

    #[test]
    fn test_host_does_not_misreport_missing_tmux_as_ssh_offline() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then shift; if [ "$#" -gt 0 ]; then shift; fi; break; fi
  shift
done
case "$1" in
  *"'true'"*) exit 0 ;;
  *"'tmux'"*"'-V'"*) printf 'tmux: command not found\n' >&2; exit 127 ;;
  *"'tw'"*"'version'"*) printf '1.0.3\n'; exit 0 ;;
  *"'tw'"*"'rpc'"*"'capabilities'"*)
    printf '%s\n' '{"protocolVersion":1,"capabilities":["list","create-worktree","create-terminal","kill-session"]}'
    exit 0
    ;;
esac
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");
        let original_path = std::env::var("PATH").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
        }
        let status = test_host(AddHostArgs {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        })
        .expect("host status");
        assert!(status.reachable);
        assert!(!status.tmux_available);
        assert!(status
            .tmux_error
            .as_deref()
            .unwrap_or_default()
            .contains("tmux: command not found"));
        assert!(status.tw_available);
        assert!(status.tw_compatible);
        restore_env("PATH", original_path);
    }

    #[test]
    fn install_host_tw_uses_github_source_install() {
        let _guard = test_env_lock().lock().expect("lock");
        let temp = tempfile::tempdir().expect("tempdir");
        let bin_dir = temp.path().join("bin");
        let log_path = temp.path().join("ssh.log");
        fs::create_dir_all(&bin_dir).expect("bin dir");
        let ssh_path = bin_dir.join("ssh");
        fs::write(
            &ssh_path,
            r#"#!/bin/sh
log="${TW_FAKE_SSH_LOG:?}"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    if [ "$#" -gt 0 ]; then shift; fi
    break
  fi
  shift
done
printf '%s\n' "$*" >> "$log"

case "$1" in
  *"git clone --depth 1"*"npm link --prefix"*)
    printf 'installed\n'
    exit 0
    ;;
  *"'true'"*)
    exit 0
    ;;
  *"'tmux'"*"'-V'"*)
    printf 'tmux 3.4\n'
    exit 0
    ;;
  *"'tw'"*"'version'"*)
    printf '0.11.1\n'
    exit 0
    ;;
  *"'tw'"*"'rpc'"*"'capabilities'"*)
    printf '%s\n' '{"protocolVersion":1,"capabilities":["list","create-worktree","create-terminal","kill-session"]}'
    exit 0
    ;;
esac

printf 'unexpected remote command: %s\n' "$*" >&2
exit 12
"#,
        )
        .expect("ssh shim");
        let mut perms = fs::metadata(&ssh_path).expect("ssh metadata").permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&ssh_path, perms).expect("ssh executable");

        let original_path = std::env::var("PATH").ok();
        let original_log = std::env::var("TW_FAKE_SSH_LOG").ok();
        let original_home = std::env::var("HOME").ok();
        unsafe {
            std::env::set_var(
                "PATH",
                format!(
                    "{}:{}",
                    bin_dir.to_string_lossy(),
                    original_path.clone().unwrap_or_default()
                ),
            );
            std::env::set_var("TW_FAKE_SSH_LOG", &log_path);
            std::env::set_var("HOME", temp.path());
        }

        save_hosts_config(&[HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        }])
        .expect("save hosts");

        let status = install_host_tw_from_source(&find_host("dev").expect("configured host"))
            .expect("install remote tw");
        assert!(status.reachable);
        assert!(status.tw_available);
        assert_eq!(status.tw_version.as_deref(), Some("0.11.1"));

        let log = fs::read_to_string(&log_path).expect("ssh log");
        assert!(log.contains("git clone --depth 1"));
        assert!(log.contains("--branch \"$tag\""));
        assert!(log.contains("v1.0.3"));
        assert!(log.contains("https://github.com/Sskift/tmux-worktree.git"));
        assert!(log.contains("npm link --prefix"));

        restore_env("PATH", original_path);
        restore_env("TW_FAKE_SSH_LOG", original_log);
        restore_env("HOME", original_home);
    }

    #[test]
    fn test_parse_session_key() {
        // Local session (no colon)
        assert_eq!(parse_session_key("myproject"), (None, "myproject"));
        assert_eq!(parse_session_key("simple"), (None, "simple"));
        // Remote session (host:name)
        assert_eq!(
            parse_session_key("ssh-host1:myproject"),
            (Some("ssh-host1"), "myproject")
        );
        assert_eq!(
            parse_session_key("my-host:session-name"),
            (Some("my-host"), "session-name")
        );
        // Edge cases
        assert_eq!(parse_session_key("a:b:c"), (Some("a"), "b:c"));
    }

    #[test]
    fn ssh_host_validation_blocks_option_injection_and_control_characters() {
        let valid = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "2001:db8::42".to_string(),
            user: Some("alice".to_string()),
            port: Some(2222),
            identity_file: Some("/Users/alice/SSH Keys/dev key".to_string()),
            worktree_base: Some("~/worktrees".to_string()),
            tmux_path: Some("~/.local/bin/tmux".to_string()),
            tw_path: Some("~/.local/bin/tw".to_string()),
        };
        validate_ssh_host_fields(&valid).expect("valid SSH endpoint");

        for (host, expected) in [
            (
                {
                    let mut host = valid.clone();
                    host.id = "LOCAL".to_string();
                    host
                },
                "reserved for the local control plane",
            ),
            (
                {
                    let mut host = valid.clone();
                    host.id = "bad/id".to_string();
                    host
                },
                "host id may contain only",
            ),
            (
                {
                    let mut host = valid.clone();
                    host.host = "-oProxyCommand=/usr/bin/false".to_string();
                    host
                },
                "host target cannot start",
            ),
            (
                {
                    let mut host = valid.clone();
                    host.host = "alice@ssh-host".to_string();
                    host
                },
                "must not include a user",
            ),
            (
                {
                    let mut host = valid.clone();
                    host.host = "ssh host".to_string();
                    host
                },
                "whitespace or control",
            ),
            (
                {
                    let mut host = valid.clone();
                    host.user = Some("-oProxyCommand=/usr/bin/false".to_string());
                    host
                },
                "SSH user cannot start",
            ),
            (
                {
                    let mut host = valid.clone();
                    host.user = Some("alice@example".to_string());
                    host
                },
                "SSH user cannot contain '@'",
            ),
            (
                {
                    let mut host = valid.clone();
                    host.identity_file = Some("-Fmalicious-config".to_string());
                    host
                },
                "identity file cannot start",
            ),
            (
                {
                    let mut host = valid.clone();
                    host.identity_file = Some("/tmp/key\n-oProxyCommand=bad".to_string());
                    host
                },
                "identity file cannot contain control",
            ),
        ] {
            let error = validate_ssh_host_fields(&host).expect_err("unsafe SSH endpoint");
            assert!(error.contains(expected), "{error}");
        }
    }

    #[test]
    fn host_compatibility_requires_the_canonical_close_capability() {
        let complete =
            ["list", "create-worktree", "create-terminal", "kill-session"].map(str::to_string);
        assert!(tw_rpc_capabilities_compatible(1, &complete));
        assert!(!tw_rpc_capabilities_compatible(2, &complete));
        assert!(!tw_rpc_capabilities_compatible(
            1,
            &["list", "create-worktree", "create-terminal"].map(str::to_string),
        ));
    }

    #[test]
    fn ssh_scp_and_relay_forward_end_options_before_the_destination() {
        let host = HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "ssh-host".to_string(),
            user: Some("alice".to_string()),
            port: Some(2222),
            identity_file: Some("/tmp/dev key".to_string()),
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        };
        let args = |command: &std::process::Command| {
            command
                .get_args()
                .map(|arg| arg.to_string_lossy().to_string())
                .collect::<Vec<_>>()
        };

        let ssh = ssh_command(&host, &["true"]).expect("ssh command");
        let ssh_args = args(&ssh);
        let ssh_separator = ssh_args.iter().position(|arg| arg == "--").expect("ssh --");
        assert_eq!(
            ssh_args.get(ssh_separator + 1).map(String::as_str),
            Some("ssh-host")
        );
        assert!(ssh_args.windows(2).any(|pair| pair == ["-l", "alice"]));
        assert!(!ssh_args.iter().any(|arg| arg == "alice@ssh-host"));

        let scp = scp_cli_command(
            &host,
            Path::new("/tmp/tw-cli.js"),
            ".tmux-worktree/tw-cli.js",
        )
        .expect("scp command");
        let scp_args = args(&scp);
        let scp_separator = scp_args.iter().position(|arg| arg == "--").expect("scp --");
        assert_eq!(
            scp_args.get(scp_separator + 1).map(String::as_str),
            Some("/tmp/tw-cli.js")
        );
        assert_eq!(
            scp_args.get(scp_separator + 2).map(String::as_str),
            Some("alice@ssh-host:.tmux-worktree/tw-cli.js")
        );

        let relay = mobile_relay_ssh_forward_command(&host, "127.0.0.1", 8787)
            .expect("relay forward command");
        let relay_args = args(&relay);
        let relay_separator = relay_args
            .iter()
            .position(|arg| arg == "--")
            .expect("relay --");
        assert_eq!(
            relay_args.get(relay_separator + 1).map(String::as_str),
            Some("ssh-host")
        );
        assert!(relay_args.windows(2).any(|pair| pair == ["-l", "alice"]));
        assert!(!relay_args.iter().any(|arg| arg == "alice@ssh-host"));
    }

    #[test]
    fn unsafe_ssh_host_is_rejected_before_config_replacement_or_probe() {
        let _guard = test_env_lock().lock().expect("lock");
        let original_home = std::env::var("HOME").ok();
        let original_dashboard_home = std::env::var("TW_DASHBOARD_HOME").ok();
        let temp = tempfile::tempdir().expect("tempdir");
        unsafe {
            std::env::set_var("HOME", temp.path());
            std::env::set_var("TW_DASHBOARD_HOME", temp.path());
        }
        let config_path = temp.path().join(".tmux-worktree.json");
        fs::write(&config_path, r#"{"projects":{"app":"/repo/app"}}"#).expect("seed config");
        let before = fs::read(&config_path).expect("config before");
        let malicious = HostConfig {
            id: "bad".to_string(),
            label: "Bad".to_string(),
            host: "-oProxyCommand=/usr/bin/false".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        };
        let save_error = save_hosts_config(&[malicious]).expect_err("unsafe config must fail");
        assert!(
            save_error.contains("host target cannot start"),
            "{save_error}"
        );
        assert_eq!(fs::read(&config_path).expect("config after"), before);

        let probe_result = test_host(AddHostArgs {
            id: "bad".to_string(),
            label: "Bad".to_string(),
            host: "-oProxyCommand=/usr/bin/false".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        });
        let probe_error = match probe_result {
            Ok(_) => panic!("unsafe probe must fail before spawning ssh"),
            Err(error) => error,
        };
        assert!(
            probe_error.contains("host target cannot start"),
            "{probe_error}"
        );

        restore_env("TW_DASHBOARD_HOME", original_dashboard_home);
        restore_env("HOME", original_home);
    }

    #[test]
    fn hosts_from_config_accepts_string_and_object_shorthand() {
        let hosts = hosts_from_config(&serde_json::json!({
            "remoteHosts": [
                "ssh-host",
                { "id": "gpu", "hostname": "gpu-host" }
            ]
        }));

        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].id, "ssh-host");
        assert_eq!(hosts[0].label, "ssh-host");
        assert_eq!(hosts[0].host, "ssh-host");
        assert_eq!(hosts[1].id, "gpu");
        assert_eq!(hosts[1].label, "gpu");
        assert_eq!(hosts[1].host, "gpu-host");
    }

    #[test]
    fn add_host_args_accepts_missing_optional_fields() {
        let args = serde_json::from_value::<AddHostArgs>(serde_json::json!({
            "id": "remote-dev",
            "label": "remote-dev",
            "host": "remote-dev"
        }))
        .expect("deserialize add host args");

        assert_eq!(args.id, "remote-dev");
        assert_eq!(args.port, None);
        assert_eq!(args.user, None);
        assert_eq!(args.identity_file, None);
        assert_eq!(args.worktree_base, None);
        assert_eq!(args.tmux_path, None);
        assert_eq!(args.tw_path, None);
    }

    #[test]
    fn atomic_write_failure_preserves_existing_file_and_cleans_temp() {
        let temp = tempfile::tempdir().expect("tempdir");
        let path = temp.path().join("state.json");
        fs::write(&path, "old state").expect("write old state");

        let error = atomic_write_file_with(&path, b"new state", |temp_path| {
            assert_eq!(temp_path.parent(), path.parent());
            assert_eq!(fs::read(temp_path).expect("read synced temp"), b"new state");
            assert_eq!(
                fs::metadata(temp_path)
                    .expect("temp metadata")
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
            Err("injected failure before rename".to_string())
        })
        .expect_err("injected failure");

        assert!(error.contains("injected failure before rename"));
        assert_eq!(
            fs::read_to_string(&path).expect("old state intact"),
            "old state"
        );
        let leftovers = fs::read_dir(temp.path())
            .expect("read tempdir")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
            .count();
        assert_eq!(leftovers, 0);
    }

    #[test]
    fn terminal_registry_save_is_atomic_private_and_releases_shared_lock() {
        let _guard = test_env_lock().lock().expect("lock");
        let original_home = std::env::var("HOME").ok();
        let original_dashboard_home = std::env::var("TW_DASHBOARD_HOME").ok();
        let temp = tempfile::tempdir().expect("tempdir");
        unsafe {
            std::env::set_var("HOME", temp.path());
            std::env::set_var("TW_DASHBOARD_HOME", temp.path());
        }

        let terminals = vec![serde_json::json!({
            "id": "term-v2-test",
            "label": "shell",
            "cwd": "/repo/app",
            "tmuxName": "tw-term-a1b2c",
            "rawName": "tw-term-a1b2c",
            "managed": true
        })];
        save_terminals(terminals.clone()).expect("save terminal registry");
        assert_eq!(load_terminals().expect("load terminal registry"), terminals);
        let registry = temp.path().join(".tw-dashboard-terminals.json");
        assert_eq!(
            fs::metadata(&registry)
                .expect("registry metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert!(!temp
            .path()
            .join(".tw-dashboard-terminals.json.lock")
            .exists());
        assert_eq!(
            fs::read_dir(temp.path())
                .expect("read registry directory")
                .filter_map(Result::ok)
                .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp-"))
                .count(),
            0
        );

        restore_env("TW_DASHBOARD_HOME", original_dashboard_home);
        restore_env("HOME", original_home);
    }

    #[test]
    fn stale_config_lock_owner_cannot_release_the_replacement_lock() {
        let _guard = test_env_lock().lock().expect("lock");
        let original_home = std::env::var("HOME").ok();
        let original_dashboard_home = std::env::var("TW_DASHBOARD_HOME").ok();
        let temp = tempfile::tempdir().expect("tempdir");
        unsafe {
            std::env::set_var("HOME", temp.path());
            std::env::set_var("TW_DASHBOARD_HOME", temp.path());
        }

        let first = acquire_dashboard_config_file_lock().expect("first config lock");
        let lock_path = first.path.clone();
        let stale_record = DashboardConfigLockOwner {
            owner: first.owner.clone(),
            created_at: 0,
        };
        fs::write(
            lock_path.join("owner.json"),
            serde_json::to_vec(&stale_record).expect("serialize stale owner"),
        )
        .expect("make first owner stale");

        let second = acquire_dashboard_config_file_lock().expect("replacement config lock");
        assert_ne!(first.owner, second.owner);
        drop(first);

        assert!(
            lock_path.is_dir(),
            "old guard must not remove replacement lock"
        );
        let current = read_dashboard_config_lock_owner(&lock_path).expect("replacement owner");
        assert_eq!(current.owner, second.owner);

        drop(second);
        assert!(!lock_path.exists(), "current owner releases its own lock");
        restore_env("TW_DASHBOARD_HOME", original_dashboard_home);
        restore_env("HOME", original_home);
    }

    #[test]
    fn update_host_is_transactional_preserves_other_config_and_is_idempotent() {
        let _guard = test_env_lock().lock().expect("lock");
        let original_home = std::env::var("HOME").ok();
        let original_dashboard_home = std::env::var("TW_DASHBOARD_HOME").ok();
        let temp = tempfile::tempdir().expect("tempdir");
        unsafe {
            std::env::set_var("HOME", temp.path());
            std::env::set_var("TW_DASHBOARD_HOME", temp.path());
        }
        let config_path = temp.path().join(".tmux-worktree.json");
        fs::write(
            &config_path,
            serde_json::to_string_pretty(&serde_json::json!({
                "projects": {
                    "dashboard": { "path": "/repo/dashboard" }
                },
                "mobileRelay": {
                    "relayUrl": "wss://relay.example.test",
                    "secret": "keep-me"
                },
                "hosts": [
                    {
                        "id": "builder",
                        "label": "Old builder",
                        "host": "old.example.test",
                        "user": "old-user",
                        "worktreeBase": "/old/worktrees",
                        "tmuxPath": "/old/tmux",
                        "twPath": "/old/tw",
                        "futureHostField": { "mode": "keep" }
                    },
                    {
                        "id": "spare",
                        "label": "Spare",
                        "host": "spare.example.test"
                    }
                ]
            }))
            .expect("serialize initial config"),
        )
        .expect("write initial config");

        let args = || UpdateHostArgs {
            id: "builder".to_string(),
            label: "  Build host  ".to_string(),
            host: "  builder.example.test  ".to_string(),
            user: Some("  alice  ".to_string()),
            port: Some(2222),
            identity_file: Some("  ~/keys/builder  ".to_string()),
            worktree_base: Some("  ~/worktrees  ".to_string()),
            tmux_path: Some("  ~/.local/bin/tmux  ".to_string()),
            tw_path: Some("  ~/.local/bin/tw  ".to_string()),
        };

        let hosts = update_host_config(args()).expect("update host");
        let builder = hosts
            .iter()
            .find(|host| host.id == "builder")
            .expect("updated builder");
        assert_eq!(builder.label, "Build host");
        assert_eq!(builder.host, "builder.example.test");
        assert_eq!(builder.user.as_deref(), Some("alice"));
        assert_eq!(builder.port, Some(2222));
        assert_eq!(
            builder.identity_file.as_deref(),
            Some(temp.path().join("keys/builder").to_string_lossy().as_ref())
        );
        assert_eq!(builder.worktree_base.as_deref(), Some("~/worktrees"));
        assert_eq!(builder.tmux_path.as_deref(), Some("~/.local/bin/tmux"));
        assert_eq!(builder.tw_path.as_deref(), Some("~/.local/bin/tw"));
        assert!(hosts.iter().any(|host| host.id == "spare"));

        let saved: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&config_path).expect("read updated config"))
                .expect("parse updated config");
        assert_eq!(saved["projects"]["dashboard"]["path"], "/repo/dashboard");
        assert_eq!(saved["mobileRelay"]["secret"], "keep-me");
        assert_eq!(saved["hosts"][0]["futureHostField"]["mode"], "keep");

        let first_write = fs::read(&config_path).expect("first update bytes");
        assert_eq!(
            fs::metadata(&config_path)
                .expect("config metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        update_host_config(args()).expect("repeat update");
        assert_eq!(
            fs::read(&config_path).expect("second update bytes"),
            first_write
        );

        let cleared = update_host_config(UpdateHostArgs {
            id: "builder".to_string(),
            label: "Build host".to_string(),
            host: "builder.example.test".to_string(),
            user: Some(" ".to_string()),
            port: None,
            identity_file: None,
            worktree_base: Some("".to_string()),
            tmux_path: None,
            tw_path: Some("  ".to_string()),
        })
        .expect("clear optional host fields");
        let builder = cleared
            .iter()
            .find(|host| host.id == "builder")
            .expect("cleared builder");
        assert_eq!(builder.user, None);
        assert_eq!(builder.port, None);
        assert_eq!(builder.identity_file, None);
        assert_eq!(builder.worktree_base, None);
        assert_eq!(builder.tmux_path, None);
        assert_eq!(builder.tw_path, None);

        restore_env("TW_DASHBOARD_HOME", original_dashboard_home);
        restore_env("HOME", original_home);
    }

    #[test]
    fn update_host_rejects_missing_and_duplicate_stable_ids_without_writing() {
        let _guard = test_env_lock().lock().expect("lock");
        let original_home = std::env::var("HOME").ok();
        let original_dashboard_home = std::env::var("TW_DASHBOARD_HOME").ok();
        let temp = tempfile::tempdir().expect("tempdir");
        unsafe {
            std::env::set_var("HOME", temp.path());
            std::env::set_var("TW_DASHBOARD_HOME", temp.path());
        }
        let config_path = temp.path().join(".tmux-worktree.json");
        let host_value = serde_json::json!({
            "id": "builder",
            "label": "Builder",
            "host": "builder.example.test"
        });
        fs::write(
            &config_path,
            serde_json::to_string_pretty(&serde_json::json!({
                "other": { "preserved": true },
                "hosts": [host_value.clone()]
            }))
            .expect("serialize config"),
        )
        .expect("write config");
        let missing_before = fs::read(&config_path).expect("missing before");

        let missing = update_host_config(UpdateHostArgs {
            id: "missing".to_string(),
            label: "Missing".to_string(),
            host: "missing.example.test".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        })
        .expect_err("missing id must fail");
        assert_eq!(missing, "host id 'missing' not found");
        assert_eq!(
            fs::read(&config_path).expect("missing after"),
            missing_before
        );

        fs::write(
            &config_path,
            serde_json::to_string_pretty(&serde_json::json!({
                "other": { "preserved": true },
                "hosts": [host_value.clone(), host_value]
            }))
            .expect("serialize duplicate config"),
        )
        .expect("write duplicate config");
        let duplicate_before = fs::read(&config_path).expect("duplicate before");
        let duplicate = update_host_config(UpdateHostArgs {
            id: "builder".to_string(),
            label: "Builder".to_string(),
            host: "builder.example.test".to_string(),
            user: None,
            port: None,
            identity_file: None,
            worktree_base: None,
            tmux_path: None,
            tw_path: None,
        })
        .expect_err("duplicate id must fail");
        assert_eq!(duplicate, "host id 'builder' is duplicated in config");
        assert_eq!(
            fs::read(&config_path).expect("duplicate after"),
            duplicate_before
        );

        restore_env("TW_DASHBOARD_HOME", original_dashboard_home);
        restore_env("HOME", original_home);
    }

    #[test]
    fn update_host_invalidates_only_its_cached_status() {
        let state = HostState::default();
        let status = |id: &str| CachedHostStatus {
            status: HostStatus {
                id: id.to_string(),
                label: id.to_string(),
                reachable: true,
                latency_ms: Some(1),
                error: None,
                tmux_available: true,
                tmux_version: Some("tmux 3.5a".to_string()),
                tmux_error: None,
                tw_available: true,
                tw_version: Some("1.0.3".to_string()),
                tw_error: None,
                tw_protocol_version: Some(1),
                tw_capabilities: vec!["list".to_string(), "create-worktree".to_string()],
                tw_compatible: true,
            },
            checked_at: Instant::now(),
        };
        {
            let mut statuses = state.statuses.lock().expect("cache lock");
            statuses.insert("builder".to_string(), status("builder"));
            statuses.insert("spare".to_string(), status("spare"));
        }

        invalidate_host_status_cache(&state, "builder").expect("invalidate builder");

        let statuses = state.statuses.lock().expect("cache lock");
        assert!(!statuses.contains_key("builder"));
        assert!(statuses.contains_key("spare"));
    }

    #[test]
    fn remove_then_readd_same_host_id_never_reuses_cached_status() {
        let _guard = test_env_lock().lock().expect("lock");
        let original_home = std::env::var("HOME").ok();
        let original_dashboard_home = std::env::var("TW_DASHBOARD_HOME").ok();
        let temp = tempfile::tempdir().expect("tempdir");
        unsafe {
            std::env::set_var("HOME", temp.path());
            std::env::set_var("TW_DASHBOARD_HOME", temp.path());
        }
        let config_path = temp.path().join(".tmux-worktree.json");
        fs::write(
            &config_path,
            serde_json::to_string_pretty(&serde_json::json!({
                "hosts": [{
                    "id": "builder",
                    "label": "Old builder",
                    "host": "old.example.test"
                }]
            }))
            .expect("serialize config"),
        )
        .expect("write config");

        let state = HostState::default();
        let stale_status = || CachedHostStatus {
            status: HostStatus {
                id: "builder".to_string(),
                label: "Old builder".to_string(),
                reachable: false,
                latency_ms: None,
                error: Some("stale failure".to_string()),
                tmux_available: false,
                tmux_version: None,
                tmux_error: None,
                tw_available: false,
                tw_version: None,
                tw_error: None,
                tw_protocol_version: None,
                tw_capabilities: vec![],
                tw_compatible: false,
            },
            checked_at: Instant::now(),
        };
        state
            .statuses
            .lock()
            .expect("cache lock")
            .insert("builder".to_string(), stale_status());

        let after_remove =
            remove_host_with_state(" builder ".to_string(), &state).expect("remove host");
        assert!(after_remove.iter().all(|host| host.id != "builder"));
        assert!(!state
            .statuses
            .lock()
            .expect("cache lock")
            .contains_key("builder"));

        state
            .statuses
            .lock()
            .expect("cache lock")
            .insert("builder".to_string(), stale_status());
        let after_add = add_host_with_state(
            AddHostArgs {
                id: " builder ".to_string(),
                label: " New builder ".to_string(),
                host: " new.example.test ".to_string(),
                user: Some(" alice ".to_string()),
                port: Some(2222),
                identity_file: Some(" ~/.ssh/builder ".to_string()),
                worktree_base: Some(" ~/worktrees ".to_string()),
                tmux_path: Some(" ~/.local/bin/tmux ".to_string()),
                tw_path: Some(" ~/.local/bin/tw ".to_string()),
            },
            &state,
        )
        .expect("re-add host");
        let builder = after_add
            .iter()
            .find(|host| host.id == "builder")
            .expect("new builder");
        assert_eq!(builder.label, "New builder");
        assert_eq!(builder.host, "new.example.test");
        assert_eq!(builder.user.as_deref(), Some("alice"));
        assert_eq!(builder.port, Some(2222));
        assert_eq!(builder.worktree_base.as_deref(), Some("~/worktrees"));
        assert_eq!(builder.tmux_path.as_deref(), Some("~/.local/bin/tmux"));
        assert_eq!(builder.tw_path.as_deref(), Some("~/.local/bin/tw"));
        assert!(!state
            .statuses
            .lock()
            .expect("cache lock")
            .contains_key("builder"));

        restore_env("TW_DASHBOARD_HOME", original_dashboard_home);
        restore_env("HOME", original_home);
    }

    #[test]
    fn layout_schema_migration_backup_is_created_once_and_save_is_idempotent() {
        let _guard = test_env_lock().lock().expect("lock");
        let original_home = std::env::var("HOME").ok();
        let original_dashboard_home = std::env::var("TW_DASHBOARD_HOME").ok();
        let temp = tempfile::tempdir().expect("tempdir");
        unsafe {
            std::env::set_var("HOME", temp.path());
            std::env::set_var("TW_DASHBOARD_HOME", temp.path());
        }
        let path = temp.path().join(".tw-dashboard-layout.json");
        let legacy = serde_json::json!({
            "left": 240,
            "selection": { "kind": "session", "name": "dashboard" }
        });
        let legacy_text = serde_json::to_string_pretty(&legacy).expect("serialize legacy");
        fs::write(&path, &legacy_text).expect("write legacy layout");

        let first_v2 = serde_json::json!({
            "schemaVersion": 2,
            "sidebar": { "width": 280 },
            "selection": { "kind": "session", "id": "local:dashboard" }
        });
        assert_eq!(layout_schema_version(&first_v2), 2);
        assert_eq!(
            layout_schema_version(&serde_json::json!({ "version": 2 })),
            2
        );
        save_layout(first_v2.clone()).expect("save migrated layout");
        let backup_path = layout_backup_path(&path, 1);
        assert_eq!(
            backup_path.file_name().and_then(|name| name.to_str()),
            Some(".tw-dashboard-layout.v1.backup.json")
        );
        assert_eq!(
            fs::read_to_string(&backup_path).expect("read migration backup"),
            legacy_text
        );
        let backup_once = fs::read(&backup_path).expect("backup bytes");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &fs::read_to_string(&path).expect("read v2 layout")
            )
            .expect("parse v2 layout"),
            first_v2
        );

        let updated_v2 = serde_json::json!({
            "schemaVersion": 2,
            "sidebar": { "width": 300 },
            "selection": { "kind": "session", "id": "local:dashboard" }
        });
        save_layout(updated_v2.clone()).expect("repeat v2 save");
        save_layout(updated_v2.clone()).expect("idempotent v2 save");
        assert_eq!(
            fs::read(&backup_path).expect("backup unchanged"),
            backup_once
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(
                &fs::read_to_string(&path).expect("read updated v2")
            )
            .expect("parse updated v2"),
            updated_v2
        );

        fs::write(&path, "{ invalid layout").expect("write malformed layout");
        let malformed_before = fs::read(&path).expect("malformed before");
        let error = save_layout(serde_json::json!({ "schemaVersion": 3 }))
            .expect_err("malformed source must block migration");
        assert!(error.contains("parse layout for backup"));
        assert_eq!(fs::read(&path).expect("malformed after"), malformed_before);

        restore_env("TW_DASHBOARD_HOME", original_dashboard_home);
        restore_env("HOME", original_home);
    }

    #[test]
    fn ssh_config_aliases_are_candidates_not_auto_connected_hosts() {
        let hosts = ssh_host_candidates_from_config_text(
            r#"
Host oncall-host
  HostName 192.0.2.10
  User alice

Host ssh-host
  HostName 192.0.2.11
  User alice

Host github.com
  HostName github.com
  User git
"#,
        );

        let ids = hosts
            .iter()
            .map(|host| host.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["oncall-host", "ssh-host"]);
        assert!(hosts_from_config(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn load_hosts_does_not_auto_connect_ssh_config_aliases() {
        let _guard = test_env_lock().lock().unwrap();
        let original_home = std::env::var("HOME").ok();
        let original_tw_home = std::env::var("TW_DASHBOARD_HOME").ok();
        let temp = tempfile::tempdir().expect("tempdir");
        let ssh_dir = temp.path().join(".ssh");
        fs::create_dir_all(&ssh_dir).expect("mkdir .ssh");
        fs::write(
            ssh_dir.join("config"),
            r#"
Host ssh-host
  HostName 192.0.2.11
  User alice
"#,
        )
        .expect("write ssh config");
        unsafe {
            std::env::set_var("HOME", temp.path());
            std::env::set_var("TW_DASHBOARD_HOME", temp.path());
        }

        let hosts = load_hosts().expect("load hosts");

        restore_env("TW_DASHBOARD_HOME", original_tw_home);
        restore_env("HOME", original_home);
        assert!(hosts.is_empty());
    }

    #[test]
    fn ssh_host_candidates_filter_non_machine_aliases() {
        let hosts = ssh_host_candidates_from_config_text(
            r#"
Host github.com
  User git
Host ssh-host gpu-box staging.example
  User dev
  Port 2200
Host *.example
  User ignored
Host build?
  User ignored
"#,
        );

        let ids = hosts
            .iter()
            .map(|host| host.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["ssh-host", "gpu-box", "staging.example"]);
        let gpu = hosts
            .iter()
            .find(|host| host.id == "gpu-box")
            .expect("gpu host");
        assert_eq!(gpu.user.as_deref(), Some("dev"));
        assert_eq!(gpu.port, Some(2200));
    }

    #[test]
    fn ssh_host_candidates_skip_git_jump_and_duplicate_root_entries() {
        let hosts = ssh_host_candidates_from_config_text(
            r#"
Host remote-dev
  HostName 192.0.2.10
  User alice

Host git.example.com
  HostName git.example.com
  Port 29418
  User alice

Host build-cloud
  HostName 192.0.2.12
  User alice

Host ssh-host
  HostName 192.0.2.11
  User alice

Host gpu-worker
  HostName 2605:340:cd51:7702:caa9:5514:509e:3464
  User tiger
  ProxyJump jump-proxy

Host gpu-worker-root
  HostName 2605:340:cd51:7702:caa9:5514:509e:3464
  User root
  ProxyJump jump-proxy

Host jump-proxy
  HostName jump.example.com
  User alice
"#,
        );

        let ids = hosts
            .iter()
            .map(|host| host.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            vec!["remote-dev", "build-cloud", "ssh-host", "gpu-worker"]
        );
    }

    #[test]
    fn mobile_relay_config_accepts_nested_and_flat_fields() {
        let nested = mobile_relay_config_from_value(&serde_json::json!({
            "mobileRelay": {
                "relayUrl": "wss://relay.example.net",
                "hostId": "macbook",
                "displayName": "Desk Mac",
                "secret": "token-1"
            }
        }));
        assert_eq!(nested.relay_url, "wss://relay.example.net");
        assert_eq!(nested.host_id, "macbook");
        assert_eq!(nested.display_name, "Desk Mac");
        assert_eq!(nested.secret, "token-1");

        let flat = mobile_relay_config_from_value(&serde_json::json!({
            "mobileRelayUrl": "wss://relay.example.org",
            "mobileRelayHostId": "laptop",
            "mobileRelaySecret": "token-2"
        }));
        assert_eq!(flat.relay_url, "wss://relay.example.org");
        assert_eq!(flat.host_id, "laptop");
        assert_eq!(flat.secret, "token-2");
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
}
