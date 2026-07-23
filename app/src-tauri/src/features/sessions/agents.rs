use crate::config::find_host;
use crate::ipc::AgentProbeResult;
use crate::remote::{run_remote_cmd_check_strings, HostConfig};
use crate::support::user_bin_search_paths;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy)]
pub(crate) struct AgentProbeSpec {
    pub(crate) id: &'static str,
    pub(crate) label: &'static str,
    pub(crate) command: &'static str,
}

pub(crate) const AGENT_PROBE_SPECS: [AgentProbeSpec; 6] = [
    AgentProbeSpec {
        id: "claude",
        label: "Claude Code",
        command: "claude",
    },
    AgentProbeSpec {
        id: "codex",
        label: "Codex",
        command: "codex",
    },
    AgentProbeSpec {
        id: "gemini",
        label: "Gemini CLI",
        command: "gemini",
    },
    AgentProbeSpec {
        id: "opencode",
        label: "OpenCode",
        command: "opencode",
    },
    AgentProbeSpec {
        id: "aider",
        label: "Aider",
        command: "aider",
    },
    AgentProbeSpec {
        id: "kimi",
        label: "Kimi Code",
        command: "kimi",
    },
];

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub(crate) fn probe_local_agents_in_paths(search_paths: &[PathBuf]) -> Vec<AgentProbeResult> {
    AGENT_PROBE_SPECS
        .iter()
        .map(|spec| {
            let executable_path = search_paths
                .iter()
                .map(|directory| directory.join(spec.command))
                .find(|candidate| is_executable_file(candidate))
                .map(|candidate| candidate.to_string_lossy().to_string());
            AgentProbeResult {
                id: spec.id.to_string(),
                label: spec.label.to_string(),
                command: spec.command.to_string(),
                available: executable_path.is_some(),
                executable_path,
                error: None,
            }
        })
        .collect()
}

fn probe_local_agents() -> Vec<AgentProbeResult> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let inherited_path = std::env::var_os("PATH");
    let search_paths = user_bin_search_paths(home.as_deref(), inherited_path.as_deref());
    probe_local_agents_in_paths(&search_paths)
}

fn probe_remote_agents(host: &HostConfig) -> Result<Vec<AgentProbeResult>, String> {
    // The script and every argument are fixed here. In particular, this never
    // accepts the configured aiCmd or any other user-provided shell fragment.
    const PROBE_SCRIPT: &str = r#"for agent_command do
  agent_path=$(command -v "$agent_command" 2>/dev/null || true)
  if [ -n "$agent_path" ]; then
    printf '%s\t1\t%s\n' "$agent_command" "$agent_path"
  else
    printf '%s\t0\n' "$agent_command"
  fi
done"#;

    let mut remote_command = vec![
        "sh".to_string(),
        "-c".to_string(),
        PROBE_SCRIPT.to_string(),
        "agent-probe".to_string(),
    ];
    remote_command.extend(
        AGENT_PROBE_SPECS
            .iter()
            .map(|spec| spec.command.to_string()),
    );
    let output = run_remote_cmd_check_strings(host, &remote_command)?;
    let discovered = output
        .lines()
        .filter_map(|line| {
            let mut fields = line.splitn(3, '\t');
            let command = fields.next()?.to_string();
            let available = fields.next()? == "1";
            let path = fields
                .next()
                .filter(|path| available && !path.is_empty())
                .map(str::to_string);
            Some((command, path))
        })
        .collect::<HashMap<_, _>>();

    Ok(AGENT_PROBE_SPECS
        .iter()
        .map(|spec| {
            let executable_path = discovered.get(spec.command).cloned().flatten();
            AgentProbeResult {
                id: spec.id.to_string(),
                label: spec.label.to_string(),
                command: spec.command.to_string(),
                available: executable_path.is_some(),
                executable_path,
                error: None,
            }
        })
        .collect())
}

fn probe_agents_for_host_id(host_id: Option<&str>) -> Result<Vec<AgentProbeResult>, String> {
    match host_id {
        Some(host_id) => {
            let host_id = host_id.trim();
            if host_id.is_empty() {
                return Err("host id is empty".to_string());
            }
            let host = find_host(host_id)?;
            probe_remote_agents(&host)
        }
        None => Ok(probe_local_agents()),
    }
}

#[tauri::command]
pub(crate) async fn probe_agents(host_id: Option<String>) -> Result<Vec<AgentProbeResult>, String> {
    tauri::async_runtime::spawn_blocking(move || probe_agents_for_host_id(host_id.as_deref()))
        .await
        .map_err(|error| format!("agent probe task failed: {error}"))?
}
