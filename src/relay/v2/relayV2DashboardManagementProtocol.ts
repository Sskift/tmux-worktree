import { Buffer } from "node:buffer";
import {
  decodeRelayV2StrictUtf8,
  parseRelayV2JsonObject,
  RelayV2JsonError,
  type RelayV2JsonValue,
} from "./strictJson.js";

export const RELAY_V2_DASHBOARD_MANAGEMENT_CONTRACT =
  "tmux-worktree-dashboard-relay-v2-management-ipc";
export const RELAY_V2_DASHBOARD_MANAGEMENT_PROTOCOL_VERSION = 1;
export const RELAY_V2_DASHBOARD_MANAGEMENT_MAX_FRAME_PAYLOAD_BYTES = 16_384;

const REQUEST_ID_PREFIX = "dmgmt1.";
const REQUEST_ID_PATTERN = /^dmgmt1\.[A-Za-z0-9_-]{21}[AQgw]$/;
const SEMVER_NUMERIC_IDENTIFIER = "(?:0|[1-9][0-9]*)";
const SEMVER_NON_NUMERIC_IDENTIFIER = "(?:[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER_PRERELEASE_IDENTIFIER =
  `(?:${SEMVER_NUMERIC_IDENTIFIER}|${SEMVER_NON_NUMERIC_IDENTIFIER})`;
const ASCII_SEMVER_PATTERN = new RegExp(
  `^${SEMVER_NUMERIC_IDENTIFIER}\\.${SEMVER_NUMERIC_IDENTIFIER}\\.${SEMVER_NUMERIC_IDENTIFIER}`
  + `(?:-${SEMVER_PRERELEASE_IDENTIFIER}(?:\\.${SEMVER_PRERELEASE_IDENTIFIER})*)?`
  + "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
);
const REQUEST_KEYS = Object.freeze(["protocolVersion", "requestId", "operation"]);
const OPERATIONS = new Set<RelayV2DashboardManagementOperation>([
  "status",
  "bootstrap_host",
  "refresh_host",
  "start_connector",
  "stop_connector",
  "create_enrollment",
  "revoke_client_grant",
]);
const REQUEST_JSON_LIMITS = Object.freeze({
  maxDepth: 8,
  maxDirectKeys: 32,
  maxTotalKeys: 32,
  maxNodes: 64,
});

export type RelayV2DashboardManagementOperation =
  | "status"
  | "bootstrap_host"
  | "refresh_host"
  | "start_connector"
  | "stop_connector"
  | "create_enrollment"
  | "revoke_client_grant";

export interface RelayV2DashboardManagementRequest {
  protocolVersion: 1;
  requestId: string;
  operation: RelayV2DashboardManagementOperation;
}

export interface RelayV2DashboardManagementStatusResponse {
  protocolVersion: 1;
  requestId: string;
  ok: true;
  result: {
    availability: "unavailable";
    capabilities: readonly [];
    reason: "default_off";
  };
  error: null;
}

export interface RelayV2DashboardManagementUnavailableResponse {
  protocolVersion: 1;
  requestId: string;
  ok: false;
  result: null;
  error: {
    code: "UNAVAILABLE";
    message: "Relay v2 management is unavailable";
    retryable: false;
  };
}

export type RelayV2DashboardManagementResponse =
  | RelayV2DashboardManagementStatusResponse
  | RelayV2DashboardManagementUnavailableResponse;

export interface RelayV2DashboardManagementHandler {
  handle(
    request: RelayV2DashboardManagementRequest,
  ): RelayV2DashboardManagementResponse;
}

export class RelayV2DashboardManagementProtocolError extends Error {
  constructor() {
    super("Relay v2 Dashboard management protocol input is invalid");
    this.name = "RelayV2DashboardManagementProtocolError";
  }
}

function invalidRequest(): never {
  throw new RelayV2DashboardManagementProtocolError();
}

function hasExactRequestKeys(value: Record<string, RelayV2JsonValue>): boolean {
  const keys = Object.keys(value);
  return keys.length === REQUEST_KEYS.length
    && REQUEST_KEYS.every((key) => Object.hasOwn(value, key));
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

export function decodeRelayV2DashboardManagementRequest(
  framePayload: Uint8Array,
): RelayV2DashboardManagementRequest {
  if (!(framePayload instanceof Uint8Array)
    || framePayload.byteLength === 0
    || framePayload.byteLength > RELAY_V2_DASHBOARD_MANAGEMENT_MAX_FRAME_PAYLOAD_BYTES
    || (framePayload.byteLength >= 3
      && framePayload[0] === 0xef
      && framePayload[1] === 0xbb
      && framePayload[2] === 0xbf)
    || framePayload.includes(0x0a)
    || framePayload.includes(0x0d)) {
    return invalidRequest();
  }

  let source: string;
  try {
    source = decodeRelayV2StrictUtf8(framePayload);
  } catch (error) {
    if (!(error instanceof RelayV2JsonError)) throw error;
    return invalidRequest();
  }
  if (!source.startsWith("{") || !source.endsWith("}")) return invalidRequest();

  let value: Record<string, RelayV2JsonValue>;
  try {
    value = parseRelayV2JsonObject(source, REQUEST_JSON_LIMITS);
  } catch (error) {
    if (!(error instanceof RelayV2JsonError)) throw error;
    return invalidRequest();
  }

  if (!hasExactRequestKeys(value)
    || value.protocolVersion !== RELAY_V2_DASHBOARD_MANAGEMENT_PROTOCOL_VERSION
    || !isCanonicalRequestId(value.requestId)
    || typeof value.operation !== "string"
    || !OPERATIONS.has(value.operation as RelayV2DashboardManagementOperation)) {
    return invalidRequest();
  }

  return Object.freeze({
    protocolVersion: RELAY_V2_DASHBOARD_MANAGEMENT_PROTOCOL_VERSION,
    requestId: value.requestId,
    operation: value.operation as RelayV2DashboardManagementOperation,
  });
}

export function encodeRelayV2DashboardManagementReadyFrame(
  runtimeVersion: string,
): string {
  if (typeof runtimeVersion !== "string"
    || Buffer.byteLength(runtimeVersion, "utf8") < 5
    || Buffer.byteLength(runtimeVersion, "utf8") > 128
    || !ASCII_SEMVER_PATTERN.test(runtimeVersion)) {
    throw new TypeError("invalid bundled CLI package version");
  }
  return `${JSON.stringify({
    contract: RELAY_V2_DASHBOARD_MANAGEMENT_CONTRACT,
    protocolVersion: RELAY_V2_DASHBOARD_MANAGEMENT_PROTOCOL_VERSION,
    runtimeVersion,
  })}\n`;
}

export function encodeRelayV2DashboardManagementResponseFrame(
  response: RelayV2DashboardManagementResponse,
): string {
  return `${JSON.stringify(response)}\n`;
}

/**
 * Permanent v1 default-off authority. It has no injected ports and therefore
 * cannot observe or mutate credential, enrollment, grant, or connector state.
 */
export function createRelayV2DashboardManagementDefaultOffHandler():
  RelayV2DashboardManagementHandler {
  return Object.freeze({
    handle(request: RelayV2DashboardManagementRequest): RelayV2DashboardManagementResponse {
      if (request.operation === "status") {
        return {
          protocolVersion: RELAY_V2_DASHBOARD_MANAGEMENT_PROTOCOL_VERSION,
          requestId: request.requestId,
          ok: true,
          result: {
            availability: "unavailable",
            capabilities: [],
            reason: "default_off",
          },
          error: null,
        };
      }
      return {
        protocolVersion: RELAY_V2_DASHBOARD_MANAGEMENT_PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: false,
        result: null,
        error: {
          code: "UNAVAILABLE",
          message: "Relay v2 management is unavailable",
          retryable: false,
        },
      };
    },
  });
}
