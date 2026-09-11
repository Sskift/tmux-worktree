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
    fixed_error, ManagementCallError, ManagementChildManager, ManagementChildSelection,
    ManagementCleanupOutcome, ManagementError, ManagementInput, ManagementLaunchKey,
    ManagementOperation, ManagementOutcome, ManagementStartError,
};
use super::management_protocol_v2::{valid_device_label, valid_identifier};

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
// Bound lazy management-child resurrection: a child that keeps dying must not
// trigger an unbounded spawn storm (each spawn waits up to STARTUP_TIMEOUT).
// After this many attempts a rebuild is suppressed until the cooldown elapses;
// calls then surface the terminal channel-closed error so the operator can
// retry manually.
const RESURRECT_MAX_ATTEMPTS: u32 = 3;
const RESURRECT_COOLDOWN: Duration = Duration::from_secs(60);

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SelfHostedConnectorRepair {
    Accepted,
    ChildRetrying,
    RebuildRequired,
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

#[cfg(test)]
type RebuildOverrideFactory =
    Arc<dyn Fn() -> Result<ManagementChildManager, ManagementStartError> + Send + Sync>;

pub(crate) struct MobileRelayV2ManagementCommandState {
    owner: Mutex<ManagementCommandOwner>,
    shutdown: Mutex<ManagementShutdown>,
    artifacts: EnrollmentArtifactRegistry,
    disposed: AtomicBool,
    // Handle used to lazily resurrect a poisoned/crashed management child
    // without restarting the Dashboard. None for states that can never spawn
    // (unavailable) or in unit tests that construct managers directly.
    rebuild_handle: Mutex<Option<tauri::AppHandle>>,
    // Mode latch for lazy resurrection: only the default-production owner
    // (which has no desired-state watchdog) is rebuilt from the call path.
    // Self-hosted owners and the permanent-unavailable state must never spawn a
    // DefaultProduction child on this path — they are rebuilt by the connector
    // watchdog / explicit Start Center. The owner may transiently be
    // StartFailed(ChannelClosed) in BOTH modes, so the owner match arms cannot
    // tell them apart without it. It follows the owner LINEAGE, not the
    // construction-time selection: a Dashboard that starts in default
    // production and is switched to self-hosted in-app (first Save + Deploy +
    // Start Center replaces the same singleton) must flip it to false at the
    // moment the self-hosted replacement claims the owner.
    allow_default_production_respawn: AtomicBool,
    resurrect: Mutex<RespawnBudget>,
    #[cfg(test)]
    rebuild_override: Mutex<Option<RebuildOverrideFactory>>,
}

#[derive(Clone, Copy)]
struct RespawnBudget {
    attempts: u32,
    window_started: Option<Instant>,
}

impl RespawnBudget {
    fn fresh() -> Self {
        Self {
            attempts: 0,
            window_started: None,
        }
    }

    /// Check if an attempt is allowed right now without mutating the budget.
    /// Resets if the cooldown window has elapsed.
    fn can_attempt(&self, now: Instant) -> bool {
        if let Some(started) = self.window_started {
            if now.duration_since(started) >= RESURRECT_COOLDOWN {
                return true;
            }
            if self.attempts >= RESURRECT_MAX_ATTEMPTS {
                return false;
            }
        }
        true
    }

    /// Return true and record an attempt if a rebuild is allowed right now;
    /// reset the rolling window once the cooldown has elapsed.
    fn take_attempt(&mut self, now: Instant) -> bool {
        if let Some(started) = self.window_started {
            if now.duration_since(started) >= RESURRECT_COOLDOWN {
                *self = Self::fresh();
            }
        }
        if self.attempts >= RESURRECT_MAX_ATTEMPTS {
            return false;
        }
        if self.window_started.is_none() {
            self.window_started = Some(now);
        }
        self.attempts += 1;
        true
    }
}

impl MobileRelayV2ManagementCommandState {
    pub(crate) fn unavailable() -> Self {
        // The permanently-unavailable state must never spawn a child: the
        // initial start produced no manager and lazy resurrection is a
        // DefaultProduction path only.
        Self::from_start_with_artifacts_and_rebuild(
            Err(ManagementStartError::Unavailable),
            ManagementLaunchKey::DefaultProduction,
            EnrollmentArtifactRegistry::disabled(),
            None,
            false,
        )
    }

    pub(crate) fn start(app: &tauri::AppHandle) -> Self {
        let closer_app = app.clone();
        let artifacts = EnrollmentArtifactRegistry::new(move |label| {
            if let Some(window) = closer_app.get_webview_window(label) {
                let _ = window.destroy();
            }
        });
        let rebuild_handle = app.clone();
        Self::from_artifact_start_with_rebuild(
            artifacts,
            ManagementLaunchKey::DefaultProduction,
            Some(rebuild_handle),
            true,
            || ManagementChildManager::start(app),
        )
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
                // Self-hosted owners are rebuilt by the connector watchdog /
                // explicit Start Center, never by a DefaultProduction respawn.
                Self::from_start_with_artifacts_and_rebuild(
                    settled,
                    launch_key,
                    artifacts,
                    Some(app.clone()),
                    false,
                )
            }
            Err(()) => Self::from_start_with_artifacts_and_rebuild(
                Err(ManagementStartError::Unavailable),
                launch_key,
                EnrollmentArtifactRegistry::disabled(),
                Some(app.clone()),
                false,
            ),
        }
    }

    #[cfg(test)]
    fn from_artifact_start<F>(
        artifacts: Result<EnrollmentArtifactRegistry, ()>,
        launch_key: ManagementLaunchKey,
        start_manager: F,
    ) -> Self
    where
        F: FnOnce() -> Result<ManagementChildManager, ManagementStartError>,
    {
        let allow_default_production_respawn = launch_key == ManagementLaunchKey::DefaultProduction;
        Self::from_artifact_start_with_rebuild(
            artifacts,
            launch_key,
            None,
            allow_default_production_respawn,
            start_manager,
        )
    }

    fn from_artifact_start_with_rebuild<F>(
        artifacts: Result<EnrollmentArtifactRegistry, ()>,
        launch_key: ManagementLaunchKey,
        rebuild_handle: Option<tauri::AppHandle>,
        allow_default_production_respawn: bool,
        start_manager: F,
    ) -> Self
    where
        F: FnOnce() -> Result<ManagementChildManager, ManagementStartError>,
    {
        match artifacts {
            Ok(artifacts) => Self::from_start_with_artifacts_and_rebuild(
                start_manager(),
                launch_key,
                artifacts,
                rebuild_handle,
                allow_default_production_respawn,
            ),
            Err(()) => Self::from_start_with_artifacts_and_rebuild(
                Err(ManagementStartError::Unavailable),
                launch_key,
                EnrollmentArtifactRegistry::disabled(),
                rebuild_handle,
                false,
            ),
        }
    }

    /// Test-only: pretend the respawn budget window started `age` ago so a
    /// test can observe the cooldown rolling over without sleeping 60s.
    #[cfg(test)]
    fn age_respawn_budget_for_test(&self, age: Duration) {
        let mut budget = self.resurrect.lock().unwrap();
        if let Some(started) = budget.window_started {
            budget.window_started = started.checked_sub(age);
        }
    }

    #[cfg(test)]
    fn exhaust_respawn_budget_for_test(&self) {
        let mut budget = self.resurrect.lock().unwrap();
        budget.attempts = RESURRECT_MAX_ATTEMPTS;
        budget.window_started = Some(Instant::now());
    }

    #[cfg(test)]
    fn from_start(start: Result<ManagementChildManager, ManagementStartError>) -> Self {
        Self::from_start_with_artifacts(
            start,
            ManagementLaunchKey::DefaultProduction,
            EnrollmentArtifactRegistry::disabled(),
        )
    }

    #[cfg(test)]
    fn from_start_with_artifacts(
        start: Result<ManagementChildManager, ManagementStartError>,
        launch_key: ManagementLaunchKey,
        artifacts: EnrollmentArtifactRegistry,
    ) -> Self {
        let allow_default_production_respawn = launch_key == ManagementLaunchKey::DefaultProduction;
        Self::from_start_with_artifacts_and_rebuild(
            start,
            launch_key,
            artifacts,
            None,
            allow_default_production_respawn,
        )
    }

    fn from_start_with_artifacts_and_rebuild(
        start: Result<ManagementChildManager, ManagementStartError>,
        launch_key: ManagementLaunchKey,
        artifacts: EnrollmentArtifactRegistry,
        rebuild_handle: Option<tauri::AppHandle>,
        allow_default_production_respawn: bool,
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
            rebuild_handle: Mutex::new(rebuild_handle),
            allow_default_production_respawn: AtomicBool::new(allow_default_production_respawn),
            resurrect: Mutex::new(RespawnBudget::fresh()),
            #[cfg(test)]
            rebuild_override: Mutex::new(None),
        }
    }

    #[cfg(test)]
    fn set_rebuild_override(
        &self,
        factory: impl Fn() -> Result<ManagementChildManager, ManagementStartError>
            + Send
            + Sync
            + 'static,
    ) {
        *self.rebuild_override.lock().unwrap() = Some(Arc::new(factory));
        // A present override enables lazy resurrection even without a real
        // Tauri AppHandle in unit tests.
        *self.rebuild_handle.lock().unwrap() = None;
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
        // At most one lazy resurrection per call. The rebuild itself is bounded
        // by RESURRECT_MAX_ATTEMPTS so this loop is bounded as well.
        let mut resurrected = false;
        loop {
            let attempt =
                self.dispatch_management_call(operation, input.clone(), expected_launch_key);
            let hard_closed = match &attempt {
                Ok(outcome) => {
                    !outcome.ok
                        && outcome
                            .error
                            .as_ref()
                            .is_some_and(|error| error.code == CHANNEL_CLOSED_CODE)
                }
                Err(error) => error.code == CHANNEL_CLOSED_CODE,
            };
            if hard_closed && !resurrected {
                // If a rebuild is already in flight (another caller or the
                // watchdog owns it), wait for that owner to be published and
                // retry against it instead of spawning a second child.
                let in_flight_replace = {
                    let owner = self.owner.lock().unwrap();
                    match &*owner {
                        ManagementCommandOwner::Replacing(completion) => Some(completion.clone()),
                        _ => None,
                    }
                };
                if let Some(completion) = in_flight_replace {
                    let _cleanup = completion.wait();
                    continue;
                }
                if !resurrected {
                    resurrected = true;
                    // Only the default-production owner (which has no desired-
                    // state watchdog) is lazily resurrected from the call path.
                    // Self-hosted owners are rebuilt by the connector watchdog,
                    // and RecoveryRequired stays fail-closed by design.
                    match self.lazy_respawn_default_production() {
                        Ok(()) => continue,
                        Err(ManagementStartError::RecoveryRequired) => {
                            return Err(fixed_error(
                                RECOVERY_REQUIRED_CODE,
                                RECOVERY_REQUIRED_MESSAGE,
                            ));
                        }
                        Err(_) => return attempt,
                    }
                }
            }
            return attempt;
        }
    }

    fn dispatch_management_call(
        &self,
        operation: MobileRelayV2ManagementOperation,
        input: ManagementInput,
        expected_launch_key: Option<&ManagementLaunchKey>,
    ) -> Result<ManagementOutcome, ManagementError> {
        let mut owner = self.owner.lock().unwrap();
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
                            self.artifacts.clear();
                            let previous = std::mem::replace(
                                &mut *owner,
                                ManagementCommandOwner::StartFailed(
                                    ManagementStartError::ChannelClosed,
                                ),
                            );
                            let cleanup = drain_command_owner(previous);
                            *owner = ManagementCommandOwner::StartFailed(
                                if cleanup == ManagementCleanupOutcome::RecoveryRequired {
                                    ManagementStartError::RecoveryRequired
                                } else {
                                    ManagementStartError::ChannelClosed
                                },
                            );
                            return Err(channel_closed_error());
                        }
                    }
                }
                Ok(outcome)
            }
            ManagementCommandOwner::StartFailed(error) => Err(map_start_error(*error)),
            ManagementCommandOwner::Replacing(_completion) => {
                // A rebuild is in flight. Return a hard channel-closed signal;
                // the outer call loop waits on the Replacing completion and
                // retries against the freshly published owner.
                Err(channel_closed_error())
            }
        }
    }

    /// Lazily rebuild the default-production management child after a hard
    /// channel-closed fault (poisoned process or crashed child). Default
    /// production has no desired-state watchdog, so without this the relay v2
    /// panel stays CHANNEL_CLOSED until the Dashboard is restarted. Concurrent
    /// callers coalesce onto the single Replacing completion; the rebuild is
    /// bounded by RESURRECT_MAX_ATTEMPTS inside a rolling cooldown to avoid a
    /// spawn storm against a crash-looping child.
    pub(crate) fn lazy_respawn_default_production(&self) -> Result<(), ManagementStartError> {
        if self.disposed.load(Ordering::Acquire) {
            return Err(ManagementStartError::ChannelClosed);
        }
        // Mode latch: only the default-production owner is lazily rebuilt from
        // the call path. A self-hosted owner can reach Ready{SelfHosted} or
        // StartFailed(ChannelClosed) (projection-failure drain, or the
        // failed-stop abandon path) in exactly the same state this path
        // inspects; StartFailed carries no launch key, so without this latch a
        // non-connector call (status/enrollment) on a drained self-hosted
        // owner would spawn an unrelated DefaultProduction child and publish
        // enrollment/QR data for the production shipping root. Self-hosted
        // faults are rebuilt by the connector watchdog and Start Center.
        if !self
            .allow_default_production_respawn
            .load(Ordering::Acquire)
        {
            return Err(ManagementStartError::ChannelClosed);
        }
        #[cfg(not(test))]
        if self.rebuild_handle.lock().unwrap().is_none() {
            return Err(ManagementStartError::ChannelClosed);
        }
        #[cfg(test)]
        {
            let handle_present = self.rebuild_handle.lock().unwrap().is_some();
            let override_present = self.rebuild_override.lock().unwrap().is_some();
            if !handle_present && !override_present {
                return Err(ManagementStartError::ChannelClosed);
            }
        }
        {
            // Claim one bounded attempt before publishing so a crash-looping
            // child cannot trigger unbounded spawns. An exhausted budget is a
            // soft refusal, not a recovery latch: the owner stays
            // StartFailed(ChannelClosed) so the watchdog / next lazy call
            // retries once the 60s window has rolled over. RecoveryRequired is
            // reserved for deterministic failures (uncertain cleanup, a
            // replacement that could not commit ready).
            let mut budget = self.resurrect.lock().unwrap();
            if !budget.take_attempt(Instant::now()) {
                return Err(ManagementStartError::ChannelClosed);
            }
        }
        let completion = Arc::new(ManagementDrainCompletion::pending());
        let previous = {
            let mut owner = self.owner.lock().unwrap();
            if self.disposed.load(Ordering::Acquire) {
                return Err(ManagementStartError::ChannelClosed);
            }
            // Re-check the mode latch under the owner lock: a self-hosted
            // replacement that claimed the owner between the unlocked check
            // above and here has already flipped it, and its StartFailed
            // lineage must not be resurrected as default production.
            if !self
                .allow_default_production_respawn
                .load(Ordering::Acquire)
            {
                return Err(ManagementStartError::ChannelClosed);
            }
            match &*owner {
                ManagementCommandOwner::Ready { launch_key, .. }
                    if *launch_key == ManagementLaunchKey::DefaultProduction => {}
                ManagementCommandOwner::StartFailed(ManagementStartError::ChannelClosed) => {}
                ManagementCommandOwner::StartFailed(ManagementStartError::RecoveryRequired) => {
                    return Err(ManagementStartError::RecoveryRequired);
                }
                ManagementCommandOwner::StartFailed(ManagementStartError::Unavailable) => {
                    return Err(ManagementStartError::Unavailable);
                }
                ManagementCommandOwner::Ready { .. } => {
                    // Self-hosted owner: rebuilt by the watchdog, not here.
                    return Err(ManagementStartError::ChannelClosed);
                }
                ManagementCommandOwner::Replacing(existing) => {
                    let existing = existing.clone();
                    drop(owner);
                    let cleanup = existing.wait();
                    return if cleanup == ManagementCleanupOutcome::RecoveryRequired {
                        Err(ManagementStartError::RecoveryRequired)
                    } else {
                        Ok(())
                    };
                }
            }
            std::mem::replace(
                &mut *owner,
                ManagementCommandOwner::Replacing(completion.clone()),
            )
        };

        // Drain the old owner outside the owner lock; the spawn below waits up
        // to STARTUP_TIMEOUT and must not block unrelated callers on the mutex.
        let cleanup = drain_command_owner(previous);
        if cleanup == ManagementCleanupOutcome::RecoveryRequired {
            // Fail closed: a child whose cleanup was uncertain may still hold a
            // live native credential claim, so never silently replace it.
            let mut owner = self.owner.lock().unwrap();
            *owner = ManagementCommandOwner::StartFailed(ManagementStartError::RecoveryRequired);
            drop(owner);
            completion.complete(ManagementCleanupOutcome::RecoveryRequired);
            return Err(ManagementStartError::RecoveryRequired);
        }
        #[cfg(test)]
        let started = {
            if let Some(overrider) = self.rebuild_override.lock().unwrap().clone() {
                overrider()
            } else {
                let app = self
                    .rebuild_handle
                    .lock()
                    .unwrap()
                    .clone()
                    .ok_or(ManagementStartError::ChannelClosed)?;
                ManagementChildManager::start(&app)
            }
        };
        #[cfg(not(test))]
        let started = {
            let app = self
                .rebuild_handle
                .lock()
                .unwrap()
                .clone()
                .ok_or(ManagementStartError::ChannelClosed)?;
            ManagementChildManager::start(&app)
        };
        let mut owner = self.owner.lock().unwrap();
        match started {
            Ok(manager) => {
                *owner = ManagementCommandOwner::Ready {
                    launch_key: ManagementLaunchKey::DefaultProduction,
                    manager,
                };
                self.allow_default_production_respawn
                    .store(true, Ordering::Release);
                drop(owner);
                completion.complete(ManagementCleanupOutcome::Clean);
                Ok(())
            }
            Err(error) => {
                *owner = ManagementCommandOwner::StartFailed(error);
                drop(owner);
                completion.complete(if error == ManagementStartError::RecoveryRequired {
                    ManagementCleanupOutcome::RecoveryRequired
                } else {
                    ManagementCleanupOutcome::Clean
                });
                Err(error)
            }
        }
    }

    /// Reset operator recovery latch and respawn budget. Called when an operator
    /// explicitly requests restart/recovery or starts the self-hosted center.
    pub(crate) fn reset_recovery(&self) {
        *self.resurrect.lock().unwrap() = RespawnBudget::fresh();
        let mut owner = self.owner.lock().unwrap();
        if matches!(
            &*owner,
            ManagementCommandOwner::StartFailed(ManagementStartError::RecoveryRequired)
        ) {
            *owner = ManagementCommandOwner::StartFailed(ManagementStartError::ChannelClosed);
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
            BaseConnectorReadiness::Ready
            | BaseConnectorReadiness::Starting
            | BaseConnectorReadiness::Retrying => Ok(()),
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
            BaseConnectorReadiness::NotReady | BaseConnectorReadiness::Retrying => {
                Err(not_ready_error())
            }
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

    pub(crate) fn classify_self_hosted_connector_repair(
        &self,
        expected_launch_key: &ManagementLaunchKey,
    ) -> SelfHostedConnectorRepair {
        use super::management_protocol_v2::BaseConnectorReadiness;

        match self.ensure_self_hosted_connector_start_accepted(expected_launch_key) {
            Ok(BaseConnectorReadiness::Ready | BaseConnectorReadiness::Starting) => {
                SelfHostedConnectorRepair::Accepted
            }
            Ok(BaseConnectorReadiness::Retrying) => SelfHostedConnectorRepair::ChildRetrying,
            Ok(BaseConnectorReadiness::NotReady) => SelfHostedConnectorRepair::RebuildRequired,
            Err(ref error) if management_error_is_transport(error) => {
                SelfHostedConnectorRepair::RebuildRequired
            }
            Err(_) => {
                let status_outcome = match self.call_with_input_for_launch_key(
                    MobileRelayV2ManagementOperation::Status,
                    ManagementInput::None,
                    Some(expected_launch_key),
                ) {
                    Ok(outcome) => outcome,
                    Err(_) => return SelfHostedConnectorRepair::RebuildRequired,
                };
                let status_result = match successful_v2_result(status_outcome) {
                    Ok(result) => result,
                    Err(_) => return SelfHostedConnectorRepair::RebuildRequired,
                };
                let Some(status_str) = connector_projection_status(&status_result) else {
                    return SelfHostedConnectorRepair::RebuildRequired;
                };
                match status_str {
                    "failed" => {
                        if projection_connector_failed_retryable(&status_result) == Some(true) {
                            SelfHostedConnectorRepair::ChildRetrying
                        } else {
                            SelfHostedConnectorRepair::RebuildRequired
                        }
                    }
                    "superseded" => SelfHostedConnectorRepair::RebuildRequired,
                    "stopped" | "starting" | "registered" | "registered_incomplete" => {
                        SelfHostedConnectorRepair::ChildRetrying
                    }
                    _ => SelfHostedConnectorRepair::RebuildRequired,
                }
            }
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
        let readiness =
            super::management_protocol_v2::projection_base_connector_readiness(&status);
        if !refreshed && readiness == BaseConnectorReadiness::Ready {
            return Ok(readiness);
        }
        if !refreshed && readiness == BaseConnectorReadiness::Starting {
            return Ok(readiness);
        }
        if !refreshed && readiness == BaseConnectorReadiness::Retrying {
            return Ok(readiness);
        }
        if strict_stopped
            && !refreshed
            && readiness == BaseConnectorReadiness::NotReady
            && connector_projection_status(&status) != Some("stopped")
        {
            return Err(not_ready_error());
        }
        let original_error = match self.request_self_hosted_connector_start(expected_launch_key) {
            Ok(outcome) => match base_connector_readiness(outcome) {
                Ok(
                    r @ (BaseConnectorReadiness::Ready
                    | BaseConnectorReadiness::Starting
                    | BaseConnectorReadiness::Retrying),
                ) => return Ok(r),
                Ok(BaseConnectorReadiness::NotReady) => None,
                Err(error) => {
                    if management_error_is_transport(&error) {
                        return Err(error);
                    }
                    Some(error)
                }
            },
            Err(error) => {
                if management_error_is_transport(&error) {
                    return Err(error);
                }
                Some(error)
            }
        };
        let status_outcome = self.call_with_input_for_launch_key(
            MobileRelayV2ManagementOperation::Status,
            ManagementInput::None,
            Some(expected_launch_key),
        )?;
        let status_result = match successful_v2_result(status_outcome) {
            Ok(result) => result,
            Err(err) if management_error_is_transport(&err) => return Err(err),
            Err(_) => return Err(original_error.unwrap_or_else(not_ready_error)),
        };
        let reinspected_readiness =
            super::management_protocol_v2::projection_base_connector_readiness(&status_result);
        match reinspected_readiness {
            BaseConnectorReadiness::Ready
            | BaseConnectorReadiness::Starting
            | BaseConnectorReadiness::Retrying => Ok(reinspected_readiness),
            BaseConnectorReadiness::NotReady => {
                Err(original_error.unwrap_or_else(not_ready_error))
            }
        }
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

    pub(crate) fn connector_retrying_error() -> ManagementError {
        fixed_error(
            "NOT_READY",
            "Relay v2 connector is retrying its relay connection automatically",
        )
    }

    /// Predicate for the fixed `connector_retrying_error()` so the deployment
    /// layer can render its own user-facing message without string-matching the
    /// code itself.
    pub(crate) fn management_error_is_connector_retrying(error: &ManagementError) -> bool {
        let expected = Self::connector_retrying_error();
        error.code == expected.code && error.message == expected.message
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
        if readiness != BaseConnectorReadiness::Starting
            && readiness != BaseConnectorReadiness::Retrying
        {
            return Err(not_ready_error());
        }
        let deadline = Instant::now() + timeout;

        loop {
            let now = Instant::now();
            if now >= deadline {
                return match readiness {
                    BaseConnectorReadiness::Retrying => Err(Self::connector_retrying_error()),
                    _ => Err(not_ready_error()),
                };
            }
            thread::sleep(poll_interval.min(deadline.saturating_duration_since(now)));
            if Instant::now() >= deadline {
                return match readiness {
                    BaseConnectorReadiness::Retrying => Err(Self::connector_retrying_error()),
                    _ => Err(not_ready_error()),
                };
            }
            readiness = base_connector_readiness(self.call_with_input_for_launch_key(
                MobileRelayV2ManagementOperation::Status,
                ManagementInput::None,
                Some(expected_launch_key),
            )?)?;
            match readiness {
                BaseConnectorReadiness::Ready => return Ok(()),
                BaseConnectorReadiness::Starting | BaseConnectorReadiness::Retrying => {}
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
        self.replace_self_hosted_with_reuse(Some(app), selection, true, commit_ready)
    }

    /// Rebuild the self-hosted management child even when its process is still
    /// responsive. This is for a terminal cut inside the current root (failed
    /// non-retryable / superseded), a dead channel, or the watchdog's bounded
    /// stall escalation — a retryable failure is owned by the child's retry loop
    /// and must not reach it.
    pub(crate) fn restart_self_hosted<F>(
        &self,
        app: &tauri::AppHandle,
        selection: ManagementChildSelection,
        commit_ready: F,
    ) -> Result<(), ManagementStartError>
    where
        F: FnOnce() -> Result<(), String>,
    {
        self.replace_self_hosted_with_reuse(Some(app), selection, false, commit_ready)
    }

    #[cfg(test)]
    pub(crate) fn restart_self_hosted_for_test<F>(
        &self,
        selection: ManagementChildSelection,
        commit_ready: F,
    ) -> Result<(), ManagementStartError>
    where
        F: FnOnce() -> Result<(), String>,
    {
        self.replace_self_hosted_with_reuse(None, selection, false, commit_ready)
    }

    fn replace_self_hosted_with_reuse<F>(
        &self,
        app: Option<&tauri::AppHandle>,
        selection: ManagementChildSelection,
        reuse_ready_child: bool,
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
        {
            // Never sacrifice a live child to an exhausted budget: the budget
            // used to be charged only after the previous owner had already been
            // drained, so a refused rebuild left the caller with NO child at
            // all. Peek (non-mutating) before touching the owner; a dead or
            // poisoned owner keeps the drain → StartFailed(ChannelClosed) path
            // below. The same-key reuse fast path in claim_replacement never
            // spawns, so it is exempt. The peek-then-claim gap is a benign
            // TOCTOU (worst case: the pre-1.0.28 behavior).
            let owner = self.owner.lock().unwrap();
            if let ManagementCommandOwner::Ready { launch_key, manager } = &*owner {
                let reuse_fast_path = reuse_ready_child && *launch_key == desired_key;
                if !reuse_fast_path && manager.is_reusable_after_observation() {
                    let budget = self.resurrect.lock().unwrap();
                    if !budget.can_attempt(Instant::now()) {
                        return Err(ManagementStartError::ChannelClosed);
                    }
                }
            }
        }
        let completion = Arc::new(ManagementDrainCompletion::pending());
        // Phase 1: under the owner lock, either fast-path a reusable child,
        // coalesce behind an in-flight replacement, or publish Replacing and
        // claim leadership. The expensive drain + spawn (up to STARTUP_TIMEOUT
        // plus the clean-close budget) runs WITHOUT the owner lock so status
        // polls and concurrent management calls observe Replacing promptly
        // instead of blocking on the mutex for tens of seconds.
        let leader_previous =
            match self.claim_replacement(&desired_key, reuse_ready_child, &completion)? {
                Some(previous) => previous,
                None => return Ok(()),
            };

        // Phase 2: drain the old owner and spawn the replacement without the
        // owner lock held. RecoveryRequired stays fail-closed.
        let drain_cleanup = drain_command_owner(leader_previous);
        if drain_cleanup == ManagementCleanupOutcome::RecoveryRequired {
            let mut owner = self.owner.lock().unwrap();
            *owner = ManagementCommandOwner::StartFailed(ManagementStartError::RecoveryRequired);
            drop(owner);
            completion.complete(ManagementCleanupOutcome::RecoveryRequired);
            return Err(ManagementStartError::RecoveryRequired);
        }
        if self.disposed.load(Ordering::Acquire) {
            let mut owner = self.owner.lock().unwrap();
            *owner = ManagementCommandOwner::StartFailed(ManagementStartError::ChannelClosed);
            drop(owner);
            completion.complete(ManagementCleanupOutcome::Clean);
            return Err(ManagementStartError::ChannelClosed);
        }
        {
            // Same soft refusal as the default-production path: the drained
            // owner is already gone, so publish StartFailed(ChannelClosed) and
            // let the watchdog retry after the budget window rolls over instead
            // of latching RecoveryRequired (which only an operator can clear).
            let mut budget = self.resurrect.lock().unwrap();
            if !budget.take_attempt(Instant::now()) {
                drop(budget);
                let mut owner = self.owner.lock().unwrap();
                *owner = ManagementCommandOwner::StartFailed(ManagementStartError::ChannelClosed);
                drop(owner);
                completion.complete(ManagementCleanupOutcome::Clean);
                return Err(ManagementStartError::ChannelClosed);
            }
        }
        #[cfg(test)]
        let candidate = {
            if let Some(overrider) = self.rebuild_override.lock().unwrap().clone() {
                overrider()
            } else {
                let app = app.ok_or(ManagementStartError::ChannelClosed)?;
                ManagementChildManager::start_selected(app, selection)
            }
        };
        #[cfg(not(test))]
        let candidate = {
            let app = app.ok_or(ManagementStartError::ChannelClosed)?;
            ManagementChildManager::start_selected(app, selection)
        };
        let settled = settle_candidate_start(candidate, commit_ready);

        // Phase 3: re-take the lock to publish the terminal owner.
        self.publish_replacement(settled, published_key, &completion)
    }

    /// Phase 1 of a self-hosted replacement: under the owner lock, either
    /// fast-path a reusable child (`Ok(None)`), coalesce behind an in-flight
    /// replacement (`Err`), or publish Replacing and return the previous owner
    /// for the caller to drain (`Ok(Some(previous))`). Claiming leadership also
    /// moves the respawn mode latch to the requested lineage, so any
    /// StartFailed(ChannelClosed) this owner later degrades into is attributed
    /// to the self-hosted mode and never lazily resurrected as default
    /// production.
    fn claim_replacement(
        &self,
        desired_key: &ManagementLaunchKey,
        reuse_ready_child: bool,
        completion: &Arc<ManagementDrainCompletion>,
    ) -> Result<Option<ManagementCommandOwner>, ManagementStartError> {
        let mut owner = self.owner.lock().unwrap();
        if self.disposed.load(Ordering::Acquire) {
            return Err(ManagementStartError::ChannelClosed);
        }
        if reuse_ready_child
            && matches!(
                &*owner,
                ManagementCommandOwner::Ready {
                    launch_key,
                    manager,
                } if launch_key == desired_key && manager.is_reusable_after_observation()
            )
        {
            return Ok(None);
        }
        self.artifacts.clear();
        let previous = std::mem::replace(
            &mut *owner,
            ManagementCommandOwner::Replacing(completion.clone()),
        );
        match previous {
            ManagementCommandOwner::Replacing(previous) => {
                // Another replacement owns this epoch. Wait for it (outside
                // the lock) and never spawn a competing child.
                drop(owner);
                let cleanup = previous.wait();
                completion.complete(cleanup);
                Err(if cleanup == ManagementCleanupOutcome::RecoveryRequired {
                    ManagementStartError::RecoveryRequired
                } else {
                    ManagementStartError::ChannelClosed
                })
            }
            leader => {
                self.allow_default_production_respawn.store(
                    *desired_key == ManagementLaunchKey::DefaultProduction,
                    Ordering::Release,
                );
                Ok(Some(leader))
            }
        }
    }

    /// Phase 3 of a self-hosted replacement: re-take the owner lock and publish
    /// the terminal owner. Re-validates the disposed fence: a shutdown that
    /// raced the spawn must drain the freshly started child instead of
    /// publishing a live Ready owner.
    fn publish_replacement(
        &self,
        settled: Result<ManagementChildManager, ManagementStartError>,
        published_key: ManagementLaunchKey,
        completion: &Arc<ManagementDrainCompletion>,
    ) -> Result<(), ManagementStartError> {
        let mut owner = self.owner.lock().unwrap();
        if self.disposed.load(Ordering::Acquire) {
            if let Ok(manager) = settled {
                let cleanup = manager.dispose();
                drop(owner);
                completion.complete(cleanup);
                return Err(ManagementStartError::ChannelClosed);
            }
            *owner = ManagementCommandOwner::StartFailed(ManagementStartError::ChannelClosed);
            drop(owner);
            completion.complete(ManagementCleanupOutcome::Clean);
            return Err(ManagementStartError::ChannelClosed);
        }
        match settled {
            Ok(manager) => {
                self.allow_default_production_respawn.store(
                    published_key == ManagementLaunchKey::DefaultProduction,
                    Ordering::Release,
                );
                *owner = ManagementCommandOwner::Ready {
                    launch_key: published_key,
                    manager,
                };
                drop(owner);
                completion.complete(ManagementCleanupOutcome::Clean);
                Ok(())
            }
            Err(error) => {
                *owner = ManagementCommandOwner::StartFailed(error);
                drop(owner);
                completion.complete(if error == ManagementStartError::RecoveryRequired {
                    ManagementCleanupOutcome::RecoveryRequired
                } else {
                    ManagementCleanupOutcome::Clean
                });
                Err(error)
            }
        }
    }

    /// Mark a known-dead self-hosted management owner as a recoverable
    /// StartFailed(ChannelClosed) WITHOUT touching the process-level `disposed`
    /// latch. Used by the config-replacement drain when the connector stop
    /// fails: the old child is already unusable, but calling the terminal
    /// dispose() would set `disposed=true` and permanently brick every later
    /// call, replace and watchdog restart until the Dashboard restarts. The
    /// next Start Center / watchdog replace then rebuilds from StartFailed.
    /// No-op (and harmless) when the owner is already gone or being replaced.
    pub(crate) fn abandon_self_hosted_owner_after_failed_stop(
        &self,
        expected_launch_key: &ManagementLaunchKey,
    ) {
        if self.disposed.load(Ordering::Acquire) {
            return;
        }
        let mut owner = self.owner.lock().unwrap();
        if self.disposed.load(Ordering::Acquire) {
            return;
        }
        match &*owner {
            ManagementCommandOwner::Ready { launch_key, .. }
                if launch_key == expected_launch_key =>
            {
                // The abandoned owner keeps its lineage: a self-hosted owner
                // degraded to StartFailed(ChannelClosed) here must be rebuilt
                // by Start Center / the watchdog, never lazily as production.
                self.allow_default_production_respawn.store(
                    *expected_launch_key == ManagementLaunchKey::DefaultProduction,
                    Ordering::Release,
                );
                let completion = Arc::new(ManagementDrainCompletion::pending());
                let previous = std::mem::replace(
                    &mut *owner,
                    ManagementCommandOwner::Replacing(completion.clone()),
                );
                drop(owner);
                let cleanup = drain_command_owner(previous);
                let mut owner = self.owner.lock().unwrap();
                // A ChannelClosed start failure is recoverable by the next
                // replace; RecoveryRequired is preserved fail-closed.
                let failure = if cleanup == ManagementCleanupOutcome::RecoveryRequired {
                    ManagementStartError::RecoveryRequired
                } else {
                    ManagementStartError::ChannelClosed
                };
                *owner = ManagementCommandOwner::StartFailed(failure);
                drop(owner);
                completion.complete(if cleanup == ManagementCleanupOutcome::RecoveryRequired {
                    ManagementCleanupOutcome::RecoveryRequired
                } else {
                    ManagementCleanupOutcome::Clean
                });
            }
            _ => {}
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

#[tauri::command]
pub(crate) async fn mobile_relay_v2_restart_management_service(
    app: tauri::AppHandle,
    state: State<'_, Arc<MobileRelayV2ManagementCommandState>>,
) -> Result<(), String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        state.reset_recovery();
        if state.allow_default_production_respawn.load(Ordering::Acquire) {
            state.lazy_respawn_default_production().map_err(|e| {
                format!("Failed to restart default production management service: {:?}", e)
            })
        } else {
            let prepared = super::self_hosted_deployment::prepare_relay_v2_self_hosted_management_prerequisites()?
                .ok_or_else(|| "Relay v2 self-hosted management configuration disappeared".to_string())?;
            let selection = prepared.selection();
            let steady_key = selection.steady_launch_key();
            let _binding = prepared.management_binding()?;
            state
                .restart_self_hosted(&app, selection, move || prepared.commit_ready())
                .map_err(|e| {
                    format!("Failed to restart self-hosted management service: {:?}", e)
                })?;
            let _ = state.ensure_self_hosted_connector_start_accepted(&steady_key);
            Ok(())
        }
    })
    .await
    .map_err(|e| format!("Restart management service task failed: {e}"))?
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
                serde_json::Value::String(label) if valid_device_label(label).is_ok() => {
                    Some(label.clone())
                }
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
                .filter(|grant_id| valid_identifier(grant_id).is_ok())
                .ok_or_else(invalid_argument_error)?;
            Ok(ManagementInput::RevokeClientGrant {
                grant_id: grant_id.to_string(),
            })
        }
    }
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

fn projection_connector_failed_retryable(result: &serde_json::Value) -> Option<bool> {
    result
        .get("connector")
        .and_then(serde_json::Value::as_object)
        .and_then(|connector| {
            if connector.get("status").and_then(serde_json::Value::as_str) == Some("failed") {
                connector.get("retryable").and_then(serde_json::Value::as_bool)
            } else {
                None
            }
        })
}

fn management_error_is_transport(error: &ManagementError) -> bool {
    error.code == CHANNEL_CLOSED_CODE
        || error.code == SUPERSEDED_CODE
        || error.code == RECOVERY_REQUIRED_CODE
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
    fn projection_failure_drains_owner_without_fencing_explicit_recovery() {
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
        let mut response: serde_json::Value =
            serde_json::from_str(exchange["responseFrame"].as_str().unwrap()).unwrap();
        response["result"]["enrollment"]["review"]["enrollment"]["expiresAtMs"] =
            serde_json::json!(8_000_000_000_000_u64);
        let response = serde_json::to_string(&response).unwrap();
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
        assert!(!state.disposed.load(Ordering::Acquire));
        assert!(matches!(
            &*state.shutdown.lock().unwrap(),
            ManagementShutdown::Live
        ));
        assert!(matches!(
            &*state.owner.lock().unwrap(),
            ManagementCommandOwner::StartFailed(ManagementStartError::ChannelClosed)
        ));
        assert_eq!(
            state.call(MobileRelayV2ManagementOperation::Status),
            Err(channel_closed_error())
        );
    }

    #[cfg(unix)]
    fn resurrect_live_script() -> String {
        // A complete registered-connector projection (the start_connector golden
        // shape is accepted on status calls too). The request id is a literal
        // placeholder rewritten per-request with sed so decode_response's
        // request-id + operation correlation matches.
        let registered = serde_json::json!({
            "status": "registered",
            "acknowledgement": "host.registered",
            "hostId": "mac-admin",
            "connectorId": "connector-one",
            "negotiatedCapabilityIntersection":
                super::super::management_protocol_v2::REQUIRED_CAPABILITIES,
        });
        let mut frame: serde_json::Value = serde_json::from_str(
            &command_regression_projection_response([0u8; 16], registered),
        )
        .unwrap();
        frame["requestId"] = serde_json::json!("RIDPLACEHOLDER");
        let frame = serde_json::to_string(&frame).unwrap();
        assert!(!frame.contains('\''));
        format!(
            "printf '%s\\n' '{{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}}'; while IFS= read -r request; do rid=$(printf '%s' \"$request\" | sed -n 's/.*\"requestId\":\"\\([^\"]*\\)\".*/\\1/p'); printf '%s\\n' '{frame}' | sed \"s/RIDPLACEHOLDER/$rid/\"; done"
        )
    }

    #[cfg(unix)]
    #[test]
    fn default_production_owner_lazily_resurrects_a_poisoned_child_on_the_next_call() {
        // The first child reads the request but never answers; on the response
        // timeout it drains gracefully (stdin closes, the blocking read hits
        // EOF, the script exits 0) — the slow-but-healthy case the owner can
        // replace without operator recovery.
        let dead_script = "printf '%s\\n' '{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}'; while IFS= read -r request; do :; done".to_string();
        let dead =
            ManagementChildManager::start_v2_command_regression_script(dead_script, [70u8; 16])
                .expect("dead child starts");
        let state = Arc::new(MobileRelayV2ManagementCommandState::from_start(Ok(dead)));
        let spawns = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        {
            let spawns = spawns.clone();
            let live_script = resurrect_live_script();
            state.set_rebuild_override(move || {
                spawns.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                ManagementChildManager::start_v2_command_regression_script_with_request_ids(
                    live_script.clone(),
                    vec![[71u8; 16], [72u8; 16]],
                )
            });
        }

        // First call misses its response deadline; the call path lazily
        // rebuilds the owner (this call may surface the closed error).
        let _ = state.call(MobileRelayV2ManagementOperation::Status);
        // The next call uses the resurrected child and must succeed.
        let after = state
            .call(MobileRelayV2ManagementOperation::Status)
            .expect("resurrected owner answers status");
        assert!(after.ok, "resurrected child returns ok: {after:?}");
        assert_eq!(
            spawns.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "exactly one rebuild spawn occurred"
        );
        assert!(!state.disposed.load(Ordering::Acquire));
    }

    #[cfg(unix)]
    #[test]
    fn concurrent_callers_coalesce_onto_a_single_lazy_resurrection() {
        use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

        let dead_script = "printf '%s\\n' '{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}'; while IFS= read -r request; do :; done".to_string();
        let dead =
            ManagementChildManager::start_v2_command_regression_script(dead_script, [80u8; 16])
                .expect("dead child starts");
        let state = Arc::new(MobileRelayV2ManagementCommandState::from_start(Ok(dead)));

        let spawns = Arc::new(AtomicUsize::new(0));
        {
            let spawns = spawns.clone();
            let live_script = resurrect_live_script();
            state.set_rebuild_override(move || {
                // Hold the spawn briefly so concurrent callers observe the
                // Replacing owner and coalesce; exactly one factory runs.
                std::thread::sleep(Duration::from_millis(50));
                spawns.fetch_add(1, AtomicOrdering::SeqCst);
                let ids: Vec<[u8; 16]> = (81..96u8).map(|byte| [byte; 16]).collect();
                ManagementChildManager::start_v2_command_regression_script_with_request_ids(
                    live_script.clone(),
                    ids,
                )
            });
        }

        let mut handles = Vec::new();
        for _ in 0..4 {
            let state = state.clone();
            handles.push(std::thread::spawn(move || {
                state.call(MobileRelayV2ManagementOperation::Status)
            }));
        }
        for handle in handles {
            let _ = handle.join().unwrap();
        }
        assert_eq!(
            spawns.load(AtomicOrdering::SeqCst),
            1,
            "concurrent callers must coalesce onto one spawn"
        );
    }

    #[cfg(unix)]
    #[test]
    fn failed_stop_drain_abandons_owner_recoverably_without_the_disposed_latch() {
        // A live owner whose connector stop fails is abandoned by the config
        // replacement drain. It must NOT latch the process-level disposed fence
        // (which permanently bricks every later call and watchdog restart until
        // Dashboard restart); the owner instead becomes a recoverable
        // StartFailed(ChannelClosed) that the next replace rebuilds.
        let manager = ManagementChildManager::start_v2_command_regression_script(
            "printf '%s\\n' '{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}'; while IFS= read -r request; do exit 90; done".to_string(),
            [90u8; 16],
        )
        .expect("owner starts");
        let state = MobileRelayV2ManagementCommandState::from_start(Ok(manager));
        assert!(!state.disposed.load(Ordering::Acquire));

        state.abandon_self_hosted_owner_after_failed_stop(&ManagementLaunchKey::DefaultProduction);

        // The process-level disposed latch must remain clear so the watchdog /
        // Start Center replace path is still allowed to rebuild.
        assert!(!state.disposed.load(Ordering::Acquire));
        // The owner is a recoverable start failure, NOT RecoveryRequired (which
        // the replace path treats as terminal).
        assert!(matches!(
            &*state.owner.lock().unwrap(),
            ManagementCommandOwner::StartFailed(ManagementStartError::ChannelClosed)
        ));
        assert!(matches!(
            &*state.shutdown.lock().unwrap(),
            ManagementShutdown::Live
        ));
    }

    #[cfg(unix)]
    fn self_hosted_test_launch_key() -> ManagementLaunchKey {
        let identity = super::super::management_child::ManagementPreparedFileIdentity {
            device: 1,
            inode: 2,
            length: 3,
            mode: 0o600,
            uid: 501,
            links: 1,
            sha256: [9; 32],
        };
        ManagementLaunchKey::SelfHostedDarwinArm64 {
            account_home: std::path::PathBuf::from("/Users/test"),
            credential_https_ca_input: std::path::PathBuf::from("/Users/test/issuer-ca.pem"),
            carrier_wss_ca_input: std::path::PathBuf::from("/Users/test/carrier-ca.pem"),
            credential_https_ca_identity: identity.clone(),
            carrier_wss_ca_identity: identity,
            profile_lineage: "00112233445566778899aabbccddeeff".to_string(),
            provision_profile_input: None,
            bootstrap_secret_input: None,
            bootstrap_secret_mode: None,
        }
    }

    #[cfg(unix)]
    #[test]
    fn self_hosted_start_failed_channel_closed_never_spawns_default_production() {
        // Review C014(b)/D034: StartFailed(ChannelClosed) carries no launch key
        // and is reachable in BOTH modes (projection-failure drain and the
        // failed-stop abandon path). The old lazy_respawn owner match admitted
        // that arm unconditionally, so a later NON-connector management call
        // (status/enrollment — routed with launch_key=None) on a drained
        // self-hosted owner spawned a DefaultProduction child and published
        // production shipping-root enrollment/QR data. The state-level mode
        // latch must reject that: a self-hosted-constructed state never lazily
        // respawns; the connector watchdog / Start Center rebuild it instead.
        let state = Arc::new(
            MobileRelayV2ManagementCommandState::from_start_with_artifacts(
                Err(ManagementStartError::ChannelClosed),
                self_hosted_test_launch_key(),
                EnrollmentArtifactRegistry::disabled(),
            ),
        );
        assert!(
            !state
                .allow_default_production_respawn
                .load(Ordering::Acquire),
            "self-hosted construction must disable default-production respawn"
        );
        let spawns = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        {
            let spawns = spawns.clone();
            let live_script = resurrect_live_script();
            state.set_rebuild_override(move || {
                spawns.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                ManagementChildManager::start_v2_command_regression_script_with_request_ids(
                    live_script.clone(),
                    vec![[75u8; 16], [76u8; 16]],
                )
            });
        }

        // A non-connector call against the StartFailed self-hosted owner must
        // surface channel closed without ever running the spawn factory.
        let first = state.call(MobileRelayV2ManagementOperation::Status);
        assert!(
            first.is_err(),
            "StartFailed self-hosted call stays closed: {first:?}"
        );
        assert_eq!(
            first.unwrap_err().code,
            CHANNEL_CLOSED_CODE,
            "surfaces a retryable channel-closed error, not a wrong-mode owner"
        );
        assert_eq!(
            spawns.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "no default-production spawn may happen for a self-hosted owner"
        );
        // The owner must NOT have been republished as Ready{DefaultProduction}.
        match &*state.owner.lock().unwrap() {
            ManagementCommandOwner::Ready { launch_key, .. } => {
                assert_ne!(
                    *launch_key,
                    ManagementLaunchKey::DefaultProduction,
                    "self-hosted fault must never publish a DefaultProduction owner"
                );
            }
            ManagementCommandOwner::StartFailed(_) => {}
            ManagementCommandOwner::Replacing(_) => {}
        }
        // A second call still never spawns and still fails closed.
        let second = state.call(MobileRelayV2ManagementOperation::CreateEnrollment);
        assert!(second.is_err());
        assert_eq!(
            spawns.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "retry must still not spawn a default-production child"
        );
    }

    #[cfg(unix)]
    #[test]
    fn self_hosted_owner_abandoned_after_failed_stop_never_spawns_default_production() {
        // Same mode gate, but reached via the C015 failed-stop abandon path
        // (which explicitly sets StartFailed(ChannelClosed) on a self-hosted
        // owner whose connector stop failed during a config drain).
        let manager = ManagementChildManager::start_v2_command_regression_script(
            "printf '%s\\n' '{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}'; while IFS= read -r request; do exit 91; done".to_string(),
            [91u8; 16],
        )
        .expect("owner starts");
        let launch_key = self_hosted_test_launch_key();
        let state = Arc::new(
            MobileRelayV2ManagementCommandState::from_start_with_artifacts(
                Ok(manager),
                launch_key.clone(),
                EnrollmentArtifactRegistry::disabled(),
            ),
        );
        let spawns = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        {
            let spawns = spawns.clone();
            let live_script = resurrect_live_script();
            state.set_rebuild_override(move || {
                spawns.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                ManagementChildManager::start_v2_command_regression_script_with_request_ids(
                    live_script.clone(),
                    vec![[92u8; 16], [93u8; 16]],
                )
            });
        }

        state.abandon_self_hosted_owner_after_failed_stop(&launch_key);
        assert!(matches!(
            &*state.owner.lock().unwrap(),
            ManagementCommandOwner::StartFailed(ManagementStartError::ChannelClosed)
        ));

        // A non-connector call against the abandoned self-hosted owner must
        // surface channel closed without ever running the spawn factory.
        let result = state.call(MobileRelayV2ManagementOperation::CreateEnrollment);
        assert!(
            result.is_err(),
            "abandoned self-hosted call stays closed: {result:?}"
        );
        assert_eq!(
            spawns.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "failed-stop abandon must not be resurrected as default production"
        );
        assert!(matches!(
            &*state.owner.lock().unwrap(),
            ManagementCommandOwner::StartFailed(ManagementStartError::ChannelClosed)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn default_state_switched_to_self_hosted_in_app_never_lazily_respawns_production() {
        // Rereview C014(b)/D034: the management state is a singleton that the
        // Dashboard constructs in DEFAULT production when no self-hosted config
        // exists yet (lib.rs start()). The user's first in-app Save + Deploy +
        // Start Center then calls restart_self_hosted on that SAME state, which
        // publishes Ready{SelfHosted}. A construction-time latch stays "true"
        // across that switch, so when the self-hosted owner later degrades to
        // StartFailed(ChannelClosed) (projection failure, or the C015
        // failed-stop abandon), the next non-connector call would lazily spawn
        // a DefaultProduction child and hand out production-root enrollment/QR
        // data. The latch must follow the owner lineage set at replacement.
        let default_manager = ManagementChildManager::start_v2_command_regression_script(
            "printf '%s\\n' '{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}'; while IFS= read -r request; do exit 94; done".to_string(),
            [94u8; 16],
        )
        .expect("default owner starts");
        let state = Arc::new(MobileRelayV2ManagementCommandState::from_start(Ok(
            default_manager,
        )));
        assert!(
            state
                .allow_default_production_respawn
                .load(Ordering::Acquire),
            "default-production construction enables lazy respawn"
        );
        let spawns = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        {
            let spawns = spawns.clone();
            let live_script = resurrect_live_script();
            state.set_rebuild_override(move || {
                spawns.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                ManagementChildManager::start_v2_command_regression_script_with_request_ids(
                    live_script.clone(),
                    vec![[95u8; 16], [96u8; 16]],
                )
            });
        }

        // In-app switch: drive the same claim/publish phases restart_self_hosted
        // uses (the spawn itself needs a Tauri AppHandle, so the test supplies
        // the settled self-hosted child directly).
        let self_hosted_key = self_hosted_test_launch_key();
        let completion = Arc::new(ManagementDrainCompletion::pending());
        let previous = state
            .claim_replacement(&self_hosted_key, false, &completion)
            .expect("claims leadership")
            .expect("default owner is replaced, not reused");
        assert_eq!(
            drain_command_owner(previous),
            ManagementCleanupOutcome::Clean
        );
        let self_hosted_manager = ManagementChildManager::start_v2_command_regression_script(
            "printf '%s\\n' '{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}'; while IFS= read -r request; do exit 97; done".to_string(),
            [97u8; 16],
        )
        .expect("self-hosted owner starts");
        state
            .publish_replacement(
                Ok(self_hosted_manager),
                self_hosted_key.clone(),
                &completion,
            )
            .expect("publishes the self-hosted owner");
        assert!(matches!(
            &*state.owner.lock().unwrap(),
            ManagementCommandOwner::Ready { launch_key, .. } if *launch_key == self_hosted_key
        ));
        assert!(
            !state
                .allow_default_production_respawn
                .load(Ordering::Acquire),
            "switching the singleton to self-hosted must disable lazy production respawn"
        );

        // Degrade the self-hosted owner the way a failed config-drain stop does.
        state.abandon_self_hosted_owner_after_failed_stop(&self_hosted_key);
        assert!(matches!(
            &*state.owner.lock().unwrap(),
            ManagementCommandOwner::StartFailed(ManagementStartError::ChannelClosed)
        ));

        // Non-connector calls (status / QR enrollment) are routed with
        // launch_key=None: they must fail closed, never spawn production.
        for operation in [
            MobileRelayV2ManagementOperation::Status,
            MobileRelayV2ManagementOperation::CreateEnrollment,
        ] {
            let result = state.call(operation);
            assert!(result.is_err(), "{operation:?} stays closed: {result:?}");
            assert_eq!(result.unwrap_err().code, CHANNEL_CLOSED_CODE);
        }
        assert_eq!(
            spawns.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "a self-hosted lineage must never be resurrected as default production"
        );
        assert!(matches!(
            &*state.owner.lock().unwrap(),
            ManagementCommandOwner::StartFailed(ManagementStartError::ChannelClosed)
        ));
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
    fn command_regression_error_response(request_bytes: [u8; 16], code: &str) -> String {
        let (message, retryable) = match code {
            "UNAVAILABLE" => ("Relay v2 management is unavailable", false),
            "NOT_READY" => ("Relay v2 management is not ready", false),
            "BUSY" => ("Relay v2 management is busy", true),
            "OPERATION_FAILED" => ("Relay v2 management operation failed", false),
            _ => panic!("unsupported code for test error response: {code}"),
        };
        serde_json::to_string(&serde_json::json!({
            "protocolVersion": 2,
            "requestId": command_regression_request_id(request_bytes),
            "ok": false,
            "result": null,
            "error": {
                "code": code,
                "message": message,
                "retryable": retryable,
            }
        }))
        .unwrap()
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

    #[cfg(unix)]
    fn self_hosted_test_selection() -> ManagementChildSelection {
        let identity = super::super::management_child::ManagementPreparedFileIdentity {
            device: 1,
            inode: 2,
            length: 3,
            mode: 0o600,
            uid: 501,
            links: 1,
            sha256: [9; 32],
        };
        ManagementChildSelection::SelfHostedDarwinArm64 {
            account_home: std::path::PathBuf::from("/Users/test"),
            credential_https_ca_input: std::path::PathBuf::from("/Users/test/issuer-ca.pem"),
            carrier_wss_ca_input: std::path::PathBuf::from("/Users/test/carrier-ca.pem"),
            credential_https_ca_identity: identity.clone(),
            carrier_wss_ca_identity: identity,
            profile_lineage: "00112233445566778899aabbccddeeff".to_string(),
            provision_profile_input: None,
            bootstrap_secret_input: None,
            bootstrap_secret_mode: None,
        }
    }

    #[cfg(unix)]
    #[test]
    fn sigkill_post_handshake_respawns_and_returns_to_ready() {
        // (a) Post-handshake child killed by SIGKILL (`kill -9 $$`) -> watchdog/rebuild
        // respawns on next tick, spawn count increments by 1, and state returns to Ready.
        let sigkill_script = "printf '%s\\n' '{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}'; kill -9 $$".to_string();
        let manager =
            ManagementChildManager::start_v2_command_regression_script(sigkill_script, [101u8; 16])
                .expect("child starts");
        let selection = self_hosted_test_selection();
        let self_hosted_key = selection.steady_launch_key();
        let state = Arc::new(
            MobileRelayV2ManagementCommandState::from_start_with_artifacts(
                Ok(manager),
                self_hosted_key.clone(),
                EnrollmentArtifactRegistry::disabled(),
            ),
        );
        let spawns = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        {
            let spawns = spawns.clone();
            let live_script = resurrect_live_script();
            state.set_rebuild_override(move || {
                spawns.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                ManagementChildManager::start_v2_command_regression_script_with_request_ids(
                    live_script.clone(),
                    vec![[102u8; 16], [103u8; 16]],
                )
            });
        }

        // Allow child to process SIGKILL
        std::thread::sleep(Duration::from_millis(50));

        // Rebuild via restart_self_hosted (watchdog reconcile path)
        let rebuild = state.restart_self_hosted_for_test(selection, || Ok(()));
        assert!(rebuild.is_ok(), "rebuild must succeed: {rebuild:?}");
        assert_eq!(
            spawns.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "spawn count must be 1"
        );
        assert!(matches!(
            &*state.owner.lock().unwrap(),
            ManagementCommandOwner::Ready { launch_key, .. } if *launch_key == self_hosted_key
        ));
    }

    #[cfg(unix)]
    #[test]
    fn four_consecutive_signal_deaths_within_60s_pause_until_window_rolls_over() {
        // (b) 4 consecutive signal deaths within 60s -> the 4th attempt exhausts the
        // RespawnBudget and is refused (no spawn) until the window rolls over;
        let sigkill_script = "printf '%s\\n' '{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}'; kill -9 $$".to_string();
        let manager = ManagementChildManager::start_v2_command_regression_script(
            sigkill_script.clone(),
            [110u8; 16],
        )
        .expect("child starts");
        let selection = self_hosted_test_selection();
        let self_hosted_key = selection.steady_launch_key();
        let state = Arc::new(
            MobileRelayV2ManagementCommandState::from_start_with_artifacts(
                Ok(manager),
                self_hosted_key.clone(),
                EnrollmentArtifactRegistry::disabled(),
            ),
        );
        let spawns = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        {
            let spawns = spawns.clone();
            let script = sigkill_script.clone();
            state.set_rebuild_override(move || {
                let count = spawns.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                ManagementChildManager::start_v2_command_regression_script(
                    script.clone(),
                    [(111 + count) as u8; 16],
                )
            });
        }

        std::thread::sleep(Duration::from_millis(50));

        // Attempt 1: succeeds (spawn 1)
        let r1 = state.restart_self_hosted_for_test(selection.clone(), || Ok(()));
        assert!(r1.is_ok(), "attempt 1 succeeds: {r1:?}");
        assert_eq!(spawns.load(std::sync::atomic::Ordering::SeqCst), 1);
        std::thread::sleep(Duration::from_millis(50));

        // Attempt 2: succeeds (spawn 2)
        let r2 = state.restart_self_hosted_for_test(selection.clone(), || Ok(()));
        assert!(r2.is_ok(), "attempt 2 succeeds: {r2:?}");
        assert_eq!(spawns.load(std::sync::atomic::Ordering::SeqCst), 2);
        std::thread::sleep(Duration::from_millis(50));

        // Attempt 3: succeeds (spawn 3)
        let r3 = state.restart_self_hosted_for_test(selection.clone(), || Ok(()));
        assert!(r3.is_ok(), "attempt 3 succeeds: {r3:?}");
        assert_eq!(spawns.load(std::sync::atomic::Ordering::SeqCst), 3);
        std::thread::sleep(Duration::from_millis(50));

        // Attempt 4: budget exhausted. Must NOT spawn, and must NOT latch
        // RecoveryRequired either: an exhausted budget is a soft refusal that
        // the watchdog retries after the 60s window rolls over. Latching here
        // would turn a transient crash burst (upgrade, OOM killer, a flaky
        // devbox link) into an outage only an operator click can end — the
        // very failure mode this package exists to remove.
        let r4 = state.restart_self_hosted_for_test(selection.clone(), || Ok(()));
        assert_eq!(r4.err(), Some(ManagementStartError::ChannelClosed));
        assert_eq!(
            spawns.load(std::sync::atomic::Ordering::SeqCst),
            3,
            "must not spawn when budget is exhausted"
        );
        assert!(matches!(
            &*state.owner.lock().unwrap(),
            ManagementCommandOwner::StartFailed(ManagementStartError::ChannelClosed)
        ));
        // Calls fail with CHANNEL_CLOSED (retryable), not CELL_RECOVERY_REQUIRED.
        let call_res = state.call(MobileRelayV2ManagementOperation::Status);
        assert_eq!(call_res.unwrap_err().code, CHANNEL_CLOSED_CODE);

        // Still inside the window: a retry is refused again without spawning.
        let r4b = state.restart_self_hosted_for_test(selection.clone(), || Ok(()));
        assert_eq!(r4b.err(), Some(ManagementStartError::ChannelClosed));
        assert_eq!(spawns.load(std::sync::atomic::Ordering::SeqCst), 3);

        // Once the 60s window has elapsed the watchdog's next reconcile rebuilds
        // without any operator action.
        state.age_respawn_budget_for_test(RESURRECT_COOLDOWN);
        let r5 = state.restart_self_hosted_for_test(selection.clone(), || Ok(()));
        assert!(r5.is_ok(), "budget window rollover allows restart: {r5:?}");
        assert_eq!(spawns.load(std::sync::atomic::Ordering::SeqCst), 4);

        // Operator reset still works as an immediate override of the window.
        // (Let each replacement child reach its post-handshake death before the
        // next restart drains it, as the earlier attempts do.)
        std::thread::sleep(Duration::from_millis(50));
        let r5b = state.restart_self_hosted_for_test(selection.clone(), || Ok(()));
        assert!(r5b.is_ok(), "attempt 2 of the new window succeeds: {r5b:?}");
        std::thread::sleep(Duration::from_millis(50));
        let r5c = state.restart_self_hosted_for_test(selection.clone(), || Ok(()));
        assert!(r5c.is_ok(), "attempt 3 of the new window succeeds: {r5c:?}");
        std::thread::sleep(Duration::from_millis(50));
        let refused = state.restart_self_hosted_for_test(selection.clone(), || Ok(()));
        assert_eq!(refused.err(), Some(ManagementStartError::ChannelClosed));
        let before = spawns.load(std::sync::atomic::Ordering::SeqCst);
        state.reset_recovery();
        let r6 = state.restart_self_hosted_for_test(selection, || Ok(()));
        assert!(r6.is_ok(), "operator reset allows restart: {r6:?}");
        assert_eq!(spawns.load(std::sync::atomic::Ordering::SeqCst), before + 1);
    }

    #[cfg(unix)]
    #[test]
    fn active_stop_exited_child_does_not_rebuild() {
        // (c) Actively stopped child exits -> does NOT rebuild.
        let script = "printf '%s\\n' '{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}'; while IFS= read -r request; do exit 0; done".to_string();
        let manager =
            ManagementChildManager::start_v2_command_regression_script(script, [120u8; 16])
                .expect("child starts");
        let state = Arc::new(MobileRelayV2ManagementCommandState::from_start(Ok(manager)));
        let spawns = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        {
            let spawns = spawns.clone();
            let live_script = resurrect_live_script();
            state.set_rebuild_override(move || {
                spawns.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                ManagementChildManager::start_v2_command_regression_script_with_request_ids(
                    live_script.clone(),
                    vec![[121u8; 16], [122u8; 16]],
                )
            });
        }

        // Active stop / disposal
        state.dispose();
        assert!(state.disposed.load(Ordering::Acquire));

        // Calls fail closed with CHANNEL_CLOSED and never respawn
        let result = state.call(MobileRelayV2ManagementOperation::Status);
        assert_eq!(result.unwrap_err().code, CHANNEL_CLOSED_CODE);
        assert_eq!(
            spawns.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "disposed state must never respawn"
        );
    }

    #[cfg(unix)]
    #[test]
    fn self_hosted_owner_sigkill_rebuilds_self_hosted_never_production() {
        // (d) Self-hosted owner killed by SIGKILL -> rebuilds self-hosted, never production.
        let sigkill_script = "printf '%s\\n' '{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}'; kill -9 $$".to_string();
        let manager =
            ManagementChildManager::start_v2_command_regression_script(sigkill_script, [130u8; 16])
                .expect("child starts");
        let selection = self_hosted_test_selection();
        let self_hosted_key = selection.steady_launch_key();
        let state = Arc::new(
            MobileRelayV2ManagementCommandState::from_start_with_artifacts(
                Ok(manager),
                self_hosted_key.clone(),
                EnrollmentArtifactRegistry::disabled(),
            ),
        );
        assert!(
            !state
                .allow_default_production_respawn
                .load(Ordering::Acquire),
            "self-hosted must not allow default production respawn"
        );
        let spawns = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        {
            let spawns = spawns.clone();
            let live_script = resurrect_live_script();
            state.set_rebuild_override(move || {
                spawns.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                ManagementChildManager::start_v2_command_regression_script_with_request_ids(
                    live_script.clone(),
                    vec![[131u8; 16], [132u8; 16]],
                )
            });
        }

        std::thread::sleep(Duration::from_millis(50));

        // Non-connector call must not lazily spawn default production
        let call_res = state.call(MobileRelayV2ManagementOperation::Status);
        assert_eq!(call_res.unwrap_err().code, CHANNEL_CLOSED_CODE);
        assert_eq!(
            spawns.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "must not spawn production on status call"
        );

        // Rebuilding rebuilds the self-hosted owner
        let rebuild = state.restart_self_hosted_for_test(selection, || Ok(()));
        assert!(rebuild.is_ok(), "self-hosted rebuild succeeds: {rebuild:?}");
        assert_eq!(
            spawns.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "self-hosted spawn count is 1"
        );
        assert!(matches!(
            &*state.owner.lock().unwrap(),
            ManagementCommandOwner::Ready { launch_key, .. } if *launch_key == self_hosted_key
        ));
        assert!(
            !state
                .allow_default_production_respawn
                .load(Ordering::Acquire),
            "lineage remains self-hosted"
        );
    }

    #[cfg(unix)]
    #[test]
    fn supervisor_killed_manager_is_not_latched_and_self_hosted_restart_succeeds() {
        // 1.0.28 cleanup policy: a RUST-INITIATED kill (here the response
        // deadline path against a child that never answers and ignores stdin
        // EOF) classifies Clean once the child is reaped. A command state
        // built from that manager must NOT be latched
        // StartFailed(RecoveryRequired) — restart_self_hosted must drain the
        // dead owner and spawn the replacement without an operator reset or an
        // app relaunch (the post-1789094879 incident: exactly that in-memory
        // latch refused restarts for four hours).
        let hang_script = "printf '%s\\n' '{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}'; while :; do IFS= read -r request || sleep 1; done".to_string();
        let manager = ManagementChildManager::start_v2_command_regression_script_with_timeouts(
            hang_script,
            vec![[140u8; 16]],
            Duration::from_secs(2),
            Duration::from_millis(200),
            Duration::from_secs(30),
            Duration::from_millis(100),
        )
        .expect("never-answering child starts");

        // Force the supervisor-side kill: the missed deadline drains, the
        // close budget is exceeded, and the child is SIGKILLed — Clean.
        let killed = manager.request(ManagementOperation::Status).unwrap();
        assert_eq!(killed.error.unwrap().code, CHANNEL_CLOSED_CODE);

        let selection = self_hosted_test_selection();
        let self_hosted_key = selection.steady_launch_key();
        let state = Arc::new(
            MobileRelayV2ManagementCommandState::from_start_with_artifacts(
                Ok(manager),
                self_hosted_key.clone(),
                EnrollmentArtifactRegistry::disabled(),
            ),
        );
        let spawns = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        {
            let spawns = spawns.clone();
            let live_script = resurrect_live_script();
            state.set_rebuild_override(move || {
                spawns.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                ManagementChildManager::start_v2_command_regression_script_with_request_ids(
                    live_script.clone(),
                    vec![[141u8; 16], [142u8; 16]],
                )
            });
        }

        let restart = state.restart_self_hosted_for_test(selection, || Ok(()));
        assert!(
            restart.is_ok(),
            "a Clean supervisor kill must not require operator recovery: {restart:?}"
        );
        assert_eq!(spawns.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(matches!(
            &*state.owner.lock().unwrap(),
            ManagementCommandOwner::Ready { launch_key, .. } if *launch_key == self_hosted_key
        ));
    }

    #[cfg(unix)]
    #[test]
    fn retryable_connector_failure_is_owned_by_the_child_not_a_rebuild() {
        let ids = [[151; 16], [152; 16], [153; 16], [154; 16]];
        let failed_retryable = serde_json::json!({"status": "failed", "retryable": true});
        let r0 = command_regression_projection_response(ids[0], failed_retryable.clone());
        let r1 = command_regression_projection_response(ids[1], failed_retryable.clone());
        let r2 = command_regression_projection_response(ids[2], failed_retryable.clone());
        let r3 = command_regression_projection_response(ids[3], failed_retryable);
        let request_ids = ids.map(command_regression_request_id);
        let script = format!(
            "printf '%s\\n' '{{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}}'; while IFS= read -r request; do case \"$request\" in *'\"operation\":\"start_connector\"'*) exit 75 ;; *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *) exit 76 ;; esac; done",
            request_ids[0], r0,
            request_ids[1], r1,
            request_ids[2], r2,
            request_ids[3], r3,
        );
        let manager = ManagementChildManager::start_v2_command_regression_script_with_request_ids(
            script,
            ids.to_vec(),
        )
        .unwrap();
        let state = Arc::new(MobileRelayV2ManagementCommandState::from_start(Ok(manager)));
        let spawns = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        {
            let spawns = spawns.clone();
            state.set_rebuild_override(move || {
                spawns.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Err(ManagementStartError::ChannelClosed)
            });
        }

        assert_eq!(
            state.ensure_self_hosted_connector_start_accepted(
                &ManagementLaunchKey::DefaultProduction
            ),
            Ok(super::super::management_protocol_v2::BaseConnectorReadiness::Retrying)
        );
        assert_eq!(
            state.restore_self_hosted_connector_desired_state(
                &ManagementLaunchKey::DefaultProduction
            ),
            Ok(())
        );
        assert_eq!(
            state.classify_self_hosted_connector_repair(
                &ManagementLaunchKey::DefaultProduction
            ),
            SelfHostedConnectorRepair::ChildRetrying
        );
        assert_eq!(spawns.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert!(matches!(
            &*state.owner.lock().unwrap(),
            ManagementCommandOwner::Ready { .. }
        ));
        assert!(
            state
                .call(MobileRelayV2ManagementOperation::Status)
                .unwrap()
                .ok
        );
    }

    #[cfg(unix)]
    #[test]
    fn ensure_reinspects_after_a_refused_start() {
        // Part 1: Status stopped -> start_connector failure -> Status failed{retryable:true} => Ok(Retrying)
        let ids1 = [[161; 16], [162; 16], [163; 16]];
        let stopped1 = command_regression_projection_response(
            ids1[0],
            serde_json::json!({"status": "stopped"}),
        );
        let start_fail1 = command_regression_error_response(ids1[1], "UNAVAILABLE");
        let retrying1 = command_regression_projection_response(
            ids1[2],
            serde_json::json!({"status": "failed", "retryable": true}),
        );
        let req_ids1 = ids1.map(command_regression_request_id);
        let script1 = format!(
            "printf '%s\\n' '{{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}}'; while IFS= read -r request; do case \"$request\" in *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *) exit 81 ;; esac; done",
            req_ids1[0], stopped1,
            req_ids1[1], start_fail1,
            req_ids1[2], retrying1,
        );
        let manager1 = ManagementChildManager::start_v2_command_regression_script_with_request_ids(
            script1,
            ids1.to_vec(),
        )
        .unwrap();
        let state1 = MobileRelayV2ManagementCommandState::from_start(Ok(manager1));
        assert_eq!(
            state1.ensure_self_hosted_connector_start_accepted(
                &ManagementLaunchKey::DefaultProduction
            ),
            Ok(super::super::management_protocol_v2::BaseConnectorReadiness::Retrying)
        );

        // Part 2: Status stopped -> start failure -> Status still stopped => Err whose code is start failure's code
        let ids2 = [[164; 16], [165; 16], [166; 16]];
        let stopped2a = command_regression_projection_response(
            ids2[0],
            serde_json::json!({"status": "stopped"}),
        );
        let start_fail2 = command_regression_error_response(ids2[1], "UNAVAILABLE");
        let stopped2b = command_regression_projection_response(
            ids2[2],
            serde_json::json!({"status": "stopped"}),
        );
        let req_ids2 = ids2.map(command_regression_request_id);
        let script2 = format!(
            "printf '%s\\n' '{{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}}'; while IFS= read -r request; do case \"$request\" in *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *) exit 82 ;; esac; done",
            req_ids2[0], stopped2a,
            req_ids2[1], start_fail2,
            req_ids2[2], stopped2b,
        );
        let manager2 = ManagementChildManager::start_v2_command_regression_script_with_request_ids(
            script2,
            ids2.to_vec(),
        )
        .unwrap();
        let state2 = MobileRelayV2ManagementCommandState::from_start(Ok(manager2));
        let err2 = state2
            .ensure_self_hosted_connector_start_accepted(&ManagementLaunchKey::DefaultProduction)
            .unwrap_err();
        assert_eq!(err2.code, "UNAVAILABLE");
    }

    #[cfg(unix)]
    #[test]
    fn nonretryable_failed_cut_requires_rebuild() {
        // Four scripted frames: ensure() spends the first three (preflight
        // Status failed{retryable:false}, a refused start, and the single
        // re-inspection Status that stays non-retryable) and classify()'s
        // non-transport error arm then spends the fourth — the asserted
        // RebuildRequired must come from the terminal cut itself, not from a
        // dead re-inspection channel.
        let ids = [[171; 16], [172; 16], [173; 16], [174; 16]];
        let cut = serde_json::json!({"status": "failed", "retryable": false});
        let r0 = command_regression_projection_response(ids[0], cut.clone());
        let r1 = command_regression_error_response(ids[1], "OPERATION_FAILED");
        let r2 = command_regression_projection_response(ids[2], cut.clone());
        let r3 = command_regression_projection_response(ids[3], cut);
        let req_ids = ids.map(command_regression_request_id);
        let script = format!(
            "printf '%s\\n' '{{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}}'; while IFS= read -r request; do case \"$request\" in *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *) exit 83 ;; esac; done",
            req_ids[0], r0,
            req_ids[1], r1,
            req_ids[2], r2,
            req_ids[3], r3,
        );
        let manager = ManagementChildManager::start_v2_command_regression_script_with_request_ids(
            script,
            ids.to_vec(),
        )
        .unwrap();
        let state = MobileRelayV2ManagementCommandState::from_start(Ok(manager));
        assert_eq!(
            state.classify_self_hosted_connector_repair(&ManagementLaunchKey::DefaultProduction),
            SelfHostedConnectorRepair::RebuildRequired
        );
    }

    #[cfg(unix)]
    #[test]
    fn superseded_cut_requires_rebuild() {
        // Same four-frame sequence as the non-retryable case: classify() must
        // read "superseded" itself on its dedicated Status re-inspection rather
        // than inferring RebuildRequired from a channel that already died.
        let ids = [[175; 16], [176; 16], [177; 16], [178; 16]];
        let cut = serde_json::json!({"status": "superseded"});
        let r0 = command_regression_projection_response(ids[0], cut.clone());
        let r1 = command_regression_error_response(ids[1], "OPERATION_FAILED");
        let r2 = command_regression_projection_response(ids[2], cut.clone());
        let r3 = command_regression_projection_response(ids[3], cut);
        let req_ids = ids.map(command_regression_request_id);
        let script = format!(
            "printf '%s\\n' '{{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}}'; while IFS= read -r request; do case \"$request\" in *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *) exit 84 ;; esac; done",
            req_ids[0], r0,
            req_ids[1], r1,
            req_ids[2], r2,
            req_ids[3], r3,
        );
        let manager = ManagementChildManager::start_v2_command_regression_script_with_request_ids(
            script,
            ids.to_vec(),
        )
        .unwrap();
        let state = MobileRelayV2ManagementCommandState::from_start(Ok(manager));
        assert_eq!(
            state.classify_self_hosted_connector_repair(&ManagementLaunchKey::DefaultProduction),
            SelfHostedConnectorRepair::RebuildRequired
        );
    }

    #[cfg(unix)]
    #[test]
    fn dead_channel_requires_rebuild() {
        let script = "printf '%s\\n' '{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}'; kill -9 $$".to_string();
        let manager =
            ManagementChildManager::start_v2_command_regression_script(script, [177u8; 16])
                .unwrap();
        let state = MobileRelayV2ManagementCommandState::from_start(Ok(manager));
        assert_eq!(
            state.classify_self_hosted_connector_repair(&ManagementLaunchKey::DefaultProduction),
            SelfHostedConnectorRepair::RebuildRequired
        );
    }

    /// Build a four-frame scripted child that forces
    /// classify_self_hosted_connector_repair into its non-transport error arm
    /// and then answers classify's OWN dedicated Status re-inspection with
    /// `final_cut`. Frames 0-2 drive ensure() into a non-transport Err exactly
    /// like ensure_reinspects_after_a_refused_start Part 2: preflight Status
    /// "stopped" (projects NotReady), a refused start_connector (UNAVAILABLE),
    /// and a re-inspection Status still "stopped"; frame 3 is the raw status
    /// string table under test.
    #[cfg(unix)]
    fn classify_reinspection_state(
        ids: &[[u8; 16]],
        final_cut: &serde_json::Value,
        exit_code: u8,
    ) -> MobileRelayV2ManagementCommandState {
        assert_eq!(ids.len(), 4, "the fixture spends exactly four request frames");
        let stopped = serde_json::json!({"status": "stopped"});
        let r0 = command_regression_projection_response(ids[0], stopped.clone());
        let r1 = command_regression_error_response(ids[1], "UNAVAILABLE");
        let r2 = command_regression_projection_response(ids[2], stopped);
        let r3 = command_regression_projection_response(ids[3], final_cut.clone());
        let request_ids: Vec<String> =
            ids.iter().map(|id| command_regression_request_id(*id)).collect();
        let script = format!(
            "printf '%s\\n' '{{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}}'; while IFS= read -r request; do case \"$request\" in *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *) exit {exit_code} ;; esac; done",
            request_ids[0], r0,
            request_ids[1], r1,
            request_ids[2], r2,
            request_ids[3], r3,
        );
        let manager = ManagementChildManager::start_v2_command_regression_script_with_request_ids(
            script,
            ids.to_vec(),
        )
        .unwrap();
        MobileRelayV2ManagementCommandState::from_start(Ok(manager))
    }

    #[cfg(unix)]
    #[test]
    fn classify_reinspection_table_defers_every_alive_cut_after_a_refused_start() {
        // Each row drives ensure() into a non-transport Err and then pins ONE
        // raw status string in classify()'s dedicated re-inspection. This table
        // deliberately diverges from projection_base_connector_readiness (raw
        // "stopped" is NotReady in ensure but ChildRetrying here), so a typo or
        // a reorder of the string patterns must flip these assertions instead
        // of being swallowed by the wildcard arm. Frames use fully-decodable
        // wire shapes: the typed protocol rejects a bare "starting"/registered
        // cut as an invalid frame (which terminalizes the child) — a genuine
        // child can never emit one.
        let alive_cuts: [(&str, serde_json::Value); 5] = [
            (
                "failed retryable",
                serde_json::json!({"status": "failed", "retryable": true}),
            ),
            ("stopped", serde_json::json!({"status": "stopped"})),
            (
                "starting without a host id",
                serde_json::json!({"status": "starting", "hostId": null}),
            ),
            (
                "registered complete",
                serde_json::json!({
                    "status": "registered",
                    "acknowledgement": "host.registered",
                    "hostId": "mac-admin",
                    "connectorId": "connector-one",
                    "negotiatedCapabilityIntersection":
                        super::super::management_protocol_v2::REQUIRED_CAPABILITIES,
                }),
            ),
            (
                "registered incomplete",
                serde_json::json!({
                    "status": "registered_incomplete",
                    "acknowledgement": "host.registered",
                    "hostId": "mac-admin",
                    "connectorId": "connector-one",
                    "negotiatedCapabilityIntersection": [],
                }),
            ),
        ];
        for (index, (label, cut)) in alive_cuts.iter().enumerate() {
            let base = 201u8 + u8::try_from(index * 4).unwrap();
            let ids: Vec<[u8; 16]> = (0..4).map(|offset| [base + offset; 16]).collect();
            let state = classify_reinspection_state(&ids, cut, 91 + u8::try_from(index).unwrap());
            assert_eq!(
                state.classify_self_hosted_connector_repair(
                    &ManagementLaunchKey::DefaultProduction
                ),
                SelfHostedConnectorRepair::ChildRetrying,
                "{label} observed after a refused start must defer to the alive child's own retry"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn classify_reinspection_unknown_status_requires_rebuild() {
        // A connector status outside the typed wire vocabulary cannot decode
        // (internally tagged connector enum + deny_unknown_fields): the invalid
        // frame terminalizes the child and classify's transport path rebuilds
        // rather than deferring for 600s. This pins the raw table's defensive
        // wildcard — an out-of-vocabulary status must never read as
        // ChildRetrying.
        let ids: Vec<[u8; 16]> = (221..225u8).map(|byte| [byte; 16]).collect();
        let state = classify_reinspection_state(
            &ids,
            &serde_json::json!({"status": "capabilities_handshaking"}),
            96,
        );
        assert_eq!(
            state.classify_self_hosted_connector_repair(&ManagementLaunchKey::DefaultProduction),
            SelfHostedConnectorRepair::RebuildRequired
        );
    }

    #[cfg(unix)]
    #[test]
    fn exhausted_budget_never_drains_a_live_child() {
        let live_script = resurrect_live_script();
        let manager = ManagementChildManager::start_v2_command_regression_script_with_request_ids(
            live_script.clone(),
            vec![[181u8; 16], [182u8; 16]],
        )
        .unwrap();
        let selection = self_hosted_test_selection();
        let self_hosted_key = selection.steady_launch_key();
        let state = Arc::new(MobileRelayV2ManagementCommandState::from_start_with_artifacts(
            Ok(manager),
            self_hosted_key.clone(),
            EnrollmentArtifactRegistry::disabled(),
        ));
        let spawns = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        {
            let spawns = spawns.clone();
            let live_script = live_script.clone();
            state.set_rebuild_override(move || {
                let count = spawns.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                ManagementChildManager::start_v2_command_regression_script_with_request_ids(
                    live_script.clone(),
                    vec![[(190 + count) as u8; 16], [(191 + count) as u8; 16]],
                )
            });
        }

        // Exhaust the budget without killing the child
        state.exhaust_respawn_budget_for_test();

        // Rebuilding a live child when budget is exhausted must be refused without draining
        let refused = state.restart_self_hosted_for_test(selection.clone(), || Ok(()));
        assert_eq!(refused.err(), Some(ManagementStartError::ChannelClosed));
        assert_eq!(spawns.load(std::sync::atomic::Ordering::SeqCst), 0);

        // Owner must still be Ready with the live child
        assert!(matches!(
            &*state.owner.lock().unwrap(),
            ManagementCommandOwner::Ready { launch_key, .. } if *launch_key == self_hosted_key
        ));

        // Status call still succeeds against the undrained child
        assert!(
            state
                .call_with_input_for_launch_key(
                    MobileRelayV2ManagementOperation::Status,
                    ManagementInput::None,
                    Some(&self_hosted_key)
                )
                .unwrap()
                .ok
        );

        // The same-key reuse fast path never spawns (and never drains), so it
        // stays exempt from the budget peek while the budget is exhausted.
        let reused = state.replace_self_hosted_with_reuse(
            None,
            selection.clone(),
            true,
            || Ok(()),
        );
        assert!(
            reused.is_ok(),
            "same-key reuse must stay allowed under an exhausted budget: {reused:?}"
        );
        assert_eq!(spawns.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert!(matches!(
            &*state.owner.lock().unwrap(),
            ManagementCommandOwner::Ready { launch_key, .. } if *launch_key == self_hosted_key
        ));

        // After the window rolls over, restart succeeds and spawns replacement
        state.age_respawn_budget_for_test(RESURRECT_COOLDOWN);
        let restarted = state.restart_self_hosted_for_test(selection, || Ok(()));
        assert!(restarted.is_ok(), "restart succeeds after cooldown: {restarted:?}");
        assert_eq!(spawns.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[cfg(unix)]
    #[test]
    fn wait_for_readiness_polls_through_retrying() {
        use super::super::management_protocol_v2::BaseConnectorReadiness;

        // Part 1: Status answers failed{retryable:true} twice, then registered => Ok(())
        let ids1 = [[183; 16], [184; 16], [185; 16]];
        let retrying_connector = serde_json::json!({"status": "failed", "retryable": true});
        let registered_connector = serde_json::json!({
            "status": "registered",
            "acknowledgement": "host.registered",
            "hostId": "mac-admin",
            "connectorId": "connector-one",
            "negotiatedCapabilityIntersection":
                super::super::management_protocol_v2::REQUIRED_CAPABILITIES,
        });
        let r0 = command_regression_projection_response(ids1[0], retrying_connector.clone());
        let r1 = command_regression_projection_response(ids1[1], retrying_connector.clone());
        let r2 = command_regression_projection_response(ids1[2], registered_connector);
        let req_ids1 = ids1.map(command_regression_request_id);
        let script1 = format!(
            "printf '%s\\n' '{{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}}'; while IFS= read -r request; do case \"$request\" in *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *'{}'*) printf '%s\\n' '{}' ;; *) exit 88 ;; esac; done",
            req_ids1[0], r0,
            req_ids1[1], r1,
            req_ids1[2], r2,
        );
        let manager1 = ManagementChildManager::start_v2_command_regression_script_with_request_ids(
            script1,
            ids1.to_vec(),
        )
        .unwrap();
        let state1 = MobileRelayV2ManagementCommandState::from_start(Ok(manager1));
        assert_eq!(
            state1.wait_for_self_hosted_connector_base_readiness_with_bounds(
                &ManagementLaunchKey::DefaultProduction,
                BaseConnectorReadiness::Retrying,
                Duration::from_secs(5),
                Duration::from_millis(10),
            ),
            Ok(())
        );

        // Part 2: every Status keeps reporting failed{retryable:true} until the
        // deadline, so the wait must surface connector_retrying_error(). The
        // script rewrites a placeholder request id into every answer, which
        // keeps the result independent of how many polls fit in the deadline.
        let mut retrying_frame: serde_json::Value = serde_json::from_str(
            &command_regression_projection_response([0u8; 16], retrying_connector.clone()),
        )
        .unwrap();
        retrying_frame["requestId"] = serde_json::json!("RIDPLACEHOLDER");
        let retrying_frame = serde_json::to_string(&retrying_frame).unwrap();
        assert!(!retrying_frame.contains('\''));
        let ids2: Vec<[u8; 16]> = (186..194u8).map(|byte| [byte; 16]).collect();
        let script2 = format!(
            "printf '%s\\n' '{{\"contract\":\"tmux-worktree-dashboard-relay-v2-management-ipc\",\"protocolVersion\":2,\"runtimeVersion\":\"1.2.3\"}}'; while IFS= read -r request; do rid=$(printf '%s' \"$request\" | sed -n 's/.*\"requestId\":\"\\([^\"]*\\)\".*/\\1/p'); printf '%s\\n' '{retrying_frame}' | sed \"s/RIDPLACEHOLDER/$rid/\"; done"
        );
        let manager2 = ManagementChildManager::start_v2_command_regression_script_with_request_ids(
            script2,
            ids2,
        )
        .unwrap();
        let state2 = MobileRelayV2ManagementCommandState::from_start(Ok(manager2));
        assert_eq!(
            state2.wait_for_self_hosted_connector_base_readiness_with_bounds(
                &ManagementLaunchKey::DefaultProduction,
                BaseConnectorReadiness::Retrying,
                Duration::from_millis(50),
                Duration::from_millis(10),
            ),
            Err(MobileRelayV2ManagementCommandState::connector_retrying_error())
        );
    }

    #[test]
    fn respawn_budget_can_attempt_peeks_without_mutating_and_respects_rollover() {
        let mut budget = RespawnBudget::fresh();
        let t0 = Instant::now();

        // Fresh: can_attempt is true, no mutation
        assert!(budget.can_attempt(t0));
        assert_eq!(budget.attempts, 0);
        assert!(budget.window_started.is_none());

        // Take 3 attempts
        assert!(budget.take_attempt(t0));
        assert_eq!(budget.attempts, 1);
        assert!(budget.can_attempt(t0));

        assert!(budget.take_attempt(t0));
        assert_eq!(budget.attempts, 2);
        assert!(budget.can_attempt(t0));

        assert!(budget.take_attempt(t0));
        assert_eq!(budget.attempts, 3);

        // Budget exhausted: can_attempt is false, does not mutate
        let t1 = t0 + Duration::from_secs(10);
        assert!(!budget.can_attempt(t1));
        assert_eq!(budget.attempts, 3);
        assert!(!budget.can_attempt(t1));
        assert_eq!(budget.attempts, 3);
        assert!(!budget.take_attempt(t1));

        // After cooldown: can_attempt is true without mutating
        let t2 = t0 + RESURRECT_COOLDOWN;
        assert!(budget.can_attempt(t2));
        assert_eq!(budget.attempts, 3);
        assert!(budget.can_attempt(t2));

        // take_attempt at t2 actually resets window and succeeds
        assert!(budget.take_attempt(t2));
        assert_eq!(budget.attempts, 1);
        assert_eq!(budget.window_started, Some(t2));
    }
}
