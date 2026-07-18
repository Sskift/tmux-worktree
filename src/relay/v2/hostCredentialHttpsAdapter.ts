import {
  decodeRelayV2HttpsBody,
  encodeRelayV2HttpsBody,
  RELAY_V2_HTTP_BODY_BYTES,
} from "./codec.js";
import type {
  RelayV2HttpsSchema,
  RelayV2JsonObject,
} from "./codecSchema.js";
import {
  createRelayV2SingleExchangeNodeHttpsTransport,
  performRelayV2SingleExchangeHttps,
  readRelayV2SingleExchangeAbortState,
  type RelayV2SingleExchangeHttpsTransport,
  type RelayV2SingleExchangeHttpsTransportResponse,
} from "./singleExchangeHttpsTransport.js";

const MAX_ISSUER_URL_BYTES = 2_048;
const JSON_CONTENT_TYPE = "application/json";
const NO_STORE = "no-store";
const IDENTITY = "identity";
const CREDENTIAL_ERROR_STATUSES = new Set([
  400, 401, 403, 404, 409, 413, 415, 429, 500, 503,
]);

export const RELAY_V2_HOST_BOOTSTRAP_HTTPS_PATH = "/v2/hosts/bootstrap";
export const RELAY_V2_HOST_TOKEN_REFRESH_HTTPS_PATH = "/v2/hosts/tokens/refresh";
export const RELAY_V2_HOST_CREDENTIAL_HTTPS_BODY_BYTES = RELAY_V2_HTTP_BODY_BYTES;

export type RelayV2HostCredentialHttpsAdapterErrorCode =
  | "CONFIGURATION_INVALID"
  | "REQUEST_INVALID"
  | "CREDENTIAL_REJECTED"
  | "EXCHANGE_FAILED"
  | "ABORTED";

/** A closed failure which never retains a URL, header, body, token, or cause. */
export class RelayV2HostCredentialHttpsAdapterError extends Error {
  readonly httpStatus: number | null;
  readonly errorCode: string | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(
    readonly code: RelayV2HostCredentialHttpsAdapterErrorCode,
    response?: {
      readonly httpStatus: number;
      readonly errorCode: string;
      readonly retryable: boolean;
      readonly retryAfterMs: number | null;
    },
  ) {
    super(
      code === "CONFIGURATION_INVALID"
        ? "Relay v2 host credential HTTPS configuration is invalid"
        : code === "REQUEST_INVALID"
          ? "Relay v2 host credential HTTPS request is invalid"
          : code === "ABORTED"
            ? "Relay v2 host credential HTTPS exchange was aborted"
            : code === "CREDENTIAL_REJECTED"
              ? "Relay v2 host credential HTTPS request was rejected"
              : "Relay v2 host credential HTTPS exchange failed",
    );
    this.name = "RelayV2HostCredentialHttpsAdapterError";
    this.httpStatus = response?.httpStatus ?? null;
    this.errorCode = response?.errorCode ?? null;
    this.retryable = response?.retryable ?? false;
    this.retryAfterMs = response?.retryAfterMs ?? null;
  }
}

export interface RelayV2HostBootstrapHttpsRequest {
  readonly bootstrapAttemptId: string;
  readonly bootstrapToken: string;
  readonly hostId: string;
  readonly hostEpoch: string;
  readonly hostInstanceId: string;
}

export interface RelayV2HostRefreshHttpsRequest {
  readonly refreshAttemptId: string;
  readonly grantId: string;
  readonly hostInstanceId: string;
  readonly refreshToken: string;
}

export interface RelayV2HostCredentialHttpsResponseFields {
  readonly principalId: string;
  readonly grantId: string;
  readonly hostId: string;
  readonly accessToken: string;
  readonly accessExpiresAtMs: number;
  readonly refreshToken: string;
  readonly refreshExpiresAtMs: number;
}

export interface RelayV2HostBootstrapHttpsResponse
extends RelayV2HostCredentialHttpsResponseFields {
  readonly bootstrapAttemptId: string;
}

export interface RelayV2HostRefreshHttpsResponse
extends RelayV2HostCredentialHttpsResponseFields {
  readonly refreshAttemptId: string;
}

export interface RelayV2HostCredentialHttpsAdapterOptions {
  /** Exact HTTPS issuer origin; request paths are selected only by this adapter. */
  readonly issuerUrl: string;
  /** Isolated test seam. No production composition is constructed here. */
  readonly transport?: RelayV2SingleExchangeHttpsTransport;
}

interface CredentialRejectionMetadata {
  readonly httpStatus: number;
  readonly errorCode: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
}

/** Private control-flow value: injected code cannot forge it through a public error class. */
class RelayV2HostCredentialInternalFailure {
  constructor(readonly rejection: CredentialRejectionMetadata | null) {}
}

const NON_RETRYABLE_CREDENTIAL_ERROR = Object.freeze({
  retryable: false,
  retryAfter: "null",
} as const);
const RETRYABLE_CREDENTIAL_ERROR = Object.freeze({
  retryable: true,
  retryAfter: "nonnegative_integer",
} as const);

function credentialErrorPolicy(
  httpStatus: number,
  errorCode: string,
): typeof NON_RETRYABLE_CREDENTIAL_ERROR | typeof RETRYABLE_CREDENTIAL_ERROR | undefined {
  switch (httpStatus) {
    case 400:
    case 413:
      return errorCode === "INVALID_ENVELOPE" ? NON_RETRYABLE_CREDENTIAL_ERROR : undefined;
    case 401:
      return errorCode === "AUTH_REQUIRED" || errorCode === "AUTH_INVALID"
        ? NON_RETRYABLE_CREDENTIAL_ERROR
        : undefined;
    case 403:
      return errorCode === "ROLE_MISMATCH" || errorCode === "PERMISSION_DENIED"
        ? NON_RETRYABLE_CREDENTIAL_ERROR
        : undefined;
    case 404:
      return errorCode === "GRANT_NOT_FOUND" || errorCode === "INVALID_ENVELOPE"
        ? NON_RETRYABLE_CREDENTIAL_ERROR
        : undefined;
    case 409:
      return errorCode === "IDEMPOTENCY_CONFLICT"
        ? NON_RETRYABLE_CREDENTIAL_ERROR
        : undefined;
    case 415:
      return errorCode === "PROTOCOL_UNSUPPORTED"
        ? NON_RETRYABLE_CREDENTIAL_ERROR
        : undefined;
    case 429:
      return errorCode === "RATE_LIMITED" ? RETRYABLE_CREDENTIAL_ERROR : undefined;
    case 500:
      return errorCode === "INTERNAL" ? NON_RETRYABLE_CREDENTIAL_ERROR : undefined;
    case 503:
      if (errorCode === "BUSY") return RETRYABLE_CREDENTIAL_ERROR;
      return errorCode === "CAPABILITY_UNAVAILABLE"
        ? NON_RETRYABLE_CREDENTIAL_ERROR
        : undefined;
    default:
      return undefined;
  }
}

function failure(
  code: RelayV2HostCredentialHttpsAdapterErrorCode,
): RelayV2HostCredentialHttpsAdapterError {
  return new RelayV2HostCredentialHttpsAdapterError(code);
}

function internalExchangeFailure(): RelayV2HostCredentialInternalFailure {
  return new RelayV2HostCredentialInternalFailure(null);
}

function internalCredentialRejection(value: unknown): CredentialRejectionMetadata | null {
  try {
    return value instanceof RelayV2HostCredentialInternalFailure
      ? value.rejection
      : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  let actual: PropertyKey[];
  try {
    actual = Reflect.ownKeys(value);
  } catch {
    return false;
  }
  return actual.length === expected.length
    && expected.every((key) => actual.includes(key));
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return value instanceof AbortSignal;
}

function validateIssuerOrigin(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || Buffer.byteLength(value, "utf8") > MAX_ISSUER_URL_BYTES
    || /[\0\r\n\s]/.test(value)
    || value.includes("?")
    || value.includes("#")
  ) throw failure("CONFIGURATION_INVALID");

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw failure("CONFIGURATION_INVALID");
  }
  const authoritySlash = value.indexOf("/", "https://".length);
  const rawAuthority = value.slice(
    "https://".length,
    authoritySlash === -1 ? value.length : authoritySlash,
  );
  const rawPath = authoritySlash === -1 ? "" : value.slice(authoritySlash);
  if (
    parsed.protocol !== "https:"
    || parsed.hostname.length === 0
    || rawAuthority.includes("@")
    || parsed.username.length !== 0
    || parsed.password.length !== 0
    || parsed.pathname !== "/"
    || (rawPath !== "" && rawPath !== "/")
    || parsed.search.length !== 0
    || parsed.hash.length !== 0
    || parsed.port === "0"
  ) throw failure("CONFIGURATION_INVALID");
  return parsed.origin;
}

function endpoint(origin: string, path: string): string {
  return `${origin}${path}`;
}

function requestHeaders(bodyLength: number): Readonly<Record<string, string>> {
  return Object.freeze({
    Accept: JSON_CONTENT_TYPE,
    "Content-Type": JSON_CONTENT_TYPE,
    "Cache-Control": NO_STORE,
    "Accept-Encoding": IDENTITY,
    "Content-Length": String(bodyLength),
  });
}

function rawHeaderValues(
  headers: readonly (readonly [name: string, value: string])[],
  requestedName: string,
): string[] | null {
  const values: string[] = [];
  for (const pair of headers) {
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
  headers: readonly (readonly [name: string, value: string])[],
): number | null | undefined {
  const values = rawHeaderValues(headers, "content-length");
  if (values === null || values.length > 1) return undefined;
  if (values.length === 0) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(values[0]!)) return undefined;
  const length = Number(values[0]);
  if (!Number.isSafeInteger(length) || length > RELAY_V2_HTTP_BODY_BYTES) {
    return undefined;
  }
  return length;
}

function acceptedResponse(
  response: RelayV2SingleExchangeHttpsTransportResponse,
): { readonly statusCode: number; readonly contentLength: number | null } | undefined {
  const statusCode = response.statusCode;
  if (
    statusCode !== 200
    && !CREDENTIAL_ERROR_STATUSES.has(statusCode)
  ) return undefined;
  const headers = response.headers;
  const contentType = rawHeaderValues(headers, "content-type");
  const cacheControl = rawHeaderValues(headers, "cache-control");
  const contentEncoding = rawHeaderValues(headers, "content-encoding");
  if (
    contentType === null
    || cacheControl === null
    || contentEncoding === null
    || contentType.length !== 1
    || contentType[0] !== JSON_CONTENT_TYPE
    || cacheControl.length !== 1
    || cacheControl[0] !== NO_STORE
    || contentEncoding.length > 1
    || (contentEncoding.length === 1 && contentEncoding[0] !== IDENTITY)
  ) return undefined;
  const contentLength = acceptedContentLength(headers);
  return contentLength === undefined ? undefined : { statusCode, contentLength };
}

async function readBoundedBody(
  response: RelayV2SingleExchangeHttpsTransportResponse,
  declaredLength: number | null,
): Promise<Uint8Array> {
  const storage = Buffer.allocUnsafe(RELAY_V2_HTTP_BODY_BYTES);
  let received = 0;
  for await (const chunk of response.body) {
    if (
      !(chunk instanceof Uint8Array)
      || chunk.byteLength > RELAY_V2_HTTP_BODY_BYTES - received
    ) throw internalExchangeFailure();
    storage.set(chunk, received);
    received += chunk.byteLength;
  }
  if (declaredLength !== null && declaredLength !== received) {
    throw internalExchangeFailure();
  }
  return storage.subarray(0, received);
}

function credentialRejection(
  httpStatus: number,
  frame: RelayV2JsonObject,
): RelayV2HostCredentialInternalFailure {
  const structured = frame.error;
  if (
    !isRecord(structured)
    || !hasExactKeys(structured, [
      "code", "message", "retryable", "retryAfterMs", "commandDisposition", "details",
    ])
    || typeof structured.code !== "string"
    || typeof structured.retryable !== "boolean"
    || structured.commandDisposition !== "not_applicable"
    || structured.details !== null
  ) throw internalExchangeFailure();

  const policy = credentialErrorPolicy(httpStatus, structured.code);
  if (
    policy === undefined
    || structured.retryable !== policy.retryable
    || (policy.retryAfter === "null"
      ? structured.retryAfterMs !== null
      : (typeof structured.retryAfterMs !== "number"
        || !Number.isSafeInteger(structured.retryAfterMs)
        || structured.retryAfterMs < 0))
  ) throw internalExchangeFailure();

  return new RelayV2HostCredentialInternalFailure(Object.freeze({
    httpStatus,
    errorCode: structured.code,
    retryable: structured.retryable,
    retryAfterMs: structured.retryAfterMs as number | null,
  }));
}

function bootstrapResponse(
  frame: RelayV2JsonObject,
  request: RelayV2JsonObject,
): RelayV2HostBootstrapHttpsResponse {
  if (
    frame.bootstrapAttemptId !== request.bootstrapAttemptId
    || frame.hostId !== request.hostId
  ) throw internalExchangeFailure();
  return Object.freeze({
    bootstrapAttemptId: frame.bootstrapAttemptId as string,
    principalId: frame.principalId as string,
    grantId: frame.grantId as string,
    hostId: frame.hostId as string,
    accessToken: frame.accessToken as string,
    accessExpiresAtMs: frame.accessExpiresAtMs as number,
    refreshToken: frame.refreshToken as string,
    refreshExpiresAtMs: frame.refreshExpiresAtMs as number,
  });
}

function refreshResponse(
  frame: RelayV2JsonObject,
  request: RelayV2JsonObject,
): RelayV2HostRefreshHttpsResponse {
  if (
    frame.refreshAttemptId !== request.refreshAttemptId
    || frame.grantId !== request.grantId
  ) throw internalExchangeFailure();
  return Object.freeze({
    refreshAttemptId: frame.refreshAttemptId as string,
    principalId: frame.principalId as string,
    grantId: frame.grantId as string,
    hostId: frame.hostId as string,
    accessToken: frame.accessToken as string,
    accessExpiresAtMs: frame.accessExpiresAtMs as number,
    refreshToken: frame.refreshToken as string,
    refreshExpiresAtMs: frame.refreshExpiresAtMs as number,
  });
}

/**
 * Stateless host credential HTTPS boundary.
 *
 * Attempt identity, timeout/retry policy, credential CAS/persistence, and
 * production wiring remain caller-owned. Each method starts at most one
 * transport exchange and retains no credential after the returned promise.
 */
export class RelayV2HostCredentialHttpsAdapter {
  private readonly issuerOrigin: string;
  private readonly transport: RelayV2SingleExchangeHttpsTransport;

  constructor(options: RelayV2HostCredentialHttpsAdapterOptions) {
    let issuerUrl: unknown;
    let transport: unknown;
    let validOptions = false;
    try {
      validOptions = isRecord(options)
        && hasExactKeys(options, [
          "issuerUrl",
          ...(Object.hasOwn(options, "transport") ? ["transport"] : []),
        ]);
      issuerUrl = validOptions ? options.issuerUrl : undefined;
      transport = validOptions ? options.transport : undefined;
    } catch {
      throw failure("CONFIGURATION_INVALID");
    }
    if (
      !validOptions
      || (transport !== undefined
        && (!isRecord(transport) || typeof transport.start !== "function"))
    ) throw failure("CONFIGURATION_INVALID");
    this.issuerOrigin = validateIssuerOrigin(issuerUrl);
    this.transport = transport as RelayV2SingleExchangeHttpsTransport | undefined
      ?? createRelayV2SingleExchangeNodeHttpsTransport();
  }

  bootstrap(
    input: RelayV2HostBootstrapHttpsRequest,
    signal: AbortSignal,
  ): Promise<RelayV2HostBootstrapHttpsResponse> {
    if (!isAbortSignal(signal)) return Promise.reject(failure("REQUEST_INVALID"));
    const aborted = readRelayV2SingleExchangeAbortState(signal);
    if (aborted === undefined) return Promise.reject(failure("EXCHANGE_FAILED"));
    if (aborted) return Promise.reject(failure("ABORTED"));
    let body: RelayV2JsonObject;
    try {
      body = {
        bootstrapAttemptId: input.bootstrapAttemptId,
        bootstrapToken: input.bootstrapToken,
        hostId: input.hostId,
        hostEpoch: input.hostEpoch,
        hostInstanceId: input.hostInstanceId,
      };
    } catch {
      return Promise.reject(failure("REQUEST_INVALID"));
    }
    return this.perform(
      RELAY_V2_HOST_BOOTSTRAP_HTTPS_PATH,
      "host.bootstrap.request",
      "host.bootstrap.response",
      body,
      signal,
      (frame) => bootstrapResponse(frame, body),
    );
  }

  refresh(
    input: RelayV2HostRefreshHttpsRequest,
    signal: AbortSignal,
  ): Promise<RelayV2HostRefreshHttpsResponse> {
    if (!isAbortSignal(signal)) return Promise.reject(failure("REQUEST_INVALID"));
    const aborted = readRelayV2SingleExchangeAbortState(signal);
    if (aborted === undefined) return Promise.reject(failure("EXCHANGE_FAILED"));
    if (aborted) return Promise.reject(failure("ABORTED"));
    let body: RelayV2JsonObject;
    try {
      body = {
        refreshAttemptId: input.refreshAttemptId,
        grantId: input.grantId,
        hostInstanceId: input.hostInstanceId,
        refreshToken: input.refreshToken,
      };
    } catch {
      return Promise.reject(failure("REQUEST_INVALID"));
    }
    return this.perform(
      RELAY_V2_HOST_TOKEN_REFRESH_HTTPS_PATH,
      "token.refresh.host.request",
      "token.refresh.host.response",
      body,
      signal,
      (frame) => refreshResponse(frame, body),
    );
  }

  private async perform<Result>(
    path: string,
    requestSchema: RelayV2HttpsSchema,
    responseSchema: RelayV2HttpsSchema,
    requestBody: RelayV2JsonObject,
    signal: AbortSignal,
    project: (frame: RelayV2JsonObject) => Result,
  ): Promise<Result> {
    let body: Uint8Array;
    try {
      body = encodeRelayV2HttpsBody(requestSchema, requestBody);
    } catch {
      throw failure("REQUEST_INVALID");
    }

    const outcome = await performRelayV2SingleExchangeHttps<
      Result,
      CredentialRejectionMetadata | null
    >({
      transport: this.transport,
      request: {
        endpoint: endpoint(this.issuerOrigin, path),
        method: "POST",
        headers: requestHeaders(body.byteLength),
        body,
      },
      signal,
      consume: async (received) => {
        const admitted = acceptedResponse(received);
        if (admitted === undefined) throw internalExchangeFailure();
        const bytes = await readBoundedBody(received, admitted.contentLength);
        if (admitted.statusCode === 200) {
          return project(decodeRelayV2HttpsBody(responseSchema, bytes).frame);
        }
        const decoded = decodeRelayV2HttpsBody("error.response", bytes).frame;
        throw credentialRejection(admitted.statusCode, decoded);
      },
      mapConsumeFailure: internalCredentialRejection,
    });
    if (outcome.kind === "completed") return outcome.value;
    if (outcome.kind === "aborted") throw failure("ABORTED");
    if (outcome.kind === "consume_failed" && outcome.failure != null) {
      throw new RelayV2HostCredentialHttpsAdapterError(
        "CREDENTIAL_REJECTED",
        outcome.failure,
      );
    }
    throw failure("EXCHANGE_FAILED");
  }
}
