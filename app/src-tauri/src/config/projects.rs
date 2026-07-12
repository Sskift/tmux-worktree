use super::{
    acquire_dashboard_config_file_lock, dashboard_config_write_lock, find_host, string_field,
};
use crate::ipc::Project;
use crate::remote::{remote_home_dir_for_host, run_remote_cmd_check, HostConfig};
use crate::support::{
    app_home_dir, atomic_write_file, expand_home_path, expand_home_path_with_home,
};
use serde::Deserialize;
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
            .filter_map(|value| {
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
            })
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
            let project_name = string_field(value, &["name", "key", "id", "label"])?;
            if project_name == name {
                project_from_value_with_home(name.to_string(), value, home)
            } else {
                None
            }
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
