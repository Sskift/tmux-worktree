import { IncomingMessage } from "node:http";
import { Duplex } from "node:stream";
import {
  clearTimeout as nodeClearTimeout,
  setTimeout as nodeSetTimeout,
} from "node:timers";
import { types as nodeUtilTypes } from "node:util";

import type {
  RelayV2BrokerHostUpgradeMetadata,
} from "./brokerHostUpgradeDispatch.js";
import type {
  RelayV2BrokerHostWssListenerFreeComposition,
  RelayV2BrokerHostWssListenerFreeUpgradeResult,
} from "./brokerHostWssListenerFreeComposition.js";

const REQUEST_INPUT_KEYS = Object.freeze([
  "request",
  "socket",
  "head",
] as const);
const COMPOSITION_KEYS = Object.freeze([
  "hostUpgrade",
  "closeAndDrain",
] as const);
const HOST_UPGRADE_KEYS = Object.freeze(["upgrade"] as const);
const REJECT_STATUSES = Object.freeze([
  400,
  401,
  403,
  404,
  426,
  503,
] as const);
const REJECT_RESPONSES: Readonly<Record<(typeof REJECT_STATUSES)[number], string>> =
  Object.freeze({
    400: "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n",
    401: "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n",
    403: "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n",
    404: "HTTP/1.1 404 Not Found\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n",
    426: "HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n",
    503: "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n",
  });
const REJECT_END_DEADLINE_MS = 1_000;

const promiseThen = Promise.prototype.then;

export interface RelayV2BrokerHostWssNodeUpgradeRequestInput {
  readonly request: IncomingMessage;
  readonly socket: Duplex;
  readonly head: Uint8Array;
}

export interface RelayV2BrokerHostWssNodeUpgradeRequestAdapter {
  handleUpgradeRequest(
    input: RelayV2BrokerHostWssNodeUpgradeRequestInput,
  ): Promise<"upgraded" | "rejected">;
  closeAndDrain(): Promise<void>;
}

type CapturedComposition = Readonly<{
  composition: RelayV2BrokerHostWssListenerFreeComposition;
  hostUpgrade: RelayV2BrokerHostWssListenerFreeComposition["hostUpgrade"];
  upgrade: Function;
  closeAndDrain: Function;
}>;

type CapturedRejectSocket = Readonly<{
  receiver: Duplex;
  end: Function;
  destroy: Function;
}>;

type DelegatedOutcome =
  | Readonly<{ outcome: "upgraded" }>
  | Readonly<{ outcome: "reject"; status: (typeof REJECT_STATUSES)[number] }>;

function rejectedProxy(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  try {
    return nodeUtilTypes.isProxy(value);
  } catch {
    return true;
  }
}

function failure(): Error {
  return new Error("Relay v2 Broker Host Node Upgrade request adapter failed");
}

function rejectedFailure<T>(): Promise<T> {
  const rejected = Promise.reject<T>(failure());
  void rejected.catch(() => undefined);
  return rejected;
}

function captureExactDataRecord(
  value: unknown,
  exactKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== "object" || rejectedProxy(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== exactKeys.length
      || keys.some((key) => typeof key !== "string" || !exactKeys.includes(key))
    ) return null;
    const captured = Object.create(null) as Record<string, unknown>;
    for (const key of exactKeys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
      captured[key] = descriptor.value;
    }
    return Object.freeze(captured);
  } catch {
    return null;
  }
}

function captureFrozenNullPrototypeFacade(
  value: unknown,
  exactKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  const captured = captureExactDataRecord(value, exactKeys);
  if (!captured) return null;
  try {
    if (!Object.isFrozen(value) || Reflect.getPrototypeOf(value) !== null) return null;
  } catch {
    return null;
  }
  return captured;
}

function captureMethod(receiver: object, name: string): Function | null {
  let owner: object | null = receiver;
  try {
    while (owner !== null) {
      if (rejectedProxy(owner)) return null;
      const descriptor = Reflect.getOwnPropertyDescriptor(owner, name);
      if (descriptor !== undefined) {
        return Object.hasOwn(descriptor, "value")
          && typeof descriptor.value === "function"
          && !rejectedProxy(descriptor.value)
          ? descriptor.value
          : null;
      }
      owner = Reflect.getPrototypeOf(owner);
    }
  } catch {
    return null;
  }
  return null;
}

function captureComposition(value: unknown): CapturedComposition | null {
  const captured = captureFrozenNullPrototypeFacade(value, COMPOSITION_KEYS);
  const hostUpgrade = captureFrozenNullPrototypeFacade(
    captured?.hostUpgrade,
    HOST_UPGRADE_KEYS,
  );
  if (
    !captured
    || !hostUpgrade
    || typeof hostUpgrade.upgrade !== "function"
    || rejectedProxy(hostUpgrade.upgrade)
    || typeof captured.closeAndDrain !== "function"
    || rejectedProxy(captured.closeAndDrain)
  ) return null;
  return Object.freeze({
    composition: value as RelayV2BrokerHostWssListenerFreeComposition,
    hostUpgrade: captured.hostUpgrade as RelayV2BrokerHostWssListenerFreeComposition["hostUpgrade"],
    upgrade: hostUpgrade.upgrade,
    closeAndDrain: captured.closeAndDrain,
  });
}

function captureRejectSocket(value: unknown): CapturedRejectSocket | null {
  if (
    value === null
    || typeof value !== "object"
    || rejectedProxy(value)
    || !(value instanceof Duplex)
  ) return null;
  const end = captureMethod(value, "end");
  const destroy = captureMethod(value, "destroy");
  if (!end || !destroy) return null;
  return Object.freeze({ receiver: value, end, destroy });
}

function splitRawRequestTarget(value: unknown): Readonly<{
  pathname: string;
  search: string;
}> | null {
  if (typeof value !== "string" || value.length === 0 || value[0] !== "/") return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code >= 0x7f || code === 0x23) return null;
  }
  const query = value.indexOf("?");
  return Object.freeze({
    pathname: query === -1 ? value : value.slice(0, query),
    search: query === -1 ? "" : value.slice(query),
  });
}

function trimHttpOws(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && (value.charCodeAt(start) === 0x20 || value.charCodeAt(start) === 0x09)) {
    start += 1;
  }
  while (end > start && (
    value.charCodeAt(end - 1) === 0x20
    || value.charCodeAt(end - 1) === 0x09
  )) {
    end -= 1;
  }
  return value.slice(start, end);
}

function captureRawHeaderMetadata(value: unknown): Readonly<{
  authorizationHeaders: readonly string[];
  offeredProtocols: readonly string[];
}> | null {
  if (rejectedProxy(value) || !Array.isArray(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = descriptors.length;
    if (
      !length
      || !Object.hasOwn(length, "value")
      || !Number.isSafeInteger(length.value)
      || length.value < 0
      || length.value % 2 !== 0
      || Reflect.ownKeys(descriptors).length !== length.value + 1
    ) return null;
    const authorizationHeaders: string[] = [];
    const offeredProtocols: string[] = [];
    for (let index = 0; index < length.value; index += 2) {
      const name = descriptors[String(index)];
      const headerValue = descriptors[String(index + 1)];
      if (
        !name
        || !Object.hasOwn(name, "value")
        || typeof name.value !== "string"
        || !headerValue
        || !Object.hasOwn(headerValue, "value")
        || typeof headerValue.value !== "string"
      ) return null;
      const lowerName = name.value.toLowerCase();
      if (lowerName === "authorization") {
        authorizationHeaders.push(headerValue.value);
      } else if (lowerName === "sec-websocket-protocol") {
        for (const protocol of headerValue.value.split(",")) {
          offeredProtocols.push(trimHttpOws(protocol));
        }
      }
    }
    return Object.freeze({
      authorizationHeaders: Object.freeze(authorizationHeaders),
      offeredProtocols: Object.freeze(offeredProtocols),
    });
  } catch {
    return null;
  }
}

function captureRequestMetadata(
  value: unknown,
  expectedSocket: Duplex,
): RelayV2BrokerHostUpgradeMetadata | null {
  if (
    value === null
    || typeof value !== "object"
    || rejectedProxy(value)
    || !(value instanceof IncomingMessage)
  ) return null;
  try {
    const url = Reflect.getOwnPropertyDescriptor(value, "url");
    const rawHeaders = Reflect.getOwnPropertyDescriptor(value, "rawHeaders");
    const requestSocket = Reflect.getOwnPropertyDescriptor(value, "socket");
    if (
      !url
      || !Object.hasOwn(url, "value")
      || !rawHeaders
      || !Object.hasOwn(rawHeaders, "value")
      || !requestSocket
      || !Object.hasOwn(requestSocket, "value")
      || requestSocket.value !== expectedSocket
    ) return null;
    const target = splitRawRequestTarget(url.value);
    const headers = captureRawHeaderMetadata(rawHeaders.value);
    if (!target || !headers) return null;
    return Object.freeze(Object.assign(Object.create(null), {
      pathname: target.pathname,
      search: target.search,
      authorizationHeaders: headers.authorizationHeaders,
      legacyQuerySecret: null,
      offeredProtocols: headers.offeredProtocols,
    })) as RelayV2BrokerHostUpgradeMetadata;
  } catch {
    return null;
  }
}

function captureDelegatedOutcome(value: unknown): DelegatedOutcome | null {
  if (value === null || typeof value !== "object" || rejectedProxy(value)) return null;
  try {
    const outcome = Reflect.getOwnPropertyDescriptor(value, "outcome");
    if (!outcome || !Object.hasOwn(outcome, "value")) return null;
    if (outcome.value === "upgraded") return Object.freeze({ outcome: "upgraded" });
    if (outcome.value !== "reject") return null;
    const status = Reflect.getOwnPropertyDescriptor(value, "status");
    if (
      !status
      || !Object.hasOwn(status, "value")
      || !REJECT_STATUSES.includes(status.value as (typeof REJECT_STATUSES)[number])
    ) return null;
    return Object.freeze({
      outcome: "reject",
      status: status.value as (typeof REJECT_STATUSES)[number],
    });
  } catch {
    return null;
  }
}

function endRejectResponse(
  socket: CapturedRejectSocket,
  status: (typeof REJECT_STATUSES)[number],
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let destroyCalled = false;
    let deadline: ReturnType<typeof nodeSetTimeout> | null = null;
    const destroyOnce = (): void => {
      if (destroyCalled) return;
      destroyCalled = true;
      try {
        Reflect.apply(socket.destroy, socket.receiver, []);
      } catch {}
    };
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (deadline !== null) {
        nodeClearTimeout(deadline);
        deadline = null;
      }
      if (error !== undefined && error !== null) {
        destroyOnce();
        reject(failure());
      } else {
        resolve();
      }
    };
    try {
      deadline = nodeSetTimeout(
        () => { settle(failure()); },
        REJECT_END_DEADLINE_MS,
      );
    } catch {
      settle(failure());
      return;
    }
    try {
      Reflect.apply(socket.end, socket.receiver, [REJECT_RESPONSES[status], settle]);
    } catch {
      settle(failure());
    }
  });
}

/**
 * Default-off outer Node Upgrade boundary for one complete B7j Host owner.
 * It creates no listener and never owns an upgraded socket or connection.
 */
export function createRelayV2BrokerHostWssNodeUpgradeRequestAdapter(
  composition: RelayV2BrokerHostWssListenerFreeComposition,
): RelayV2BrokerHostWssNodeUpgradeRequestAdapter {
  const delegated = captureComposition(composition);
  if (!delegated) throw failure();

  let lifecycle: "open" | "closing" | "closed" = "open";
  const activeHandlers = new Set<Promise<void>>();
  let closePromise: Promise<void> | null = null;
  let adapter!: RelayV2BrokerHostWssNodeUpgradeRequestAdapter;

  const handleUpgradeRequest = function handleUpgradeRequest(
    this: unknown,
    input: RelayV2BrokerHostWssNodeUpgradeRequestInput,
  ): Promise<"upgraded" | "rejected"> {
    if (this !== adapter || lifecycle !== "open") return rejectedFailure();

    let resolveBarrier!: () => void;
    let rejectBarrier!: (error: Error) => void;
    const barrier = new Promise<void>((resolve, reject) => {
      resolveBarrier = resolve;
      rejectBarrier = reject;
    });
    void barrier.catch(() => undefined);
    activeHandlers.add(barrier);

    const operation = (async (): Promise<"upgraded" | "rejected"> => {
      const captured = captureExactDataRecord(input, REQUEST_INPUT_KEYS);
      if (!captured) throw failure();
      const socket = captureRejectSocket(captured.socket);
      if (
        !socket
        || rejectedProxy(captured.head)
        || !(captured.head instanceof Uint8Array)
      ) throw failure();

      const metadata = captureRequestMetadata(captured.request, socket.receiver);
      if (!metadata) {
        await endRejectResponse(socket, 400);
        return "rejected";
      }

      let result: RelayV2BrokerHostWssListenerFreeUpgradeResult;
      try {
        const pending = Reflect.apply(delegated.upgrade, delegated.hostUpgrade, [
          Object.freeze(Object.assign(Object.create(null), {
            metadata,
            request: captured.request,
            socket: captured.socket,
            head: captured.head,
          })),
        ]);
        if (!nodeUtilTypes.isPromise(pending)) throw failure();
        result = await pending;
      } catch {
        throw failure();
      }

      const outcome = captureDelegatedOutcome(result);
      if (!outcome) throw failure();
      if (outcome.outcome === "upgraded") return "upgraded";
      await endRejectResponse(socket, outcome.status);
      return "rejected";
    })();

    const observed = promiseThen.call(
      operation,
      () => {
        activeHandlers.delete(barrier);
        resolveBarrier();
      },
      () => {
        activeHandlers.delete(barrier);
        rejectBarrier(failure());
      },
    );
    void promiseThen.call(observed, undefined, () => undefined);
    return operation;
  };

  const closeAndDrain = function closeAndDrain(this: unknown): Promise<void> {
    if (this !== adapter) return rejectedFailure();
    if (closePromise) return closePromise;
    lifecycle = "closing";
    const admittedHandlers = [...activeHandlers];
    let resolveClose!: () => void;
    let rejectClose!: (error: Error) => void;
    closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    void closePromise.catch(() => undefined);
    let delegatedClose: Promise<void>;
    try {
      const pending = Reflect.apply(
        delegated.closeAndDrain,
        delegated.composition,
        [],
      );
      if (!nodeUtilTypes.isPromise(pending)) throw failure();
      delegatedClose = pending;
    } catch {
      delegatedClose = Promise.reject(failure());
      void delegatedClose.catch(() => undefined);
    }
    void (async () => {
      const settlements = await Promise.allSettled([
        delegatedClose,
        ...admittedHandlers,
      ]);
      lifecycle = "closed";
      if (settlements.some((settlement) => settlement.status === "rejected")) {
        rejectClose(failure());
      } else {
        resolveClose();
      }
    })();
    return closePromise;
  };

  adapter = Object.freeze(Object.assign(Object.create(null), {
    handleUpgradeRequest,
    closeAndDrain,
  })) as RelayV2BrokerHostWssNodeUpgradeRequestAdapter;
  return adapter;
}
