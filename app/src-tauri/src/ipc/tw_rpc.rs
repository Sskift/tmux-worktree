use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TwRpcListResponse {
    pub(crate) protocol_version: u32,
    pub(crate) sessions: Vec<TwRpcSession>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TwRpcSession {
    pub(crate) name: String,
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) project: Option<String>,
    pub(crate) attached: bool,
    pub(crate) windows: u32,
    pub(crate) created: u64,
    pub(crate) activity: u64,
    #[serde(default)]
    pub(crate) cwd: Option<String>,
}

#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TwRpcCreateWorktreeResponse {
    pub(crate) protocol_version: u32,
    #[serde(default)]
    pub(crate) kind: Option<String>,
    pub(crate) session: String,
    #[serde(default)]
    pub(crate) worktree_path: Option<String>,
    #[serde(default)]
    pub(crate) branch: Option<String>,
}

#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TwRpcCreateTerminalResponse {
    pub(crate) protocol_version: u32,
    pub(crate) kind: String,
    pub(crate) session: String,
    pub(crate) cwd: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TwRpcKillSessionResponse {
    pub(crate) protocol_version: u32,
    pub(crate) kind: String,
    pub(crate) session: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TwRpcCapabilitiesResponse {
    pub(crate) protocol_version: u32,
    pub(crate) capabilities: Vec<String>,
}
