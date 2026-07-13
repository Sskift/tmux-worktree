use std::net::{IpAddr, ToSocketAddrs};

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

fn wait_for_mobile_relay_url_resolution_with<Published, Resolve, Pause>(
    value: &str,
    publication_attempts: usize,
    resolution_attempts: usize,
    mut published: Published,
    mut resolve: Resolve,
    mut pause: Pause,
) -> Result<(), String>
where
    Published: FnMut(&str) -> bool,
    Resolve: FnMut(&str, u16) -> bool,
    Pause: FnMut(),
{
    let normalized = validate_mobile_relay_connector_url(value)?;
    let parsed = tauri::Url::parse(&normalized)
        .map_err(|_| "Automatic WSS setup returned an invalid Relay URL".to_string())?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "Automatic WSS setup returned a Relay URL without a host".to_string())?;
    let port = parsed.port_or_known_default().unwrap_or(443);
    let publication_attempts = publication_attempts.max(1);
    let resolution_attempts = resolution_attempts.max(1);

    let mut publication_ready = false;
    for attempt in 0..publication_attempts {
        if published(host) {
            publication_ready = true;
            break;
        }
        if attempt + 1 < publication_attempts {
            pause();
        }
    }
    if !publication_ready {
        return Err(
            "Automatic WSS setup published a URL, but its public DNS record did not appear within 60 seconds"
                .to_string(),
        );
    }

    for attempt in 0..resolution_attempts {
        if resolve(host, port) {
            return Ok(());
        }
        if attempt + 1 < resolution_attempts {
            pause();
        }
    }

    Err(
        "Automatic WSS setup published a URL, but this Mac could not resolve it within 15 seconds"
            .to_string(),
    )
}

fn mobile_relay_public_dns_ready(host: &str) -> bool {
    let Ok(output) = std::process::Command::new("/usr/bin/dig")
        .args(["+time=1", "+tries=1", "+short", host])
        .output()
    else {
        return false;
    };
    output.status.success()
        && String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .any(|line| line.parse::<IpAddr>().is_ok())
}

pub(super) fn wait_for_mobile_relay_url_resolution(value: &str) -> Result<(), String> {
    wait_for_mobile_relay_url_resolution_with(
        value,
        30,
        15,
        mobile_relay_public_dns_ready,
        |host, port| {
            (host, port)
                .to_socket_addrs()
                .is_ok_and(|mut addresses| addresses.next().is_some())
        },
        || std::thread::sleep(std::time::Duration::from_secs(1)),
    )
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
        validate_mobile_relay_connector_url, wait_for_mobile_relay_url_resolution_with,
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

    #[test]
    fn relay_url_resolution_waits_for_the_system_resolver_before_connector_start() {
        let mut resolutions = Vec::new();
        let mut pauses = 0;
        assert_eq!(
            wait_for_mobile_relay_url_resolution_with(
                "wss://new-tunnel.trycloudflare.com",
                1,
                3,
                |_| true,
                |host, port| {
                    resolutions.push((host.to_string(), port));
                    resolutions.len() == 3
                },
                || pauses += 1,
            ),
            Ok(())
        );
        assert_eq!(
            resolutions,
            vec![
                ("new-tunnel.trycloudflare.com".to_string(), 443),
                ("new-tunnel.trycloudflare.com".to_string(), 443),
                ("new-tunnel.trycloudflare.com".to_string(), 443),
            ]
        );
        assert_eq!(pauses, 2);
    }

    #[test]
    fn relay_url_resolution_fails_before_connector_start_when_dns_never_arrives() {
        let mut resolutions = 0;
        let mut pauses = 0;
        let error = wait_for_mobile_relay_url_resolution_with(
            "wss://unresolved-tunnel.trycloudflare.com",
            1,
            2,
            |_| true,
            |_, _| {
                resolutions += 1;
                false
            },
            || pauses += 1,
        )
        .unwrap_err();
        assert_eq!(resolutions, 2);
        assert_eq!(pauses, 1);
        assert!(error.contains("could not resolve"));
    }

    #[test]
    fn relay_url_resolution_does_not_touch_the_system_resolver_before_public_dns_exists() {
        let mut publications = 0;
        let mut resolutions = 0;
        let mut pauses = 0;
        assert_eq!(
            wait_for_mobile_relay_url_resolution_with(
                "wss://fresh-tunnel.trycloudflare.com",
                3,
                1,
                |_| {
                    publications += 1;
                    publications == 3
                },
                |_, _| {
                    resolutions += 1;
                    true
                },
                || pauses += 1,
            ),
            Ok(())
        );
        assert_eq!(publications, 3);
        assert_eq!(resolutions, 1);
        assert_eq!(pauses, 2);
    }
}
