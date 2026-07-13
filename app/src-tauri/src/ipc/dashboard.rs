use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Serialize, Clone)]
pub(crate) struct DirEntry {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) is_dir: bool,
    pub(crate) is_symlink: bool,
    pub(crate) is_hidden: bool,
    pub(crate) size: u64,
}

#[derive(Serialize, Clone)]
pub(crate) struct Session {
    pub(crate) name: String,
    pub(crate) attached: bool,
    pub(crate) window_count: u32,
    pub(crate) created: u64,
    pub(crate) activity: u64,
    pub(crate) output_signature: Option<String>,
    pub(crate) agent_running: Option<bool>,
    #[serde(default, rename = "hostId")]
    pub(crate) host_id: Option<String>,
    #[serde(default, rename = "rawName")]
    pub(crate) raw_name: String,
    #[serde(default)]
    pub(crate) project: Option<String>,
    pub(crate) managed: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostStatus {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) reachable: bool,
    pub(crate) latency_ms: Option<u64>,
    pub(crate) error: Option<String>,
    pub(crate) tmux_available: bool,
    pub(crate) tmux_version: Option<String>,
    pub(crate) tmux_error: Option<String>,
    pub(crate) tw_available: bool,
    pub(crate) tw_version: Option<String>,
    pub(crate) tw_error: Option<String>,
    pub(crate) tw_protocol_version: Option<u32>,
    pub(crate) tw_capabilities: Vec<String>,
    pub(crate) tw_compatible: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentProbeResult {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) command: String,
    pub(crate) available: bool,
    pub(crate) executable_path: Option<String>,
    pub(crate) error: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TmuxTerminal {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) cwd: String,
    pub(crate) tmux_name: String,
    pub(crate) host_id: Option<String>,
    pub(crate) raw_name: String,
    pub(crate) managed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardCatalogSnapshot {
    pub(crate) sessions: Vec<Session>,
    pub(crate) terminals: Vec<TmuxTerminal>,
    pub(crate) failed_session_host_ids: Vec<String>,
    pub(crate) failed_terminal_host_ids: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreatedTerminal {
    pub(crate) tmux_name: String,
    pub(crate) host_id: Option<String>,
    pub(crate) raw_name: String,
    pub(crate) cwd: String,
    pub(crate) managed: bool,
}

#[derive(Serialize, Clone)]
pub(crate) struct Project {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) branch: Option<String>,
}

#[derive(Serialize, Clone)]
pub(crate) struct PtyChunk {
    pub(crate) id: String,
    pub(crate) data: String,
}

#[derive(Serialize, Clone)]
pub(crate) struct PtyExit {
    pub(crate) id: String,
    pub(crate) code: i32,
}

#[derive(Deserialize)]
pub(crate) struct OpenArgs {
    pub(crate) id: Option<String>,
    pub(crate) cmd: String,
    pub(crate) args: Vec<String>,
    pub(crate) cwd: Option<String>,
    pub(crate) cols: u16,
    pub(crate) rows: u16,
    pub(crate) env: Option<HashMap<String, String>>,
    #[serde(rename = "controlSession", default)]
    pub(crate) control_session: Option<String>,
    #[serde(rename = "controlHostId", default)]
    pub(crate) control_host_id: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct CreateTerminalArgs {
    pub(crate) cwd: String,
    #[serde(rename = "aiCmd")]
    pub(crate) ai_cmd: String,
    #[serde(rename = "hostId", default)]
    pub(crate) host_id: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct EnsureTerminalArgs {
    pub(crate) name: String,
    pub(crate) cwd: String,
    #[serde(rename = "aiCmd", default)]
    pub(crate) ai_cmd: Option<String>,
    #[serde(rename = "hostId", default)]
    pub(crate) host_id: Option<String>,
    #[serde(rename = "rawName", default)]
    pub(crate) raw_name: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
pub(crate) struct OrphanedWorktree {
    pub(crate) project: String,
    pub(crate) path: String,
    pub(crate) name: String,
}

#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct CreateArgs {
    pub(crate) project: Option<String>,
    pub(crate) path: Option<String>,
    #[serde(rename = "aiCmd")]
    pub(crate) ai_cmd: String,
    pub(crate) name: Option<String>,
    pub(crate) branch: Option<String>,
    #[serde(rename = "hostId", default)]
    pub(crate) host_id: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct RestoreArgs {
    pub(crate) path: String,
    pub(crate) name: String,
    #[serde(rename = "aiCmd", default)]
    pub(crate) ai_cmd: String,
}

#[derive(Deserialize)]
pub(crate) struct DeleteWorktreeArgs {
    pub(crate) path: String,
    #[serde(default)]
    pub(crate) force: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TmuxStatusTheme {
    pub(crate) status_bg: String,
    pub(crate) status_fg: String,
    pub(crate) active_bg: String,
    pub(crate) active_fg: String,
    pub(crate) inactive_fg: String,
    pub(crate) accent: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MobileRelayStatus {
    pub(crate) active: bool,
    pub(crate) connected: bool,
    pub(crate) connection_state: String,
    pub(crate) relay_url: String,
    pub(crate) broker_host_id: String,
    pub(crate) host_id: String,
    pub(crate) secret: String,
    pub(crate) token: String,
    pub(crate) connected_at: Option<u64>,
    pub(crate) updated_at: Option<u64>,
    pub(crate) retry_in_ms: Option<u64>,
    pub(crate) error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MobileRelayConfigInput {
    pub(crate) relay_url: String,
    pub(crate) broker_host_id: String,
    pub(crate) host_id: String,
    pub(crate) secret: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MobileRelayBrokerInput {
    pub(crate) host_id: String,
    pub(crate) port: Option<u16>,
    pub(crate) quick_tunnel: Option<bool>,
}
