use super::{
    bundled_cli_path, remote_tw_capabilities, remote_tw_version, scp_cli_to_host,
    tw_rpc_capabilities_compatible,
};
use crate::config::{
    add_host_config, find_host, load_hosts, remove_host_config, trimmed_non_empty_string,
    update_host_config, AddHostArgs, UpdateHostArgs,
};
use crate::ipc::HostStatus;
use crate::remote::{
    run_remote_cmd_check, run_remote_tmux_check, validate_ssh_host_fields, HostConfig,
};
use crate::support::{expand_home_path, remote_path_expr, shell_quote};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tauri::State;

const HOST_STATUS_CACHE_MS: u64 = 5000;
const TW_GITHUB_REPO: &str = "https://github.com/Sskift/tmux-worktree.git";

pub(crate) struct CachedHostStatus {
    pub(crate) status: HostStatus,
    pub(crate) checked_at: Instant,
}

#[derive(Default)]
pub(crate) struct HostState {
    pub(crate) statuses: Mutex<HashMap<String, CachedHostStatus>>,
}

fn probe_host_status(host: &HostConfig) -> HostStatus {
    let start = Instant::now();
    let ssh_result = run_remote_cmd_check(host, &["true"]);
    let latency = start.elapsed().as_millis() as u64;
    if let Err(error) = ssh_result {
        return HostStatus {
            id: host.id.clone(),
            label: host.label.clone(),
            reachable: false,
            latency_ms: None,
            error: Some(error),
            tmux_available: false,
            tmux_version: None,
            tmux_error: None,
            tw_available: false,
            tw_version: None,
            tw_error: None,
            tw_protocol_version: None,
            tw_capabilities: vec![],
            tw_compatible: false,
        };
    }

    let tmux = run_remote_tmux_check(host, &["-V"]);
    let (tmux_available, tmux_version, tmux_error) = match tmux {
        Ok(version) => (true, Some(version), None),
        Err(error) => (false, None, Some(error)),
    };
    let tw_version = remote_tw_version(host);
    let (tw_available, tw_version, tw_error, tw_protocol_version, tw_capabilities, tw_compatible) =
        match tw_version {
            Ok(version) => match remote_tw_capabilities(host) {
                Ok(capabilities) => {
                    let compatible = tw_rpc_capabilities_compatible(
                        capabilities.protocol_version,
                        &capabilities.capabilities,
                    );
                    (
                        true,
                        Some(version),
                        if compatible {
                            None
                        } else {
                            Some("remote tw RPC capabilities are incompatible".to_string())
                        },
                        Some(capabilities.protocol_version),
                        capabilities.capabilities,
                        compatible,
                    )
                }
                Err(error) => (true, Some(version), Some(error), None, vec![], false),
            },
            Err(error) => (false, None, Some(error), None, vec![], false),
        };
    HostStatus {
        id: host.id.clone(),
        label: host.label.clone(),
        reachable: true,
        latency_ms: Some(latency),
        error: None,
        tmux_available,
        tmux_version,
        tmux_error,
        tw_available,
        tw_version,
        tw_error,
        tw_protocol_version,
        tw_capabilities,
        tw_compatible,
    }
}

#[tauri::command]
pub(crate) fn test_host(args: AddHostArgs) -> Result<HostStatus, String> {
    let host = HostConfig {
        id: args.id.trim().to_string(),
        label: args.label.trim().to_string(),
        host: args.host.trim().to_string(),
        user: args
            .user
            .filter(|u| !u.trim().is_empty())
            .map(|u| u.trim().to_string()),
        port: args.port,
        identity_file: args
            .identity_file
            .filter(|p| !p.trim().is_empty())
            .map(|p| expand_home_path(p.trim())),
        worktree_base: args
            .worktree_base
            .as_deref()
            .and_then(trimmed_non_empty_string),
        tmux_path: args.tmux_path.as_deref().and_then(trimmed_non_empty_string),
        tw_path: args.tw_path.as_deref().and_then(trimmed_non_empty_string),
    };
    validate_ssh_host_fields(&host)?;
    Ok(probe_host_status(&host))
}

pub(crate) fn install_host_tw_from_source(host: &HostConfig) -> Result<HostStatus, String> {
    let script = format!(
        r#"set -e
repo={}
tag={}
root="$HOME/.local/src/tmux-worktree"
mkdir -p "$HOME/.local/src"
if [ -d "$root/.git" ]; then
  git -C "$root" fetch origin "refs/tags/$tag:refs/tags/$tag" --force
  git -C "$root" checkout --detach "$tag"
else
  rm -rf "$root"
  git clone --depth 1 --branch "$tag" "$repo" "$root"
fi
cd "$root"
npm install
npm run build
npm link --prefix "$HOME/.local"
"#,
        shell_quote(TW_GITHUB_REPO),
        shell_quote(&format!("v{}", env!("CARGO_PKG_VERSION")))
    );
    run_remote_cmd_check(host, &["sh", "-lc", &script])
        .map_err(|e| format!("install remote tw on {}: {e}", host.label))?;
    Ok(probe_host_status(host))
}

fn install_host_tw_from_bundled_cli(host: &HostConfig, cli: &Path) -> Result<HostStatus, String> {
    run_remote_cmd_check(host, &["sh", "-lc", "mkdir -p \"$HOME/.tmux-worktree\""])?;
    scp_cli_to_host(host, cli, ".tmux-worktree/tw-cli.cjs")?;
    let install_path = remote_path_expr(host.tw_path.as_deref().unwrap_or("~/.local/bin/tw"));
    let script = format!(
        r#"set -e
target={install_path}
mkdir -p "$(dirname "$target")"
cat > "$target" <<'EOF'
#!/bin/sh
exec /usr/bin/env node "$HOME/.tmux-worktree/tw-cli.cjs" "$@"
EOF
chmod 700 "$target"
"#
    );
    run_remote_cmd_check(host, &["sh", "-lc", &script])
        .map_err(|error| format!("install bundled tw on {}: {error}", host.label))?;
    Ok(probe_host_status(host))
}

#[tauri::command]
pub(crate) fn install_host_tw(
    app: tauri::AppHandle,
    host_id: String,
) -> Result<HostStatus, String> {
    let host = find_host(host_id.trim())?;
    if let Some(cli) = bundled_cli_path(&app) {
        install_host_tw_from_bundled_cli(&host, &cli)
    } else {
        install_host_tw_from_source(&host)
    }
}

#[tauri::command]
pub(crate) async fn host_statuses(
    state: State<'_, Arc<HostState>>,
) -> Result<Vec<HostStatus>, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || host_statuses_blocking(state))
        .await
        .map_err(|e| format!("host statuses task failed: {e}"))?
}

fn host_statuses_blocking(state: Arc<HostState>) -> Result<Vec<HostStatus>, String> {
    let hosts = load_hosts()?;
    let now = Instant::now();
    let mut statuses = Vec::new();

    for host in &hosts {
        // Check cache first
        {
            let cached = state.statuses.lock().unwrap();
            if let Some(cached_status) = cached.get(&host.id) {
                if now.duration_since(cached_status.checked_at).as_millis()
                    < HOST_STATUS_CACHE_MS as u128
                {
                    statuses.push(cached_status.status.clone());
                    continue;
                }
            }
        }

        let status = probe_host_status(host);

        // Cache the result
        {
            let mut cached = state.statuses.lock().unwrap();
            cached.insert(
                host.id.clone(),
                CachedHostStatus {
                    status: status.clone(),
                    checked_at: now,
                },
            );
        }

        statuses.push(status);
    }

    Ok(statuses)
}

pub(crate) fn invalidate_host_status_cache(state: &HostState, id: &str) -> Result<(), String> {
    state
        .statuses
        .lock()
        .map_err(|_| "host status cache lock poisoned".to_string())?
        .remove(id);
    Ok(())
}

pub(crate) fn add_host_with_state(
    args: AddHostArgs,
    state: &HostState,
) -> Result<Vec<HostConfig>, String> {
    let id = args.id.trim().to_string();
    let hosts = add_host_config(args)?;
    invalidate_host_status_cache(state, &id)?;
    Ok(hosts)
}

#[tauri::command]
pub(crate) fn add_host(
    args: AddHostArgs,
    state: State<'_, Arc<HostState>>,
) -> Result<Vec<HostConfig>, String> {
    add_host_with_state(args, state.inner().as_ref())
}

#[tauri::command]
pub(crate) fn update_host(
    args: UpdateHostArgs,
    state: State<'_, Arc<HostState>>,
) -> Result<Vec<HostConfig>, String> {
    let id = args.id.trim().to_string();
    let hosts = update_host_config(args)?;
    invalidate_host_status_cache(state.inner().as_ref(), &id)?;
    Ok(hosts)
}

pub(crate) fn remove_host_with_state(
    id: String,
    state: &HostState,
) -> Result<Vec<HostConfig>, String> {
    let id = id.trim().to_string();
    let hosts = remove_host_config(&id)?;
    invalidate_host_status_cache(state, &id)?;
    Ok(hosts)
}

#[tauri::command]
pub(crate) fn remove_host(
    id: String,
    state: State<'_, Arc<HostState>>,
) -> Result<Vec<HostConfig>, String> {
    remove_host_with_state(id, state.inner().as_ref())
}
