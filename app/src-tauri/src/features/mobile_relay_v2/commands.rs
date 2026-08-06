use base64::Engine as _;
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Manager, State};

use super::enrollment_artifact::{
    EnrollmentArtifactCopyField, EnrollmentArtifactRegistry, EnrollmentArtifactWindowClaim,
};
use super::management_child::{
    ManagementCallError, ManagementChildManager, ManagementChildSelection,
    ManagementCleanupOutcome, ManagementError, ManagementInput, ManagementLaunchKey,
    ManagementOperation, ManagementOutcome, ManagementStartError,
};

const UNAVAILABLE_CODE: &str = "UNAVAILABLE";
const UNAVAILABLE_MESSAGE: &str = "Relay v2 management is unavailable";
const CHANNEL_CLOSED_CODE: &str = "CHANNEL_CLOSED";
const CHANNEL_CLOSED_MESSAGE: &str = "Relay v2 management channel closed";
const SUPERSEDED_CODE: &str = "SUPERSEDED";
const SUPERSEDED_MESSAGE: &str = "Relay v2 management owner was superseded";
const INVALID_ARGUMENT_CODE: &str = "INVALID_ARGUMENT";
const INVALID_ARGUMENT_MESSAGE: &str = "Relay v2 management input is invalid";
const RECOVERY_REQUIRED_CODE: &str = "CELL_RECOVERY_REQUIRED";
const RECOVERY_REQUIRED_MESSAGE: &str = "Relay v2 Host credential cell requires operator recovery";
const CONNECTOR_READINESS_TIMEOUT: Duration = Duration::from_secs(60);
const CONNECTOR_READINESS_POLL_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum MobileRelayV2ManagementOperation {
    Status,
    BootstrapHost,
    RefreshHost,
    StartConnector,
    StopConnector,
    CreateEnrollment,
    RevokeClientGrant,
}

impl From<MobileRelayV2ManagementOperation> for ManagementOperation {
    fn from(operation: MobileRelayV2ManagementOperation) -> Self {
        match operation {
            MobileRelayV2ManagementOperation::Status => Self::Status,
            MobileRelayV2ManagementOperation::BootstrapHost => Self::BootstrapHost,
            MobileRelayV2ManagementOperation::RefreshHost => Self::RefreshHost,
            MobileRelayV2ManagementOperation::StartConnector => Self::StartConnector,
            MobileRelayV2ManagementOperation::StopConnector => Self::StopConnector,
            MobileRelayV2ManagementOperation::CreateEnrollment => Self::CreateEnrollment,
            MobileRelayV2ManagementOperation::RevokeClientGrant => Self::RevokeClientGrant,
        }
    }
}

enum ManagementCommandOwner {
    Ready {
        launch_key: ManagementLaunchKey,
        manager: ManagementChildManager,
    },
    StartFailed(ManagementStartError),
    Replacing(Arc<ManagementDrainCompletion>),
}

struct ManagementDrainCompletion {
    outcome: Mutex<Option<ManagementCleanupOutcome>>,
    changed: Condvar,
}

impl ManagementDrainCompletion {
    fn pending() -> Self {
        Self {
            outcome: Mutex::new(None),
            changed: Condvar::new(),
        }
    }

    fn complete(&self, outcome: ManagementCleanupOutcome) {
        let mut current = self.outcome.lock().unwrap();
        if current.is_none() {
            *current = Some(outcome);
            self.changed.notify_all();
        }
    }

    fn wait(&self) -> ManagementCleanupOutcome {
        let mut outcome = self.outcome.lock().unwrap();
        loop {
            if let Some(outcome) = *outcome {
                return outcome;
            }
            outcome = self.changed.wait(outcome).unwrap();
        }
    }
}

enum ManagementShutdown {
    Live,
    Draining(Arc<ManagementDrainCompletion>),
    Complete(ManagementCleanupOutcome),
}

pub(crate) struct MobileRelayV2ManagementCommandState {
    owner: Mutex<ManagementCommandOwner>,
    shutdown: Mutex<ManagementShutdown>,
    artifacts: EnrollmentArtifactRegistry,
    disposed: AtomicBool,
}

impl MobileRelayV2ManagementCommandState {
    pub(crate) fn unavailable() -> Self {
        Self::from_start_with_artifacts(
            Err(ManagementStartError::Unavailable),
            ManagementLaunchKey::DefaultProduction,
            EnrollmentArtifactRegistry::disabled(),
        )
    }

    pub(crate) fn start(app: &tauri::AppHandle) -> Self {
        let closer_app = app.clone();
        let artifacts = EnrollmentArtifactRegistry::new(move |label| {
            if let Some(window) = closer_app.get_webview_window(label) {
                let _ = window.destroy();
            }
        });
        Self::from_artifact_start(artifacts, ManagementLaunchKey::DefaultProduction, || {
            ManagementChildManager::start(app)
        })
    }

    pub(crate) fn start_self_hosted<F>(
        app: &tauri::AppHandle,
        selection: ManagementChildSelection,
        commit_ready: F,
    ) -> Self
    where
        F: FnOnce() -> Result<(), String>,
    {
        let launch_key = selection.steady_launch_key();
        let closer_app = app.clone();
        let artifacts = EnrollmentArtifactRegistry::new(move |label| {
            if let Some(window) = closer_app.get_webview_window(label) {
                let _ = window.destroy();
            }
        });
        match artifacts {
            Ok(artifacts) => {
                let start = ManagementChildManager::start_selected(app, selection);
                let settled = settle_candidate_start(start, commit_ready);
                Self::from_start_with_artifacts(settled, launch_key, artifacts)
            }
            Err(()) => Self::from_start_with_artifacts(
                Err(ManagementStartError::Unavailable),
                launch_key,
                EnrollmentArtifactRegistry::disabled(),
            ),
        }
    }

    fn from_artifact_start<F>(
        artifacts: Result<EnrollmentArtifactRegistry, ()>,
        launch_key: ManagementLaunchKey,
        start_manager: F,
    ) -> Self
    where
        F: FnOnce() -> Result<ManagementChildManager, ManagementStartError>,
    {
        match artifacts {
            Ok(artifacts) => {
                Self::from_start_with_artifacts(start_manager(), launch_key, artifacts)
            }
            Err(()) => Self::from_start_with_artifacts(
                Err(ManagementStartError::Unavailable),
                launch_key,
                EnrollmentArtifactRegistry::disabled(),
            ),
        }
    }

    #[cfg(test)]
    fn from_start(start: Result<ManagementChildManager, ManagementStartError>) -> Self {
        Self::from_start_with_artifacts(
            start,
            ManagementLaunchKey::DefaultProduction,
            EnrollmentArtifactRegistry::disabled(),
        )
    }

    fn from_start_with_artifacts(
        start: Result<ManagementChildManager, ManagementStartError>,
        launch_key: ManagementLaunchKey,
        artifacts: EnrollmentArtifactRegistry,
    ) -> Self {
        Self {
            owner: Mutex::new(match start {
                Ok(manager) => ManagementCommandOwner::Ready {
                    launch_key,
                    manager,
                },
                Err(error) => ManagementCommandOwner::StartFailed(error),
            }),
            shutdown: Mutex::new(ManagementShutdown::Live),
            artifacts,
            disposed: AtomicBool::new(false),
        }
    }

    #[cfg(test)]
    fn call(
        &self,
        operation: MobileRelayV2ManagementOperation,
    ) -> Result<ManagementOutcome, ManagementError> {
        self.call_with_input(operation, ManagementInput::None)
    }

    fn call_with_input(
        &self,
        operation: MobileRelayV2ManagementOperation,
        input: ManagementInput,
    ) -> Result<ManagementOutcome, ManagementError> {
        self.call_with_input_for_launch_key(operation, input, None)
    }

    fn call_with_input_for_launch_key(
        &self,
        operation: MobileRelayV2ManagementOperation,
        input: ManagementInput,
        expected_launch_key: Option<&ManagementLaunchKey>,
    ) -> Result<ManagementOutcome, ManagementError> {
        if self.disposed.load(Ordering::Acquire) {
            return Err(channel_closed_error());
        }
        if operation == MobileRelayV2ManagementOperation::RefreshHost {
            self.artifacts.clear();
        }
        let owner = self.owner.lock().unwrap();
        match &*owner {
            ManagementCommandOwner::Ready {
                launch_key,
                manager,
            } => {
                if expected_launch_key.is_some_and(|expected| expected != launch_key) {
                    return Err(not_ready_error());
                }
                let mut outcome = match manager.request_with_input(operation.into(), input) {
                    Ok(outcome) => outcome,
                    Err(error) => {
                        self.artifacts.clear();
                        return Err(map_call_error(error));
                    }
                };
                if outcome.protocol_version == super::management_protocol_v2::PROTOCOL_VERSION {
                    let projected = outcome
                        .result
                        .take()
                        .map(|result| {
                            super::management_protocol_v2::project_for_renderer(
                                result,
                                &self.artifacts,
                            )
                        })
                        .transpose();
                    match projected {
                        Ok(result) => outcome.result = result,
                        Err(()) => {
                            self.disposed.store(true, Ordering::Release);
                            drop(owner);
                            self.shutdown_and_drain();
                            return Err(channel_closed_error());
                        }
                    }
                }
                Ok(outcome)
            }
            ManagementCommandOwner::StartFailed(error) => Err(map_start_error(*error)),
            ManagementCommandOwner::Replacing(_) => Err(channel_closed_error()),
        }
    }

    pub(crate) fn restore_self_hosted_connector_desired_state(
        &self,
        expected_launch_key: &ManagementLaunchKey,
    ) -> Result<(), ManagementError> {
        self.restore_self_hosted_connector_desired_state_with_now(
            expected_launch_key,
            management_now_ms()?,
        )
    }

    fn restore_self_hosted_connector_desired_state_with_now(
        &self,
        expected_launch_key: &ManagementLaunchKey,
        now_ms: u64,
    ) -> Result<(), ManagementError> {
        use super::management_protocol_v2::BaseConnectorReadiness;

        match self.ensure_self_hosted_connector_start_accepted_with_now(
            expected_launch_key,
            now_ms,
            true,
        )? {
            BaseConnectorReadiness::Ready | BaseConnectorReadiness::Starting => Ok(()),
            BaseConnectorReadiness::NotReady => Err(not_ready_error()),
        }
    }

    pub(crate) fn start_self_hosted_connector(
        &self,
        expected_launch_key: &ManagementLaunchKey,
    ) -> Result<ManagementOutcome, ManagementError> {
        self.start_self_hosted_connector_with_now(expected_launch_key, management_now_ms()?)
    }

    fn start_self_hosted_connector_with_now(
        &self,
        expected_launch_key: &ManagementLaunchKey,
        now_ms: u64,
    ) -> Result<ManagementOutcome, ManagementError> {
        use super::management_protocol_v2::BaseConnectorReadiness;

        self.preflight_self_hosted_connector_credential(expected_launch_key, now_ms)?;
        let outcome = self.request_self_hosted_connector_start(expected_launch_key)?;
        match base_connector_readiness(outcome.clone())? {
            BaseConnectorReadiness::Ready | BaseConnectorReadiness::Starting => Ok(outcome),
            BaseConnectorReadiness::NotReady => Err(not_ready_error()),
        }
    }

    pub(crate) fn stop_self_hosted_connector_for_launch_key(
        &self,
        expected_launch_key: Option<&ManagementLaunchKey>,
    ) -> Result<ManagementOutcome, ManagementError> {
        let outcome = self.call_with_input_for_launch_key(
            MobileRelayV2ManagementOperation::StopConnector,
            ManagementInput::None,
            expected_launch_key,
        )?;
        let result = successful_v2_result(outcome.clone())?;
        if connector_projection_status(&result) == Some("stopped") {
            Ok(outcome)
        } else {
            Err(not_ready_error())
        }
    }

    pub(crate) fn ensure_self_hosted_connector_start_accepted(
        &self,
        expected_launch_key: &ManagementLaunchKey,
    ) -> Result<super::management_protocol_v2::BaseConnectorReadiness, ManagementError> {
        self.ensure_self_hosted_connector_start_accepted_with_now(
            expected_launch_key,
            management_now_ms()?,
            false,
        )
    }

    fn ensure_self_hosted_connector_start_accepted_with_now(
        &self,
        expected_launch_key: &ManagementLaunchKey,
        now_ms: u64,
        strict_stopped: bool,
    ) -> Result<super::management_protocol_v2::BaseConnectorReadiness, ManagementError> {
        use super::management_protocol_v2::BaseConnectorReadiness;

        let (status, refreshed) =
            self.preflight_self_hosted_connector_credential(expected_launch_key, now_ms)?;
        let mut readiness =
            super::management_protocol_v2::projection_base_connector_readiness(&status);
        if !refreshed && readiness == BaseConnectorReadiness::Ready {
            return Ok(readiness);
        }
        if !refreshed && readiness == BaseConnectorReadiness::Starting {
            return Ok(readiness);
        }
        if strict_stopped
            && !refreshed
            && readiness == BaseConnectorReadiness::NotReady
            && connector_projection_status(&status) != Some("stopped")
        {
            return Err(not_ready_error());
        }
        readiness = base_connector_readiness(
            self.request_self_hosted_connector_start(expected_launch_key)?,
        )?;
        if readiness == BaseConnectorReadiness::NotReady {
            return Err(not_ready_error());
        }
        Ok(readiness)
    }

    fn preflight_self_hosted_connector_credential(
        &self,
        expected_launch_key: &ManagementLaunchKey,
        now_ms: u64,
    ) -> Result<(serde_json::Value, bool), ManagementError> {
        let status = successful_v2_result(self.call_with_input_for_launch_key(
            MobileRelayV2ManagementOperation::Status,
            ManagementInput::None,
            Some(expected_launch_key),
        )?)?;
        let expires_at_ms =
            super::management_protocol_v2::projection_ready_host_credential_expires_at_ms(&status)
                .ok_or_else(not_ready_error)?;
        if expires_at_ms > now_ms {
            return Ok((status, false));
        }

        let refreshed = successful_v2_result(self.call_with_input_for_launch_key(
            MobileRelayV2ManagementOperation::RefreshHost,
            ManagementInput::None,
            Some(expected_launch_key),
        )?)?;
        let refreshed_expires_at_ms =
            super::management_protocol_v2::projection_ready_host_credential_expires_at_ms(
                &refreshed,
            )
            .ok_or_else(not_ready_error)?;
        if refreshed_expires_at_ms <= now_ms {
            return Err(not_ready_error());
        }
        Ok((refreshed, true))
    }

    fn request_self_hosted_connector_start(
        &self,
        expected_launch_key: &ManagementLaunchKey,
    ) -> Result<ManagementOutcome, ManagementError> {
        self.call_with_input_for_launch_key(
            MobileRelayV2ManagementOperation::StartConnector,
            ManagementInput::None,
            Some(expected_launch_key),
        )
    }

    pub(crate) fn wait_for_self_hosted_connector_base_readiness(
        &self,
        expected_launch_key: &ManagementLaunchKey,
        readiness: super::management_protocol_v2::BaseConnectorReadiness,
    ) -> Result<(), ManagementError> {
        self.wait_for_self_hosted_connector_base_readiness_with_bounds(
            expected_launch_key,
            readiness,
            CONNECTOR_READINESS_TIMEOUT,
            CONNECTOR_READINESS_POLL_INTERVAL,
        )
    }

    fn wait_for_self_hosted_connector_base_readiness_with_bounds(
        &self,
        expected_launch_key: &ManagementLaunchKey,
        mut readiness: super::management_protocol_v2::BaseConnectorReadiness,
        timeout: Duration,
        poll_interval: Duration,
    ) -> Result<(), ManagementError> {
        use super::management_protocol_v2::BaseConnectorReadiness;

        if readiness == BaseConnectorReadiness::Ready {
            return Ok(());
        }
        if readiness != BaseConnectorReadiness::Starting {
            return Err(not_ready_error());
        }
        let deadline = Instant::now() + timeout;

        loop {
            let now = Instant::now();
            if now >= deadline {
                return Err(not_ready_error());
            }
            thread::sleep(poll_interval.min(deadline.saturating_duration_since(now)));
            readiness = base_connector_readiness(self.call_with_input_for_launch_key(
                MobileRelayV2ManagementOperation::Status,
                ManagementInput::None,
                Some(expected_launch_key),
            )?)?;
            match readiness {
                BaseConnectorReadiness::Ready => return Ok(()),
                BaseConnectorReadiness::Starting => {}
                BaseConnectorReadiness::NotReady => return Err(not_ready_error()),
            }
        }
    }

    pub(crate) fn replace_self_hosted<F>(
        &self,
        app: &tauri::AppHandle,
        selection: ManagementChildSelection,
        commit_ready: F,
    ) -> Result<(), ManagementStartError>
    where
        F: FnOnce() -> Result<(), String>,
    {
        if self.disposed.load(Ordering::Acquire) {
            return Err(ManagementStartError::ChannelClosed);
        }
        let desired_key = selection.launch_key();
        let published_key = selection.steady_launch_key();
        let mut owner = self.owner.lock().unwrap();
        if self.disposed.load(Ordering::Acquire) {
            return Err(ManagementStartError::ChannelClosed);
        }
        if matches!(
            &*owner,
            ManagementCommandOwner::Ready {
                launch_key,
                manager,
            } if launch_key == &desired_key && manager.is_reusable_after_observation()
        ) {
            return Ok(());
        }

        self.artifacts.clear();
        let completion = Arc::new(ManagementDrainCompletion::pending());
        let previous = std::mem::replace(
            &mut *owner,
            ManagementCommandOwner::Replacing(completion.clone()),
        );
        match previous {
            ManagementCommandOwner::Ready { manager, .. } => {
                if manager.dispose() != ManagementCleanupOutcome::Clean {
                    *owner =
                        ManagementCommandOwner::StartFailed(ManagementStartError::RecoveryRequired);
                    completion.complete(ManagementCleanupOutcome::RecoveryRequired);
                    return Err(ManagementStartError::RecoveryRequired);
                }
            }
            ManagementCommandOwner::StartFailed(ManagementStartError::RecoveryRequired) => {
                *owner =
                    ManagementCommandOwner::StartFailed(ManagementStartError::RecoveryRequired);
                completion.complete(ManagementCleanupOutcome::RecoveryRequired);
                return Err(ManagementStartError::RecoveryRequired);
            }
            ManagementCommandOwner::StartFailed(_) => {}
            ManagementCommandOwner::Replacing(previous) => {
                drop(owner);
                let cleanup = previous.wait();
                completion.complete(cleanup);
                return Err(if cleanup == ManagementCleanupOutcome::RecoveryRequired {
                    ManagementStartError::RecoveryRequired
                } else {
                    ManagementStartError::ChannelClosed
                });
            }
        }

        if self.disposed.load(Ordering::Acquire) {
            *owner = ManagementCommandOwner::StartFailed(ManagementStartError::ChannelClosed);
            completion.complete(ManagementCleanupOutcome::Clean);
            return Err(ManagementStartError::ChannelClosed);
        }
        let candidate = ManagementChildManager::start_selected(app, selection);
        let settled = settle_candidate_start(candidate, commit_ready);
        match settled {
            Ok(manager) => {
                *owner = ManagementCommandOwner::Ready {
                    launch_key: published_key,
                    manager,
                };
                completion.complete(ManagementCleanupOutcome::Clean);
                Ok(())
            }
            Err(error) => {
                *owner = ManagementCommandOwner::StartFailed(error);
                completion.complete(if error == ManagementStartError::RecoveryRequired {
                    ManagementCleanupOutcome::RecoveryRequired
                } else {
                    ManagementCleanupOutcome::Clean
                });
                Err(error)
            }
        }
    }

    pub(crate) fn dispose(&self) -> ManagementCleanupOutcome {
        self.shutdown_and_drain()
    }

    fn shutdown_and_drain(&self) -> ManagementCleanupOutcome {
        let (completion, leader) = {
            let mut shutdown = self.shutdown.lock().unwrap();
            match &*shutdown {
                ManagementShutdown::Complete(outcome) => return *outcome,
                ManagementShutdown::Draining(completion) => (completion.clone(), false),
                ManagementShutdown::Live => {
                    let completion = Arc::new(ManagementDrainCompletion::pending());
                    *shutdown = ManagementShutdown::Draining(completion.clone());
                    (completion, true)
                }
            }
        };
        if !leader {
            return completion.wait();
        }

        // The sole completion becomes visible before the disposed fence. No
        // concurrent Exit/dispose can observe shutdown without an exact
        // outcome barrier to await.
        self.disposed.store(true, Ordering::Release);
        self.artifacts.close();
        let mut owner = self.owner.lock().unwrap();
        let previous = std::mem::replace(
            &mut *owner,
            ManagementCommandOwner::Replacing(completion.clone()),
        );
        drop(owner);
        let cleanup = drain_command_owner(previous);
        let mut owner = self.owner.lock().unwrap();
        *owner = ManagementCommandOwner::StartFailed(
            if cleanup == ManagementCleanupOutcome::RecoveryRequired {
                ManagementStartError::RecoveryRequired
            } else {
                ManagementStartError::ChannelClosed
            },
        );
        drop(owner);
        {
            let mut shutdown = self.shutdown.lock().unwrap();
            *shutdown = ManagementShutdown::Complete(cleanup);
        }
        completion.complete(cleanup);
        cleanup
    }
}

fn drain_command_owner(owner: ManagementCommandOwner) -> ManagementCleanupOutcome {
    match owner {
        ManagementCommandOwner::Ready { manager, .. } => manager.dispose(),
        ManagementCommandOwner::StartFailed(ManagementStartError::RecoveryRequired) => {
            ManagementCleanupOutcome::RecoveryRequired
        }
        ManagementCommandOwner::StartFailed(_) => ManagementCleanupOutcome::Clean,
        ManagementCommandOwner::Replacing(completion) => completion.wait(),
    }
}

fn settle_candidate_start<F>(
    start: Result<ManagementChildManager, ManagementStartError>,
    commit_ready: F,
) -> Result<ManagementChildManager, ManagementStartError>
where
    F: FnOnce() -> Result<(), String>,
{
    let manager = start?;
    if commit_ready().is_ok() {
        return Ok(manager);
    }
    let _ = manager.dispose();
    Err(ManagementStartError::RecoveryRequired)
}

impl Drop for MobileRelayV2ManagementCommandState {
    fn drop(&mut self) {
        self.dispose();
    }
}

#[tauri::command]
pub(crate) async fn mobile_relay_v2_management_call(
    operation: MobileRelayV2ManagementOperation,
    input: serde_json::Value,
    state: State<'_, Arc<MobileRelayV2ManagementCommandState>>,
    deployment: State<'_, Arc<super::MobileRelayV2SelfHostedDeploymentState>>,
) -> Result<ManagementOutcome, ManagementError> {
    let input = decode_command_input(operation, input)?;
    let state = Arc::clone(state.inner());
    let deployment = Arc::clone(deployment.inner());
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(outcome) = super::call_relay_v2_self_hosted_connector_operation(
            deployment.as_ref(),
            state.as_ref(),
            operation,
        ) {
            return outcome;
        }
        state.call_with_input(operation, input)
    })
    .await
    .map_err(|_| channel_closed_error())?
}

#[tauri::command]
pub(crate) async fn mobile_relay_v2_enrollment_artifact_show(
    handle: String,
    app: tauri::AppHandle,
    state: State<'_, Arc<MobileRelayV2ManagementCommandState>>,
) -> Result<(), ManagementError> {
    if !valid_artifact_handle(&handle) {
        return Err(invalid_argument_error());
    }
    show_enrollment_artifact(&app, state.inner().as_ref(), &handle).map_err(|_| not_ready_error())
}

#[tauri::command]
pub(crate) async fn mobile_relay_v2_enrollment_artifact_copy(
    handle: String,
    field: EnrollmentArtifactCopyField,
    state: State<'_, Arc<MobileRelayV2ManagementCommandState>>,
) -> Result<(), ManagementError> {
    if !valid_artifact_handle(&handle) {
        return Err(invalid_argument_error());
    }
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        copy_enrollment_artifact(state.as_ref(), &handle, field)
    })
    .await
    .map_err(|_| not_ready_error())?
    .map_err(|_| not_ready_error())
}

#[tauri::command]
pub(crate) async fn mobile_relay_v2_enrollment_artifact_inline_png(
    handle: String,
    state: State<'_, Arc<MobileRelayV2ManagementCommandState>>,
) -> Result<String, ManagementError> {
    if !valid_artifact_handle(&handle) {
        return Err(invalid_argument_error());
    }
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        inline_enrollment_artifact_png(state.as_ref(), &handle)
    })
    .await
    .map_err(|_| not_ready_error())?
    .map_err(|_| not_ready_error())
}

/// Returns the live QR PNG as base64 (data-URL-ready payload) without
/// consuming the artifact, so the renderer can display the pairing QR inline.
/// The enrollment link and PNG bytes are never logged or persisted.
fn inline_enrollment_artifact_png(
    state: &MobileRelayV2ManagementCommandState,
    handle: &str,
) -> Result<String, ()> {
    if state.disposed.load(Ordering::Acquire) {
        return Err(());
    }
    let png = state.artifacts.claim_inline_png(handle)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(png.as_ref()))
}

fn copy_enrollment_artifact(
    state: &MobileRelayV2ManagementCommandState,
    handle: &str,
    field: EnrollmentArtifactCopyField,
) -> Result<(), ()> {
    if state.disposed.load(Ordering::Acquire) {
        return Err(());
    }
    let value = state.artifacts.claim_copy_value(handle, field)?;
    write_native_clipboard(&value)
}

#[cfg(target_os = "macos")]
fn write_native_clipboard(value: &str) -> Result<(), ()> {
    use std::io::Write as _;

    let mut child = std::process::Command::new("/usr/bin/pbcopy")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| ())?;
    let write_result = child
        .stdin
        .take()
        .ok_or(())
        .and_then(|mut stdin| stdin.write_all(value.as_bytes()).map_err(|_| ()));
    let status = child.wait().map_err(|_| ())?;
    if write_result.is_ok() && status.success() {
        Ok(())
    } else {
        Err(())
    }
}

#[cfg(not(target_os = "macos"))]
fn write_native_clipboard(_value: &str) -> Result<(), ()> {
    Err(())
}

fn show_enrollment_artifact(
    app: &tauri::AppHandle,
    state: &MobileRelayV2ManagementCommandState,
    handle: &str,
) -> Result<(), ()> {
    if state.disposed.load(Ordering::Acquire) {
        return Err(());
    }
    for _ in 0..2 {
        match state.artifacts.claim_window(handle)? {
            EnrollmentArtifactWindowClaim::Existing { label } => {
                if let Some(window) = app.get_webview_window(&label) {
                    if window.show().is_ok() && window.set_focus().is_ok() {
                        return Ok(());
                    }
                    state.artifacts.clear();
                    return Err(());
                }
                state.artifacts.release_window(handle, &label);
            }
            EnrollmentArtifactWindowClaim::Fresh { label, png } => {
                if create_native_artifact_window(
                    app,
                    &label,
                    png,
                    state.artifacts.clone(),
                    handle.to_string(),
                )
                .is_ok()
                {
                    return Ok(());
                }
                state.artifacts.clear();
                return Err(());
            }
        }
    }
    Err(())
}

#[cfg(target_os = "macos")]
fn create_native_artifact_window(
    app: &tauri::AppHandle,
    label: &str,
    png: Arc<[u8]>,
    artifacts: EnrollmentArtifactRegistry,
    handle: String,
) -> Result<(), ()> {
    let url = tauri::Url::parse("about:blank").map_err(|_| ())?;
    let window = tauri::WebviewWindowBuilder::new(app, label, tauri::WebviewUrl::External(url))
        .title("Relay v2 one-time enrollment")
        .inner_size(360.0, 360.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .center()
        .build()
        .map_err(|_| ())?;

    let native_window = window.clone();
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let install_result = window
        .run_on_main_thread(move || {
            let _ = sender.send(install_native_png(&native_window, &png));
        })
        .map_err(|_| ())
        .and_then(|()| receiver.recv().map_err(|_| ()))
        .and_then(|result| result);
    if install_result.is_err() {
        let _ = window.destroy();
        return Err(());
    }

    let event_label = label.to_string();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            artifacts.clear_if_window(&handle, &event_label);
        }
    });
    if window.show().is_err() || window.set_focus().is_err() {
        let _ = window.destroy();
        return Err(());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_native_png(window: &tauri::WebviewWindow, png: &[u8]) -> Result<(), ()> {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSImage, NSImageScaling, NSImageView, NSWindow};
    use objc2_foundation::NSData;

    let mtm = MainThreadMarker::new().ok_or(())?;
    let pointer = window.ns_window().map_err(|_| ())?;
    let ns_window = unsafe { &*pointer.cast::<NSWindow>() };
    let data = unsafe { NSData::dataWithBytes_length(png.as_ptr().cast(), png.len()) };
    let image = NSImage::initWithData(NSImage::alloc(), &data).ok_or(())?;
    let image_view = NSImageView::imageViewWithImage(&image, mtm);
    image_view.setImageScaling(NSImageScaling::ScaleProportionallyUpOrDown);
    ns_window.setContentView(Some(&image_view));
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn create_native_artifact_window(
    _app: &tauri::AppHandle,
    _label: &str,
    _png: Arc<[u8]>,
    _artifacts: EnrollmentArtifactRegistry,
    _handle: String,
) -> Result<(), ()> {
    Err(())
}

fn decode_command_input(
    operation: MobileRelayV2ManagementOperation,
    value: serde_json::Value,
) -> Result<ManagementInput, ManagementError> {
    match operation {
        MobileRelayV2ManagementOperation::Status
        | MobileRelayV2ManagementOperation::BootstrapHost
        | MobileRelayV2ManagementOperation::RefreshHost
        | MobileRelayV2ManagementOperation::StartConnector
        | MobileRelayV2ManagementOperation::StopConnector => {
            if value.is_null() {
                Ok(ManagementInput::None)
            } else {
                Err(invalid_argument_error())
            }
        }
        MobileRelayV2ManagementOperation::CreateEnrollment => {
            let object = value.as_object().ok_or_else(invalid_argument_error)?;
            if object.len() != 1 || !object.contains_key("deviceLabel") {
                return Err(invalid_argument_error());
            }
            let device_label = match &object["deviceLabel"] {
                serde_json::Value::Null => None,
                serde_json::Value::String(label) if valid_opaque(label, 128) => Some(label.clone()),
                _ => return Err(invalid_argument_error()),
            };
            Ok(ManagementInput::CreateEnrollment { device_label })
        }
        MobileRelayV2ManagementOperation::RevokeClientGrant => {
            let object = value.as_object().ok_or_else(invalid_argument_error)?;
            if object.len() != 2
                || !object.contains_key("grantId")
                || object.get("reason").and_then(serde_json::Value::as_str) != Some("user_revoked")
            {
                return Err(invalid_argument_error());
            }
            let grant_id = object["grantId"]
                .as_str()
                .filter(|grant_id| valid_opaque(grant_id, 128))
                .ok_or_else(invalid_argument_error)?;
            Ok(ManagementInput::RevokeClientGrant {
                grant_id: grant_id.to_string(),
            })
        }
    }
}

fn valid_opaque(value: &str, max_bytes: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_bytes
        && value.trim() == value
        && !['\0', '\r', '\n']
            .iter()
            .any(|forbidden| value.contains(*forbidden))
        && !["twcap2.", "twref2.", "twenroll2.", "twhostboot2."]
            .iter()
            .any(|prefix| value.to_ascii_lowercase().contains(prefix))
}

fn valid_artifact_handle(value: &str) -> bool {
    let Some(suffix) = value.strip_prefix("dqart1.") else {
        return false;
    };
    suffix.len() == 32
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn fixed_error(code: &str, message: &str) -> ManagementError {
    ManagementError {
        code: code.to_string(),
        message: message.to_string(),
        retryable: false,
    }
}

fn unavailable_error() -> ManagementError {
    fixed_error(UNAVAILABLE_CODE, UNAVAILABLE_MESSAGE)
}

fn channel_closed_error() -> ManagementError {
    fixed_error(CHANNEL_CLOSED_CODE, CHANNEL_CLOSED_MESSAGE)
}

fn superseded_error() -> ManagementError {
    fixed_error(SUPERSEDED_CODE, SUPERSEDED_MESSAGE)
}

fn invalid_argument_error() -> ManagementError {
    fixed_error(INVALID_ARGUMENT_CODE, INVALID_ARGUMENT_MESSAGE)
}

fn not_ready_error() -> ManagementError {
    fixed_error("NOT_READY", "Relay v2 management is not ready")
}

fn management_now_ms() -> Result<u64, ManagementError> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| not_ready_error())?;
    u64::try_from(elapsed.as_millis()).map_err(|_| not_ready_error())
}

fn base_connector_readiness(
    outcome: ManagementOutcome,
) -> Result<super::management_protocol_v2::BaseConnectorReadiness, ManagementError> {
    let result = successful_v2_result(outcome)?;
    Ok(super::management_protocol_v2::projection_base_connector_readiness(&result))
}

fn successful_v2_result(outcome: ManagementOutcome) -> Result<serde_json::Value, ManagementError> {
    if !outcome.ok {
        return Err(outcome.error.unwrap_or_else(channel_closed_error));
    }
    if outcome.protocol_version != super::management_protocol_v2::PROTOCOL_VERSION
        || outcome.error.is_some()
    {
        return Err(not_ready_error());
    }
    outcome.result.ok_or_else(not_ready_error)
}

fn connector_projection_status(result: &serde_json::Value) -> Option<&str> {
    result
        .get("connector")
        .and_then(serde_json::Value::as_object)
        .and_then(|connector| connector.get("status"))
        .and_then(serde_json::Value::as_str)
}

fn map_start_error(error: ManagementStartError) -> ManagementError {
    match error {
        ManagementStartError::Unavailable => unavailable_error(),
        ManagementStartError::ChannelClosed => channel_closed_error(),
        ManagementStartError::RecoveryRequired => {
            fixed_error(RECOVERY_REQUIRED_CODE, RECOVERY_REQUIRED_MESSAGE)
        }
    }
}

fn map_call_error(error: ManagementCallError) -> ManagementError {
    match error {
        ManagementCallError::Superseded => superseded_error(),
        ManagementCallError::ChannelClosed | ManagementCallError::RequestIdUnavailable => {
            channel_closed_error()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn projection_failure_fences_then_drains_without_recursively_locking_owner() {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
        use std::sync::mpsc;
        use std::time::Duration;

        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../contracts/dashboard-relay-v2-management/v2/cases.json"
        ))
        .unwrap();
        let exchange = fixture["goldenExchanges"]
            .as_array()
            .unwrap()
            .iter()
            .find(|exchange| exchange["operation"] == "create_enrollment")
            .unwrap();
        let request_id = exchange["normalizedRequest"]["requestId"].as_str().unwrap();
        let request_id: [u8; 16] = URL_SAFE_NO_PAD
            .decode(request_id.split_once('.').unwrap().1)
            .unwrap()
            .try_into()
            .unwrap();
        let response = exchange["responseFrame"].as_str().unwrap().trim_end();
        assert!(!response.contains('\''));
        let script = format!(
            "printf '%s\\n' '{{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}}'; IFS= read -r request; printf '%s\\n' '{response}'; while IFS= read -r request; do :; done"
        );
        let manager =
            ManagementChildManager::start_v2_command_regression_script(script, request_id).unwrap();
        let state = Arc::new(MobileRelayV2ManagementCommandState::from_start(Ok(manager)));
        let called = state.clone();
        let (sent, received) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            sent.send(called.call_with_input(
                MobileRelayV2ManagementOperation::CreateEnrollment,
                ManagementInput::CreateEnrollment {
                    device_label: Some("Pixel".to_string()),
                },
            ))
            .unwrap();
        });
        assert_eq!(
            received.recv_timeout(Duration::from_secs(2)).unwrap(),
            Err(channel_closed_error())
        );
        worker.join().unwrap();
        assert_eq!(
            state.call(MobileRelayV2ManagementOperation::Status),
            Err(channel_closed_error())
        );
    }

    #[test]
    fn concurrent_dispose_waits_for_the_single_published_drain_outcome() {
        use std::sync::mpsc;
        use std::time::Duration;

        let state = Arc::new(MobileRelayV2ManagementCommandState::from_start(Err(
            ManagementStartError::ChannelClosed,
        )));
        let completion = Arc::new(ManagementDrainCompletion::pending());
        *state.shutdown.lock().unwrap() = ManagementShutdown::Draining(completion.clone());
        state.disposed.store(true, Ordering::Release);

        let follower = state.clone();
        let (sent, received) = mpsc::channel();
        std::thread::spawn(move || sent.send(follower.dispose()).unwrap());
        assert!(received.recv_timeout(Duration::from_millis(20)).is_err());

        completion.complete(ManagementCleanupOutcome::RecoveryRequired);
        assert_eq!(
            received.recv_timeout(Duration::from_secs(1)).unwrap(),
            ManagementCleanupOutcome::RecoveryRequired
        );
    }

    #[test]
    fn command_operation_is_a_closed_enum() {
        let cases = [
            ("status", MobileRelayV2ManagementOperation::Status),
            (
                "bootstrap_host",
                MobileRelayV2ManagementOperation::BootstrapHost,
            ),
            (
                "refresh_host",
                MobileRelayV2ManagementOperation::RefreshHost,
            ),
            (
                "start_connector",
                MobileRelayV2ManagementOperation::StartConnector,
            ),
            (
                "stop_connector",
                MobileRelayV2ManagementOperation::StopConnector,
            ),
            (
                "create_enrollment",
                MobileRelayV2ManagementOperation::CreateEnrollment,
            ),
            (
                "revoke_client_grant",
                MobileRelayV2ManagementOperation::RevokeClientGrant,
            ),
        ];
        for (input, expected) in cases {
            assert_eq!(
                serde_json::from_str::<MobileRelayV2ManagementOperation>(&format!("\"{input}\""))
                    .unwrap(),
                expected
            );
        }
        assert!(
            serde_json::from_str::<MobileRelayV2ManagementOperation>("\"status_now\"").is_err()
        );
        assert!(serde_json::from_str::<MobileRelayV2ManagementOperation>(
            r#"{"operation":"status"}"#
        )
        .is_err());
    }

    #[test]
    fn start_failure_is_permanent_and_closed() {
        let unavailable =
            MobileRelayV2ManagementCommandState::from_start(Err(ManagementStartError::Unavailable));
        assert_eq!(
            unavailable
                .call(MobileRelayV2ManagementOperation::Status)
                .unwrap_err(),
            unavailable_error()
        );
        assert_eq!(
            unavailable
                .call(MobileRelayV2ManagementOperation::StartConnector)
                .unwrap_err(),
            unavailable_error()
        );

        let channel_closed = MobileRelayV2ManagementCommandState::from_start(Err(
            ManagementStartError::ChannelClosed,
        ));
        assert_eq!(
            channel_closed
                .call(MobileRelayV2ManagementOperation::Status)
                .unwrap_err(),
            channel_closed_error()
        );
    }

    #[cfg(unix)]
    fn command_regression_request_id(bytes: [u8; 16]) -> String {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

        format!("dmgmt2.{}", URL_SAFE_NO_PAD.encode(bytes))
    }

    #[cfg(unix)]
    fn command_regression_projection_response(
        request_bytes: [u8; 16],
        connector: serde_json::Value,
    ) -> String {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../../contracts/dashboard-relay-v2-management/v2/cases.json"
        ))
        .unwrap();
        let mut response: serde_json::Value = serde_json::from_str(
            fixture["goldenExchanges"]
                .as_array()
                .unwrap()
                .iter()
                .find(|exchange| exchange["operation"] == "start_connector")
                .unwrap()["responseFrame"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        response["requestId"] =
            serde_json::Value::String(command_regression_request_id(request_bytes));
        response["result"]["hostCredential"]["expiresAtMs"] =
            serde_json::json!(8_000_000_000_000_u64);
        response["result"]["connector"] = connector;
        serde_json::to_string(&response).unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn self_hosted_connector_reuses_exact_ready_projection_without_a_new_start() {
        let first = [11; 16];
        let second = [12; 16];
        let ready_connector = serde_json::json!({
            "status": "registered",
            "acknowledgement": "host.registered",
            "hostId": "mac-admin",
            "connectorId": "connector-one",
            "negotiatedCapabilityIntersection":
                super::super::management_protocol_v2::REQUIRED_CAPABILITIES,
        });
        let first_response = command_regression_projection_response(first, ready_connector.clone());
        let second_response = command_regression_projection_response(second, ready_connector);
        let first_id = command_regression_request_id(first);
        let second_id = command_regression_request_id(second);
        let script = format!(
            "printf '%s\\n' '{{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}}'; while IFS= read -r request; do case \"$request\" in *'\"operation\":\"start_connector\"'*) exit 73 ;; *'{first_id}'*) printf '%s\\n' '{first_response}' ;; *'{second_id}'*) printf '%s\\n' '{second_response}' ;; *) exit 74 ;; esac; done"
        );
        let manager = ManagementChildManager::start_v2_command_regression_script_with_request_ids(
            script,
            vec![first, second],
        )
        .unwrap();
        let state = MobileRelayV2ManagementCommandState::from_start(Ok(manager));

        assert_eq!(
            state.ensure_self_hosted_connector_start_accepted(
                &ManagementLaunchKey::DefaultProduction
            ),
            Ok(super::super::management_protocol_v2::BaseConnectorReadiness::Ready)
        );
        assert!(
            state
                .call(MobileRelayV2ManagementOperation::Status)
                .unwrap()
                .ok
        );
    }

    #[cfg(unix)]
    #[test]
    fn restart_restore_arms_one_controller_owned_attempt_without_polling() {
        let ids = [[13; 16], [14; 16], [15; 16]];
        let stopped = command_regression_projection_response(
            ids[0],
            serde_json::json!({"status": "stopped"}),
        );
        let starting_connector = serde_json::json!({"status": "starting", "hostId": "mac-admin"});
        let starting = command_regression_projection_response(ids[1], starting_connector.clone());
        let after = command_regression_projection_response(ids[2], starting_connector);
        let request_ids = ids.map(command_regression_request_id);
        let script = format!(
            "printf '%s\\n' '{{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}}'; while IFS= read -r request; do case \"$request\" in *'{}'*) case \"$request\" in *'\"operation\":\"status\"'*) printf '%s\\n' '{}' ;; *) exit 77 ;; esac ;; *'{}'*) case \"$request\" in *'\"operation\":\"start_connector\"'*) printf '%s\\n' '{}' ;; *) exit 78 ;; esac ;; *'{}'*) case \"$request\" in *'\"operation\":\"status\"'*) printf '%s\\n' '{}' ;; *) exit 79 ;; esac ;; *) exit 80 ;; esac; done",
            request_ids[0],
            stopped,
            request_ids[1],
            starting,
            request_ids[2],
            after,
        );
        let manager = ManagementChildManager::start_v2_command_regression_script_with_request_ids(
            script,
            ids.to_vec(),
        )
        .unwrap();
        let state = MobileRelayV2ManagementCommandState::from_start(Ok(manager));

        assert_eq!(
            state.restore_self_hosted_connector_desired_state(
                &ManagementLaunchKey::DefaultProduction
            ),
            Ok(())
        );
        assert!(
            state
                .call(MobileRelayV2ManagementOperation::Status)
                .unwrap()
                .ok
        );
    }

    #[cfg(unix)]
    #[test]
    fn expired_start_and_restore_refresh_before_connector_admission() {
        const NOW_MS: u64 = 1_900_000_000_000;
        let ids = [
            [41; 16], [42; 16], [43; 16], [44; 16], [45; 16], [46; 16], [47; 16],
        ];
        let stopped_connector = serde_json::json!({"status": "stopped"});
        let starting_connector = serde_json::json!({"status": "starting", "hostId": "mac-admin"});
        let response = |request_id, connector: serde_json::Value, expires_at_ms| {
            let mut value: serde_json::Value = serde_json::from_str(
                &command_regression_projection_response(request_id, connector),
            )
            .unwrap();
            value["result"]["hostCredential"]["expiresAtMs"] = serde_json::json!(expires_at_ms);
            serde_json::to_string(&value).unwrap()
        };
        let responses = [
            response(ids[0], stopped_connector.clone(), NOW_MS),
            response(ids[1], stopped_connector.clone(), NOW_MS + 3_600_000),
            response(ids[2], starting_connector.clone(), NOW_MS + 3_600_000),
            response(ids[3], stopped_connector.clone(), NOW_MS - 1),
            response(ids[4], stopped_connector, NOW_MS + 7_200_000),
            response(ids[5], starting_connector.clone(), NOW_MS + 7_200_000),
            response(ids[6], starting_connector, NOW_MS + 7_200_000),
        ];
        let request_ids = ids.map(command_regression_request_id);
        let script = format!(
            "printf '%s\\n' '{{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}}'; while IFS= read -r request; do case \"$request\" in *'{}'*) case \"$request\" in *'\"operation\":\"status\"'*) printf '%s\\n' '{}' ;; *) exit 91 ;; esac ;; *'{}'*) case \"$request\" in *'\"operation\":\"refresh_host\"'*) printf '%s\\n' '{}' ;; *) exit 92 ;; esac ;; *'{}'*) case \"$request\" in *'\"operation\":\"start_connector\"'*) printf '%s\\n' '{}' ;; *) exit 93 ;; esac ;; *'{}'*) case \"$request\" in *'\"operation\":\"status\"'*) printf '%s\\n' '{}' ;; *) exit 94 ;; esac ;; *'{}'*) case \"$request\" in *'\"operation\":\"refresh_host\"'*) printf '%s\\n' '{}' ;; *) exit 95 ;; esac ;; *'{}'*) case \"$request\" in *'\"operation\":\"start_connector\"'*) printf '%s\\n' '{}' ;; *) exit 96 ;; esac ;; *'{}'*) case \"$request\" in *'\"operation\":\"status\"'*) printf '%s\\n' '{}' ;; *) exit 97 ;; esac ;; *) exit 98 ;; esac; done",
            request_ids[0],
            responses[0],
            request_ids[1],
            responses[1],
            request_ids[2],
            responses[2],
            request_ids[3],
            responses[3],
            request_ids[4],
            responses[4],
            request_ids[5],
            responses[5],
            request_ids[6],
            responses[6],
        );
        let manager = ManagementChildManager::start_v2_command_regression_script_with_request_ids(
            script,
            ids.to_vec(),
        )
        .unwrap();
        let state = MobileRelayV2ManagementCommandState::from_start(Ok(manager));

        assert_eq!(
            state.restore_self_hosted_connector_desired_state_with_now(
                &ManagementLaunchKey::DefaultProduction,
                NOW_MS,
            ),
            Ok(()),
        );
        assert!(
            state
                .start_self_hosted_connector_with_now(
                    &ManagementLaunchKey::DefaultProduction,
                    NOW_MS,
                )
                .unwrap()
                .ok
        );
        assert!(
            state
                .call(MobileRelayV2ManagementOperation::Status)
                .unwrap()
                .ok
        );
    }

    #[cfg(unix)]
    #[test]
    fn restart_restore_reuses_an_already_armed_starting_cut() {
        let ids = [[16; 16], [17; 16]];
        let starting_connector = serde_json::json!({"status": "starting", "hostId": "mac-admin"});
        let first = command_regression_projection_response(ids[0], starting_connector.clone());
        let after = command_regression_projection_response(ids[1], starting_connector);
        let request_ids = ids.map(command_regression_request_id);
        let script = format!(
            "printf '%s\\n' '{{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}}'; while IFS= read -r request; do case \"$request\" in *'\"operation\":\"start_connector\"'*) exit 81 ;; *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *) exit 82 ;; esac; done",
            request_ids[0],
            first,
            request_ids[1],
            after,
        );
        let manager = ManagementChildManager::start_v2_command_regression_script_with_request_ids(
            script,
            ids.to_vec(),
        )
        .unwrap();
        let state = MobileRelayV2ManagementCommandState::from_start(Ok(manager));

        assert_eq!(
            state.restore_self_hosted_connector_desired_state(
                &ManagementLaunchKey::DefaultProduction
            ),
            Ok(())
        );
        assert!(
            state
                .call(MobileRelayV2ManagementOperation::Status)
                .unwrap()
                .ok
        );
    }

    #[cfg(unix)]
    #[test]
    fn restart_restore_does_not_override_a_nonretryable_failed_cut() {
        let ids = [[20; 16], [21; 16]];
        let failed_connector = serde_json::json!({"status": "failed", "retryable": false});
        let first = command_regression_projection_response(ids[0], failed_connector.clone());
        let after = command_regression_projection_response(ids[1], failed_connector);
        let request_ids = ids.map(command_regression_request_id);
        let script = format!(
            "printf '%s\\n' '{{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}}'; while IFS= read -r request; do case \"$request\" in *'\"operation\":\"start_connector\"'*) exit 85 ;; *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *) exit 86 ;; esac; done",
            request_ids[0],
            first,
            request_ids[1],
            after,
        );
        let manager = ManagementChildManager::start_v2_command_regression_script_with_request_ids(
            script,
            ids.to_vec(),
        )
        .unwrap();
        let state = MobileRelayV2ManagementCommandState::from_start(Ok(manager));

        assert_eq!(
            state.restore_self_hosted_connector_desired_state(
                &ManagementLaunchKey::DefaultProduction
            ),
            Err(not_ready_error())
        );
        assert!(
            state
                .call(MobileRelayV2ManagementOperation::Status)
                .unwrap()
                .ok
        );
    }

    #[cfg(unix)]
    #[test]
    fn restart_restore_rejects_a_different_published_launch_identity_before_request() {
        let script = "printf '%s\\n' '{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}'; while IFS= read -r request; do exit 87; done".to_string();
        let manager =
            ManagementChildManager::start_v2_command_regression_script(script, [26; 16]).unwrap();
        let identity = super::super::management_child::ManagementPreparedFileIdentity {
            device: 1,
            inode: 2,
            length: 3,
            mode: 0o600,
            uid: 501,
            links: 1,
            sha256: [4; 32],
        };
        let published_key = ManagementLaunchKey::SelfHostedDarwinArm64 {
            account_home: std::path::PathBuf::from("/Users/test"),
            credential_https_ca_input: std::path::PathBuf::from("/Users/test/issuer-ca.pem"),
            carrier_wss_ca_input: std::path::PathBuf::from("/Users/test/carrier-ca.pem"),
            credential_https_ca_identity: identity.clone(),
            carrier_wss_ca_identity: identity,
            profile_lineage: "00112233445566778899aabbccddeeff".to_string(),
            provision_profile_input: None,
            bootstrap_secret_input: None,
            bootstrap_secret_mode: None,
        };
        let state = MobileRelayV2ManagementCommandState::from_start_with_artifacts(
            Ok(manager),
            published_key,
            EnrollmentArtifactRegistry::disabled(),
        );

        assert_eq!(
            state.restore_self_hosted_connector_desired_state(
                &ManagementLaunchKey::DefaultProduction
            ),
            Err(not_ready_error())
        );
    }

    #[cfg(unix)]
    #[test]
    fn explicit_stop_uses_the_management_owner_and_requires_exact_stopped() {
        let ids = [[18; 16], [19; 16]];
        let stopped_connector = serde_json::json!({"status": "stopped"});
        let stopped = command_regression_projection_response(ids[0], stopped_connector.clone());
        let after = command_regression_projection_response(ids[1], stopped_connector);
        let request_ids = ids.map(command_regression_request_id);
        let script = format!(
            "printf '%s\\n' '{{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}}'; while IFS= read -r request; do case \"$request\" in *'{}'*) case \"$request\" in *'\"operation\":\"stop_connector\"'*) printf '%s\\n' '{}' ;; *) exit 83 ;; esac ;; *'{}'*) printf '%s\\n' '{}' ;; *) exit 84 ;; esac; done",
            request_ids[0],
            stopped,
            request_ids[1],
            after,
        );
        let manager = ManagementChildManager::start_v2_command_regression_script_with_request_ids(
            script,
            ids.to_vec(),
        )
        .unwrap();
        let state = MobileRelayV2ManagementCommandState::from_start(Ok(manager));

        assert!(state
            .stop_self_hosted_connector_for_launch_key(Some(
                &ManagementLaunchKey::DefaultProduction,
            ))
            .is_ok());
        assert!(
            state
                .call(MobileRelayV2ManagementOperation::Status)
                .unwrap()
                .ok
        );
    }

    #[cfg(unix)]
    #[test]
    fn accepted_connector_start_polls_the_exact_ready_cut_without_poisoning_the_child() {
        let ids = [[21; 16], [22; 16], [23; 16], [24; 16], [25; 16]];
        let stopped = command_regression_projection_response(
            ids[0],
            serde_json::json!({"status": "stopped"}),
        );
        let starting = serde_json::json!({"status": "starting", "hostId": "mac-admin"});
        let accepted = command_regression_projection_response(ids[1], starting.clone());
        let pending = command_regression_projection_response(ids[2], starting);
        let ready_connector = serde_json::json!({
            "status": "registered",
            "acknowledgement": "host.registered",
            "hostId": "mac-admin",
            "connectorId": "connector-one",
            "negotiatedCapabilityIntersection":
                super::super::management_protocol_v2::REQUIRED_CAPABILITIES,
        });
        let ready = command_regression_projection_response(ids[3], ready_connector.clone());
        let after = command_regression_projection_response(ids[4], ready_connector);
        let request_ids = ids.map(command_regression_request_id);
        let script = format!(
            "printf '%s\\n' '{{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}}'; while IFS= read -r request; do case \"$request\" in *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *) exit 75 ;; esac; done",
            request_ids[0],
            stopped,
            request_ids[1],
            accepted,
            request_ids[2],
            pending,
            request_ids[3],
            ready,
            request_ids[4],
            after,
        );
        let manager = ManagementChildManager::start_v2_command_regression_script_with_request_ids(
            script,
            ids.to_vec(),
        )
        .unwrap();
        let state = MobileRelayV2ManagementCommandState::from_start(Ok(manager));

        let readiness = state
            .ensure_self_hosted_connector_start_accepted(&ManagementLaunchKey::DefaultProduction)
            .unwrap();
        assert_eq!(
            state.wait_for_self_hosted_connector_base_readiness_with_bounds(
                &ManagementLaunchKey::DefaultProduction,
                readiness,
                Duration::from_secs(1),
                Duration::from_millis(1),
            ),
            Ok(())
        );
        assert!(
            state
                .call(MobileRelayV2ManagementOperation::Status)
                .unwrap()
                .ok
        );
    }

    #[cfg(unix)]
    #[test]
    fn connector_readiness_timeout_does_not_poison_the_management_child() {
        let ids = [[31; 16], [32; 16], [33; 16], [34; 16]];
        let stopped = command_regression_projection_response(
            ids[0],
            serde_json::json!({"status": "stopped"}),
        );
        let starting = serde_json::json!({"status": "starting", "hostId": "mac-admin"});
        let responses = [
            stopped,
            command_regression_projection_response(ids[1], starting.clone()),
            command_regression_projection_response(ids[2], starting.clone()),
            command_regression_projection_response(ids[3], starting),
        ];
        let request_ids = ids.map(command_regression_request_id);
        let script = format!(
            "printf '%s\\n' '{{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}}'; while IFS= read -r request; do case \"$request\" in *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *) exit 76 ;; esac; done",
            request_ids[0],
            responses[0],
            request_ids[1],
            responses[1],
            request_ids[2],
            responses[2],
            request_ids[3],
            responses[3],
        );
        let manager = ManagementChildManager::start_v2_command_regression_script_with_request_ids(
            script,
            ids.to_vec(),
        )
        .unwrap();
        let state = MobileRelayV2ManagementCommandState::from_start(Ok(manager));

        let readiness = state
            .ensure_self_hosted_connector_start_accepted(&ManagementLaunchKey::DefaultProduction)
            .unwrap();
        assert_eq!(
            state.wait_for_self_hosted_connector_base_readiness_with_bounds(
                &ManagementLaunchKey::DefaultProduction,
                readiness,
                Duration::from_millis(1),
                Duration::from_millis(1),
            ),
            Err(not_ready_error())
        );
        assert!(
            state
                .call(MobileRelayV2ManagementOperation::Status)
                .unwrap()
                .ok
        );
    }

    #[test]
    fn artifact_owner_start_failure_is_permanently_unavailable_without_starting_the_child() {
        let unavailable = MobileRelayV2ManagementCommandState::from_artifact_start(
            Err(()),
            ManagementLaunchKey::DefaultProduction,
            || panic!("artifact failure must fence child startup"),
        );
        assert_eq!(
            unavailable
                .call(MobileRelayV2ManagementOperation::Status)
                .unwrap_err(),
            unavailable_error()
        );
    }

    #[test]
    fn supervisor_failures_have_fixed_non_retryable_command_errors() {
        assert_eq!(
            map_call_error(ManagementCallError::RequestIdUnavailable),
            channel_closed_error()
        );
        assert_eq!(
            map_call_error(ManagementCallError::ChannelClosed),
            channel_closed_error()
        );
        assert_eq!(
            map_call_error(ManagementCallError::Superseded),
            superseded_error()
        );
    }

    #[test]
    fn dashboard_management_v2_command_inputs_are_closed_and_non_sensitive() {
        assert_eq!(
            decode_command_input(
                MobileRelayV2ManagementOperation::Status,
                serde_json::Value::Null
            )
            .unwrap(),
            ManagementInput::None
        );
        assert_eq!(
            decode_command_input(
                MobileRelayV2ManagementOperation::CreateEnrollment,
                serde_json::json!({ "deviceLabel": "Pixel" }),
            )
            .unwrap(),
            ManagementInput::CreateEnrollment {
                device_label: Some("Pixel".to_string())
            }
        );
        assert_eq!(
            decode_command_input(
                MobileRelayV2ManagementOperation::RevokeClientGrant,
                serde_json::json!({ "grantId": "client-grant-1", "reason": "user_revoked" }),
            )
            .unwrap(),
            ManagementInput::RevokeClientGrant {
                grant_id: "client-grant-1".to_string()
            }
        );
        for (operation, input) in [
            (
                MobileRelayV2ManagementOperation::Status,
                serde_json::json!({}),
            ),
            (
                MobileRelayV2ManagementOperation::CreateEnrollment,
                serde_json::json!({ "deviceLabel": null, "intent": "retry" }),
            ),
            (
                MobileRelayV2ManagementOperation::CreateEnrollment,
                serde_json::json!({ "deviceLabel": "twcap2.forbidden" }),
            ),
            (
                MobileRelayV2ManagementOperation::RevokeClientGrant,
                serde_json::json!({ "grantId": "client-grant-1", "reason": "admin" }),
            ),
        ] {
            assert_eq!(
                decode_command_input(operation, input).unwrap_err(),
                invalid_argument_error()
            );
        }
    }
}
