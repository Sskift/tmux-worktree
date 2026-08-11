use serde::Deserialize;

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
