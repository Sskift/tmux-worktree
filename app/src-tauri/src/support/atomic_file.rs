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
