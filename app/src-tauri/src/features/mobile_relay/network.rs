const LEGACY_PLACEHOLDER_RELAY_URL: &str = "wss://relay.example.com";

pub(super) fn tcp_port_open(port: u16) -> bool {
    std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host == "127.0.0.1"
        || host == "::1"
        || host == "[::1]"
}

pub(super) fn validate_mobile_relay_connector_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Relay URL is required before starting the connector".to_string());
    }
    let parsed = tauri::Url::parse(trimmed).map_err(|_| "Enter a valid Relay URL".to_string())?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "Relay URL must include a host".to_string())?;
    let authority = trimmed
        .split_once("://")
        .map(|(_, remainder)| remainder)
        .unwrap_or(trimmed)
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    if trimmed.eq_ignore_ascii_case(LEGACY_PLACEHOLDER_RELAY_URL)
        || host.eq_ignore_ascii_case("relay.example.com")
    {
        return Err(
            "Replace the example Relay URL with this broker's trusted wss:// endpoint".to_string(),
        );
    }
    if parsed.port() == Some(0) {
        return Err("Relay URL includes an invalid port".to_string());
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || authority.contains('@')
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(
            "Relay URL must be a root URL without credentials, path, query, or fragment"
                .to_string(),
        );
    }

    match parsed.scheme() {
        "wss" => {}
        "ws" if is_loopback_host(host) => {}
        "ws" => {
            return Err(
                "Cleartext ws:// is allowed only for localhost diagnostics; configure trusted wss:// for remote Relay"
                    .to_string(),
            )
        }
        _ => return Err("Relay URL must use wss://".to_string()),
    }

    Ok(trimmed.trim_end_matches('/').to_string())
}

pub(super) fn is_cloudflare_quick_tunnel_url(value: &str) -> bool {
    let Ok(normalized) = validate_mobile_relay_connector_url(value) else {
        return false;
    };
    let Ok(parsed) = tauri::Url::parse(&normalized) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let Some(label) = host
        .to_ascii_lowercase()
        .strip_suffix(".trycloudflare.com")
        .map(str::to_string)
    else {
        return false;
    };
    let bytes = label.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 63
        && bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        && !label.contains('.')
        && label
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

pub(super) fn preserved_mobile_relay_url_after_broker_start(
    current_url: &str,
    current_broker_host_id: &str,
    selected_broker_host_id: &str,
) -> String {
    if current_broker_host_id.trim() != selected_broker_host_id.trim() {
        return String::new();
    }
    validate_mobile_relay_connector_url(current_url).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{
        is_cloudflare_quick_tunnel_url, preserved_mobile_relay_url_after_broker_start,
        validate_mobile_relay_connector_url,
    };

    #[test]
    fn mobile_relay_connector_requires_wss_except_for_loopback_diagnostics() {
        assert_eq!(
            validate_mobile_relay_connector_url(" wss://relay.example.net/ "),
            Ok("wss://relay.example.net".to_string())
        );
        assert_eq!(
            validate_mobile_relay_connector_url("ws://127.0.0.1:8787/"),
            Ok("ws://127.0.0.1:8787".to_string())
        );
        assert_eq!(
            validate_mobile_relay_connector_url("ws://[::1]:8787"),
            Ok("ws://[::1]:8787".to_string())
        );
        assert!(validate_mobile_relay_connector_url("ws://desk-mac.local:8787").is_err());
        assert!(validate_mobile_relay_connector_url("ws://10.0.0.8:8787").is_err());
        assert!(validate_mobile_relay_connector_url("https://relay.example.net").is_err());
        assert!(validate_mobile_relay_connector_url("wss://user@relay.example.net").is_err());
        assert!(validate_mobile_relay_connector_url("wss://@relay.example.net").is_err());
        assert!(validate_mobile_relay_connector_url("wss://relay.example.net/client").is_err());
        assert!(validate_mobile_relay_connector_url("wss://relay.example.net:0").is_err());
        assert!(validate_mobile_relay_connector_url("wss://relay.example.com/").is_err());
    }

    #[test]
    fn broker_start_only_preserves_an_explicit_safe_connector_url() {
        assert_eq!(
            preserved_mobile_relay_url_after_broker_start(
                "wss://relay.example.net",
                "devbox",
                "devbox",
            ),
            "wss://relay.example.net"
        );
        assert_eq!(
            preserved_mobile_relay_url_after_broker_start(
                "wss://relay.example.com",
                "devbox",
                "devbox",
            ),
            ""
        );
        assert_eq!(
            preserved_mobile_relay_url_after_broker_start(
                "ws://desk-mac.local:8787",
                "devbox",
                "devbox",
            ),
            ""
        );
        assert_eq!(
            preserved_mobile_relay_url_after_broker_start(
                "wss://old-relay.example.net",
                "old-center",
                "new-center",
            ),
            ""
        );
        assert_eq!(
            preserved_mobile_relay_url_after_broker_start(
                "wss://legacy-relay.example.net",
                "",
                "devbox",
            ),
            ""
        );
    }

    #[test]
    fn quick_tunnel_url_requires_a_single_trycloudflare_subdomain() {
        assert!(is_cloudflare_quick_tunnel_url(
            "wss://evaluation-songs-bodies-skins.trycloudflare.com"
        ));
        assert!(is_cloudflare_quick_tunnel_url(
            "wss://ABC-123.trycloudflare.com/"
        ));
        assert!(!is_cloudflare_quick_tunnel_url("wss://trycloudflare.com"));
        assert!(!is_cloudflare_quick_tunnel_url(
            "wss://nested.name.trycloudflare.com"
        ));
        assert!(!is_cloudflare_quick_tunnel_url(
            "wss://-invalid.trycloudflare.com"
        ));
        assert!(!is_cloudflare_quick_tunnel_url("wss://relay.example.net"));
    }
}
