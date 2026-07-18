import { decodeRelayV2AuthUtf8, parseRelayV2AuthJson } from "./authJson.js";
import {
  isRelayV2BrokerCredentialAuthorityError,
  type RelayV2BrokerCredentialAuthorityErrorCode,
  type RelayV2BrokerCredentialGrantCredential,
  type RelayV2BrokerCredentialHttpSourceAdmission,
} from "./brokerCredentialAuthority.js";
import {
  validateRelayV2HttpsBody,
  type RelayV2JsonObject,
} from "./codecSchema.js";

export const RELAY_V2_BROKER_HOST_BOOTSTRAP_PATH = "/v2/hosts/bootstrap";
export const RELAY_V2_BROKER_CREDENTIAL_HTTP_BODY_BYTES = 16_384;

const JSON_CONTENT_TYPE = "application/json";
const NO_STORE = "no-store";
const SOURCE_ENDPOINT = "host_bootstrap" as const;

export type RelayV2BrokerHostBootstrapHttpStatus =
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

export interface RelayV2BrokerHostBootstrapHttpHeader {
  readonly name: string;
  readonly value: string;
}

export interface RelayV2BrokerHostBootstrapHttpBody
extends AsyncIterable<Uint8Array> {
  cancel?(): void | Promise<void>;
}

export interface RelayV2BrokerHostBootstrapHttpRequest {
  readonly method: string;
  /** Exact pathname supplied by a future trusted HTTP server adapter. */
  readonly path: string;
  /**
   * Duplicate fields remain separate so this boundary can reject them. When
   * Content-Length is present, this boundary also requires the body iterator
   * to end at that exact byte count; future server framing is not trusted to
   * fill or truncate it on this adapter's behalf.
   */
  readonly headers: readonly RelayV2BrokerHostBootstrapHttpHeader[];
  readonly body: RelayV2BrokerHostBootstrapHttpBody;
}

export interface RelayV2BrokerHostBootstrapHttpResponse {
  readonly status: RelayV2BrokerHostBootstrapHttpStatus;
  readonly headers: Readonly<{
    "content-type": typeof JSON_CONTENT_TYPE;
    "cache-control": typeof NO_STORE;
  }>;
  readonly body: Uint8Array;
}

/**
 * The only credential behavior visible to this HTTP boundary. A production
 * composition may provide this port in the future; this module never opens or
 * constructs the authority or its store.
 */
export interface RelayV2BrokerHostBootstrapAuthorityPort {
  admitHttpSource(input: {
    endpoint: typeof SOURCE_ENDPOINT;
    sourceKey: string;
  }): Promise<RelayV2BrokerCredentialHttpSourceAdmission>;
  releaseHttpSourceAdmission(
    admission: RelayV2BrokerCredentialHttpSourceAdmission,
    endpoint: typeof SOURCE_ENDPOINT,
    sourceKey: string,
  ): void;
  bootstrapHost(
    admission: RelayV2BrokerCredentialHttpSourceAdmission,
    sourceKey: string,
    input: RelayV2BrokerHostBootstrapInput,
  ): Promise<RelayV2BrokerCredentialGrantCredential>;
}

export interface RelayV2BrokerHostBootstrapInput {
  bootstrapAttemptId: string;
  bootstrapToken: string;
  hostId: string;
  hostEpoch: string;
  hostInstanceId: string;
}

type ErrorCode =
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
  status: Exclude<RelayV2BrokerHostBootstrapHttpStatus, 200>;
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
  headers: readonly RelayV2BrokerHostBootstrapHttpHeader[],
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
  headers: readonly RelayV2BrokerHostBootstrapHttpHeader[],
  name: string,
  value: string,
): boolean {
  const values = headerValues(headers, name);
  return values.length === 1 && values[0] === value;
}

function contentLengthAdmission(
  headers: readonly RelayV2BrokerHostBootstrapHttpHeader[],
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

function encodeJson(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function errorResponse(mapping: ErrorMapping): RelayV2BrokerHostBootstrapHttpResponse {
  return Object.freeze({
    status: mapping.status,
    headers: RESPONSE_HEADERS,
    body: encodeJson({
      error: {
        code: mapping.code,
        message: mapping.message,
        retryable: mapping.retryable,
        retryAfterMs: mapping.retryAfterMs,
        commandDisposition: "not_applicable",
        details: null,
      },
    }),
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
      return {
        status: 503,
        code: "CAPABILITY_UNAVAILABLE",
        message: "Persistent credential authority is unavailable",
        retryable: false,
        retryAfterMs: null,
      };
  }
}

function closedErrorResponse(error: unknown): RelayV2BrokerHostBootstrapHttpResponse {
  try {
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
    // The body port is the trusted owner of its underlying transport. Trigger
    // it first, then best-effort the iterator seam; neither is awaited.
    invokeAbortSeam(body, "cancel");
    invokeAbortSeam(iterator, "return");
  };
}

async function readBoundedBody(
  body: RelayV2BrokerHostBootstrapHttpBody,
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
      // Check the boundary before copying even a single oversized chunk.
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

function parseBootstrapInput(bytes: Uint8Array): RelayV2BrokerHostBootstrapInput {
  const value = parseRelayV2AuthJson(decodeRelayV2AuthUtf8(bytes), {
    maxDepth: 8,
    maxKeys: 32,
    maxNodes: 128,
  });
  validateRelayV2HttpsBody(
    "host.bootstrap.request",
    value as RelayV2JsonObject,
  );
  const input = value as unknown as RelayV2BrokerHostBootstrapInput;
  return {
    bootstrapAttemptId: input.bootstrapAttemptId,
    bootstrapToken: input.bootstrapToken,
    hostId: input.hostId,
    hostEpoch: input.hostEpoch,
    hostInstanceId: input.hostInstanceId,
  };
}

function successResponse(
  result: RelayV2BrokerCredentialGrantCredential,
): RelayV2BrokerHostBootstrapHttpResponse {
  if (result.endpoint !== "host_bootstrap") {
    throw new Error("Relay v2 host bootstrap authority returned an invalid response");
  }
  validateRelayV2HttpsBody(
    "host.bootstrap.response",
    result.body as unknown as RelayV2JsonObject,
  );
  return Object.freeze({
    status: 200,
    headers: RESPONSE_HEADERS,
    body: encodeJson(result.body),
  });
}

/**
 * Strict, unwired POST /v2/hosts/bootstrap ingress foundation.
 *
 * `sourceKey` is deliberately a separate trusted-composition input. This
 * boundary never derives it from the URL, body, Forwarded, X-Forwarded-For,
 * or any other request header.
 */
export async function handleRelayV2BrokerHostBootstrapHttpIngress(
  authority: RelayV2BrokerHostBootstrapAuthorityPort,
  sourceKey: string,
  request: RelayV2BrokerHostBootstrapHttpRequest,
): Promise<RelayV2BrokerHostBootstrapHttpResponse> {
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
  if (
    request === null
    || typeof request !== "object"
    || method !== "POST"
    || path !== RELAY_V2_BROKER_HOST_BOOTSTRAP_PATH
  ) {
    abortBody(null);
    return errorResponse({ ...INVALID_REQUEST, status: 404 });
  }
  if (!Array.isArray(headers)) {
    abortBody(null);
    return errorResponse(INVALID_REQUEST);
  }
  const requestHeaders = headers as readonly RelayV2BrokerHostBootstrapHttpHeader[];

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
  // §1.2 does not freeze an ingress Accept requirement. It is intentionally
  // not used as an admission or response-selection signal here.

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
    admission = await authority.admitHttpSource({ endpoint: SOURCE_ENDPOINT, sourceKey });
  } catch (error) {
    abortBody(null);
    return closedErrorResponse(error);
  }

  const releaseAdmission = (): void => {
    if (admission === null) return;
    const owned = admission;
    admission = null;
    authority.releaseHttpSourceAdmission(owned, SOURCE_ENDPOINT, sourceKey);
  };

  const body = await readBoundedBody(
    bodyPort as RelayV2BrokerHostBootstrapHttpBody,
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

  let input: RelayV2BrokerHostBootstrapInput;
  try {
    input = parseBootstrapInput(body.bytes);
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
    const result = await authority.bootstrapHost(owned, sourceKey, input);
    return successResponse(result);
  } catch (error) {
    return closedErrorResponse(error);
  }
}
