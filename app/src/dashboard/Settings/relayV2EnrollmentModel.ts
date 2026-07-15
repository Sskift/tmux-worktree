export const RELAY_V2_REQUIRED_CAPABILITIES = [
  "error.structured.v1",
  "command.ledger.v1",
  "command.query.v1",
  "snapshot.revision.v1",
  "event.sequence.v1",
  "terminal.stream.resume.v1",
] as const;

export type RelayV2RequiredCapability = (typeof RELAY_V2_REQUIRED_CAPABILITIES)[number];

export interface RelayV1SharedSecretProfile {
  protocolVersion: 1;
  credentialKind: "legacy_shared_secret";
  sharedSecretConfigured: boolean;
}

export interface RelayV2CredentialReference {
  protocolVersion: 2;
  credentialKind: "twcap2_grant";
  credentialReference: string | null;
}

export type RelayV2HostRegistration =
  | {
      status: "not_registered";
      hostId: null;
      connectorId: null;
      error: string | null;
    }
  | {
      status: "registered";
      acknowledgement: "host.registered";
      hostId: string;
      connectorId: string;
      error: null;
    };

export interface RelayV2EnrollmentReview {
  enrollment: {
    enrollmentId: string;
    enrollmentCode: string;
    expiresAtMs: number;
  };
  display: {
    issuerUrl: string;
    relayUrl: string;
    hostId: string;
    deviceLabel: string | null;
  };
}

export type RelayV2EnrollmentAttempt =
  | { status: "idle" }
  | { status: "creating" }
  | { status: "created"; review: RelayV2EnrollmentReview }
  | { status: "failed"; error: string };

export interface RelayV2EnrollmentState {
  v1Profile: RelayV1SharedSecretProfile;
  v2Credential: RelayV2CredentialReference;
  hostRegistration: RelayV2HostRegistration;
  capabilityIntersection: readonly string[];
  enrollment: RelayV2EnrollmentAttempt;
}

export type RelayV2EnrollmentEvent =
  | { type: "v2CredentialReferenceObserved"; credentialReference: string | null }
  | { type: "hostRegistered"; hostId: string; connectorId: string }
  | { type: "hostRegistrationLost"; error?: string | null }
  | { type: "capabilityIntersectionObserved"; capabilities: readonly string[] }
  | { type: "enrollmentCreateStarted" }
  | { type: "enrollmentCreated"; review: RelayV2EnrollmentReview }
  | { type: "enrollmentCreateFailed"; error: string }
  | { type: "enrollmentCleared" };

export interface RelayV2EnrollmentView {
  ready: boolean;
  missingCapabilities: readonly RelayV2RequiredCapability[];
  readinessLabel: string;
  readinessDetail: string;
  v1CredentialLabel: string;
  v2CredentialLabel: string;
  enrollmentActionDisabled: boolean;
  enrollmentActionLabel: string;
  error: string | null;
  review: RelayV2EnrollmentReview | null;
  qrPayload: string | null;
}

const NOT_READY_ERROR = "Relay v2 enrollment requires host.registered and all six required capabilities.";

export function createRelayV2EnrollmentState(
  sharedSecretConfigured = false,
): RelayV2EnrollmentState {
  return {
    v1Profile: {
      protocolVersion: 1,
      credentialKind: "legacy_shared_secret",
      sharedSecretConfigured,
    },
    v2Credential: {
      protocolVersion: 2,
      credentialKind: "twcap2_grant",
      credentialReference: null,
    },
    hostRegistration: {
      status: "not_registered",
      hostId: null,
      connectorId: null,
      error: null,
    },
    capabilityIntersection: [],
    enrollment: { status: "idle" },
  };
}

export function relayV2MissingCapabilities(
  capabilityIntersection: readonly string[],
): RelayV2RequiredCapability[] {
  const negotiated = new Set(capabilityIntersection);
  return RELAY_V2_REQUIRED_CAPABILITIES.filter((capability) => !negotiated.has(capability));
}

export function relayV2EnrollmentReady(state: RelayV2EnrollmentState): boolean {
  return state.hostRegistration.status === "registered"
    && relayV2MissingCapabilities(state.capabilityIntersection).length === 0;
}

export function relayV2EnrollmentReducer(
  state: RelayV2EnrollmentState,
  event: RelayV2EnrollmentEvent,
): RelayV2EnrollmentState {
  switch (event.type) {
    case "v2CredentialReferenceObserved":
      return {
        ...state,
        v2Credential: {
          ...state.v2Credential,
          credentialReference: event.credentialReference,
        },
      };
    case "hostRegistered":
      return {
        ...state,
        hostRegistration: {
          status: "registered",
          acknowledgement: "host.registered",
          hostId: event.hostId,
          connectorId: event.connectorId,
          error: null,
        },
      };
    case "hostRegistrationLost":
      return {
        ...state,
        hostRegistration: {
          status: "not_registered",
          hostId: null,
          connectorId: null,
          error: event.error?.trim() || null,
        },
        enrollment: { status: "idle" },
      };
    case "capabilityIntersectionObserved": {
      const nextState = {
        ...state,
        capabilityIntersection: [...new Set(event.capabilities)],
      };
      return relayV2EnrollmentReady(nextState)
        ? nextState
        : { ...nextState, enrollment: { status: "idle" } };
    }
    case "enrollmentCreateStarted":
      return relayV2EnrollmentReady(state)
        ? { ...state, enrollment: { status: "creating" } }
        : { ...state, enrollment: { status: "failed", error: NOT_READY_ERROR } };
    case "enrollmentCreated":
      return relayV2EnrollmentReady(state)
        ? { ...state, enrollment: { status: "created", review: event.review } }
        : { ...state, enrollment: { status: "failed", error: NOT_READY_ERROR } };
    case "enrollmentCreateFailed":
      return {
        ...state,
        enrollment: {
          status: "failed",
          error: event.error.trim() || "Relay v2 enrollment failed.",
        },
      };
    case "enrollmentCleared":
      return { ...state, enrollment: { status: "idle" } };
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
  const missingCapabilities = relayV2MissingCapabilities(state.capabilityIntersection);
  const ready = state.hostRegistration.status === "registered"
    && missingCapabilities.length === 0;
  const createdReview = state.enrollment.status === "created" ? state.enrollment.review : null;
  const reviewMatchesRegistration = createdReview !== null
    && state.hostRegistration.status === "registered"
    && createdReview.display.hostId === state.hostRegistration.hostId;
  const reviewIsCurrent = createdReview !== null
    && createdReview.enrollment.expiresAtMs > nowMs;
  const review = ready && reviewMatchesRegistration && reviewIsCurrent ? createdReview : null;
  const qrPayload = review ? buildRelayV2EnrollmentQrPayload(review) : null;

  let readinessLabel: string;
  let readinessDetail: string;
  if (state.hostRegistration.status !== "registered") {
    readinessLabel = "Relay v2 host not registered";
    readinessDetail = state.hostRegistration.error
      ? `host.registered was not established: ${state.hostRegistration.error}`
      : "Enrollment stays unavailable until the connector receives host.registered.";
  } else if (missingCapabilities.length > 0) {
    readinessLabel = "Relay v2 capabilities incomplete";
    readinessDetail = `Enrollment stays unavailable. Missing: ${missingCapabilities.join(", ")}.`;
  } else {
    readinessLabel = "Relay v2 connector ready for enrollment";
    readinessDetail = "The Mac host connector is registered with all six required capabilities. Phone connectivity is not verified.";
  }

  const enrollmentActionDisabled = !ready || qrPayload === null;
  const enrollmentActionLabel = !ready
    ? "Enrollment unavailable"
    : qrPayload
      ? "Enrollment review ready"
      : state.enrollment.status === "creating"
        ? "Creating enrollment preview"
        : state.enrollment.status === "failed"
          ? "Enrollment preview failed"
          : createdReview && !reviewIsCurrent
            ? "Enrollment preview expired"
            : "Enrollment adapter pending";

  return {
    ready,
    missingCapabilities,
    readinessLabel,
    readinessDetail,
    v1CredentialLabel: state.v1Profile.sharedSecretConfigured
      ? "Relay v1 shared secret configured"
      : "Relay v1 shared secret not configured",
    v2CredentialLabel: state.v2Credential.credentialReference
      ? "Relay v2 credential reference available"
      : "Relay v2 credential reference unavailable",
    enrollmentActionDisabled,
    enrollmentActionLabel,
    error: state.enrollment.status === "failed"
      ? `${state.enrollment.error} Relay v1 remains unchanged; no fallback was attempted.`
      : null,
    review,
    qrPayload,
  };
}
