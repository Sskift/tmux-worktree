use crate::features::sessions::tmux_session_exists;
use crate::ipc::CreateArgs;
use crate::support::{app_home_dir_or_tmp, shell_quote};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AutomationTriggerType {
    Manual,
    Schedule,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AutomationOverlap {
    Queue,
    Skip,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AutomationStatus {
    Idle,
    Queued,
    Running,
    Success,
    Failed,
    Skipped,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Automation {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) enabled: bool,
    pub(crate) trigger_type: AutomationTriggerType,
    pub(crate) schedule: Option<String>,
    pub(crate) timezone: Option<String>,
    pub(crate) project: Option<String>,
    pub(crate) path: Option<String>,
    pub(crate) ai_cmd: String,
    pub(crate) instruction: String,
    pub(crate) overlap: AutomationOverlap,
    pub(crate) last_run_at: Option<String>,
    pub(crate) last_status: AutomationStatus,
    pub(crate) last_session: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationRun {
    pub(crate) id: String,
    pub(crate) automation_id: String,
    pub(crate) started_at: String,
    pub(crate) finished_at: Option<String>,
    pub(crate) status: AutomationStatus,
    pub(crate) session_name: Option<String>,
    pub(crate) error: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAutomationInput {
    pub(crate) id: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) enabled: Option<bool>,
    pub(crate) trigger_type: Option<AutomationTriggerType>,
    pub(crate) schedule: Option<Option<String>>,
    pub(crate) timezone: Option<Option<String>>,
    pub(crate) project: Option<Option<String>>,
    pub(crate) path: Option<Option<String>>,
    pub(crate) ai_cmd: Option<String>,
    pub(crate) instruction: Option<String>,
    pub(crate) overlap: Option<AutomationOverlap>,
}

pub(crate) struct UpsertAutomationResult {
    pub(crate) automations: Vec<Automation>,
    pub(crate) automation: Automation,
}

pub(crate) const AUTOMATION_RUN_LIMIT: usize = 200;

fn automations_path() -> std::path::PathBuf {
    app_home_dir_or_tmp().join(".tw-dashboard-automations.json")
}

fn automation_runs_path() -> std::path::PathBuf {
    app_home_dir_or_tmp().join(".tw-dashboard-automation-runs.json")
}

pub(crate) fn trimmed_non_empty(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn optional_string_patch(
    existing: Option<String>,
    patch: Option<Option<String>>,
) -> Option<String> {
    match patch {
        Some(Some(value)) => trimmed_non_empty(value),
        Some(None) => None,
        None => existing,
    }
}

pub(crate) fn new_prefixed_id(prefix: &str) -> String {
    let id = uuid::Uuid::new_v4().simple().to_string();
    format!("{}-{}", prefix, &id[..12])
}

fn unix_seconds_to_rfc3339(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let seconds_of_day = secs % 86_400;
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;

    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if month <= 2 { 1 } else { 0 };

    // Keep timestamps in JavaScript's canonical ISO representation. Besides
    // being valid RFC 3339, this exact millisecond form is required by the
    // frozen terminal-control request contract.
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.000Z")
}

pub(crate) fn now_rfc3339() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    unix_seconds_to_rfc3339(secs)
}

pub(crate) fn automation_command_with_instruction(ai_cmd: &str, instruction: &str) -> String {
    let command = ai_cmd.trim();
    let instruction = instruction.trim();
    if instruction.is_empty() {
        return command.to_string();
    }
    if command.is_empty() {
        return shell_quote(instruction);
    }
    format!("{} {}", command, shell_quote(instruction))
}

pub(crate) fn should_skip_automation_overlap(
    automation: &Automation,
    session_exists: bool,
) -> bool {
    automation.overlap == AutomationOverlap::Skip
        && matches!(
            automation.last_status,
            AutomationStatus::Queued | AutomationStatus::Running
        )
        && automation.last_session.is_some()
        && session_exists
}

pub(crate) fn trigger_automation_with_creator<F>(
    id: String,
    create: F,
) -> Result<AutomationRun, String>
where
    F: FnOnce(CreateArgs) -> Result<String, String>,
{
    let mut automations = load_automations_from_disk()?;
    let index = automations
        .iter()
        .position(|automation| automation.id == id)
        .ok_or_else(|| format!("automation not found: {id}"))?;
    let automation = automations[index].clone();
    let now = now_rfc3339();
    let session_exists = automation
        .last_session
        .as_ref()
        .map(|session| tmux_session_exists(session.clone()).unwrap_or(false))
        .unwrap_or(false);

    if should_skip_automation_overlap(&automation, session_exists) {
        let run = AutomationRun {
            id: new_prefixed_id("run"),
            automation_id: automation.id.clone(),
            started_at: now.clone(),
            finished_at: Some(now),
            status: AutomationStatus::Skipped,
            session_name: automation.last_session.clone(),
            error: Some("automation already has a live running session".to_string()),
        };
        let mut runs = load_automation_runs_from_disk()?;
        append_automation_run(&mut runs, run.clone());
        save_automation_runs_to_disk(&runs)?;
        return Ok(run);
    }

    let ai_cmd = automation_command_with_instruction(&automation.ai_cmd, &automation.instruction);
    let start_result = create(CreateArgs {
        project: automation.project.clone().and_then(trimmed_non_empty),
        path: automation.path.clone().and_then(trimmed_non_empty),
        ai_cmd,
        name: Some(automation.name.clone()),
        branch: None,
        host_id: None,
    });

    let mut runs = load_automation_runs_from_disk()?;
    let run = match start_result {
        Ok(session) => {
            automations[index].last_run_at = Some(now.clone());
            automations[index].last_status = AutomationStatus::Running;
            automations[index].last_session = Some(session.clone());
            AutomationRun {
                id: new_prefixed_id("run"),
                automation_id: automation.id,
                started_at: now,
                finished_at: None,
                status: AutomationStatus::Running,
                session_name: Some(session),
                error: None,
            }
        }
        Err(error) => {
            automations[index].last_run_at = Some(now.clone());
            automations[index].last_status = AutomationStatus::Failed;
            AutomationRun {
                id: new_prefixed_id("run"),
                automation_id: automation.id,
                started_at: now.clone(),
                finished_at: Some(now),
                status: AutomationStatus::Failed,
                session_name: None,
                error: Some(error),
            }
        }
    };

    append_automation_run(&mut runs, run.clone());
    save_automations_to_disk(&automations)?;
    save_automation_runs_to_disk(&runs)?;
    Ok(run)
}

pub(crate) fn upsert_automation_from_input(
    mut automations: Vec<Automation>,
    input: SaveAutomationInput,
    now: &str,
) -> Result<UpsertAutomationResult, String> {
    let input_id = input.id.and_then(trimmed_non_empty);
    let existing_index = input_id.as_deref().and_then(|id| {
        automations
            .iter()
            .position(|automation| automation.id == id)
    });
    let existing = existing_index.map(|index| automations[index].clone());

    let id = existing
        .as_ref()
        .map(|automation| automation.id.clone())
        .or(input_id)
        .unwrap_or_else(|| new_prefixed_id("auto"));
    let name = input
        .name
        .and_then(trimmed_non_empty)
        .or_else(|| existing.as_ref().map(|automation| automation.name.clone()))
        .unwrap_or_else(|| "Untitled automation".to_string());
    let enabled = input
        .enabled
        .or_else(|| existing.as_ref().map(|automation| automation.enabled))
        .unwrap_or(true);
    let trigger_type = input
        .trigger_type
        .or_else(|| existing.as_ref().map(|automation| automation.trigger_type))
        .unwrap_or(AutomationTriggerType::Manual);
    let schedule = optional_string_patch(
        existing
            .as_ref()
            .and_then(|automation| automation.schedule.clone()),
        input.schedule,
    );
    let timezone = optional_string_patch(
        existing
            .as_ref()
            .and_then(|automation| automation.timezone.clone()),
        input.timezone,
    );
    let project = optional_string_patch(
        existing
            .as_ref()
            .and_then(|automation| automation.project.clone()),
        input.project,
    );
    let path = optional_string_patch(
        existing
            .as_ref()
            .and_then(|automation| automation.path.clone()),
        input.path,
    );
    let ai_cmd = input
        .ai_cmd
        .and_then(trimmed_non_empty)
        .or_else(|| {
            existing
                .as_ref()
                .map(|automation| automation.ai_cmd.clone())
        })
        .unwrap_or_else(|| "claude".to_string());
    let instruction = input
        .instruction
        .map(|value| value.trim().to_string())
        .or_else(|| {
            existing
                .as_ref()
                .map(|automation| automation.instruction.clone())
        })
        .unwrap_or_default();
    let overlap = input
        .overlap
        .or_else(|| existing.as_ref().map(|automation| automation.overlap))
        .unwrap_or(AutomationOverlap::Queue);
    let created_at = existing
        .as_ref()
        .map(|automation| automation.created_at.clone())
        .unwrap_or_else(|| now.to_string());

    let automation = Automation {
        id,
        name,
        enabled,
        trigger_type,
        schedule,
        timezone,
        project,
        path,
        ai_cmd,
        instruction,
        overlap,
        last_run_at: existing
            .as_ref()
            .and_then(|automation| automation.last_run_at.clone()),
        last_status: existing
            .as_ref()
            .map(|automation| automation.last_status)
            .unwrap_or(AutomationStatus::Idle),
        last_session: existing
            .as_ref()
            .and_then(|automation| automation.last_session.clone()),
        created_at,
        updated_at: now.to_string(),
    };

    if let Some(index) = existing_index {
        automations[index] = automation.clone();
    } else {
        automations.push(automation.clone());
    }

    Ok(UpsertAutomationResult {
        automations,
        automation,
    })
}

pub(crate) fn delete_automation_from_list(
    mut automations: Vec<Automation>,
    id: &str,
) -> Vec<Automation> {
    automations.retain(|automation| automation.id != id);
    automations
}

pub(crate) fn append_automation_run(runs: &mut Vec<AutomationRun>, run: AutomationRun) {
    runs.insert(0, run);
    runs.truncate(AUTOMATION_RUN_LIMIT);
}

pub(crate) fn load_automations_from_disk() -> Result<Vec<Automation>, String> {
    let path = automations_path();
    if !path.exists() {
        return Ok(vec![]);
    }
    let text = std::fs::read_to_string(&path).map_err(|error| format!("read: {error}"))?;
    serde_json::from_str(&text).map_err(|error| format!("parse: {error}"))
}

pub(crate) fn save_automations_to_disk(automations: &[Automation]) -> Result<(), String> {
    let path = automations_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("mkdir: {error}"))?;
    }
    let text =
        serde_json::to_string_pretty(automations).map_err(|error| format!("serialize: {error}"))?;
    std::fs::write(path, text).map_err(|error| format!("write: {error}"))
}

pub(crate) fn load_automation_runs_from_disk() -> Result<Vec<AutomationRun>, String> {
    let path = automation_runs_path();
    if !path.exists() {
        return Ok(vec![]);
    }
    let text = std::fs::read_to_string(&path).map_err(|error| format!("read: {error}"))?;
    serde_json::from_str(&text).map_err(|error| format!("parse: {error}"))
}

pub(crate) fn save_automation_runs_to_disk(runs: &[AutomationRun]) -> Result<(), String> {
    let path = automation_runs_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("mkdir: {error}"))?;
    }
    let text = serde_json::to_string_pretty(runs).map_err(|error| format!("serialize: {error}"))?;
    std::fs::write(path, text).map_err(|error| format!("write: {error}"))
}

#[tauri::command]
pub(crate) fn list_automations() -> Result<Vec<Automation>, String> {
    load_automations_from_disk()
}

#[tauri::command]
pub(crate) fn save_automation(input: SaveAutomationInput) -> Result<Automation, String> {
    let automations = load_automations_from_disk()?;
    let now = now_rfc3339();
    let result = upsert_automation_from_input(automations, input, &now)?;
    save_automations_to_disk(&result.automations)?;
    Ok(result.automation)
}

#[tauri::command]
pub(crate) fn delete_automation(id: String) -> Result<(), String> {
    let automations = load_automations_from_disk()?;
    let next = delete_automation_from_list(automations, id.trim());
    save_automations_to_disk(&next)
}

#[tauri::command]
pub(crate) fn list_automation_runs(
    automation_id: Option<String>,
) -> Result<Vec<AutomationRun>, String> {
    let mut runs = load_automation_runs_from_disk()?;
    if let Some(id) = automation_id.and_then(trimmed_non_empty) {
        runs.retain(|run| run.automation_id == id);
    }
    runs.truncate(AUTOMATION_RUN_LIMIT);
    Ok(runs)
}
