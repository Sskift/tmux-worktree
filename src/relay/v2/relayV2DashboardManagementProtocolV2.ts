import { Buffer } from "node:buffer";
import {
  decodeRelayV2StrictUtf8,
  parseRelayV2JsonObject,
  RelayV2JsonError,
  type RelayV2JsonValue,
} from "./strictJson.js";

export const RELAY_V2_DASHBOARD_MANAGEMENT_PROTOCOL_V2_CONTRACT =
  "tmux-worktree-dashboard-relay-v2-management-ipc";
export const RELAY_V2_DASHBOARD_MANAGEMENT_PROTOCOL_V2_VERSION = 2;
export const RELAY_V2_DASHBOARD_MANAGEMENT_PROTOCOL_V2_MAX_FRAME_PAYLOAD_BYTES = 16_384;

export const RELAY_V2_DASHBOARD_MANAGEMENT_REQUIRED_CAPABILITIES = Object.freeze([
  "error.structured.v1",
  "command.ledger.v1",
  "command.query.v1",
  "snapshot.revision.v1",
  "event.sequence.v1",
  "terminal.stream.resume.v1",
] as const);

const REQUEST_ID_PREFIX = "dmgmt2.";
const REQUEST_ID_PATTERN = /^dmgmt2\.[A-Za-z0-9_-]{21}[AQgw]$/;
const REQUEST_KEYS = Object.freeze(["protocolVersion", "requestId", "operation", "input"]);
const SEMVER_NUMERIC_IDENTIFIER = "(?:0|[1-9][0-9]*)";
const SEMVER_NON_NUMERIC_IDENTIFIER = "(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER_PRERELEASE_IDENTIFIER =
  `(?:${SEMVER_NUMERIC_IDENTIFIER}|${SEMVER_NON_NUMERIC_IDENTIFIER})`;
const ASCII_SEMVER_PATTERN = new RegExp(
  `^${SEMVER_NUMERIC_IDENTIFIER}\\.${SEMVER_NUMERIC_IDENTIFIER}\\.${SEMVER_NUMERIC_IDENTIFIER}`
  + `(?:-${SEMVER_PRERELEASE_IDENTIFIER}(?:\\.${SEMVER_PRERELEASE_IDENTIFIER})*)?`
  + "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
);
const REQUEST_JSON_LIMITS = Object.freeze({
  maxDepth: 8,
  maxDirectKeys: 32,
  maxTotalKeys: 32,
  maxNodes: 64,
});
const OPERATIONS = new Set<RelayV2DashboardManagementProtocolV2Operation>([
  "status",
  "bootstrap_host",
  "refresh_host",
  "start_connector",
  "stop_connector",
  "create_enrollment",
  "revoke_client_grant",
]);
const ERROR_VALUES = Object.freeze({
  UNAVAILABLE: Object.freeze({
    message: "Relay v2 management is unavailable",
    retryable: false,
  }),
  INVALID_ARGUMENT: Object.freeze({
    message: "Relay v2 management input is invalid",
    retryable: false,
  }),
  NOT_READY: Object.freeze({
    message: "Relay v2 management is not ready",
    retryable: false,
  }),
  BUSY: Object.freeze({
    message: "Relay v2 management is busy",
    retryable: true,
  }),
  OPERATION_FAILED: Object.freeze({
    message: "Relay v2 management operation failed",
    retryable: false,
  }),
} as const);
const CREDENTIAL_VALUE_PREFIXES = Object.freeze([
  "twcap2.",
  "twref2.",
  "twenroll2.",
  "twhostboot2.",
]);

export type RelayV2DashboardManagementProtocolV2Operation =
  | "status"
  | "bootstrap_host"
  | "refresh_host"
  | "start_connector"
  | "stop_connector"
  | "create_enrollment"
  | "revoke_client_grant";

export type RelayV2DashboardManagementProtocolV2Request =
  | Readonly<{
      protocolVersion: 2;
      requestId: string;
      operation:
        | "status"
        | "bootstrap_host"
        | "refresh_host"
        | "start_connector"
        | "stop_connector";
      input: null;
    }>
  | Readonly<{
      protocolVersion: 2;
      requestId: string;
      operation: "create_enrollment";
      input: Readonly<{ deviceLabel: string | null }>;
    }>
  | Readonly<{
      protocolVersion: 2;
      requestId: string;
      operation: "revoke_client_grant";
      input: Readonly<{ grantId: string; reason: "user_revoked" }>;
    }>;

export type RelayV2DashboardManagementHostCredentialProjection =
  | Readonly<{ status: "missing" }>
  | Readonly<{ status: "ready"; credentialReference: string; expiresAtMs: number }>
  | Readonly<{ status: "failed"; retryable: boolean }>;

export type RelayV2DashboardManagementConnectorProjection =
  | Readonly<{ status: "stopped" }>
  | Readonly<{ status: "starting"; hostId: string | null }>
  | Readonly<{
      status: "registered" | "registered_incomplete";
      acknowledgement: "host.registered";
      hostId: string;
      connectorId: string;
      negotiatedCapabilityIntersection: readonly string[];
    }>
  | Readonly<{ status: "failed"; retryable: boolean }>
  | Readonly<{ status: "superseded" }>;

export type RelayV2DashboardManagementEnrollmentProjection =
  | Readonly<{ status: "idle" }>
  | Readonly<{
      status: "active";
      review: Readonly<{
        enrollment: Readonly<{
          enrollmentId: string;
          enrollmentCode: string;
          expiresAtMs: number;
        }>;
        display: Readonly<{
          issuerUrl: string;
          relayUrl: string;
          hostId: string;
          deviceLabel: string | null;
        }>;
      }>;
    }>
  | Readonly<{ status: "expired"; enrollmentId: string; expiredAtMs: number }>
  | Readonly<{ status: "failed"; intent: "create" | "retry" | "rebuild"; retryable: boolean }>;

export type RelayV2DashboardManagementKnownClientGrantProjection =
  | Readonly<{ status: "unknown" }>
  | Readonly<{ status: "active"; grantId: string }>
  | Readonly<{
      status: "revoked";
      grantId: string;
      revokedAtMs: number;
      alreadyRevoked: boolean;
    }>
  | Readonly<{ status: "failed"; grantId: string; retryable: boolean }>;

export interface RelayV2DashboardManagementProjection {
  authority: Readonly<{ kind: "node"; reason: null }>;
  hostCredential: RelayV2DashboardManagementHostCredentialProjection;
  connector: RelayV2DashboardManagementConnectorProjection;
  enrollment: RelayV2DashboardManagementEnrollmentProjection;
  knownClientGrant: RelayV2DashboardManagementKnownClientGrantProjection;
}

export type RelayV2DashboardManagementProtocolV2ErrorCode = keyof typeof ERROR_VALUES;

export type RelayV2DashboardManagementProtocolV2Response =
  | Readonly<{
      protocolVersion: 2;
      requestId: string;
      ok: true;
      result: RelayV2DashboardManagementProjection;
      error: null;
    }>
  | Readonly<{
      protocolVersion: 2;
      requestId: string;
      ok: false;
      result: null;
      error: Readonly<{
        code: RelayV2DashboardManagementProtocolV2ErrorCode;
        message: string;
        retryable: boolean;
      }>;
    }>;

export interface RelayV2DashboardManagementProtocolV2Handler {
  handle(
    request: RelayV2DashboardManagementProtocolV2Request,
  ): RelayV2DashboardManagementProtocolV2Response
    | Promise<RelayV2DashboardManagementProtocolV2Response>;
}

export class RelayV2DashboardManagementProtocolV2Error extends Error {
  constructor() {
    super("Relay v2 Dashboard management protocol v2 input is invalid");
    this.name = "RelayV2DashboardManagementProtocolV2Error";
  }
}

function invalid(): never {
  throw new RelayV2DashboardManagementProtocolV2Error();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isCanonicalRequestId(value: unknown): value is string {
  if (typeof value !== "string" || !REQUEST_ID_PATTERN.test(value)) return false;
  const suffix = value.slice(REQUEST_ID_PREFIX.length);
  let decoded: Buffer;
  try {
    decoded = Buffer.from(suffix, "base64url");
  } catch {
    return false;
  }
  return decoded.byteLength === 16 && decoded.toString("base64url") === suffix;
}

function containsCredentialLikeValue(value: string): boolean {
  const lower = value.toLowerCase();
  return CREDENTIAL_VALUE_PREFIXES.some((prefix) => lower.includes(prefix));
}

function validOpaque(
  value: unknown,
  maximumBytes: number,
  options: { allowEnrollmentCode?: boolean } = {},
): value is string {
  if (typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > maximumBytes
    || value.trim() !== value
    || value.includes("\0")
    || value.includes("\r")
    || value.includes("\n")) {
    return false;
  }
  if (options.allowEnrollmentCode) {
    return value.startsWith("twenroll2.") && value.length > "twenroll2.".length;
  }
  return !containsCredentialLikeValue(value);
}

function validTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validManagementUrl(value: unknown, scheme: "https:" | "wss:", path: string): boolean {
  if (typeof value !== "string"
    || !value.startsWith(scheme === "https:" ? "https://" : "wss://")
    || !value.includes("//")
    || !/^[\x21-\x7e]+$/.test(value)
    || Buffer.byteLength(value, "utf8") > 2_048
    || containsCredentialLikeValue(value)) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const authority = value.slice(value.indexOf("//") + 2).split("/", 1)[0];
  return parsed.protocol === scheme
    && parsed.hostname.length > 0
    && parsed.username === ""
    && parsed.password === ""
    && parsed.search === ""
    && parsed.hash === ""
    && !authority.endsWith(":")
    && parsed.pathname === path;
}

function decodeInput(
  operation: RelayV2DashboardManagementProtocolV2Operation,
  input: RelayV2JsonValue,
): RelayV2DashboardManagementProtocolV2Request["input"] {
  if (operation === "status"
    || operation === "bootstrap_host"
    || operation === "refresh_host"
    || operation === "start_connector"
    || operation === "stop_connector") {
    if (input !== null) return invalid();
    return null;
  }
  if (input === null || Array.isArray(input) || typeof input !== "object") return invalid();
  if (operation === "create_enrollment") {
    if (!hasExactKeys(input, ["deviceLabel"])) return invalid();
    const deviceLabel = input.deviceLabel;
    if (deviceLabel !== null && !validOpaque(deviceLabel, 128)) return invalid();
    return Object.freeze({ deviceLabel });
  }
  if (!hasExactKeys(input, ["grantId", "reason"])
    || !validOpaque(input.grantId, 128)
    || input.reason !== "user_revoked") {
    return invalid();
  }
  return Object.freeze({ grantId: input.grantId, reason: "user_revoked" });
}

export function decodeRelayV2DashboardManagementProtocolV2Request(
  framePayload: Uint8Array,
): RelayV2DashboardManagementProtocolV2Request {
  if (!(framePayload instanceof Uint8Array)
    || framePayload.byteLength === 0
    || framePayload.byteLength
      > RELAY_V2_DASHBOARD_MANAGEMENT_PROTOCOL_V2_MAX_FRAME_PAYLOAD_BYTES
    || (framePayload.byteLength >= 3
      && framePayload[0] === 0xef
      && framePayload[1] === 0xbb
      && framePayload[2] === 0xbf)
    || framePayload.includes(0x0a)
    || framePayload.includes(0x0d)) {
    return invalid();
  }
  let source: string;
  try {
    source = decodeRelayV2StrictUtf8(framePayload);
  } catch (error) {
    if (!(error instanceof RelayV2JsonError)) throw error;
    return invalid();
  }
  if (!source.startsWith("{") || !source.endsWith("}")) return invalid();
  let value: Record<string, RelayV2JsonValue>;
  try {
    value = parseRelayV2JsonObject(source, REQUEST_JSON_LIMITS);
  } catch (error) {
    if (!(error instanceof RelayV2JsonError)) throw error;
    return invalid();
  }
  if (!hasExactKeys(value, REQUEST_KEYS)
    || value.protocolVersion !== RELAY_V2_DASHBOARD_MANAGEMENT_PROTOCOL_V2_VERSION
    || !isCanonicalRequestId(value.requestId)
    || typeof value.operation !== "string"
    || !OPERATIONS.has(value.operation as RelayV2DashboardManagementProtocolV2Operation)) {
    return invalid();
  }
  const operation = value.operation as RelayV2DashboardManagementProtocolV2Operation;
  const input = decodeInput(operation, value.input);
  return Object.freeze({
    protocolVersion: RELAY_V2_DASHBOARD_MANAGEMENT_PROTOCOL_V2_VERSION,
    requestId: value.requestId,
    operation,
    input,
  }) as RelayV2DashboardManagementProtocolV2Request;
}

export function encodeRelayV2DashboardManagementProtocolV2ReadyFrame(
  runtimeVersion: string,
): string {
  if (typeof runtimeVersion !== "string"
    || Buffer.byteLength(runtimeVersion, "utf8") < 5
    || Buffer.byteLength(runtimeVersion, "utf8") > 128
    || !ASCII_SEMVER_PATTERN.test(runtimeVersion)) {
    throw new TypeError("invalid bundled CLI package version");
  }
  return `${JSON.stringify({
    contract: RELAY_V2_DASHBOARD_MANAGEMENT_PROTOCOL_V2_CONTRACT,
    protocolVersion: RELAY_V2_DASHBOARD_MANAGEMENT_PROTOCOL_V2_VERSION,
    runtimeVersion,
  })}\n`;
}

function validateHostCredential(value: unknown): value is RelayV2DashboardManagementHostCredentialProjection {
  if (!isObject(value) || typeof value.status !== "string") return false;
  if (value.status === "missing") return hasExactKeys(value, ["status"]);
  if (value.status === "ready") {
    return hasExactKeys(value, ["status", "credentialReference", "expiresAtMs"])
      && validOpaque(value.credentialReference, 256)
      && validTimestamp(value.expiresAtMs);
  }
  return value.status === "failed"
    && hasExactKeys(value, ["status", "retryable"])
    && typeof value.retryable === "boolean";
}

function validateCapabilities(value: unknown, complete: boolean): value is readonly string[] {
  if (!Array.isArray(value)
    || value.length > RELAY_V2_DASHBOARD_MANAGEMENT_REQUIRED_CAPABILITIES.length) {
    return false;
  }
  const values = value as unknown[];
  const seen = new Set<string>();
  for (const capability of values) {
    if (typeof capability !== "string"
      || !(RELAY_V2_DASHBOARD_MANAGEMENT_REQUIRED_CAPABILITIES as readonly string[])
        .includes(capability)
      || seen.has(capability)) {
      return false;
    }
    seen.add(capability);
  }
  const hasAll = RELAY_V2_DASHBOARD_MANAGEMENT_REQUIRED_CAPABILITIES.every(
    (capability) => seen.has(capability),
  );
  return hasAll === complete;
}

function validateConnector(value: unknown): value is RelayV2DashboardManagementConnectorProjection {
  if (!isObject(value) || typeof value.status !== "string") return false;
  if (value.status === "stopped" || value.status === "superseded") {
    return hasExactKeys(value, ["status"]);
  }
  if (value.status === "starting") {
    return hasExactKeys(value, ["status", "hostId"])
      && (value.hostId === null || validOpaque(value.hostId, 128));
  }
  if (value.status === "failed") {
    return hasExactKeys(value, ["status", "retryable"])
      && typeof value.retryable === "boolean";
  }
  if (value.status !== "registered" && value.status !== "registered_incomplete") return false;
  return hasExactKeys(value, [
    "status",
    "acknowledgement",
    "hostId",
    "connectorId",
    "negotiatedCapabilityIntersection",
  ])
    && value.acknowledgement === "host.registered"
    && validOpaque(value.hostId, 128)
    && validOpaque(value.connectorId, 128)
    && validateCapabilities(
      value.negotiatedCapabilityIntersection,
      value.status === "registered",
    );
}

function validateEnrollment(value: unknown): value is RelayV2DashboardManagementEnrollmentProjection {
  if (!isObject(value) || typeof value.status !== "string") return false;
  if (value.status === "idle") return hasExactKeys(value, ["status"]);
  if (value.status === "expired") {
    return hasExactKeys(value, ["status", "enrollmentId", "expiredAtMs"])
      && validOpaque(value.enrollmentId, 128)
      && validTimestamp(value.expiredAtMs);
  }
  if (value.status === "failed") {
    return hasExactKeys(value, ["status", "intent", "retryable"])
      && (value.intent === "create" || value.intent === "retry" || value.intent === "rebuild")
      && typeof value.retryable === "boolean";
  }
  if (value.status !== "active" || !hasExactKeys(value, ["status", "review"])
    || !isObject(value.review) || !hasExactKeys(value.review, ["enrollment", "display"])
    || !isObject(value.review.enrollment)
    || !hasExactKeys(value.review.enrollment, ["enrollmentId", "enrollmentCode", "expiresAtMs"])
    || !validOpaque(value.review.enrollment.enrollmentId, 128)
    || !validOpaque(value.review.enrollment.enrollmentCode, 512, { allowEnrollmentCode: true })
    || !validTimestamp(value.review.enrollment.expiresAtMs)
    || !isObject(value.review.display)
    || !hasExactKeys(value.review.display, ["issuerUrl", "relayUrl", "hostId", "deviceLabel"])
    || !validManagementUrl(value.review.display.issuerUrl, "https:", "/")
    || !validManagementUrl(value.review.display.relayUrl, "wss:", "/client")
    || !validOpaque(value.review.display.hostId, 128)
    || (value.review.display.deviceLabel !== null
      && !validOpaque(value.review.display.deviceLabel, 128))) {
    return false;
  }
  return true;
}

function validateKnownGrant(value: unknown): value is RelayV2DashboardManagementKnownClientGrantProjection {
  if (!isObject(value) || typeof value.status !== "string") return false;
  if (value.status === "unknown") return hasExactKeys(value, ["status"]);
  if (value.status === "active") {
    return hasExactKeys(value, ["status", "grantId"])
      && validOpaque(value.grantId, 128);
  }
  if (value.status === "failed") {
    return hasExactKeys(value, ["status", "grantId", "retryable"])
      && validOpaque(value.grantId, 128)
      && typeof value.retryable === "boolean";
  }
  return value.status === "revoked"
    && hasExactKeys(value, ["status", "grantId", "revokedAtMs", "alreadyRevoked"])
    && validOpaque(value.grantId, 128)
    && validTimestamp(value.revokedAtMs)
    && typeof value.alreadyRevoked === "boolean";
}

function validateProjection(
  value: unknown,
  operation: RelayV2DashboardManagementProtocolV2Operation,
): value is RelayV2DashboardManagementProjection {
  if (!isObject(value) || !hasExactKeys(value, [
    "authority",
    "hostCredential",
    "connector",
    "enrollment",
    "knownClientGrant",
  ])
    || !isObject(value.authority)
    || !hasExactKeys(value.authority, ["kind", "reason"])
    || value.authority.kind !== "node"
    || value.authority.reason !== null
    || !validateHostCredential(value.hostCredential)
    || !validateConnector(value.connector)
    || !validateEnrollment(value.enrollment)
    || !validateKnownGrant(value.knownClientGrant)) {
    return false;
  }
  if (value.connector.status === "registered"
    && value.hostCredential.status !== "ready") return false;
  if (value.enrollment.status === "active") {
    if (value.connector.status !== "registered"
      || value.hostCredential.status !== "ready"
      || value.enrollment.review.display.hostId !== value.connector.hostId) return false;
  }
  if (operation === "create_enrollment" && value.enrollment.status !== "active") return false;
  if (operation === "revoke_client_grant"
    && value.knownClientGrant.status !== "revoked") return false;
  return true;
}

function validateResponse(
  response: unknown,
  operation: RelayV2DashboardManagementProtocolV2Operation,
): asserts response is RelayV2DashboardManagementProtocolV2Response {
  if (!isObject(response)
    || !hasExactKeys(response, ["protocolVersion", "requestId", "ok", "result", "error"])
    || response.protocolVersion !== RELAY_V2_DASHBOARD_MANAGEMENT_PROTOCOL_V2_VERSION
    || !isCanonicalRequestId(response.requestId)) return invalid();
  if (response.ok === true) {
    if (response.error !== null || !validateProjection(response.result, operation)) return invalid();
    return;
  }
  if (response.ok !== false || response.result !== null || !isObject(response.error)
    || !hasExactKeys(response.error, ["code", "message", "retryable"])
    || typeof response.error.code !== "string"
    || !Object.hasOwn(ERROR_VALUES, response.error.code)) return invalid();
  const expected = ERROR_VALUES[
    response.error.code as RelayV2DashboardManagementProtocolV2ErrorCode
  ];
  if (response.error.message !== expected.message
    || response.error.retryable !== expected.retryable) return invalid();
}

export function createRelayV2DashboardManagementProtocolV2FailureResponse(
  requestId: string,
  code: RelayV2DashboardManagementProtocolV2ErrorCode,
): RelayV2DashboardManagementProtocolV2Response {
  if (!isCanonicalRequestId(requestId) || !Object.hasOwn(ERROR_VALUES, code)) return invalid();
  const fixed = ERROR_VALUES[code];
  return Object.freeze({
    protocolVersion: RELAY_V2_DASHBOARD_MANAGEMENT_PROTOCOL_V2_VERSION,
    requestId,
    ok: false,
    result: null,
    error: Object.freeze({ code, message: fixed.message, retryable: fixed.retryable }),
  });
}

export function encodeRelayV2DashboardManagementProtocolV2ResponseFrame(
  response: RelayV2DashboardManagementProtocolV2Response,
  request: RelayV2DashboardManagementProtocolV2Request,
): string {
  if (!OPERATIONS.has(request.operation)
    || response.requestId !== request.requestId) return invalid();
  validateResponse(response, request.operation);
  const frame = JSON.stringify(response);
  if (Buffer.byteLength(frame, "utf8")
    > RELAY_V2_DASHBOARD_MANAGEMENT_PROTOCOL_V2_MAX_FRAME_PAYLOAD_BYTES) return invalid();
  return `${frame}\n`;
}
