use serde::{Deserialize, Serialize};

use super::management_child::{ManagementInput, ManagementOperation};

pub(crate) const PROTOCOL_VERSION: u32 = 2;
pub(crate) const REQUEST_ID_PREFIX: &str = "dmgmt2.";

const MAX_IDENTIFIER_BYTES: usize = 128;
const MAX_CREDENTIAL_REFERENCE_BYTES: usize = 256;
const MAX_ENROLLMENT_CODE_BYTES: usize = 512;
const MAX_DEVICE_LABEL_BYTES: usize = 128;
const MAX_URL_BYTES: usize = 2_048;
const JS_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

const REQUIRED_CAPABILITIES: [&str; 6] = [
    "error.structured.v1",
    "command.ledger.v1",
    "command.query.v1",
    "snapshot.revision.v1",
    "event.sequence.v1",
    "terminal.stream.resume.v1",
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestFrame<'a> {
    protocol_version: u32,
    request_id: &'a str,
    operation: ManagementOperation,
    input: RequestInput<'a>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(untagged)]
enum RequestInput<'a> {
    None,
    CreateEnrollment {
        #[serde(rename = "deviceLabel")]
        device_label: Option<&'a str>,
    },
    RevokeClientGrant {
        #[serde(rename = "grantId")]
        grant_id: &'a str,
        reason: &'static str,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DashboardProjection {
    authority: ProjectionAuthority,
    host_credential: HostCredentialProjection,
    connector: ConnectorProjection,
    enrollment: EnrollmentProjection,
    known_client_grant: KnownClientGrantProjection,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProjectionAuthority {
    kind: String,
    reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
enum HostCredentialProjection {
    Missing,
    Ready {
        #[serde(rename = "credentialReference")]
        credential_reference: String,
        #[serde(rename = "expiresAtMs")]
        expires_at_ms: u64,
    },
    Failed {
        retryable: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
enum ConnectorProjection {
    Stopped,
    Starting {
        #[serde(rename = "hostId")]
        host_id: Option<String>,
    },
    Registered {
        #[serde(rename = "acknowledgement")]
        acknowledgement: String,
        #[serde(rename = "hostId")]
        host_id: String,
        #[serde(rename = "connectorId")]
        connector_id: String,
        #[serde(rename = "negotiatedCapabilityIntersection")]
        negotiated_capability_intersection: Vec<String>,
    },
    RegisteredIncomplete {
        #[serde(rename = "acknowledgement")]
        acknowledgement: String,
        #[serde(rename = "hostId")]
        host_id: String,
        #[serde(rename = "connectorId")]
        connector_id: String,
        #[serde(rename = "negotiatedCapabilityIntersection")]
        negotiated_capability_intersection: Vec<String>,
    },
    Failed {
        retryable: bool,
    },
    Superseded,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
enum EnrollmentProjection {
    Idle,
    Active {
        review: EnrollmentReview,
    },
    Expired {
        #[serde(rename = "enrollmentId")]
        enrollment_id: String,
        #[serde(rename = "expiredAtMs")]
        expired_at_ms: u64,
    },
    Failed {
        intent: EnrollmentIntent,
        retryable: bool,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum EnrollmentIntent {
    Create,
    Retry,
    Rebuild,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EnrollmentReview {
    enrollment: EnrollmentSecretProjection,
    display: EnrollmentDisplayProjection,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EnrollmentSecretProjection {
    enrollment_id: String,
    enrollment_code: String,
    expires_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EnrollmentDisplayProjection {
    issuer_url: String,
    relay_url: String,
    host_id: String,
    device_label: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
enum KnownClientGrantProjection {
    Unknown,
    Active {
        #[serde(rename = "grantId")]
        grant_id: String,
    },
    Revoked {
        #[serde(rename = "grantId")]
        grant_id: String,
        #[serde(rename = "revokedAtMs")]
        revoked_at_ms: u64,
        #[serde(rename = "alreadyRevoked")]
        already_revoked: bool,
    },
    Failed {
        #[serde(rename = "grantId")]
        grant_id: String,
        retryable: bool,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResponseFrame {
    protocol_version: u32,
    request_id: String,
    ok: bool,
    result: Option<DashboardProjection>,
    error: Option<WireError>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
struct WireError {
    code: String,
    message: String,
    retryable: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DecodedResponse {
    pub(crate) result: Option<DashboardProjection>,
    pub(crate) error: Option<DecodedError>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DecodedError {
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) retryable: bool,
}

pub(crate) fn encode_request(
    request_id: &str,
    operation: ManagementOperation,
    input: &ManagementInput,
) -> Result<Vec<u8>, ()> {
    let input = match (operation, input) {
        (
            ManagementOperation::Status
            | ManagementOperation::BootstrapHost
            | ManagementOperation::RefreshHost
            | ManagementOperation::StartConnector
            | ManagementOperation::StopConnector,
            ManagementInput::None,
        ) => RequestInput::None,
        (
            ManagementOperation::CreateEnrollment,
            ManagementInput::CreateEnrollment { device_label },
        ) => {
            if let Some(label) = device_label {
                valid_device_label(label)?;
            }
            RequestInput::CreateEnrollment {
                device_label: device_label.as_deref(),
            }
        }
        (
            ManagementOperation::RevokeClientGrant,
            ManagementInput::RevokeClientGrant { grant_id },
        ) => {
            valid_identifier(grant_id)?;
            RequestInput::RevokeClientGrant {
                grant_id,
                reason: "user_revoked",
            }
        }
        _ => return Err(()),
    };
    serde_json::to_vec(&RequestFrame {
        protocol_version: PROTOCOL_VERSION,
        request_id,
        operation,
        input,
    })
    .map_err(|_| ())
}

pub(crate) fn decode_response(
    payload: &[u8],
    expected_request_id: &str,
    operation: ManagementOperation,
) -> Result<DecodedResponse, ()> {
    let shape: serde_json::Value = serde_json::from_slice(payload).map_err(|_| ())?;
    validate_response_shape(&shape)?;
    let response: ResponseFrame = serde_json::from_slice(payload).map_err(|_| ())?;
    if response.protocol_version != PROTOCOL_VERSION
        || response.request_id.as_bytes() != expected_request_id.as_bytes()
    {
        return Err(());
    }
    match (response.ok, response.result, response.error) {
        (true, Some(result), None) => {
            validate_projection(&result, operation)?;
            Ok(DecodedResponse {
                result: Some(result),
                error: None,
            })
        }
        (false, None, Some(error)) => {
            validate_wire_error(&error)?;
            Ok(DecodedResponse {
                result: None,
                error: Some(DecodedError {
                    code: error.code,
                    message: error.message,
                    retryable: error.retryable,
                }),
            })
        }
        _ => Err(()),
    }
}

fn validate_response_shape(value: &serde_json::Value) -> Result<(), ()> {
    let root = exact_object(
        value,
        &["protocolVersion", "requestId", "ok", "result", "error"],
    )?;
    match (&root["result"], &root["error"]) {
        (serde_json::Value::Object(_), serde_json::Value::Null) => {
            let projection = exact_object(
                &root["result"],
                &[
                    "authority",
                    "hostCredential",
                    "connector",
                    "enrollment",
                    "knownClientGrant",
                ],
            )?;
            exact_object(&projection["authority"], &["kind", "reason"])?;
            validate_tagged_shape(
                &projection["hostCredential"],
                &[
                    ("missing", &[]),
                    ("ready", &["credentialReference", "expiresAtMs"]),
                    ("failed", &["retryable"]),
                ],
            )?;
            validate_tagged_shape(
                &projection["connector"],
                &[
                    ("stopped", &[]),
                    ("starting", &["hostId"]),
                    (
                        "registered",
                        &[
                            "acknowledgement",
                            "hostId",
                            "connectorId",
                            "negotiatedCapabilityIntersection",
                        ],
                    ),
                    (
                        "registered_incomplete",
                        &[
                            "acknowledgement",
                            "hostId",
                            "connectorId",
                            "negotiatedCapabilityIntersection",
                        ],
                    ),
                    ("failed", &["retryable"]),
                    ("superseded", &[]),
                ],
            )?;
            validate_enrollment_shape(&projection["enrollment"])?;
            validate_tagged_shape(
                &projection["knownClientGrant"],
                &[
                    ("unknown", &[]),
                    ("active", &["grantId"]),
                    ("revoked", &["grantId", "revokedAtMs", "alreadyRevoked"]),
                    ("failed", &["grantId", "retryable"]),
                ],
            )?;
            Ok(())
        }
        (serde_json::Value::Null, serde_json::Value::Object(_)) => {
            exact_object(&root["error"], &["code", "message", "retryable"])?;
            Ok(())
        }
        _ => Err(()),
    }
}

fn validate_enrollment_shape(value: &serde_json::Value) -> Result<(), ()> {
    let enrollment = value.as_object().ok_or(())?;
    let status = enrollment
        .get("status")
        .and_then(serde_json::Value::as_str)
        .ok_or(())?;
    match status {
        "idle" => {
            exact_object(value, &["status"])?;
        }
        "active" => {
            let enrollment = exact_object(value, &["status", "review"])?;
            let review = exact_object(&enrollment["review"], &["enrollment", "display"])?;
            exact_object(
                &review["enrollment"],
                &["enrollmentId", "enrollmentCode", "expiresAtMs"],
            )?;
            exact_object(
                &review["display"],
                &["issuerUrl", "relayUrl", "hostId", "deviceLabel"],
            )?;
        }
        "expired" => {
            exact_object(value, &["status", "enrollmentId", "expiredAtMs"])?;
        }
        "failed" => {
            exact_object(value, &["status", "intent", "retryable"])?;
        }
        _ => return Err(()),
    }
    Ok(())
}

fn validate_tagged_shape(
    value: &serde_json::Value,
    variants: &[(&str, &[&str])],
) -> Result<(), ()> {
    let object = value.as_object().ok_or(())?;
    let status = object
        .get("status")
        .and_then(serde_json::Value::as_str)
        .ok_or(())?;
    let fields = variants
        .iter()
        .find_map(|(candidate, fields)| (*candidate == status).then_some(*fields))
        .ok_or(())?;
    let mut keys = Vec::with_capacity(fields.len() + 1);
    keys.push("status");
    keys.extend_from_slice(fields);
    exact_object(value, &keys)?;
    Ok(())
}

fn exact_object<'a>(
    value: &'a serde_json::Value,
    keys: &[&str],
) -> Result<&'a serde_json::Map<String, serde_json::Value>, ()> {
    let object = value.as_object().ok_or(())?;
    if object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key)) {
        Ok(object)
    } else {
        Err(())
    }
}

fn validate_wire_error(error: &WireError) -> Result<(), ()> {
    let expected = match error.code.as_str() {
        "UNAVAILABLE" => ("Relay v2 management is unavailable", false),
        "INVALID_ARGUMENT" => ("Relay v2 management input is invalid", false),
        "NOT_READY" => ("Relay v2 management is not ready", false),
        "BUSY" => ("Relay v2 management is busy", true),
        "OPERATION_FAILED" => ("Relay v2 management operation failed", false),
        // These outcomes are owned by the Rust supervisor and may never be
        // supplied by child stdout.
        "CHANNEL_CLOSED" | "SUPERSEDED" => return Err(()),
        _ => return Err(()),
    };
    if error.message == expected.0 && error.retryable == expected.1 {
        Ok(())
    } else {
        Err(())
    }
}

fn validate_projection(
    projection: &DashboardProjection,
    operation: ManagementOperation,
) -> Result<(), ()> {
    if projection.authority.kind != "node" || projection.authority.reason.is_some() {
        return Err(());
    }

    match &projection.host_credential {
        HostCredentialProjection::Missing => {}
        HostCredentialProjection::Ready {
            credential_reference,
            expires_at_ms,
        } => {
            valid_bounded_opaque(credential_reference, MAX_CREDENTIAL_REFERENCE_BYTES)?;
            reject_credential_value(credential_reference)?;
            valid_timestamp(*expires_at_ms)?;
        }
        HostCredentialProjection::Failed { .. } => {}
    }

    let ready_host_id = match &projection.connector {
        ConnectorProjection::Stopped => None,
        ConnectorProjection::Starting { host_id } => {
            if let Some(host_id) = host_id {
                valid_identifier(host_id)?;
            }
            None
        }
        ConnectorProjection::Registered {
            acknowledgement,
            host_id,
            connector_id,
            negotiated_capability_intersection,
        } => {
            validate_registered_connector(
                acknowledgement,
                host_id,
                connector_id,
                negotiated_capability_intersection,
                true,
            )?;
            Some(host_id.as_str())
        }
        ConnectorProjection::RegisteredIncomplete {
            acknowledgement,
            host_id,
            connector_id,
            negotiated_capability_intersection,
        } => {
            validate_registered_connector(
                acknowledgement,
                host_id,
                connector_id,
                negotiated_capability_intersection,
                false,
            )?;
            None
        }
        ConnectorProjection::Failed { .. } | ConnectorProjection::Superseded => None,
    };

    if ready_host_id.is_some()
        && !matches!(
            projection.host_credential,
            HostCredentialProjection::Ready { .. }
        )
    {
        return Err(());
    }

    match &projection.enrollment {
        EnrollmentProjection::Idle => {}
        EnrollmentProjection::Active { review } => {
            let Some(host_id) = ready_host_id else {
                return Err(());
            };
            validate_enrollment_review(review, host_id)?;
        }
        EnrollmentProjection::Expired {
            enrollment_id,
            expired_at_ms,
        } => {
            valid_identifier(enrollment_id)?;
            valid_timestamp(*expired_at_ms)?;
        }
        EnrollmentProjection::Failed { .. } => {}
    }

    match &projection.known_client_grant {
        KnownClientGrantProjection::Unknown => {}
        KnownClientGrantProjection::Active { grant_id }
        | KnownClientGrantProjection::Failed { grant_id, .. } => valid_identifier(grant_id)?,
        KnownClientGrantProjection::Revoked {
            grant_id,
            revoked_at_ms,
            ..
        } => {
            valid_identifier(grant_id)?;
            valid_timestamp(*revoked_at_ms)?;
        }
    }

    if operation == ManagementOperation::RevokeClientGrant
        && !matches!(
            projection.known_client_grant,
            KnownClientGrantProjection::Revoked { .. }
        )
    {
        return Err(());
    }
    if operation == ManagementOperation::CreateEnrollment
        && !matches!(projection.enrollment, EnrollmentProjection::Active { .. })
    {
        return Err(());
    }
    Ok(())
}

fn validate_registered_connector(
    acknowledgement: &str,
    host_id: &str,
    connector_id: &str,
    capabilities: &[String],
    must_be_complete: bool,
) -> Result<(), ()> {
    if acknowledgement != "host.registered" {
        return Err(());
    }
    valid_identifier(host_id)?;
    valid_identifier(connector_id)?;
    if capabilities.len() > REQUIRED_CAPABILITIES.len() {
        return Err(());
    }
    let mut seen = [false; REQUIRED_CAPABILITIES.len()];
    for capability in capabilities {
        let Some(index) = REQUIRED_CAPABILITIES
            .iter()
            .position(|known| capability == known)
        else {
            return Err(());
        };
        if seen[index] {
            return Err(());
        }
        seen[index] = true;
    }
    if seen.iter().all(|present| *present) == must_be_complete {
        Ok(())
    } else {
        Err(())
    }
}

fn validate_enrollment_review(review: &EnrollmentReview, host_id: &str) -> Result<(), ()> {
    valid_identifier(&review.enrollment.enrollment_id)?;
    valid_timestamp(review.enrollment.expires_at_ms)?;
    valid_bounded_opaque(
        &review.enrollment.enrollment_code,
        MAX_ENROLLMENT_CODE_BYTES,
    )?;
    let Some(code_suffix) = review.enrollment.enrollment_code.strip_prefix("twenroll2.") else {
        return Err(());
    };
    if code_suffix.is_empty() {
        return Err(());
    }
    valid_issuer_url(&review.display.issuer_url)?;
    valid_relay_url(&review.display.relay_url)?;
    valid_identifier(&review.display.host_id)?;
    if review.display.host_id != host_id {
        return Err(());
    }
    if let Some(device_label) = &review.display.device_label {
        valid_device_label(device_label)?;
    }
    Ok(())
}

fn valid_timestamp(value: u64) -> Result<(), ()> {
    if value <= JS_MAX_SAFE_INTEGER {
        Ok(())
    } else {
        Err(())
    }
}

fn valid_identifier(value: &str) -> Result<(), ()> {
    valid_bounded_opaque(value, MAX_IDENTIFIER_BYTES)?;
    reject_credential_value(value)
}

fn valid_device_label(value: &str) -> Result<(), ()> {
    valid_bounded_opaque(value, MAX_DEVICE_LABEL_BYTES)?;
    reject_credential_value(value)
}

fn valid_bounded_opaque(value: &str, maximum_bytes: usize) -> Result<(), ()> {
    if value.is_empty()
        || value.len() > maximum_bytes
        || value.trim() != value
        || value.contains('\0')
        || value.contains('\r')
        || value.contains('\n')
    {
        Err(())
    } else {
        Ok(())
    }
}

fn reject_credential_value(value: &str) -> Result<(), ()> {
    let lower = value.to_ascii_lowercase();
    if ["twcap2.", "twref2.", "twenroll2.", "twhostboot2."]
        .iter()
        .any(|prefix| lower.contains(prefix))
    {
        Err(())
    } else {
        Ok(())
    }
}

fn valid_issuer_url(value: &str) -> Result<(), ()> {
    valid_management_url(value, "https", "/")
}

fn valid_relay_url(value: &str) -> Result<(), ()> {
    valid_management_url(value, "wss", "/client")
}

fn valid_management_url(value: &str, scheme: &str, required_path: &str) -> Result<(), ()> {
    if !value.is_ascii()
        || value.len() > MAX_URL_BYTES
        || value.trim() != value
        || value
            .as_bytes()
            .first()
            .into_iter()
            .chain(value.as_bytes().last())
            .any(|byte| *byte <= b' ' || *byte == 0x7f)
        || reject_credential_value(value).is_err()
        || ['\0', '\r', '\n']
            .iter()
            .any(|forbidden| value.contains(*forbidden))
    {
        return Err(());
    }
    let parsed = tauri::Url::parse(value).map_err(|_| ())?;
    let authority = value
        .strip_prefix(&format!("{scheme}://"))
        .and_then(|suffix| suffix.split('/').next())
        .ok_or(())?;
    if parsed.scheme() != scheme
        || parsed.host_str().is_none_or(str::is_empty)
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || authority.ends_with(':')
        || parsed.path() != required_path
    {
        return Err(());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const CASES: &str =
        include_str!("../../../../../contracts/dashboard-relay-v2-management/v2/cases.json");

    #[test]
    fn dashboard_management_v2_golden_exchanges_are_closed_and_valid() {
        let fixture: Value = serde_json::from_str(CASES).unwrap();
        for exchange in fixture["goldenExchanges"].as_array().unwrap() {
            let request_id = exchange["normalizedRequest"]["requestId"].as_str().unwrap();
            let operation = operation(exchange["operation"].as_str().unwrap());
            let input = input(&exchange["normalizedRequest"]["input"]);
            let mut encoded = encode_request(request_id, operation, &input).unwrap();
            encoded.push(b'\n');
            assert_eq!(
                encoded,
                exchange["requestFrame"].as_str().unwrap().as_bytes(),
                "{}",
                exchange["name"]
            );
            let response = exchange["responseFrame"]
                .as_str()
                .unwrap()
                .trim_end_matches('\n')
                .as_bytes();
            let decoded = decode_response(response, request_id, operation).unwrap();
            assert!(decoded.result.is_some(), "{}", exchange["name"]);
            assert!(decoded.error.is_none(), "{}", exchange["name"]);
        }
    }

    #[test]
    fn dashboard_management_v2_incomplete_registration_cannot_expose_enrollment() {
        let fixture: Value = serde_json::from_str(CASES).unwrap();
        let valid = &fixture["projectionCases"]["registeredIncomplete"];
        let valid_payload = serde_json::to_vec(valid).unwrap();
        decode_response(
            &valid_payload,
            "dmgmt2.AquZUdkZ9FXG7OEIfRHmjw",
            ManagementOperation::Status,
        )
        .unwrap();

        let invalid = &fixture["projectionCases"]["incompleteWithEnrollment"];
        let invalid_payload = serde_json::to_vec(invalid).unwrap();
        assert!(decode_response(
            &invalid_payload,
            "dmgmt2.AquZUdkZ9FXG7OEIfRHmjw",
            ManagementOperation::Status,
        )
        .is_err());
    }

    #[test]
    fn dashboard_management_v2_forbidden_or_unknown_response_fields_are_rejected() {
        let fixture: Value = serde_json::from_str(CASES).unwrap();
        for case in fixture["invalidResponseFrameCases"].as_array().unwrap() {
            assert!(
                decode_response(
                    case["frame"].as_str().unwrap().as_bytes(),
                    case["expectedRequestId"].as_str().unwrap(),
                    operation(case["operation"].as_str().unwrap()),
                )
                .is_err(),
                "{}",
                case["name"]
            );
        }
    }

    fn operation(value: &str) -> ManagementOperation {
        match value {
            "status" => ManagementOperation::Status,
            "bootstrap_host" => ManagementOperation::BootstrapHost,
            "refresh_host" => ManagementOperation::RefreshHost,
            "start_connector" => ManagementOperation::StartConnector,
            "stop_connector" => ManagementOperation::StopConnector,
            "create_enrollment" => ManagementOperation::CreateEnrollment,
            "revoke_client_grant" => ManagementOperation::RevokeClientGrant,
            _ => panic!("unknown operation"),
        }
    }

    fn input(value: &Value) -> ManagementInput {
        match value {
            Value::Null => ManagementInput::None,
            Value::Object(object) if object.contains_key("deviceLabel") => {
                ManagementInput::CreateEnrollment {
                    device_label: object["deviceLabel"].as_str().map(str::to_string),
                }
            }
            Value::Object(object) => ManagementInput::RevokeClientGrant {
                grant_id: object["grantId"].as_str().unwrap().to_string(),
            },
            _ => panic!("unknown input"),
        }
    }
}
