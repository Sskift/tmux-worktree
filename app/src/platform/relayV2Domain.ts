import {
  MOBILE_RELAY_V2_REQUIRED_CAPABILITIES,
  type MobileRelayV2Connector,
  type MobileRelayV2DashboardState,
  type MobileRelayV2EnrollmentReview,
  type MobileRelayV2OperationFailure,
} from "./domainTypes";

const CONTRADICTORY_REGISTRATION_ERROR =
  "Relay v2 backend returned a contradictory host registration; restore authoritative Relay v2 state.";
const MALFORMED_STATUS_ERROR =
  "Relay v2 backend returned malformed status; restore authoritative Relay v2 state before trying again.";
const HIDDEN_ENROLLMENT_ERROR =
  "Enrollment is hidden until authoritative Relay v2 state is restored.";
const REDACTED_CREDENTIAL = "[redacted Relay v2 credential]";
const CREDENTIAL_LIKE_SOURCE =
  String.raw`(?:twcap2|twref2|twenroll2|twhostboot2)\.[^\s"'<>]+`;

type Parsed<T> = { valid: true; value: T } | { valid: false };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function own(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasOwnFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => own(value, field));
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function opaqueIdentifier(value: unknown): string | null {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && !value.includes("\0")
    ? value
    : null;
}

function safeTimestamp(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function containsCredentialLikeValue(value: string): boolean {
  return new RegExp(CREDENTIAL_LIKE_SOURCE, "i").test(value);
}

export function sanitizeMobileRelayV2DisplayMessage(
  value: unknown,
  fallback: string,
): string {
  const message = nonEmptyString(value) ?? fallback;
  return message.replace(new RegExp(CREDENTIAL_LIKE_SOURCE, "gi"), REDACTED_CREDENTIAL);
}

function safeFailureCode(value: unknown): string {
  const code = nonEmptyString(value);
  return code && !containsCredentialLikeValue(code) ? code : "relay_v2_unknown_failure";
}

function capabilityIntersection(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const capabilities: string[] = [];
  const seen = new Set<string>();
  for (const capability of value) {
    const parsed = opaqueIdentifier(capability);
    if (!parsed) return null;
    if (!seen.has(parsed)) {
      seen.add(parsed);
      capabilities.push(parsed);
    }
  }
  return capabilities;
}

export function relayV2MissingNegotiatedCapabilities(
  capabilities: readonly string[],
): (typeof MOBILE_RELAY_V2_REQUIRED_CAPABILITIES)[number][] {
  const negotiated = new Set(capabilities);
  return MOBILE_RELAY_V2_REQUIRED_CAPABILITIES.filter(
    (capability) => !negotiated.has(capability),
  );
}

function failedConnector(error: string): MobileRelayV2Connector {
  return {
    status: "failed",
    acknowledgement: null,
    hostId: null,
    connectorId: null,
    negotiatedCapabilityIntersection: [],
    exitCode: null,
    error,
    retryable: false,
  };
}

function parseMobileRelayV2Connector(value: unknown): Parsed<MobileRelayV2Connector> {
  const input = record(value);
  if (!input || !hasOwnFields(input, [
    "status",
    "acknowledgement",
    "hostId",
    "connectorId",
    "negotiatedCapabilityIntersection",
    "exitCode",
    "error",
    "retryable",
  ])) return { valid: false };

  const capabilities = capabilityIntersection(input.negotiatedCapabilityIntersection);
  if (!capabilities) return { valid: false };

  if (input.status === "stopped") {
    if (
      input.acknowledgement !== null
      || input.hostId !== null
      || input.connectorId !== null
      || capabilities.length !== 0
      || input.exitCode !== null
      || input.error !== null
      || input.retryable !== null
    ) return { valid: false };
    return {
      valid: true,
      value: {
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
  }

  if (input.status === "starting") {
    const hostId = input.hostId === null ? null : opaqueIdentifier(input.hostId);
    if (
      (input.hostId !== null && !hostId)
      || input.acknowledgement !== null
      || input.connectorId !== null
      || capabilities.length !== 0
      || input.exitCode !== null
      || input.error !== null
      || input.retryable !== null
    ) return { valid: false };
    return {
      valid: true,
      value: {
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
  }

  if (input.status === "registered" || input.status === "registered_incomplete") {
    const hostId = opaqueIdentifier(input.hostId);
    const connectorId = opaqueIdentifier(input.connectorId);
    if (
      input.acknowledgement !== "host.registered"
      || !hostId
      || !connectorId
      || input.exitCode !== null
      || input.error !== null
      || input.retryable !== null
    ) return { valid: false };
    return {
      valid: true,
      value: {
        status: relayV2MissingNegotiatedCapabilities(capabilities).length === 0
          ? "registered"
          : "registered_incomplete",
        acknowledgement: "host.registered",
        hostId,
        connectorId,
        negotiatedCapabilityIntersection: capabilities,
        exitCode: null,
        error: null,
        retryable: null,
      },
    };
  }

  if (input.status === "failed") {
    if (
      input.acknowledgement !== null
      || input.hostId !== null
      || input.connectorId !== null
      || capabilities.length !== 0
      || input.exitCode !== null
      || !nonEmptyString(input.error)
      || typeof input.retryable !== "boolean"
    ) return { valid: false };
    return {
      valid: true,
      value: {
        status: "failed",
        acknowledgement: null,
        hostId: null,
        connectorId: null,
        negotiatedCapabilityIntersection: [],
        exitCode: null,
        error: sanitizeMobileRelayV2DisplayMessage(input.error, "Relay v2 connector failed."),
        retryable: input.retryable,
      },
    };
  }

  if (input.status === "superseded") {
    if (
      input.acknowledgement !== null
      || input.hostId !== null
      || input.connectorId !== null
      || capabilities.length !== 0
      || input.exitCode !== 78
      || !nonEmptyString(input.error)
      || input.retryable !== false
    ) return { valid: false };
    return {
      valid: true,
      value: {
        status: "superseded",
        acknowledgement: null,
        hostId: null,
        connectorId: null,
        negotiatedCapabilityIntersection: [],
        exitCode: 78,
        error: sanitizeMobileRelayV2DisplayMessage(
          input.error,
          "A newer authenticated connector replaced this process.",
        ),
        retryable: false,
      },
    };
  }

  return { valid: false };
}

/** Adapter connector output is untrusted; only the closed projection is returned. */
export function normalizeMobileRelayV2Connector(value: unknown): MobileRelayV2Connector {
  const parsed = parseMobileRelayV2Connector(value);
  return parsed.valid ? parsed.value : failedConnector(CONTRADICTORY_REGISTRATION_ERROR);
}

export function mobileRelayV2ConnectorReady(connector: unknown): boolean {
  const parsed = parseMobileRelayV2Connector(connector);
  if (!parsed.valid) return false;
  return parsed.value.status === "registered"
    && relayV2MissingNegotiatedCapabilities(
      parsed.value.negotiatedCapabilityIntersection,
    ).length === 0;
}

function validIssuerUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && Boolean(url.hostname)
      && !url.username
      && !url.password
      && url.pathname === "/"
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function validRelayUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "wss:"
      && Boolean(url.hostname)
      && !url.username
      && !url.password
      && url.pathname === "/client"
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

export function normalizeMobileRelayV2EnrollmentReview(
  value: unknown,
): MobileRelayV2EnrollmentReview | null {
  const review = record(value);
  const enrollment = record(review?.enrollment);
  const display = record(review?.display);
  if (
    !review
    || !enrollment
    || !display
    || !hasOwnFields(review, ["enrollment", "display"])
    || !hasOwnFields(enrollment, ["enrollmentId", "enrollmentCode", "expiresAtMs"])
    || !hasOwnFields(display, ["issuerUrl", "relayUrl", "hostId", "deviceLabel"])
  ) return null;

  const enrollmentId = opaqueIdentifier(enrollment.enrollmentId);
  const enrollmentCode = opaqueIdentifier(enrollment.enrollmentCode);
  const expiresAtMs = safeTimestamp(enrollment.expiresAtMs);
  const issuerUrl = opaqueIdentifier(display.issuerUrl);
  const relayUrl = opaqueIdentifier(display.relayUrl);
  const hostId = opaqueIdentifier(display.hostId);
  const deviceLabel = display.deviceLabel === null
    ? null
    : opaqueIdentifier(display.deviceLabel);
  if (
    !enrollmentId
    || !enrollmentCode
    || !enrollmentCode.startsWith("twenroll2.")
    || enrollmentCode.length === "twenroll2.".length
    || expiresAtMs === null
    || !issuerUrl
    || !validIssuerUrl(issuerUrl)
    || !relayUrl
    || !validRelayUrl(relayUrl)
    || !hostId
    || (display.deviceLabel !== null && !deviceLabel)
  ) return null;

  return {
    enrollment: { enrollmentId, enrollmentCode, expiresAtMs },
    display: { issuerUrl, relayUrl, hostId, deviceLabel },
  };
}

function parseV1Profile(value: unknown): Parsed<MobileRelayV2DashboardState["v1Profile"]> {
  const input = record(value);
  if (
    !input
    || !hasOwnFields(input, ["protocolVersion", "credentialKind", "sharedSecretConfigured"])
    || input.protocolVersion !== 1
    || input.credentialKind !== "legacy_shared_secret"
    || typeof input.sharedSecretConfigured !== "boolean"
  ) return { valid: false };
  return {
    valid: true,
    value: {
      protocolVersion: 1,
      credentialKind: "legacy_shared_secret",
      sharedSecretConfigured: input.sharedSecretConfigured,
    },
  };
}

function parseAuthority(value: unknown): Parsed<MobileRelayV2DashboardState["authority"]> {
  const input = record(value);
  if (!input || !hasOwnFields(input, ["kind", "reason"])) return { valid: false };
  if (input.kind === "unavailable" && nonEmptyString(input.reason)) {
    return {
      valid: true,
      value: {
        kind: "unavailable",
        reason: sanitizeMobileRelayV2DisplayMessage(
          input.reason,
          "Relay v2 backend authority is unavailable.",
        ),
      },
    };
  }
  if ((input.kind === "fake_preview" || input.kind === "node") && input.reason === null) {
    return { valid: true, value: { kind: input.kind, reason: null } };
  }
  return { valid: false };
}

function parseHostCredential(
  value: unknown,
): Parsed<MobileRelayV2DashboardState["hostCredential"]> {
  const input = record(value);
  if (!input || !hasOwnFields(input, [
    "protocolVersion",
    "credentialKind",
    "status",
    "credentialReference",
    "expiresAtMs",
    "error",
    "retryable",
  ])) return { valid: false };
  if (input.protocolVersion !== 2 || input.credentialKind !== "twcap2_grant") {
    return { valid: false };
  }
  const credentialReference = input.credentialReference === null
    ? null
    : opaqueIdentifier(input.credentialReference);
  if (
    (input.credentialReference !== null && !credentialReference)
    || (credentialReference !== null && containsCredentialLikeValue(credentialReference))
  ) return { valid: false };
  const expiresAtMs = input.expiresAtMs === null ? null : safeTimestamp(input.expiresAtMs);
  if (input.expiresAtMs !== null && expiresAtMs === null) return { valid: false };
  const error = input.error === null
    ? null
    : sanitizeMobileRelayV2DisplayMessage(
        input.error,
        "Relay v2 host credential operation failed.",
      );
  if (input.error !== null && !nonEmptyString(input.error)) return { valid: false };

  const common = {
    protocolVersion: 2 as const,
    credentialKind: "twcap2_grant" as const,
    credentialReference,
    expiresAtMs,
  };
  if (
    input.status === "missing"
    && credentialReference === null
    && expiresAtMs === null
    && input.error === null
    && input.retryable === null
  ) return { valid: true, value: { ...common, status: "missing", error: null, retryable: null } };
  if (
    input.status === "bootstrapping"
    && input.error === null
    && input.retryable === null
  ) return { valid: true, value: { ...common, status: "bootstrapping", error: null, retryable: null } };
  if (
    input.status === "ready"
    && credentialReference !== null
    && input.error === null
    && input.retryable === null
  ) return { valid: true, value: { ...common, status: "ready", error: null, retryable: null } };
  if (
    input.status === "refreshing"
    && credentialReference !== null
    && input.error === null
    && input.retryable === null
  ) return { valid: true, value: { ...common, status: "refreshing", error: null, retryable: null } };
  if (
    input.status === "failed"
    && error !== null
    && typeof input.retryable === "boolean"
  ) return {
    valid: true,
    value: { ...common, status: "failed", error, retryable: input.retryable },
  };
  return { valid: false };
}

function parseEnrollment(
  value: unknown,
  connector: MobileRelayV2Connector,
  authorityAvailable: boolean,
  nowMs: number,
): Parsed<MobileRelayV2DashboardState["enrollment"]> {
  const input = record(value);
  if (!input || !own(input, "status")) return { valid: false };
  if (input.status === "idle") return { valid: true, value: { status: "idle" } };
  if (
    input.status === "creating"
    && (input.intent === "create" || input.intent === "retry" || input.intent === "rebuild")
  ) return { valid: true, value: { status: "creating", intent: input.intent } };
  if (input.status === "active" && own(input, "review")) {
    const review = normalizeMobileRelayV2EnrollmentReview(input.review);
    if (
      !review
      || !authorityAvailable
      || !mobileRelayV2ConnectorReady(connector)
      || review.display.hostId !== connector.hostId
    ) return { valid: false };
    if (review.enrollment.expiresAtMs <= nowMs) {
      return {
        valid: true,
        value: {
          status: "expired",
          enrollmentId: review.enrollment.enrollmentId,
          expiredAtMs: review.enrollment.expiresAtMs,
        },
      };
    }
    return { valid: true, value: { status: "active", review } };
  }
  if (
    input.status === "expired"
    && opaqueIdentifier(input.enrollmentId)
    && safeTimestamp(input.expiredAtMs) !== null
  ) return {
    valid: true,
    value: {
      status: "expired",
      enrollmentId: opaqueIdentifier(input.enrollmentId)!,
      expiredAtMs: safeTimestamp(input.expiredAtMs)!,
    },
  };
  if (
    input.status === "failed"
    && (input.intent === "create" || input.intent === "retry" || input.intent === "rebuild")
    && nonEmptyString(input.error)
    && typeof input.retryable === "boolean"
  ) return {
    valid: true,
    value: {
      status: "failed",
      intent: input.intent,
      error: sanitizeMobileRelayV2DisplayMessage(input.error, "Relay v2 enrollment failed."),
      retryable: input.retryable,
    },
  };
  return { valid: false };
}

function parseKnownClientGrant(
  value: unknown,
): Parsed<MobileRelayV2DashboardState["knownClientGrant"]> {
  const input = record(value);
  if (!input || !own(input, "status")) return { valid: false };
  if (input.status === "unknown") return { valid: true, value: { status: "unknown" } };
  const grantId = opaqueIdentifier(input.grantId);
  if (!grantId) return { valid: false };
  if (input.status === "active") return { valid: true, value: { status: "active", grantId } };
  if (input.status === "revoking") return { valid: true, value: { status: "revoking", grantId } };
  if (
    input.status === "revoked"
    && safeTimestamp(input.revokedAtMs) !== null
    && typeof input.alreadyRevoked === "boolean"
  ) return {
    valid: true,
    value: {
      status: "revoked",
      grantId,
      revokedAtMs: safeTimestamp(input.revokedAtMs)!,
      alreadyRevoked: input.alreadyRevoked,
    },
  };
  if (
    input.status === "failed"
    && nonEmptyString(input.error)
    && typeof input.retryable === "boolean"
  ) return {
    valid: true,
    value: {
      status: "failed",
      grantId,
      error: sanitizeMobileRelayV2DisplayMessage(
        input.error,
        "Relay v2 client grant revoke failed.",
      ),
      retryable: input.retryable,
    },
  };
  return { valid: false };
}

function unavailableDashboardState(
  sharedSecretConfigured: boolean,
): MobileRelayV2DashboardState {
  return {
    authority: { kind: "unavailable", reason: MALFORMED_STATUS_ERROR },
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
    connector: failedConnector(MALFORMED_STATUS_ERROR),
    enrollment: {
      status: "failed",
      intent: "create",
      error: HIDDEN_ENROLLMENT_ERROR,
      retryable: false,
    },
    knownClientGrant: { status: "unknown" },
  };
}

/**
 * Rebuild the renderer's closed, non-sensitive projection from untrusted
 * adapter output. Unknown fields are discarded; malformed known state clears
 * every cached v2 readiness signal while preserving a valid v1 configured bit.
 */
export function normalizeMobileRelayV2DashboardState(
  state: unknown,
  nowMs = Date.now(),
): MobileRelayV2DashboardState {
  const input = record(state);
  const v1Profile = parseV1Profile(input?.v1Profile);
  const sharedSecretConfigured = v1Profile.valid
    ? v1Profile.value.sharedSecretConfigured
    : false;
  if (
    !input
    || !hasOwnFields(input, [
      "authority",
      "v1Profile",
      "hostCredential",
      "connector",
      "enrollment",
      "knownClientGrant",
    ])
    || !v1Profile.valid
  ) return unavailableDashboardState(sharedSecretConfigured);

  const authority = parseAuthority(input.authority);
  const hostCredential = parseHostCredential(input.hostCredential);
  const connector = parseMobileRelayV2Connector(input.connector);
  const knownClientGrant = parseKnownClientGrant(input.knownClientGrant);
  const observationTime = safeTimestamp(nowMs);
  if (
    !authority.valid
    || !hostCredential.valid
    || !connector.valid
    || !knownClientGrant.valid
    || observationTime === null
  ) return unavailableDashboardState(sharedSecretConfigured);

  const enrollment = parseEnrollment(
    input.enrollment,
    connector.value,
    authority.value.kind !== "unavailable",
    observationTime,
  );
  if (!enrollment.valid) return unavailableDashboardState(sharedSecretConfigured);

  return {
    authority: authority.value,
    v1Profile: v1Profile.value,
    hostCredential: hostCredential.value,
    connector: connector.value,
    enrollment: enrollment.value,
    knownClientGrant: knownClientGrant.value,
  };
}

export class MobileRelayV2BackendOperationError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(failure: MobileRelayV2OperationFailure) {
    super(sanitizeMobileRelayV2DisplayMessage(
      failure.message,
      "Relay v2 backend operation failed.",
    ));
    this.name = "MobileRelayV2BackendOperationError";
    this.code = safeFailureCode(failure.code);
    this.retryable = failure.retryable === true;
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
      code: safeFailureCode(input.code),
      message: sanitizeMobileRelayV2DisplayMessage(
        input.message,
        "Relay v2 backend operation failed.",
      ),
      retryable: input.retryable,
    };
  }
  return {
    code: "relay_v2_unknown_failure",
    message: sanitizeMobileRelayV2DisplayMessage(
      error instanceof Error ? error.message : error,
      "Relay v2 backend operation failed.",
    ),
    retryable: false,
  };
}
