use crate::config::find_host;
use crate::features::control_plane::{bundled_cli_path, installed_tw_command, node_bin};
use crate::remote::{remote_tmux_cmd, remote_tw_cmd, run_remote_cmd_with_input};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

const PROTOCOL_VERSION: u64 = 1;
const MAX_RESPONSE_BYTES: usize = 384 * 1024;

pub(crate) struct TerminalControlState {
    process: Mutex<Option<Child>>,
    dashboard_instance_id: String,
}

impl TerminalControlState {
    pub(crate) fn new() -> Self {
        Self {
            process: Mutex::new(None),
            dashboard_instance_id: uuid::Uuid::new_v4().to_string(),
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
    pub(crate) owner: Value,
    pub(crate) lease: Option<Value>,
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
        PtyControlStatus {
            controlled: true,
            read_only: !owned_here,
            state: self.last_state.clone(),
            owner_kind: self.last_owner_kind.clone(),
            can_take_over: !owned_here
                && self.last_state == "HELD"
                && matches!(self.last_owner_kind.as_deref(), Some("feishu")),
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
        self.lease = Some(lease);
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

fn decode_response(body: &Value, response: &[u8]) -> Result<Value, TerminalControlCallError> {
    let decoded: Value =
        serde_json::from_slice(response).map_err(|error| TerminalControlCallError {
            code: "UNAVAILABLE".to_string(),
            message: format!("decode terminal-control response: {error}"),
        })?;
    if decoded.get("protocolVersion").and_then(Value::as_u64) != Some(PROTOCOL_VERSION)
        || decoded.get("requestId") != body.get("requestId")
    {
        return Err(TerminalControlCallError {
            code: "UNAVAILABLE".to_string(),
            message: "terminal-control response envelope mismatch".to_string(),
        });
    }
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

fn send_remote(host_id: &str, body: &Value) -> Result<Value, TerminalControlCallError> {
    let host = find_host(host_id).map_err(|message| TerminalControlCallError {
        code: "UNAVAILABLE".to_string(),
        message,
    })?;
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
    command.push_str(&remote_tw_cmd(&host));
    command.push_str(" terminal-control request");
    let mut frame = serde_json::to_vec(body).map_err(|error| TerminalControlCallError {
        code: "INTERNAL".to_string(),
        message: format!("encode terminal-control request: {error}"),
    })?;
    frame.push(b'\n');
    let output =
        run_remote_cmd_with_input(&host, &["sh", "-c", &command], &frame).map_err(|message| {
            TerminalControlCallError {
                code: "UNAVAILABLE".to_string(),
                message: format!("remote terminal-control on {}: {message}", host.label),
            }
        })?;
    if !output.status.success() {
        return Err(TerminalControlCallError {
            code: "UNAVAILABLE".to_string(),
            message: format!(
                "remote terminal-control on {} exited {}: {}",
                host.label,
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        });
    }
    if output.stdout.len() > MAX_RESPONSE_BYTES || !output.stdout.ends_with(b"\n") {
        return Err(TerminalControlCallError {
            code: "UNAVAILABLE".to_string(),
            message: format!(
                "remote terminal-control on {} returned a missing or oversized response",
                host.label
            ),
        });
    }
    decode_response(body, &output.stdout)
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
        return send_remote(host_id, &body);
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
        owner,
        lease: None,
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
    let (resolved_state, resolved_owner) = resolved
        .get("ownership")
        .map(ownership_fields)
        .unwrap_or_else(|| ("FREE".to_string(), None));
    control.last_state = resolved_state;
    control.last_owner_kind = resolved_owner;
    let Some(target_id) = control.control_target_id.clone() else {
        control.last_error = Some("terminal-control resolve returned no target ID".to_string());
        return control;
    };
    match call_terminal_control(
        app,
        state,
        host_id,
        "lease.acquire",
        json!({ "controlTargetId": target_id, "owner": control.owner }),
    ) {
        Ok(value) => match dashboard_lease_from_result(&value, &target_id, &control.owner) {
            Ok(lease) => {
                control.lease = Some(lease);
                let (current_state, current_owner) = ownership_fields(&value);
                control.last_state = current_state;
                control.last_owner_kind = current_owner;
            }
            Err(error) => control.last_error = Some(error.to_string()),
        },
        Err(error) => {
            control.last_error = Some(error.to_string());
            if error.code == "PERMISSION_DENIED" {
                control.last_state = "HELD".to_string();
            }
        }
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
        control.pending_handoff_id = None;
        let _ = call_terminal_control(
            app,
            state,
            control.host_id.as_deref(),
            "lease.release",
            json!({ "lease": lease }),
        );
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

pub(crate) fn resize_pty_control(
    app: &tauri::AppHandle,
    state: &TerminalControlState,
    control: &mut PtyControl,
    cols: u16,
    rows: u16,
) -> Result<(), TerminalControlCallError> {
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
    if let Err(error) = &result {
        control.lease = None;
        control.last_error = Some(error.to_string());
    }
    result.map(|_| ())
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
            let owns_target = control.last_owner_kind.as_deref() == Some("dashboard")
                && control.last_state == "HELD";
            if !owns_target {
                control.lease = None;
            } else if control.lease.is_none() {
                let _ = acquire_pty_control(app, state, control);
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
    fn terminal_control_socket_checks_correlation_and_preserves_permission_errors() {
        let _guard = ENV_LOCK.lock().unwrap();
        let path = PathBuf::from(format!(
            "/tmp/tw-terminal-control-rust-{}.sock",
            uuid::Uuid::new_v4()
        ));
        let listener = UnixListener::bind(&path).unwrap();
        std::env::set_var("TW_TERMINAL_CONTROL_SOCKET", &path);
        let server = std::thread::spawn(move || {
            for index in 0..2 {
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
                } else {
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
            owner,
            lease: None,
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
