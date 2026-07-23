import type { ClientRequest, IncomingMessage } from "node:http";
import {
  request as nodeHttpsRequest,
  type RequestOptions as NodeHttpsRequestOptions,
} from "node:https";
import { checkServerIdentity } from "node:tls";
import { types as nodeUtilTypes } from "node:util";

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

// Bounds on captured TLS material, chosen at the frozen outer-HTTPS magnitude
// (httpsBodyBytes 16384): a private trust bundle for one exact endpoint holds
// a small root/chain set and PEM/DER key material stays well under one body.
const MAX_CA_ENTRIES = 8;
const MAX_TLS_MATERIAL_BYTES = 16_384;
const MAX_CA_TOTAL_BYTES = 32_768;

function tlsMaterialBytes(value: string | Uint8Array): number {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
}

function captureTlsMaterial(
  value: string | Uint8Array,
): string | Uint8Array {
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_TLS_MATERIAL_BYTES) {
      throw new TypeError("Relay v2 single-exchange HTTPS TLS material is invalid");
    }
    return value;
  }
  if (value instanceof Uint8Array && !nodeUtilTypes.isProxy(value)) {
    if (value.byteLength > MAX_TLS_MATERIAL_BYTES) {
      throw new TypeError("Relay v2 single-exchange HTTPS TLS material is invalid");
    }
    // Buffer.prototype.slice shares memory; always copy into an owned array.
    return new Uint8Array(value);
  }
  throw new TypeError("Relay v2 single-exchange HTTPS TLS material is invalid");
}

/**
 * Snapshots TLS options exactly once. Every later check reads only the
 * snapshot; no foreign property is read again.
 */
function captureTlsOptions(
  value: RelayV2SingleExchangeNodeHttpsTlsOptions | undefined,
): Readonly<{
  ca?: readonly (string | Uint8Array)[];
  cert?: string | Uint8Array;
  key?: string | Uint8Array;
}> {
  const invalid = (): TypeError =>
    new TypeError("Relay v2 single-exchange HTTPS TLS options are invalid");
  if (value === undefined) return Object.freeze(Object.create(null));
  if (!isRecord(value) || nodeUtilTypes.isProxy(value)) throw invalid();
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw invalid();
  }
  const allowed = ["ca", "cert", "key"];
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) {
    throw invalid();
  }
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw invalid();
    snapshot[key] = descriptor.value;
  }
  const captured: {
    ca?: readonly (string | Uint8Array)[];
    cert?: string | Uint8Array;
    key?: string | Uint8Array;
  } = Object.create(null);
  if (snapshot.ca !== undefined) {
    if (!Array.isArray(snapshot.ca) || nodeUtilTypes.isProxy(snapshot.ca)) {
      throw invalid();
    }
    const length = snapshot.ca.length;
    if (length > MAX_CA_ENTRIES) throw invalid();
    let caDescriptors: PropertyDescriptorMap;
    try {
      caDescriptors = Object.getOwnPropertyDescriptors(snapshot.ca);
    } catch {
      throw invalid();
    }
    const caKeys = Reflect.ownKeys(caDescriptors);
    if (
      caKeys.length !== length + 1
      || caKeys.some((key) => {
        if (key === "length") return false;
        return typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)
          || Number(key) >= length;
      })
    ) throw invalid();
    const authorities: (string | Uint8Array)[] = [];
    let totalBytes = 0;
    for (let index = 0; index < length; index += 1) {
      const descriptor = caDescriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) throw invalid();
      const authority = captureTlsMaterial(descriptor.value as string | Uint8Array);
      totalBytes += tlsMaterialBytes(authority);
      if (totalBytes > MAX_CA_TOTAL_BYTES) throw invalid();
      authorities.push(authority);
    }
    captured.ca = Object.freeze(authorities);
  }
  if (snapshot.cert !== undefined) {
    captured.cert = captureTlsMaterial(snapshot.cert as string | Uint8Array);
  }
  if (snapshot.key !== undefined) {
    captured.key = captureTlsMaterial(snapshot.key as string | Uint8Array);
  }
  return Object.freeze(captured);
}

function transportFailure(
  code: RelayV2SingleExchangeHttpsErrorCode,
): RelayV2SingleExchangeHttpsError {
  return new RelayV2SingleExchangeHttpsError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return value instanceof AbortSignal;
}

const ABORT_SIGNAL_ABORTED_GETTER = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)?.get;
const EVENT_TARGET_ADD_EVENT_LISTENER = Object.getOwnPropertyDescriptor(
  EventTarget.prototype,
  "addEventListener",
)?.value as unknown;
const EVENT_TARGET_REMOVE_EVENT_LISTENER = Object.getOwnPropertyDescriptor(
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
    headers.push([response.rawHeaders[index]!, response.rawHeaders[index + 1]!]);
  }
  return headers;
}

/**
 * System-TLS Node transport for one POST. Node follows no redirects and this
 * layer adds no proxy, decompression, cookie, cache, retry, or authentication.
 */
export function createRelayV2SingleExchangeNodeHttpsTransport(
  request: RelayV2SingleExchangeNodeHttpsRequest =
    nodeHttpsRequest as RelayV2SingleExchangeNodeHttpsRequest,
  tls?: RelayV2SingleExchangeNodeHttpsTlsOptions,
): RelayV2SingleExchangeHttpsTransport {
  const capturedTls = captureTlsOptions(tls);
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
        client = request(
          new URL(input.endpoint),
          {
            method: "POST",
            headers: input.headers,
            agent: false,
            rejectUnauthorized: true,
            checkServerIdentity,
            ...(capturedTls.ca === undefined
              ? {}
              : { ca: capturedTls.ca as NodeHttpsRequestOptions["ca"] }),
            ...(capturedTls.cert === undefined
              ? {}
              : { cert: capturedTls.cert as NodeHttpsRequestOptions["cert"] }),
            ...(capturedTls.key === undefined
              ? {}
              : { key: capturedTls.key as NodeHttpsRequestOptions["key"] }),
          },
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
        client.end(Buffer.from(input.body.buffer, input.body.byteOffset, input.body.byteLength));
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

const ABORTED_OUTCOME = Object.freeze({ kind: "aborted" } as const);
const TRANSPORT_FAILED_OUTCOME = Object.freeze({ kind: "transport_failed" } as const);

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
      resolve(Object.freeze({ kind: "completed", value }));
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
        || !Object.hasOwn(exchange, "response")
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
          fail(Object.freeze({ kind: "consume_failed", failure: mappedFailure }));
        }
      })();
    }, () => {
      const aborted = readRelayV2SingleExchangeAbortState(signal);
      fail(aborted === true ? ABORTED_OUTCOME : TRANSPORT_FAILED_OUTCOME);
    });
  });
}
