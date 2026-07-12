use crate::remote::{run_remote_cmd_check_strings, HostConfig};
use crate::support::tmux_bin;
use std::collections::HashMap;

#[derive(Clone, Default)]
pub(crate) struct RemoteSessionActivitySample {
    pub(crate) output_signature: Option<String>,
    pub(crate) agent_running: Option<bool>,
}

pub(crate) fn remote_session_activity_samples(
    host: &HostConfig,
    raw_names: &[String],
) -> Result<HashMap<String, RemoteSessionActivitySample>, String> {
    if raw_names.is_empty() {
        return Ok(HashMap::new());
    }
    let script = r##"for session do
  target="=$session:"
  signature=$(tmux capture-pane -p -e -J -S -200 -t "$target" 2>/dev/null | cksum | awk '{print $1 ":" $2}')
  title=$(tmux display-message -p -t "$target" "#{pane_title}" 2>/dev/null || true)
  printf '%s\037%s\037%s\n' "$session" "$signature" "$title"
done"##;
    let mut remote_cmd = vec![
        "sh".to_string(),
        "-c".to_string(),
        script.to_string(),
        "sh".to_string(),
    ];
    remote_cmd.extend(raw_names.iter().cloned());
    let output = run_remote_cmd_check_strings(host, &remote_cmd)?;
    let mut samples = HashMap::new();
    for line in output.lines().filter(|line| !line.is_empty()) {
        let mut parts = line.splitn(3, '\x1f');
        let Some(raw_name) = parts.next().map(str::trim).filter(|name| !name.is_empty()) else {
            continue;
        };
        let output_signature = parts
            .next()
            .map(str::trim)
            .filter(|signature| !signature.is_empty())
            .map(|signature| format!("remote:{signature}"));
        let agent_running = parts.next().map(agent_running_from_pane_title);
        samples.insert(
            raw_name.to_string(),
            RemoteSessionActivitySample {
                output_signature,
                agent_running,
            },
        );
    }
    Ok(samples)
}

pub(crate) fn pane_output_signature(name: &str) -> Option<String> {
    let output = std::process::Command::new(tmux_bin())
        .args(["capture-pane", "-p", "-e", "-J", "-S", "-200", "-t", name])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let trimmed = text.trim_end_matches('\n');
    Some(stable_output_signature(trimmed))
}

pub(crate) fn session_agent_running(target: &str) -> Option<bool> {
    let output = std::process::Command::new(tmux_bin())
        .args([
            "list-panes",
            "-t",
            target,
            "-F",
            "#{pane_active}\x1f#{pane_title}",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut first_title = None;
    for line in stdout.lines().filter(|line| !line.is_empty()) {
        let mut parts = line.splitn(2, '\x1f');
        let active = parts.next().unwrap_or_default();
        let title = parts.next().unwrap_or_default();
        if first_title.is_none() {
            first_title = Some(title.to_string());
        }
        if active == "1" {
            return Some(agent_running_from_pane_title(title));
        }
    }

    first_title.as_deref().map(agent_running_from_pane_title)
}

pub(crate) fn agent_running_from_pane_title(title: &str) -> bool {
    let mut chars = title.trim_start().chars();
    let Some(first) = chars.next() else {
        return false;
    };
    ('\u{2800}'..='\u{28ff}').contains(&first)
        && chars.next().is_some_and(|next| next.is_whitespace())
}

pub(crate) fn stable_output_signature(text: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}
