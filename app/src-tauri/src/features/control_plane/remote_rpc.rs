use crate::ipc::TwRpcCapabilitiesResponse;
use crate::remote::{run_remote_tw_check, HostConfig};

pub(crate) fn remote_tw_version(host: &HostConfig) -> Result<String, String> {
    run_remote_tw_check(host, &["version"])
        .map(|version| version.lines().next().unwrap_or("").trim().to_string())
}

pub(crate) fn remote_tw_capabilities(
    host: &HostConfig,
) -> Result<TwRpcCapabilitiesResponse, String> {
    let output = run_remote_tw_check(host, &["rpc", "capabilities"])?;
    serde_json::from_str(&output).map_err(|error| format!("parse tw rpc capabilities: {error}"))
}

pub(crate) fn tw_rpc_capabilities_compatible(
    protocol_version: u32,
    capabilities: &[String],
) -> bool {
    protocol_version == 1
        && [
            "list",
            "create-worktree",
            "create-terminal",
            "kill-session",
            "hard-timeout",
        ]
        .iter()
        .all(|required| capabilities.iter().any(|capability| capability == required))
}
