import type { MobileRelayV2ProductAdapter } from "./dashboardBackend";
import {
  MOBILE_RELAY_V2_REQUIRED_CAPABILITIES,
  type MobileRelayV2CreateEnrollmentInput,
  type MobileRelayV2DashboardState,
  type MobileRelayV2EnrollmentReview,
  type MobileRelayV2RevokeClientGrantInput,
} from "./domainTypes";
import {
  mobileRelayV2ConnectorReady,
  MobileRelayV2BackendOperationError,
  normalizeMobileRelayV2DashboardState,
} from "./relayV2Domain";

export interface FakeMobileRelayV2AdapterOptions {
  initialState?: MobileRelayV2DashboardState;
  now?: () => number;
  connectorCapabilities?: readonly string[];
  issuerUrl?: string;
  relayUrl?: string;
  hostId?: string;
}

export function createFakeMobileRelayV2RenderArtifact(
  expiresAtMs: number,
  sequence = 0,
): MobileRelayV2EnrollmentReview["renderArtifact"] {
  return {
    kind: "native_qr_handle",
    handle: `dqart1.${String(sequence).padStart(32, "0")}`,
    expiresAtMs,
  };
}

function cloneState(state: MobileRelayV2DashboardState): MobileRelayV2DashboardState {
  return structuredClone(state);
}

export function createFakeMobileRelayV2State(
  sharedSecretConfigured = false,
): MobileRelayV2DashboardState {
  return {
    authority: { kind: "fake_preview", reason: null },
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

export function createFakeMobileRelayV2Adapter(
  options: FakeMobileRelayV2AdapterOptions = {},
): MobileRelayV2ProductAdapter {
  const now = options.now ?? Date.now;
  const connectorCapabilities = options.connectorCapabilities
    ?? MOBILE_RELAY_V2_REQUIRED_CAPABILITIES;
  const issuerUrl = options.issuerUrl ?? "https://relay.preview.invalid";
  const relayUrl = options.relayUrl ?? "wss://relay.preview.invalid/client";
  const hostId = options.hostId ?? "mac-admin-preview";
  let state = normalizeMobileRelayV2DashboardState(
    cloneState(options.initialState ?? createFakeMobileRelayV2State()),
    now(),
  );
  let enrollmentSequence = 0;

  const publish = (): MobileRelayV2DashboardState => {
    state = normalizeMobileRelayV2DashboardState(state, now());
    return cloneState(state);
  };
  const expireEnrollment = () => {
    if (
      state.enrollment.status === "active"
      && state.enrollment.review.enrollment.expiresAtMs <= now()
    ) {
      state = {
        ...state,
        enrollment: {
          status: "expired",
          enrollmentId: state.enrollment.review.enrollment.enrollmentId,
          expiredAtMs: state.enrollment.review.enrollment.expiresAtMs,
        },
      };
    }
  };
  const requireAuthority = () => {
    if (state.authority.kind === "unavailable") {
      throw new MobileRelayV2BackendOperationError({
        code: "relay_v2_adapter_unavailable",
        message: state.authority.reason,
        retryable: false,
      });
    }
  };
  const fail = (code: string, message: string, retryable = false): never => {
    throw new MobileRelayV2BackendOperationError({ code, message, retryable });
  };
  const enrollmentReady = () => mobileRelayV2ConnectorReady(state.connector);

  return {
    status: async (signal) => {
      if (signal?.aborted) throw signal.reason ?? new Error("Relay v2 status observation aborted.");
      expireEnrollment();
      return publish();
    },
    bootstrapHost: async () => {
      requireAuthority();
      if (state.hostCredential.status === "ready") return publish();
      state = {
        ...state,
        hostCredential: {
          ...state.hostCredential,
          status: "bootstrapping",
          error: null,
          retryable: null,
        },
      };
      state = {
        ...state,
        hostCredential: {
          ...state.hostCredential,
          status: "ready",
          credentialReference: "fake-preview://relay-v2/host-grant",
          expiresAtMs: now() + 60 * 60_000,
          error: null,
          retryable: null,
        },
      };
      return publish();
    },
    refreshHost: async () => {
      requireAuthority();
      if (!state.hostCredential.credentialReference) {
        fail(
          "relay_v2_host_credential_missing",
          "Relay v2 host credential must be bootstrapped before refresh.",
        );
      }
      state = {
        ...state,
        hostCredential: {
          ...state.hostCredential,
          status: "refreshing",
          error: null,
          retryable: null,
        },
      };
      state = {
        ...state,
        hostCredential: {
          ...state.hostCredential,
          status: "ready",
          expiresAtMs: now() + 60 * 60_000,
          error: null,
          retryable: null,
        },
      };
      return publish();
    },
    startConnector: async () => {
      requireAuthority();
      if (state.hostCredential.status !== "ready") {
        fail("relay_v2_host_credential_not_ready", "Relay v2 host credential is not ready.");
      }
      state = {
        ...state,
        connector: {
          status: "starting",
          acknowledgement: null,
          hostId,
          connectorId: null,
          negotiatedCapabilityIntersection: [],
          exitCode: null,
          error: null,
          retryable: null,
        },
      };
      state = {
        ...state,
        connector: {
          status: "registered_incomplete",
          acknowledgement: "host.registered",
          hostId,
          connectorId: "fake-preview-connector",
          negotiatedCapabilityIntersection: [...new Set(connectorCapabilities)],
          exitCode: null,
          error: null,
          retryable: null,
        },
      };
      return publish();
    },
    stopConnector: async () => {
      requireAuthority();
      state = {
        ...state,
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
      };
      return publish();
    },
    showEnrollmentArtifact: async ({ handle }) => {
      expireEnrollment();
      if (
        state.enrollment.status !== "active"
        || state.enrollment.review.renderArtifact.handle !== handle
      ) {
        fail(
          "relay_v2_enrollment_artifact_unavailable",
          "The Relay v2 enrollment artifact is unavailable.",
        );
      }
    },
    createEnrollment: async (input: MobileRelayV2CreateEnrollmentInput) => {
      requireAuthority();
      expireEnrollment();
      if (!enrollmentReady()) {
        fail(
          "relay_v2_enrollment_not_ready",
          "Relay v2 enrollment requires host.registered and all six required capabilities.",
        );
      }
      if (state.enrollment.status === "active") {
        if (input.intent === "rebuild") {
          fail(
            "relay_v2_enrollment_active",
            "Wait for the current one-time enrollment to expire before rebuilding.",
          );
        }
        return publish();
      }
      enrollmentSequence += 1;
      state = {
        ...state,
        enrollment: { status: "creating", intent: input.intent },
      };
      const expiresAtMs = now() + 5 * 60_000;
      state = {
        ...state,
        enrollment: {
          status: "active",
          review: {
            enrollment: {
              enrollmentId: `fake-preview-enrollment-${enrollmentSequence}`,
              expiresAtMs,
            },
            display: {
              issuerUrl,
              relayUrl,
              hostId,
              deviceLabel: input.deviceLabel?.trim() || null,
            },
            renderArtifact: createFakeMobileRelayV2RenderArtifact(
              expiresAtMs,
              enrollmentSequence,
            ),
          },
        },
      };
      return publish();
    },
    revokeClientGrant: async (input: MobileRelayV2RevokeClientGrantInput) => {
      requireAuthority();
      if (
        state.knownClientGrant.status === "revoked"
        && state.knownClientGrant.grantId === input.grantId
      ) return publish();
      if (
        state.knownClientGrant.status !== "active"
        || state.knownClientGrant.grantId !== input.grantId
      ) {
        fail(
          "relay_v2_client_grant_unknown",
          "The requested Relay v2 client grant is not known to this host.",
        );
      }
      state = {
        ...state,
        knownClientGrant: { status: "revoking", grantId: input.grantId },
      };
      state = {
        ...state,
        knownClientGrant: {
          status: "revoked",
          grantId: input.grantId,
          revokedAtMs: now(),
          alreadyRevoked: false,
        },
      };
      return publish();
    },
  };
}
