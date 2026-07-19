import {
  MOBILE_RELAY_V2_REQUIRED_CAPABILITIES,
  type MobileRelayV1SharedSecretProfile,
  type MobileRelayV2DashboardState,
  type MobileRelayV2EnrollmentReview,
  type MobileRelayV2OperationFailure,
  type MobileRelayV2RequiredCapability,
} from "../../platform/domainTypes";
import {
  mobileRelayV2ConnectorReady,
  normalizeMobileRelayV2DashboardState,
  normalizeMobileRelayV2Connector,
  normalizeMobileRelayV2EnrollmentReview,
  relayV2MissingNegotiatedCapabilities,
  sanitizeMobileRelayV2DisplayMessage,
} from "../../platform/relayV2Domain";

export const RELAY_V2_REQUIRED_CAPABILITIES = MOBILE_RELAY_V2_REQUIRED_CAPABILITIES;

export type RelayV2RequiredCapability = MobileRelayV2RequiredCapability;
export type RelayV1SharedSecretProfile = MobileRelayV1SharedSecretProfile;
export type RelayV2EnrollmentReview = MobileRelayV2EnrollmentReview;
export type RelayV2EnrollmentState = MobileRelayV2DashboardState;

export type RelayV2EnrollmentEvent =
  | { type: "backendStateObserved"; state: RelayV2EnrollmentState }
  | { type: "backendObservationFailed"; failure: MobileRelayV2OperationFailure }
  | { type: "v1ProfileObserved"; sharedSecretConfigured: boolean }
  | { type: "v2CredentialReferenceObserved"; credentialReference: string | null }
  | { type: "hostCredentialOperationStarted"; operation: "bootstrap" | "refresh" }
  | { type: "hostCredentialOperationFailed"; error: string; retryable?: boolean }
  | { type: "hostRegistered"; hostId: string; connectorId: string }
  | { type: "hostRegistrationLost"; error?: string | null; retryable?: boolean }
  | { type: "connectorStarting" }
  | { type: "connectorStopped" }
  | { type: "connectorSuperseded"; error?: string | null }
  | { type: "capabilityIntersectionObserved"; capabilities: readonly string[] }
  | { type: "enrollmentCreateStarted"; intent?: "create" | "retry" | "rebuild" }
  | { type: "enrollmentCreated"; review: RelayV2EnrollmentReview }
  | {
      type: "enrollmentCreateFailed";
      error: string;
      intent?: "create" | "retry" | "rebuild";
      retryable?: boolean;
    }
  | { type: "enrollmentCleared" }
  | { type: "clientGrantObserved"; grantId: string }
  | { type: "clientGrantRevokeStarted"; grantId: string }
  | {
      type: "clientGrantRevoked";
      grantId: string;
      revokedAtMs: number;
      alreadyRevoked: boolean;
    }
  | { type: "clientGrantRevokeFailed"; grantId: string; error: string; retryable?: boolean };

export interface RelayV2EnrollmentView {
  adapterAvailable: boolean;
  previewOnly: boolean;
  ready: boolean;
  missingCapabilities: readonly RelayV2RequiredCapability[];
  readinessLabel: string;
  readinessDetail: string;
  v1CredentialLabel: string;
  v2CredentialLabel: string;
  hostCredentialAction: "bootstrap" | "refresh" | null;
  connectorAction: "start" | "stop" | "restart" | null;
  enrollmentAction: "create" | "retry" | "rebuild" | null;
  enrollmentActionDisabled: boolean;
  enrollmentActionLabel: string;
  grantRevokeDisabled: boolean;
  grantRevokeLabel: string;
  error: string | null;
  review: RelayV2EnrollmentReview | null;
  qrPayload: string | null;
}

const NOT_READY_ERROR =
  "Relay v2 enrollment requires host.registered and all six required capabilities.";

export function createRelayV2EnrollmentState(
  sharedSecretConfigured = false,
): RelayV2EnrollmentState {
  return {
    authority: {
      kind: "unavailable",
      reason: "Relay v2 backend authority has not been observed.",
    },
    v1Profile: {
      protocolVersion: 1,
      credentialKind: "legacy_shared_secret",
      sharedSecretConfigured,
    },
    hostCredential: {
      protocolVersion: 2,
      credentialKind: "twcap2_grant",
      status: "missing",
      credentialReference: null,
      expiresAtMs: null,
      error: null,
      retryable: null,
    },
    connector: {
      status: "stopped",
      acknowledgement: null,
      hostId: null,
      connectorId: null,
      negotiatedCapabilityIntersection: [],
      exitCode: null,
      error: null,
      retryable: null,
    },
    enrollment: { status: "idle" },
    knownClientGrant: { status: "unknown" },
  };
}

export function relayV2MissingCapabilities(
  capabilityIntersection: readonly string[],
): RelayV2RequiredCapability[] {
  return relayV2MissingNegotiatedCapabilities(capabilityIntersection);
}

export function relayV2EnrollmentReady(state: RelayV2EnrollmentState): boolean {
  return state.authority.kind !== "unavailable"
    && mobileRelayV2ConnectorReady(state.connector);
}

export function relayV2EnrollmentReducer(
  state: RelayV2EnrollmentState,
  event: RelayV2EnrollmentEvent,
): RelayV2EnrollmentState {
  switch (event.type) {
    case "backendStateObserved":
      return event.state;
    case "backendObservationFailed": {
      const message = sanitizeMobileRelayV2DisplayMessage(
        event.failure.message,
        "Relay v2 status observation failed.",
      );
      const intent = state.enrollment.status === "creating"
        || state.enrollment.status === "failed"
        ? state.enrollment.intent
        : "create";
      return {
        ...state,
        authority: {
          kind: "unavailable",
          reason: `${message} Previously observed Relay v2 readiness was cleared.`,
        },
        connector: {
          status: "failed",
          acknowledgement: null,
          hostId: null,
          connectorId: null,
          negotiatedCapabilityIntersection: [],
          exitCode: null,
          error: message,
          retryable: event.failure.retryable,
        },
        enrollment: {
          status: "failed",
          intent,
          error: "Enrollment is hidden until authoritative Relay v2 status is restored.",
          retryable: event.failure.retryable,
        },
      };
    }
    case "v1ProfileObserved":
      return {
        ...state,
        v1Profile: {
          ...state.v1Profile,
          sharedSecretConfigured: event.sharedSecretConfigured,
        },
      };
    case "v2CredentialReferenceObserved":
      return normalizeMobileRelayV2DashboardState({
        ...state,
        hostCredential: {
          ...state.hostCredential,
          status: event.credentialReference ? "ready" : "missing",
          credentialReference: event.credentialReference,
          expiresAtMs: event.credentialReference ? state.hostCredential.expiresAtMs : null,
          error: null,
          retryable: null,
        },
      });
    case "hostCredentialOperationStarted":
      if (
        state.hostCredential.status === "bootstrapping"
        || state.hostCredential.status === "refreshing"
      ) return state;
      return {
        ...state,
        hostCredential: {
          ...state.hostCredential,
          status: event.operation === "bootstrap" ? "bootstrapping" : "refreshing",
          error: null,
          retryable: null,
        },
      };
    case "hostCredentialOperationFailed":
      return {
        ...state,
        hostCredential: {
          ...state.hostCredential,
          status: "failed",
          error: sanitizeMobileRelayV2DisplayMessage(
            event.error,
            "Relay v2 host credential operation failed.",
          ),
          retryable: event.retryable === true,
        },
      };
    case "hostRegistered":
      return {
        ...state,
        connector: normalizeMobileRelayV2Connector({
          status: "registered_incomplete",
          acknowledgement: "host.registered",
          hostId: event.hostId,
          connectorId: event.connectorId,
          negotiatedCapabilityIntersection:
            state.connector.negotiatedCapabilityIntersection,
          exitCode: null,
          error: null,
          retryable: null,
        }),
      };
    case "hostRegistrationLost":
      return {
        ...state,
        connector: event.error
          ? {
              status: "failed",
              acknowledgement: null,
              hostId: null,
              connectorId: null,
              negotiatedCapabilityIntersection: [],
              exitCode: null,
              error: sanitizeMobileRelayV2DisplayMessage(
                event.error,
                "Relay v2 connector failed.",
              ),
              retryable: event.retryable === true,
            }
          : {
              status: "stopped",
              acknowledgement: null,
              hostId: null,
              connectorId: null,
              negotiatedCapabilityIntersection: [],
              exitCode: null,
              error: null,
              retryable: null,
            },
      };
    case "connectorStarting":
      if (state.connector.status === "starting") return state;
      return {
        ...state,
        connector: {
          status: "starting",
          acknowledgement: null,
          hostId: state.connector.hostId,
          connectorId: null,
          negotiatedCapabilityIntersection: [],
          exitCode: null,
          error: null,
          retryable: null,
        },
      };
    case "connectorStopped":
      return relayV2EnrollmentReducer(state, { type: "hostRegistrationLost" });
    case "connectorSuperseded":
      return {
        ...state,
        connector: {
          status: "superseded",
          acknowledgement: null,
          hostId: null,
          connectorId: null,
          negotiatedCapabilityIntersection: [],
          exitCode: 78,
          error: sanitizeMobileRelayV2DisplayMessage(
            event.error,
            "A newer authenticated connector replaced this process.",
          ),
          retryable: false,
        },
      };
    case "capabilityIntersectionObserved":
      if (
        state.connector.status !== "registered"
        && state.connector.status !== "registered_incomplete"
      ) return state;
      return {
        ...state,
        connector: normalizeMobileRelayV2Connector({
          ...state.connector,
          negotiatedCapabilityIntersection: [...new Set(event.capabilities)],
        }),
      };
    case "enrollmentCreateStarted": {
      if (state.enrollment.status === "creating") return state;
      const intent = event.intent
        ?? (state.enrollment.status === "failed"
          ? "retry"
          : state.enrollment.status === "expired"
            ? "rebuild"
            : "create");
      return relayV2EnrollmentReady(state)
        ? { ...state, enrollment: { status: "creating", intent } }
        : {
            ...state,
            enrollment: {
              status: "failed",
              intent,
              error: NOT_READY_ERROR,
              retryable: false,
            },
          };
    }
    case "enrollmentCreated":
      return relayV2EnrollmentReady(state)
        ? normalizeMobileRelayV2DashboardState({
            ...state,
            enrollment: { status: "active", review: event.review },
          })
        : {
            ...state,
            enrollment: {
              status: "failed",
              intent: state.enrollment.status === "creating"
                ? state.enrollment.intent
                : "create",
              error: NOT_READY_ERROR,
              retryable: false,
            },
          };
    case "enrollmentCreateFailed":
      return {
        ...state,
        enrollment: {
          status: "failed",
          intent: event.intent
            ?? (state.enrollment.status === "creating" ? state.enrollment.intent : "create"),
          error: sanitizeMobileRelayV2DisplayMessage(
            event.error,
            "Relay v2 enrollment failed.",
          ),
          retryable: event.retryable === true,
        },
      };
    case "enrollmentCleared":
      return { ...state, enrollment: { status: "idle" } };
    case "clientGrantObserved":
      return { ...state, knownClientGrant: { status: "active", grantId: event.grantId } };
    case "clientGrantRevokeStarted":
      if (
        state.knownClientGrant.status === "revoking"
        && state.knownClientGrant.grantId === event.grantId
      ) return state;
      return {
        ...state,
        knownClientGrant: { status: "revoking", grantId: event.grantId },
      };
    case "clientGrantRevoked":
      return {
        ...state,
        knownClientGrant: {
          status: "revoked",
          grantId: event.grantId,
          revokedAtMs: event.revokedAtMs,
          alreadyRevoked: event.alreadyRevoked,
        },
      };
    case "clientGrantRevokeFailed":
      return {
        ...state,
        knownClientGrant: {
          status: "failed",
          grantId: event.grantId,
          error: sanitizeMobileRelayV2DisplayMessage(
            event.error,
            "Relay v2 client grant revoke failed.",
          ),
          retryable: event.retryable === true,
        },
      };
  }
}

export function buildRelayV2EnrollmentQrPayload(
  review: RelayV2EnrollmentReview,
): string | null {
  const normalized = normalizeMobileRelayV2EnrollmentReview(review);
  if (!normalized) return null;
  const { enrollment, display } = normalized;
  return [
    "tmuxworktree://enroll?v=2",
    `issuerUrl=${encodeURIComponent(display.issuerUrl)}`,
    `relayUrl=${encodeURIComponent(display.relayUrl)}`,
    `hostId=${encodeURIComponent(display.hostId)}`,
    `enrollmentId=${encodeURIComponent(enrollment.enrollmentId)}`,
    `enrollmentCode=${encodeURIComponent(enrollment.enrollmentCode)}`,
  ].join("&");
}

export function deriveRelayV2EnrollmentView(
  state: RelayV2EnrollmentState,
  nowMs = Date.now(),
): RelayV2EnrollmentView {
  const normalizedState = normalizeMobileRelayV2DashboardState(state, nowMs);
  const connector = normalizeMobileRelayV2Connector(normalizedState.connector);
  const adapterAvailable = normalizedState.authority.kind !== "unavailable";
  const missingCapabilities = relayV2MissingCapabilities(
    connector.negotiatedCapabilityIntersection,
  );
  const ready = relayV2EnrollmentReady(normalizedState);
  const activeReview = normalizedState.enrollment.status === "active"
    ? normalizedState.enrollment.review
    : null;
  const reviewMatchesRegistration = activeReview !== null
    && connector.status === "registered"
    && activeReview.display.hostId === connector.hostId;
  const reviewIsCurrent = activeReview !== null
    && activeReview.enrollment.expiresAtMs > nowMs;
  const review = ready && reviewMatchesRegistration && reviewIsCurrent ? activeReview : null;
  const qrPayload = review ? buildRelayV2EnrollmentQrPayload(review) : null;

  let readinessLabel: string;
  let readinessDetail: string;
  if (normalizedState.authority.kind === "unavailable") {
    readinessLabel = "Relay v2 backend unavailable";
    readinessDetail = normalizedState.authority.reason;
  } else if (connector.status === "registered_incomplete") {
    readinessLabel = "Relay v2 capabilities incomplete";
    readinessDetail = `Enrollment stays unavailable. Missing: ${missingCapabilities.join(", ")}.`;
  } else if (connector.status !== "registered") {
    readinessLabel = "Relay v2 host not registered";
    readinessDetail = connector.error
      ? `host.registered was not established: ${connector.error}`
      : "Enrollment stays unavailable until the connector receives host.registered.";
  } else {
    readinessLabel = "Relay v2 connector ready for enrollment";
    readinessDetail =
      "The Mac host connector is registered with all six required capabilities. Phone connectivity is not verified.";
  }

  const enrollmentAction = !adapterAvailable || !ready || normalizedState.enrollment.status === "creating"
    ? null
    : activeReview && reviewIsCurrent
      ? null
      : normalizedState.enrollment.status === "failed"
        ? normalizedState.enrollment.retryable
          ? "retry"
          : null
        : normalizedState.enrollment.status === "expired" || (activeReview !== null && !reviewIsCurrent)
          ? "rebuild"
          : "create";
  const enrollmentActionLabel = !adapterAvailable
    ? "Enrollment adapter unavailable"
    : !ready
      ? "Enrollment unavailable"
      : qrPayload
        ? "One-time enrollment active"
        : normalizedState.enrollment.status === "creating"
          ? normalizedState.enrollment.intent === "rebuild"
            ? "Rebuilding enrollment"
            : "Creating enrollment"
          : normalizedState.enrollment.status === "failed"
            ? normalizedState.enrollment.retryable
              ? "Retry enrollment"
              : "Enrollment failed — reconfigure Relay v2"
            : normalizedState.enrollment.status === "expired" || (activeReview !== null && !reviewIsCurrent)
              ? "Rebuild expired enrollment"
              : "Create one-time enrollment";

  const errors = [
    normalizedState.hostCredential.error,
    connector.error,
    normalizedState.enrollment.status === "failed" ? normalizedState.enrollment.error : null,
    normalizedState.knownClientGrant.status === "failed"
      ? normalizedState.knownClientGrant.error
      : null,
  ].filter((value): value is string => Boolean(value));

  return {
    adapterAvailable,
    previewOnly: normalizedState.authority.kind === "fake_preview",
    ready,
    missingCapabilities,
    readinessLabel,
    readinessDetail,
    v1CredentialLabel: normalizedState.v1Profile.sharedSecretConfigured
      ? "Relay v1 shared secret configured"
      : "Relay v1 shared secret not configured",
    v2CredentialLabel: `Relay v2 host credential ${normalizedState.hostCredential.status}`,
    hostCredentialAction: !adapterAvailable
      || normalizedState.hostCredential.status === "bootstrapping"
      || normalizedState.hostCredential.status === "refreshing"
      ? null
      : normalizedState.hostCredential.status === "failed" && !normalizedState.hostCredential.retryable
        ? null
      : normalizedState.hostCredential.credentialReference
        ? "refresh"
        : "bootstrap",
    connectorAction: !adapterAvailable
      || !normalizedState.hostCredential.credentialReference
      || connector.status === "starting"
      || (connector.status === "failed" && !connector.retryable)
      ? null
      : connector.status === "superseded"
        ? "restart"
        : connector.status === "registered" || connector.status === "registered_incomplete"
          ? "stop"
          : "start",
    enrollmentAction,
    enrollmentActionDisabled: enrollmentAction === null,
    enrollmentActionLabel,
    grantRevokeDisabled: !adapterAvailable || !(
      normalizedState.knownClientGrant.status === "active"
      || (
        normalizedState.knownClientGrant.status === "failed"
        && normalizedState.knownClientGrant.retryable
      )
    ),
    grantRevokeLabel: normalizedState.knownClientGrant.status === "failed"
      ? normalizedState.knownClientGrant.retryable
        ? "Retry client grant revoke"
        : "Client grant revoke failed — reconfigure Relay v2"
      : normalizedState.knownClientGrant.status === "revoking"
        ? "Revoking client grant"
        : "Revoke known client grant",
    error: errors.length > 0
      ? `${errors[0]} Relay v1 remains unchanged; no fallback was attempted.`
      : null,
    review,
    qrPayload,
  };
}
