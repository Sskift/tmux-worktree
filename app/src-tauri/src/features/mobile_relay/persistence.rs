use super::model::MobileRelayConfig;
use crate::config::{acquire_dashboard_config_file_lock, dashboard_config_write_lock};
use crate::ipc::MobileRelayConfigInput;
use crate::support::{app_home_dir, app_home_dir_or_tmp, atomic_write_file};
use std::path::PathBuf;

fn config_string_field(config: &serde_json::Value, fields: &[&str]) -> Option<String> {
    let object = config.as_object()?;
    fields.iter().find_map(|field| {
        object
            .get(*field)
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn mobile_relay_config_from_value(config: &serde_json::Value) -> MobileRelayConfig {
    let relay = config
        .get("mobileRelay")
        .or_else(|| config.get("relay"))
        .unwrap_or(config);
    MobileRelayConfig {
        relay_url: config_string_field(relay, &["relayUrl", "url", "broker", "brokerUrl"])
            .or_else(|| config_string_field(config, &["mobileRelayUrl", "relayUrl"]))
            .unwrap_or_default(),
        broker_host_id: config_string_field(relay, &["brokerHostId", "relayCenterHostId"])
            .or_else(|| config_string_field(config, &["mobileRelayBrokerHostId"]))
            .unwrap_or_default(),
        host_id: config_string_field(relay, &["hostId", "host", "adminHostId"])
            .or_else(|| config_string_field(config, &["mobileRelayHostId", "relayHostId"]))
            .unwrap_or_default(),
        display_name: config_string_field(relay, &["displayName", "name", "label"])
            .or_else(|| {
                config_string_field(config, &["mobileRelayDisplayName", "relayDisplayName"])
            })
            .unwrap_or_default(),
        secret: config_string_field(relay, &["secret", "token", "relaySecret"])
            .or_else(|| config_string_field(config, &["mobileRelaySecret", "relaySecret"]))
            .unwrap_or_default(),
    }
}

fn load_mobile_relay_config_file() -> MobileRelayConfig {
    let Some(home) = app_home_dir() else {
        return MobileRelayConfig::default();
    };
    let config_path = home.join(".tmux-worktree.json");
    let Ok(content) = std::fs::read_to_string(config_path) else {
        return MobileRelayConfig::default();
    };
    let Ok(config) = serde_json::from_str::<serde_json::Value>(&content) else {
        return MobileRelayConfig::default();
    };
    mobile_relay_config_from_value(&config)
}

pub(super) fn preflight_mobile_relay_config_write() -> Result<(), String> {
    if env_non_empty("TW_RELAY_SECRET").is_some() {
        return Err(
            "Start broker cannot rotate the Relay v1 token while TW_RELAY_SECRET overrides the saved configuration"
                .to_string(),
        );
    }
    let home = app_home_dir().ok_or("home dir not found")?;
    let config_path = home.join(".tmux-worktree.json");
    if !config_path.exists() {
        return Ok(());
    }
    let text = std::fs::read_to_string(&config_path).map_err(|e| format!("read config: {e}"))?;
    let config: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("parse config: {e}"))?;
    if !config.is_object() {
        return Err("config root is not an object".to_string());
    }
    Ok(())
}

fn env_non_empty(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn config_or_default(value: &str, default: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        default.to_string()
    } else {
        trimmed.to_string()
    }
}

pub(super) fn mobile_relay_config() -> MobileRelayConfig {
    let file = load_mobile_relay_config_file();
    MobileRelayConfig {
        relay_url: env_non_empty("TW_RELAY_URL")
            .unwrap_or_else(|| file.relay_url.trim().to_string()),
        broker_host_id: file.broker_host_id.trim().to_string(),
        host_id: env_non_empty("TW_RELAY_HOST_ID")
            .unwrap_or_else(|| config_or_default(&file.host_id, "mac-admin")),
        display_name: env_non_empty("TW_RELAY_DISPLAY_NAME")
            .unwrap_or_else(|| config_or_default(&file.display_name, "Mac Admin")),
        secret: env_non_empty("TW_RELAY_SECRET").unwrap_or_else(|| file.secret.trim().to_string()),
    }
}

pub(super) fn save_mobile_relay_config_file(
    args: &MobileRelayConfigInput,
) -> Result<MobileRelayConfig, String> {
    let home = app_home_dir().ok_or("home dir not found")?;
    let config_path = home.join(".tmux-worktree.json");
    let _guard = dashboard_config_write_lock()
        .lock()
        .map_err(|_| "dashboard config write lock poisoned".to_string())?;
    let _file_guard = acquire_dashboard_config_file_lock()?;
    let mut config: serde_json::Value = if config_path.exists() {
        let text =
            std::fs::read_to_string(&config_path).map_err(|e| format!("read config: {e}"))?;
        serde_json::from_str(&text).map_err(|e| format!("parse config: {e}"))?
    } else {
        serde_json::json!({})
    };
    let root = config
        .as_object_mut()
        .ok_or("config root is not an object")?;
    let existing_display_name = root
        .get("mobileRelay")
        .and_then(|value| config_string_field(value, &["displayName", "name", "label"]))
        .unwrap_or_else(|| "Mac Admin".to_string());
    let relay = root
        .entry("mobileRelay".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !relay.is_object() {
        *relay = serde_json::json!({});
    }
    let relay = relay
        .as_object_mut()
        .ok_or("mobileRelay config is not an object")?;
    for alias in [
        "url",
        "broker",
        "brokerUrl",
        "relayCenterHostId",
        "host",
        "adminHostId",
        "name",
        "label",
        "token",
        "relaySecret",
    ] {
        relay.remove(alias);
    }
    relay.insert(
        "relayUrl".to_string(),
        serde_json::Value::String(args.relay_url.trim().to_string()),
    );
    relay.insert(
        "brokerHostId".to_string(),
        serde_json::Value::String(args.broker_host_id.trim().to_string()),
    );
    relay.insert(
        "hostId".to_string(),
        serde_json::Value::String(args.host_id.trim().to_string()),
    );
    relay.insert(
        "displayName".to_string(),
        serde_json::Value::String(existing_display_name.clone()),
    );
    relay.insert(
        "secret".to_string(),
        serde_json::Value::String(args.secret.trim().to_string()),
    );
    let pretty =
        serde_json::to_string_pretty(&config).map_err(|e| format!("serialize config: {e}"))?;
    atomic_write_file(&config_path, format!("{pretty}\n").as_bytes())
        .map_err(|e| format!("write config: {e}"))?;
    Ok(MobileRelayConfig {
        relay_url: args.relay_url.trim().to_string(),
        broker_host_id: args.broker_host_id.trim().to_string(),
        host_id: args.host_id.trim().to_string(),
        display_name: existing_display_name,
        secret: args.secret.trim().to_string(),
    })
}

pub(super) fn mobile_relay_status_file() -> PathBuf {
    app_home_dir_or_tmp()
        .join(".tmux-worktree")
        .join("mobile-relay-status.json")
}

#[cfg(test)]
mod tests {
    use super::{
        mobile_relay_config, mobile_relay_config_from_value, preflight_mobile_relay_config_write,
        save_mobile_relay_config_file,
    };
    use crate::ipc::MobileRelayConfigInput;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    fn restore_env(name: &str, value: Option<String>) {
        if let Some(value) = value {
            unsafe {
                std::env::set_var(name, value);
            }
        } else {
            unsafe {
                std::env::remove_var(name);
            }
        }
    }

    #[test]
    fn mobile_relay_config_accepts_nested_and_flat_fields() {
        let nested = mobile_relay_config_from_value(&serde_json::json!({
            "mobileRelay": {
                "relayUrl": "wss://relay.example.net",
                "brokerHostId": "devbox",
                "hostId": "macbook",
                "displayName": "Desk Mac",
                "secret": "token-1"
            }
        }));
        assert_eq!(nested.relay_url, "wss://relay.example.net");
        assert_eq!(nested.broker_host_id, "devbox");
        assert_eq!(nested.host_id, "macbook");
        assert_eq!(nested.display_name, "Desk Mac");
        assert_eq!(nested.secret, "token-1");

        let flat = mobile_relay_config_from_value(&serde_json::json!({
            "mobileRelayUrl": "wss://relay.example.org",
            "mobileRelayHostId": "laptop",
            "mobileRelaySecret": "token-2"
        }));
        assert_eq!(flat.relay_url, "wss://relay.example.org");
        assert_eq!(flat.host_id, "laptop");
        assert_eq!(flat.secret, "token-2");
    }

    #[test]
    fn mobile_relay_config_save_is_private_atomic_and_preserves_root_fields() {
        let _guard = crate::tests::test_env_lock().lock().expect("test env lock");
        let variables = [
            "HOME",
            "TW_DASHBOARD_HOME",
            "TW_RELAY_URL",
            "TW_RELAY_HOST_ID",
            "TW_RELAY_DISPLAY_NAME",
            "TW_RELAY_SECRET",
        ];
        let originals = variables.map(|name| (name, std::env::var(name).ok()));
        let temp = tempfile::tempdir().expect("tempdir");
        unsafe {
            std::env::set_var("HOME", temp.path());
            std::env::set_var("TW_DASHBOARD_HOME", temp.path());
        }
        let config_path = temp.path().join(".tmux-worktree.json");
        fs::write(
            &config_path,
            r#"{
  "projects": { "app": "/repo/app" },
  "mobileRelay": { "displayName": "Desk Mac", "legacyNested": true }
}"#,
        )
        .expect("seed config");

        let saved = save_mobile_relay_config_file(&MobileRelayConfigInput {
            relay_url: " ws://relay.example.net:8787 ".to_string(),
            broker_host_id: " devbox ".to_string(),
            host_id: " mac-admin ".to_string(),
            secret: " shared-v1-secret ".to_string(),
        })
        .expect("save relay config");
        assert_eq!(saved.relay_url, "ws://relay.example.net:8787");
        assert_eq!(saved.broker_host_id, "devbox");
        assert_eq!(saved.host_id, "mac-admin");
        assert_eq!(saved.display_name, "Desk Mac");
        assert_eq!(saved.secret, "shared-v1-secret");

        let text = fs::read_to_string(&config_path).expect("read saved config");
        assert!(text.ends_with('\n'));
        let value: serde_json::Value = serde_json::from_str(&text).expect("parse saved config");
        assert_eq!(value["projects"]["app"], "/repo/app");
        assert_eq!(value["mobileRelay"]["displayName"], "Desk Mac");
        assert_eq!(
            value["mobileRelay"]["relayUrl"],
            "ws://relay.example.net:8787"
        );
        assert_eq!(value["mobileRelay"]["hostId"], "mac-admin");
        assert_eq!(value["mobileRelay"]["brokerHostId"], "devbox");
        assert_eq!(value["mobileRelay"]["secret"], "shared-v1-secret");
        assert_eq!(value["mobileRelay"]["legacyNested"], true);
        assert_eq!(
            fs::metadata(&config_path)
                .expect("config metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );

        unsafe {
            std::env::set_var("TW_RELAY_URL", "wss://env-relay.example.net");
            std::env::set_var("TW_RELAY_HOST_ID", "env-host");
            std::env::set_var("TW_RELAY_DISPLAY_NAME", "Env Mac");
            std::env::set_var("TW_RELAY_SECRET", "env-shared-v1-secret");
        }
        let env_config = mobile_relay_config();
        assert_eq!(env_config.relay_url, "wss://env-relay.example.net");
        assert_eq!(env_config.host_id, "env-host");
        assert_eq!(env_config.display_name, "Env Mac");
        assert_eq!(env_config.secret, "env-shared-v1-secret");

        for (name, value) in originals {
            restore_env(name, value);
        }
    }

    #[test]
    fn mobile_relay_broker_preflight_rejects_corrupt_config_and_secret_override() {
        let _guard = crate::tests::test_env_lock().lock().expect("test env lock");
        let original_home = std::env::var("HOME").ok();
        let original_dashboard_home = std::env::var("TW_DASHBOARD_HOME").ok();
        let original_secret = std::env::var("TW_RELAY_SECRET").ok();
        let temp = tempfile::tempdir().expect("tempdir");
        unsafe {
            std::env::set_var("HOME", temp.path());
            std::env::set_var("TW_DASHBOARD_HOME", temp.path());
            std::env::remove_var("TW_RELAY_SECRET");
        }
        let config_path = temp.path().join(".tmux-worktree.json");
        fs::write(&config_path, "{broken").expect("write corrupt config");
        assert!(preflight_mobile_relay_config_write()
            .expect_err("corrupt config must fail")
            .contains("parse config"));

        fs::write(&config_path, "{}\n").expect("write valid config");
        unsafe {
            std::env::set_var("TW_RELAY_SECRET", "environment-secret");
        }
        assert!(preflight_mobile_relay_config_write()
            .expect_err("secret override must fail")
            .contains("TW_RELAY_SECRET"));

        restore_env("TW_RELAY_SECRET", original_secret);
        restore_env("TW_DASHBOARD_HOME", original_dashboard_home);
        restore_env("HOME", original_home);
    }
}
