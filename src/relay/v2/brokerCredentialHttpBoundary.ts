import {
  isRelayV2BrokerCredentialAuthorityError,
  type RelayV2BrokerCredentialAuthorityErrorCode,
  type RelayV2BrokerCredentialHttpSourceAdmission,
  type RelayV2BrokerCredentialHttpSourceEndpoint,
} from "./brokerCredentialAuthority.js";
import {
  decodeRelayV2HttpsBody,
  encodeRelayV2HttpsBody,
} from "./codec.js";
import type {
  RelayV2HttpsSchema,
  RelayV2JsonObject,
} from "./codecSchema.js";

export const RELAY_V2_BROKER_CREDENTIAL_HTTP_BODY_BYTES = 16_384;

const JSON_CONTENT_TYPE = "application/json";
const NO_STORE = "no-store";
const HTTP_ADMISSION_ERROR_BRAND = Symbol.for(
  "tmux-worktree.relay-v2.broker-credential-http-admission-error.v1",
);

export type RelayV2BrokerCredentialHttpStatus =
  | 200
  | 400
  | 401
  | 403
  | 404
  | 409
  | 413
  | 415
  | 429
  | 500
  | 503;

export interface RelayV2BrokerCredentialHttpHeader {
  readonly name: string;
  readonly value: string;
}

export interface RelayV2BrokerCredentialHttpBody
extends AsyncIterable<Uint8Array> {
  cancel?(): void | Promise<void>;
}

export interface RelayV2BrokerCredentialHttpRequest {
  readonly method: string;
  /** Exact pathname supplied by a future trusted HTTP server adapter. */
  readonly path: string;
  /** Duplicate fields stay separate so this boundary can reject them. */
  readonly headers: readonly RelayV2BrokerCredentialHttpHeader[];
  readonly body: RelayV2BrokerCredentialHttpBody;
}

export interface RelayV2BrokerCredentialHttpResponse {
  readonly status: RelayV2BrokerCredentialHttpStatus;
  readonly headers: Readonly<{
    "content-type": typeof JSON_CONTENT_TYPE;
    "cache-control": typeof NO_STORE;
  }>;
  readonly body: Uint8Array;
}

export interface RelayV2BrokerCredentialHttpSourceAuthorityPort {
  admitHttpSource(input: {
    endpoint: RelayV2BrokerCredentialHttpSourceEndpoint;
    sourceKey: string;
  }): Promise<RelayV2BrokerCredentialHttpSourceAdmission>;
  releaseHttpSourceAdmission(
    admission: RelayV2BrokerCredentialHttpSourceAdmission,
    endpoint: RelayV2BrokerCredentialHttpSourceEndpoint,
    sourceKey: string,
  ): void;
}

export interface RelayV2BrokerCredentialHttpBoundaryRoute<
  Authority extends RelayV2BrokerCredentialHttpSourceAuthorityPort,
> {
  readonly path: string;
  readonly sourceEndpoint: RelayV2BrokerCredentialHttpSourceEndpoint;
  readonly requestSchema: RelayV2HttpsSchema;
  readonly responseSchema: RelayV2HttpsSchema;
  /** Optional header authentication which still runs before body iteration. */
  authenticate?(
    authority: Authority,
    headers: readonly RelayV2BrokerCredentialHttpHeader[],
  ): Promise<unknown>;
  /**
   * Ownership of `admission` transfers here exactly once. The authority port
   * must consume it before any credential transition or rejection.
   */
  invoke(
    authority: Authority,
    admission: RelayV2BrokerCredentialHttpSourceAdmission,
    sourceKey: string,
    body: RelayV2JsonObject,
    authentication: unknown,
  ): Promise<RelayV2JsonObject>;
}

type ErrorCode =
  | "AUTH_REQUIRED"
  | "AUTH_INVALID"
  | "PERMISSION_DENIED"
  | "GRANT_NOT_FOUND"
  | "ROLE_MISMATCH"
  | "PROTOCOL_UNSUPPORTED"
  | "CAPABILITY_UNAVAILABLE"
  | "INVALID_ENVELOPE"
  | "IDEMPOTENCY_CONFLICT"
  | "RATE_LIMITED"
  | "BUSY"
  | "INTERNAL";

interface ErrorMapping {
  status: Exclude<RelayV2BrokerCredentialHttpStatus, 200>;
  code: ErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs: number | null;
}

type BoundedBodyResult =
  | { outcome: "success"; bytes: Uint8Array }
  | { outcome: "too_large" }
  | { outcome: "length_mismatch" }
  | { outcome: "read_failed" };

type ContentLengthAdmission =
  | { outcome: "absent"; length: null }
  | { outcome: "valid"; length: number }
  | { outcome: "invalid" }
  | { outcome: "too_large" };

class RelayV2BrokerCredentialHttpAdmissionError extends Error {
  readonly [HTTP_ADMISSION_ERROR_BRAND] = true;

  constructor(readonly mapping: ErrorMapping) {
    super("Relay v2 credential HTTP admission failed");
    this.name = "RelayV2BrokerCredentialHttpAdmissionError";
  }
}

const RESPONSE_HEADERS = Object.freeze({
  "content-type": JSON_CONTENT_TYPE,
  "cache-control": NO_STORE,
});

const INVALID_REQUEST: ErrorMapping = Object.freeze({
  status: 400,
  code: "INVALID_ENVELOPE",
  message: "Request is invalid",
  retryable: false,
  retryAfterMs: null,
});

function headerValues(
  headers: readonly RelayV2BrokerCredentialHttpHeader[],
  expectedName: string,
): string[] {
  const values: string[] = [];
  for (const header of headers) {
    if (
      header !== null
      && typeof header === "object"
      && typeof header.name === "string"
      && typeof header.value === "string"
      && header.name.toLowerCase() === expectedName
    ) values.push(header.value);
  }
  return values;
}

function exactHeader(
  headers: readonly RelayV2BrokerCredentialHttpHeader[],
  name: string,
  value: string,
): boolean {
  const values = headerValues(headers, name);
  return values.length === 1 && values[0] === value;
}

/** Returns the exact sensitive token without ever placing it in an error. */
export function requireRelayV2BrokerCredentialBearerAuthorization(
  headers: readonly RelayV2BrokerCredentialHttpHeader[],
): string {
  const values = headerValues(headers, "authorization");
  if (values.length === 0) {
    throw new RelayV2BrokerCredentialHttpAdmissionError({
      status: 401,
      code: "AUTH_REQUIRED",
      message: "Authorization is required",
      retryable: false,
      retryAfterMs: null,
    });
  }
  const value = values.length === 1 ? values[0] : null;
  const token = value?.startsWith("Bearer ") ? value.slice(7) : null;
  if (
    token === null
    || token.length === 0
    || token !== token.trim()
    || token.includes("\0")
    || Buffer.byteLength(token, "utf8") > 8_192
  ) {
    throw new RelayV2BrokerCredentialHttpAdmissionError({
      status: 401,
      code: "AUTH_INVALID",
      message: "Credential is invalid",
      retryable: false,
      retryAfterMs: null,
    });
  }
  return token;
}

function contentLengthAdmission(
  headers: readonly RelayV2BrokerCredentialHttpHeader[],
): ContentLengthAdmission {
  const values = headerValues(headers, "content-length");
  if (values.length === 0) return { outcome: "absent", length: null };
  if (values.length !== 1 || !/^(0|[1-9][0-9]*)$/.test(values[0])) {
    return { outcome: "invalid" };
  }
  let length: bigint;
  try {
    length = BigInt(values[0]);
  } catch {
    return { outcome: "invalid" };
  }
  return length > BigInt(RELAY_V2_BROKER_CREDENTIAL_HTTP_BODY_BYTES)
    ? { outcome: "too_large" }
    : { outcome: "valid", length: Number(length) };
}

function errorResponse(mapping: ErrorMapping): RelayV2BrokerCredentialHttpResponse {
  const body: RelayV2JsonObject = {
    error: {
      code: mapping.code,
      message: mapping.message,
      retryable: mapping.retryable,
      retryAfterMs: mapping.retryAfterMs,
      commandDisposition: "not_applicable",
      details: null,
    },
  };
  return Object.freeze({
    status: mapping.status,
    headers: RESPONSE_HEADERS,
    body: encodeRelayV2HttpsBody("error.response", body),
  });
}

function authorityErrorMapping(
  code: RelayV2BrokerCredentialAuthorityErrorCode,
): ErrorMapping {
  switch (code) {
    case "AUTH_INVALID":
      return {
        status: 401,
        code: "AUTH_INVALID",
        message: "Credential is invalid",
        retryable: false,
        retryAfterMs: null,
      };
    case "ROLE_MISMATCH":
      return {
        status: 403,
        code: "ROLE_MISMATCH",
        message: "Credential role does not match",
        retryable: false,
        retryAfterMs: null,
      };
    case "PERMISSION_DENIED":
      return {
        status: 403,
        code: "PERMISSION_DENIED",
        message: "Operation is not permitted",
        retryable: false,
        retryAfterMs: null,
      };
    case "GRANT_NOT_FOUND":
      return {
        status: 404,
        code: "GRANT_NOT_FOUND",
        message: "Grant was not found",
        retryable: false,
        retryAfterMs: null,
      };
    case "IDEMPOTENCY_CONFLICT":
      return {
        status: 409,
        code: "IDEMPOTENCY_CONFLICT",
        message: "Request conflicts with a prior attempt",
        retryable: false,
        retryAfterMs: null,
      };
    case "RATE_LIMITED":
      return {
        status: 429,
        code: "RATE_LIMITED",
        message: "Credential operation is rate limited",
        retryable: true,
        retryAfterMs: 1_000,
      };
    case "BUSY":
    case "STATE_CAPACITY_EXHAUSTED":
      return {
        status: 503,
        code: "BUSY",
        message: "Credential authority is busy",
        retryable: true,
        retryAfterMs: 1_000,
      };
    case "INVALID_ARGUMENT":
      return INVALID_REQUEST;
    case "STATE_INVALID":
    case "STATE_CONFLICT":
      return {
        status: 500,
        code: "INTERNAL",
        message: "Credential authority state is invalid",
        retryable: false,
        retryAfterMs: null,
      };
    case "AUTHORITY_NOT_READY":
    case "AUTHORITY_CLOSED":
    case "STORE_PUBLICATION_UNCERTAIN":
    case "EXTERNAL_ANCHOR_UNCERTAIN":
    case "EXTERNAL_ANCHOR_CONFLICT":
    case "EXTERNAL_CONTINUITY_UNAVAILABLE":
    case "EXTERNAL_CONTINUITY_INVALID":
    case "CLOSE_BARRIER_FAILED":
    case "LIVE_AUTHORIZATION_FENCE_UNAVAILABLE":
      return {
        status: 503,
        code: "CAPABILITY_UNAVAILABLE",
        message: "Persistent credential authority is unavailable",
        retryable: false,
        retryAfterMs: null,
      };
  }
}

function isAdmissionError(
  error: unknown,
): error is RelayV2BrokerCredentialHttpAdmissionError {
  try {
    if ((typeof error !== "object" && typeof error !== "function") || error === null) {
      return false;
    }
    return (error as Record<PropertyKey, unknown>)[HTTP_ADMISSION_ERROR_BRAND] === true
      && (error as RelayV2BrokerCredentialHttpAdmissionError).mapping !== undefined;
  } catch {
    return false;
  }
}

function closedErrorResponse(error: unknown): RelayV2BrokerCredentialHttpResponse {
  try {
    if (isAdmissionError(error)) return errorResponse(error.mapping);
    if (isRelayV2BrokerCredentialAuthorityError(error)) {
      return errorResponse(authorityErrorMapping(error.code));
    }
  } catch {
    // A malformed cross-entry error object still maps to the generic response.
  }
  return errorResponse({
    status: 500,
    code: "INTERNAL",
    message: "Credential request failed",
    retryable: false,
    retryAfterMs: null,
  });
}

function absorbAbortResult(value: unknown): void {
  try {
    void Promise.resolve(value).then(undefined, () => undefined);
  } catch {
    // A throwing thenable is still only an abort failure.
  }
}

function invokeAbortSeam(target: unknown, property: "cancel" | "return"): void {
  try {
    if ((typeof target !== "object" && typeof target !== "function") || target === null) {
      return;
    }
    const operation = (target as Record<string, unknown>)[property];
    if (typeof operation !== "function") return;
    absorbAbortResult(operation.call(target));
  } catch {
    // Getter, call, and thenable failures never replace the closed response.
  }
}

function oneShotBodyAbort(body: unknown): (iterator: unknown) => void {
  let triggered = false;
  return (iterator: unknown): void => {
    if (triggered) return;
    triggered = true;
    invokeAbortSeam(body, "cancel");
    invokeAbortSeam(iterator, "return");
  };
}

async function readBoundedBody(
  body: RelayV2BrokerCredentialHttpBody,
  declaredLength: number | null,
  abort: (iterator: unknown) => void,
): Promise<BoundedBodyResult> {
  let iterator: AsyncIterator<Uint8Array> | null = null;
  const bytes = new Uint8Array(RELAY_V2_BROKER_CREDENTIAL_HTTP_BODY_BYTES);
  let written = 0;
  try {
    iterator = body[Symbol.asyncIterator]();
    while (true) {
      const item = await iterator.next();
      if (item.done) {
        if (declaredLength !== null && written !== declaredLength) {
          abort(iterator);
          return { outcome: "length_mismatch" };
        }
        return { outcome: "success", bytes: bytes.slice(0, written) };
      }
      const chunk = item.value;
      if (!(chunk instanceof Uint8Array)) {
        abort(iterator);
        return { outcome: "read_failed" };
      }
      if (chunk.byteLength > RELAY_V2_BROKER_CREDENTIAL_HTTP_BODY_BYTES - written) {
        abort(iterator);
        return { outcome: "too_large" };
      }
      if (declaredLength !== null && chunk.byteLength > declaredLength - written) {
        abort(iterator);
        return { outcome: "length_mismatch" };
      }
      bytes.set(chunk, written);
      written += chunk.byteLength;
    }
  } catch {
    abort(iterator);
    return { outcome: "read_failed" };
  }
}

function successResponse(
  schema: RelayV2HttpsSchema,
  body: RelayV2JsonObject,
): RelayV2BrokerCredentialHttpResponse {
  return Object.freeze({
    status: 200,
    headers: RESPONSE_HEADERS,
    body: encodeRelayV2HttpsBody(schema, body),
  });
}

/**
 * Shared strict, unwired Relay v2 credential HTTP boundary. It owns no
 * listener, credential fact, parser, replay key, or readiness decision.
 */
export async function handleRelayV2BrokerCredentialHttpBoundary<
  Authority extends RelayV2BrokerCredentialHttpSourceAuthorityPort,
>(
  authority: Authority,
  sourceKey: string,
  request: RelayV2BrokerCredentialHttpRequest,
  routes: readonly RelayV2BrokerCredentialHttpBoundaryRoute<Authority>[],
): Promise<RelayV2BrokerCredentialHttpResponse> {
  let method: unknown;
  let path: unknown;
  let headers: unknown;
  let bodyPort: unknown;
  try {
    method = request?.method;
    path = request?.path;
    headers = request?.headers;
    bodyPort = request?.body;
  } catch {
    return errorResponse(INVALID_REQUEST);
  }
  const abortBody = oneShotBodyAbort(bodyPort);
  const route = typeof path === "string"
    ? routes.find((candidate) => candidate.path === path)
    : undefined;
  if (request === null || typeof request !== "object" || method !== "POST" || !route) {
    abortBody(null);
    return errorResponse({ ...INVALID_REQUEST, status: 404 });
  }
  if (!Array.isArray(headers)) {
    abortBody(null);
    return errorResponse(INVALID_REQUEST);
  }
  const requestHeaders = headers as readonly RelayV2BrokerCredentialHttpHeader[];

  let encodings: string[];
  let contentTypeAccepted: boolean;
  let cacheControlAccepted: boolean;
  let declaredLength: ContentLengthAdmission;
  try {
    encodings = headerValues(requestHeaders, "content-encoding");
    contentTypeAccepted = exactHeader(requestHeaders, "content-type", JSON_CONTENT_TYPE);
    cacheControlAccepted = exactHeader(requestHeaders, "cache-control", NO_STORE);
    declaredLength = contentLengthAdmission(requestHeaders);
  } catch {
    abortBody(null);
    return errorResponse(INVALID_REQUEST);
  }
  if (encodings.length > 1 || (encodings.length === 1 && encodings[0] !== "identity")) {
    abortBody(null);
    return errorResponse({
      status: 415,
      code: "PROTOCOL_UNSUPPORTED",
      message: "HTTP request encoding is unsupported",
      retryable: false,
      retryAfterMs: null,
    });
  }
  if (!contentTypeAccepted) {
    abortBody(null);
    return errorResponse({
      status: 415,
      code: "PROTOCOL_UNSUPPORTED",
      message: "HTTP content type is unsupported",
      retryable: false,
      retryAfterMs: null,
    });
  }
  if (!cacheControlAccepted) {
    abortBody(null);
    return errorResponse(INVALID_REQUEST);
  }
  if (declaredLength.outcome === "invalid") {
    abortBody(null);
    return errorResponse(INVALID_REQUEST);
  }
  if (declaredLength.outcome === "too_large") {
    abortBody(null);
    return errorResponse({ ...INVALID_REQUEST, status: 413 });
  }
  if (
    (typeof bodyPort !== "object" && typeof bodyPort !== "function")
    || bodyPort === null
  ) {
    abortBody(null);
    return errorResponse(INVALID_REQUEST);
  }

  let admission: RelayV2BrokerCredentialHttpSourceAdmission | null = null;
  try {
    admission = await authority.admitHttpSource({
      endpoint: route.sourceEndpoint,
      sourceKey,
    });
  } catch (error) {
    abortBody(null);
    return closedErrorResponse(error);
  }

  const releaseAdmission = (): void => {
    if (admission === null) return;
    const owned = admission;
    admission = null;
    authority.releaseHttpSourceAdmission(owned, route.sourceEndpoint, sourceKey);
  };

  let authentication: unknown;
  if (route.authenticate) {
    try {
      authentication = await route.authenticate(authority, requestHeaders);
    } catch (error) {
      abortBody(null);
      try {
        releaseAdmission();
      } catch (releaseError) {
        return closedErrorResponse(releaseError);
      }
      return closedErrorResponse(error);
    }
  }

  const body = await readBoundedBody(
    bodyPort as RelayV2BrokerCredentialHttpBody,
    declaredLength.length,
    abortBody,
  );
  if (body.outcome !== "success") {
    try {
      releaseAdmission();
    } catch (error) {
      return closedErrorResponse(error);
    }
    return body.outcome === "too_large"
      ? errorResponse({ ...INVALID_REQUEST, status: 413 })
      : errorResponse(INVALID_REQUEST);
  }

  let decoded: RelayV2JsonObject;
  try {
    decoded = decodeRelayV2HttpsBody(route.requestSchema, body.bytes).frame;
  } catch {
    try {
      releaseAdmission();
    } catch (error) {
      return closedErrorResponse(error);
    }
    return errorResponse(INVALID_REQUEST);
  }

  try {
    const owned = admission;
    admission = null;
    if (owned === null) return closedErrorResponse(new Error("missing admission"));
    const response = await route.invoke(
      authority,
      owned,
      sourceKey,
      decoded,
      authentication,
    );
    return successResponse(route.responseSchema, response);
  } catch (error) {
    return closedErrorResponse(error);
  }
}
