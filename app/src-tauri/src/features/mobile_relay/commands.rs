use super::broker::{
    mobile_relay_secret, start_mobile_relay_broker_on_host,
    start_mobile_relay_quick_tunnel_on_host, stop_mobile_relay_broker_on_host,
    stop_mobile_relay_quick_tunnel_on_host,
};
use super::model::{MobileRelayState, RelayHostRuntimeStatus};
use super::network::{
    is_cloudflare_quick_tunnel_url, preserved_mobile_relay_url_after_broker_start, tcp_port_open,
    validate_mobile_relay_connector_url,
};
use super::persistence::{
    mobile_relay_config, mobile_relay_status_file, preflight_mobile_relay_config_write,
    save_mobile_relay_config_file,
};
use super::runtime::{
    read_serve_token, spawn_relay_host, spawn_serve, stop_managed_serve,
    stop_mobile_relay_processes,
};
use crate::config::find_host;
use crate::ipc::{MobileRelayBrokerInput, MobileRelayConfigInput, MobileRelayStatus};
use std::sync::Arc;
use tauri::State;

fn set_mobile_relay_error(state: &MobileRelayState, message: Option<String>) {
    let mut last_error = state.last_error.lock().unwrap();
    *last_error = message;
}

fn load_mobile_relay_runtime_status() -> Option<RelayHostRuntimeStatus> {
    let content = std::fs::read_to_string(mobile_relay_status_file()).ok()?;
    serde_json::from_str(&content).ok()
}

#[tauri::command]
pub(crate) fn mobile_relay_start(
    app: tauri::AppHandle,
    state: State<'_, Arc<MobileRelayState>>,
) -> Result<(), String> {
    set_mobile_relay_error(state.inner(), None);
    let mut proc = state.process.lock().unwrap();
    if proc.is_some() {
        return Ok(());
    }

    let config = mobile_relay_config();
    let relay_url = validate_mobile_relay_connector_url(&config.relay_url).map_err(|err| {
        set_mobile_relay_error(state.inner(), Some(err.clone()));
        err
    })?;
    if config.secret.trim().is_empty() {
        let message = "Relay token is required before starting the connector".to_string();
        set_mobile_relay_error(state.inner(), Some(message.clone()));
        return Err(message);
    }

    if !tcp_port_open(8311) {
        let child = spawn_serve(&app).map_err(|err| {
            set_mobile_relay_error(state.inner(), Some(err.clone()));
            err
        })?;
        let mut serve = state.serve_process.lock().unwrap();
        *serve = Some(child);
    }

    let tok = read_serve_token();
    {
        let mut t = state.token.lock().unwrap();
        *t = tok.clone();
    }

    let _ = std::fs::remove_file(mobile_relay_status_file());

    let child = spawn_relay_host(
        &app,
        &relay_url,
        &config.host_id,
        &config.display_name,
        &config.secret,
        &tok,
    )
    .map_err(|err| {
        set_mobile_relay_error(state.inner(), Some(err.clone()));
        stop_managed_serve(state.inner());
        err
    })?;

    *state.relay_url.lock().unwrap() = relay_url;
    *state.host_id.lock().unwrap() = config.host_id;
    *state.secret.lock().unwrap() = config.secret;
    *proc = Some(child);

    Ok(())
}

#[tauri::command]
pub(crate) fn mobile_relay_save_config(
    args: MobileRelayConfigInput,
    state: State<'_, Arc<MobileRelayState>>,
) -> Result<MobileRelayStatus, String> {
    let config = save_mobile_relay_config_file(&args)?;
    *state.relay_url.lock().unwrap() = config.relay_url;
    *state.broker_host_id.lock().unwrap() = config.broker_host_id;
    *state.host_id.lock().unwrap() = config.host_id;
    *state.secret.lock().unwrap() = config.secret;
    set_mobile_relay_error(state.inner(), None);
    Ok(mobile_relay_status_from_state(state.inner()))
}

#[tauri::command]
pub(crate) async fn mobile_relay_start_broker(
    app: tauri::AppHandle,
    args: MobileRelayBrokerInput,
    state: State<'_, Arc<MobileRelayState>>,
) -> Result<MobileRelayStatus, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        mobile_relay_start_broker_blocking(app, args, state)
    })
    .await
    .map_err(|error| format!("Relay setup task failed: {error}"))?
}

fn mobile_relay_start_broker_blocking(
    app: tauri::AppHandle,
    args: MobileRelayBrokerInput,
    state: Arc<MobileRelayState>,
) -> Result<MobileRelayStatus, String> {
    if state.process.lock().unwrap().is_some() {
        return Err(
            "Stop the Mac connector before restarting the broker because Start broker rotates the shared Relay v1 token"
                .to_string(),
        );
    }
    preflight_mobile_relay_config_write()?;
    let host = find_host(args.host_id.trim())?;
    let port = args.port.unwrap_or(8787);
    let current_config = mobile_relay_config();
    let preserved_relay_url = preserved_mobile_relay_url_after_broker_start(
        &current_config.relay_url,
        &current_config.broker_host_id,
        &host.id,
    );
    let needs_quick_tunnel =
        preserved_relay_url.is_empty() || is_cloudflare_quick_tunnel_url(&preserved_relay_url);
    let (relay_url, quick_tunnel_started) = if needs_quick_tunnel {
        if !args.quick_tunnel.unwrap_or(false) {
            let message =
                "A trusted WSS URL is required. Enable automatic Quick Tunnel setup or save this Relay center's fixed wss:// URL."
                    .to_string();
            set_mobile_relay_error(state.as_ref(), Some(message.clone()));
            return Err(message);
        }
        let published_url = match start_mobile_relay_quick_tunnel_on_host(&host, port) {
            Ok(url) => url,
            Err(err) => {
                let message = match stop_mobile_relay_quick_tunnel_on_host(&host) {
                    Ok(()) => err,
                    Err(cleanup_err) => {
                        format!(
                            "{err}; temporary WSS cleanup could not be confirmed: {cleanup_err}"
                        )
                    }
                };
                set_mobile_relay_error(state.as_ref(), Some(message.clone()));
                return Err(message);
            }
        };
        let validated_url = match validate_mobile_relay_connector_url(&published_url) {
            Ok(url) if is_cloudflare_quick_tunnel_url(&url) => url,
            _ => {
                let message = match stop_mobile_relay_quick_tunnel_on_host(&host) {
                    Ok(()) => "Automatic WSS setup returned an unexpected URL; the temporary tunnel was stopped"
                        .to_string(),
                    Err(cleanup_err) => format!(
                        "Automatic WSS setup returned an unexpected URL, and temporary tunnel cleanup could not be confirmed: {cleanup_err}"
                    ),
                };
                set_mobile_relay_error(state.as_ref(), Some(message.clone()));
                return Err(message);
            }
        };
        (validated_url, true)
    } else {
        (preserved_relay_url, false)
    };
    let secret = mobile_relay_secret();
    if let Err(err) = start_mobile_relay_broker_on_host(&app, &host, port, &secret) {
        let message = if quick_tunnel_started {
            match stop_mobile_relay_quick_tunnel_on_host(&host) {
                Ok(()) => err,
                Err(cleanup_err) => {
                    format!("{err}; temporary WSS cleanup could not be confirmed: {cleanup_err}")
                }
            }
        } else {
            err
        };
        set_mobile_relay_error(state.as_ref(), Some(message.clone()));
        return Err(message);
    }
    // A Quick Tunnel can publish its URL before the corresponding DNS record
    // reaches the Mac's resolver. The relay-host already owns reconnect/backoff
    // semantics, so keep the valid remote tunnel and broker alive, save the
    // generated profile, and let the connector converge instead of treating
    // DNS propagation as a destructive setup failure.
    let config = MobileRelayConfigInput {
        relay_url,
        broker_host_id: host.id.clone(),
        host_id: current_config.host_id,
        secret,
    };
    let saved = match save_mobile_relay_config_file(&config) {
        Ok(saved) => saved,
        Err(err) => {
            let mut cleanup_errors = Vec::new();
            if let Err(cleanup_err) = stop_mobile_relay_broker_on_host(&host) {
                cleanup_errors.push(format!("broker: {cleanup_err}"));
            }
            if quick_tunnel_started {
                if let Err(cleanup_err) = stop_mobile_relay_quick_tunnel_on_host(&host) {
                    cleanup_errors.push(format!("temporary WSS: {cleanup_err}"));
                }
            }
            let cleanup_status = if cleanup_errors.is_empty() {
                "the remote setup was stopped".to_string()
            } else {
                format!(
                    "remote cleanup could not be confirmed ({})",
                    cleanup_errors.join("; ")
                )
            };
            let message = format!(
                "Relay broker started, but its local configuration could not be saved; {cleanup_status}: {err}"
            );
            set_mobile_relay_error(state.as_ref(), Some(message.clone()));
            return Err(message);
        }
    };
    *state.relay_url.lock().unwrap() = saved.relay_url;
    *state.broker_host_id.lock().unwrap() = saved.broker_host_id;
    *state.host_id.lock().unwrap() = saved.host_id;
    *state.secret.lock().unwrap() = saved.secret;
    set_mobile_relay_error(state.as_ref(), None);
    Ok(mobile_relay_status_from_state(state.as_ref()))
}

#[tauri::command]
pub(crate) fn mobile_relay_stop(state: State<'_, Arc<MobileRelayState>>) -> Result<(), String> {
    stop_mobile_relay_processes(state.inner());
    set_mobile_relay_error(state.inner(), None);
    Ok(())
}

#[tauri::command]
pub(crate) fn mobile_relay_status(state: State<'_, Arc<MobileRelayState>>) -> MobileRelayStatus {
    mobile_relay_status_from_state(state.inner())
}

fn mobile_relay_status_from_state(state: &MobileRelayState) -> MobileRelayStatus {
    let mut proc = state.process.lock().unwrap();
    let mut process_error = None;
    if let Some(ref mut child) = *proc {
        match child.try_wait() {
            Ok(Some(status)) => {
                *proc = None;
                process_error = Some(format!("Mobile relay connector exited: {status}"));
            }
            _ => {}
        }
    }
    if let Some(message) = process_error {
        set_mobile_relay_error(state, Some(message));
    }
    let active = proc.is_some();
    let default_config = mobile_relay_config();
    let relay_url = state.relay_url.lock().unwrap();
    let broker_host_id = state.broker_host_id.lock().unwrap();
    let host_id = state.host_id.lock().unwrap();
    let secret = state.secret.lock().unwrap();
    let token = state.token.lock().unwrap();
    let resolved_relay_url = if relay_url.is_empty() {
        default_config.relay_url
    } else {
        relay_url.clone()
    };
    let resolved_host_id = if host_id.is_empty() {
        default_config.host_id
    } else {
        host_id.clone()
    };
    let resolved_broker_host_id = if broker_host_id.is_empty() {
        default_config.broker_host_id
    } else {
        broker_host_id.clone()
    };
    let runtime = active
        .then(load_mobile_relay_runtime_status)
        .flatten()
        .filter(|status| {
            status.relay_url == resolved_relay_url && status.host_id == resolved_host_id
        });
    let connection_state = if !active {
        "stopped".to_string()
    } else {
        runtime
            .as_ref()
            .map(|status| status.state.clone())
            .filter(|status| !status.is_empty())
            .unwrap_or_else(|| "starting".to_string())
    };
    let connected = active && connection_state == "connected";
    let runtime_error = runtime.as_ref().and_then(|status| status.error.clone());
    let error = state.last_error.lock().unwrap().clone().or(runtime_error);
    MobileRelayStatus {
        active,
        connected,
        connection_state,
        relay_url: resolved_relay_url,
        broker_host_id: resolved_broker_host_id,
        host_id: resolved_host_id,
        secret: if secret.is_empty() {
            default_config.secret
        } else {
            secret.clone()
        },
        token: token.clone(),
        connected_at: runtime.as_ref().and_then(|status| status.connected_at),
        updated_at: runtime.as_ref().and_then(|status| status.updated_at),
        retry_in_ms: runtime.as_ref().and_then(|status| status.retry_in_ms),
        error,
    }
}
