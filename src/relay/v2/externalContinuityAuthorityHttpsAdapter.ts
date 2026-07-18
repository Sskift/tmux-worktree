import { randomBytes } from "node:crypto";

import {
  RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION,
  type RelayV2ContinuityAnchorCasRequest,
  type RelayV2ContinuityAnchorReadRequest,
  type RelayV2MonotonicCasAuthority,
} from "./continuityAnchor.js";
import {
  decodeRelayV2StrictUtf8,
  parseRelayV2JsonObject,
  type RelayV2JsonValue,
} from "./strictJson.js";
import {
  createRelayV2SingleExchangeNodeHttpsTransport,
  performRelayV2SingleExchangeHttps,
  readRelayV2SingleExchangeAbortState,
  type RelayV2SingleExchangeNodeHttpsRequest,
  type RelayV2SingleExchangeHttpsTransport,
  type RelayV2SingleExchangeHttpsTransportExchange,
  type RelayV2SingleExchangeHttpsTransportRequest,
  type RelayV2SingleExchangeHttpsTransportResponse,
} from "./singleExchangeHttpsTransport.js";

const CONTRACT_VERSION = 1 as const;
const MAX_ENDPOINT_BYTES = 2_048;
const MAX_BODY_BYTES = 16_384;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_KEYS = 32;
const MAX_JSON_NODES = 128;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const OPERATION_ID_PREFIX = "twca1.";

const FIXED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "cache-control",
  "content-length",
  "content-type",
  "host",
  "connection",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export const RELAY_V2_EXTERNAL_CONTINUITY_HTTPS_BODY_BYTES = MAX_BODY_BYTES;

export type RelayV2ExternalContinuityNamespace =
  | "broker-credential.v1"
  | "agent-transcript-lifecycle.v1";

export type RelayV2ExternalContinuityHttpsAdapterErrorCode =
  | "ANCHOR_UNAVAILABLE"
  | "ANCHOR_COMMIT_UNCERTAIN";

export class RelayV2ExternalContinuityHttpsAdapterError extends Error {
  constructor(readonly code: RelayV2ExternalContinuityHttpsAdapterErrorCode) {
    super(
      code === "ANCHOR_UNAVAILABLE"
        ? "Relay v2 external continuity authority is unavailable"
        : "Relay v2 external continuity authority commit is uncertain",
    );
    this.name = "RelayV2ExternalContinuityHttpsAdapterError";
  }
}

export type RelayV2ExternalContinuityHttpsTransportRequest =
  RelayV2SingleExchangeHttpsTransportRequest;
export type RelayV2ExternalContinuityHttpsTransportResponse =
  RelayV2SingleExchangeHttpsTransportResponse;
export type RelayV2ExternalContinuityHttpsTransportExchange =
  RelayV2SingleExchangeHttpsTransportExchange;
export type RelayV2ExternalContinuityHttpsTransport =
  RelayV2SingleExchangeHttpsTransport;

export function createRelayV2ExternalContinuityNodeHttpsTransport(
  request?: RelayV2SingleExchangeNodeHttpsRequest,
): RelayV2ExternalContinuityHttpsTransport {
  const transport = createRelayV2SingleExchangeNodeHttpsTransport(request);
  return {
    start(input): RelayV2ExternalContinuityHttpsTransportExchange {
      const exchange = transport.start(input);
      return {
        response: Promise.resolve(exchange.response).catch(() => {
          throw new Error("Relay v2 external continuity HTTPS transport failed");
        }),
        abort: () => { exchange.abort(); },
      };
    },
  };
}

export interface RelayV2ExternalContinuityHttpsAdapterOptions {
  endpoint: string;
  securityDomainId: string;
  namespace: RelayV2ExternalContinuityNamespace;
  anchorId: string;
  /**
   * Resolves workload authentication in-process for one attempt. The adapter
   * never accepts credential material in its endpoint or persisted options.
   */
  authenticationHeaders(): Readonly<Record<string, string>>;
  /** Isolated test seam; production composition is intentionally absent. */
  transport?: RelayV2ExternalContinuityHttpsTransport;
}

type ExternalOperation = "read" | "compare_and_swap";

const EXTERNAL_ERROR_DEFINITIONS = {
  AUTHENTICATION_FAILED: {
    operations: ["read", "compare_and_swap"], retryable: false, retryAfter: false, cas: "proven_no_commit",
  },
  PERMISSION_DENIED: {
    operations: ["read", "compare_and_swap"], retryable: false, retryAfter: false, cas: "proven_no_commit",
  },
  MALFORMED_REQUEST: {
    operations: ["read", "compare_and_swap"], retryable: false, retryAfter: false, cas: "proven_no_commit",
  },
  IDEMPOTENCY_CONFLICT: {
    operations: ["read", "compare_and_swap"], retryable: false, retryAfter: false, cas: "proven_no_commit",
  },
  QUOTA_EXCEEDED: {
    operations: ["read", "compare_and_swap"], retryable: false, retryAfter: false, cas: "proven_no_commit",
  },
  CAPACITY_EXHAUSTED: {
    operations: ["read", "compare_and_swap"], retryable: true, retryAfter: true, cas: "proven_no_commit",
  },
  RATE_LIMITED: {
    operations: ["read", "compare_and_swap"], retryable: true, retryAfter: true, cas: "proven_no_commit",
  },
  TIMEOUT: {
    operations: ["read", "compare_and_swap"], retryable: false, retryAfter: false, cas: "uncertain",
  },
  UNAVAILABLE: {
    operations: ["read", "compare_and_swap"], retryable: false, retryAfter: false, cas: "uncertain",
  },
  RESULT_UNCERTAIN: {
    operations: ["compare_and_swap"], retryable: false, retryAfter: false, cas: "uncertain",
  },
  STALE_READ: {
    operations: ["read"], retryable: false, retryAfter: false, cas: "not_applicable",
  },
  RECOVERY_ROLLBACK: {
    operations: ["read", "compare_and_swap"], retryable: false, retryAfter: false, cas: "proven_no_commit",
  },
  ANCHOR_RETIRED: {
    operations: ["read", "compare_and_swap"], retryable: false, retryAfter: false, cas: "proven_no_commit",
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") <= 128
    && IDENTIFIER.test(value);
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return value instanceof AbortSignal;
}

function mappedFailure(operation: ExternalOperation): RelayV2ExternalContinuityHttpsAdapterError {
  return new RelayV2ExternalContinuityHttpsAdapterError(
    operation === "read" ? "ANCHOR_UNAVAILABLE" : "ANCHOR_COMMIT_UNCERTAIN",
  );
}

function validateEndpoint(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > MAX_ENDPOINT_BYTES
    || value.includes("?")
    || value.includes("#")
  ) {
    throw new TypeError("Relay v2 external continuity HTTPS endpoint is invalid");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError("Relay v2 external continuity HTTPS endpoint is invalid");
  }
  if (
    endpoint.protocol !== "https:"
    || endpoint.hostname.length === 0
    || endpoint.username.length !== 0
    || endpoint.password.length !== 0
    || endpoint.search.length !== 0
    || endpoint.hash.length !== 0
  ) {
    throw new TypeError("Relay v2 external continuity HTTPS endpoint is invalid");
  }
  return value;
}

function operationId(): string {
  return `${OPERATION_ID_PREFIX}${randomBytes(32).toString("base64url")}`;
}

function encodeRequestBody(value: Record<string, unknown>): Uint8Array {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new Error("Relay v2 external continuity HTTPS request is invalid");
  }
  const body = Buffer.from(encoded, "utf8");
  if (body.byteLength > MAX_BODY_BYTES) {
    throw new Error("Relay v2 external continuity HTTPS request is invalid");
  }
  return body;
}

function requestHeaders(
  bodyLength: number,
  authenticationHeaders: () => Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  let authentication: Readonly<Record<string, string>>;
  try {
    authentication = authenticationHeaders();
  } catch {
    throw new Error("Relay v2 external continuity HTTPS authentication is unavailable");
  }
  if (!isRecord(authentication)) {
    throw new Error("Relay v2 external continuity HTTPS authentication is unavailable");
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Accept-Encoding": "identity",
    "Content-Length": String(bodyLength),
  };
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(authentication)) {
    const normalized = name.toLowerCase();
    if (
      !HEADER_NAME.test(name)
      || FIXED_REQUEST_HEADERS.has(normalized)
      || seen.has(normalized)
      || typeof value !== "string"
      || /[\0\r\n]/.test(value)
    ) {
      throw new Error("Relay v2 external continuity HTTPS authentication is unavailable");
    }
    seen.add(normalized);
    headers[name] = value;
  }
  return Object.freeze(headers);
}

function rawHeaderValues(
  response: RelayV2ExternalContinuityHttpsTransportResponse,
  requestedName: string,
): string[] | null {
  const values: string[] = [];
  for (const pair of response.headers) {
    if (
      !Array.isArray(pair)
      || pair.length !== 2
      || typeof pair[0] !== "string"
      || typeof pair[1] !== "string"
    ) return null;
    if (pair[0].toLowerCase() === requestedName) values.push(pair[1]);
  }
  return values;
}

function acceptedContentLength(
  response: RelayV2ExternalContinuityHttpsTransportResponse,
): number | null | undefined {
  const values = rawHeaderValues(response, "content-length");
  if (values === null || values.length > 1) return undefined;
  if (values.length === 0) return null;
  if (!/^[0-9]+$/.test(values[0]!)) return undefined;
  const length = Number(values[0]);
  if (!Number.isSafeInteger(length) || length > MAX_BODY_BYTES) return undefined;
  return length;
}

function acceptedResponseHeaders(
  response: RelayV2ExternalContinuityHttpsTransportResponse,
): number | null | undefined {
  if (response.statusCode !== 200) return undefined;
  const contentType = rawHeaderValues(response, "content-type");
  const cacheControl = rawHeaderValues(response, "cache-control");
  const contentEncoding = rawHeaderValues(response, "content-encoding");
  if (
    contentType === null
    || cacheControl === null
    || contentEncoding === null
    || contentType.length !== 1
    || contentType[0] !== "application/json"
    || cacheControl.length !== 1
    || cacheControl[0] !== "no-store"
    || contentEncoding.length > 1
    || (contentEncoding.length === 1 && contentEncoding[0] !== "identity")
  ) return undefined;
  return acceptedContentLength(response);
}

async function readBoundedBody(
  response: RelayV2ExternalContinuityHttpsTransportResponse,
  declaredLength: number | null,
): Promise<Uint8Array> {
  const storage = Buffer.allocUnsafe(MAX_BODY_BYTES);
  let received = 0;
  for await (const chunk of response.body) {
    if (!(chunk instanceof Uint8Array) || chunk.byteLength > MAX_BODY_BYTES - received) {
      throw new Error("Relay v2 external continuity HTTPS response is invalid");
    }
    storage.set(chunk, received);
    received += chunk.byteLength;
  }
  if (declaredLength !== null && declaredLength !== received) {
    throw new Error("Relay v2 external continuity HTTPS response is invalid");
  }
  return storage.subarray(0, received);
}

function validExternalError(
  value: unknown,
  operation: ExternalOperation,
): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [
    "code", "message", "retryable", "retryAfterMs", "commitDisposition",
  ])) return false;
  if (typeof value.code !== "string" || !Object.hasOwn(EXTERNAL_ERROR_DEFINITIONS, value.code)) {
    return false;
  }
  const definition = EXTERNAL_ERROR_DEFINITIONS[
    value.code as keyof typeof EXTERNAL_ERROR_DEFINITIONS
  ];
  if (!(definition.operations as readonly string[]).includes(operation)) return false;
  if (value.message !== null || value.retryable !== definition.retryable) return false;
  if (definition.retryAfter) {
    if (
      !Number.isSafeInteger(value.retryAfterMs)
      || (value.retryAfterMs as number) < 0
    ) return false;
  } else if (value.retryAfterMs !== null) return false;
  return value.commitDisposition === (
    operation === "read" ? "not_applicable" : definition.cas
  );
}

function decodeResponseEnvelope(
  bytes: Uint8Array,
  operation: ExternalOperation,
  expectedOperationId: string,
): unknown {
  let envelope: { [key: string]: RelayV2JsonValue };
  try {
    envelope = parseRelayV2JsonObject(decodeRelayV2StrictUtf8(bytes), {
      maxDepth: MAX_JSON_DEPTH,
      maxDirectKeys: MAX_JSON_KEYS,
      maxTotalKeys: MAX_JSON_KEYS,
      maxNodes: MAX_JSON_NODES,
    });
  } catch {
    throw mappedFailure(operation);
  }
  if (
    !hasExactKeys(envelope, ["contractVersion", "operationId", "ok", "result", "error"])
    || envelope.contractVersion !== CONTRACT_VERSION
    || envelope.operationId !== expectedOperationId
    || typeof envelope.ok !== "boolean"
  ) throw mappedFailure(operation);

  if (envelope.ok) {
    if (envelope.error !== null) throw mappedFailure(operation);
    return envelope.result;
  }
  if (envelope.result !== null || !validExternalError(envelope.error, operation)) {
    throw mappedFailure(operation);
  }
  // Even a well-formed definite CAS rejection cannot authorize a blind retry.
  throw mappedFailure(operation);
}

export class RelayV2ExternalContinuityAuthorityHttpsAdapter
implements RelayV2MonotonicCasAuthority {
  private readonly endpoint: string;
  private readonly securityDomainId: string;
  private readonly namespace: RelayV2ExternalContinuityNamespace;
  private readonly anchorId: string;
  private readonly authenticationHeaders: () => Readonly<Record<string, string>>;
  private readonly transport: RelayV2ExternalContinuityHttpsTransport;

  constructor(options: RelayV2ExternalContinuityHttpsAdapterOptions) {
    if (
      !isRecord(options)
      || !hasExactKeys(options, [
        "endpoint", "securityDomainId", "namespace", "anchorId", "authenticationHeaders",
        ...(Object.hasOwn(options, "transport") ? ["transport"] : []),
      ])
      || !isIdentifier(options.securityDomainId)
      || !isIdentifier(options.anchorId)
      || !(["broker-credential.v1", "agent-transcript-lifecycle.v1"] as const)
        .includes(options.namespace as RelayV2ExternalContinuityNamespace)
      || typeof options.authenticationHeaders !== "function"
      || (options.transport !== undefined
        && (!isRecord(options.transport) || typeof options.transport.start !== "function"))
    ) {
      throw new TypeError("Relay v2 external continuity HTTPS adapter options are invalid");
    }
    this.endpoint = validateEndpoint(options.endpoint);
    this.securityDomainId = options.securityDomainId;
    this.namespace = options.namespace;
    this.anchorId = options.anchorId;
    this.authenticationHeaders = options.authenticationHeaders;
    this.transport = options.transport ?? createRelayV2ExternalContinuityNodeHttpsTransport();
  }

  read(request: RelayV2ContinuityAnchorReadRequest): Promise<unknown> {
    if (
      !isRecord(request)
      || !hasExactKeys(request, ["protocolVersion", "anchorId", "signal"])
      || request.protocolVersion !== RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION
      || request.anchorId !== this.anchorId
      || !isAbortSignal(request.signal)
    ) return Promise.reject(mappedFailure("read"));
    return this.perform("read", {}, request.signal);
  }

  compareAndSwap(request: RelayV2ContinuityAnchorCasRequest): Promise<unknown> {
    if (
      !isRecord(request)
      || !hasExactKeys(request, ["protocolVersion", "anchorId", "expected", "next", "signal"])
      || request.protocolVersion !== RELAY_V2_CONTINUITY_ANCHOR_PROTOCOL_VERSION
      || request.anchorId !== this.anchorId
      || !isAbortSignal(request.signal)
    ) return Promise.reject(mappedFailure("compare_and_swap"));
    return this.perform("compare_and_swap", {
      expected: request.expected,
      next: request.next,
    }, request.signal);
  }

  private async perform(
    operation: ExternalOperation,
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (readRelayV2SingleExchangeAbortState(signal) !== false) {
      throw mappedFailure(operation);
    }

    const requestOperationId = operationId();
    let body: Uint8Array;
    let headers: Readonly<Record<string, string>>;
    try {
      body = encodeRequestBody({
        contractVersion: CONTRACT_VERSION,
        operationId: requestOperationId,
        securityDomainId: this.securityDomainId,
        namespace: this.namespace,
        anchorId: this.anchorId,
        operation,
        payload,
      });
      headers = requestHeaders(body.byteLength, this.authenticationHeaders);
    } catch {
      throw mappedFailure(operation);
    }
    if (readRelayV2SingleExchangeAbortState(signal) !== false) {
      throw mappedFailure(operation);
    }

    const outcome = await performRelayV2SingleExchangeHttps({
      transport: this.transport,
      request: {
        endpoint: this.endpoint,
        method: "POST",
        headers,
        body,
      },
      signal,
      consume: async (received) => {
        const contentLength = acceptedResponseHeaders(received);
        if (contentLength === undefined) throw mappedFailure(operation);
        const bytes = await readBoundedBody(received, contentLength);
        return decodeResponseEnvelope(bytes, operation, requestOperationId);
      },
    });
    if (outcome.kind === "completed") return outcome.value;
    throw mappedFailure(operation);
  }
}
