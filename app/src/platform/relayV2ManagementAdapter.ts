import type { MobileRelayV2ProductAdapter } from "./dashboardBackend";
import {
  MOBILE_RELAY_V2_KNOWN_CAPABILITIES,
  MOBILE_RELAY_V2_REQUIRED_CAPABILITIES,
  type MobileRelayV2CopyEnrollmentArtifactInput,
  type MobileRelayV2CreateEnrollmentInput,
  type MobileRelayV2DashboardState,
  type MobileRelayV2InlineEnrollmentArtifactPngInput,
  type MobileRelayV2RevokeClientGrantInput,
  type MobileRelayV2ShowEnrollmentArtifactInput,
} from "./domainTypes";
import {
  MobileRelayV2BackendOperationError,
  normalizeMobileRelayV2DashboardState,
} from "./relayV2Domain";

const COMMAND = "mobile_relay_v2_management_call";
const SHOW_ARTIFACT_COMMAND = "mobile_relay_v2_enrollment_artifact_show";
const COPY_ARTIFACT_COMMAND = "mobile_relay_v2_enrollment_artifact_copy";
const INLINE_PNG_COMMAND = "mobile_relay_v2_enrollment_artifact_inline_png";
const REQUEST_ID_PATTERN = /^dmgmt2\.[A-Za-z0-9_-]{21}[AQgw]$/;
const NATIVE_QR_HANDLE_PATTERN = /^dqart1\.[A-Za-z0-9_-]{32}$/;

const MANAGEMENT_ERRORS = {
  UNAVAILABLE: {
    code: "UNAVAILABLE",
    message: "Relay v2 management is unavailable",
    retryable: false,
  },
  INVALID_ARGUMENT: {
    code: "INVALID_ARGUMENT",
    message: "Relay v2 management input is invalid",
    retryable: false,
  },
  NOT_READY: {
    code: "NOT_READY",
    message: "Relay v2 management is not ready",
    retryable: false,
  },
  BUSY: {
    code: "BUSY",
    message: "Relay v2 management is busy",
    retryable: true,
  },
  OPERATION_FAILED: {
    code: "OPERATION_FAILED",
    message: "Relay v2 management operation failed",
    retryable: false,
  },
  CHANNEL_CLOSED: {
    code: "CHANNEL_CLOSED",
    message: "Relay v2 management channel closed",
    retryable: false,
  },
  SUPERSEDED: {
    code: "SUPERSEDED",
    message: "Relay v2 management owner was superseded",
    retryable: false,
  },
} as const;

type ManagementErrorCode = keyof typeof MANAGEMENT_ERRORS;
type ManagementOperation =
  | "status"
  | "bootstrap_host"
  | "refresh_host"
  | "start_connector"
  | "stop_connector"
  | "create_enrollment"
  | "revoke_client_grant";
type ManagementInvoke = (command: string, args?: unknown) => Promise<unknown>;

type DecodedOutcome =
  | { kind: "state"; state: MobileRelayV2DashboardState }
  | { kind: "error"; code: ManagementErrorCode };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  const input = record(value);
  if (!input) return null;
  const actual = Object.keys(input);
  return actual.length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(input, key))
    ? input
    : null;
}

function opaque(value: unknown, maximumBytes = 128): string | null {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || value.includes("\0")
    || value.includes("\r")
    || value.includes("\n")
    || new TextEncoder().encode(value).byteLength > maximumBytes
  ) return null;
  return value;
}

function safeTimestamp(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function credentialLike(value: string): boolean {
  return /(?:twcap2|twref2|twenroll2|twhostboot2)\./i.test(value);
}

function projectionOpaque(value: unknown, maximumBytes = 128): string | null {
  const parsed = opaque(value, maximumBytes);
  return parsed && !credentialLike(parsed) ? parsed : null;
}

function projectionQrHandle(value: unknown): string | null {
  return typeof value === "string" && NATIVE_QR_HANDLE_PATTERN.test(value)
    ? value
    : null;
}

function projectionUrl(
  value: unknown,
  scheme: "https" | "wss",
  path: "/" | "/client",
): string | null {
  const parsed = projectionOpaque(value, 2_048);
  if (!parsed || !parsed.startsWith(`${scheme}://`)) return null;
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    return null;
  }
  const authority = parsed.slice(`${scheme}://`.length).split("/", 1)[0];
  return url.protocol === `${scheme}:`
    && url.hostname.length > 0
    && url.username.length === 0
    && url.password.length === 0
    && url.search.length === 0
    && url.hash.length === 0
    && !authority.endsWith(":")
    && url.pathname === path
    ? parsed
    : null;
}

function parseManagementError(value: unknown): ManagementErrorCode | null {
  const input = exactObject(value, ["code", "message", "retryable"]);
  if (!input) return null;
  for (const code of Object.keys(MANAGEMENT_ERRORS) as ManagementErrorCode[]) {
    const expected = MANAGEMENT_ERRORS[code];
    if (
      input.code === expected.code
      && input.message === expected.message
      && input.retryable === expected.retryable
    ) return code;
  }
  return null;
}

function parseHostCredential(value: unknown): MobileRelayV2DashboardState["hostCredential"] | null {
  const input = record(value);
  if (!input || typeof input.status !== "string") return null;
  const base = {
    protocolVersion: 2 as const,
    credentialKind: "twcap2_grant" as const,
  };
  if (input.status === "missing" && exactObject(input, ["status"])) {
    return {
      ...base,
      status: "missing",
      credentialReference: null,
      expiresAtMs: null,
      error: null,
      retryable: null,
    };
  }
  if (input.status === "ready" && exactObject(input, [
    "status",
    "credentialReference",
    "expiresAtMs",
  ])) {
    const credentialReference = projectionOpaque(input.credentialReference, 256);
    const expiresAtMs = safeTimestamp(input.expiresAtMs);
    if (!credentialReference || expiresAtMs === null) {
      return null;
    }
    return {
      ...base,
      status: "ready",
      credentialReference,
      expiresAtMs,
      error: null,
      retryable: null,
    };
  }
  if (
    input.status === "failed"
    && exactObject(input, ["status", "retryable"])
    && typeof input.retryable === "boolean"
  ) {
    return {
      ...base,
      status: "failed",
      credentialReference: null,
      expiresAtMs: null,
      error: "Relay v2 host credential operation failed.",
      retryable: input.retryable,
    };
  }
  return null;
}

function parseCapabilities(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MOBILE_RELAY_V2_KNOWN_CAPABILITIES.length) {
    return null;
  }
  const allowed = new Set<string>(MOBILE_RELAY_V2_KNOWN_CAPABILITIES);
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string" || !allowed.has(candidate) || seen.has(candidate)) {
      return null;
    }
    seen.add(candidate);
  }
  return MOBILE_RELAY_V2_KNOWN_CAPABILITIES.filter((capability) => seen.has(capability));
}

function parseConnector(value: unknown): MobileRelayV2DashboardState["connector"] | null {
  const input = record(value);
  if (!input || typeof input.status !== "string") return null;
  if (input.status === "stopped" && exactObject(input, ["status"])) {
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
  if (input.status === "starting" && exactObject(input, ["status", "hostId"])) {
    const hostId = input.hostId === null ? null : projectionOpaque(input.hostId);
    if (input.hostId !== null && !hostId) return null;
    return {
      status: "starting",
      acknowledgement: null,
      hostId,
      connectorId: null,
      negotiatedCapabilityIntersection: [],
      exitCode: null,
      error: null,
      retryable: null,
    };
  }
  if (
    (input.status === "registered" || input.status === "registered_incomplete")
    && exactObject(input, [
      "status",
      "acknowledgement",
      "hostId",
      "connectorId",
      "negotiatedCapabilityIntersection",
    ])
  ) {
    const hostId = projectionOpaque(input.hostId);
    const connectorId = projectionOpaque(input.connectorId);
    const capabilities = parseCapabilities(input.negotiatedCapabilityIntersection);
    const complete = capabilities !== null
      && MOBILE_RELAY_V2_REQUIRED_CAPABILITIES.every(
        (capability) => capabilities.includes(capability),
      );
    if (
      input.acknowledgement !== "host.registered"
      || !hostId
      || !connectorId
      || !capabilities
      || (input.status === "registered") !== complete
    ) return null;
    return {
      status: input.status,
      acknowledgement: "host.registered",
      hostId,
      connectorId,
      negotiatedCapabilityIntersection: capabilities,
      exitCode: null,
      error: null,
      retryable: null,
    };
  }
  if (
    input.status === "failed"
    && exactObject(input, ["status", "retryable"])
    && typeof input.retryable === "boolean"
  ) {
    return {
      status: "failed",
      acknowledgement: null,
      hostId: null,
      connectorId: null,
      negotiatedCapabilityIntersection: [],
      exitCode: null,
      error: "Relay v2 connector failed.",
      retryable: input.retryable,
    };
  }
  if (input.status === "superseded" && exactObject(input, ["status"])) {
    return {
      status: "superseded",
      acknowledgement: null,
      hostId: null,
      connectorId: null,
      negotiatedCapabilityIntersection: [],
      exitCode: 78,
      error: "A newer authenticated connector replaced this process.",
      retryable: false,
    };
  }
  return null;
}

function parseEnrollment(
  value: unknown,
): MobileRelayV2DashboardState["enrollment"] | null {
  const input = record(value);
  if (!input || typeof input.status !== "string") return null;
  if (input.status === "idle" && exactObject(input, ["status"])) {
    return { status: "idle" };
  }
  if (input.status === "active" && exactObject(input, ["status", "review"])) {
    const review = exactObject(input.review, ["enrollment", "display", "renderArtifact"]);
    const enrollment = exactObject(
      review?.enrollment,
      ["enrollmentId", "expiresAtMs"],
    );
    const display = exactObject(
      review?.display,
      ["issuerUrl", "relayUrl", "hostId", "deviceLabel"],
    );
    const renderArtifact = exactObject(
      review?.renderArtifact,
      ["kind", "handle", "expiresAtMs"],
    );
    if (!review || !enrollment || !display || !renderArtifact) return null;
    const enrollmentId = projectionOpaque(enrollment.enrollmentId);
    const expiresAtMs = safeTimestamp(enrollment.expiresAtMs);
    const issuerUrl = projectionUrl(display.issuerUrl, "https", "/");
    const relayUrl = projectionUrl(display.relayUrl, "wss", "/client");
    const hostId = projectionOpaque(display.hostId);
    const deviceLabel = display.deviceLabel === null ? null : projectionOpaque(display.deviceLabel);
    const artifactExpiresAtMs = safeTimestamp(renderArtifact.expiresAtMs);
    const handle = projectionQrHandle(renderArtifact.handle);
    if (
      !enrollmentId
      || expiresAtMs === null
      || !issuerUrl
      || !relayUrl
      || !hostId
      || (display.deviceLabel !== null && !deviceLabel)
      || renderArtifact.kind !== "native_qr_handle"
      || !handle
      || artifactExpiresAtMs !== expiresAtMs
    ) return null;
    return {
      status: "active",
      review: {
        enrollment: { enrollmentId, expiresAtMs },
        display: { issuerUrl, relayUrl, hostId, deviceLabel },
        renderArtifact: {
          kind: "native_qr_handle",
          handle,
          expiresAtMs: artifactExpiresAtMs,
        },
      },
    };
  }
  if (input.status === "expired" && exactObject(input, [
    "status",
    "enrollmentId",
    "expiredAtMs",
  ])) {
    const enrollmentId = projectionOpaque(input.enrollmentId);
    const expiredAtMs = safeTimestamp(input.expiredAtMs);
    return enrollmentId && expiredAtMs !== null
      ? { status: "expired", enrollmentId, expiredAtMs }
      : null;
  }
  if (
    input.status === "failed"
    && exactObject(input, ["status", "intent", "retryable"])
    && (input.intent === "create" || input.intent === "retry" || input.intent === "rebuild")
    && typeof input.retryable === "boolean"
  ) {
    return {
      status: "failed",
      intent: input.intent,
      error: "Relay v2 enrollment failed.",
      retryable: input.retryable,
    };
  }
  return null;
}

function parseKnownClientGrant(
  value: unknown,
): MobileRelayV2DashboardState["knownClientGrant"] | null {
  const input = record(value);
  if (!input || typeof input.status !== "string") return null;
  if (input.status === "unknown" && exactObject(input, ["status"])) {
    return { status: "unknown" };
  }
  if (input.status === "active" && exactObject(input, ["status", "grantId"])) {
    const grantId = projectionOpaque(input.grantId);
    return grantId ? { status: "active", grantId } : null;
  }
  if (input.status === "revoked" && exactObject(input, [
    "status",
    "grantId",
    "revokedAtMs",
    "alreadyRevoked",
  ])) {
    const grantId = projectionOpaque(input.grantId);
    const revokedAtMs = safeTimestamp(input.revokedAtMs);
    return grantId && revokedAtMs !== null && typeof input.alreadyRevoked === "boolean"
      ? { status: "revoked", grantId, revokedAtMs, alreadyRevoked: input.alreadyRevoked }
      : null;
  }
  if (
    input.status === "failed"
    && exactObject(input, ["status", "grantId", "retryable"])
    && typeof input.retryable === "boolean"
  ) {
    const grantId = projectionOpaque(input.grantId);
    return grantId
      ? {
          status: "failed",
          grantId,
          error: "Relay v2 client grant revoke failed.",
          retryable: input.retryable,
        }
      : null;
  }
  return null;
}

function parseConnectedMobileDevices(
  value: unknown,
): MobileRelayV2DashboardState["connectedMobileDevices"] | null {
  if (!Array.isArray(value) || value.length > 256) return null;
  const grantIds = new Set<string>();
  const devices: MobileRelayV2DashboardState["connectedMobileDevices"][number][] = [];
  for (const candidate of value) {
    const input = exactObject(candidate, [
      "status", "grantId", "clientInstanceId", "connectionCount",
    ]);
    const grantId = projectionOpaque(input?.grantId);
    const clientInstanceId = projectionOpaque(input?.clientInstanceId);
    if (!input
      || input.status !== "connected"
      || !grantId
      || !clientInstanceId
      || !Number.isSafeInteger(input.connectionCount)
      || (input.connectionCount as number) <= 0
      || (input.connectionCount as number) > 256
      || grantIds.has(grantId)) return null;
    grantIds.add(grantId);
    devices.push({
      status: "connected",
      grantId,
      clientInstanceId,
      connectionCount: input.connectionCount as number,
    });
  }
  return devices;
}

function parseV2Projection(value: unknown): MobileRelayV2DashboardState | null {
  const input = exactObject(value, [
    "authority",
    "hostCredential",
    "connector",
    "enrollment",
    "knownClientGrant",
    "connectedMobileDevices",
  ]);
  const authority = exactObject(input?.authority, ["kind", "reason"]);
  if (!input || !authority || authority.kind !== "node" || authority.reason !== null) return null;
  const hostCredential = parseHostCredential(input.hostCredential);
  const connector = parseConnector(input.connector);
  const enrollment = parseEnrollment(input.enrollment);
  const knownClientGrant = parseKnownClientGrant(input.knownClientGrant);
  const connectedMobileDevices = parseConnectedMobileDevices(input.connectedMobileDevices);
  if (!hostCredential
    || !connector
    || !enrollment
    || !knownClientGrant
    || !connectedMobileDevices) return null;
  if (connector.status === "registered" && hostCredential.status !== "ready") return null;
  if (enrollment.status === "active") {
    if (
      connector.status !== "registered"
      || enrollment.review.display.hostId !== connector.hostId
    ) return null;
  }
  const normalized = normalizeMobileRelayV2DashboardState({
    authority: { kind: "node", reason: null },
    hostCredential,
    connector,
    enrollment,
    knownClientGrant,
    connectedMobileDevices,
  });
  return normalized.authority.kind === "node" ? normalized : null;
}

function decodeOutcome(value: unknown, operation: ManagementOperation): DecodedOutcome | null {
  const input = exactObject(value, ["protocolVersion", "requestId", "ok", "result", "error"]);
  if (!input || input.protocolVersion !== 2) return null;
  if (
    typeof input.requestId !== "string"
    || !REQUEST_ID_PATTERN.test(input.requestId)
  ) return null;

  if (input.ok === true && input.error === null) {
    const state = parseV2Projection(input.result);
    if (!state) return null;
    if (operation === "create_enrollment" && state.enrollment.status !== "active") return null;
    if (operation === "revoke_client_grant" && state.knownClientGrant.status !== "revoked") {
      return null;
    }
    return { kind: "state", state };
  }
  if (input.ok !== false || input.result !== null) return null;
  const code = parseManagementError(input.error);
  return code ? { kind: "error", code } : null;
}

function operationError(code: ManagementErrorCode): MobileRelayV2BackendOperationError {
  return new MobileRelayV2BackendOperationError(MANAGEMENT_ERRORS[code]);
}

function invalidOutcomeError(): MobileRelayV2BackendOperationError {
  return new MobileRelayV2BackendOperationError({
    code: "CHANNEL_CLOSED",
    message: "Relay v2 management returned an invalid outcome",
    retryable: false,
  });
}

function invalidInputError(): MobileRelayV2BackendOperationError {
  return operationError("INVALID_ARGUMENT");
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("Relay v2 management observation aborted");
  error.name = "AbortError";
  return error;
}

function callerCompletion<T>(completion: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return completion;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    completion.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function createEnrollmentInput(input: MobileRelayV2CreateEnrollmentInput): unknown {
  const deviceLabel = input.deviceLabel ?? null;
  if (deviceLabel !== null && (!opaque(deviceLabel) || credentialLike(deviceLabel))) {
    throw invalidInputError();
  }
  return { deviceLabel };
}

function revokeInput(input: MobileRelayV2RevokeClientGrantInput): unknown {
  const grantId = opaque(input.grantId);
  if (!grantId || credentialLike(grantId) || input.reason !== "user_revoked") {
    throw invalidInputError();
  }
  return { grantId, reason: "user_revoked" };
}

function artifactInput(input: MobileRelayV2ShowEnrollmentArtifactInput): unknown {
  if (!NATIVE_QR_HANDLE_PATTERN.test(input.handle)) throw invalidInputError();
  return { handle: input.handle };
}

function artifactCopyInput(input: MobileRelayV2CopyEnrollmentArtifactInput): unknown {
  if (
    !NATIVE_QR_HANDLE_PATTERN.test(input.handle)
    || !["issuer_url", "relay_url", "enrollment_link"].includes(input.field)
  ) throw invalidInputError();
  return { handle: input.handle, field: input.field };
}

function inlinePngInput(input: MobileRelayV2InlineEnrollmentArtifactPngInput): unknown {
  if (!NATIVE_QR_HANDLE_PATTERN.test(input.handle)) throw invalidInputError();
  return { handle: input.handle };
}

export function createRelayV2ManagementAdapter(
  invoke: ManagementInvoke,
): MobileRelayV2ProductAdapter {
  let barrier: Promise<void> = Promise.resolve();

  const enqueue = (
    operation: ManagementOperation,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<MobileRelayV2DashboardState> => {
    const completion = barrier.then(async () => {
      if (signal?.aborted) throw abortReason(signal);
      let raw: unknown;
      try {
        raw = await invoke(COMMAND, { operation, input });
      } catch (error) {
        const code = parseManagementError(error);
        throw code ? operationError(code) : invalidOutcomeError();
      }
      const outcome = decodeOutcome(raw, operation);
      if (!outcome) throw invalidOutcomeError();
      if (outcome.kind === "error") throw operationError(outcome.code);
      return outcome.state;
    });
    barrier = completion.then(
      () => undefined,
      () => undefined,
    );
    return callerCompletion(completion, signal);
  };

  return {
    status: (signal) => enqueue("status", null, signal),
    bootstrapHost: () => enqueue("bootstrap_host", null),
    refreshHost: () => enqueue("refresh_host", null),
    startConnector: () => enqueue("start_connector", null),
    stopConnector: () => enqueue("stop_connector", null),
    showEnrollmentArtifact: async (input) => {
      try {
        await invoke(SHOW_ARTIFACT_COMMAND, artifactInput(input));
      } catch (error) {
        const code = parseManagementError(error);
        throw code ? operationError(code) : invalidOutcomeError();
      }
    },
    copyEnrollmentArtifact: async (input) => {
      try {
        await invoke(COPY_ARTIFACT_COMMAND, artifactCopyInput(input));
      } catch (error) {
        const code = parseManagementError(error);
        throw code ? operationError(code) : invalidOutcomeError();
      }
    },
    inlineEnrollmentArtifactPng: async (input) => {
      try {
        const png = await invoke(INLINE_PNG_COMMAND, inlinePngInput(input));
        if (typeof png !== "string" || png.length === 0) throw invalidOutcomeError();
        return png;
      } catch (error) {
        if (error instanceof MobileRelayV2BackendOperationError) throw error;
        const code = parseManagementError(error);
        throw code ? operationError(code) : invalidOutcomeError();
      }
    },
    createEnrollment: (input) => {
      try {
        return enqueue("create_enrollment", createEnrollmentInput(input));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    revokeClientGrant: (input) => {
      try {
        return enqueue("revoke_client_grant", revokeInput(input));
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
}
