import type { ClientRequest, IncomingMessage } from "node:http";
import {
  request as nodeHttpsRequest,
  type RequestOptions as NodeHttpsRequestOptions,
} from "node:https";
import { checkServerIdentity } from "node:tls";
import { types as nodeUtilTypes } from "node:util";
import {
  readRelayV2HostTlsCaTrustCut,
  type RelayV2HostTlsCaTrustCut,
} from "./hostTlsTrustMaterial.js";

const NODE_HTTPS_REQUEST =
  nodeHttpsRequest as RelayV2SingleExchangeNodeHttpsRequest;
const NODE_CHECK_SERVER_IDENTITY = checkServerIdentity;
const NODE_IS_PROXY = nodeUtilTypes.isProxy;
const NODE_IS_UINT8_ARRAY = nodeUtilTypes.isUint8Array;
const OBJECT_CREATE = Object.create;
const OBJECT_DEFINE_PROPERTIES = Object.defineProperties;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_HAS_OWN = Object.hasOwn;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const ARRAY_IS_ARRAY = Array.isArray;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const BUFFER_CONSTRUCTOR = Buffer;
const BUFFER_BYTE_LENGTH = BUFFER_CONSTRUCTOR.byteLength;
const BUFFER_FROM = BUFFER_CONSTRUCTOR.from;
const STRING_CONSTRUCTOR = String;
const ARRAY_BUFFER_CONSTRUCTOR = ArrayBuffer;
const UINT8_ARRAY_CONSTRUCTOR = Uint8Array;
const URL_CONSTRUCTOR = URL;
const TYPED_ARRAY_PROTOTYPE =
  OBJECT_GET_PROTOTYPE_OF(UINT8_ARRAY_CONSTRUCTOR.prototype);
const TYPED_ARRAY_BUFFER_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  TYPED_ARRAY_PROTOTYPE,
  "buffer",
)?.get;
const TYPED_ARRAY_BYTE_OFFSET_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  TYPED_ARRAY_PROTOTYPE,
  "byteOffset",
)?.get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)?.get;
const TYPED_ARRAY_LENGTH_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  TYPED_ARRAY_PROTOTYPE,
  "length",
)?.get;
const TYPED_ARRAY_SET = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  TYPED_ARRAY_PROTOTYPE,
  "set",
)?.value;

export interface RelayV2SingleExchangeHttpsTransportRequest {
  endpoint: string;
  method: "POST";
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}

export interface RelayV2SingleExchangeHttpsTransportResponse {
  statusCode: number;
  /** Raw pairs preserve duplicates for the owning protocol header gate. */
  headers: readonly (readonly [name: string, value: string])[];
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
}

export interface RelayV2SingleExchangeHttpsTransportExchange {
  response: PromiseLike<RelayV2SingleExchangeHttpsTransportResponse>;
  abort(): void;
}

export interface RelayV2SingleExchangeHttpsTransport {
  start(
    request: RelayV2SingleExchangeHttpsTransportRequest,
  ): RelayV2SingleExchangeHttpsTransportExchange;
}

export type RelayV2SingleExchangeHttpsErrorCode =
  | "ABORTED"
  | "TRANSPORT_FAILED";

/** Closed transport failure: it never retains endpoint, headers, body, or cause. */
export class RelayV2SingleExchangeHttpsError extends Error {
  constructor(readonly code: RelayV2SingleExchangeHttpsErrorCode) {
    super(
      code === "ABORTED"
        ? "Relay v2 single-exchange HTTPS request was aborted"
        : "Relay v2 single-exchange HTTPS transport failed",
    );
    this.name = "RelayV2SingleExchangeHttpsError";
  }
}

export type RelayV2SingleExchangeNodeHttpsRequest = (
  url: URL,
  options: NodeHttpsRequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

/**
 * One-attempt TLS material captured by an external trust/auth resolver. The
 * values extend — never weaken — the pinned peer verification below.
 */
export interface RelayV2SingleExchangeNodeHttpsTlsOptions {
  readonly ca?: readonly (string | Uint8Array)[];
  readonly cert?: string | Uint8Array;
  readonly key?: string | Uint8Array;
}

interface CapturedTlsOptions {
  readonly ca?: readonly (string | Uint8Array)[];
  readonly cert?: string | Uint8Array;
  readonly key?: string | Uint8Array;
}

interface MutableCapturedTlsOptions {
  ca?: readonly (string | Uint8Array)[];
  cert?: string | Uint8Array;
  key?: string | Uint8Array;
}

const EMPTY_CAPTURED_TLS_OPTIONS =
  OBJECT_FREEZE(OBJECT_CREATE(null)) as CapturedTlsOptions;

// Bounds on captured TLS material, chosen at the frozen outer-HTTPS magnitude
// (httpsBodyBytes 16384): a private trust bundle for one exact endpoint holds
// a small root/chain set and PEM/DER key material stays well under one body.
const MAX_CA_ENTRIES = 8;
const MAX_TLS_MATERIAL_BYTES = 16_384;
const MAX_CA_TOTAL_BYTES = 32_768;

interface CapturedTlsMaterial {
  readonly material: string | Uint8Array;
  readonly byteLength: number;
}

function captureTlsMaterial(
  value: string | Uint8Array,
): CapturedTlsMaterial {
  if (typeof value === "string") {
    const byteLength = BUFFER_BYTE_LENGTH(value, "utf8");
    if (byteLength > MAX_TLS_MATERIAL_BYTES) {
      throw new TypeError("Relay v2 single-exchange HTTPS TLS material is invalid");
    }
    return OBJECT_FREEZE({ material: value, byteLength });
  }
  if (value !== null
    && typeof value === "object"
    && !NODE_IS_PROXY(value)
    && NODE_IS_UINT8_ARRAY(value)
    && typeof TYPED_ARRAY_BYTE_LENGTH_GETTER === "function"
    && typeof TYPED_ARRAY_SET === "function") {
    let byteLength: unknown;
    try {
      byteLength = REFLECT_APPLY(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []);
    } catch {
      throw new TypeError("Relay v2 single-exchange HTTPS TLS material is invalid");
    }
    if (typeof byteLength !== "number"
      || !NUMBER_IS_SAFE_INTEGER(byteLength)
      || byteLength > MAX_TLS_MATERIAL_BYTES) {
      throw new TypeError("Relay v2 single-exchange HTTPS TLS material is invalid");
    }
    const copy = new UINT8_ARRAY_CONSTRUCTOR(byteLength);
    try {
      REFLECT_APPLY(TYPED_ARRAY_SET, copy, [value]);
    } catch {
      throw new TypeError("Relay v2 single-exchange HTTPS TLS material is invalid");
    }
    return OBJECT_FREEZE({ material: copy, byteLength });
  }
  throw new TypeError("Relay v2 single-exchange HTTPS TLS material is invalid");
}

/**
 * Snapshots TLS options exactly once. Every later check reads only the
 * snapshot; no foreign property is read again.
 */
function captureTlsOptions(
  value: RelayV2SingleExchangeNodeHttpsTlsOptions | undefined,
): CapturedTlsOptions {
  const invalid = (): TypeError =>
    new TypeError("Relay v2 single-exchange HTTPS TLS options are invalid");
  if (value === undefined) return EMPTY_CAPTURED_TLS_OPTIONS;
  if (!isRecord(value) || NODE_IS_PROXY(value)) throw invalid();
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
  } catch {
    throw invalid();
  }
  const keys = REFLECT_OWN_KEYS(descriptors);
  const snapshot: Record<string, unknown> = OBJECT_CREATE(null);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (typeof key !== "string"
      || (key !== "ca" && key !== "cert" && key !== "key")) throw invalid();
    const descriptor = descriptors[key];
    if (!descriptor || !OBJECT_HAS_OWN(descriptor, "value")) throw invalid();
    snapshot[key] = descriptor.value;
  }
  const captured: MutableCapturedTlsOptions = OBJECT_CREATE(null);
  if (snapshot.ca !== undefined) {
    if (!ARRAY_IS_ARRAY(snapshot.ca) || NODE_IS_PROXY(snapshot.ca)) {
      throw invalid();
    }
    let lengthDescriptor: PropertyDescriptor | undefined;
    let caDescriptors: PropertyDescriptorMap;
    try {
      lengthDescriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(snapshot.ca, "length");
      caDescriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(snapshot.ca);
    } catch {
      throw invalid();
    }
    if (lengthDescriptor === undefined
      || !OBJECT_HAS_OWN(lengthDescriptor, "value")
      || typeof lengthDescriptor.value !== "number"
      || !NUMBER_IS_SAFE_INTEGER(lengthDescriptor.value)
      || lengthDescriptor.value > MAX_CA_ENTRIES) throw invalid();
    const length = lengthDescriptor.value;
    const caKeys = REFLECT_OWN_KEYS(caDescriptors);
    if (caKeys.length !== length + 1 || caKeys[length] !== "length") throw invalid();
    const authorities: (string | Uint8Array)[] = [];
    let totalBytes = 0;
    for (let index = 0; index < length; index += 1) {
      const key = STRING_CONSTRUCTOR(index);
      if (caKeys[index] !== key) throw invalid();
      const descriptor = caDescriptors[key];
      if (!descriptor || !OBJECT_HAS_OWN(descriptor, "value")) throw invalid();
      const authority = captureTlsMaterial(descriptor.value as string | Uint8Array);
      totalBytes += authority.byteLength;
      if (totalBytes > MAX_CA_TOTAL_BYTES) throw invalid();
      authorities[index] = authority.material;
    }
    captured.ca = OBJECT_FREEZE(authorities);
  }
  if (snapshot.cert !== undefined) {
    captured.cert = captureTlsMaterial(
      snapshot.cert as string | Uint8Array,
    ).material;
  }
  if (snapshot.key !== undefined) {
    captured.key = captureTlsMaterial(
      snapshot.key as string | Uint8Array,
    ).material;
  }
  return OBJECT_FREEZE(captured);
}

function transportFailure(
  code: RelayV2SingleExchangeHttpsErrorCode,
): RelayV2SingleExchangeHttpsError {
  return new RelayV2SingleExchangeHttpsError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !ARRAY_IS_ARRAY(value);
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return value instanceof AbortSignal;
}

const ABORT_SIGNAL_ABORTED_GETTER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  AbortSignal.prototype,
  "aborted",
)?.get;
const EVENT_TARGET_ADD_EVENT_LISTENER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  EventTarget.prototype,
  "addEventListener",
)?.value as unknown;
const EVENT_TARGET_REMOVE_EVENT_LISTENER = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(
  EventTarget.prototype,
  "removeEventListener",
)?.value as unknown;

/** Reads the built-in state without resolving an instance-owned getter. */
export function readRelayV2SingleExchangeAbortState(
  signal: AbortSignal,
): boolean | undefined {
  try {
    if (ABORT_SIGNAL_ABORTED_GETTER === undefined) return undefined;
    const aborted = ABORT_SIGNAL_ABORTED_GETTER.call(signal);
    return typeof aborted === "boolean" ? aborted : undefined;
  } catch {
    return undefined;
  }
}

function safeAddAbortListener(signal: AbortSignal, listener: () => void): boolean {
  try {
    if (typeof EVENT_TARGET_ADD_EVENT_LISTENER !== "function") return false;
    EVENT_TARGET_ADD_EVENT_LISTENER.call(signal, "abort", listener, { once: true });
    return true;
  } catch {
    return false;
  }
}

function safeRemoveAbortListener(signal: AbortSignal, listener: () => void): void {
  try {
    if (typeof EVENT_TARGET_REMOVE_EVENT_LISTENER !== "function") return;
    EVENT_TARGET_REMOVE_EVENT_LISTENER.call(signal, "abort", listener);
  } catch {}
}

function nodeResponseHeaders(
  response: IncomingMessage,
): readonly (readonly [string, string])[] {
  const headers: Array<readonly [string, string]> = [];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    headers[index / 2] = [
      response.rawHeaders[index]!,
      response.rawHeaders[index + 1]!,
    ];
  }
  return headers;
}

function captureNodeRequestBody(value: Uint8Array): Buffer {
  if (typeof TYPED_ARRAY_BUFFER_GETTER !== "function"
    || typeof TYPED_ARRAY_BYTE_OFFSET_GETTER !== "function"
    || typeof TYPED_ARRAY_BYTE_LENGTH_GETTER !== "function"
    || typeof TYPED_ARRAY_LENGTH_GETTER !== "function"
    || typeof TYPED_ARRAY_SET !== "function") {
    throw new TypeError("Relay v2 single-exchange HTTPS body is invalid");
  }
  let sourceBuffer: ArrayBufferLike;
  let sourceByteOffset: number;
  let sourceByteLength: number;
  try {
    sourceBuffer = REFLECT_APPLY(TYPED_ARRAY_BUFFER_GETTER, value, []) as ArrayBufferLike;
    sourceByteOffset = REFLECT_APPLY(
      TYPED_ARRAY_BYTE_OFFSET_GETTER,
      value,
      [],
    ) as number;
    sourceByteLength = REFLECT_APPLY(
      TYPED_ARRAY_BYTE_LENGTH_GETTER,
      value,
      [],
    ) as number;
  } catch {
    throw new TypeError("Relay v2 single-exchange HTTPS body is invalid");
  }
  if (!NUMBER_IS_SAFE_INTEGER(sourceByteOffset)
    || sourceByteOffset < 0
    || !NUMBER_IS_SAFE_INTEGER(sourceByteLength)
    || sourceByteLength < 0) {
    throw new TypeError("Relay v2 single-exchange HTTPS body is invalid");
  }

  let body: Buffer;
  try {
    const source = new UINT8_ARRAY_CONSTRUCTOR(
      sourceBuffer,
      sourceByteOffset,
      sourceByteLength,
    );
    const copiedBuffer = new ARRAY_BUFFER_CONSTRUCTOR(sourceByteLength);
    const copiedBytes = new UINT8_ARRAY_CONSTRUCTOR(copiedBuffer);
    REFLECT_APPLY(TYPED_ARRAY_SET, copiedBytes, [source]);
    body = REFLECT_APPLY(
      BUFFER_FROM,
      BUFFER_CONSTRUCTOR,
      [copiedBuffer, 0, sourceByteLength],
    ) as Buffer;

    const bodyBuffer = REFLECT_APPLY(
      TYPED_ARRAY_BUFFER_GETTER,
      body,
      [],
    ) as ArrayBufferLike;
    const bodyByteOffset = REFLECT_APPLY(
      TYPED_ARRAY_BYTE_OFFSET_GETTER,
      body,
      [],
    ) as number;
    const bodyByteLength = REFLECT_APPLY(
      TYPED_ARRAY_BYTE_LENGTH_GETTER,
      body,
      [],
    ) as number;
    const bodyLength = REFLECT_APPLY(
      TYPED_ARRAY_LENGTH_GETTER,
      body,
      [],
    ) as number;
    if (bodyBuffer !== copiedBuffer
      || bodyByteOffset !== 0
      || bodyByteLength !== sourceByteLength
      || bodyLength !== sourceByteLength) {
      throw new TypeError("Relay v2 single-exchange HTTPS body is invalid");
    }
    OBJECT_DEFINE_PROPERTIES(body, {
      buffer: {
        configurable: false,
        enumerable: false,
        value: bodyBuffer,
        writable: false,
      },
      byteOffset: {
        configurable: false,
        enumerable: false,
        value: bodyByteOffset,
        writable: false,
      },
      byteLength: {
        configurable: false,
        enumerable: false,
        value: bodyByteLength,
        writable: false,
      },
      length: {
        configurable: false,
        enumerable: false,
        value: bodyLength,
        writable: false,
      },
    });
  } catch {
    throw new TypeError("Relay v2 single-exchange HTTPS body is invalid");
  }
  return body;
}

/**
 * System-TLS Node transport for one POST. Node follows no redirects and this
 * layer adds no proxy, decompression, cookie, cache, retry, or authentication.
 */
function createCapturedRelayV2SingleExchangeNodeHttpsTransport(
  request: RelayV2SingleExchangeNodeHttpsRequest,
  capturedTls: CapturedTlsOptions,
): RelayV2SingleExchangeHttpsTransport {
  return {
    start(input): RelayV2SingleExchangeHttpsTransportExchange {
      let client: ClientRequest | undefined;
      let incoming: IncomingMessage | undefined;
      let aborted = false;
      let responseSettled = false;
      let incomingDestroyed = false;
      let resolveResponse!: (value: RelayV2SingleExchangeHttpsTransportResponse) => void;
      let rejectResponse!: (reason: Error) => void;
      const response = new Promise<RelayV2SingleExchangeHttpsTransportResponse>(
        (resolve, reject) => {
          resolveResponse = resolve;
          rejectResponse = reject;
        },
      );
      const rejectSafely = (): void => {
        if (responseSettled) return;
        responseSettled = true;
        rejectResponse(transportFailure("TRANSPORT_FAILED"));
      };
      const destroyIncoming = (): void => {
        if (incoming === undefined || incomingDestroyed) return;
        incomingDestroyed = true;
        try { incoming.destroy(); } catch {}
      };

      try {
        const requestBody = captureNodeRequestBody(input.body);
        const requestOptions = OBJECT_FREEZE({
          method: "POST",
          headers: input.headers,
          agent: false,
          rejectUnauthorized: true,
          checkServerIdentity: NODE_CHECK_SERVER_IDENTITY,
          ...(capturedTls.ca === undefined
            ? {}
            : { ca: capturedTls.ca as NodeHttpsRequestOptions["ca"] }),
          ...(capturedTls.cert === undefined
            ? {}
            : { cert: capturedTls.cert as NodeHttpsRequestOptions["cert"] }),
          ...(capturedTls.key === undefined
            ? {}
            : { key: capturedTls.key as NodeHttpsRequestOptions["key"] }),
        });
        client = request(
          new URL_CONSTRUCTOR(input.endpoint),
          requestOptions,
          (received) => {
            incoming = received;
            if (aborted || responseSettled) {
              destroyIncoming();
              return;
            }
            responseSettled = true;
            resolveResponse({
              statusCode: received.statusCode ?? 0,
              headers: nodeResponseHeaders(received),
              body: received as AsyncIterable<Uint8Array>,
              destroy: destroyIncoming,
            });
          },
        );
        client.once("error", rejectSafely);
        client.end(requestBody);
      } catch {
        rejectSafely();
      }

      return {
        response,
        abort: () => {
          if (aborted) return;
          aborted = true;
          if (incoming !== undefined) destroyIncoming();
          else {
            try { client?.destroy(); } catch {}
          }
          rejectSafely();
        },
      };
    },
  };
}

export function createRelayV2SingleExchangeNodeHttpsTransport(
  request: RelayV2SingleExchangeNodeHttpsRequest =
    NODE_HTTPS_REQUEST,
  tls?: RelayV2SingleExchangeNodeHttpsTlsOptions,
): RelayV2SingleExchangeHttpsTransport {
  return createCapturedRelayV2SingleExchangeNodeHttpsTransport(
    request,
    captureTlsOptions(tls),
  );
}

/**
 * Host credential lane opener. Only a process-local Host CA cut can extend
 * system trust; this path has no cert/key or arbitrary TLS-options surface.
 */
export function createRelayV2HostCaOnlySingleExchangeNodeHttpsTransport(
  tlsTrustCut?: RelayV2HostTlsCaTrustCut,
): RelayV2SingleExchangeHttpsTransport {
  if (tlsTrustCut === undefined) {
    return createCapturedRelayV2SingleExchangeNodeHttpsTransport(
      NODE_HTTPS_REQUEST,
      EMPTY_CAPTURED_TLS_OPTIONS,
    );
  }
  const tlsTrust = readRelayV2HostTlsCaTrustCut(tlsTrustCut);
  if (tlsTrust === undefined) {
    throw new TypeError("Relay v2 Host TLS trust authority is invalid");
  }
  const captured: MutableCapturedTlsOptions = OBJECT_CREATE(null);
  captured.ca = tlsTrust.certificateAuthorities;
  return createCapturedRelayV2SingleExchangeNodeHttpsTransport(
    NODE_HTTPS_REQUEST,
    OBJECT_FREEZE(captured),
  );
}

export interface RelayV2SingleExchangeHttpsOptions<Result, Failure = undefined> {
  readonly transport: RelayV2SingleExchangeHttpsTransport;
  readonly request: RelayV2SingleExchangeHttpsTransportRequest;
  readonly signal: AbortSignal;
  consume(response: RelayV2SingleExchangeHttpsTransportResponse): Promise<Result> | Result;
  /** Maps a caught consumer fault without ever exposing the raw fault in the lifecycle outcome. */
  mapConsumeFailure?(failure: unknown): Failure;
}

export type RelayV2SingleExchangeHttpsOutcome<Result, Failure = undefined> =
  | { readonly kind: "completed"; readonly value: Result }
  | { readonly kind: "aborted" }
  | { readonly kind: "transport_failed" }
  | { readonly kind: "consume_failed"; readonly failure: Failure | undefined };

const ABORTED_OUTCOME = OBJECT_FREEZE({ kind: "aborted" } as const);
const TRANSPORT_FAILED_OUTCOME = OBJECT_FREEZE({ kind: "transport_failed" } as const);

/**
 * Owns exactly one start/settle/cancel lifecycle. The protocol adapter owns
 * request construction and response admission/decoding through `consume`.
 */
export function performRelayV2SingleExchangeHttps<Result, Failure = undefined>(
  options: RelayV2SingleExchangeHttpsOptions<Result, Failure>,
): Promise<RelayV2SingleExchangeHttpsOutcome<Result, Failure>> {
  let signal: AbortSignal;
  try {
    signal = options.signal;
  } catch {
    return Promise.resolve(TRANSPORT_FAILED_OUTCOME);
  }
  if (!isAbortSignal(signal)) return Promise.resolve(TRANSPORT_FAILED_OUTCOME);

  return new Promise<RelayV2SingleExchangeHttpsOutcome<Result, Failure>>((resolve) => {
    let settled = false;
    let exchange: RelayV2SingleExchangeHttpsTransportExchange | undefined;
    let response: RelayV2SingleExchangeHttpsTransportResponse | undefined;
    let transportCancelled = false;
    let lateResponseDestroyed = false;
    let abortSettlementEnabled = false;
    let abortObservedBeforeStart = false;
    let listenerRegistrationAttempted = false;
    let listenerRemovalAttempted = false;

    const cleanup = (): void => {
      if (!listenerRegistrationAttempted || listenerRemovalAttempted) return;
      listenerRemovalAttempted = true;
      safeRemoveAbortListener(signal, onAbort);
    };
    const destroy = (target: unknown): boolean => {
      try {
        if (!isRecord(target)) return false;
        const destroyTarget = target.destroy;
        if (typeof destroyTarget !== "function") return false;
        destroyTarget.call(target);
        return true;
      } catch {
        return false;
      }
    };
    const cancelTransport = (): void => {
      if (transportCancelled) return;
      if (response !== undefined) {
        transportCancelled = true;
        if (!destroy(response)) {
          try { exchange?.abort(); } catch {}
        }
        return;
      }
      if (exchange !== undefined) {
        transportCancelled = true;
        try { exchange.abort(); } catch {}
      }
    };
    const destroyLateResponse = (target: unknown): void => {
      if (lateResponseDestroyed) return;
      lateResponseDestroyed = true;
      destroy(target);
    };
    const fail = (outcome: RelayV2SingleExchangeHttpsOutcome<Result, Failure>): void => {
      if (settled) return;
      settled = true;
      cleanup();
      cancelTransport();
      resolve(outcome);
    };
    const succeed = (value: Result): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(OBJECT_FREEZE({ kind: "completed", value }));
    };
    const onAbort = (): void => {
      if (!abortSettlementEnabled) {
        abortObservedBeforeStart = true;
        return;
      }
      fail(ABORTED_OUTCOME);
    };

    const initiallyAborted = readRelayV2SingleExchangeAbortState(signal);
    if (initiallyAborted === undefined) {
      fail(TRANSPORT_FAILED_OUTCOME);
      return;
    }
    if (initiallyAborted) {
      fail(ABORTED_OUTCOME);
      return;
    }
    listenerRegistrationAttempted = true;
    if (!safeAddAbortListener(signal, onAbort)) {
      fail(TRANSPORT_FAILED_OUTCOME);
      return;
    }
    const abortedAfterRegistration = readRelayV2SingleExchangeAbortState(signal);
    if (abortedAfterRegistration === undefined) {
      fail(TRANSPORT_FAILED_OUTCOME);
      return;
    }
    if (abortObservedBeforeStart || abortedAfterRegistration) {
      fail(ABORTED_OUTCOME);
      return;
    }
    abortSettlementEnabled = true;

    try {
      exchange = options.transport.start(options.request);
      if (settled) {
        cancelTransport();
        return;
      }
      if (
        !isRecord(exchange)
        || typeof exchange.abort !== "function"
        || !OBJECT_HAS_OWN(exchange, "response")
      ) {
        fail(TRANSPORT_FAILED_OUTCOME);
        return;
      }
    } catch {
      fail(TRANSPORT_FAILED_OUTCOME);
      return;
    }
    const abortedAfterStart = readRelayV2SingleExchangeAbortState(signal);
    if (abortedAfterStart === undefined) {
      fail(TRANSPORT_FAILED_OUTCOME);
      return;
    }
    if (abortedAfterStart) {
      fail(ABORTED_OUTCOME);
      return;
    }

    let responsePromise: Promise<RelayV2SingleExchangeHttpsTransportResponse>;
    try {
      responsePromise = Promise.resolve(exchange.response);
    } catch {
      fail(TRANSPORT_FAILED_OUTCOME);
      return;
    }
    responsePromise.then((received) => {
      void (async () => {
        if (settled) {
          destroyLateResponse(received);
          return;
        }
        response = received;
        try {
          succeed(await options.consume(received));
        } catch (consumerFailure) {
          let mappedFailure: Failure | undefined;
          try {
            const mapper = options.mapConsumeFailure;
            if (typeof mapper === "function") mappedFailure = mapper(consumerFailure);
          } catch {}
          fail(OBJECT_FREEZE({ kind: "consume_failed", failure: mappedFailure }));
        }
      })();
    }, () => {
      const aborted = readRelayV2SingleExchangeAbortState(signal);
      fail(aborted === true ? ABORTED_OUTCOME : TRANSPORT_FAILED_OUTCOME);
    });
  });
}
