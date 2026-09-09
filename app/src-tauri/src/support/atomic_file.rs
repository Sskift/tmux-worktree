use std::io::Write;
use std::path::Path;

pub(crate) fn atomic_write_file_with<F>(
    path: &Path,
    contents: &[u8],
    before_rename: F,
) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("invalid file path: {}", path.display()))?;
    let temp_path = parent.join(format!(
        ".{file_name}.tmp-{}",
        uuid::Uuid::new_v4().simple()
    ));

    let result = (|| -> Result<(), String> {
        let mut options = std::fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temp_path)
            .map_err(|error| format!("create {}: {error}", temp_path.display()))?;
        file.write_all(contents)
            .map_err(|error| format!("write {}: {error}", temp_path.display()))?;
        file.flush()
            .map_err(|error| format!("flush {}: {error}", temp_path.display()))?;
        file.sync_all()
            .map_err(|error| format!("sync {}: {error}", temp_path.display()))?;
        drop(file);

        before_rename(&temp_path)?;
        std::fs::rename(&temp_path, path).map_err(|error| {
            format!(
                "rename {} to {}: {error}",
                temp_path.display(),
                path.display()
            )
        })?;
        if let Ok(directory) = std::fs::File::open(parent) {
            let _ = directory.sync_all();
        }
        Ok(())
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&temp_path);
    }
    result
}

pub(crate) fn atomic_write_file(path: &Path, contents: &[u8]) -> Result<(), String> {
    atomic_write_file_with(path, contents, |_| Ok(()))
}

/// Quarantine backups are kept for a week before unlinking: they are
/// forensic evidence for a torn/corrupt state file, but accumulate
/// forever if never reclaimed.
const SWEEP_CORRUPT_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 60 * 60);

/// A pre-rename atomic-write temp file that outlives an hour cannot
/// belong to a live writer (a write completes in milliseconds); it is a
/// kill/crash orphan. Mirrors the Node side (sweepStateFileArtifacts
/// in src/stateFileArtifacts.ts), which uses the same two windows.
const SWEEP_TMP_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(60 * 60);

/// Remove quarantine backups and atomic-write temp files orphaned next to
/// `path` by crashed processes on either side (Rust Dashboard or Node
/// CLI/relay). Only touches the state file's own directory (never
/// recursive) and only these name patterns:
/// - `<basename>.corrupt-*` (quarantine backups from both sides),
/// - `<basename>.*.tmp` (Node `<pid>.<uuid>` atomic temp files),
/// - `.<basename>.tmp-*` (Rust atomic_write_file temp files).
///
/// Call ONLY after a successful state load: a failed load may need the
/// quarantined bytes for recovery, and the age windows (7 days /
/// 1 hour) are what make deletion safe, not the call site.
pub(crate) fn sweep_state_file_artifacts(path: &Path) {
    let Some(directory) = path.parent() else {
        return;
    };
    let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    let corrupt_prefix = format!("{file_name}.corrupt-");
    let node_tmp_prefix = format!("{file_name}.");
    let rust_tmp_prefix = format!(".{file_name}.tmp-");

    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let is_corrupt = name.starts_with(&corrupt_prefix);
        let is_node_tmp = name.starts_with(&node_tmp_prefix) && name.ends_with(".tmp");
        let is_rust_tmp = name.starts_with(&rust_tmp_prefix);
        if !is_corrupt && !is_node_tmp && !is_rust_tmp {
            continue;
        }
        let max_age = if is_corrupt {
            SWEEP_CORRUPT_MAX_AGE
        } else {
            SWEEP_TMP_MAX_AGE
        };
        let old_enough = entry
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age > max_age);
        if !old_enough {
            continue;
        }
        if let Err(error) = std::fs::remove_file(entry.path()) {
            eprintln!(
                "warning: could not sweep stale state artifact {}: {error}",
                entry.path().display()
            );
        }
    }
}
