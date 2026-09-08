use crate::config::{acquire_dashboard_file_lock, trimmed_non_empty_string};
use crate::features::sessions::tmux_session_exists;
use crate::ipc::CreateArgs;
use crate::support::{app_home_dir_or_tmp, atomic_write_file, shell_quote};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

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
pub(crate) struct AutomationRunInFlight {
    /// Correlates the marker with the trigger run that claimed it; only that
    /// run clears it in phase 2.
    pub(crate) run_id: String,
    /// Unix-millis timestamp the claim was written. Used to expire a marker
    /// left behind if the process dies between phase 1 and phase 2, so the
    /// skip fence never latches shut forever.
    pub(crate) started_at_ms: u64,
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
    /// Durable "a skip-overlap run is currently being created" claim, written
    /// in phase 1 (before the slow worktree/agent spawn) so a second trigger
    /// overlapping the create window dedups immediately instead of also
    /// spawning a session. Cleared/replaced by real status in phase 2. Only
    /// set for `overlap=skip`; `overlap=queue` intentionally never sets it.
    /// Optional + defaults to absent for forward/backward compatibility with
    /// records written by older Dashboard builds and the Node CLI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) run_in_flight: Option<AutomationRunInFlight>,
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

/// A claimed (in-flight) skip run older than this is treated as stale: the
/// process that wrote it almost certainly died before it could clear the
/// marker in phase 2. Worktree/agent creation runs seconds-to-tens-of-seconds,
/// so this comfortably exceeds any real create window while bounding how long
/// a crash can keep a skip automation from re-firing.
const IN_FLIGHT_STALE_MS: u64 = 10 * 60 * 1000;

/// True when a persisted in-flight claim is still fresh (i.e. a run for this
/// automation is inside its create window right now).
fn automation_in_flight_fresh(automation: &Automation, now_ms: u64) -> bool {
    match automation.run_in_flight.as_ref() {
        Some(claim) => now_ms.saturating_sub(claim.started_at_ms) < IN_FLIGHT_STALE_MS,
        None => false,
    }
}

/// Phase-2 teardown: a run that wrote its own in-flight claim in phase 1 clears
/// it here. The clear is gated on the persisted claim still carrying THIS run's
/// id, so a slow run that returns after another run has legitimately overwritten
/// a stale claim never wipes the newer run's live claim.
fn clear_own_in_flight_claim(automation: &mut Automation, run_id: &str, claimed: bool) {
    if !claimed {
        return;
    }
    if automation
        .run_in_flight
        .as_ref()
        .map(|claim| claim.run_id == run_id)
        .unwrap_or(true)
    {
        automation.run_in_flight = None;
    }
}

fn automations_path() -> std::path::PathBuf {
    app_home_dir_or_tmp().join(".tw-dashboard-automations.json")
}

fn automation_runs_path() -> std::path::PathBuf {
    app_home_dir_or_tmp().join(".tw-dashboard-automation-runs.json")
}

fn automations_lock_path() -> std::path::PathBuf {
    std::path::PathBuf::from(format!("{}.lock", automations_path().display()))
}

fn automation_runs_lock_path() -> std::path::PathBuf {
    std::path::PathBuf::from(format!("{}.lock", automation_runs_path().display()))
}

/// Serializes automation state read-modify-write within the Dashboard
/// process. The directory locks below additionally coordinate with the
/// Node `tw automation` CLI and Relay processes.
fn automation_write_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Move a state file that fails to parse out of the way so a torn/legacy
/// write can never brick the whole automation surface. The bytes are
/// preserved for forensics; callers then treat the state as empty.
fn quarantine_corrupt_state(path: &std::path::Path, kind: &str, error: &str) {
    let backup = std::path::PathBuf::from(format!("{}.corrupt-{}", path.display(), unix_millis()));
    match std::fs::rename(path, &backup) {
        Ok(()) => eprintln!(
            "warning: {kind} state at {} was corrupt ({error}); backed it up to {} and starting fresh",
            path.display(),
            backup.display()
        ),
        Err(rename_error) => eprintln!(
            "warning: {kind} state at {} was corrupt ({error}); could not back it up: {rename_error}",
            path.display()
        ),
    }
}

fn optional_string_patch(
    existing: Option<String>,
    patch: Option<Option<String>>,
) -> Option<String> {
    match patch {
        Some(Some(value)) => trimmed_non_empty_string(value),
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
    now_ms: u64,
) -> bool {
    if automation.overlap != AutomationOverlap::Skip {
        return false;
    }
    // A fresh in-flight claim means another trigger for this same automation is
    // already inside its (session-less) create window. Dedup immediately even
    // though last_session/last_status=Running have not been persisted yet — this
    // closes the cross-create-window double-spawn gap. Stale claims (process
    // died mid-create) are ignored so the fence never latches shut.
    if automation_in_flight_fresh(automation, now_ms) {
        return true;
    }
    matches!(
        automation.last_status,
        AutomationStatus::Queued | AutomationStatus::Running
    ) && automation.last_session.is_some()
        && session_exists
}

struct TriggerStart {
    automation_id: String,
    now: String,
    run_id: String,
    create_args: CreateArgs,
    /// True when this trigger wrote a fresh in-flight claim in phase 1; only
    /// then may phase 2 clear it (a run that was skipped on a pre-existing
    /// claim must not clear the other run's claim).
    claims_in_flight: bool,
}

pub(crate) fn trigger_automation_with_creator<F>(
    id: String,
    create: F,
) -> Result<AutomationRun, String>
where
    F: FnOnce(CreateArgs) -> Result<String, String>,
{
    // Phase 1 (locked): snapshot the target automation and decide skip vs
    // run. The slow worktree creation runs with NO lock held; phase 2
    // re-loads fresh state and merges only this run's fields so concurrent
    // edits/saves are never clobbered by a stale snapshot.
    let start = {
        let _guard = automation_write_lock()
            .lock()
            .map_err(|_| "automation write lock poisoned".to_string())?;
        let _auto_lock = acquire_dashboard_file_lock(automations_lock_path(), "automation state")?;
        let _runs_lock =
            acquire_dashboard_file_lock(automation_runs_lock_path(), "automation run state")?;

        let mut automations = load_automations_from_disk()?;
        let target_index = automations
            .iter()
            .position(|automation| automation.id == id)
            .ok_or_else(|| format!("automation not found: {id}"))?;
        let automation = automations[target_index].clone();
        let now = now_rfc3339();
        let now_ms = unix_millis();
        let session_exists = automation
            .last_session
            .as_ref()
            .map(|session| tmux_session_exists(session.clone()).unwrap_or(false))
            .unwrap_or(false);

        if should_skip_automation_overlap(&automation, session_exists, now_ms) {
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

        // This run will proceed to create(). For overlap=skip, persist a
        // durable in-flight claim *before* leaving the lock so a second trigger
        // overlapping the (session-less) create window dedups in its own phase
        // 1 instead of also spawning a worktree/agent. overlap=queue allows
        // concurrency by design and never claims. The claim is paired with a
        // phase-2 clear; a crash in between is bounded by IN_FLIGHT_STALE_MS.
        let run_id = new_prefixed_id("run");
        let claims_in_flight = automation.overlap == AutomationOverlap::Skip;
        if claims_in_flight {
            automations[target_index].run_in_flight = Some(AutomationRunInFlight {
                run_id: run_id.clone(),
                started_at_ms: now_ms,
            });
            save_automations_to_disk(&automations)?;
        }

        let ai_cmd =
            automation_command_with_instruction(&automation.ai_cmd, &automation.instruction);
        TriggerStart {
            automation_id: automation.id,
            now,
            run_id,
            create_args: CreateArgs {
                project: automation.project.and_then(trimmed_non_empty_string),
                path: automation.path.and_then(trimmed_non_empty_string),
                ai_cmd,
                name: Some(automation.name),
                branch: None,
                host_id: None,
            },
            claims_in_flight,
        }
    };

    // Worktree/session creation: network + git, seconds to tens of seconds.
    // Deliberately outside every lock.
    let start_result = create(start.create_args);

    // Phase 2 (locked): re-load fresh automations+runs and merge only this
    // run's own fields onto the current record, then append the run.
    let _guard = automation_write_lock()
        .lock()
        .map_err(|_| "automation write lock poisoned".to_string())?;
    let _auto_lock = acquire_dashboard_file_lock(automations_lock_path(), "automation state")?;
    let _runs_lock =
        acquire_dashboard_file_lock(automation_runs_lock_path(), "automation run state")?;

    let mut automations = load_automations_from_disk()?;
    let mut runs = load_automation_runs_from_disk()?;
    let now = start.now;
    let automation_id = start.automation_id;
    let run_id = start.run_id;
    let target_index = automations
        .iter()
        .position(|automation| automation.id == automation_id);

    let run = match start_result {
        Ok(session) => {
            if let Some(index) = target_index {
                automations[index].last_run_at = Some(now.clone());
                automations[index].last_status = AutomationStatus::Running;
                automations[index].last_session = Some(session.clone());
                clear_own_in_flight_claim(&mut automations[index], &run_id, start.claims_in_flight);
                save_automations_to_disk(&automations)?;
            }
            AutomationRun {
                id: run_id,
                automation_id,
                started_at: now,
                finished_at: None,
                status: AutomationStatus::Running,
                session_name: Some(session),
                error: None,
            }
        }
        Err(error) => {
            if let Some(index) = target_index {
                automations[index].last_run_at = Some(now.clone());
                automations[index].last_status = AutomationStatus::Failed;
                // Paired rollback: create failed, so drop the in-flight claim
                // instead of letting it linger until the stale TTL.
                clear_own_in_flight_claim(&mut automations[index], &run_id, start.claims_in_flight);
                save_automations_to_disk(&automations)?;
            }
            AutomationRun {
                id: run_id,
                automation_id,
                started_at: now.clone(),
                finished_at: Some(now),
                status: AutomationStatus::Failed,
                session_name: None,
                error: Some(error),
            }
        }
    };

    append_automation_run(&mut runs, run.clone());
    save_automation_runs_to_disk(&runs)?;
    Ok(run)
}

pub(crate) fn upsert_automation_from_input(
    mut automations: Vec<Automation>,
    input: SaveAutomationInput,
    now: &str,
) -> Result<UpsertAutomationResult, String> {
    let input_id = input.id.and_then(trimmed_non_empty_string);
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
        .and_then(trimmed_non_empty_string)
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
        .and_then(trimmed_non_empty_string)
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
        // Preserve a live in-flight claim across an edit so saving config
        // during a run's create window cannot wipe the dedup fence. Phase 2
        // of the claiming run clears it; new records start with none.
        run_in_flight: existing
            .as_ref()
            .and_then(|automation| automation.run_in_flight.clone()),
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

fn load_state_array<T: serde::de::DeserializeOwned>(
    path: &std::path::Path,
    kind: &str,
) -> Result<Vec<T>, String> {
    if !path.exists() {
        return Ok(vec![]);
    }
    let text = std::fs::read_to_string(path).map_err(|error| format!("read: {error}"))?;
    match serde_json::from_str::<Vec<T>>(&text) {
        Ok(items) => Ok(items),
        Err(error) => {
            quarantine_corrupt_state(path, kind, &error.to_string());
            Ok(vec![])
        }
    }
}

pub(crate) fn load_automations_from_disk() -> Result<Vec<Automation>, String> {
    load_state_array(&automations_path(), "automation")
}

pub(crate) fn save_automations_to_disk(automations: &[Automation]) -> Result<(), String> {
    let path = automations_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("mkdir: {error}"))?;
    }
    let mut text =
        serde_json::to_string_pretty(automations).map_err(|error| format!("serialize: {error}"))?;
    text.push('\n');
    atomic_write_file(&path, text.as_bytes()).map_err(|error| format!("write: {error}"))
}

pub(crate) fn load_automation_runs_from_disk() -> Result<Vec<AutomationRun>, String> {
    load_state_array(&automation_runs_path(), "automation run")
}

pub(crate) fn save_automation_runs_to_disk(runs: &[AutomationRun]) -> Result<(), String> {
    let path = automation_runs_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("mkdir: {error}"))?;
    }
    let mut text =
        serde_json::to_string_pretty(runs).map_err(|error| format!("serialize: {error}"))?;
    text.push('\n');
    atomic_write_file(&path, text.as_bytes()).map_err(|error| format!("write: {error}"))
}

#[tauri::command]
pub(crate) fn list_automations() -> Result<Vec<Automation>, String> {
    load_automations_from_disk()
}

#[tauri::command]
pub(crate) fn save_automation(input: SaveAutomationInput) -> Result<Automation, String> {
    let _guard = automation_write_lock()
        .lock()
        .map_err(|_| "automation write lock poisoned".to_string())?;
    let _file_guard = acquire_dashboard_file_lock(automations_lock_path(), "automation state")?;
    let automations = load_automations_from_disk()?;
    let now = now_rfc3339();
    let result = upsert_automation_from_input(automations, input, &now)?;
    save_automations_to_disk(&result.automations)?;
    Ok(result.automation)
}

#[tauri::command]
pub(crate) fn delete_automation(id: String) -> Result<(), String> {
    let _guard = automation_write_lock()
        .lock()
        .map_err(|_| "automation write lock poisoned".to_string())?;
    let _file_guard = acquire_dashboard_file_lock(automations_lock_path(), "automation state")?;
    let automations = load_automations_from_disk()?;
    let next = delete_automation_from_list(automations, id.trim());
    save_automations_to_disk(&next)
}

#[tauri::command]
pub(crate) fn list_automation_runs(
    automation_id: Option<String>,
) -> Result<Vec<AutomationRun>, String> {
    let mut runs = load_automation_runs_from_disk()?;
    if let Some(id) = automation_id.and_then(trimmed_non_empty_string) {
        runs.retain(|run| run.automation_id == id);
    }
    runs.truncate(AUTOMATION_RUN_LIMIT);
    Ok(runs)
}
