use super::{bundled_cli_path, installed_tw_command, node_bin};
use crate::ipc::{TwRpcCapabilitiesResponse, TwRpcCreateResponse, TwRpcSession};
use crate::support::app_home_dir;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum LocalTwRpcRuntime {
    Bundled { node: String, cli: PathBuf },
    Installed { tw: String },
}

impl LocalTwRpcRuntime {
    pub(crate) fn audit_label(&self) -> &'static str {
        match self {
            Self::Bundled { .. } => "bundled same-version TW runtime",
            Self::Installed { .. } => "installed same-version TW fallback",
        }
    }
}

fn installed_tw_version(program: &str, home: &Path) -> Result<String, String> {
    let output = std::process::Command::new(program)
        .arg("version")
        .env("HOME", home)
        .env("TW_DASHBOARD_HOME", home)
        .output()
        .map_err(|error| format!("run {program} version: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "{program} version exited {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn validate_installed_tw_rpc(program: &str, home: &Path) -> Result<(), String> {
    let output = std::process::Command::new(program)
        .args(["rpc-v2", "capabilities"])
        .env("HOME", home)
        .env("TW_DASHBOARD_HOME", home)
        .output()
        .map_err(|error| format!("run {program} rpc-v2 capabilities: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "{program} rpc-v2 capabilities exited {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let response: TwRpcCapabilitiesResponse = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("parse {program} rpc-v2 capabilities: {error}"))?;
    let required = [
        "incarnation-list.v1",
        "reservation-correlation.v1",
        "correlated-create-worktree.v1",
        "resolved-create-worktree.v1",
        "correlated-create-terminal.v1",
        "expected-incarnation-kill-session.v1",
        "hard-timeout.v1",
        "dashboard-lifecycle.v2",
    ];
    if response.protocol_version != 2
        || required.iter().any(|required| {
            !response
                .capabilities
                .iter()
                .any(|capability| capability == required)
        })
    {
        return Err(format!(
            "{program} does not provide the complete Dashboard TW RPC v2 contract"
        ));
    }
    Ok(())
}

pub(crate) fn build_tw_rpc_v2_args(operation: &str, request: serde_json::Value) -> Vec<String> {
    vec![
        "rpc-v2".to_string(),
        operation.to_string(),
        "--request-json".to_string(),
        request.to_string(),
    ]
}

pub(crate) fn parse_tw_rpc_v2_create_response(
    output: &str,
    runtime_label: &str,
    expected_operation: &str,
    expected_kind: &str,
) -> Result<TwRpcSession, String> {
    let response: TwRpcCreateResponse = serde_json::from_str(output.trim())
        .map_err(|error| format!("parse {runtime_label} {expected_operation} response: {error}"))?;
    if response.protocol_version != 2 || response.operation != expected_operation {
        return Err(format!(
            "{runtime_label} returned an incompatible TW RPC v2 {expected_operation} response"
        ));
    }
    if response.state != "succeeded" {
        let detail = response
            .error
            .map(|error| format!("{}: {}", error.code, error.message))
            .unwrap_or_else(|| response.state.clone());
        return Err(format!(
            "{runtime_label} {expected_operation} did not succeed: {detail}"
        ));
    }
    let session = response
        .session
        .ok_or_else(|| format!("{runtime_label} {expected_operation} returned no session"))?;
    if session.kind != expected_kind || !session.lifecycle_marked || session.name.trim().is_empty()
    {
        return Err(format!(
            "{runtime_label} {expected_operation} returned a non-authoritative session"
        ));
    }
    Ok(session)
}

pub(crate) fn select_local_tw_rpc_runtime(
    bundled_cli: Option<PathBuf>,
    node: Option<String>,
    installed_tw: Option<String>,
    home: &Path,
) -> Result<LocalTwRpcRuntime, String> {
    if let (Some(cli), Some(node)) = (bundled_cli.as_ref(), node.as_ref()) {
        return Ok(LocalTwRpcRuntime::Bundled {
            node: node.clone(),
            cli: cli.clone(),
        });
    }

    let mut failures = Vec::new();
    if bundled_cli.is_none() {
        failures.push("bundled CLI resource not found".to_string());
    } else if node.is_none() {
        failures.push("Node.js 20+ not found for bundled CLI".to_string());
    }

    if let Some(tw) = installed_tw {
        match installed_tw_version(&tw, home) {
            Ok(version) if version == env!("CARGO_PKG_VERSION") => {
                match validate_installed_tw_rpc(&tw, home) {
                    Ok(()) => return Ok(LocalTwRpcRuntime::Installed { tw }),
                    Err(error) => failures.push(error),
                }
            }
            Ok(version) => failures.push(format!(
                "installed tw version {version:?} does not match Dashboard {}",
                env!("CARGO_PKG_VERSION")
            )),
            Err(error) => failures.push(error),
        }
    } else {
        failures.push("installed tw/tmux-worktree command not found".to_string());
    }

    Err(format!(
        "Canonical local TW runtime unavailable: {}. Direct Rust/tmux lifecycle fallbacks are intentionally disabled so Dashboard cannot silently create a different session contract. Install Node.js 20+ or install a compatible tw {}.",
        failures.join("; "),
        env!("CARGO_PKG_VERSION")
    ))
}

pub(crate) fn resolve_local_tw_rpc_runtime(
    app: &tauri::AppHandle,
    home: &Path,
) -> Result<LocalTwRpcRuntime, String> {
    select_local_tw_rpc_runtime(
        bundled_cli_path(app),
        node_bin(),
        installed_tw_command(),
        home,
    )
}

pub(crate) fn run_local_tw_rpc_runtime(
    runtime: &LocalTwRpcRuntime,
    rpc_args: &[String],
    operation: &str,
) -> Result<String, String> {
    let home = app_home_dir().ok_or("home dir not found")?;
    let mut command = match runtime {
        LocalTwRpcRuntime::Bundled { node, cli } => {
            let mut command = std::process::Command::new(node);
            command.arg(cli);
            command
        }
        LocalTwRpcRuntime::Installed { tw } => std::process::Command::new(tw),
    };
    let output = command
        .args(rpc_args)
        // The bundled Node CLI uses os.homedir(), while isolated Dashboard
        // tests and dev builds use TW_DASHBOARD_HOME. Keep both views aligned.
        .env("HOME", &home)
        .env("TW_DASHBOARD_HOME", &home)
        .output()
        .map_err(|error| format!("spawn {}: {error}", runtime.audit_label()))?;
    if !output.status.success() {
        return Err(format!(
            "{} {operation} failed ({}): {}. No secondary creator was attempted.",
            runtime.audit_label(),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
