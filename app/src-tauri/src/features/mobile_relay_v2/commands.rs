use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Manager, State};

use super::enrollment_artifact::{EnrollmentArtifactRegistry, EnrollmentArtifactWindowClaim};
use super::management_child::{
    ManagementCallError, ManagementChildManager, ManagementError, ManagementInput,
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
    artifacts: EnrollmentArtifactRegistry,
    disposed: AtomicBool,
}

impl MobileRelayV2ManagementCommandState {
    pub(crate) fn start(app: &tauri::AppHandle) -> Self {
        let closer_app = app.clone();
        let artifacts = EnrollmentArtifactRegistry::new(move |label| {
            if let Some(window) = closer_app.get_webview_window(label) {
                let _ = window.destroy();
            }
        });
        Self::from_artifact_start(artifacts, || ManagementChildManager::start(app))
    }

    fn from_artifact_start<F>(
        artifacts: Result<EnrollmentArtifactRegistry, ()>,
        start_manager: F,
    ) -> Self
    where
        F: FnOnce() -> Result<ManagementChildManager, ManagementStartError>,
    {
        match artifacts {
            Ok(artifacts) => Self::from_start_with_artifacts(start_manager(), artifacts),
            Err(()) => Self::from_start_with_artifacts(
                Err(ManagementStartError::Unavailable),
                EnrollmentArtifactRegistry::disabled(),
            ),
        }
    }

    #[cfg(test)]
    fn from_start(start: Result<ManagementChildManager, ManagementStartError>) -> Self {
        Self::from_start_with_artifacts(start, EnrollmentArtifactRegistry::disabled())
    }

    fn from_start_with_artifacts(
        start: Result<ManagementChildManager, ManagementStartError>,
        artifacts: EnrollmentArtifactRegistry,
    ) -> Self {
        Self {
            owner: match start {
                Ok(manager) => ManagementCommandOwner::Ready(manager),
                Err(error) => ManagementCommandOwner::StartFailed(error),
            },
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
        if self.disposed.load(Ordering::Acquire) {
            return Err(channel_closed_error());
        }
        if operation == MobileRelayV2ManagementOperation::RefreshHost {
            self.artifacts.clear();
        }
        match &self.owner {
            ManagementCommandOwner::Ready(manager) => {
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
                            self.dispose();
                            return Err(channel_closed_error());
                        }
                    }
                }
                Ok(outcome)
            }
            ManagementCommandOwner::StartFailed(error) => Err(map_start_error(*error)),
        }
    }

    pub(crate) fn dispose(&self) {
        if self.disposed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.artifacts.close();
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
    input: serde_json::Value,
    state: State<'_, Arc<MobileRelayV2ManagementCommandState>>,
) -> Result<ManagementOutcome, ManagementError> {
    let input = decode_command_input(operation, input)?;
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || state.call_with_input(operation, input))
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
    fn artifact_owner_start_failure_is_permanently_unavailable_without_starting_the_child() {
        let unavailable = MobileRelayV2ManagementCommandState::from_artifact_start(Err(()), || {
            panic!("artifact failure must fence child startup")
        });
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
