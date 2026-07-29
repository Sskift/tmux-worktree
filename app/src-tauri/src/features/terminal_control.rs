use crate::config::find_host;
use crate::features::control_plane::{bundled_cli_path, installed_tw_command, node_bin};
use crate::features::now_rfc3339;
use crate::remote::{
    remote_tmux_cmd, remote_tw_cmd, spawn_remote_terminal_control_proxy, HostConfig,
    RemoteTerminalControlProxy,
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};
use std::time::{Duration, Instant};

const PROTOCOL_VERSION: u64 = 1;
const MAX_RESPONSE_BYTES: usize = 384 * 1024;
const REMOTE_PROXY_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, PartialEq, Eq)]
struct RemoteTerminalControlFingerprint {
    host: String,
    user: Option<String>,
    port: Option<u16>,
    identity_file: Option<String>,
    tw_path: Option<String>,
    tmux_path: Option<String>,
}

impl From<&HostConfig> for RemoteTerminalControlFingerprint {
    fn from(host: &HostConfig) -> Self {
        Self {
            host: host.host.clone(),
            user: host.user.clone(),
            port: host.port,
            identity_file: host.identity_file.clone(),
            tw_path: host.tw_path.clone(),
            tmux_path: host.tmux_path.clone(),
        }
    }
}

#[derive(Default)]
struct RemoteTerminalControlProxySlot {
    fingerprint: Option<RemoteTerminalControlFingerprint>,
    proxy: Option<RemoteTerminalControlProxy>,
}

type SharedRemoteTerminalControlProxySlot = Arc<Mutex<RemoteTerminalControlProxySlot>>;

pub(crate) struct TerminalControlState {
    process: Mutex<Option<Child>>,
    remote_proxies: Mutex<HashMap<String, SharedRemoteTerminalControlProxySlot>>,
    dashboard_instance_id: String,
}

impl TerminalControlState {
    pub(crate) fn new() -> Self {
        Self {
            process: Mutex::new(None),
            remote_proxies: Mutex::new(HashMap::new()),
            dashboard_instance_id: uuid::Uuid::new_v4().to_string(),
        }
    }

    fn remote_proxy_slot(&self, host_id: &str) -> SharedRemoteTerminalControlProxySlot {
        let mut proxies = self.remote_proxies.lock().unwrap();
        Arc::clone(
            proxies
                .entry(host_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(RemoteTerminalControlProxySlot::default()))),
        )
    }

    pub(crate) fn stop_remote_proxies(&self) {
        let slots = self
            .remote_proxies
            .lock()
            .unwrap()
            .drain()
            .map(|(_, slot)| slot)
            .collect::<Vec<_>>();
        for slot in slots {
            slot.lock().unwrap().proxy.take();
        }
    }

    pub(crate) fn dashboard_owner(&self, pty_id: &str) -> Value {
        json!({
            "kind": "dashboard",
            "instanceId": format!("dashboard:{}:{}", self.dashboard_instance_id, pty_id),
        })
    }
}

#[derive(Debug)]
pub(crate) struct TerminalControlCallError {
    pub(crate) code: String,
    pub(crate) message: String,
}

impl std::fmt::Display for TerminalControlCallError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

#[derive(Clone)]
pub(crate) struct PtyControl {
    pub(crate) session_name: String,
    pub(crate) host_id: Option<String>,
    pub(crate) control_target_id: Option<String>,
    pub(crate) control_epoch: Option<String>,
    pub(crate) owner: Value,
    pub(crate) lease: Option<Value>,
    pub(crate) desired_size: Option<(u16, u16)>,
    pub(crate) applied_size: Option<(u16, u16)>,
    pub(crate) next_operation: u64,
    pub(crate) pending_handoff_id: Option<String>,
    pub(crate) last_state: String,
    pub(crate) last_owner_kind: Option<String>,
    pub(crate) last_error: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PtyControlStatus {
    pub(crate) controlled: bool,
    pub(crate) read_only: bool,
    pub(crate) state: String,
    pub(crate) owner_kind: Option<String>,
    pub(crate) can_take_over: bool,
    pub(crate) can_recover: bool,
    pub(crate) message: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TerminalControlOwnerWire {
    kind: String,
    instance_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TerminalControlLeaseWire {
    control_target_id: String,
    control_epoch: String,
    lease_id: String,
    fence: String,
    owner: TerminalControlOwnerWire,
    expires_at: String,
}

fn valid_wire_token(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_len
        && !value.bytes().any(|byte| matches!(byte, 0 | b'\r' | b'\n'))
}

fn canonical_fence(value: &str) -> bool {
    value == "0"
        || (value.len() <= 32
            && value
                .as_bytes()
                .first()
                .is_some_and(|byte| matches!(byte, b'1'..=b'9'))
            && value.bytes().all(|byte| byte.is_ascii_digit()))
}

fn validated_dashboard_lease(
    value: &Value,
    expected_target_id: &str,
    expected_owner: &Value,
) -> Result<Value, TerminalControlCallError> {
    let lease: TerminalControlLeaseWire =
        serde_json::from_value(value.clone()).map_err(|error| TerminalControlCallError {
            code: "UNAVAILABLE".to_string(),
            message: format!("terminal-control returned an invalid lease: {error}"),
        })?;
    let expected_instance = expected_owner
        .get("instanceId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if lease.control_target_id != expected_target_id
        || lease.owner.kind != "dashboard"
        || lease.owner.instance_id != expected_instance
        || !valid_wire_token(&lease.control_target_id, 128)
        || !valid_wire_token(&lease.control_epoch, 128)
        || !valid_wire_token(&lease.lease_id, 128)
        || !canonical_fence(&lease.fence)
        || !valid_wire_token(&lease.owner.instance_id, 256)
        || !valid_wire_token(&lease.expires_at, 64)
    {
        return Err(TerminalControlCallError {
            code: "UNAVAILABLE".to_string(),
            message: "terminal-control returned a mismatched dashboard lease".to_string(),
        });
    }
    serde_json::to_value(lease).map_err(|error| TerminalControlCallError {
        code: "INTERNAL".to_string(),
        message: format!("normalize terminal-control lease: {error}"),
    })
}

fn dashboard_lease_from_result(
    value: &Value,
    expected_target_id: &str,
    expected_owner: &Value,
) -> Result<Value, TerminalControlCallError> {
    let lease = value.get("lease").ok_or_else(|| TerminalControlCallError {
        code: "UNAVAILABLE".to_string(),
        message: "terminal-control returned no lease".to_string(),
    })?;
    validated_dashboard_lease(lease, expected_target_id, expected_owner)
}

impl PtyControl {
    pub(crate) fn status(&self) -> PtyControlStatus {
        let owned_here = self.lease.is_some();
        let interactive_held = self.last_state == "HELD"
            && self.last_owner_kind.is_some()
            && self.last_owner_kind.as_deref() != Some("feishu");
        PtyControlStatus {
            controlled: true,
            // FREE is writable-on-demand: the first real input atomically
            // acquires the shared interactive lease. Dashboard, Relay/APK and
            // other controlled interactive adapters never make one another
            // read-only; only Feishu remains an exclusive input owner.
            read_only: !owned_here && self.last_state != "FREE" && !interactive_held,
            state: self.last_state.clone(),
            owner_kind: self.last_owner_kind.clone(),
            can_take_over: !owned_here
                && self.last_state == "HELD"
                && matches!(self.last_owner_kind.as_deref(), Some("feishu")),
            can_recover: !owned_here
                && self.last_state == "RECOVERY_REQUIRED"
                && self.control_target_id.is_some()
                && self.control_epoch.is_some(),
            message: self.last_error.clone(),
        }
    }

    pub(crate) fn operation_id(&mut self, kind: &str) -> String {
        self.next_operation = self.next_operation.saturating_add(1);
        format!(
            "dashboard:{}:{}:{}",
            self.owner
                .get("instanceId")
                .and_then(Value::as_str)
                .unwrap_or("unknown"),
            kind,
            self.next_operation
        )
    }

    pub(crate) fn dashboard_owner_instance(&self) -> Result<String, String> {
        self.owner
            .get("instanceId")
            .and_then(Value::as_str)
            .filter(|value| valid_wire_token(value, 256))
            .map(str::to_string)
            .ok_or_else(|| "Dashboard terminal control owner is invalid".to_string())
    }

    pub(crate) fn ensure_local_transfer_target(
        &self,
        expected_session: &str,
    ) -> Result<(), String> {
        if self.host_id.is_some() {
            return Err(
                "Feishu binding does not yet support a Dashboard terminal on an SSH host"
                    .to_string(),
            );
        }
        if self.session_name != expected_session {
            return Err("Dashboard PTY is attached to a different managed terminal".to_string());
        }
        if self.control_target_id.is_none() {
            return Err("Dashboard PTY has no canonical terminal control target".to_string());
        }
        Ok(())
    }

    pub(crate) fn current_dashboard_lease(&self) -> Result<Value, String> {
        let target_id = self
            .control_target_id
            .as_deref()
            .ok_or_else(|| "Dashboard terminal has no canonical controlTargetId".to_string())?;
        let lease = self
            .lease
            .as_ref()
            .ok_or_else(|| "Dashboard does not currently own terminal input".to_string())?;
        validated_dashboard_lease(lease, target_id, &self.owner).map_err(|error| error.to_string())
    }

    pub(crate) fn clear_dashboard_lease_after_transfer_attempt(&mut self) {
        self.lease = None;
        self.applied_size = None;
        self.pending_handoff_id = None;
        self.last_state = "RECOVERY_REQUIRED".to_string();
        self.last_owner_kind = None;
        self.last_error = Some(
            "terminal ownership transfer was submitted; refresh canonical status before writing"
                .to_string(),
        );
    }

    pub(crate) fn adopt_dashboard_lease(&mut self, lease: Value) -> Result<(), String> {
        let target_id = self
            .control_target_id
            .as_deref()
            .ok_or_else(|| "Dashboard terminal has no canonical controlTargetId".to_string())?;
        let lease = validated_dashboard_lease(&lease, target_id, &self.owner)
            .map_err(|error| error.to_string())?;
        self.control_epoch = lease
            .get("controlEpoch")
            .and_then(Value::as_str)
            .map(str::to_string);
        self.lease = Some(lease);
        self.applied_size = None;
        self.pending_handoff_id = None;
        self.last_state = "HELD".to_string();
        self.last_owner_kind = Some("dashboard".to_string());
        self.last_error = None;
        Ok(())
    }
}

fn socket_path() -> PathBuf {
    if let Some(path) =
        std::env::var_os("TW_TERMINAL_CONTROL_SOCKET").filter(|value| !value.is_empty())
    {
        return PathBuf::from(path);
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    let preferred = home.join(".tmux-worktree").join("terminal-control-v1.sock");
    if preferred.to_string_lossy().as_bytes().len() <= 100 {
        return preferred;
    }
    let digest = Sha256::digest(home.to_string_lossy().as_bytes());
    let suffix = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    std::env::temp_dir()
        .join(format!("tw-terminal-control-{suffix}"))
        .join("v1.sock")
}

fn decode_response_envelope(
    body: &Value,
    response: &[u8],
) -> Result<Value, TerminalControlCallError> {
    let decoded: Value =
        serde_json::from_slice(response).map_err(|error| TerminalControlCallError {
            code: "UNAVAILABLE".to_string(),
            message: format!("decode terminal-control response: {error}"),
        })?;
    let object = decoded.as_object();
    let ok = decoded.get("ok").and_then(Value::as_bool);
    let payload_matches = match ok {
        Some(true) => object.is_some_and(|object| {
            object.len() == 4 && object.contains_key("result") && !object.contains_key("error")
        }),
        Some(false) => object.is_some_and(|object| {
            let error = object.get("error").and_then(Value::as_object);
            object.len() == 4
                && !object.contains_key("result")
                && error.is_some_and(|error| {
                    error.len() == 3
                        && error.get("code").and_then(Value::as_str).is_some()
                        && error.get("message").and_then(Value::as_str).is_some()
                        && error.get("retryable").and_then(Value::as_bool).is_some()
                })
        }),
        None => false,
    };
    if decoded.get("protocolVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION)
        || decoded.get("requestId") != body.get("requestId")
        || !payload_matches
    {
        return Err(TerminalControlCallError {
            code: "UNAVAILABLE".to_string(),
            message: "terminal-control response envelope mismatch".to_string(),
        });
    }
    Ok(decoded)
}

fn decode_response_result(decoded: &Value) -> Result<Value, TerminalControlCallError> {
    if decoded.get("ok").and_then(Value::as_bool) == Some(false) {
        let error = decoded.get("error").and_then(Value::as_object);
        return Err(TerminalControlCallError {
            code: error
                .and_then(|value| value.get("code"))
                .and_then(Value::as_str)
                .unwrap_or("INTERNAL")
                .to_string(),
            message: error
                .and_then(|value| value.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("terminal-control rejected the request")
                .to_string(),
        });
    }
    decoded
        .get("result")
        .cloned()
        .ok_or_else(|| TerminalControlCallError {
            code: "UNAVAILABLE".to_string(),
            message: "terminal-control response has no result".to_string(),
        })
}

fn decode_response(body: &Value, response: &[u8]) -> Result<Value, TerminalControlCallError> {
    let decoded = decode_response_envelope(body, response)?;
    decode_response_result(&decoded)
}

fn send_once(body: &Value) -> Result<Value, TerminalControlCallError> {
    let path = socket_path();
    let mut stream = UnixStream::connect(&path).map_err(|error| TerminalControlCallError {
        code: "UNAVAILABLE".to_string(),
        message: format!("connect terminal-control {}: {error}", path.display()),
    })?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| TerminalControlCallError {
            code: "UNAVAILABLE".to_string(),
            message: format!("configure terminal-control read timeout: {error}"),
        })?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| TerminalControlCallError {
            code: "UNAVAILABLE".to_string(),
            message: format!("configure terminal-control write timeout: {error}"),
        })?;
    let frame = serde_json::to_vec(body).map_err(|error| TerminalControlCallError {
        code: "INTERNAL".to_string(),
        message: format!("encode terminal-control request: {error}"),
    })?;
    stream
        .write_all(&frame)
        .map_err(|error| TerminalControlCallError {
            code: "UNAVAILABLE".to_string(),
            message: format!("write terminal-control request: {error}"),
        })?;
    stream
        .write_all(b"\n")
        .map_err(|error| TerminalControlCallError {
            code: "UNAVAILABLE".to_string(),
            message: format!("finish terminal-control request: {error}"),
        })?;
    let mut reader = BufReader::new(stream);
    let mut response = Vec::new();
    reader
        .by_ref()
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_until(b'\n', &mut response)
        .map_err(|error| TerminalControlCallError {
            code: "UNAVAILABLE".to_string(),
            message: format!("read terminal-control response: {error}"),
        })?;
    if response.len() > MAX_RESPONSE_BYTES || !response.ends_with(b"\n") {
        return Err(TerminalControlCallError {
            code: "UNAVAILABLE".to_string(),
            message: "terminal-control response is missing or too large".to_string(),
        });
    }
    decode_response(body, &response)
}

fn remote_terminal_control_command(host: &HostConfig, mode: &str) -> String {
    let mut command = String::new();
    if host
        .tmux_path
        .as_deref()
        .is_some_and(|path| !path.trim().is_empty())
    {
        command.push_str("TW_TMUX=");
        command.push_str(&remote_tmux_cmd(&host));
        command.push(' ');
    }
    command.push_str(&remote_tw_cmd(host));
    command.push_str(" terminal-control ");
    command.push_str(mode);
    command
}

fn lock_remote_proxy_slot_until<'a>(
    slot: &'a Mutex<RemoteTerminalControlProxySlot>,
    deadline: Instant,
) -> Result<MutexGuard<'a, RemoteTerminalControlProxySlot>, TerminalControlCallError> {
    loop {
        match slot.try_lock() {
            Ok(slot) => return Ok(slot),
            Err(TryLockError::Poisoned(_)) => {
                return Err(TerminalControlCallError {
                    code: "INTERNAL".to_string(),
                    message: "remote terminal-control proxy lane is poisoned".to_string(),
                });
            }
            Err(TryLockError::WouldBlock) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(TerminalControlCallError {
                        code: "UNAVAILABLE".to_string(),
                        message: format!(
                            "remote terminal-control hard timeout after {} ms waiting for the host lane",
                            REMOTE_PROXY_REQUEST_TIMEOUT.as_millis()
                        ),
                    });
                }
                std::thread::sleep(remaining.min(Duration::from_millis(2)));
            }
        }
    }
}

fn send_remote(
    state: &TerminalControlState,
    host_id: &str,
    body: &Value,
) -> Result<Value, TerminalControlCallError> {
    let deadline = Instant::now() + REMOTE_PROXY_REQUEST_TIMEOUT;
    let request_id = body
        .get("requestId")
        .and_then(Value::as_str)
        .ok_or_else(|| TerminalControlCallError {
            code: "INTERNAL".to_string(),
            message: "terminal-control request has no requestId".to_string(),
        })?;
    let mut frame = serde_json::to_vec(body).map_err(|error| TerminalControlCallError {
        code: "INTERNAL".to_string(),
        message: format!("encode terminal-control request: {error}"),
    })?;
    frame.push(b'\n');
    if frame.len() > MAX_RESPONSE_BYTES {
        return Err(TerminalControlCallError {
            code: "INTERNAL".to_string(),
            message: "terminal-control request exceeds the frame limit".to_string(),
        });
    }

    let shared_slot = state.remote_proxy_slot(host_id);
    let mut slot = lock_remote_proxy_slot_until(&shared_slot, deadline)?;
    // Resolve the Host only after entering its serial lane. A config edit while
    // another request is in flight must not let this request reuse the old
    // endpoint snapshot after it finally reaches the head of the queue.
    let host = find_host(host_id).map_err(|message| TerminalControlCallError {
        code: "UNAVAILABLE".to_string(),
        message,
    })?;
    let fingerprint = RemoteTerminalControlFingerprint::from(&host);
    if slot.fingerprint.as_ref() != Some(&fingerprint) {
        slot.proxy.take();
        slot.fingerprint = Some(fingerprint);
    }
    if slot.proxy.as_mut().is_some_and(|proxy| !proxy.is_usable()) {
        slot.proxy.take();
    }
    if slot.proxy.is_none() {
        let command = remote_terminal_control_command(&host, "proxy");
        slot.proxy = Some(
            spawn_remote_terminal_control_proxy(&host, &["sh", "-c", &command], MAX_RESPONSE_BYTES)
                .map_err(|message| TerminalControlCallError {
                    code: "UNAVAILABLE".to_string(),
                    message: format!(
                        "start remote terminal-control proxy on {}: {message}",
                        host.label
                    ),
                })?,
        );
    }
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        slot.proxy.take();
        return Err(TerminalControlCallError {
            code: "UNAVAILABLE".to_string(),
            message: format!(
                "remote terminal-control hard timeout after {} ms",
                REMOTE_PROXY_REQUEST_TIMEOUT.as_millis()
            ),
        });
    }
    let response = match slot
        .proxy
        .as_mut()
        .expect("proxy initialized above")
        .request(&frame, request_id, remaining)
    {
        Ok(response) => response,
        Err(message) => {
            slot.proxy.take();
            return Err(TerminalControlCallError {
                code: "UNAVAILABLE".to_string(),
                message: format!("remote terminal-control on {}: {message}", host.label),
            });
        }
    };
    let decoded = match decode_response_envelope(body, &response) {
        Ok(decoded) => decoded,
        Err(error) => {
            slot.proxy.take();
            return Err(error);
        }
    };
    decode_response_result(&decoded)
}

fn request(kind: &str, fields: Value) -> Value {
    let mut object = fields.as_object().cloned().unwrap_or_default();
    object.insert("protocolVersion".to_string(), json!(PROTOCOL_VERSION));
    object.insert(
        "requestId".to_string(),
        json!(uuid::Uuid::new_v4().to_string()),
    );
    object.insert("type".to_string(), json!(kind));
    Value::Object(object)
}

fn server_is_ready() -> bool {
    send_once(&request("ping", json!({}))).is_ok()
}

fn spawn_server(app: &tauri::AppHandle) -> Result<Child, String> {
    let mut failures = Vec::new();
    if let Some(cli) = bundled_cli_path(app) {
        if let Some(node) = node_bin() {
            let cli_arg = cli.to_string_lossy().to_string();
            match Command::new(&node)
                .args([cli_arg.as_str(), "terminal-control", "serve"])
                .env("TW_TERMINAL_CONTROL_CLI", &cli_arg)
                .process_group(0)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
            {
                Ok(child) => return Ok(child),
                Err(error) => failures.push(format!("spawn bundled terminal-control: {error}")),
            }
        } else {
            failures.push("Node.js not found for bundled CLI".to_string());
        }
    } else {
        failures.push("bundled CLI resource not found".to_string());
    }
    if let Some(tw) = installed_tw_command() {
        match Command::new(&tw)
            .args(["terminal-control", "serve"])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        {
            Ok(child) => return Ok(child),
            Err(error) => failures.push(format!("spawn installed terminal-control: {error}")),
        }
    }
    Err(format!(
        "failed to start terminal-control authority: {}",
        failures.join("; ")
    ))
}

fn ensure_server(
    app: &tauri::AppHandle,
    state: &TerminalControlState,
) -> Result<(), TerminalControlCallError> {
    if server_is_ready() {
        return Ok(());
    }
    let mut process = state.process.lock().unwrap();
    if let Some(child) = process.as_mut() {
        if matches!(child.try_wait(), Ok(None)) {
            drop(process);
            for _ in 0..80 {
                if server_is_ready() {
                    return Ok(());
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            return Err(TerminalControlCallError {
                code: "UNAVAILABLE".to_string(),
                message: "terminal-control process did not become ready".to_string(),
            });
        }
    }
    *process = Some(
        spawn_server(app).map_err(|message| TerminalControlCallError {
            code: "UNAVAILABLE".to_string(),
            message,
        })?,
    );
    drop(process);
    for _ in 0..80 {
        if server_is_ready() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Err(TerminalControlCallError {
        code: "UNAVAILABLE".to_string(),
        message: "terminal-control process did not become ready".to_string(),
    })
}

pub(crate) fn call_terminal_control(
    app: &tauri::AppHandle,
    state: &TerminalControlState,
    host_id: Option<&str>,
    kind: &str,
    fields: Value,
) -> Result<Value, TerminalControlCallError> {
    let body = request(kind, fields);
    if let Some(host_id) = host_id {
        return send_remote(state, host_id, &body);
    }
    ensure_server(app, state)?;
    send_once(&body)
}

fn ownership_fields(value: &Value) -> (String, Option<String>) {
    let ownership = value.get("ownership").unwrap_or(value);
    (
        ownership
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("RECOVERY_REQUIRED")
            .to_string(),
        ownership
            .get("ownerKind")
            .and_then(Value::as_str)
            .map(str::to_string),
    )
}

pub(crate) fn resolve_pty_control_target(
    app: &tauri::AppHandle,
    state: &TerminalControlState,
    session_name: &str,
    host_id: Option<&str>,
) -> Result<String, TerminalControlCallError> {
    let resolved = call_terminal_control(
        app,
        state,
        host_id,
        "target.resolve",
        json!({ "sessionName": session_name }),
    )?;
    resolved
        .get("controlTargetId")
        .and_then(Value::as_str)
        .filter(|value| valid_wire_token(value, 128))
        .map(str::to_string)
        .ok_or_else(|| TerminalControlCallError {
            code: "RECOVERY_REQUIRED".to_string(),
            message: "terminal-control resolve returned no target ID".to_string(),
        })
}

pub(crate) fn open_pty_control(
    app: &tauri::AppHandle,
    state: &TerminalControlState,
    pty_id: &str,
    session_name: &str,
    host_id: Option<&str>,
) -> PtyControl {
    let owner = state.dashboard_owner(pty_id);
    let mut control = PtyControl {
        session_name: session_name.to_string(),
        host_id: host_id.map(str::to_string),
        control_target_id: None,
        control_epoch: None,
        owner,
        lease: None,
        desired_size: None,
        applied_size: None,
        next_operation: 0,
        pending_handoff_id: None,
        last_state: "RECOVERY_REQUIRED".to_string(),
        last_owner_kind: None,
        last_error: None,
    };
    let resolved = match call_terminal_control(
        app,
        state,
        host_id,
        "target.resolve",
        json!({ "sessionName": session_name }),
    ) {
        Ok(value) => value,
        Err(error) => {
            control.last_error = Some(error.to_string());
            return control;
        }
    };
    control.control_target_id = resolved
        .get("controlTargetId")
        .and_then(Value::as_str)
        .filter(|value| valid_wire_token(value, 128))
        .map(str::to_string);
    control.control_epoch = resolved
        .get("controlEpoch")
        .and_then(Value::as_str)
        .filter(|value| valid_wire_token(value, 128))
        .map(str::to_string);
    let (resolved_state, resolved_owner) = resolved
        .get("ownership")
        .map(ownership_fields)
        .unwrap_or_else(|| ("FREE".to_string(), None));
    control.last_state = resolved_state;
    control.last_owner_kind = resolved_owner;
    if control.control_target_id.is_none() {
        control.last_error = Some("terminal-control resolve returned no target ID".to_string());
        return control;
    }
    if control.control_epoch.is_none() {
        control.last_error = Some("terminal-control resolve returned no control epoch".to_string());
        return control;
    }
    control
}

pub(crate) fn acquire_pty_control(
    app: &tauri::AppHandle,
    state: &TerminalControlState,
    control: &mut PtyControl,
) -> Result<Value, TerminalControlCallError> {
    if let Some(lease) = control.lease.clone() {
        return Ok(lease);
    }
    let target_id = control
        .control_target_id
        .clone()
        .ok_or_else(|| TerminalControlCallError {
            code: "RECOVERY_REQUIRED".to_string(),
            message: control
                .last_error
                .clone()
                .unwrap_or_else(|| "control target is unresolved".to_string()),
        })?;
    let value = call_terminal_control(
        app,
        state,
        control.host_id.as_deref(),
        "lease.acquire",
        json!({ "controlTargetId": target_id, "owner": control.owner }),
    )?;
    let lease = dashboard_lease_from_result(&value, &target_id, &control.owner)?;
    let (current_state, current_owner) = ownership_fields(&value);
    control.lease = Some(lease.clone());
    control.applied_size = None;
    control.pending_handoff_id = None;
    control.last_state = current_state;
    control.last_owner_kind = current_owner;
    control.last_error = None;
    Ok(lease)
}

pub(crate) fn release_pty_control(
    app: &tauri::AppHandle,
    state: &TerminalControlState,
    control: &mut PtyControl,
) {
    if let Some(lease) = control.lease.take() {
        control.applied_size = None;
        control.pending_handoff_id = None;
        match call_terminal_control(
            app,
            state,
            control.host_id.as_deref(),
            "lease.release",
            json!({ "lease": lease }),
        ) {
            Ok(value) => {
                let (current_state, current_owner) = ownership_fields(&value);
                control.last_state = current_state;
                control.last_owner_kind = current_owner;
                control.last_error = None;
            }
            Err(error) => {
                control.last_error = Some(error.to_string());
                control.last_state = if error.code == "TARGET_GONE" {
                    "TARGET_GONE".to_string()
                } else {
                    "RECOVERY_REQUIRED".to_string()
                };
                control.last_owner_kind = None;
            }
        }
        return;
    }
    let (Some(target_id), Some(handoff_id)) = (
        control.control_target_id.clone(),
        control.pending_handoff_id.take(),
    ) else {
        return;
    };
    let withdrawn = call_terminal_control(
        app,
        state,
        control.host_id.as_deref(),
        "handoff.withdraw",
        json!({
            "controlTargetId": target_id.clone(),
            "handoffId": handoff_id,
            "nextOwner": control.owner,
        }),
    );
    if withdrawn.is_err() {
        if let Ok(value) = call_terminal_control(
            app,
            state,
            control.host_id.as_deref(),
            "lease.acquire",
            json!({ "controlTargetId": target_id, "owner": control.owner }),
        ) {
            if let Some(lease) = value.get("lease").cloned() {
                let _ = call_terminal_control(
                    app,
                    state,
                    control.host_id.as_deref(),
                    "lease.release",
                    json!({ "lease": lease }),
                );
            }
        }
    }
}

pub(crate) fn write_pty_control(
    app: &tauri::AppHandle,
    state: &TerminalControlState,
    control: &mut PtyControl,
    data: &[u8],
) -> Result<(), TerminalControlCallError> {
    let lease = acquire_pty_control(app, state, control)?;
    apply_desired_pty_size(app, state, control)?;
    let operation_id = control.operation_id("input");
    let result = call_terminal_control(
        app,
        state,
        control.host_id.as_deref(),
        "input.raw",
        json!({
            "lease": lease,
            "operationId": operation_id,
            "pane": "0",
            "dataBase64": base64::engine::general_purpose::STANDARD.encode(data),
        }),
    );
    if let Err(error) = &result {
        if matches!(
            error.code.as_str(),
            "PERMISSION_DENIED"
                | "HANDOFF_PENDING"
                | "TARGET_GONE"
                | "RECOVERY_REQUIRED"
                | "OPERATION_IN_DOUBT"
                | "UNAVAILABLE"
                | "INTERNAL"
        ) {
            control.lease = None;
            control.applied_size = None;
        }
        if matches!(
            error.code.as_str(),
            "RECOVERY_REQUIRED" | "OPERATION_IN_DOUBT" | "UNAVAILABLE" | "INTERNAL"
        ) {
            control.last_state = "RECOVERY_REQUIRED".to_string();
            control.last_owner_kind = None;
        }
        control.last_error = Some(error.to_string());
    }
    result.map(|_| ())
}

pub(crate) fn scroll_pty_control(
    app: &tauri::AppHandle,
    state: &TerminalControlState,
    control: &mut PtyControl,
    direction: &str,
    lines: u16,
) -> Result<(), TerminalControlCallError> {
    if !matches!(direction, "up" | "down") || !(1..=100).contains(&lines) {
        return Err(TerminalControlCallError {
            code: "INVALID_REQUEST".to_string(),
            message: "terminal scroll input is invalid".to_string(),
        });
    }
    let lease = acquire_pty_control(app, state, control)?;
    apply_desired_pty_size(app, state, control)?;
    let operation_id = control.operation_id("scroll");
    let result = call_terminal_control(
        app,
        state,
        control.host_id.as_deref(),
        "input.scroll",
        json!({
            "lease": lease,
            "operationId": operation_id,
            "pane": "0",
            "direction": direction,
            "lines": lines,
        }),
    );
    if let Err(error) = &result {
        if matches!(
            error.code.as_str(),
            "PERMISSION_DENIED"
                | "HANDOFF_PENDING"
                | "TARGET_GONE"
                | "RECOVERY_REQUIRED"
                | "OPERATION_IN_DOUBT"
                | "UNAVAILABLE"
                | "INTERNAL"
        ) {
            control.lease = None;
            control.applied_size = None;
        }
        if matches!(
            error.code.as_str(),
            "RECOVERY_REQUIRED" | "OPERATION_IN_DOUBT" | "UNAVAILABLE" | "INTERNAL"
        ) {
            control.last_state = "RECOVERY_REQUIRED".to_string();
            control.last_owner_kind = None;
        }
        control.last_error = Some(error.to_string());
    }
    result.map(|_| ())
}

fn apply_desired_pty_size(
    app: &tauri::AppHandle,
    state: &TerminalControlState,
    control: &mut PtyControl,
) -> Result<(), TerminalControlCallError> {
    let Some((cols, rows)) = control.desired_size else {
        return Ok(());
    };
    if control.applied_size == Some((cols, rows)) {
        return Ok(());
    }
    let Some(lease) = control.lease.clone() else {
        return Ok(());
    };
    let operation_id = control.operation_id("resize");
    let result = call_terminal_control(
        app,
        state,
        control.host_id.as_deref(),
        "input.resize",
        json!({
            "lease": lease,
            "operationId": operation_id,
            "pane": "0",
            "cols": cols,
            "rows": rows,
        }),
    );
    match result {
        Ok(_) => {
            control.applied_size = Some((cols, rows));
            Ok(())
        }
        Err(error) => {
            control.lease = None;
            control.applied_size = None;
            control.last_error = Some(error.to_string());
            Err(error)
        }
    }
}

pub(crate) fn resize_pty_control(
    app: &tauri::AppHandle,
    state: &TerminalControlState,
    control: &mut PtyControl,
    cols: u16,
    rows: u16,
) -> Result<(), TerminalControlCallError> {
    control.desired_size = Some((cols, rows));
    if control.lease.is_some() {
        return apply_desired_pty_size(app, state, control);
    }
    if control.last_state != "FREE" {
        return Ok(());
    }

    // A read-only tmux attachment uses ignore-size, so resizing its PTY alone
    // cannot make the shared window match the visible Dashboard viewport.
    // When the target is still FREE, fence the real tmux resize with a short
    // Dashboard lease and release it immediately. A concurrent Feishu/local
    // owner wins at lease.acquire or input.resize; this path never bypasses
    // terminal-control and never leaves an observation-only PTY holding input.
    acquire_pty_control(app, state, control)?;
    let result = apply_desired_pty_size(app, state, control);
    if result.is_ok() {
        release_pty_control(app, state, control);
    }
    result
}

pub(crate) fn kill_pty_controlled_session(
    app: &tauri::AppHandle,
    state: &TerminalControlState,
    control: &mut PtyControl,
) -> Result<(), TerminalControlCallError> {
    let lease = acquire_pty_control(app, state, control)?;
    let operation_id = control.operation_id("lifecycle-kill");
    let result = call_terminal_control(
        app,
        state,
        control.host_id.as_deref(),
        "lifecycle.kill",
        json!({ "lease": lease, "operationId": operation_id }),
    );
    match result {
        Ok(_) => {
            control.lease = None;
            control.pending_handoff_id = None;
            control.last_state = "TARGET_GONE".to_string();
            control.last_owner_kind = None;
            control.last_error = None;
            Ok(())
        }
        Err(error) => {
            control.last_error = Some(error.to_string());
            Err(error)
        }
    }
}

pub(crate) fn refresh_pty_control_status(
    app: &tauri::AppHandle,
    state: &TerminalControlState,
    control: &mut PtyControl,
) -> PtyControlStatus {
    let Some(target_id) = control.control_target_id.clone() else {
        return control.status();
    };
    let refreshed = if let Some(lease) = control.lease.clone() {
        call_terminal_control(
            app,
            state,
            control.host_id.as_deref(),
            "lease.renew",
            json!({ "lease": lease }),
        )
    } else {
        call_terminal_control(
            app,
            state,
            control.host_id.as_deref(),
            "ownership.status",
            json!({ "controlTargetId": target_id }),
        )
    };
    match refreshed {
        Ok(value) => {
            if let Some(control_epoch) = value
                .get("controlEpoch")
                .and_then(Value::as_str)
                .filter(|value| valid_wire_token(value, 128))
            {
                control.control_epoch = Some(control_epoch.to_string());
            }
            if value.get("lease").is_some() {
                match dashboard_lease_from_result(&value, &target_id, &control.owner) {
                    Ok(lease) => control.lease = Some(lease),
                    Err(error) => {
                        control.last_error = Some(error.to_string());
                        control.last_state = "RECOVERY_REQUIRED".to_string();
                        control.last_owner_kind = None;
                        control.lease = None;
                        return control.status();
                    }
                }
            }
            let (current_state, current_owner) = ownership_fields(&value);
            control.last_state = current_state;
            control.last_owner_kind = current_owner;
            control.last_error = None;
            if value.get("lease").is_none() {
                // ownership.status is observation only. Another mounted PTY
                // (including one from this Dashboard) must never be treated as
                // this connection's lease, and FREE stays lazy-acquire.
                control.lease = None;
                control.applied_size = None;
            }
            if control.last_state != "DRAINING" {
                control.pending_handoff_id = None;
            }
        }
        Err(error) => {
            control.last_error = Some(error.to_string());
            control.last_state = if error.code == "TARGET_GONE" {
                "TARGET_GONE".to_string()
            } else {
                "RECOVERY_REQUIRED".to_string()
            };
            control.lease = None;
            control.applied_size = None;
        }
    }
    control.status()
}

pub(crate) fn recover_pty_control(
    app: &tauri::AppHandle,
    state: &TerminalControlState,
    control: &mut PtyControl,
) -> PtyControlStatus {
    // Recovery is an operator action, but the PTY may have cached an epoch or
    // state from before a controller restart. Refresh first so one click uses
    // the current canonical epoch instead of silently requiring a second try.
    let refreshed = refresh_pty_control_status(app, state, control);
    if refreshed.state != "RECOVERY_REQUIRED" || refreshed.message.is_some() {
        // A transport, response, or lease-validation failure is not proof of
        // canonical recovery state. Surface it without using a cached epoch to
        // force/fence an otherwise healthy target.
        return refreshed;
    }
    if control.lease.is_some() || control.last_state != "RECOVERY_REQUIRED" {
        control.last_error = Some(
            "local recovery is only available while terminal input continuity requires recovery"
                .to_string(),
        );
        return control.status();
    }
    let (Some(target_id), Some(control_epoch)) = (
        control.control_target_id.clone(),
        control.control_epoch.clone(),
    ) else {
        control.last_error = Some("terminal recovery identity is incomplete".to_string());
        return control.status();
    };
    let record_id = format!("dashboard-recovery:{}", uuid::Uuid::new_v4().simple());
    match call_terminal_control(
        app,
        state,
        control.host_id.as_deref(),
        "handoff.force",
        json!({
            "controlTargetId": target_id.clone(),
            "expectedControlEpoch": control_epoch,
            "nextOwner": control.owner,
            "proof": {
                "kind": "operator-acknowledged-in-doubt",
                "recordId": record_id,
                "recordedAt": now_rfc3339(),
            },
            "acknowledgeUncertainOperation": true,
        }),
    ) {
        Ok(value) => match dashboard_lease_from_result(&value, &target_id, &control.owner) {
            Ok(lease) => {
                if let Err(error) = control.adopt_dashboard_lease(lease) {
                    control.last_error = Some(error);
                }
            }
            Err(error) => control.last_error = Some(error.to_string()),
        },
        Err(error) => {
            let message = error.to_string();
            if error.code != "RECOVERY_REQUIRED" {
                let _ = refresh_pty_control_status(app, state, control);
            }
            // A successful refresh must not erase the reason the operator's
            // recovery attempt failed; the renderer surfaces this message.
            control.last_error = Some(message);
        }
    }
    control.status()
}

pub(crate) fn request_pty_control_takeover(
    app: &tauri::AppHandle,
    state: &TerminalControlState,
    control: &mut PtyControl,
) -> PtyControlStatus {
    let Some(target_id) = control.control_target_id.clone() else {
        return control.status();
    };
    match call_terminal_control(
        app,
        state,
        control.host_id.as_deref(),
        "handoff.begin",
        json!({ "controlTargetId": target_id, "nextOwner": control.owner }),
    ) {
        Ok(value) => {
            control.lease = match value.get("lease") {
                Some(_) => match dashboard_lease_from_result(&value, &target_id, &control.owner) {
                    Ok(lease) => Some(lease),
                    Err(error) => {
                        control.last_error = Some(error.to_string());
                        return control.status();
                    }
                },
                None => None,
            };
            if control.lease.is_some() {
                control.applied_size = None;
            }
            control.pending_handoff_id = value
                .get("ownership")
                .and_then(|ownership| ownership.get("handoffId"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let (current_state, current_owner) = ownership_fields(&value);
            control.last_state = current_state;
            control.last_owner_kind = current_owner;
            control.last_error = None;
        }
        Err(error) => {
            control.last_error = Some(error.to_string());
        }
    }
    control.status()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn recovery_timestamp_matches_the_canonical_terminal_control_contract() {
        let timestamp = now_rfc3339();
        assert_eq!(timestamp.len(), 24);
        assert_eq!(&timestamp[4..5], "-");
        assert_eq!(&timestamp[7..8], "-");
        assert_eq!(&timestamp[10..11], "T");
        assert_eq!(&timestamp[19..], ".000Z");
    }

    fn remote_host() -> HostConfig {
        HostConfig {
            id: "dev".to_string(),
            label: "Dev".to_string(),
            host: "devbox".to_string(),
            user: Some("alice".to_string()),
            port: Some(22),
            identity_file: Some("~/.ssh/dev".to_string()),
            worktree_base: Some("~/worktrees".to_string()),
            tmux_path: Some("~/.local/bin/tmux".to_string()),
            tw_path: Some("~/.local/bin/tw".to_string()),
        }
    }

    #[test]
    fn remote_proxy_fingerprint_covers_every_connection_and_command_field() {
        let host = remote_host();
        let expected = RemoteTerminalControlFingerprint::from(&host);
        let variants = [
            {
                let mut value = host.clone();
                value.host = "another-host".to_string();
                value
            },
            {
                let mut value = host.clone();
                value.user = Some("bob".to_string());
                value
            },
            {
                let mut value = host.clone();
                value.port = Some(2222);
                value
            },
            {
                let mut value = host.clone();
                value.identity_file = Some("~/.ssh/another".to_string());
                value
            },
            {
                let mut value = host.clone();
                value.tw_path = Some("~/bin/tw-next".to_string());
                value
            },
            {
                let mut value = host.clone();
                value.tmux_path = Some("~/bin/tmux-next".to_string());
                value
            },
        ];
        for variant in variants {
            assert_ne!(RemoteTerminalControlFingerprint::from(&variant), expected);
        }

        let mut presentation_only = host;
        presentation_only.label = "Renamed Dev".to_string();
        presentation_only.worktree_base = Some("~/other-worktrees".to_string());
        assert_eq!(
            RemoteTerminalControlFingerprint::from(&presentation_only),
            expected
        );
    }

    #[test]
    fn terminal_control_response_envelope_is_closed_and_correlated() {
        let body = json!({
            "protocolVersion": 1,
            "requestId": "outer-request",
            "type": "ping",
        });
        let invalid = [
            json!({
                "protocolVersion": 1,
                "requestId": "wrong-request",
                "ok": true,
                "result": {},
            }),
            json!({
                "protocolVersion": 1,
                "requestId": "outer-request",
                "ok": true,
            }),
            json!({
                "protocolVersion": 1,
                "requestId": "outer-request",
                "ok": true,
                "result": {},
                "extra": true,
            }),
            json!({
                "protocolVersion": 1,
                "requestId": "outer-request",
                "ok": false,
                "error": { "code": "INTERNAL", "message": "bad" },
            }),
        ];
        for response in invalid {
            let encoded = format!("{response}\n");
            let error = decode_response_envelope(&body, encoded.as_bytes()).unwrap_err();
            assert_eq!(error.code, "UNAVAILABLE");
            assert_eq!(error.message, "terminal-control response envelope mismatch");
        }
    }

    #[test]
    fn remote_proxy_host_lane_wait_is_deadline_bounded() {
        let slot = Arc::new(Mutex::new(RemoteTerminalControlProxySlot::default()));
        let guard = slot.lock().unwrap();
        let waiting = Arc::clone(&slot);
        let started = Instant::now();
        let task = std::thread::spawn(move || {
            match lock_remote_proxy_slot_until(&waiting, Instant::now() + Duration::from_millis(30))
            {
                Ok(_) => panic!("locked host lane must not be acquired"),
                Err(error) => error,
            }
        });
        let error = task.join().unwrap();
        assert_eq!(error.code, "UNAVAILABLE");
        assert!(error.message.contains("hard timeout"));
        assert!(started.elapsed() < Duration::from_secs(1));
        drop(guard);
    }

    #[test]
    fn terminal_control_socket_checks_correlation_and_preserves_permission_errors() {
        let _guard = ENV_LOCK.lock().unwrap();
        let path = PathBuf::from(format!(
            "/tmp/tw-terminal-control-rust-{}.sock",
            uuid::Uuid::new_v4()
        ));
        let listener = UnixListener::bind(&path).unwrap();
        std::env::set_var("TW_TERMINAL_CONTROL_SOCKET", &path);
        let server = std::thread::spawn(move || {
            for index in 0..3 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut line = String::new();
                BufReader::new(stream.try_clone().unwrap())
                    .read_line(&mut line)
                    .unwrap();
                let request: Value = serde_json::from_str(line.trim()).unwrap();
                let response = if index == 0 {
                    json!({
                        "protocolVersion": 1,
                        "requestId": request["requestId"],
                        "ok": true,
                        "result": { "authority": "test" },
                    })
                } else if index == 1 {
                    json!({
                        "protocolVersion": 1,
                        "requestId": request["requestId"],
                        "ok": false,
                        "error": {
                            "code": "PERMISSION_DENIED",
                            "message": "owned by feishu",
                            "retryable": false,
                        },
                    })
                } else {
                    json!({
                        "protocolVersion": 1,
                        "requestId": "a-different-request",
                        "ok": true,
                        "result": { "authority": "must-not-be-accepted" },
                    })
                };
                stream
                    .write_all(format!("{}\n", response).as_bytes())
                    .unwrap();
            }
        });

        let first = request("ping", json!({}));
        assert_eq!(send_once(&first).unwrap()["authority"], "test");
        let second = request("ownership.status", json!({ "controlTargetId": "target" }));
        let error = send_once(&second).unwrap_err();
        assert_eq!(error.code, "PERMISSION_DENIED");
        assert_eq!(error.message, "owned by feishu");
        let third = request("ping", json!({}));
        let mismatch = send_once(&third).unwrap_err();
        assert_eq!(mismatch.code, "UNAVAILABLE");
        assert_eq!(
            mismatch.message,
            "terminal-control response envelope mismatch"
        );

        server.join().unwrap();
        std::env::remove_var("TW_TERMINAL_CONTROL_SOCKET");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn dashboard_transfer_seam_accepts_only_the_exact_closed_lease() {
        let owner = json!({
            "kind": "dashboard",
            "instanceId": "dashboard:instance:pty-one",
        });
        let lease = json!({
            "controlTargetId": "target-one",
            "controlEpoch": "epoch-one",
            "leaseId": "lease-one",
            "fence": "12",
            "owner": owner.clone(),
            "expiresAt": "2026-07-13T12:00:00.000Z",
        });
        let mut control = PtyControl {
            session_name: "tw-term-one".to_string(),
            host_id: None,
            control_target_id: Some("target-one".to_string()),
            control_epoch: Some("epoch-one".to_string()),
            owner,
            lease: None,
            desired_size: None,
            applied_size: None,
            next_operation: 0,
            pending_handoff_id: None,
            last_state: "FREE".to_string(),
            last_owner_kind: None,
            last_error: None,
        };

        control.ensure_local_transfer_target("tw-term-one").unwrap();
        assert_eq!(
            control.dashboard_owner_instance().unwrap(),
            "dashboard:instance:pty-one"
        );
        control.adopt_dashboard_lease(lease.clone()).unwrap();
        assert_eq!(control.current_dashboard_lease().unwrap(), lease);

        let mut unknown_field = lease.clone();
        unknown_field["unexpected"] = json!(true);
        assert!(control.adopt_dashboard_lease(unknown_field).is_err());
        let mut wrong_owner = lease.clone();
        wrong_owner["owner"]["instanceId"] = json!("dashboard:other:pty");
        assert!(control.adopt_dashboard_lease(wrong_owner).is_err());

        control.clear_dashboard_lease_after_transfer_attempt();
        assert!(control.current_dashboard_lease().is_err());
        assert_eq!(control.last_state, "RECOVERY_REQUIRED");
    }
}
