use crate::features::control_plane::{bundled_cli_path, scp_cli_to_host};
use crate::remote::{remote_tmux_cmd, run_remote_cmd_check_strings, HostConfig};
use crate::support::shell_quote;

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
exec /usr/bin/env node "$HOME/.tmux-worktree/tw-cli.cjs" relay-server --host 0.0.0.0 --port {}
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

#[cfg(test)]
mod tests {
    use super::mobile_relay_secret;

    #[test]
    fn mobile_relay_v1_shared_secret_is_64_lowercase_hex_characters() {
        let secret = mobile_relay_secret();
        assert_eq!(secret.len(), 64);
        assert!(secret
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    }
}
