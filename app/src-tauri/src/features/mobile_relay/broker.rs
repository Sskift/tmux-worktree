use crate::features::control_plane::{bundled_cli_path, scp_cli_to_host};
use crate::remote::{remote_tmux_cmd, run_remote_cmd_check_strings, HostConfig};
use crate::support::shell_quote;

const RELAY_TUNNEL_SESSION: &str = "tw-relay-tunnel";
const CLOUDFLARED_VERSION: &str = "2026.7.1";
const CLOUDFLARED_LINUX_AMD64_SHA256: &str =
    "79a0ade7fc854f62c1aaef48424d9d979e8c2fcd039189d24db82b84cd146be1";
const CLOUDFLARED_LINUX_ARM64_SHA256: &str =
    "18f2c9bfc7a67a971bd96f1a5a1935def3c1e52aa386626f1566f04e9b5478d6";

pub(super) fn mobile_relay_secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

pub(super) fn start_mobile_relay_broker_on_host(
    app: &tauri::AppHandle,
    host: &HostConfig,
    port: u16,
    secret: &str,
) -> Result<(), String> {
    if port == 0 {
        return Err("relay broker port must be greater than zero".to_string());
    }
    let cli = bundled_cli_path(app).ok_or("bundled CLI resource not found")?;
    run_remote_cmd_check_strings(
        host,
        &[
            "sh".into(),
            "-lc".into(),
            "mkdir -p \"$HOME/.tmux-worktree\"".into(),
        ],
    )?;
    scp_cli_to_host(host, &cli, ".tmux-worktree/tw-cli.cjs")?;
    let script = format!(
        r#"set -e
mkdir -p "$HOME/.tmux-worktree"
printf %s {} > "$HOME/.tmux-worktree/relay-secret"
chmod 600 "$HOME/.tmux-worktree/relay-secret"
cat > "$HOME/.tmux-worktree/relay-server.sh" <<'EOF'
#!/bin/sh
export TW_RELAY_SECRET="$(cat "$HOME/.tmux-worktree/relay-secret")"
exec /usr/bin/env node "$HOME/.tmux-worktree/tw-cli.cjs" relay-server --host 127.0.0.1 --port {}
EOF
chmod 700 "$HOME/.tmux-worktree/relay-server.sh"
{} kill-session -t tw-relay-server 2>/dev/null || true
{} new-session -d -s tw-relay-server "$HOME/.tmux-worktree/relay-server.sh"
sleep 1
{} has-session -t tw-relay-server
"#,
        shell_quote(secret),
        port,
        remote_tmux_cmd(host),
        remote_tmux_cmd(host),
        remote_tmux_cmd(host),
    );
    run_remote_cmd_check_strings(host, &["sh".into(), "-lc".into(), script])?;
    Ok(())
}

pub(super) fn start_mobile_relay_quick_tunnel_on_host(
    host: &HostConfig,
    port: u16,
) -> Result<String, String> {
    if port == 0 {
        return Err("relay broker port must be greater than zero".to_string());
    }
    let tmux = remote_tmux_cmd(host);
    let script = format!(
        r#"set -eu
mkdir -p "$HOME/.tmux-worktree"
umask 077
managed_cloudflared="$HOME/.tmux-worktree/bin/cloudflared"
system_cloudflared="$(command -v cloudflared || true)"
if [ ! -x "$managed_cloudflared" ] && [ -z "$system_cloudflared" ]; then
  if [ "$(uname -s)" != "Linux" ]; then
    echo "Automatic cloudflared provisioning supports Linux Relay centers; install cloudflared in ~/.tmux-worktree/bin/cloudflared or PATH on this host" >&2
    exit 127
  fi
  case "$(uname -m)" in
    x86_64|amd64)
      cloudflared_asset="cloudflared-linux-amd64"
      cloudflared_sha256="{}"
      ;;
    aarch64|arm64)
      cloudflared_asset="cloudflared-linux-arm64"
      cloudflared_sha256="{}"
      ;;
    *)
      echo "Automatic cloudflared provisioning does not support this Relay center architecture: $(uname -m)" >&2
      exit 127
      ;;
  esac
  mkdir -p "$HOME/.tmux-worktree/bin"
  cloudflared_tmp="$HOME/.tmux-worktree/bin/.cloudflared.$$.tmp"
  trap 'rm -f "$cloudflared_tmp"' EXIT HUP INT TERM
  cloudflared_url="https://github.com/cloudflare/cloudflared/releases/download/{}/$cloudflared_asset"
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --silent --show-error --output "$cloudflared_tmp" "$cloudflared_url"
  elif command -v wget >/dev/null 2>&1; then
    wget --quiet --output-document="$cloudflared_tmp" "$cloudflared_url"
  else
    echo "Automatic cloudflared provisioning requires curl or wget on the selected Relay center" >&2
    exit 127
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    downloaded_sha256="$(sha256sum "$cloudflared_tmp" | awk '{{print $1}}')"
  elif command -v shasum >/dev/null 2>&1; then
    downloaded_sha256="$(shasum -a 256 "$cloudflared_tmp" | awk '{{print $1}}')"
  else
    echo "Automatic cloudflared provisioning requires sha256sum or shasum on the selected Relay center" >&2
    exit 127
  fi
  if [ "$downloaded_sha256" != "$cloudflared_sha256" ]; then
    echo "Downloaded cloudflared failed SHA-256 verification" >&2
    exit 1
  fi
  chmod 700 "$cloudflared_tmp"
  mv "$cloudflared_tmp" "$managed_cloudflared"
  trap - EXIT HUP INT TERM
fi
cat > "$HOME/.tmux-worktree/relay-tunnel.sh" <<'EOF'
#!/bin/sh
set -eu
umask 077
if [ -x "$HOME/.tmux-worktree/bin/cloudflared" ]; then
  cloudflared="$HOME/.tmux-worktree/bin/cloudflared"
else
  cloudflared="$(command -v cloudflared || true)"
fi
if [ -z "$cloudflared" ] || [ ! -x "$cloudflared" ]; then
  echo "cloudflared is not installed on this Relay center" >&2
  exit 127
fi
exec "$cloudflared" tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:{}
EOF
chmod 700 "$HOME/.tmux-worktree/relay-tunnel.sh"
: > "$HOME/.tmux-worktree/cloudflared.log"
chmod 600 "$HOME/.tmux-worktree/cloudflared.log"
{} kill-session -t {} 2>/dev/null || true
{} new-session -d -s {} "\"$HOME/.tmux-worktree/relay-tunnel.sh\" >> \"$HOME/.tmux-worktree/cloudflared.log\" 2>&1"
attempt=0
while [ "$attempt" -lt 20 ]; do
  relay_url="$(sed -n 's#.*https://\([a-z0-9-][a-z0-9-]*\.trycloudflare\.com\).*#wss://\1#p' "$HOME/.tmux-worktree/cloudflared.log" | tail -n 1)"
  if [ -n "$relay_url" ]; then
    printf '%s\n' "$relay_url"
    exit 0
  fi
  if ! {} has-session -t {} 2>/dev/null; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
if grep -q "cloudflared is not installed" "$HOME/.tmux-worktree/cloudflared.log" 2>/dev/null; then
  echo "Automatic WSS setup could not find the provisioned cloudflared binary on the selected Relay center." >&2
else
  echo "Cloudflare Quick Tunnel did not publish a trusted WSS URL within 20 seconds. Inspect ~/.tmux-worktree/cloudflared.log on the Relay center." >&2
fi
exit 1
"#,
        CLOUDFLARED_LINUX_AMD64_SHA256,
        CLOUDFLARED_LINUX_ARM64_SHA256,
        CLOUDFLARED_VERSION,
        port,
        tmux,
        RELAY_TUNNEL_SESSION,
        tmux,
        RELAY_TUNNEL_SESSION,
        tmux,
        RELAY_TUNNEL_SESSION,
    );
    run_remote_cmd_check_strings(host, &["sh".into(), "-lc".into(), script])
}

pub(super) fn stop_mobile_relay_quick_tunnel_on_host(host: &HostConfig) -> Result<(), String> {
    let script = format!(
        "{} kill-session -t {} 2>/dev/null || true",
        remote_tmux_cmd(host),
        RELAY_TUNNEL_SESSION,
    );
    run_remote_cmd_check_strings(host, &["sh".into(), "-lc".into(), script]).map(|_| ())
}

pub(super) fn stop_mobile_relay_broker_on_host(host: &HostConfig) -> Result<(), String> {
    let script = format!(
        "{} kill-session -t tw-relay-server 2>/dev/null || true",
        remote_tmux_cmd(host),
    );
    run_remote_cmd_check_strings(host, &["sh".into(), "-lc".into(), script]).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::{
        mobile_relay_secret, CLOUDFLARED_LINUX_AMD64_SHA256, CLOUDFLARED_LINUX_ARM64_SHA256,
        CLOUDFLARED_VERSION, RELAY_TUNNEL_SESSION,
    };

    #[test]
    fn mobile_relay_v1_shared_secret_is_64_lowercase_hex_characters() {
        let secret = mobile_relay_secret();
        assert_eq!(secret.len(), 64);
        assert!(secret
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    }

    #[test]
    fn quick_tunnel_uses_a_dedicated_tmux_session() {
        assert_eq!(RELAY_TUNNEL_SESSION, "tw-relay-tunnel");
    }

    #[test]
    fn managed_cloudflared_release_has_pinned_sha256_digests() {
        assert_eq!(CLOUDFLARED_VERSION, "2026.7.1");
        for digest in [
            CLOUDFLARED_LINUX_AMD64_SHA256,
            CLOUDFLARED_LINUX_ARM64_SHA256,
        ] {
            assert_eq!(digest.len(), 64);
            assert!(digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
        }
        assert_ne!(
            CLOUDFLARED_LINUX_AMD64_SHA256,
            CLOUDFLARED_LINUX_ARM64_SHA256
        );
    }
}
