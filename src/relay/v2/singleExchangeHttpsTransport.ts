import type { ClientRequest, IncomingMessage } from "node:http";
import {
  request as nodeHttpsRequest,
  type RequestOptions as NodeHttpsRequestOptions,
} from "node:https";
import { checkServerIdentity } from "node:tls";

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
        client = request(
          new URL(input.endpoint),
          {
            method: "POST",
            headers: input.headers,
            agent: false,
            rejectUnauthorized: true,
            checkServerIdentity,
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
