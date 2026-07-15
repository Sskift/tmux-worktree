import {
  MOBILE_RELAY_V2_REQUIRED_CAPABILITIES,
  type MobileRelayV2Connector,
  type MobileRelayV2DashboardState,
  type MobileRelayV2OperationFailure,
} from "./domainTypes";

const CONTRADICTORY_REGISTRATION_ERROR =
  "Relay v2 backend returned a contradictory host registration; reconfigure the connector.";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function own(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function capabilityIntersection(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((capability): capability is string => (
        typeof capability === "string" && capability.length > 0
      )))]
    : [];
}

export function relayV2MissingNegotiatedCapabilities(
  capabilities: readonly string[],
): (typeof MOBILE_RELAY_V2_REQUIRED_CAPABILITIES)[number][] {
  const negotiated = new Set(capabilities);
  return MOBILE_RELAY_V2_REQUIRED_CAPABILITIES.filter(
    (capability) => !negotiated.has(capability),
  );
}

/**
 * Treat adapter output as untrusted IPC data. In particular, a status string
 * alone never proves registration: the ACK, both identities, and the broker +
 * host negotiated capability intersection must agree.
 */
export function normalizeMobileRelayV2Connector(value: unknown): MobileRelayV2Connector {
  const input = record(value);
  const status = input?.status;
  if (status === "stopped") {
    return {
      status: "stopped",
      acknowledgement: null,
      hostId: null,
      connectorId: null,
      negotiatedCapabilityIntersection: [],
      exitCode: null,
      error: null,
      retryable: null,
    };
  }
  if (status === "starting") {
    return {
      status: "starting",
      acknowledgement: null,
      hostId: nonEmptyString(input?.hostId),
      connectorId: null,
      negotiatedCapabilityIntersection: [],
      exitCode: null,
      error: null,
      retryable: null,
    };
  }
  if (status === "superseded") {
    return {
      status: "superseded",
      acknowledgement: null,
      hostId: null,
      connectorId: null,
      negotiatedCapabilityIntersection: [],
      exitCode: 78,
      error: nonEmptyString(input?.error)
        ?? "A newer authenticated connector replaced this process.",
      retryable: false,
    };
  }
  if (status === "failed") {
    return {
      status: "failed",
      acknowledgement: null,
      hostId: null,
      connectorId: null,
      negotiatedCapabilityIntersection: [],
      exitCode: null,
      error: nonEmptyString(input?.error) ?? "Relay v2 connector failed.",
      retryable: input?.retryable === true,
    };
  }
  if (status === "registered" || status === "registered_incomplete") {
    const hostId = nonEmptyString(input?.hostId);
    const connectorId = nonEmptyString(input?.connectorId);
    if (input?.acknowledgement !== "host.registered" || !hostId || !connectorId) {
      return {
        status: "failed",
        acknowledgement: null,
        hostId: null,
        connectorId: null,
        negotiatedCapabilityIntersection: [],
        exitCode: null,
        error: CONTRADICTORY_REGISTRATION_ERROR,
        retryable: false,
      };
    }
    const negotiatedCapabilityIntersection = capabilityIntersection(
      input.negotiatedCapabilityIntersection,
    );
    return {
      status: relayV2MissingNegotiatedCapabilities(negotiatedCapabilityIntersection).length === 0
        ? "registered"
        : "registered_incomplete",
      acknowledgement: "host.registered",
      hostId,
      connectorId,
      negotiatedCapabilityIntersection,
      exitCode: null,
      error: null,
      retryable: null,
    };
  }
  return {
    status: "failed",
    acknowledgement: null,
    hostId: null,
    connectorId: null,
    negotiatedCapabilityIntersection: [],
    exitCode: null,
    error: "Relay v2 backend returned an unknown connector state; reconfigure the connector.",
    retryable: false,
  };
}

export function mobileRelayV2ConnectorReady(
  connector: MobileRelayV2Connector,
): boolean {
  const normalized = normalizeMobileRelayV2Connector(connector);
  return normalized.status === "registered"
    && normalized.acknowledgement === "host.registered"
    && normalized.hostId.length > 0
    && normalized.connectorId.length > 0
    && relayV2MissingNegotiatedCapabilities(
      normalized.negotiatedCapabilityIntersection,
    ).length === 0;
}

export function normalizeMobileRelayV2DashboardState(
  state: MobileRelayV2DashboardState,
  nowMs = Date.now(),
): MobileRelayV2DashboardState {
  const connector = normalizeMobileRelayV2Connector(state.connector);
  const enrollment = state.enrollment.status === "active"
    && state.enrollment.review.enrollment.expiresAtMs <= nowMs
    ? {
        status: "expired" as const,
        enrollmentId: state.enrollment.review.enrollment.enrollmentId,
        expiredAtMs: state.enrollment.review.enrollment.expiresAtMs,
      }
    : state.enrollment.status === "failed"
      ? { ...state.enrollment, retryable: state.enrollment.retryable === true }
      : state.enrollment;
  const knownClientGrant = state.knownClientGrant.status === "failed"
    ? { ...state.knownClientGrant, retryable: state.knownClientGrant.retryable === true }
    : state.knownClientGrant;
  const hostCredential = {
    ...state.hostCredential,
    retryable: state.hostCredential.status === "failed"
      ? state.hostCredential.retryable === true
      : null,
  };
  return { ...state, connector, enrollment, knownClientGrant, hostCredential };
}

export class MobileRelayV2BackendOperationError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(failure: MobileRelayV2OperationFailure) {
    super(failure.message);
    this.name = "MobileRelayV2BackendOperationError";
    this.code = failure.code;
    this.retryable = failure.retryable;
  }
}

export function classifyMobileRelayV2OperationFailure(
  error: unknown,
): MobileRelayV2OperationFailure {
  const input = record(error);
  if (
    input
    && own(input, "code")
    && own(input, "message")
    && own(input, "retryable")
    && nonEmptyString(input.code)
    && nonEmptyString(input.message)
    && typeof input.retryable === "boolean"
  ) {
    return {
      code: nonEmptyString(input.code)!,
      message: nonEmptyString(input.message)!,
      retryable: input.retryable,
    };
  }
  return {
    code: "relay_v2_unknown_failure",
    message: error instanceof Error
      ? error.message.trim() || "Relay v2 backend operation failed."
      : nonEmptyString(error) ?? "Relay v2 backend operation failed.",
    retryable: false,
  };
}
