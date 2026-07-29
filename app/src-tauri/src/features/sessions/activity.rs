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
  current_command=$(tmux display-message -p -t "$target" "#{pane_current_command}" 2>/dev/null || true)
  start_command=$(tmux display-message -p -t "$target" "#{pane_start_command}" 2>/dev/null || true)
  printf '%s\037%s\037%s\037%s\037%s\n' "$session" "$signature" "$title" "$current_command" "$start_command"
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
        let mut parts = line.splitn(5, '\x1f');
        let Some(raw_name) = parts.next().map(str::trim).filter(|name| !name.is_empty()) else {
            continue;
        };
        let output_signature = parts
            .next()
            .map(str::trim)
            .filter(|signature| !signature.is_empty())
            .map(|signature| format!("remote:{signature}"));
        let title = parts.next().unwrap_or_default();
        let current_command = parts.next().unwrap_or_default();
        let start_command = parts.next().unwrap_or_default();
        let agent_running = agent_running_from_pane(title, current_command, start_command);
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
            "#{pane_active}\x1f#{pane_title}\x1f#{pane_current_command}\x1f#{pane_start_command}",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut first_observation = None;
    for line in stdout.lines().filter(|line| !line.is_empty()) {
        let mut parts = line.splitn(4, '\x1f');
        let active = parts.next().unwrap_or_default();
        let title = parts.next().unwrap_or_default();
        let current_command = parts.next().unwrap_or_default();
        let start_command = parts.next().unwrap_or_default();
        if first_observation.is_none() {
            first_observation = Some((
                title.to_string(),
                current_command.to_string(),
                start_command.to_string(),
            ));
        }
        if active == "1" {
            return agent_running_from_pane(title, current_command, start_command);
        }
    }

    first_observation
        .as_ref()
        .and_then(|(title, current, start)| agent_running_from_pane(title, current, start))
}

pub(crate) fn agent_running_from_pane_title(title: &str) -> bool {
    let mut chars = title.trim_start().chars();
    let Some(first) = chars.next() else {
        return false;
    };
    ('\u{2800}'..='\u{28ff}').contains(&first)
        && chars.next().is_some_and(|next| next.is_whitespace())
}

fn is_kimi_executable(value: &str) -> bool {
    let executable = value
        .trim_matches(|character: char| {
            character.is_whitespace() || character == '\'' || character == '"'
        })
        .rsplit('/')
        .next()
        .unwrap_or_default();
    matches!(executable, "kimi" | "kimicode" | "kimi-code")
}

fn command_starts_kimi(command: &str) -> bool {
    command.split([';', '\n']).any(|segment| {
        let mut tokens = segment.split_whitespace();
        let Some(mut executable) = tokens.next() else {
            return false;
        };
        while matches!(
            executable.trim_matches(|character: char| {
                character.is_whitespace() || character == '\'' || character == '"'
            }),
            "exec" | "command" | "nohup"
        ) {
            let Some(next) = tokens.next() else {
                return false;
            };
            executable = next;
        }
        is_kimi_executable(executable)
    })
}

pub(crate) fn agent_running_from_pane(
    title: &str,
    current_command: &str,
    start_command: &str,
) -> Option<bool> {
    if agent_running_from_pane_title(title) {
        return Some(true);
    }
    if title.trim().eq_ignore_ascii_case("Kimi Code")
        || is_kimi_executable(current_command)
        || command_starts_kimi(start_command)
    {
        // Kimi Code keeps its session title unchanged while a turn runs. An
        // unknown title hint lets the renderer use its existing consecutive
        // pane-output signature classifier instead of reporting every turn as
        // stopped.
        return None;
    }
    Some(false)
}

pub(crate) fn stable_output_signature(text: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}
