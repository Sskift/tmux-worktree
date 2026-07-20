use crate::config::acquire_dashboard_file_lock;
use crate::support::{app_home_dir_or_tmp, atomic_write_file};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

const DASHBOARD_LAYOUT_SCHEMA_VERSION: u64 = 2;
const DASHBOARD_LAYOUT_REVISION_PREFIX: &str = "twlr1_";
const DASHBOARD_LAYOUT_REVISION_DOMAIN: &[u8] = b"tmux-worktree/dashboard-layout-revision/v1\0";
const MAX_SAFE_JSON_INTEGER_EXCLUSIVE: f64 = 9_007_199_254_740_992.0;

const LAYOUT_REVISION_CONFLICT: &str = "LAYOUT_REVISION_CONFLICT";
const LAYOUT_STATE_BLOCKED: &str = "LAYOUT_STATE_BLOCKED";
const LAYOUT_INVALID_REQUEST: &str = "LAYOUT_INVALID_REQUEST";
const LAYOUT_IO_ERROR: &str = "LAYOUT_IO_ERROR";

fn dashboard_layout_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn layout_path() -> PathBuf {
    app_home_dir_or_tmp().join(".tw-dashboard-layout.json")
}

pub(crate) fn layout_lock_path(path: &Path) -> PathBuf {
    let mut lock_path = path.as_os_str().to_os_string();
    lock_path.push(".lock");
    PathBuf::from(lock_path)
}

pub(crate) fn layout_backup_path(path: &Path, schema_version: u64) -> PathBuf {
    path.with_extension(format!("v{schema_version}.backup.json"))
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardLayoutLoadResult {
    pub(crate) layout: serde_json::Value,
    pub(crate) revision: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardLayoutSaveResult {
    pub(crate) revision: String,
    pub(crate) unchanged: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DashboardLayoutPersistenceError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
    pub(crate) retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) current_revision: Option<String>,
}

impl DashboardLayoutPersistenceError {
    fn invalid_request(message: impl Into<String>) -> Self {
        Self {
            code: LAYOUT_INVALID_REQUEST,
            message: message.into(),
            retryable: false,
            current_revision: None,
        }
    }

    fn revision_conflict(current_revision: String) -> Self {
        Self {
            code: LAYOUT_REVISION_CONFLICT,
            message: "Dashboard layout changed since it was loaded".to_string(),
            retryable: false,
            current_revision: Some(current_revision),
        }
    }

    fn state_blocked(message: impl Into<String>, current_revision: String) -> Self {
        Self {
            code: LAYOUT_STATE_BLOCKED,
            message: message.into(),
            retryable: false,
            current_revision: Some(current_revision),
        }
    }

    fn io(message: impl Into<String>) -> Self {
        Self {
            code: LAYOUT_IO_ERROR,
            message: message.into(),
            retryable: true,
            current_revision: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DashboardLayoutClassification {
    Legacy(u64),
    Current,
    Future(u64),
    Invalid,
}

struct RawDashboardLayout {
    present: bool,
    bytes: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
struct CanonicalJsonNumber {
    negative: bool,
    digits: String,
    exponent: i64,
}

fn canonical_json_number_text(text: &str) -> Option<CanonicalJsonNumber> {
    let (negative, unsigned) = match text.strip_prefix('-') {
        Some(unsigned) => (true, unsigned),
        None => (false, text),
    };
    let exponent_index = unsigned.find(|character| character == 'e' || character == 'E');
    let (mantissa, explicit_exponent) = match exponent_index {
        Some(index) => {
            let exponent = unsigned.get(index + 1..)?.parse::<i64>().ok()?;
            (unsigned.get(..index)?, exponent)
        }
        None => (unsigned, 0),
    };
    let (integer, fraction) = match mantissa.split_once('.') {
        Some((integer, fraction)) => (integer, fraction),
        None => (mantissa, ""),
    };
    if integer.is_empty()
        || !integer.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let combined = format!("{integer}{fraction}");
    let Some(first_nonzero) = combined.bytes().position(|byte| byte != b'0') else {
        return Some(CanonicalJsonNumber {
            negative: false,
            digits: "0".to_string(),
            exponent: 0,
        });
    };
    let mut digits = combined[first_nonzero..].to_string();
    let mut exponent = explicit_exponent.checked_sub(i64::try_from(fraction.len()).ok()?)?;
    while digits.ends_with('0') {
        digits.pop();
        exponent = exponent.checked_add(1)?;
    }
    Some(CanonicalJsonNumber {
        negative,
        digits,
        exponent,
    })
}

fn json_number_texts_semantically_equal(left: &str, right: &str) -> bool {
    match (
        canonical_json_number_text(left),
        canonical_json_number_text(right),
    ) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

fn json_numbers_semantically_equal(left: &serde_json::Number, right: &serde_json::Number) -> bool {
    json_number_texts_semantically_equal(&left.to_string(), &right.to_string())
}

#[cfg(test)]
pub(crate) fn json_number_texts_semantically_equal_for_test(left: &str, right: &str) -> bool {
    json_number_texts_semantically_equal(left, right)
}

fn json_values_semantically_equal(left: &serde_json::Value, right: &serde_json::Value) -> bool {
    match (left, right) {
        (serde_json::Value::Null, serde_json::Value::Null) => true,
        (serde_json::Value::Bool(left), serde_json::Value::Bool(right)) => left == right,
        (serde_json::Value::Number(left), serde_json::Value::Number(right)) => {
            json_numbers_semantically_equal(left, right)
        }
        (serde_json::Value::String(left), serde_json::Value::String(right)) => left == right,
        (serde_json::Value::Array(left), serde_json::Value::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(left, right)| json_values_semantically_equal(left, right))
        }
        (serde_json::Value::Object(left), serde_json::Value::Object(right)) => {
            left.len() == right.len()
                && left.iter().all(|(key, left)| {
                    right
                        .get(key)
                        .is_some_and(|right| json_values_semantically_equal(left, right))
                })
        }
        _ => false,
    }
}

pub(crate) fn layout_revision_for_raw(present: bool, raw: &[u8]) -> String {
    let revision_bytes = if present { raw } else { &[] };
    let mut digest = Sha256::new();
    digest.update(DASHBOARD_LAYOUT_REVISION_DOMAIN);
    digest.update([u8::from(present)]);
    digest.update((revision_bytes.len() as u64).to_be_bytes());
    digest.update(revision_bytes);
    format!(
        "{DASHBOARD_LAYOUT_REVISION_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(digest.finalize())
    )
}

fn is_layout_revision(value: &str) -> bool {
    value.len() == DASHBOARD_LAYOUT_REVISION_PREFIX.len() + 43
        && value.starts_with(DASHBOARD_LAYOUT_REVISION_PREFIX)
        && value[DASHBOARD_LAYOUT_REVISION_PREFIX.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn read_raw_layout(path: &Path) -> Result<RawDashboardLayout, DashboardLayoutPersistenceError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(RawDashboardLayout {
            present: true,
            bytes,
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(RawDashboardLayout {
            present: false,
            bytes: Vec::new(),
        }),
        Err(error) => Err(DashboardLayoutPersistenceError::io(format!(
            "Read dashboard layout: {error}"
        ))),
    }
}

fn parse_raw_layout(
    raw: &RawDashboardLayout,
    revision: &str,
) -> Result<serde_json::Value, DashboardLayoutPersistenceError> {
    if !raw.present {
        return Ok(serde_json::json!({}));
    }
    serde_json::from_slice(&raw.bytes).map_err(|_| {
        DashboardLayoutPersistenceError::state_blocked(
            "The saved dashboard layout is malformed and will not be overwritten",
            revision.to_string(),
        )
    })
}

fn positive_safe_integer(value: &serde_json::Value) -> Option<u64> {
    let number = value.as_f64()?;
    if number.is_finite()
        && number > 0.0
        && number.fract() == 0.0
        && number < MAX_SAFE_JSON_INTEGER_EXCLUSIVE
    {
        Some(number as u64)
    } else {
        None
    }
}

fn valid_column_order(value: Option<&serde_json::Value>) -> bool {
    let Some(columns) = value.and_then(serde_json::Value::as_array) else {
        return false;
    };
    if columns.len() != 4 {
        return false;
    }
    let mut seen = [false; 4];
    for column in columns {
        let Some(column) = column.as_str() else {
            return false;
        };
        let index = match column {
            "file" => 0,
            "main" => 1,
            "scratch" => 2,
            "editor" => 3,
            _ => return false,
        };
        if seen[index] {
            return false;
        }
        seen[index] = true;
    }
    seen.into_iter().all(|present| present)
}

fn positive_number(value: &serde_json::Value) -> bool {
    value
        .as_f64()
        .is_some_and(|number| number.is_finite() && number > 0.0)
}

fn finite_number(value: &serde_json::Value) -> bool {
    value.as_f64().is_some_and(f64::is_finite)
}

fn string_array(value: &serde_json::Value, non_empty: bool) -> bool {
    value.as_array().is_some_and(|values| {
        values.iter().all(|value| {
            value
                .as_str()
                .is_some_and(|value| !non_empty || !value.is_empty())
        })
    })
}

fn valid_host_id(record: &serde_json::Map<String, serde_json::Value>) -> bool {
    record
        .get("hostId")
        .is_none_or(|value| value.is_null() || value.is_string())
}

fn valid_pinned_items(value: &serde_json::Value) -> bool {
    value.as_array().is_some_and(|items| {
        items.iter().all(|item| {
            let Some(record) = item.as_object() else {
                return false;
            };
            match record.get("kind").and_then(serde_json::Value::as_str) {
                Some("session") => record
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|name| !name.is_empty()),
                Some("terminal") => record
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|id| !id.is_empty()),
                _ => false,
            }
        })
    })
}

fn valid_selection(value: &serde_json::Value) -> bool {
    if value.is_null() {
        return true;
    }
    let Some(record) = value.as_object() else {
        return false;
    };
    match record.get("kind").and_then(serde_json::Value::as_str) {
        Some("session") => record.get("name").is_some_and(serde_json::Value::is_string),
        Some("terminal") | Some("automation") => {
            record.get("id").is_some_and(serde_json::Value::is_string)
        }
        _ => false,
    }
}

fn valid_editing_file(value: &serde_json::Value) -> bool {
    if value.is_null() {
        return true;
    }
    let Some(record) = value.as_object() else {
        return false;
    };
    if !record.get("path").is_some_and(serde_json::Value::is_string) || !valid_host_id(record) {
        return false;
    }
    ["line", "column"].into_iter().all(|key| {
        record
            .get(key)
            .is_none_or(|value| positive_safe_integer(value).is_some())
    })
}

fn valid_diff_file(value: &serde_json::Value) -> bool {
    if value.is_null() {
        return true;
    }
    value.as_object().is_some_and(|record| {
        record.get("path").is_some_and(serde_json::Value::is_string)
            && record.get("cwd").is_some_and(serde_json::Value::is_string)
            && valid_host_id(record)
    })
}

fn valid_window(value: &serde_json::Value) -> bool {
    value.as_object().is_some_and(|record| {
        record.get("width").is_some_and(positive_number)
            && record.get("height").is_some_and(positive_number)
            && record.get("x").is_some_and(finite_number)
            && record.get("y").is_some_and(finite_number)
            && record
                .get("maximized")
                .is_some_and(serde_json::Value::is_boolean)
    })
}

fn optional_field(
    record: &serde_json::Map<String, serde_json::Value>,
    key: &str,
    validator: impl FnOnce(&serde_json::Value) -> bool,
) -> bool {
    record.get(key).is_none_or(validator)
}

fn valid_current_layout(record: &serde_json::Map<String, serde_json::Value>) -> bool {
    if record.get("schemaVersion").and_then(positive_safe_integer)
        != Some(DASHBOARD_LAYOUT_SCHEMA_VERSION)
        || !valid_column_order(record.get("columnOrder"))
    {
        return false;
    }

    for key in [
        "left",
        "right",
        "gitHeight",
        "sectionSplit",
        "automationHeight",
        "scratchWidth",
        "fileTreeWidth",
        "editorWidth",
        "sidebarWidth",
        "inspectorWidth",
    ] {
        if !optional_field(record, key, positive_number) {
            return false;
        }
    }
    for key in [
        "automationSectionCollapsed",
        "scratchCollapsed",
        "fileBrowserOpen",
        "sidebarOpen",
        "inspectorOpen",
    ] {
        if !optional_field(record, key, serde_json::Value::is_boolean) {
            return false;
        }
    }

    optional_field(record, "sessionOrder", |value| string_array(value, false))
        && optional_field(record, "worktreeGroupOrder", |value| {
            string_array(value, false)
        })
        && optional_field(record, "terminalOrder", |value| string_array(value, false))
        && optional_field(record, "collapsedProjects", |value| {
            string_array(value, true)
        })
        && optional_field(record, "pinnedItems", valid_pinned_items)
        && optional_field(record, "sidebarView", |value| {
            matches!(value.as_str(), Some("workspaces" | "files"))
        })
        && optional_field(record, "inspectorTab", |value| {
            matches!(value.as_str(), Some("files" | "git" | "diff" | "feishu"))
        })
        && optional_field(record, "selection", valid_selection)
        && optional_field(record, "editingFile", valid_editing_file)
        && optional_field(record, "diffFile", valid_diff_file)
        && optional_field(record, "window", valid_window)
}

pub(crate) fn classify_dashboard_layout(
    layout: &serde_json::Value,
) -> DashboardLayoutClassification {
    let Some(record) = layout.as_object() else {
        return DashboardLayoutClassification::Invalid;
    };
    let schema_version = match record.get("schemaVersion") {
        Some(value) => match positive_safe_integer(value) {
            Some(version) => Some(version),
            None => return DashboardLayoutClassification::Invalid,
        },
        None => None,
    };
    let legacy_version = match record.get("version") {
        Some(value) => match positive_safe_integer(value) {
            Some(version) => Some(version),
            None => return DashboardLayoutClassification::Invalid,
        },
        None => None,
    };
    if schema_version.is_some() && legacy_version.is_some() && schema_version != legacy_version {
        return DashboardLayoutClassification::Invalid;
    }
    let effective_version = schema_version.or(legacy_version).unwrap_or(1);
    if effective_version > DASHBOARD_LAYOUT_SCHEMA_VERSION {
        return DashboardLayoutClassification::Future(effective_version);
    }
    if schema_version == Some(DASHBOARD_LAYOUT_SCHEMA_VERSION) {
        return if valid_current_layout(record) {
            DashboardLayoutClassification::Current
        } else {
            DashboardLayoutClassification::Invalid
        };
    }
    DashboardLayoutClassification::Legacy(effective_version)
}

fn valid_save_request(layout: &serde_json::Value) -> bool {
    layout.as_object().is_some_and(|record| {
        !record.contains_key("version")
            && classify_dashboard_layout(layout) == DashboardLayoutClassification::Current
    })
}

fn backup_layout_before_schema_migration(
    path: &Path,
    raw: &RawDashboardLayout,
    current_version: u64,
) -> Result<Option<PathBuf>, DashboardLayoutPersistenceError> {
    if !raw.present || current_version >= DASHBOARD_LAYOUT_SCHEMA_VERSION {
        return Ok(None);
    }
    let backup_path = layout_backup_path(path, current_version);
    if !backup_path.exists() {
        atomic_write_file(&backup_path, &raw.bytes).map_err(|error| {
            DashboardLayoutPersistenceError::io(format!(
                "Write dashboard layout migration backup: {error}"
            ))
        })?;
    }
    Ok(Some(backup_path))
}

pub(crate) fn load_layout_from_path(
    path: &Path,
) -> Result<DashboardLayoutLoadResult, DashboardLayoutPersistenceError> {
    let raw = read_raw_layout(path)?;
    let revision = layout_revision_for_raw(raw.present, &raw.bytes);
    let layout = parse_raw_layout(&raw, &revision)?;
    Ok(DashboardLayoutLoadResult { layout, revision })
}

pub(crate) fn save_layout_to_path(
    path: &Path,
    layout: serde_json::Value,
    expected_revision: &str,
) -> Result<DashboardLayoutSaveResult, DashboardLayoutPersistenceError> {
    if !valid_save_request(&layout) {
        return Err(DashboardLayoutPersistenceError::invalid_request(
            "Dashboard layout must be canonical schemaVersion 2 without a legacy version marker",
        ));
    }
    if !is_layout_revision(expected_revision) {
        return Err(DashboardLayoutPersistenceError::invalid_request(
            "expectedRevision is not a valid dashboard layout revision",
        ));
    }
    let next_bytes = serde_json::to_vec_pretty(&layout).map_err(|error| {
        DashboardLayoutPersistenceError::invalid_request(format!(
            "Serialize dashboard layout request: {error}"
        ))
    })?;

    let _process_guard = dashboard_layout_write_lock().lock().map_err(|_| {
        DashboardLayoutPersistenceError::io("Dashboard layout process lock is poisoned")
    })?;
    let _file_guard = acquire_dashboard_file_lock(layout_lock_path(path), "dashboard layout")
        .map_err(|error| {
            DashboardLayoutPersistenceError::io(format!(
                "Acquire dashboard layout file lock: {error}"
            ))
        })?;

    let current_raw = read_raw_layout(path)?;
    let current_revision = layout_revision_for_raw(current_raw.present, &current_raw.bytes);
    let current_layout = parse_raw_layout(&current_raw, &current_revision)?;
    let current_classification = classify_dashboard_layout(&current_layout);
    let current_version = match current_classification {
        DashboardLayoutClassification::Legacy(version) => version,
        DashboardLayoutClassification::Current => DASHBOARD_LAYOUT_SCHEMA_VERSION,
        DashboardLayoutClassification::Future(version) => {
            return Err(DashboardLayoutPersistenceError::state_blocked(
                format!(
                    "Dashboard layout schema {version} was created by a newer version and will not be overwritten"
                ),
                current_revision,
            ));
        }
        DashboardLayoutClassification::Invalid => {
            return Err(DashboardLayoutPersistenceError::state_blocked(
                "The saved dashboard layout is invalid and will not be overwritten",
                current_revision,
            ));
        }
    };

    if json_values_semantically_equal(&current_layout, &layout) {
        return Ok(DashboardLayoutSaveResult {
            revision: current_revision,
            unchanged: true,
        });
    }
    if expected_revision != current_revision {
        return Err(DashboardLayoutPersistenceError::revision_conflict(
            current_revision,
        ));
    }

    backup_layout_before_schema_migration(path, &current_raw, current_version)?;
    atomic_write_file(path, &next_bytes).map_err(|error| {
        DashboardLayoutPersistenceError::io(format!("Write dashboard layout: {error}"))
    })?;
    Ok(DashboardLayoutSaveResult {
        revision: layout_revision_for_raw(true, &next_bytes),
        unchanged: false,
    })
}

#[derive(Deserialize)]
struct SavedWindowLayout {
    width: f64,
    height: f64,
    x: f64,
    y: f64,
    maximized: bool,
}

fn restorable_window_layout(layout: &serde_json::Value) -> Option<SavedWindowLayout> {
    if matches!(
        classify_dashboard_layout(layout),
        DashboardLayoutClassification::Future(_) | DashboardLayoutClassification::Invalid
    ) {
        return None;
    }
    let window = layout.get("window")?;
    if !valid_window(window) {
        return None;
    }
    serde_json::from_value(window.clone()).ok()
}

#[cfg(test)]
pub(crate) fn dashboard_layout_window_is_restorable(layout: &serde_json::Value) -> bool {
    restorable_window_layout(layout).is_some()
}

pub(crate) fn restore_window_layout(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let raw = match read_raw_layout(&layout_path()) {
        Ok(raw) if raw.present => raw,
        _ => return,
    };
    let Ok(layout) = serde_json::from_slice::<serde_json::Value>(&raw.bytes) else {
        return;
    };
    let Some(saved) = restorable_window_layout(&layout) else {
        return;
    };

    let _ = window.set_size(tauri::LogicalSize::new(
        saved.width.max(960.0),
        saved.height.max(600.0),
    ));
    let _ = window.set_position(tauri::LogicalPosition::new(saved.x, saved.y));
    if saved.maximized {
        let _ = window.maximize();
    }
}

#[tauri::command]
pub(crate) fn load_layout() -> Result<DashboardLayoutLoadResult, DashboardLayoutPersistenceError> {
    load_layout_from_path(&layout_path())
}

#[tauri::command]
pub(crate) fn save_layout(
    layout: serde_json::Value,
    expected_revision: String,
) -> Result<DashboardLayoutSaveResult, DashboardLayoutPersistenceError> {
    save_layout_to_path(&layout_path(), layout, &expected_revision)
}
