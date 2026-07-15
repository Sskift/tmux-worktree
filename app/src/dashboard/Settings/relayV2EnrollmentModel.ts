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
  normalizeMobileRelayV2Connector,
  relayV2MissingNegotiatedCapabilities,
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
  connectorAction: "start" | "stop" | null;
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
      const message = event.failure.message.trim() || "Relay v2 status observation failed.";
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
      return {
        ...state,
        hostCredential: {
          ...state.hostCredential,
          status: event.credentialReference ? "ready" : "missing",
          credentialReference: event.credentialReference,
          error: null,
          retryable: null,
        },
      };
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
          error: event.error.trim() || "Relay v2 host credential operation failed.",
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
              error: event.error.trim() || "Relay v2 connector failed.",
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
          error: event.error?.trim() || "A newer authenticated connector replaced this process.",
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
        ? { ...state, enrollment: { status: "active", review: event.review } }
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
          error: event.error.trim() || "Relay v2 enrollment failed.",
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
          error: event.error.trim() || "Relay v2 client grant revoke failed.",
          retryable: event.retryable === true,
        },
      };
  }
}

function validEnrollmentReview(review: RelayV2EnrollmentReview): boolean {
  const { enrollment, display } = review;
  if (
    !enrollment.enrollmentId
    || !enrollment.enrollmentCode.startsWith("twenroll2.")
    || !Number.isSafeInteger(enrollment.expiresAtMs)
    || enrollment.expiresAtMs < 0
    || !display.hostId
  ) return false;

  try {
    const issuerUrl = new URL(display.issuerUrl);
    const relayUrl = new URL(display.relayUrl);
    return issuerUrl.protocol === "https:"
      && Boolean(issuerUrl.hostname)
      && !issuerUrl.username
      && !issuerUrl.password
      && issuerUrl.pathname === "/"
      && !issuerUrl.search
      && !issuerUrl.hash
      && relayUrl.protocol === "wss:"
      && Boolean(relayUrl.hostname)
      && !relayUrl.username
      && !relayUrl.password
      && relayUrl.pathname === "/client"
      && !relayUrl.search
      && !relayUrl.hash;
  } catch {
    return false;
  }
}

export function buildRelayV2EnrollmentQrPayload(
  review: RelayV2EnrollmentReview,
): string | null {
  if (!validEnrollmentReview(review)) return null;
  const { enrollment, display } = review;
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
  const connector = normalizeMobileRelayV2Connector(state.connector);
  const adapterAvailable = state.authority.kind !== "unavailable";
  const missingCapabilities = relayV2MissingCapabilities(
    connector.negotiatedCapabilityIntersection,
  );
  const ready = relayV2EnrollmentReady(state);
  const activeReview = state.enrollment.status === "active" ? state.enrollment.review : null;
  const reviewMatchesRegistration = activeReview !== null
    && connector.status === "registered"
    && activeReview.display.hostId === connector.hostId;
  const reviewIsCurrent = activeReview !== null
    && activeReview.enrollment.expiresAtMs > nowMs;
  const review = ready && reviewMatchesRegistration && reviewIsCurrent ? activeReview : null;
  const qrPayload = review ? buildRelayV2EnrollmentQrPayload(review) : null;

  let readinessLabel: string;
  let readinessDetail: string;
  if (state.authority.kind === "unavailable") {
    readinessLabel = "Relay v2 backend unavailable";
    readinessDetail = state.authority.reason;
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

  const enrollmentAction = !adapterAvailable || !ready || state.enrollment.status === "creating"
    ? null
    : activeReview && reviewIsCurrent
      ? null
      : state.enrollment.status === "failed"
        ? state.enrollment.retryable
          ? "retry"
          : null
        : state.enrollment.status === "expired" || (activeReview !== null && !reviewIsCurrent)
          ? "rebuild"
          : "create";
  const enrollmentActionLabel = !adapterAvailable
    ? "Enrollment adapter unavailable"
    : !ready
      ? "Enrollment unavailable"
      : qrPayload
        ? "One-time enrollment active"
        : state.enrollment.status === "creating"
          ? state.enrollment.intent === "rebuild"
            ? "Rebuilding enrollment"
            : "Creating enrollment"
          : state.enrollment.status === "failed"
            ? state.enrollment.retryable
              ? "Retry enrollment"
              : "Enrollment failed — reconfigure Relay v2"
            : state.enrollment.status === "expired" || (activeReview !== null && !reviewIsCurrent)
              ? "Rebuild expired enrollment"
              : "Create one-time enrollment";

  const errors = [
    state.hostCredential.error,
    connector.error,
    state.enrollment.status === "failed" ? state.enrollment.error : null,
    state.knownClientGrant.status === "failed" ? state.knownClientGrant.error : null,
  ].filter((value): value is string => Boolean(value));

  return {
    adapterAvailable,
    previewOnly: state.authority.kind === "fake_preview",
    ready,
    missingCapabilities,
    readinessLabel,
    readinessDetail,
    v1CredentialLabel: state.v1Profile.sharedSecretConfigured
      ? "Relay v1 shared secret configured"
      : "Relay v1 shared secret not configured",
    v2CredentialLabel: `Relay v2 host credential ${state.hostCredential.status}`,
    hostCredentialAction: !adapterAvailable
      || state.hostCredential.status === "bootstrapping"
      || state.hostCredential.status === "refreshing"
      ? null
      : state.hostCredential.status === "failed" && !state.hostCredential.retryable
        ? null
      : state.hostCredential.credentialReference
        ? "refresh"
        : "bootstrap",
    connectorAction: !adapterAvailable
      || !state.hostCredential.credentialReference
      || connector.status === "starting"
      || connector.status === "superseded"
      || (connector.status === "failed" && !connector.retryable)
      ? null
      : connector.status === "registered" || connector.status === "registered_incomplete"
        ? "stop"
        : "start",
    enrollmentAction,
    enrollmentActionDisabled: enrollmentAction === null,
    enrollmentActionLabel,
    grantRevokeDisabled: !adapterAvailable || !(
      state.knownClientGrant.status === "active"
      || (
        state.knownClientGrant.status === "failed"
        && state.knownClientGrant.retryable
      )
    ),
    grantRevokeLabel: state.knownClientGrant.status === "failed"
      ? state.knownClientGrant.retryable
        ? "Retry client grant revoke"
        : "Client grant revoke failed — reconfigure Relay v2"
      : state.knownClientGrant.status === "revoking"
        ? "Revoking client grant"
        : "Revoke known client grant",
    error: errors.length > 0
      ? `${errors[0]} Relay v1 remains unchanged; no fallback was attempted.`
      : null,
    review,
    qrPayload,
  };
}
