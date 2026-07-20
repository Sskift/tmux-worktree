use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::State;

use super::management_child::{
    ManagementCallError, ManagementChildManager, ManagementError, ManagementOperation,
    ManagementOutcome, ManagementStartError,
};

const UNAVAILABLE_CODE: &str = "UNAVAILABLE";
const UNAVAILABLE_MESSAGE: &str = "Relay v2 management is unavailable";
const CHANNEL_CLOSED_CODE: &str = "CHANNEL_CLOSED";
const CHANNEL_CLOSED_MESSAGE: &str = "Relay v2 management channel closed";
const SUPERSEDED_CODE: &str = "SUPERSEDED";
const SUPERSEDED_MESSAGE: &str = "Relay v2 management owner was superseded";

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
    Ready(ManagementChildManager),
    StartFailed(ManagementStartError),
}

pub(crate) struct MobileRelayV2ManagementCommandState {
    owner: ManagementCommandOwner,
    disposed: AtomicBool,
}

impl MobileRelayV2ManagementCommandState {
    pub(crate) fn start(app: &tauri::AppHandle) -> Self {
        Self::from_start(ManagementChildManager::start(app))
    }

    fn from_start(start: Result<ManagementChildManager, ManagementStartError>) -> Self {
        Self {
            owner: match start {
                Ok(manager) => ManagementCommandOwner::Ready(manager),
                Err(error) => ManagementCommandOwner::StartFailed(error),
            },
            disposed: AtomicBool::new(false),
        }
    }

    fn call(
        &self,
        operation: MobileRelayV2ManagementOperation,
    ) -> Result<ManagementOutcome, ManagementError> {
        if self.disposed.load(Ordering::Acquire) {
            return Err(channel_closed_error());
        }
        match &self.owner {
            ManagementCommandOwner::Ready(manager) => {
                manager.request(operation.into()).map_err(map_call_error)
            }
            ManagementCommandOwner::StartFailed(error) => Err(map_start_error(*error)),
        }
    }

    pub(crate) fn dispose(&self) {
        if self.disposed.swap(true, Ordering::AcqRel) {
            return;
        }
        if let ManagementCommandOwner::Ready(manager) = &self.owner {
            manager.dispose();
        }
    }
}

impl Drop for MobileRelayV2ManagementCommandState {
    fn drop(&mut self) {
        self.dispose();
    }
}

#[tauri::command]
pub(crate) async fn mobile_relay_v2_management_call(
    operation: MobileRelayV2ManagementOperation,
    state: State<'_, Arc<MobileRelayV2ManagementCommandState>>,
) -> Result<ManagementOutcome, ManagementError> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || state.call(operation))
        .await
        .map_err(|_| channel_closed_error())?
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

fn map_start_error(error: ManagementStartError) -> ManagementError {
    match error {
        ManagementStartError::Unavailable => unavailable_error(),
        ManagementStartError::ChannelClosed => channel_closed_error(),
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
}
