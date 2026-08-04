use crate::config::find_host;
use crate::ipc::DirEntry;
use crate::remote::{
    remote_home_dir_for_host, run_remote_cmd_check, run_remote_cmd_output,
    run_remote_cmd_with_input, HostConfig,
};
use crate::support::app_home_dir;
use base64::Engine;
use serde::Serialize;

#[tauri::command]
pub(crate) fn home_dir() -> Result<String, String> {
    app_home_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .ok_or_else(|| "home dir not found".into())
}

#[tauri::command]
pub(crate) async fn remote_home_dir(host_id: String) -> Result<String, String> {
    let host_id = host_id.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let host = find_host(&host_id)?;
        remote_home_dir_for_host(&host)
    })
    .await
    .map_err(|error| format!("remote home task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn remote_read_dir(
    host_id: String,
    path: String,
) -> Result<Vec<DirEntry>, String> {
    let host_id = host_id.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let host = find_host(&host_id)?;
        remote_read_dirs_for_host(&host, &path)
    })
    .await
    .map_err(|error| format!("remote read dir task failed: {error}"))?
}

pub(crate) fn remote_read_dirs_for_host(
    host: &HostConfig,
    path: &str,
) -> Result<Vec<DirEntry>, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("remote path required".to_string());
    }
    let script = r#"dir=${1:-$HOME}; LC_ALL=C find -L "$dir" -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null | sort -z"#;
    let output = run_remote_cmd_check(host, &["sh", "-c", script, "sh", path])
        .map_err(|error| format!("read remote directory on {}: {error}", host.label))?;
    let entries = output
        .split('\0')
        .map(str::trim)
        .filter(|entry_path| !entry_path.is_empty())
        .map(|entry_path| {
            let name = entry_path
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .filter(|name| !name.is_empty())
                .unwrap_or(entry_path)
                .to_string();
            DirEntry {
                is_hidden: name.starts_with('.'),
                name,
                path: entry_path.to_string(),
                is_dir: true,
                is_symlink: false,
                size: 0,
            }
        })
        .collect();
    Ok(entries)
}

#[tauri::command]
pub(crate) fn read_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let directory = std::path::Path::new(&path);
    if !directory.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    let entries = std::fs::read_dir(directory).map_err(|error| format!("read_dir: {error}"))?;
    let mut result = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let entry_path = entry.path().to_string_lossy().to_string();
        let is_symlink = std::fs::symlink_metadata(entry.path())
            .map(|metadata| metadata.is_symlink())
            .unwrap_or(false);
        let (is_dir, size) = match entry.metadata() {
            Ok(metadata) => (metadata.is_dir(), metadata.len()),
            Err(_) => continue,
        };
        let is_hidden = name.starts_with('.');
        result.push(DirEntry {
            name,
            path: entry_path,
            is_dir,
            is_symlink,
            is_hidden,
            size,
        });
    }
    result.sort_by(|left, right| {
        right
            .is_dir
            .cmp(&left.is_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
    Ok(result)
}

#[tauri::command]
pub(crate) fn read_file(path: String) -> Result<String, String> {
    let path_ref = std::path::Path::new(&path);
    if !path_ref.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let metadata = std::fs::metadata(path_ref).map_err(|error| format!("metadata: {error}"))?;
    if metadata.len() > MAX_EDITABLE_FILE_SIZE {
        return Err("file too large (>5 MB)".into());
    }
    std::fs::read_to_string(path_ref).map_err(|error| format!("read: {error}"))
}

#[tauri::command]
pub(crate) fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, &content).map_err(|error| format!("write: {error}"))
}

#[tauri::command]
pub(crate) fn open_url(url: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(&url)
        .spawn()
        .map_err(|error| format!("open url: {error}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn file_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

const MAX_EDITABLE_FILE_SIZE: u64 = 5 * 1024 * 1024;

const REMOTE_READ_FILE_SCRIPT: &str = r#"path=$1
if [ ! -f "$path" ]; then
  printf 'not a file: %s\n' "$path" >&2
  exit 44
fi
size=$(wc -c < "$path") || exit 45
case "$size" in
  ''|*[!0-9]*) printf 'invalid file size: %s\n' "$path" >&2; exit 45 ;;
esac
if [ "$size" -gt 5242880 ]; then
  printf 'file too large (>5 MB): %s\n' "$path" >&2
  exit 46
fi
cat "$path""#;

const REMOTE_WRITE_FILE_SCRIPT: &str = r#"path=$1
if [ -z "$path" ]; then
  printf 'remote path required\n' >&2
  exit 43
fi
if [ -e "$path" ] && [ ! -f "$path" ]; then
  printf 'not a file: %s\n' "$path" >&2
  exit 44
fi
dir=${path%/*}
if [ "$dir" != "$path" ] && [ ! -d "$dir" ]; then
  printf 'parent directory does not exist: %s\n' "$dir" >&2
  exit 45
fi
tmp=$(mktemp "${path}.tw-dashboard-write.XXXXXX") || exit 46
cleanup() { rm -f "$tmp"; }
trap cleanup 0 HUP INT TERM
if [ -e "$path" ]; then
  cp -p "$path" "$tmp" || exit 46
fi
cat > "$tmp" || exit 47
mv "$tmp" "$path" || exit 48
trap - 0 HUP INT TERM"#;

fn remote_file_error(host: &HostConfig, action: &str, output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = stderr.trim();
    if detail.is_empty() {
        format!("{action} on {} failed with {}", host.label, output.status)
    } else {
        format!("{action} on {} failed: {detail}", host.label)
    }
}

pub(crate) fn remote_file_exists_for_host(host: &HostConfig, path: &str) -> Result<bool, String> {
    if path.trim().is_empty() {
        return Ok(false);
    }
    let output = run_remote_cmd_output(host, &["sh", "-c", "test -f \"$1\"", "sh", path])?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(remote_file_error(host, "check remote file", &output)),
    }
}

pub(crate) fn remote_read_file_bytes_for_host(
    host: &HostConfig,
    path: &str,
) -> Result<Vec<u8>, String> {
    if path.trim().is_empty() {
        return Err("remote path required".to_string());
    }
    let output = run_remote_cmd_output(host, &["sh", "-c", REMOTE_READ_FILE_SCRIPT, "sh", path])?;
    if !output.status.success() {
        return Err(remote_file_error(host, "read remote file", &output));
    }
    if output.stdout.len() as u64 > MAX_EDITABLE_FILE_SIZE {
        return Err("file too large (>5 MB)".to_string());
    }
    Ok(output.stdout)
}

pub(crate) fn remote_write_file_for_host(
    host: &HostConfig,
    path: &str,
    content: &[u8],
) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("remote path required".to_string());
    }
    if content.len() as u64 > MAX_EDITABLE_FILE_SIZE {
        return Err("file too large (>5 MB)".to_string());
    }
    let output = run_remote_cmd_with_input(
        host,
        &["sh", "-c", REMOTE_WRITE_FILE_SCRIPT, "sh", path],
        content,
    )?;
    if !output.status.success() {
        return Err(remote_file_error(host, "write remote file", &output));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn remote_file_exists(host_id: String, path: String) -> Result<bool, String> {
    let host_id = host_id.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let host = find_host(&host_id)?;
        remote_file_exists_for_host(&host, &path)
    })
    .await
    .map_err(|error| format!("remote file check task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn remote_read_file(host_id: String, path: String) -> Result<String, String> {
    let host_id = host_id.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let host = find_host(&host_id)?;
        let bytes = remote_read_file_bytes_for_host(&host, &path)?;
        String::from_utf8(bytes).map_err(|_| format!("remote file is not UTF-8: {path}"))
    })
    .await
    .map_err(|error| format!("remote file read task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn remote_read_file_base64(
    host_id: String,
    path: String,
) -> Result<String, String> {
    let host_id = host_id.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let host = find_host(&host_id)?;
        let bytes = remote_read_file_bytes_for_host(&host, &path)?;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    })
    .await
    .map_err(|error| format!("remote image read task failed: {error}"))?
}

#[tauri::command]
pub(crate) async fn remote_write_file(
    host_id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let host_id = host_id.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let host = find_host(&host_id)?;
        remote_write_file_for_host(&host, &path, content.as_bytes())
    })
    .await
    .map_err(|error| format!("remote file write task failed: {error}"))?
}

#[derive(Serialize, Clone)]
pub(crate) struct SearchResult {
    path: String,
    file_name: String,
    line_number: Option<usize>,
    line_content: Option<String>,
}

const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".DS_Store",
    "dist",
    "__pycache__",
    ".next",
    ".turbo",
];

fn walk_search(
    dir: &std::path::Path,
    query_lower: &str,
    mode: &str,
    root: &std::path::Path,
    results: &mut Vec<SearchResult>,
    limit: usize,
) {
    if results.len() >= limit {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    let mut directories = Vec::new();
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        let path = entry.path();
        let is_dir = path.is_dir();
        if is_dir {
            directories.push(path);
        } else {
            files.push((path, name));
        }
    }
    for (path, name) in files {
        if results.len() >= limit {
            return;
        }
        let relative_path = path.to_string_lossy().to_string();
        let file_name = name;
        if mode == "filename" {
            if file_name.to_lowercase().contains(query_lower) {
                results.push(SearchResult {
                    path: relative_path,
                    file_name,
                    line_number: None,
                    line_content: None,
                });
            }
        } else {
            // content mode
            let metadata = match std::fs::metadata(&path) {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            if metadata.len() > 1024 * 1024 {
                continue;
            }
            let text = match std::fs::read_to_string(&path) {
                Ok(text) => text,
                Err(_) => continue,
            };
            for (index, line) in text.lines().enumerate() {
                if results.len() >= limit {
                    return;
                }
                if line.to_lowercase().contains(query_lower) {
                    let trimmed = if line.len() > 200 { &line[..200] } else { line };
                    results.push(SearchResult {
                        path: relative_path.clone(),
                        file_name: file_name.clone(),
                        line_number: Some(index + 1),
                        line_content: Some(trimmed.to_string()),
                    });
                }
            }
        }
    }
    for directory in directories {
        if results.len() >= limit {
            return;
        }
        walk_search(&directory, query_lower, mode, root, results, limit);
    }
}

#[tauri::command]
pub(crate) fn search_files(
    root: String,
    query: String,
    mode: String,
) -> Result<Vec<SearchResult>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let root_path = std::path::Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();
    walk_search(root_path, &query_lower, &mode, root_path, &mut results, 100);
    Ok(results)
}
