use crate::ipc::HostStatus;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostConfig {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) host: String,
    pub(crate) user: Option<String>,
    pub(crate) port: Option<u16>,
    pub(crate) identity_file: Option<String>,
    #[serde(default)]
    pub(crate) worktree_base: Option<String>,
    #[serde(default)]
    pub(crate) tmux_path: Option<String>,
    #[serde(default)]
    pub(crate) tw_path: Option<String>,
}

pub(crate) fn validate_host_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(
            "host id may contain only letters, numbers, '.', '_' and '-' (maximum 80 characters)"
                .to_string(),
        );
    }
    if id.eq_ignore_ascii_case("local") {
        return Err("host id 'local' is reserved for the local control plane".to_string());
    }
    Ok(())
}

pub(crate) fn validate_ssh_host_fields(host: &HostConfig) -> Result<(), String> {
    validate_host_id(&host.id)?;
    let target = host.host.as_str();
    if target.is_empty() {
        return Err("host target required".to_string());
    }
    if target.starts_with('-') {
        return Err("host target cannot start with '-'".to_string());
    }
    if target.contains('@') {
        return Err("host target must not include a user; use the user field".to_string());
    }
    if target
        .chars()
        .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err("host target cannot contain whitespace or control characters".to_string());
    }

    if let Some(user) = host.user.as_deref() {
        if user.is_empty() {
            return Err("SSH user cannot be empty".to_string());
        }
        if user.starts_with('-') {
            return Err("SSH user cannot start with '-'".to_string());
        }
        if user.contains('@') {
            return Err("SSH user cannot contain '@'".to_string());
        }
        if user
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
        {
            return Err("SSH user cannot contain whitespace or control characters".to_string());
        }
    }

    if let Some(identity_file) = host.identity_file.as_deref() {
        if identity_file.is_empty() {
            return Err("identity file cannot be empty".to_string());
        }
        if identity_file.starts_with('-') {
            return Err("identity file cannot start with '-'".to_string());
        }
        if identity_file.chars().any(char::is_control) {
            return Err("identity file cannot contain control characters".to_string());
        }
    }
    Ok(())
}

pub(crate) struct CachedHostStatus {
    pub(crate) status: HostStatus,
    pub(crate) checked_at: Instant,
}

#[derive(Default)]
pub(crate) struct HostState {
    pub(crate) statuses: Mutex<HashMap<String, CachedHostStatus>>,
}
