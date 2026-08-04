use super::model::{GitFile, GitStatus};
use super::runner::{run_git_output, run_git_quiet};

fn git_status_for(cwd: &str, host_id: Option<&str>) -> Result<Option<GitStatus>, String> {
    let inside = run_git_quiet(host_id, &["-C", cwd, "rev-parse", "--is-inside-work-tree"]);
    if inside.as_deref() != Some("true") {
        return Ok(None);
    }

    let output = run_git_output(
        host_id,
        &["-C", cwd, "status", "--porcelain=v2", "--branch"],
    )?;
    if !output.status.success() {
        return Err(format!(
            "git status failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut status = GitStatus {
        branch: String::new(),
        upstream: None,
        ahead: 0,
        behind: 0,
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicts: 0,
        files: Vec::new(),
    };

    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("# branch.head ") {
            status.branch = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("# branch.upstream ") {
            status.upstream = Some(rest.to_string());
        } else if let Some(rest) = line.strip_prefix("# branch.ab ") {
            let mut parts = rest.split_whitespace();
            if let Some(ahead) = parts.next() {
                status.ahead = ahead.trim_start_matches('+').parse().unwrap_or(0);
            }
            if let Some(behind) = parts.next() {
                status.behind = behind.trim_start_matches('-').parse().unwrap_or(0);
            }
        } else if let Some(rest) = line.strip_prefix("1 ") {
            // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
            let mut parts = rest.splitn(8, ' ');
            let xy = parts.next().unwrap_or("..");
            let path = parts.nth(6).unwrap_or("").to_string();
            let (x, y) = (
                xy.chars().next().unwrap_or('.'),
                xy.chars().nth(1).unwrap_or('.'),
            );
            if x != '.' {
                status.staged += 1;
            }
            if y != '.' {
                status.unstaged += 1;
            }
            status.files.push(GitFile {
                code: xy.to_string(),
                path,
            });
        } else if let Some(rest) = line.strip_prefix("2 ") {
            // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X-score> <path><tab><origPath>
            let mut parts = rest.splitn(9, ' ');
            let xy = parts.next().unwrap_or("..");
            let tail = parts.nth(7).unwrap_or("");
            let path = tail.split('\t').next().unwrap_or("").to_string();
            let (x, y) = (
                xy.chars().next().unwrap_or('.'),
                xy.chars().nth(1).unwrap_or('.'),
            );
            if x != '.' {
                status.staged += 1;
            }
            if y != '.' {
                status.unstaged += 1;
            }
            status.files.push(GitFile {
                code: xy.to_string(),
                path,
            });
        } else if let Some(rest) = line.strip_prefix("u ") {
            // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
            let mut parts = rest.splitn(10, ' ');
            let xy = parts.next().unwrap_or("UU");
            let path = parts.nth(8).unwrap_or("").to_string();
            status.conflicts += 1;
            status.files.push(GitFile {
                code: xy.to_string(),
                path,
            });
        } else if let Some(rest) = line.strip_prefix("? ") {
            status.untracked += 1;
            status.files.push(GitFile {
                code: "??".to_string(),
                path: rest.to_string(),
            });
        }
    }

    Ok(Some(status))
}

#[tauri::command]
pub(crate) async fn git_status(
    cwd: String,
    host_id: Option<String>,
) -> Result<Option<GitStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || git_status_for(&cwd, host_id.as_deref()))
        .await
        .map_err(|error| format!("git status task failed: {error}"))?
}

fn git_diff_for(cwd: &str, path: &str, host_id: Option<&str>) -> Result<String, String> {
    // Try unstaged diff first
    let output = run_git_output(host_id, &["-C", cwd, "diff", "--", path])?;
    if !output.status.success() {
        return Err(format!(
            "git diff failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let diff = String::from_utf8_lossy(&output.stdout).to_string();

    if !diff.trim().is_empty() {
        return Ok(diff);
    }

    // Try staged diff
    let staged_output = run_git_output(host_id, &["-C", cwd, "diff", "--cached", "--", path])?;
    if !staged_output.status.success() {
        return Err(format!(
            "git diff --cached failed: {}",
            String::from_utf8_lossy(&staged_output.stderr).trim()
        ));
    }

    let staged = String::from_utf8_lossy(&staged_output.stdout).to_string();

    if !staged.trim().is_empty() {
        return Ok(staged);
    }

    // For untracked files, show entire file as addition
    let untracked_output = run_git_output(
        host_id,
        &["-C", cwd, "diff", "--no-index", "/dev/null", path],
    );

    if let Ok(output) = untracked_output {
        if !output.status.success() && output.status.code() != Some(1) {
            return Err(format!(
                "git diff --no-index failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let untracked = String::from_utf8_lossy(&output.stdout).to_string();
        if !untracked.trim().is_empty() {
            return Ok(untracked);
        }
    }

    Ok(String::new())
}

#[tauri::command]
pub(crate) async fn git_diff(
    cwd: String,
    path: String,
    host_id: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || git_diff_for(&cwd, &path, host_id.as_deref()))
        .await
        .map_err(|error| format!("git diff task failed: {error}"))?
}
