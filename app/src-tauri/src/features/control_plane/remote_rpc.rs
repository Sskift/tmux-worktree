use crate::ipc::TwRpcCapabilitiesResponse;
use crate::remote::{run_remote_tw_check, HostConfig};

pub(crate) fn remote_tw_version(host: &HostConfig) -> Result<String, String> {
    run_remote_tw_check(host, &["version"])
        .map(|version| version.lines().next().unwrap_or("").trim().to_string())
}

pub(crate) fn remote_tw_capabilities(
    host: &HostConfig,
) -> Result<TwRpcCapabilitiesResponse, String> {
    let output = run_remote_tw_check(host, &["rpc-v2", "capabilities"])?;
    serde_json::from_str(&output).map_err(|error| format!("parse tw rpc-v2 capabilities: {error}"))
}
