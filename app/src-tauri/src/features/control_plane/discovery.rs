use std::path::{Path, PathBuf};
use tauri::Manager;

fn executable_exists(path: &Path) -> bool {
    path.is_file()
}

fn which_cmd(name: &str) -> Option<String> {
    let output = std::process::Command::new("/usr/bin/which")
        .arg(name)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

fn first_existing_command(candidates: &[&str], name: &str) -> Option<String> {
    candidates
        .iter()
        .find(|path| executable_exists(Path::new(path)))
        .map(|path| path.to_string())
        .or_else(|| which_cmd(name))
}

pub(crate) fn node_bin() -> Option<String> {
    first_existing_command(
        &[
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        ],
        "node",
    )
}

fn bundled_cli_candidates(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(path) = std::env::var_os("TW_DASHBOARD_CLI").filter(|v| !v.is_empty()) {
        paths.push(PathBuf::from(path));
    }
    if let Ok(resources) = app.path().resource_dir() {
        paths.push(resources.join("tw-cli").join("cli.js"));
        paths.push(resources.join("dist").join("cli.js"));
        paths.push(resources.join("cli.js"));
    }
    paths.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../dist/cli.js"));
    paths
}

pub(crate) fn bundled_cli_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    bundled_cli_candidates(app)
        .into_iter()
        .find(|path| executable_exists(path))
}

pub(crate) fn installed_tw_command() -> Option<String> {
    first_existing_command(
        &[
            "/opt/homebrew/bin/tw",
            "/usr/local/bin/tw",
            "/opt/homebrew/bin/tmux-worktree",
            "/usr/local/bin/tmux-worktree",
        ],
        "tw",
    )
    .or_else(|| which_cmd("tmux-worktree"))
}
