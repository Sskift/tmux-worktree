use crate::config::find_host;
use crate::remote::run_remote_cmd_output;
use crate::support::git_bin;

pub(super) fn run_git_output(
    host_id: Option<&str>,
    git_args: &[&str],
) -> Result<std::process::Output, String> {
    match host_id.filter(|id| !id.trim().is_empty()) {
        Some(host_id) => {
            let host = find_host(host_id)?;
            let mut remote_cmd = Vec::with_capacity(git_args.len() + 1);
            remote_cmd.push("git");
            remote_cmd.extend_from_slice(git_args);
            run_remote_cmd_output(&host, &remote_cmd)
        }
        None => std::process::Command::new(git_bin())
            .args(git_args)
            .output()
            .map_err(|error| format!("spawn git: {error}")),
    }
}

pub(super) fn run_git_quiet(host_id: Option<&str>, git_args: &[&str]) -> Option<String> {
    let output = run_git_output(host_id, git_args).ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
