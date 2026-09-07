use serde::Deserialize;

/// Dashboard TW RPC v2 contract: capabilities a peer must provide.
///
/// Single source of truth shared by the local-CLI probe, the remote-host
/// probe, and the compatibility test.
pub(crate) const REQUIRED_TW_RPC_CAPABILITIES: [&str; 9] = [
    "incarnation-list.v1",
    "reservation-correlation.v1",
    "correlated-create-worktree.v1",
    "resolved-create-worktree.v1",
    "correlated-create-terminal.v1",
    "expected-incarnation-kill-session.v1",
    "hard-timeout.v1",
    "dashboard-lifecycle.v2",
    "project-catalog.v2",
];

/// A TW RPC peer is compatible when it speaks protocol version 2 and
/// provides every [`REQUIRED_TW_RPC_CAPABILITIES`] entry.
pub(crate) fn tw_rpc_capabilities_compatible(
    protocol_version: u32,
    capabilities: &[String],
) -> bool {
    protocol_version == 2
        && REQUIRED_TW_RPC_CAPABILITIES
            .iter()
            .all(|required| capabilities.iter().any(|capability| capability == required))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TwRpcCapabilitiesResponse {
    pub(crate) protocol_version: u32,
    pub(crate) capabilities: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TwRpcListResponse {
    pub(crate) protocol_version: u32,
    pub(crate) sessions: Vec<TwRpcSession>,
}

#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TwRpcSession {
    pub(crate) name: String,
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) project: Option<String>,
    #[serde(default)]
    pub(crate) label: Option<String>,
    pub(crate) attached: bool,
    pub(crate) windows: u32,
    pub(crate) created: u64,
    pub(crate) activity: u64,
    pub(crate) cwd: String,
    pub(crate) lifecycle_marked: bool,
}

#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TwRpcCreateResponse {
    pub(crate) protocol_version: u32,
    pub(crate) operation: String,
    pub(crate) state: String,
    #[serde(default)]
    pub(crate) session: Option<TwRpcSession>,
    #[serde(default)]
    pub(crate) error: Option<TwRpcError>,
}

#[derive(Deserialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct TwRpcError {
    pub(crate) code: String,
    pub(crate) message: String,
}
