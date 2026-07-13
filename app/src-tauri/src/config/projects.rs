use super::{
    acquire_dashboard_config_file_lock, dashboard_config_write_lock, find_host, string_field,
};
use crate::ipc::Project;
use crate::remote::{remote_home_dir_for_host, run_remote_cmd_check, HostConfig};
use crate::support::{
    app_home_dir, atomic_write_file, expand_home_path, expand_home_path_with_home,
};
use serde::{Deserialize, Serialize};
use std::path::Path;

fn expand_config_path(value: &str, home: Option<&str>) -> String {
    match home {
        Some(home) => expand_home_path_with_home(value, home),
        None => expand_home_path(value),
    }
}

fn project_from_value_with_home(
    name: String,
    value: &serde_json::Value,
    home: Option<&str>,
) -> Option<Project> {
    if let Some(path) = value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(Project {
            name,
            path: expand_config_path(path, home),
            branch: None,
        });
    }

    let path = string_field(
        value,
        &[
            "path",
            "dir",
            "directory",
            "root",
            "repo",
            "repoPath",
            "repository",
            "repositoryPath",
        ],
    )?;
    let branch = string_field(
        value,
        &[
            "branch",
            "targetBranch",
            "target_branch",
            "defaultBranch",
            "default_branch",
        ],
    )
    .map(ToString::to_string);
    Some(Project {
        name,
        path: expand_config_path(path, home),
        branch,
    })
}

fn project_from_array_item_with_home(
    value: &serde_json::Value,
    home: Option<&str>,
) -> Option<Project> {
    if let Some(path) = value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let expanded = expand_config_path(path, home);
        let name = Path::new(&expanded)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&expanded)
            .to_string();
        return Some(Project {
            name,
            path: expanded,
            branch: None,
        });
    }

    let name = string_field(value, &["name", "key", "id", "label"])?.to_string();
    project_from_value_with_home(name, value, home)
}

fn projects_value(config: &serde_json::Value) -> Option<&serde_json::Value> {
    if config.is_array() {
        return Some(config);
    }
    ["projects", "repositories", "repos"]
        .iter()
        .find_map(|key| config.get(key))
}

pub(crate) fn projects_from_config(config: &serde_json::Value) -> Vec<Project> {
    projects_from_config_with_home(config, None)
}

pub(crate) fn projects_from_config_with_home(
    config: &serde_json::Value,
    home: Option<&str>,
) -> Vec<Project> {
    match projects_value(config) {
        Some(serde_json::Value::Object(object)) => object
            .iter()
            .filter_map(|(name, value)| project_from_value_with_home(name.clone(), value, home))
            .collect(),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .filter_map(|value| project_from_array_item_with_home(value, home))
            .collect(),
        _ => vec![],
    }
}

#[cfg(test)]
pub(crate) fn project_from_config(config: &serde_json::Value, name: &str) -> Option<Project> {
    project_from_config_with_home(config, name, None)
}

pub(crate) fn project_from_config_with_home(
    config: &serde_json::Value,
    name: &str,
    home: Option<&str>,
) -> Option<Project> {
    projects_value(config).and_then(|projects| match projects {
        serde_json::Value::Object(object) => object
            .get(name)
            .and_then(|value| project_from_value_with_home(name.to_string(), value, home)),
        serde_json::Value::Array(items) => items.iter().find_map(|value| {
            let project = project_from_array_item_with_home(value, home)?;
            (project.name == name).then_some(project)
        }),
        _ => None,
    })
}

pub(crate) fn config_worktree_base(config: &serde_json::Value) -> Option<String> {
    config_worktree_base_with_home(config, None)
}

pub(crate) fn config_worktree_base_with_home(
    config: &serde_json::Value,
    home: Option<&str>,
) -> Option<String> {
    string_field(
        config,
        &[
            "worktreeBase",
            "worktree_base",
            "worktreeDir",
            "worktreeRoot",
            "worktreesDir",
            "worktreesRoot",
        ],
    )
    .map(|path| expand_config_path(path, home))
}

#[tauri::command]
pub(crate) fn list_projects() -> Result<Vec<Project>, String> {
    let home = app_home_dir().ok_or("home dir not found")?;
    let config_path = home.join(".tmux-worktree.json");

    if !config_path.exists() {
        return Ok(vec![]);
    }

    let content =
        std::fs::read_to_string(&config_path).map_err(|error| format!("read config: {error}"))?;
    let config: serde_json::Value =
        serde_json::from_str(&content).map_err(|error| format!("parse config: {error}"))?;

    Ok(projects_from_config(&config))
}

#[derive(Deserialize)]
pub(crate) struct AddProjectArgs {
    name: String,
    path: String,
}

#[derive(Deserialize)]
pub(crate) struct RemoveMissingProjectArgs {
    pub(crate) name: String,
    pub(crate) path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoveMissingProjectResult {
    pub(crate) removed: bool,
    pub(crate) projects: Vec<Project>,
}

fn project_entry_matches(
    value: &serde_json::Value,
    mapped_name: Option<&str>,
    name: &str,
    path: &str,
) -> bool {
    let project = match mapped_name {
        Some(mapped_name) => project_from_value_with_home(mapped_name.to_string(), value, None),
        None => project_from_array_item_with_home(value, None),
    };
    project.is_some_and(|project| project.name == name && project.path == path)
}

fn remove_exact_project_entry(config: &mut serde_json::Value, name: &str, path: &str) -> bool {
    if let serde_json::Value::Array(items) = config {
        let original_len = items.len();
        items.retain(|value| !project_entry_matches(value, None, name, path));
        return items.len() != original_len;
    }

    let Some(root) = config.as_object_mut() else {
        return false;
    };
    let Some(projects_key) = ["projects", "repositories", "repos"]
        .iter()
        .find(|key| root.contains_key(**key))
        .copied()
    else {
        return false;
    };
    let Some(projects) = root.get_mut(projects_key) else {
        return false;
    };

    match projects {
        serde_json::Value::Object(entries) => {
            let matches = entries
                .get(name)
                .is_some_and(|value| project_entry_matches(value, Some(name), name, path));
            if matches {
                entries.remove(name);
            }
            matches
        }
        serde_json::Value::Array(items) => {
            let original_len = items.len();
            items.retain(|value| !project_entry_matches(value, None, name, path));
            items.len() != original_len
        }
        _ => false,
    }
}

/// Remove only the locally configured project entry the caller selected, and
/// only after reloading the locked config and confirming that the exact path
/// is still configured and no longer exists. This prevents a stale UI request
/// from deleting a concurrently replaced preset.
#[tauri::command]
pub(crate) fn remove_missing_project(
    args: RemoveMissingProjectArgs,
) -> Result<RemoveMissingProjectResult, String> {
    let name = args.name.trim();
    let selected_path = expand_config_path(args.path.trim(), None);
    if name.is_empty() {
        return Err("name required".into());
    }
    if selected_path.is_empty() {
        return Err("path required".into());
    }

    let home = app_home_dir().ok_or("home dir not found")?;
    let config_path = home.join(".tmux-worktree.json");
    let _guard = dashboard_config_write_lock()
        .lock()
        .map_err(|_| "dashboard config write lock poisoned".to_string())?;
    let _file_guard = acquire_dashboard_config_file_lock()?;

    if !config_path.exists() {
        return Ok(RemoveMissingProjectResult {
            removed: false,
            projects: vec![],
        });
    }

    let text =
        std::fs::read_to_string(&config_path).map_err(|error| format!("read config: {error}"))?;
    let mut config: serde_json::Value =
        serde_json::from_str(&text).map_err(|error| format!("parse config: {error}"))?;
    let selected_is_current = projects_from_config(&config)
        .iter()
        .any(|project| project.name == name && project.path == selected_path);

    if !selected_is_current || Path::new(&selected_path).exists() {
        return Ok(RemoveMissingProjectResult {
            removed: false,
            projects: projects_from_config(&config),
        });
    }

    let removed = remove_exact_project_entry(&mut config, name, &selected_path);
    if removed {
        let mut pretty = serde_json::to_string_pretty(&config)
            .map_err(|error| format!("serialize config: {error}"))?;
        pretty.push('\n');
        atomic_write_file(&config_path, pretty.as_bytes())
            .map_err(|error| format!("write config: {error}"))?;
    }

    Ok(RemoveMissingProjectResult {
        removed,
        projects: projects_from_config(&config),
    })
}

#[tauri::command]
pub(crate) fn add_project(args: AddProjectArgs) -> Result<Vec<Project>, String> {
    let name = args.name.trim();
    let path = args.path.trim();
    if name.is_empty() {
        return Err("name required".into());
    }
    if path.is_empty() {
        return Err("path required".into());
    }
    if !Path::new(path).is_dir() {
        return Err(format!("not a directory: {path}"));
    }

    let home = app_home_dir().ok_or("home dir not found")?;
    let config_path = home.join(".tmux-worktree.json");
    let _guard = dashboard_config_write_lock()
        .lock()
        .map_err(|_| "dashboard config write lock poisoned".to_string())?;
    let _file_guard = acquire_dashboard_config_file_lock()?;

    let mut config: serde_json::Value = if config_path.exists() {
        let text = std::fs::read_to_string(&config_path)
            .map_err(|error| format!("read config: {error}"))?;
        serde_json::from_str(&text).map_err(|error| format!("parse config: {error}"))?
    } else {
        serde_json::json!({ "projects": {} })
    };

    let root = config
        .as_object_mut()
        .ok_or("config root is not an object")?;
    let projects_key = if root.contains_key("projects") {
        "projects"
    } else if root.contains_key("repositories") {
        "repositories"
    } else if root.contains_key("repos") {
        "repos"
    } else {
        "projects"
    };
    match root
        .entry(projects_key)
        .or_insert_with(|| serde_json::json!({}))
    {
        serde_json::Value::Object(projects) => {
            projects.insert(
                name.to_string(),
                serde_json::Value::String(path.to_string()),
            );
        }
        serde_json::Value::Array(projects) => {
            if let Some(existing) = projects.iter_mut().find(|item| {
                string_field(item, &["name", "key", "id", "label"]).as_deref() == Some(name)
            }) {
                *existing = serde_json::json!({ "name": name, "path": path });
            } else {
                projects.push(serde_json::json!({ "name": name, "path": path }));
            }
        }
        _ => return Err("projects is not an object or array".into()),
    }

    let pretty = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("serialize config: {error}"))?;
    atomic_write_file(&config_path, pretty.as_bytes())
        .map_err(|error| format!("write config: {error}"))?;

    list_projects()
}

pub(crate) fn remote_config_for_host(
    host: &HostConfig,
) -> Result<Option<(serde_json::Value, String)>, String> {
    let home = remote_home_dir_for_host(host)?;
    let text = run_remote_cmd_check(
        host,
        &[
            "sh",
            "-c",
            r#"home=${1:-${HOME:-.}}; config="${home%/}/.tmux-worktree.json"; if [ -f "$config" ]; then cat "$config"; fi"#,
            "sh",
            &home,
        ],
    )
    .map_err(|error| format!("read remote config on {}: {error}", host.label))?;
    let text = text.trim();
    if text.is_empty() {
        return Ok(None);
    }
    let config: serde_json::Value = serde_json::from_str(text)
        .map_err(|error| format!("parse remote config on {}: {error}", host.label))?;
    Ok(Some((config, home)))
}

#[tauri::command]
pub(crate) async fn list_remote_projects(host_id: String) -> Result<Vec<Project>, String> {
    let host_id = host_id.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let host = find_host(&host_id)?;
        let Some((config, home)) = remote_config_for_host(&host)? else {
            return Ok(vec![]);
        };
        Ok(projects_from_config_with_home(&config, Some(home.as_str())))
    })
    .await
    .map_err(|error| format!("remote projects task failed: {error}"))?
}
