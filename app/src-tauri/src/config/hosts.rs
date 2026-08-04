use super::{
    acquire_dashboard_config_file_lock, dashboard_config_write_lock, string_field,
    trimmed_non_empty_string,
};
use crate::remote::{validate_host_id, validate_ssh_host_fields, HostConfig};
use crate::support::{app_home_dir, atomic_write_file, expand_home_path};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

fn load_configured_hosts() -> Result<Vec<HostConfig>, String> {
    let home = app_home_dir().ok_or("home dir not found")?;
    let config_path = home.join(".tmux-worktree.json");
    if !config_path.exists() {
        return Ok(vec![]);
    }
    let content =
        std::fs::read_to_string(&config_path).map_err(|error| format!("read config: {error}"))?;
    let config: serde_json::Value =
        serde_json::from_str(&content).map_err(|error| format!("parse config: {error}"))?;
    let hosts = hosts_from_config(&config);
    for host in &hosts {
        validate_ssh_host_fields(host)
            .map_err(|error| format!("invalid SSH host '{}': {error}", host.id))?;
    }
    Ok(hosts)
}

/// Load explicitly connected host configurations from ~/.tmux-worktree.json.
pub(crate) fn load_hosts() -> Result<Vec<HostConfig>, String> {
    load_configured_hosts()
}

pub(crate) fn hosts_from_config(config: &serde_json::Value) -> Vec<HostConfig> {
    let collection = ["hosts", "remotes", "remoteHosts"]
        .into_iter()
        .find_map(|field| config.get(field));
    match collection {
        Some(serde_json::Value::Array(array)) => {
            array.iter().filter_map(host_from_config_value).collect()
        }
        Some(serde_json::Value::Object(map)) => map
            .iter()
            .filter_map(|(id, value)| host_from_named_config_value(id, value))
            .collect(),
        _ => vec![],
    }
}

fn host_from_alias(alias: &str) -> Option<HostConfig> {
    let trimmed = alias.trim();
    if trimmed.is_empty() || trimmed.contains(':') {
        return None;
    }
    Some(HostConfig {
        id: trimmed.to_string(),
        label: trimmed.to_string(),
        host: trimmed.to_string(),
        user: None,
        port: None,
        identity_file: None,
        worktree_base: None,
        tmux_path: None,
        tw_path: None,
    })
}

fn host_from_config_value(value: &serde_json::Value) -> Option<HostConfig> {
    match value {
        serde_json::Value::String(alias) => host_from_alias(alias),
        serde_json::Value::Object(_) => host_from_object_config_value(value, None),
        _ => None,
    }
}

fn host_from_object_config_value(
    value: &serde_json::Value,
    fallback_id: Option<&str>,
) -> Option<HostConfig> {
    let mut object = value.as_object()?.clone();
    let host = string_field(value, &["host", "hostname", "address"])
        .or(fallback_id)
        .map(str::to_string)?;
    let id = string_field(value, &["id", "name", "key"])
        .or(fallback_id)
        .unwrap_or(&host)
        .to_string();
    let label = string_field(value, &["label", "displayName", "display_name"])
        .unwrap_or(&id)
        .to_string();
    object.insert("id".to_string(), serde_json::Value::String(id));
    object.insert("label".to_string(), serde_json::Value::String(label));
    object.insert("host".to_string(), serde_json::Value::String(host));

    for (canonical, aliases) in [
        ("user", &["user", "username"][..]),
        (
            "identityFile",
            &["identityFile", "identity_file", "keyFile", "key_file"][..],
        ),
        (
            "worktreeBase",
            &[
                "worktreeBase",
                "worktree_base",
                "worktreeDir",
                "worktreeRoot",
                "worktreesDir",
                "worktreesRoot",
            ][..],
        ),
        (
            "tmuxPath",
            &["tmuxPath", "tmux_path", "tmuxBin", "tmux_bin"][..],
        ),
        ("twPath", &["twPath", "tw_path", "twBin", "tw_bin"][..]),
    ] {
        if let Some(field) = string_field(value, aliases) {
            object.insert(
                canonical.to_string(),
                serde_json::Value::String(field.to_string()),
            );
        }
    }
    if let Some(port) = value.get("port").and_then(|raw| {
        raw.as_u64()
            .or_else(|| raw.as_str()?.trim().parse::<u64>().ok())
            .filter(|port| (1..=65535).contains(port))
    }) {
        object.insert("port".to_string(), serde_json::json!(port));
    }
    serde_json::from_value::<HostConfig>(serde_json::Value::Object(object)).ok()
}

fn host_from_named_config_value(id: &str, value: &serde_json::Value) -> Option<HostConfig> {
    match value {
        serde_json::Value::String(host) => {
            let mut config = host_from_alias(id)?;
            config.host = host.trim().to_string();
            Some(config)
        }
        serde_json::Value::Object(map) => {
            host_from_object_config_value(&serde_json::Value::Object(map.clone()), Some(id))
        }
        _ => None,
    }
}

fn load_ssh_host_candidates() -> Vec<HostConfig> {
    let Some(home) = dirs::home_dir() else {
        return vec![];
    };
    let path = home.join(".ssh").join("config");
    let Ok(text) = std::fs::read_to_string(path) else {
        return vec![];
    };
    ssh_host_candidates_from_config_text(&text)
}

pub(crate) fn ssh_host_candidates_from_config_text(text: &str) -> Vec<HostConfig> {
    ssh_hosts_from_config_text(text, |_| true)
}

#[derive(Default)]
struct SshHostBlock {
    aliases: Vec<String>,
    user: Option<String>,
    port: Option<u16>,
    host_name: Option<String>,
    proxy_jump: Option<String>,
}

fn ssh_hosts_from_config_text(text: &str, include_alias: fn(&str) -> bool) -> Vec<HostConfig> {
    let mut blocks = Vec::new();
    let mut current = SshHostBlock::default();

    for raw_line in text.lines() {
        let line = raw_line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let Some((key, value)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        let key = key.to_ascii_lowercase();
        let value = value.trim();
        match key.as_str() {
            "host" => {
                if !current.aliases.is_empty() {
                    blocks.push(current);
                }
                current = SshHostBlock {
                    aliases: value
                        .split_whitespace()
                        .filter(|alias| ssh_host_alias_is_literal(alias))
                        .map(str::to_string)
                        .collect(),
                    ..SshHostBlock::default()
                };
            }
            "match" => {
                if !current.aliases.is_empty() {
                    blocks.push(current);
                }
                current = SshHostBlock::default();
            }
            "user" => {
                if !value.is_empty() {
                    current.user = Some(value.to_string());
                }
            }
            "port" => {
                current.port = value.parse::<u16>().ok();
            }
            "hostname" => {
                if !value.is_empty() {
                    current.host_name = Some(value.to_string());
                }
            }
            "proxyjump" => {
                if !value.is_empty() {
                    current.proxy_jump = Some(value.to_string());
                }
            }
            _ => {}
        }
    }
    if !current.aliases.is_empty() {
        blocks.push(current);
    }

    let jump_targets = blocks
        .iter()
        .filter_map(|block| block.proxy_jump.as_deref())
        .flat_map(ssh_proxy_jump_targets)
        .collect::<HashSet<_>>();
    let mut seen_ids = HashSet::new();
    let mut seen_physical_targets = HashSet::new();
    let mut hosts = Vec::new();

    for block in blocks {
        for alias in &block.aliases {
            if !include_alias(alias)
                || !seen_ids.insert(alias.clone())
                || jump_targets.contains(alias)
                || ssh_host_block_is_service(&block, alias)
            {
                continue;
            }
            let physical_target = ssh_host_physical_target(&block, alias);
            if !seen_physical_targets.insert(physical_target) {
                continue;
            }
            if let Some(mut host) = host_from_alias(alias) {
                host.user = block.user.clone();
                host.port = block.port;
                hosts.push(host);
            }
        }
    }

    hosts
}

fn ssh_host_alias_is_literal(alias: &str) -> bool {
    !alias.is_empty()
        && !alias
            .chars()
            .any(|character| matches!(character, '*' | '?' | '[' | ']' | '!'))
}

fn ssh_proxy_jump_targets(value: &str) -> Vec<String> {
    value
        .split(',')
        .filter_map(|target| {
            let target = target.trim();
            if target.is_empty() || target.eq_ignore_ascii_case("none") || target.contains('%') {
                return None;
            }
            let host = target
                .rsplit_once('@')
                .map(|(_, host)| host)
                .unwrap_or(target);
            let host = if let Some(rest) = host.strip_prefix('[') {
                rest.split(']').next().unwrap_or(rest)
            } else if host.matches(':').count() == 1 {
                host.split(':').next().unwrap_or(host)
            } else {
                host
            };
            if ssh_host_alias_is_literal(host) {
                Some(host.to_string())
            } else {
                None
            }
        })
        .collect()
}

fn ssh_host_block_is_service(block: &SshHostBlock, alias: &str) -> bool {
    block
        .user
        .as_deref()
        .is_some_and(|user| user.eq_ignore_ascii_case("git"))
        || block.port == Some(29418)
        || ssh_host_name(block, alias)
            .to_ascii_lowercase()
            .starts_with("git.")
}

fn ssh_host_name<'a>(block: &'a SshHostBlock, alias: &'a str) -> &'a str {
    block.host_name.as_deref().unwrap_or(alias).trim()
}

fn ssh_host_physical_target(block: &SshHostBlock, alias: &str) -> String {
    ssh_host_name(block, alias).to_ascii_lowercase()
}

/// Save hosts to ~/.tmux-worktree.json (read-modify-write).
#[cfg(test)]
pub(crate) fn save_hosts_config(hosts: &[HostConfig]) -> Result<(), String> {
    let _guard = dashboard_config_write_lock()
        .lock()
        .map_err(|_| "dashboard config write lock poisoned".to_string())?;
    let _file_guard = acquire_dashboard_config_file_lock()?;
    save_hosts_config_unlocked(hosts)
}

fn host_collection_from_config(config: &serde_json::Value) -> Option<&serde_json::Value> {
    ["hosts", "remotes", "remoteHosts"]
        .into_iter()
        .find_map(|field| config.get(field))
}

fn raw_host_objects_by_id(
    config: &serde_json::Value,
) -> HashMap<String, serde_json::Map<String, serde_json::Value>> {
    let mut result = HashMap::new();
    match host_collection_from_config(config) {
        Some(serde_json::Value::Array(values)) => {
            for value in values {
                if let (Some(host), Some(object)) =
                    (host_from_config_value(value), value.as_object())
                {
                    result.insert(host.id, object.clone());
                }
            }
        }
        Some(serde_json::Value::Object(values)) => {
            for (id, value) in values {
                if let (Some(host), Some(object)) =
                    (host_from_named_config_value(id, value), value.as_object())
                {
                    result.insert(host.id, object.clone());
                }
            }
        }
        _ => {}
    }
    result
}

fn known_host_config_field(field: &str) -> bool {
    matches!(
        field,
        "id" | "name"
            | "key"
            | "label"
            | "displayName"
            | "display_name"
            | "host"
            | "hostname"
            | "address"
            | "user"
            | "username"
            | "port"
            | "identityFile"
            | "identity_file"
            | "keyFile"
            | "key_file"
            | "worktreeBase"
            | "worktree_base"
            | "worktreeDir"
            | "worktreeRoot"
            | "worktreesDir"
            | "worktreesRoot"
            | "tmuxPath"
            | "tmux_path"
            | "tmuxBin"
            | "tmux_bin"
            | "twPath"
            | "tw_path"
            | "twBin"
            | "tw_bin"
    )
}

fn save_hosts_config_unlocked(hosts: &[HostConfig]) -> Result<(), String> {
    for host in hosts {
        validate_ssh_host_fields(host)
            .map_err(|error| format!("invalid SSH host '{}': {error}", host.id))?;
    }
    let home = app_home_dir().ok_or("home dir not found")?;
    let config_path = home.join(".tmux-worktree.json");
    let mut config: serde_json::Value = if config_path.exists() {
        let text = std::fs::read_to_string(&config_path)
            .map_err(|error| format!("read config: {error}"))?;
        serde_json::from_str(&text).map_err(|error| format!("parse config: {error}"))?
    } else {
        serde_json::json!({})
    };
    let existing = raw_host_objects_by_id(&config);
    let serialized_hosts = hosts
        .iter()
        .map(|host| {
            let mut merged = existing
                .get(&host.id)
                .map(|object| {
                    object
                        .iter()
                        .filter(|(field, _)| !known_host_config_field(field))
                        .map(|(field, value)| (field.clone(), value.clone()))
                        .collect::<serde_json::Map<_, _>>()
                })
                .unwrap_or_default();
            let canonical = serde_json::to_value(host)
                .map_err(|error| format!("serialize host {}: {error}", host.id))?;
            merged.extend(canonical.as_object().cloned().unwrap_or_default());
            Ok(serde_json::Value::Object(merged))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let root = config
        .as_object_mut()
        .ok_or("config root is not an object")?;
    root.insert(
        "hosts".to_string(),
        serde_json::Value::Array(serialized_hosts),
    );
    root.remove("remotes");
    root.remove("remoteHosts");
    let pretty = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("serialize config: {error}"))?;
    atomic_write_file(&config_path, pretty.as_bytes())
        .map_err(|error| format!("write config: {error}"))?;
    Ok(())
}

/// Find a host by ID from the config.
pub(crate) fn find_host(host_id: &str) -> Result<HostConfig, String> {
    let hosts = load_hosts()?;
    hosts
        .into_iter()
        .find(|host| host.id == host_id)
        .ok_or_else(|| format!("unknown host: {host_id}"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddHostArgs {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) host: String,
    #[serde(default)]
    pub(crate) user: Option<String>,
    #[serde(default)]
    pub(crate) port: Option<u16>,
    #[serde(default)]
    pub(crate) identity_file: Option<String>,
    #[serde(default)]
    pub(crate) worktree_base: Option<String>,
    #[serde(default)]
    pub(crate) tmux_path: Option<String>,
    #[serde(default)]
    pub(crate) tw_path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateHostArgs {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) host: String,
    #[serde(default)]
    pub(crate) user: Option<String>,
    #[serde(default)]
    pub(crate) port: Option<u16>,
    #[serde(default)]
    pub(crate) identity_file: Option<String>,
    #[serde(default)]
    pub(crate) worktree_base: Option<String>,
    #[serde(default)]
    pub(crate) tmux_path: Option<String>,
    #[serde(default)]
    pub(crate) tw_path: Option<String>,
}

#[tauri::command]
pub(crate) fn list_hosts() -> Result<Vec<HostConfig>, String> {
    load_hosts()
}

#[tauri::command]
pub(crate) fn list_ssh_host_candidates() -> Result<Vec<HostConfig>, String> {
    Ok(load_ssh_host_candidates())
}

pub(crate) fn add_host_config(args: AddHostArgs) -> Result<Vec<HostConfig>, String> {
    let id = args.id.trim();
    let label = args.label.trim();
    let host = args.host.trim();
    validate_host_id(id)?;
    if label.is_empty() {
        return Err("label required".into());
    }
    if host.is_empty() {
        return Err("host required".into());
    }

    let _guard = dashboard_config_write_lock()
        .lock()
        .map_err(|_| "dashboard config write lock poisoned".to_string())?;
    let _file_guard = acquire_dashboard_config_file_lock()?;
    let mut configured_hosts = load_configured_hosts()?;
    if configured_hosts.iter().any(|host| host.id == id) {
        return Err(format!("host id '{id}' already exists"));
    }

    let new_host = HostConfig {
        id: id.to_string(),
        label: label.to_string(),
        host: host.to_string(),
        user: args
            .user
            .filter(|user| !user.trim().is_empty())
            .map(|user| user.trim().to_string()),
        port: args.port,
        identity_file: args
            .identity_file
            .filter(|path| !path.trim().is_empty())
            .map(|path| expand_home_path(path.trim())),
        worktree_base: args
            .worktree_base
            .as_deref()
            .and_then(trimmed_non_empty_string),
        tmux_path: args.tmux_path.as_deref().and_then(trimmed_non_empty_string),
        tw_path: args.tw_path.as_deref().and_then(trimmed_non_empty_string),
    };
    validate_ssh_host_fields(&new_host)?;

    configured_hosts.push(new_host);
    save_hosts_config_unlocked(&configured_hosts)?;
    load_hosts()
}

pub(crate) fn update_host_config(args: UpdateHostArgs) -> Result<Vec<HostConfig>, String> {
    let id = args.id.trim();
    let label = args.label.trim();
    let host = args.host.trim();
    validate_host_id(id)?;
    if label.is_empty() {
        return Err("host label required".into());
    }
    if host.is_empty() {
        return Err("host target required".into());
    }

    let _guard = dashboard_config_write_lock()
        .lock()
        .map_err(|_| "dashboard config write lock poisoned".to_string())?;
    let _file_guard = acquire_dashboard_config_file_lock()?;
    let mut hosts = load_configured_hosts()?;
    let matching = hosts
        .iter()
        .filter(|configured| configured.id == id)
        .count();
    if matching == 0 {
        return Err(format!("host id '{id}' not found"));
    }
    if matching > 1 {
        return Err(format!("host id '{id}' is duplicated in config"));
    }

    let optional = |value: Option<String>| value.as_deref().and_then(trimmed_non_empty_string);
    let identity_file = optional(args.identity_file).map(|path| expand_home_path(&path));
    let updated = HostConfig {
        id: id.to_string(),
        label: label.to_string(),
        host: host.to_string(),
        user: optional(args.user),
        port: args.port,
        identity_file,
        worktree_base: optional(args.worktree_base),
        tmux_path: optional(args.tmux_path),
        tw_path: optional(args.tw_path),
    };
    validate_ssh_host_fields(&updated)?;
    let index = hosts
        .iter()
        .position(|configured| configured.id == id)
        .expect("matching host index");
    hosts[index] = updated;
    save_hosts_config_unlocked(&hosts)?;
    load_hosts()
}

pub(crate) fn remove_host_config(id: &str) -> Result<Vec<HostConfig>, String> {
    let _guard = dashboard_config_write_lock()
        .lock()
        .map_err(|_| "dashboard config write lock poisoned".to_string())?;
    let _file_guard = acquire_dashboard_config_file_lock()?;
    let mut hosts = load_configured_hosts()?;
    hosts.retain(|host| host.id != id);
    save_hosts_config_unlocked(&hosts)?;
    load_hosts()
}
