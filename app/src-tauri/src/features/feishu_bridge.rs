use super::{
    refresh_pty_control_status, with_pty_control, PtyControl, PtyState, TerminalControlState,
};
use crate::features::control_plane::{resolve_local_tw_rpc_runtime, LocalTwRpcRuntime};
use crate::support::app_home_dir;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::State;

const PROTOCOL_VERSION: u32 = 1;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const START_ATTEMPTS: usize = 80;
const START_RETRY_DELAY: Duration = Duration::from_millis(100);

#[derive(Default)]
pub(crate) struct FeishuBridgeRuntimeState {
    process: Mutex<Option<Child>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeishuBindingInput {
    chat_id: String,
    chat_name: String,
    session_name: String,
    created_by: String,
    #[serde(default)]
    allowed_sender_ids: Vec<String>,
    #[serde(default = "default_true")]
    mention_only: bool,
    attachment_id: Option<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeResponse {
    protocol_version: u32,
    request_id: String,
    ok: bool,
    result: Option<Value>,
    error: Option<BridgeError>,
}

#[derive(Deserialize)]
struct BridgeError {
    code: String,
    message: String,
}

fn socket_path() -> Result<PathBuf, String> {
    let home = app_home_dir().ok_or("home dir not found")?;
    let preferred = home.join(".tmux-worktree").join("feishu-bridge-v1.sock");
    if preferred.to_string_lossy().as_bytes().len() <= 100 {
        return Ok(preferred);
    }
    let digest = Sha256::digest(home.to_string_lossy().as_bytes());
    let suffix = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(std::env::temp_dir()
        .join(format!("tw-feishu-bridge-{suffix}"))
        .join("v1.sock"))
}

fn runtime_command(runtime: &LocalTwRpcRuntime) -> Command {
    match runtime {
        LocalTwRpcRuntime::Bundled { node, cli } => {
            let mut command = Command::new(node);
            command.arg(cli);
            command
        }
        LocalTwRpcRuntime::Installed { tw } => Command::new(tw),
    }
}

fn ensure_server(app: &tauri::AppHandle, state: &FeishuBridgeRuntimeState) -> Result<(), String> {
    if UnixStream::connect(socket_path()?).is_ok() {
        return Ok(());
    }
    let mut process = state.process.lock().unwrap();
    if process
        .as_mut()
        .and_then(|child| child.try_wait().ok())
        .flatten()
        .is_some()
    {
        *process = None;
    }
    if process.is_none() {
        let home = app_home_dir().ok_or("home dir not found")?;
        let runtime = resolve_local_tw_rpc_runtime(app, &home)?;
        let mut command = runtime_command(&runtime);
        command
            .args(["feishu-bridge", "serve"])
            .env("HOME", &home)
            .env("TW_DASHBOARD_HOME", &home)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        *process = Some(
            command
                .spawn()
                .map_err(|error| format!("spawn Feishu bridge: {error}"))?,
        );
    }
    for _ in 0..START_ATTEMPTS {
        if UnixStream::connect(socket_path()?).is_ok() {
            return Ok(());
        }
        if process
            .as_mut()
            .and_then(|child| child.try_wait().ok())
            .flatten()
            .is_some()
        {
            *process = None;
        }
        std::thread::sleep(START_RETRY_DELAY);
    }
    Err("FEISHU_BRIDGE_UNAVAILABLE: bridge did not become ready".to_string())
}

fn request(operation: &str, params: Value) -> Result<Value, String> {
    let path = socket_path()?;
    let mut stream = UnixStream::connect(&path).map_err(|error| {
        format!(
            "FEISHU_BRIDGE_UNAVAILABLE: connect {}: {error}",
            path.display()
        )
    })?;
    stream
        .set_read_timeout(Some(REQUEST_TIMEOUT))
        .map_err(|error| format!("set Feishu bridge read timeout: {error}"))?;
    stream
        .set_write_timeout(Some(REQUEST_TIMEOUT))
        .map_err(|error| format!("set Feishu bridge write timeout: {error}"))?;
    let request_id = format!("dashboard_{}", uuid::Uuid::new_v4().simple());
    let body = serde_json::to_vec(&json!({
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "operation": operation,
        "params": params,
    }))
    .map_err(|error| format!("serialize Feishu bridge request: {error}"))?;
    stream
        .write_all(&body)
        .and_then(|_| stream.write_all(b"\n"))
        .map_err(|error| format!("write Feishu bridge request: {error}"))?;
    let mut line = String::new();
    BufReader::new(stream)
        .read_line(&mut line)
        .map_err(|error| format!("read Feishu bridge response: {error}"))?;
    let response: BridgeResponse = serde_json::from_str(&line)
        .map_err(|error| format!("invalid Feishu bridge response: {error}"))?;
    if response.protocol_version != PROTOCOL_VERSION || response.request_id != request_id {
        return Err("Feishu bridge response correlation failed".to_string());
    }
    if !response.ok {
        let error = response.error.ok_or("Feishu bridge omitted error")?;
        return Err(format!("{}: {}", error.code, error.message));
    }
    response
        .result
        .ok_or("Feishu bridge omitted result".to_string())
}

struct BindingTarget {
    session_name: String,
    control_target_id: String,
}

fn binding_target(snapshot: &Value, binding_id: &str) -> Result<BindingTarget, String> {
    let bindings = snapshot
        .get("bindings")
        .and_then(Value::as_array)
        .ok_or("Feishu bridge snapshot omitted bindings")?;
    let mut matches = bindings
        .iter()
        .filter(|binding| binding.get("id").and_then(Value::as_str) == Some(binding_id));
    let binding = matches
        .next()
        .ok_or_else(|| "Feishu binding was not found".to_string())?;
    if matches.next().is_some() {
        return Err("Feishu bridge returned duplicate binding identities".to_string());
    }
    let session_name = binding
        .get("sessionName")
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && !value.bytes().any(|byte| matches!(byte, 0 | b'\r' | b'\n'))
        })
        .ok_or("Feishu binding has an invalid sessionName")?
        .to_string();
    let control_target_id = binding
        .get("controlTargetId")
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && !value.bytes().any(|byte| matches!(byte, 0 | b'\r' | b'\n'))
        })
        .ok_or("Feishu binding has an invalid controlTargetId")?
        .to_string();
    Ok(BindingTarget {
        session_name,
        control_target_id,
    })
}

fn ensure_binding_matches_pty(control: &PtyControl, target: &BindingTarget) -> Result<(), String> {
    control.ensure_local_transfer_target(&target.session_name)?;
    if control.control_target_id.as_deref() != Some(target.control_target_id.as_str()) {
        return Err("Feishu binding targets a different canonical terminal".to_string());
    }
    Ok(())
}

fn refresh_after_transfer_attempt(
    app: &tauri::AppHandle,
    control_state: &TerminalControlState,
    control: &mut PtyControl,
) {
    control.clear_dashboard_lease_after_transfer_attempt();
    let _ = refresh_pty_control_status(app, control_state, control);
}

#[tauri::command]
pub(crate) fn feishu_bridge_status(
    app: tauri::AppHandle,
    state: State<'_, Arc<FeishuBridgeRuntimeState>>,
) -> Result<Value, String> {
    ensure_server(&app, state.inner().as_ref())?;
    request("bridge.snapshot", json!({}))
}

#[tauri::command]
pub(crate) fn feishu_groups_list(
    app: tauri::AppHandle,
    state: State<'_, Arc<FeishuBridgeRuntimeState>>,
) -> Result<Value, String> {
    ensure_server(&app, state.inner().as_ref())?;
    request("groups.list", json!({}))
}

#[tauri::command]
pub(crate) fn feishu_binding_create(
    app: tauri::AppHandle,
    state: State<'_, Arc<FeishuBridgeRuntimeState>>,
    pty_state: State<'_, Arc<PtyState>>,
    control_state: State<'_, Arc<TerminalControlState>>,
    args: FeishuBindingInput,
) -> Result<Value, String> {
    ensure_server(&app, state.inner().as_ref())?;
    let allowed_sender_ids = if args.allowed_sender_ids.is_empty() {
        vec![args.created_by.clone()]
    } else {
        args.allowed_sender_ids
    };
    let params = json!({
        "chatId": args.chat_id,
        "chatName": args.chat_name,
        "sessionName": args.session_name,
        "createdBy": args.created_by,
        "allowedSenderIds": allowed_sender_ids,
        "mentionOnly": args.mention_only,
    });
    let pty_id = args
        .attachment_id
        .ok_or("Feishu Dashboard binding requires a controlled PTY attachment")?;
    with_pty_control(pty_state.inner().as_ref(), &pty_id, |control| {
        control.ensure_local_transfer_target(&args.session_name)?;
        let dashboard_lease = control.current_dashboard_lease()?;
        let mut params = params;
        params
            .as_object_mut()
            .ok_or("binding.create params are invalid")?
            .insert("dashboardLease".to_string(), dashboard_lease);
        let result = request("binding.create", params);
        refresh_after_transfer_attempt(&app, control_state.inner().as_ref(), control);
        result
    })
}

#[tauri::command]
pub(crate) fn feishu_binding_pause(
    app: tauri::AppHandle,
    state: State<'_, Arc<FeishuBridgeRuntimeState>>,
    binding_id: String,
    force: bool,
) -> Result<Value, String> {
    ensure_server(&app, state.inner().as_ref())?;
    request(
        "binding.pause",
        json!({ "bindingId": binding_id, "force": force }),
    )
}

#[tauri::command]
pub(crate) fn feishu_binding_resume(
    app: tauri::AppHandle,
    state: State<'_, Arc<FeishuBridgeRuntimeState>>,
    binding_id: String,
) -> Result<Value, String> {
    ensure_server(&app, state.inner().as_ref())?;
    request("binding.resume", json!({ "bindingId": binding_id }))
}

#[tauri::command]
pub(crate) fn feishu_binding_repair(
    app: tauri::AppHandle,
    state: State<'_, Arc<FeishuBridgeRuntimeState>>,
    binding_id: String,
) -> Result<Value, String> {
    ensure_server(&app, state.inner().as_ref())?;
    request("binding.repair", json!({ "bindingId": binding_id }))
}

#[tauri::command]
pub(crate) fn feishu_binding_remove(
    app: tauri::AppHandle,
    state: State<'_, Arc<FeishuBridgeRuntimeState>>,
    binding_id: String,
    force: bool,
) -> Result<Value, String> {
    ensure_server(&app, state.inner().as_ref())?;
    request(
        "binding.remove",
        json!({ "bindingId": binding_id, "force": force }),
    )
}

#[tauri::command]
pub(crate) fn feishu_binding_takeover(
    app: tauri::AppHandle,
    bridge_state: State<'_, Arc<FeishuBridgeRuntimeState>>,
    pty_state: State<'_, Arc<PtyState>>,
    control_state: State<'_, Arc<TerminalControlState>>,
    binding_id: String,
    pty_id: String,
    force: bool,
) -> Result<Value, String> {
    ensure_server(&app, bridge_state.inner().as_ref())?;
    with_pty_control(pty_state.inner().as_ref(), &pty_id, |control| {
        let target = binding_target(&request("bridge.snapshot", json!({}))?, &binding_id)?;
        ensure_binding_matches_pty(control, &target)?;
        let dashboard_owner_instance = control.dashboard_owner_instance()?;
        let result = request(
            "binding.takeover",
            json!({
                "bindingId": binding_id,
                "dashboardOwnerInstance": dashboard_owner_instance,
                "force": force,
            }),
        );
        match result {
            Ok(dashboard_lease) => {
                if let Err(error) = control.adopt_dashboard_lease(dashboard_lease.clone()) {
                    refresh_after_transfer_attempt(&app, control_state.inner().as_ref(), control);
                    return Err(error);
                }
                Ok(dashboard_lease)
            }
            Err(error) => {
                refresh_after_transfer_attempt(&app, control_state.inner().as_ref(), control);
                Err(error)
            }
        }
    })
}

#[tauri::command]
pub(crate) fn feishu_binding_return(
    app: tauri::AppHandle,
    bridge_state: State<'_, Arc<FeishuBridgeRuntimeState>>,
    pty_state: State<'_, Arc<PtyState>>,
    control_state: State<'_, Arc<TerminalControlState>>,
    binding_id: String,
    pty_id: String,
) -> Result<Value, String> {
    ensure_server(&app, bridge_state.inner().as_ref())?;
    with_pty_control(pty_state.inner().as_ref(), &pty_id, |control| {
        let target = binding_target(&request("bridge.snapshot", json!({}))?, &binding_id)?;
        ensure_binding_matches_pty(control, &target)?;
        let dashboard_lease = control.current_dashboard_lease()?;
        let result = request(
            "binding.return",
            json!({
                "bindingId": binding_id,
                "dashboardLease": dashboard_lease,
            }),
        );
        refresh_after_transfer_attempt(&app, control_state.inner().as_ref(), control);
        result
    })
}
