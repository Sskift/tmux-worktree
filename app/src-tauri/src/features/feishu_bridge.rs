use super::{
    acquire_pty_control, refresh_pty_control_status, with_pty_control, PtyControl, PtyState,
    TerminalControlState,
};
use crate::config::{acquire_dashboard_config_file_lock, dashboard_config_write_lock};
use crate::features::control_plane::{resolve_local_tw_rpc_runtime, LocalTwRpcRuntime};
use crate::support::{app_home_dir, atomic_write_file};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
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
const STOP_ATTEMPTS: usize = 200;
const START_RETRY_DELAY: Duration = Duration::from_millis(100);
const MAX_LARK_PROFILE_OUTPUT_BYTES: usize = 1024 * 1024;
const BASE_REQUIRED_BRIDGE_CAPABILITIES: [&str; 3] = [
    "binding.lifecycle-notices.v1",
    "binding.create.session-summary.v1",
    "binding.target-reconciliation.v1",
];
const REPLY_MODE_BRIDGE_CAPABILITY: &str = "binding.reply-mode.v1";
const ACTIVITY_COMPLETION_BRIDGE_CAPABILITY: &str = "binding.structured-agent-result.v1";
const STEERING_BRIDGE_CAPABILITY: &str = "binding.steering.v1";
const REMOVE_ORIGIN_BRIDGE_CAPABILITY: &str = "binding.remove-origin.v1";
const CONSUMER_HEALTH_BRIDGE_CAPABILITY: &str = "bridge.consumer-health.v1";
const DURABLE_REPLY_BRIDGE_CAPABILITY: &str = "reply.durable-payload.v1";
const UNKNOWN_BRIDGE_INFO_ERROR: &str = "BRIDGE_ERROR: unknown Feishu bridge operation";

#[derive(Default)]
pub(crate) struct FeishuBridgeRuntimeState {
    process: Mutex<Option<Child>>,
    transition: Mutex<()>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeishuBindingInput {
    chat_id: String,
    chat_name: String,
    session_name: String,
    session_summary: Option<String>,
    created_by: String,
    #[serde(default)]
    allowed_sender_ids: Vec<String>,
    #[serde(default = "default_true")]
    mention_only: bool,
    #[serde(default = "default_reply_mode")]
    reply_mode: String,
    attachment_id: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeishuLarkProfile {
    name: String,
    app_id: String,
    brand: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    active: bool,
    user: Option<String>,
    token_status: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeishuIntegrationStatus {
    selected_profile: Option<String>,
    profile_source: String,
    bridge_running: bool,
    profiles: Vec<FeishuLarkProfile>,
    profiles_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeishuAddProfileResult {
    status: FeishuIntegrationStatus,
    added_profile: String,
    warning: Option<String>,
}

struct LarkProfileAddOutcome {
    succeeded: bool,
    detail: Option<String>,
}

fn default_true() -> bool {
    true
}

fn default_reply_mode() -> String {
    "topic".to_string()
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BridgeInfo {
    daemon_version: String,
    lark_profile: String,
    capabilities: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BridgeProbeDisposition {
    Current,
    LegacyEmpty,
    LegacyOccupied,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FeishuReplyMode {
    Topic,
    Direct,
}

impl FeishuReplyMode {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "topic" => Ok(Self::Topic),
            "direct" => Ok(Self::Direct),
            _ => Err("replyMode must be either topic or direct".to_string()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Topic => "topic",
            Self::Direct => "direct",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LegacyBindingRemoveAction {
    UseLegacy,
    UpgradeCurrent,
    AlreadyRemoved,
}

#[derive(Debug)]
struct BridgeProbe {
    snapshot: Value,
    disposition: BridgeProbeDisposition,
    capabilities: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FeishuBridgeInstanceLock {
    pid: u32,
    started_at: u64,
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

fn instance_lock_path() -> Result<PathBuf, String> {
    let home = app_home_dir().ok_or("home dir not found")?;
    Ok(home.join(".tmux-worktree").join("feishu-bridge-v1.lock"))
}

fn valid_profile_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && !value.bytes().any(|byte| matches!(byte, 0 | b'\r' | b'\n'))
}

fn valid_lark_credential_field(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && !value.bytes().any(|byte| matches!(byte, 0 | b'\r' | b'\n'))
}

fn generated_lark_profile_name(app_id: &str, existing: &[FeishuLarkProfile]) -> String {
    let mut slug = String::new();
    let mut separator = false;
    for character in app_id.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
            separator = false;
        } else if !slug.is_empty() && !separator {
            slug.push('-');
            separator = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        slug.push_str("feishu-bot");
    }

    const MAX_GENERATED_PROFILE_BYTES: usize = 64;
    let mut base = format!("tw-{slug}");
    base.truncate(MAX_GENERATED_PROFILE_BYTES);
    while base.ends_with('-') {
        base.pop();
    }
    if !existing.iter().any(|profile| profile.name == base) {
        return base;
    }

    for collision in 2usize.. {
        let suffix = format!("-{collision}");
        let prefix_bytes = MAX_GENERATED_PROFILE_BYTES.saturating_sub(suffix.len());
        let mut candidate = base[..base.len().min(prefix_bytes)].to_string();
        while candidate.ends_with('-') {
            candidate.pop();
        }
        candidate.push_str(&suffix);
        if !existing.iter().any(|profile| profile.name == candidate) {
            return candidate;
        }
    }
    unreachable!("the generated lark-cli profile namespace is unbounded")
}

fn configured_profile_from_file() -> Result<Option<String>, String> {
    let home = app_home_dir().ok_or("home dir not found")?;
    let path = home.join(".tmux-worktree.json");
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|error| format!("read config: {error}"))?;
    let config: Value =
        serde_json::from_str(&text).map_err(|error| format!("parse config: {error}"))?;
    let root = config.as_object().ok_or("config root is not an object")?;
    let Some(feishu) = root.get("feishuBridge") else {
        return Ok(None);
    };
    let object = feishu
        .as_object()
        .ok_or("feishuBridge config is not an object")?;
    let Some(value) = object.get("larkProfile") else {
        return Ok(None);
    };
    let profile = value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("feishuBridge.larkProfile is not a non-empty string")?;
    if !valid_profile_name(profile) {
        return Err("feishuBridge.larkProfile is invalid".to_string());
    }
    Ok(Some(profile.to_string()))
}

fn effective_profile() -> Result<(Option<String>, String), String> {
    if let Some(profile) = std::env::var("TW_FEISHU_LARK_PROFILE")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        if !valid_profile_name(&profile) {
            return Err("TW_FEISHU_LARK_PROFILE is invalid".to_string());
        }
        return Ok((Some(profile), "environment".to_string()));
    }
    let profile = configured_profile_from_file()?;
    let source = if profile.is_some() { "config" } else { "none" };
    Ok((profile, source.to_string()))
}

fn lark_cli_error_message(stdout: &[u8], stderr: &[u8]) -> Option<String> {
    for bytes in [stdout, stderr] {
        if let Ok(value) = serde_json::from_slice::<Value>(bytes) {
            if let Some(message) = value
                .get("error")
                .and_then(Value::as_object)
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|message| !message.is_empty())
            {
                return Some(message.to_string());
            }
        }
    }
    for bytes in [stderr, stdout] {
        let message = String::from_utf8_lossy(bytes).trim().to_string();
        if !message.is_empty() {
            return Some(message);
        }
    }
    None
}

fn empty_lark_profile_config(message: &str) -> bool {
    message.contains("invalid config format: no apps: malformed config")
}

fn list_lark_profiles_raw() -> Result<Vec<FeishuLarkProfile>, String> {
    let output = Command::new("lark-cli")
        .args(["profile", "list"])
        .env("LARKSUITE_CLI_NO_UPDATE_NOTIFIER", "1")
        .env("LARKSUITE_CLI_NO_SKILLS_NOTIFIER", "1")
        .output()
        .map_err(|error| format!("run lark-cli profile list: {error}"))?;
    if output.stdout.len() > MAX_LARK_PROFILE_OUTPUT_BYTES
        || output.stderr.len() > MAX_LARK_PROFILE_OUTPUT_BYTES
    {
        return Err("lark-cli profile list output is too large".to_string());
    }
    if !output.status.success() {
        let message = lark_cli_error_message(&output.stdout, &output.stderr)
            .unwrap_or_else(|| "command failed without a diagnostic".to_string());
        if empty_lark_profile_config(&message) {
            return Ok(Vec::new());
        }
        return Err(format!("lark-cli profile list failed: {message}"));
    }
    let profiles: Vec<FeishuLarkProfile> = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("decode lark-cli profiles: {error}"))?;
    if profiles.iter().any(|profile| {
        !valid_profile_name(&profile.name)
            || profile.app_id.trim().is_empty()
            || profile.app_id.len() > 256
            || profile.brand.trim().is_empty()
            || profile.brand.len() > 64
    }) {
        return Err("lark-cli returned an invalid profile entry".to_string());
    }
    Ok(profiles)
}

fn lark_bot_display_name_with_program(
    program: &OsStr,
    profile: &FeishuLarkProfile,
) -> Result<String, String> {
    let language = if profile.brand == "lark" {
        "en_us"
    } else {
        "zh_cn"
    };
    let params = format!(r#"{{"lang":"{language}"}}"#);
    let output = Command::new(program)
        .args([
            "--profile",
            &profile.name,
            "api",
            "GET",
            "/open-apis/application/v6/applications/me",
            "--as",
            "bot",
            "--params",
            &params,
            "--json",
        ])
        .env("LARKSUITE_CLI_NO_UPDATE_NOTIFIER", "1")
        .env("LARKSUITE_CLI_NO_SKILLS_NOTIFIER", "1")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("read Feishu bot application info: {error}"))?;
    if output.stdout.len() > MAX_LARK_PROFILE_OUTPUT_BYTES
        || output.stderr.len() > MAX_LARK_PROFILE_OUTPUT_BYTES
    {
        return Err("Feishu bot application info is too large".to_string());
    }
    if !output.status.success() {
        let message = lark_cli_error_message(&output.stdout, &output.stderr)
            .unwrap_or_else(|| "command failed without a diagnostic".to_string());
        return Err(format!("read Feishu bot application info: {message}"));
    }
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("decode Feishu bot application info: {error}"))?;
    if value.get("ok").and_then(Value::as_bool) == Some(false) {
        let message = lark_cli_error_message(&output.stdout, &output.stderr)
            .unwrap_or_else(|| "application info request failed".to_string());
        return Err(format!("read Feishu bot application info: {message}"));
    }
    let display_name = value
        .pointer("/data/app/app_name")
        .or_else(|| value.pointer("/data/data/app/app_name"))
        .or_else(|| value.pointer("/app/app_name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty() && name.len() <= 256 && !name.chars().any(char::is_control))
        .ok_or("Feishu application info omitted the bot name")?;
    Ok(display_name.to_string())
}

fn list_lark_profiles() -> Result<Vec<FeishuLarkProfile>, String> {
    let mut profiles = list_lark_profiles_raw()?;
    for profile in &mut profiles {
        // The lark-cli profile key is an internal credential slot, not the
        // user-facing bot identity. Resolve the application name best-effort;
        // App ID remains the safe fallback when the API is unavailable.
        profile.display_name =
            lark_bot_display_name_with_program(OsStr::new("lark-cli"), profile).ok();
    }
    Ok(profiles)
}

fn add_lark_profile_with_program(
    program: &OsStr,
    name: &str,
    app_id: &str,
    app_secret: &str,
    brand: &str,
) -> Result<LarkProfileAddOutcome, String> {
    let mut child = Command::new(program)
        .args([
            "config",
            "init",
            "--name",
            name,
            "--app-id",
            app_id,
            "--brand",
            brand,
            "--app-secret-stdin",
        ])
        .env("LARKSUITE_CLI_NO_UPDATE_NOTIFIER", "1")
        .env("LARKSUITE_CLI_NO_SKILLS_NOTIFIER", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("run lark-cli config init: {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or("lark-cli app secret input is unavailable")?;
    stdin
        .write_all(app_secret.as_bytes())
        .map_err(|error| format!("write lark-cli app secret input: {error}"))?;
    drop(stdin);
    let output = child
        .wait_with_output()
        .map_err(|error| format!("wait for lark-cli config init: {error}"))?;
    if output.stdout.len() > MAX_LARK_PROFILE_OUTPUT_BYTES
        || output.stderr.len() > MAX_LARK_PROFILE_OUTPUT_BYTES
    {
        return Err("lark-cli config init output is too large".to_string());
    }
    let detail = lark_cli_error_message(&output.stdout, &output.stderr)
        .map(|message| message.replace(app_secret, "[redacted]"));
    Ok(LarkProfileAddOutcome {
        succeeded: output.status.success(),
        detail,
    })
}

fn remove_lark_profile_with_program(program: &OsStr, name: &str) -> Result<(), String> {
    let output = Command::new(program)
        .args(["profile", "remove", name])
        .env("LARKSUITE_CLI_NO_UPDATE_NOTIFIER", "1")
        .env("LARKSUITE_CLI_NO_SKILLS_NOTIFIER", "1")
        .stdin(Stdio::null())
        .output()
        .map_err(|error| format!("remove lark-cli profile: {error}"))?;
    if output.stdout.len() > MAX_LARK_PROFILE_OUTPUT_BYTES
        || output.stderr.len() > MAX_LARK_PROFILE_OUTPUT_BYTES
    {
        return Err("lark-cli profile remove output is too large".to_string());
    }
    if !output.status.success() {
        let message = lark_cli_error_message(&output.stdout, &output.stderr)
            .unwrap_or_else(|| "command failed without a diagnostic".to_string());
        return Err(format!("lark-cli profile remove failed: {message}"));
    }
    Ok(())
}

fn update_configured_profile(profile: Option<&str>, expected: Option<&str>) -> Result<(), String> {
    let home = app_home_dir().ok_or("home dir not found")?;
    let path = home.join(".tmux-worktree.json");
    let _guard = dashboard_config_write_lock()
        .lock()
        .map_err(|_| "dashboard config write lock poisoned".to_string())?;
    let _file_guard = acquire_dashboard_config_file_lock()?;
    let mut config: Value = if path.exists() {
        let text =
            std::fs::read_to_string(&path).map_err(|error| format!("read config: {error}"))?;
        serde_json::from_str(&text).map_err(|error| format!("parse config: {error}"))?
    } else {
        json!({})
    };
    let root = config
        .as_object_mut()
        .ok_or("config root is not an object")?;
    match profile {
        Some(profile) => {
            let feishu = root
                .entry("feishuBridge".to_string())
                .or_insert_with(|| json!({}));
            let object = feishu
                .as_object_mut()
                .ok_or("feishuBridge config is not an object")?;
            object.insert(
                "larkProfile".to_string(),
                Value::String(profile.to_string()),
            );
        }
        None => {
            let feishu = root
                .get_mut("feishuBridge")
                .ok_or("Feishu bot selection changed before deletion")?;
            let object = feishu
                .as_object_mut()
                .ok_or("feishuBridge config is not an object")?;
            let current = object
                .get("larkProfile")
                .and_then(Value::as_str)
                .map(str::trim);
            if current != expected {
                return Err("Feishu bot selection changed before deletion".to_string());
            }
            object.remove("larkProfile");
        }
    }
    let text = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("serialize config: {error}"))?;
    atomic_write_file(&path, format!("{text}\n").as_bytes())
        .map_err(|error| format!("write config: {error}"))
}

fn save_configured_profile(profile: &str) -> Result<(), String> {
    update_configured_profile(Some(profile), None)
}

fn clear_configured_profile(profile: &str) -> Result<(), String> {
    update_configured_profile(None, Some(profile))
}

fn bridge_is_running() -> bool {
    socket_path()
        .ok()
        .is_some_and(|path| UnixStream::connect(path).is_ok())
}

fn integration_status() -> Result<FeishuIntegrationStatus, String> {
    let (selected_profile, profile_source) = effective_profile()?;
    let bridge_running = selected_profile.is_some() && bridge_is_running();
    let (profiles, profiles_error) = match list_lark_profiles() {
        Ok(profiles) => (profiles, None),
        Err(error) => (Vec::new(), Some(error)),
    };
    Ok(FeishuIntegrationStatus {
        selected_profile,
        profile_source,
        bridge_running,
        profiles,
        profiles_error,
    })
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

fn bridge_snapshot_is_empty(snapshot: &Value) -> Result<bool, String> {
    let object = snapshot
        .as_object()
        .ok_or("FEISHU_BRIDGE_INCOMPATIBLE: bridge.snapshot is not an object")?;
    let bindings = object
        .get("bindings")
        .and_then(Value::as_array)
        .ok_or("FEISHU_BRIDGE_INCOMPATIBLE: bridge.snapshot omitted bindings")?;
    let active_turns = object
        .get("activeTurns")
        .and_then(Value::as_array)
        .ok_or("FEISHU_BRIDGE_INCOMPATIBLE: bridge.snapshot omitted activeTurns")?;
    Ok(bindings.is_empty() && active_turns.is_empty())
}

fn classify_bridge_probe(
    snapshot: &Value,
    info_result: Result<Value, String>,
    expected_profile: &str,
) -> Result<BridgeProbe, String> {
    let snapshot_is_empty = bridge_snapshot_is_empty(snapshot)?;
    let info_value = match info_result {
        Ok(value) => value,
        Err(error) if error == UNKNOWN_BRIDGE_INFO_ERROR => {
            return Ok(BridgeProbe {
                snapshot: snapshot.clone(),
                disposition: if snapshot_is_empty {
                    BridgeProbeDisposition::LegacyEmpty
                } else {
                    BridgeProbeDisposition::LegacyOccupied
                },
                capabilities: Vec::new(),
            });
        }
        Err(error) => return Err(format!("FEISHU_BRIDGE_PROBE_FAILED: {error}")),
    };
    let info: BridgeInfo = serde_json::from_value(info_value)
        .map_err(|error| format!("FEISHU_BRIDGE_INCOMPATIBLE: invalid bridge.info: {error}"))?;
    if info.daemon_version.trim().is_empty()
        || info.daemon_version.len() > 128
        || info.daemon_version.chars().any(char::is_control)
        || !valid_profile_name(&info.lark_profile)
        || info.capabilities.iter().any(|capability| {
            capability.is_empty()
                || capability.len() > 128
                || capability.chars().any(char::is_control)
        })
    {
        return Err("FEISHU_BRIDGE_INCOMPATIBLE: bridge.info contains invalid fields".to_string());
    }
    if info.lark_profile != expected_profile {
        return Err(
            "FEISHU_BRIDGE_PROFILE_MISMATCH: the running daemon uses a different lark-cli profile"
                .to_string(),
        );
    }
    let missing = BASE_REQUIRED_BRIDGE_CAPABILITIES
        .iter()
        .filter(|required| {
            !info
                .capabilities
                .iter()
                .any(|capability| capability == **required)
        })
        .copied()
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(format!(
            "FEISHU_BRIDGE_UPGRADE_REQUIRED: running daemon is missing required capabilities: {}",
            missing.join(", ")
        ));
    }
    Ok(BridgeProbe {
        snapshot: snapshot.clone(),
        disposition: BridgeProbeDisposition::Current,
        capabilities: info.capabilities,
    })
}

fn probe_bridge(expected_profile: &str) -> Result<BridgeProbe, String> {
    // Snapshot comes first so a legacy daemon can only be restarted after its
    // durable work is known to be empty. bridge.info is additive, and the one
    // exact unknown-operation response is the sole legacy signal.
    let snapshot = request("bridge.snapshot", json!({}))?;
    let info_result = request("bridge.info", json!({}));
    classify_bridge_probe(&snapshot, info_result, expected_profile)
}

fn bridge_has_reply_mode_capability(probe: &BridgeProbe) -> bool {
    probe
        .capabilities
        .iter()
        .any(|capability| capability == REPLY_MODE_BRIDGE_CAPABILITY)
}

fn reply_mode_create_param(
    probe: &BridgeProbe,
    reply_mode: FeishuReplyMode,
) -> Result<Option<&'static str>, String> {
    if bridge_has_reply_mode_capability(probe) {
        return Ok(Some(reply_mode.as_str()));
    }
    if reply_mode == FeishuReplyMode::Topic {
        return Ok(None);
    }
    Err(format!(
        "FEISHU_BRIDGE_UPGRADE_REQUIRED: running daemon is missing required capability: {REPLY_MODE_BRIDGE_CAPABILITY}"
    ))
}

fn require_reply_mode_capability(probe: &BridgeProbe) -> Result<(), String> {
    if bridge_has_reply_mode_capability(probe) {
        Ok(())
    } else {
        Err(format!(
            "FEISHU_BRIDGE_UPGRADE_REQUIRED: running daemon is missing required capability: {REPLY_MODE_BRIDGE_CAPABILITY}"
        ))
    }
}

fn require_activity_completion_capability(probe: &BridgeProbe) -> Result<(), String> {
    if bridge_has_activity_completion_capability(probe) {
        return Ok(());
    }
    Err(format!(
        "FEISHU_BRIDGE_UPGRADE_REQUIRED: running daemon is missing required capability: {ACTIVITY_COMPLETION_BRIDGE_CAPABILITY}"
    ))
}

fn bridge_has_activity_completion_capability(probe: &BridgeProbe) -> bool {
    probe
        .capabilities
        .iter()
        .any(|capability| capability == ACTIVITY_COMPLETION_BRIDGE_CAPABILITY)
}

fn require_steering_capability(probe: &BridgeProbe) -> Result<(), String> {
    if bridge_has_steering_capability(probe) {
        return Ok(());
    }
    Err(format!(
        "FEISHU_BRIDGE_UPGRADE_REQUIRED: running daemon is missing required capability: {STEERING_BRIDGE_CAPABILITY}"
    ))
}

fn bridge_has_steering_capability(probe: &BridgeProbe) -> bool {
    probe
        .capabilities
        .iter()
        .any(|capability| capability == STEERING_BRIDGE_CAPABILITY)
}

fn bridge_has_capability(probe: &BridgeProbe, capability: &str) -> bool {
    probe
        .capabilities
        .iter()
        .any(|candidate| candidate == capability)
}

fn require_hardened_delivery_capabilities(probe: &BridgeProbe) -> Result<(), String> {
    let missing = [
        CONSUMER_HEALTH_BRIDGE_CAPABILITY,
        DURABLE_REPLY_BRIDGE_CAPABILITY,
    ]
    .into_iter()
    .filter(|capability| !bridge_has_capability(probe, capability))
    .collect::<Vec<_>>();
    if missing.is_empty() {
        return Ok(());
    }
    Err(format!(
        "FEISHU_BRIDGE_UPGRADE_REQUIRED: running daemon is missing required capabilities: {}",
        missing.join(", ")
    ))
}

fn should_upgrade_empty_bridge(probe: &BridgeProbe) -> Result<bool, String> {
    Ok(bridge_snapshot_is_empty(&probe.snapshot)?
        && (probe.disposition == BridgeProbeDisposition::LegacyEmpty
            || !bridge_has_reply_mode_capability(probe)
            || !bridge_has_activity_completion_capability(probe)
            || !bridge_has_steering_capability(probe)
            || !bridge_has_capability(probe, CONSUMER_HEALTH_BRIDGE_CAPABILITY)
            || !bridge_has_capability(probe, DURABLE_REPLY_BRIDGE_CAPABILITY)))
}

fn start_server(
    app: &tauri::AppHandle,
    state: &FeishuBridgeRuntimeState,
    profile: &str,
    bundled_only: bool,
) -> Result<(), String> {
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
        if bundled_only && !matches!(&runtime, LocalTwRpcRuntime::Bundled { .. }) {
            return Err(
                "FEISHU_BRIDGE_UPGRADE_REQUIRED: bundled current TW CLI is unavailable".to_string(),
            );
        }
        let mut command = runtime_command(&runtime);
        command
            .args(["feishu-bridge", "serve", "--lark-profile", profile])
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

fn validate_bridge_shutdown(result: &Value) -> Result<(), String> {
    let object = result
        .as_object()
        .ok_or("FEISHU_BRIDGE_INCOMPATIBLE: bridge.shutdown returned a non-object")?;
    if object.len() != 1 || object.get("stopping").and_then(Value::as_bool) != Some(true) {
        return Err(
            "FEISHU_BRIDGE_INCOMPATIBLE: bridge.shutdown returned an invalid acknowledgement"
                .to_string(),
        );
    }
    Ok(())
}

fn ensure_server(
    app: &tauri::AppHandle,
    state: &FeishuBridgeRuntimeState,
) -> Result<BridgeProbe, String> {
    let (profile, _) = effective_profile()?;
    let profile = profile
        .ok_or("FEISHU_PROFILE_NOT_CONFIGURED: choose a bot profile in Settings > Integrations")?;
    let _transition = state
        .transition
        .lock()
        .map_err(|_| "Feishu bridge transition lock poisoned".to_string())?;
    if !bridge_is_running() {
        start_server(app, state, &profile, false)?;
    }
    let probe = probe_bridge(&profile)?;
    if !should_upgrade_empty_bridge(&probe)? {
        return Ok(probe);
    }

    let shutdown = request("bridge.shutdown", json!({}))?;
    validate_bridge_shutdown(&shutdown)?;
    wait_for_bridge_stop(state)?;
    start_server(app, state, &profile, true)?;
    let upgraded = probe_bridge(&profile)?;
    if upgraded.disposition != BridgeProbeDisposition::Current
        || !bridge_has_reply_mode_capability(&upgraded)
    {
        return Err(
            "FEISHU_BRIDGE_UPGRADE_REQUIRED: bundled daemon did not provide the current bridge capabilities"
                .to_string(),
        );
    }
    Ok(upgraded)
}

fn wait_for_bridge_stop(state: &FeishuBridgeRuntimeState) -> Result<(), String> {
    let lock_path = instance_lock_path()?;
    for _ in 0..STOP_ATTEMPTS {
        let socket_running = bridge_is_running();
        let mut process = state.process.lock().unwrap();
        let process_exited = match process.as_mut() {
            Some(child) => child
                .try_wait()
                .map_err(|error| format!("inspect Feishu bridge process: {error}"))?
                .is_some(),
            None => false,
        };
        if process_exited {
            *process = None;
        }
        if !socket_running && process.is_none() && !lock_path.exists() {
            return Ok(());
        }
        drop(process);
        std::thread::sleep(START_RETRY_DELAY);
    }
    Err("FEISHU_BRIDGE_UNAVAILABLE: bridge did not stop cleanly".to_string())
}

fn stop_verified_legacy_bridge() -> Result<(), String> {
    let path = instance_lock_path()?;
    let text = std::fs::read_to_string(&path)
        .map_err(|error| format!("read legacy Feishu bridge lock: {error}"))?;
    let owner: FeishuBridgeInstanceLock = serde_json::from_str(&text)
        .map_err(|error| format!("decode legacy Feishu bridge lock: {error}"))?;
    if owner.pid == 0 || owner.started_at == 0 {
        return Err("legacy Feishu bridge lock is invalid".to_string());
    }
    let output = Command::new("ps")
        .args(["-p", &owner.pid.to_string(), "-o", "command="])
        .output()
        .map_err(|error| format!("inspect legacy Feishu bridge process: {error}"))?;
    let command = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() || !command.contains("feishu-bridge") || !command.contains("serve")
    {
        return Err("legacy Feishu bridge process identity could not be verified".to_string());
    }
    let status = Command::new("kill")
        .args(["-TERM", &owner.pid.to_string()])
        .status()
        .map_err(|error| format!("stop legacy Feishu bridge: {error}"))?;
    if !status.success() {
        return Err("legacy Feishu bridge did not accept a stop request".to_string());
    }
    Ok(())
}

fn stop_empty_bridge_for_profile_change(state: &FeishuBridgeRuntimeState) -> Result<(), String> {
    if !bridge_is_running() {
        return Ok(());
    }
    let snapshot = request("bridge.snapshot", json!({}))?;
    let has_bindings = snapshot
        .get("bindings")
        .and_then(Value::as_array)
        .is_none_or(|bindings| !bindings.is_empty());
    let has_turns = snapshot
        .get("activeTurns")
        .and_then(Value::as_array)
        .is_none_or(|turns| !turns.is_empty());
    if has_bindings || has_turns {
        return Err("Unlink every Feishu group before changing the bot profile".to_string());
    }
    if let Err(error) = request("bridge.shutdown", json!({})) {
        if error.contains("unknown Feishu bridge operation") {
            stop_verified_legacy_bridge()?;
        } else {
            return Err(error);
        }
    }
    wait_for_bridge_stop(state)
}

#[tauri::command]
pub(crate) async fn feishu_integration_status() -> Result<FeishuIntegrationStatus, String> {
    tauri::async_runtime::spawn_blocking(integration_status)
        .await
        .map_err(|error| format!("join Feishu integration status: {error}"))?
}

#[tauri::command]
pub(crate) async fn feishu_integration_add_profile(
    app_id: String,
    app_secret: String,
    brand: String,
) -> Result<FeishuAddProfileResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let app_id = app_id.trim().to_string();
        let brand = brand.trim().to_string();
        if !valid_lark_credential_field(&app_id, 256) {
            return Err("Enter a valid Feishu App ID".to_string());
        }
        if !valid_lark_credential_field(&app_secret, 4096) {
            return Err("Enter a valid Feishu App Secret".to_string());
        }
        if brand != "feishu" && brand != "lark" {
            return Err("Choose Feishu or Lark for the bot identity".to_string());
        }
        let existing = list_lark_profiles_raw()?;
        let name = generated_lark_profile_name(&app_id, &existing);
        let outcome = add_lark_profile_with_program(
            OsStr::new("lark-cli"),
            &name,
            &app_id,
            &app_secret,
            &brand,
        )?;
        let profiles = list_lark_profiles_raw()?;
        let added = profiles.iter().any(|profile| {
            profile.name == name && profile.app_id == app_id && profile.brand == brand
        });
        if !added {
            return Err(outcome
                .detail
                .unwrap_or_else(|| "lark-cli did not persist the new bot identity".to_string()));
        }
        let warning = (!outcome.succeeded).then(|| {
            format!(
                "The identity was stored, but lark-cli could not verify it: {}",
                outcome
                    .detail
                    .unwrap_or_else(|| "credential verification failed".to_string())
            )
        });
        Ok(FeishuAddProfileResult {
            status: integration_status()?,
            added_profile: name,
            warning,
        })
    })
    .await
    .map_err(|error| format!("join Feishu profile add: {error}"))?
}

#[tauri::command]
pub(crate) async fn feishu_integration_save_profile(
    app: tauri::AppHandle,
    state: State<'_, Arc<FeishuBridgeRuntimeState>>,
    profile: String,
) -> Result<FeishuIntegrationStatus, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        if std::env::var("TW_FEISHU_LARK_PROFILE")
            .ok()
            .is_some_and(|value| !value.trim().is_empty())
        {
            return Err(
                "TW_FEISHU_LARK_PROFILE overrides Dashboard settings; change the environment instead"
                    .to_string(),
            );
        }
        let profile = profile.trim();
        if !valid_profile_name(profile) {
            return Err("Choose a valid lark-cli profile".to_string());
        }
        let profiles = list_lark_profiles_raw()?;
        if !profiles.iter().any(|candidate| candidate.name == profile) {
            return Err("The selected lark-cli profile no longer exists".to_string());
        }
        stop_empty_bridge_for_profile_change(state.as_ref())?;
        save_configured_profile(profile)?;
        ensure_server(&app, state.as_ref())?;
        integration_status()
    })
    .await
    .map_err(|error| format!("join Feishu profile save: {error}"))?
}

#[tauri::command]
pub(crate) async fn feishu_integration_remove_profile(
    state: State<'_, Arc<FeishuBridgeRuntimeState>>,
    profile: String,
) -> Result<FeishuIntegrationStatus, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        if std::env::var("TW_FEISHU_LARK_PROFILE")
            .ok()
            .is_some_and(|value| !value.trim().is_empty())
        {
            return Err(
                "TW_FEISHU_LARK_PROFILE overrides Dashboard settings; change the environment instead"
                    .to_string(),
            );
        }
        let profile = profile.trim();
        if !valid_profile_name(profile) {
            return Err("Choose a valid lark-cli profile".to_string());
        }
        let profiles = list_lark_profiles_raw()?;
        if !profiles.iter().any(|candidate| candidate.name == profile) {
            return Err("The selected bot profile no longer exists".to_string());
        }
        let (selected, _) = effective_profile()?;
        if selected.as_deref() == Some(profile) {
            stop_empty_bridge_for_profile_change(state.as_ref())?;
            clear_configured_profile(profile)?;
        }
        remove_lark_profile_with_program(OsStr::new("lark-cli"), profile)?;
        if list_lark_profiles_raw()?
            .iter()
            .any(|candidate| candidate.name == profile)
        {
            return Err("lark-cli did not remove the bot profile".to_string());
        }
        integration_status()
    })
    .await
    .map_err(|error| format!("join Feishu profile remove: {error}"))?
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

fn snapshot_binding<'a>(
    snapshot: &'a Value,
    binding_id: &str,
) -> Result<Option<&'a Value>, String> {
    let bindings = snapshot
        .get("bindings")
        .and_then(Value::as_array)
        .ok_or("FEISHU_BRIDGE_INCOMPATIBLE: bridge.snapshot omitted bindings")?;
    let mut matches = bindings
        .iter()
        .filter(|binding| binding.get("id").and_then(Value::as_str) == Some(binding_id));
    let binding = matches.next();
    if matches.next().is_some() {
        return Err("FEISHU_BRIDGE_INCOMPATIBLE: duplicate binding identities".to_string());
    }
    Ok(binding)
}

fn legacy_binding_remove_action(
    snapshot: &Value,
    binding_id: &str,
    force: bool,
) -> Result<LegacyBindingRemoveAction, String> {
    let Some(binding) = snapshot_binding(snapshot, binding_id)? else {
        return Ok(LegacyBindingRemoveAction::AlreadyRemoved);
    };
    match binding.get("status").and_then(Value::as_str) {
        Some("active" | "paused") => Ok(LegacyBindingRemoveAction::UseLegacy),
        Some("stale" | "pausing") if force => {
            let active_turns = snapshot
                .get("activeTurns")
                .and_then(Value::as_array)
                .ok_or("FEISHU_BRIDGE_INCOMPATIBLE: bridge.snapshot omitted activeTurns")?;
            if !active_turns.is_empty() {
                return Err(
                    "FEISHU_BRIDGE_UPGRADE_REQUIRED: wait for or cancel active Feishu turns before migrating this legacy binding"
                        .to_string(),
                );
            }
            let bindings = snapshot
                .get("bindings")
                .and_then(Value::as_array)
                .ok_or("FEISHU_BRIDGE_INCOMPATIBLE: bridge.snapshot omitted bindings")?;
            if bindings.len() != 1 {
                return Err(
                    "FEISHU_BRIDGE_UPGRADE_REQUIRED: unlink other Feishu groups before migrating this legacy binding"
                        .to_string(),
                );
            }
            Ok(LegacyBindingRemoveAction::UpgradeCurrent)
        }
        Some("stale" | "pausing") => Err(
            "FEISHU_BRIDGE_UPGRADE_REQUIRED: force confirmation is required to migrate and remove this uncertain legacy binding"
                .to_string(),
        ),
        _ => Err(
            "FEISHU_BRIDGE_INCOMPATIBLE: legacy binding has an unknown status".to_string(),
        ),
    }
}

fn request_binding_remove_confirming_absence(
    binding_id: &str,
    force: bool,
    include_origin: bool,
) -> Result<Value, String> {
    let mut params = json!({ "bindingId": binding_id, "force": force });
    if include_origin {
        params
            .as_object_mut()
            .ok_or("binding.remove params are invalid")?
            .insert("origin".to_string(), json!("dashboard"));
    }
    match request("binding.remove", params) {
        Ok(result) => Ok(result),
        Err(error) => match request("bridge.snapshot", json!({})) {
            Ok(snapshot) if matches!(snapshot_binding(&snapshot, binding_id), Ok(None)) => {
                Ok(json!({ "removed": true }))
            }
            // An uncertain acknowledgement is never retried. Preserve the
            // original remove error unless a fresh snapshot proves absence.
            Ok(_) | Err(_) => Err(error),
        },
    }
}

fn remove_binding_after_legacy_migration(
    app: &tauri::AppHandle,
    state: &FeishuBridgeRuntimeState,
    binding_id: &str,
    force: bool,
) -> Result<Value, String> {
    if !force {
        return Err(
            "FEISHU_BRIDGE_UPGRADE_REQUIRED: force confirmation is required before migrating an uncertain legacy binding"
                .to_string(),
        );
    }
    let (profile, _) = effective_profile()?;
    let profile = profile
        .ok_or("FEISHU_PROFILE_NOT_CONFIGURED: choose a bot profile in Settings > Integrations")?;
    let _transition = state
        .transition
        .lock()
        .map_err(|_| "Feishu bridge transition lock poisoned".to_string())?;
    let probe = probe_bridge(&profile)?;
    let current = match probe.disposition {
        BridgeProbeDisposition::Current => probe,
        BridgeProbeDisposition::LegacyEmpty => {
            let shutdown = request("bridge.shutdown", json!({}))?;
            validate_bridge_shutdown(&shutdown)?;
            wait_for_bridge_stop(state)?;
            start_server(app, state, &profile, true)?;
            probe_bridge(&profile)?
        }
        BridgeProbeDisposition::LegacyOccupied => {
            match legacy_binding_remove_action(&probe.snapshot, binding_id, force)? {
                LegacyBindingRemoveAction::AlreadyRemoved => {
                    return Ok(json!({ "removed": true }));
                }
                LegacyBindingRemoveAction::UseLegacy => {
                    return request_binding_remove_confirming_absence(binding_id, force, false);
                }
                LegacyBindingRemoveAction::UpgradeCurrent => {
                    // The user explicitly confirmed removal. SIGTERM is sent
                    // only after the legacy lock PID and command identity have
                    // been verified; the Node handler performs server.stop().
                    stop_verified_legacy_bridge()?;
                    wait_for_bridge_stop(state)?;
                    start_server(app, state, &profile, true)?;
                    probe_bridge(&profile)?
                }
            }
        }
    };
    if current.disposition != BridgeProbeDisposition::Current {
        return Err(
            "FEISHU_BRIDGE_UPGRADE_REQUIRED: bundled daemon did not provide the current bridge capabilities"
                .to_string(),
        );
    }
    if snapshot_binding(&current.snapshot, binding_id)?.is_none() {
        return Ok(json!({ "removed": true }));
    }
    request_binding_remove_confirming_absence(
        binding_id,
        force,
        bridge_has_capability(&current, REMOVE_ORIGIN_BRIDGE_CAPABILITY),
    )
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
pub(crate) async fn feishu_bridge_status(
    app: tauri::AppHandle,
    state: State<'_, Arc<FeishuBridgeRuntimeState>>,
) -> Result<Value, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || Ok(ensure_server(&app, state.as_ref())?.snapshot))
        .await
        .map_err(|error| format!("join Feishu bridge status: {error}"))?
}

#[tauri::command]
pub(crate) async fn feishu_groups_list(
    app: tauri::AppHandle,
    state: State<'_, Arc<FeishuBridgeRuntimeState>>,
) -> Result<Value, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        ensure_server(&app, state.as_ref())?;
        request("groups.list", json!({}))
    })
    .await
    .map_err(|error| format!("join Feishu group list: {error}"))?
}

#[tauri::command]
pub(crate) fn feishu_binding_create(
    app: tauri::AppHandle,
    state: State<'_, Arc<FeishuBridgeRuntimeState>>,
    pty_state: State<'_, Arc<PtyState>>,
    control_state: State<'_, Arc<TerminalControlState>>,
    args: FeishuBindingInput,
) -> Result<Value, String> {
    let reply_mode = FeishuReplyMode::parse(&args.reply_mode)?;
    let probe = ensure_server(&app, state.inner().as_ref())?;
    if probe.disposition != BridgeProbeDisposition::Current {
        return Err(
            "FEISHU_BRIDGE_UPGRADE_REQUIRED: unlink existing groups and retry after the legacy bridge becomes idle"
                .to_string(),
        );
    }
    require_activity_completion_capability(&probe)?;
    require_steering_capability(&probe)?;
    require_hardened_delivery_capabilities(&probe)?;
    let reply_mode_param = reply_mode_create_param(&probe, reply_mode)?;
    let mut params = json!({
        "chatId": args.chat_id,
        "chatName": args.chat_name,
        "sessionName": args.session_name,
        "createdBy": args.created_by,
        "allowedSenderIds": args.allowed_sender_ids,
        "mentionOnly": args.mention_only,
    });
    if let Some(session_summary) = args.session_summary.as_ref() {
        params
            .as_object_mut()
            .ok_or("binding.create params are invalid")?
            .insert("sessionSummary".to_string(), json!(session_summary));
    }
    if let Some(reply_mode) = reply_mode_param {
        params
            .as_object_mut()
            .ok_or("binding.create params are invalid")?
            .insert("replyMode".to_string(), json!(reply_mode));
    }
    let pty_id = args
        .attachment_id
        .ok_or("Feishu Dashboard binding requires a controlled PTY attachment")?;
    with_pty_control(pty_state.inner().as_ref(), &pty_id, |control| {
        control.ensure_local_transfer_target(&args.session_name)?;
        // Dashboard PTYs acquire their interactive lease lazily. Linking a
        // group is itself a transfer mutation, so refresh any cached lease and
        // acquire one while the same PTY mutex still excludes input/resize.
        // Feishu ownership and recovery states continue to fail closed in the
        // canonical authority.
        refresh_pty_control_status(&app, control_state.inner().as_ref(), control);
        let dashboard_lease = acquire_pty_control(&app, control_state.inner().as_ref(), control)
            .map_err(|error| error.to_string())?;
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
pub(crate) fn feishu_binding_update_reply_mode(
    app: tauri::AppHandle,
    state: State<'_, Arc<FeishuBridgeRuntimeState>>,
    binding_id: String,
    reply_mode: String,
) -> Result<Value, String> {
    let reply_mode = FeishuReplyMode::parse(&reply_mode)?;
    let probe = ensure_server(&app, state.inner().as_ref())?;
    require_reply_mode_capability(&probe)?;
    request(
        "binding.update",
        json!({
            "bindingId": binding_id,
            "replyMode": reply_mode.as_str(),
        }),
    )
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
    let probe = ensure_server(&app, state.inner().as_ref())?;
    require_activity_completion_capability(&probe)?;
    require_steering_capability(&probe)?;
    require_hardened_delivery_capabilities(&probe)?;
    request("binding.resume", json!({ "bindingId": binding_id }))
}

#[tauri::command]
pub(crate) fn feishu_binding_repair(
    app: tauri::AppHandle,
    state: State<'_, Arc<FeishuBridgeRuntimeState>>,
    binding_id: String,
) -> Result<Value, String> {
    let probe = ensure_server(&app, state.inner().as_ref())?;
    require_activity_completion_capability(&probe)?;
    require_steering_capability(&probe)?;
    require_hardened_delivery_capabilities(&probe)?;
    request("binding.repair", json!({ "bindingId": binding_id }))
}

#[tauri::command]
pub(crate) fn feishu_binding_remove(
    app: tauri::AppHandle,
    state: State<'_, Arc<FeishuBridgeRuntimeState>>,
    binding_id: String,
    force: bool,
) -> Result<Value, String> {
    let probe = ensure_server(&app, state.inner().as_ref())?;
    if probe.disposition == BridgeProbeDisposition::LegacyOccupied {
        match legacy_binding_remove_action(&probe.snapshot, &binding_id, force)? {
            LegacyBindingRemoveAction::AlreadyRemoved => {
                return Ok(json!({ "removed": true }));
            }
            LegacyBindingRemoveAction::UpgradeCurrent => {
                return remove_binding_after_legacy_migration(
                    &app,
                    state.inner().as_ref(),
                    &binding_id,
                    force,
                );
            }
            LegacyBindingRemoveAction::UseLegacy => {}
        }
    }
    request_binding_remove_confirming_absence(
        &binding_id,
        force,
        bridge_has_capability(&probe, REMOVE_ORIGIN_BRIDGE_CAPABILITY),
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
    let probe = ensure_server(&app, bridge_state.inner().as_ref())?;
    require_activity_completion_capability(&probe)?;
    require_steering_capability(&probe)?;
    require_hardened_delivery_capabilities(&probe)?;
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

#[cfg(test)]
mod tests {
    use super::{
        add_lark_profile_with_program, classify_bridge_probe, configured_profile_from_file,
        default_reply_mode, effective_profile, empty_lark_profile_config,
        generated_lark_profile_name, lark_cli_error_message, legacy_binding_remove_action,
        reply_mode_create_param, require_activity_completion_capability,
        require_hardened_delivery_capabilities, require_reply_mode_capability,
        require_steering_capability, save_configured_profile, should_upgrade_empty_bridge,
        validate_bridge_shutdown, BridgeProbeDisposition, FeishuBindingInput, FeishuLarkProfile,
        FeishuReplyMode, LegacyBindingRemoveAction, ACTIVITY_COMPLETION_BRIDGE_CAPABILITY,
        BASE_REQUIRED_BRIDGE_CAPABILITIES, CONSUMER_HEALTH_BRIDGE_CAPABILITY,
        DURABLE_REPLY_BRIDGE_CAPABILITY, REPLY_MODE_BRIDGE_CAPABILITY, STEERING_BRIDGE_CAPABILITY,
        UNKNOWN_BRIDGE_INFO_ERROR,
    };
    use serde_json::json;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    fn restore_env(name: &str, value: Option<String>) {
        if let Some(value) = value {
            unsafe { std::env::set_var(name, value) };
        } else {
            unsafe { std::env::remove_var(name) };
        }
    }

    #[test]
    fn feishu_profile_config_is_non_secret_atomic_and_preserves_unknown_fields() {
        let _guard = crate::tests::test_env_lock().lock().expect("test env lock");
        let variables = ["HOME", "TW_DASHBOARD_HOME", "TW_FEISHU_LARK_PROFILE"];
        let originals = variables.map(|name| (name, std::env::var(name).ok()));
        let temp = tempfile::tempdir().expect("tempdir");
        unsafe {
            std::env::set_var("HOME", temp.path());
            std::env::set_var("TW_DASHBOARD_HOME", temp.path());
            std::env::remove_var("TW_FEISHU_LARK_PROFILE");
        }
        let path = temp.path().join(".tmux-worktree.json");
        fs::write(
            &path,
            r#"{
  "projects": { "app": "/repo/app" },
  "feishuBridge": { "future": true }
}"#,
        )
        .expect("seed config");

        save_configured_profile(" bot-profile ".trim()).expect("save profile");
        assert_eq!(
            configured_profile_from_file().expect("read profile"),
            Some("bot-profile".to_string())
        );
        let value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).expect("read saved config"))
                .expect("parse saved config");
        assert_eq!(value["projects"]["app"], "/repo/app");
        assert_eq!(value["feishuBridge"]["future"], true);
        assert_eq!(value["feishuBridge"]["larkProfile"], "bot-profile");
        assert_eq!(
            fs::metadata(&path)
                .expect("config metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );

        unsafe { std::env::set_var("TW_FEISHU_LARK_PROFILE", "env-bot") };
        assert_eq!(
            effective_profile().expect("environment profile"),
            (Some("env-bot".to_string()), "environment".to_string())
        );

        for (name, value) in originals {
            restore_env(name, value);
        }
    }

    #[test]
    fn feishu_profile_config_refuses_corrupt_or_wrong_typed_roots() {
        let _guard = crate::tests::test_env_lock().lock().expect("test env lock");
        let original_home = std::env::var("HOME").ok();
        let original_dashboard_home = std::env::var("TW_DASHBOARD_HOME").ok();
        let original_override = std::env::var("TW_FEISHU_LARK_PROFILE").ok();
        let temp = tempfile::tempdir().expect("tempdir");
        unsafe {
            std::env::set_var("HOME", temp.path());
            std::env::set_var("TW_DASHBOARD_HOME", temp.path());
            std::env::remove_var("TW_FEISHU_LARK_PROFILE");
        }
        let path = temp.path().join(".tmux-worktree.json");
        fs::write(&path, "{broken").expect("write corrupt config");
        assert!(configured_profile_from_file()
            .expect_err("corrupt config must fail")
            .contains("parse config"));
        fs::write(&path, r#"{"feishuBridge":"wrong"}"#).expect("write typed config");
        assert!(configured_profile_from_file()
            .expect_err("wrong type must fail")
            .contains("not an object"));

        restore_env("TW_FEISHU_LARK_PROFILE", original_override);
        restore_env("TW_DASHBOARD_HOME", original_dashboard_home);
        restore_env("HOME", original_home);
    }

    #[test]
    fn empty_lark_profile_config_is_a_recoverable_add_identity_state() {
        let envelope = br#"{
  "ok": false,
  "error": {
    "message": "failed to load config: invalid config format: no apps: malformed config"
  }
}"#;
        let message = lark_cli_error_message(envelope, b"").expect("structured error");
        assert!(empty_lark_profile_config(&message));
    }

    #[test]
    fn feishu_profile_name_is_internal_stable_and_collision_safe() {
        let existing = vec![
            FeishuLarkProfile {
                name: "tw-cli-team-bot".to_string(),
                app_id: "cli_other".to_string(),
                brand: "feishu".to_string(),
                display_name: None,
                active: false,
                user: None,
                token_status: None,
            },
            FeishuLarkProfile {
                name: "tw-cli-team-bot-2".to_string(),
                app_id: "cli_other_2".to_string(),
                brand: "feishu".to_string(),
                display_name: None,
                active: false,
                user: None,
                token_status: None,
            },
        ];
        assert_eq!(
            generated_lark_profile_name("CLI_Team_Bot", &[]),
            "tw-cli-team-bot"
        );
        assert_eq!(
            generated_lark_profile_name("CLI_Team_Bot", &existing),
            "tw-cli-team-bot-3"
        );
        assert!(generated_lark_profile_name(&"x".repeat(256), &[]).len() <= 64);
    }

    #[test]
    fn feishu_profile_add_keeps_the_app_secret_on_stdin_and_redacts_failures() {
        let temp = tempfile::tempdir().expect("tempdir");
        let args_path = temp.path().join("args");
        let stdin_path = temp.path().join("stdin");
        let script_path = temp.path().join("fake-lark-cli");
        fs::write(
            &script_path,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\ncat > '{}'\nprintf '%s' \"$(cat '{}')\"\nexit 7\n",
                args_path.display(),
                stdin_path.display(),
                stdin_path.display(),
            ),
        )
        .expect("write fake lark-cli");
        let mut permissions = fs::metadata(&script_path)
            .expect("fake metadata")
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&script_path, permissions).expect("make fake executable");

        let secret = "must-never-appear-in-argv-or-errors";
        let outcome = add_lark_profile_with_program(
            script_path.as_os_str(),
            "team-bot",
            "cli_team_bot",
            secret,
            "feishu",
        )
        .expect("run fake lark-cli");
        assert!(!outcome.succeeded);
        assert_eq!(fs::read_to_string(&stdin_path).expect("read stdin"), secret);
        let args = fs::read_to_string(&args_path).expect("read args");
        assert!(args.contains("--app-secret-stdin"));
        assert!(!args.contains(secret));
        let detail = outcome.detail.expect("failure detail");
        assert!(detail.contains("[redacted]"));
        assert!(!detail.contains(secret));
    }

    #[test]
    fn bridge_probe_requires_current_capabilities_and_matching_profile() {
        let snapshot = json!({ "bindings": [], "activeTurns": [] });
        let info = json!({
            "daemonVersion": "1.0.7",
            "larkProfile": "team-bot",
            "capabilities": BASE_REQUIRED_BRIDGE_CAPABILITIES,
        });
        let current =
            classify_bridge_probe(&snapshot, Ok(info.clone()), "team-bot").expect("current daemon");
        assert_eq!(current.disposition, BridgeProbeDisposition::Current);
        assert_eq!(current.capabilities, BASE_REQUIRED_BRIDGE_CAPABILITIES);

        let mut missing_capability = info.clone();
        missing_capability["capabilities"] = json!([BASE_REQUIRED_BRIDGE_CAPABILITIES[0]]);
        assert!(
            classify_bridge_probe(&snapshot, Ok(missing_capability), "team-bot")
                .expect_err("missing capability must fail closed")
                .starts_with("FEISHU_BRIDGE_UPGRADE_REQUIRED:")
        );

        assert!(classify_bridge_probe(&snapshot, Ok(info), "other-bot")
            .expect_err("profile mismatch must fail closed")
            .starts_with("FEISHU_BRIDGE_PROFILE_MISMATCH:"));
    }

    #[test]
    fn reply_mode_rollout_upgrades_only_empty_daemons_and_gates_new_mutations() {
        let empty = json!({ "bindings": [], "activeTurns": [] });
        let occupied = json!({
            "bindings": [{ "id": "binding-1", "status": "active" }],
            "activeTurns": [],
        });
        let base_info = json!({
            "daemonVersion": "1.0.7",
            "larkProfile": "team-bot",
            "capabilities": BASE_REQUIRED_BRIDGE_CAPABILITIES,
        });
        let empty_base = classify_bridge_probe(&empty, Ok(base_info.clone()), "team-bot")
            .expect("empty base-capability daemon");
        let occupied_base = classify_bridge_probe(&occupied, Ok(base_info), "team-bot")
            .expect("occupied base-capability daemon");

        assert!(should_upgrade_empty_bridge(&empty_base).expect("valid empty snapshot"));
        assert!(!should_upgrade_empty_bridge(&occupied_base).expect("valid occupied snapshot"));
        assert_eq!(
            reply_mode_create_param(&occupied_base, FeishuReplyMode::Topic)
                .expect("legacy topic create stays compatible"),
            None,
        );
        assert!(
            reply_mode_create_param(&occupied_base, FeishuReplyMode::Direct)
                .expect_err("direct mode requires the feature capability")
                .contains(REPLY_MODE_BRIDGE_CAPABILITY)
        );
        assert!(require_reply_mode_capability(&occupied_base)
            .expect_err("updates require the feature capability")
            .contains(REPLY_MODE_BRIDGE_CAPABILITY));
        assert!(require_activity_completion_capability(&occupied_base)
            .expect_err("ownership activation requires completion tracking")
            .contains(ACTIVITY_COMPLETION_BRIDGE_CAPABILITY));
        assert!(require_steering_capability(&occupied_base)
            .expect_err("ownership activation requires steering support")
            .contains(STEERING_BRIDGE_CAPABILITY));

        let current_info = json!({
            "daemonVersion": "1.0.8",
            "larkProfile": "team-bot",
            "capabilities": [
                BASE_REQUIRED_BRIDGE_CAPABILITIES[0],
                BASE_REQUIRED_BRIDGE_CAPABILITIES[1],
                BASE_REQUIRED_BRIDGE_CAPABILITIES[2],
                REPLY_MODE_BRIDGE_CAPABILITY,
                ACTIVITY_COMPLETION_BRIDGE_CAPABILITY,
                STEERING_BRIDGE_CAPABILITY,
                CONSUMER_HEALTH_BRIDGE_CAPABILITY,
                DURABLE_REPLY_BRIDGE_CAPABILITY,
            ],
        });
        let current = classify_bridge_probe(&empty, Ok(current_info), "team-bot")
            .expect("reply-mode-capable daemon");
        assert!(!should_upgrade_empty_bridge(&current).expect("valid current snapshot"));
        assert_eq!(
            reply_mode_create_param(&current, FeishuReplyMode::Topic).expect("current topic mode"),
            Some("topic"),
        );
        assert_eq!(
            reply_mode_create_param(&current, FeishuReplyMode::Direct)
                .expect("current direct mode"),
            Some("direct"),
        );
        require_reply_mode_capability(&current).expect("current update capability");
        require_activity_completion_capability(&current).expect("current completion capability");
        require_steering_capability(&current).expect("current steering capability");
        require_hardened_delivery_capabilities(&current)
            .expect("current durable delivery capabilities");
    }

    #[test]
    fn reply_mode_input_defaults_to_topic_and_rejects_unknown_values() {
        let input: FeishuBindingInput = serde_json::from_value(json!({
            "chatId": "oc-one",
            "chatName": "Team",
            "sessionName": "managed-one",
            "createdBy": "ou-owner",
        }))
        .expect("binding input without replyMode");
        assert_eq!(input.reply_mode, default_reply_mode());
        assert_eq!(FeishuReplyMode::parse("topic"), Ok(FeishuReplyMode::Topic));
        assert_eq!(
            FeishuReplyMode::parse("direct"),
            Ok(FeishuReplyMode::Direct)
        );
        assert!(FeishuReplyMode::parse("thread").is_err());
        assert!(FeishuReplyMode::parse("").is_err());
    }

    #[test]
    fn bridge_probe_only_marks_an_exact_unknown_info_operation_as_legacy() {
        let empty = json!({ "bindings": [], "activeTurns": [] });
        let empty_legacy = classify_bridge_probe(
            &empty,
            Err(UNKNOWN_BRIDGE_INFO_ERROR.to_string()),
            "team-bot",
        )
        .expect("empty legacy daemon");
        assert_eq!(
            empty_legacy.disposition,
            BridgeProbeDisposition::LegacyEmpty
        );
        assert!(empty_legacy.capabilities.is_empty());

        for occupied in [
            json!({ "bindings": [{ "id": "binding-1" }], "activeTurns": [] }),
            json!({ "bindings": [], "activeTurns": [{ "id": "turn-1" }] }),
        ] {
            assert_eq!(
                classify_bridge_probe(
                    &occupied,
                    Err(UNKNOWN_BRIDGE_INFO_ERROR.to_string()),
                    "team-bot"
                )
                .expect("occupied legacy daemon")
                .disposition,
                BridgeProbeDisposition::LegacyOccupied
            );
        }

        assert!(classify_bridge_probe(
            &empty,
            Err("FEISHU_BRIDGE_UNAVAILABLE: read timed out".to_string()),
            "team-bot"
        )
        .expect_err("transport uncertainty must fail closed")
        .starts_with("FEISHU_BRIDGE_PROBE_FAILED:"));
    }

    #[test]
    fn bridge_upgrade_preconditions_reject_malformed_state_and_shutdown_ack() {
        let malformed_snapshot = json!({ "bindings": [] });
        assert!(classify_bridge_probe(
            &malformed_snapshot,
            Err(UNKNOWN_BRIDGE_INFO_ERROR.to_string()),
            "team-bot"
        )
        .expect_err("missing active turns must block restart")
        .contains("omitted activeTurns"));

        let empty = json!({ "bindings": [], "activeTurns": [] });
        assert!(classify_bridge_probe(
            &empty,
            Ok(json!({
                "daemonVersion": "1.0.7",
                "larkProfile": "team-bot",
                "capabilities": BASE_REQUIRED_BRIDGE_CAPABILITIES,
                "unexpected": true,
            })),
            "team-bot"
        )
        .expect_err("malformed bridge info must fail closed")
        .starts_with("FEISHU_BRIDGE_INCOMPATIBLE:"));

        validate_bridge_shutdown(&json!({ "stopping": true })).expect("shutdown ack");
        assert!(validate_bridge_shutdown(&json!({ "stopping": false }))
            .expect_err("false shutdown ack")
            .contains("invalid acknowledgement"));
        assert!(
            validate_bridge_shutdown(&json!({ "stopping": true, "extra": true }))
                .expect_err("open shutdown ack")
                .contains("invalid acknowledgement")
        );
    }

    #[test]
    fn legacy_binding_removal_only_migrates_uncertain_status_after_force_confirmation() {
        for status in ["active", "paused"] {
            let snapshot = json!({
                "bindings": [{ "id": "binding-1", "status": status }],
                "activeTurns": [],
            });
            assert_eq!(
                legacy_binding_remove_action(&snapshot, "binding-1", false)
                    .expect("certain legacy status"),
                LegacyBindingRemoveAction::UseLegacy
            );
        }

        for status in ["stale", "pausing"] {
            let snapshot = json!({
                "bindings": [{ "id": "binding-1", "status": status }],
                "activeTurns": [],
            });
            assert!(legacy_binding_remove_action(&snapshot, "binding-1", false)
                .expect_err("uncertain legacy status requires confirmation")
                .starts_with("FEISHU_BRIDGE_UPGRADE_REQUIRED:"));
            assert_eq!(
                legacy_binding_remove_action(&snapshot, "binding-1", true)
                    .expect("confirmed uncertain legacy status"),
                LegacyBindingRemoveAction::UpgradeCurrent
            );
        }

        let active_turn = json!({
            "bindings": [{ "id": "binding-1", "status": "stale" }],
            "activeTurns": [{ "id": "turn-1" }],
        });
        assert!(
            legacy_binding_remove_action(&active_turn, "binding-1", true)
                .expect_err("active turn blocks daemon migration")
                .contains("active Feishu turns")
        );

        for sibling_status in ["active", "paused", "pausing", "stale"] {
            let sibling = json!({
                "bindings": [
                    { "id": "binding-1", "status": "stale" },
                    { "id": "binding-2", "status": sibling_status },
                ],
                "activeTurns": [],
            });
            assert!(legacy_binding_remove_action(&sibling, "binding-1", true)
                .expect_err("any sibling blocks whole-daemon migration")
                .contains("other Feishu groups"));
        }

        let missing = json!({ "bindings": [], "activeTurns": [] });
        assert_eq!(
            legacy_binding_remove_action(&missing, "binding-1", true)
                .expect("already removed binding"),
            LegacyBindingRemoveAction::AlreadyRemoved
        );
    }
}
