use crate::features::control_plane::{bundled_cli_path, scp_cli_to_host};
use crate::remote::{remote_tmux_cmd, run_remote_cmd_check_strings, HostConfig};
use crate::support::shell_quote;

const RELAY_TUNNEL_SESSION: &str = "tw-relay-tunnel";

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
  echo "Automatic WSS setup requires cloudflared on the selected Relay center. Install it in ~/.tmux-worktree/bin/cloudflared or PATH." >&2
else
  echo "Cloudflare Quick Tunnel did not publish a trusted WSS URL within 20 seconds. Inspect ~/.tmux-worktree/cloudflared.log on the Relay center." >&2
fi
exit 1
"#,
        port, tmux, RELAY_TUNNEL_SESSION, tmux, RELAY_TUNNEL_SESSION, tmux, RELAY_TUNNEL_SESSION,
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
    use super::{mobile_relay_secret, RELAY_TUNNEL_SESSION};

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
}
