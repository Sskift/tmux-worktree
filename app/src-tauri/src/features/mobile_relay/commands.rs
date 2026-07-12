use super::broker::{mobile_relay_secret, start_mobile_relay_broker_on_host};
use super::model::{MobileRelayState, RelayHostRuntimeStatus};
use super::network::{
    mobile_relay_forward_url_for_host, should_preserve_mobile_relay_url, tcp_port_open,
};
use super::persistence::{
    mobile_relay_config, mobile_relay_status_file, save_mobile_relay_config_file,
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

    let config = mobile_relay_config();
    if config.secret.trim().is_empty() {
        let message = "Relay token is required before Android can connect".to_string();
        set_mobile_relay_error(state.inner(), Some(message.clone()));
        stop_managed_serve(state.inner());
        return Err(message);
    }

    let _ = std::fs::remove_file(mobile_relay_status_file());

    let child = spawn_relay_host(
        &app,
        &config.relay_url,
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

    *state.relay_url.lock().unwrap() = config.relay_url;
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
    *state.host_id.lock().unwrap() = config.host_id;
    *state.secret.lock().unwrap() = config.secret;
    set_mobile_relay_error(state.inner(), None);
    Ok(mobile_relay_status(state))
}

#[tauri::command]
pub(crate) fn mobile_relay_start_broker(
    app: tauri::AppHandle,
    args: MobileRelayBrokerInput,
    state: State<'_, Arc<MobileRelayState>>,
) -> Result<MobileRelayStatus, String> {
    let host = find_host(args.host_id.trim())?;
    let port = args.port.unwrap_or(8787);
    let secret = mobile_relay_secret();
    start_mobile_relay_broker_on_host(&app, &host, port, &secret).map_err(|err| {
        set_mobile_relay_error(state.inner(), Some(err.clone()));
        err
    })?;
    let current_config = mobile_relay_config();
    let relay_url = match mobile_relay_forward_url_for_host(&host, port) {
        Ok(url) => url,
        Err(_) if should_preserve_mobile_relay_url(&current_config.relay_url, &host, port) => {
            current_config.relay_url
        }
        Err(err) => {
            set_mobile_relay_error(state.inner(), Some(err.clone()));
            return Err(err);
        }
    };
    let config = MobileRelayConfigInput {
        relay_url,
        host_id: "mac-admin".to_string(),
        secret,
    };
    let saved = save_mobile_relay_config_file(&config)?;
    *state.relay_url.lock().unwrap() = saved.relay_url;
    *state.host_id.lock().unwrap() = saved.host_id;
    *state.secret.lock().unwrap() = saved.secret;
    set_mobile_relay_error(state.inner(), None);
    Ok(mobile_relay_status(state))
}

#[tauri::command]
pub(crate) fn mobile_relay_stop(state: State<'_, Arc<MobileRelayState>>) -> Result<(), String> {
    stop_mobile_relay_processes(state.inner());
    set_mobile_relay_error(state.inner(), None);
    Ok(())
}

#[tauri::command]
pub(crate) fn mobile_relay_status(state: State<'_, Arc<MobileRelayState>>) -> MobileRelayStatus {
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
        set_mobile_relay_error(state.inner(), Some(message));
    }
    let active = proc.is_some();
    let default_config = mobile_relay_config();
    let relay_url = state.relay_url.lock().unwrap();
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
