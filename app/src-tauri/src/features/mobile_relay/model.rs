use serde::Deserialize;
use std::sync::Mutex;

pub(crate) struct MobileRelayState {
    pub(super) process: Mutex<Option<std::process::Child>>,
    pub(super) serve_process: Mutex<Option<std::process::Child>>,
    pub(super) relay_url: Mutex<String>,
    pub(super) host_id: Mutex<String>,
    pub(super) secret: Mutex<String>,
    pub(super) token: Mutex<String>,
    pub(super) last_error: Mutex<Option<String>>,
}

impl Default for MobileRelayState {
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
            serve_process: Mutex::new(None),
            relay_url: Mutex::new("wss://relay.example.com".to_string()),
            host_id: Mutex::new("mac-admin".to_string()),
            secret: Mutex::new(String::new()),
            token: Mutex::new(String::new()),
            last_error: Mutex::new(None),
        }
    }
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub(super) struct RelayHostRuntimeStatus {
    pub(super) state: String,
    pub(super) relay_url: String,
    pub(super) host_id: String,
    pub(super) connected_at: Option<u64>,
    pub(super) updated_at: Option<u64>,
    pub(super) retry_in_ms: Option<u64>,
    pub(super) error: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct MobileRelayConfig {
    pub(super) relay_url: String,
    pub(super) host_id: String,
    pub(super) display_name: String,
    pub(super) secret: String,
}
