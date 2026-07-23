import { IncomingMessage } from "node:http";
import { Duplex } from "node:stream";
import {
  clearTimeout as nodeClearTimeout,
  setTimeout as nodeSetTimeout,
} from "node:timers";
import { types as nodeUtilTypes } from "node:util";

import { WebSocket, WebSocketServer } from "ws";

import {
  RelayV2BrokerClientUpgradeDispatchOwner,
  type RelayV2BrokerClientUpgradeMetadata,
  type RelayV2BrokerClientUpgradeVerifyPort,
} from "./brokerClientUpgradeDispatch.js";
import type { RelayV2BrokerClientWssSocket } from "./brokerClientWssAdapter.js";
import type {
  RelayV2BrokerClientWssAttachPreparedInput,
  RelayV2BrokerClientWssConnectionHandle,
  RelayV2BrokerClientWssCurrentHostPreparePort,
} from "./brokerClientWssRuntimeComposition.js";
import {
  RELAY_V2_BROKER_LIMITS,
} from "./brokerCore.js";

const CLIENT_SUBPROTOCOL = "tw-relay.v2";
const REJECT_END_DEADLINE_MS = 1_000;
const INPUT_KEYS = Object.freeze([
  "request",
  "socket",
  "head",
] as const);
const OPTION_KEYS = Object.freeze([
  "verifyV2AccessToken",
  "runtime",
] as const);
const RUNTIME_METHODS = Object.freeze([
  "installTrustedSocketCapture",
  "prepareClientWssForCurrentHost",
  "attachPreparedClientWss",
] as const);
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

export type RelayV2BrokerClientWssNodeIngressRuntime = Readonly<{
  installTrustedSocketCapture(
    trustedSocketPrototype: object,
    trustedSocketBrand: (socket: RelayV2BrokerClientWssSocket) => boolean,
  ): void;
  prepareClientWssForCurrentHost: RelayV2BrokerClientWssCurrentHostPreparePort;
  attachPreparedClientWss(
    input: RelayV2BrokerClientWssAttachPreparedInput,
  ): RelayV2BrokerClientWssConnectionHandle;
}>;

export interface RelayV2BrokerClientWssNodeListenerFreeIngressOptions {
  readonly verifyV2AccessToken: RelayV2BrokerClientUpgradeVerifyPort;
  /** Borrowed private shared-owner port; the ingress never seals or closes it. */
  readonly runtime: RelayV2BrokerClientWssNodeIngressRuntime;
}

export interface RelayV2BrokerClientWssNodeUpgradeRequestInput {
  readonly request: IncomingMessage;
  readonly socket: Duplex;
  readonly head: Uint8Array;
}

export interface RelayV2BrokerClientWssNodeListenerFreeIngress {
  handleUpgradeRequest(
    input: RelayV2BrokerClientWssNodeUpgradeRequestInput,
  ): Promise<"upgraded" | "rejected">;
  closeAndDrain(): Promise<void>;
}

export interface RelayV2BrokerClientWssNodePrivateIngressChild {
  closeAndDrain(): Promise<void>;
}

type CapturedRuntime = Readonly<{
  receiver: RelayV2BrokerClientWssNodeIngressRuntime & object;
  installTrustedSocketCapture: Function;
  prepareClientWssForCurrentHost: Function;
  attachPreparedClientWss: Function;
}>;

type CapturedRejectSocket = Readonly<{
  receiver: Duplex;
  end: Function;
  destroy: Function;
  destroyOnce(): void;
}>;

type CapturedRequest = Readonly<{
  metadata: RelayV2BrokerClientUpgradeMetadata;
  rawHeaders: readonly string[];
}>;

type Deferred = Readonly<{
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}>;

function failure(): Error {
  return new Error("Relay v2 Broker client WSS Node listener-free ingress failed");
}

function rejectedFailure<T>(): Promise<T> {
  const rejected = Promise.reject<T>(failure());
  void rejected.catch(() => undefined);
  return rejected;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  void promise.catch(() => undefined);
  return Object.freeze({ promise, resolve, reject });
}

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

function captureRuntime(value: unknown): CapturedRuntime | null {
  if (value === null || typeof value !== "object" || rejectedProxy(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).length !== RUNTIME_METHODS.length
      || RUNTIME_METHODS.some((name) => (
        !descriptors[name]
        || !Object.hasOwn(descriptors[name]!, "value")
        || typeof descriptors[name]!.value !== "function"
        || rejectedProxy(descriptors[name]!.value)
      ))
    ) return null;
    return Object.freeze({
      receiver: value as RelayV2BrokerClientWssNodeIngressRuntime & object,
      installTrustedSocketCapture:
        descriptors.installTrustedSocketCapture!.value as Function,
      prepareClientWssForCurrentHost:
        descriptors.prepareClientWssForCurrentHost!.value as Function,
      attachPreparedClientWss: descriptors.attachPreparedClientWss!.value as Function,
    });
  } catch {
    return null;
  }
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
  let destroyed = false;
  const captured = Object.freeze({
    receiver: value,
    end,
    destroy,
    destroyOnce(): void {
      if (destroyed) return;
      destroyed = true;
      try {
        Reflect.apply(destroy, value, []);
      } catch {}
    },
  });
  return captured;
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

function captureRawHeaders(value: unknown): readonly string[] | null {
  if (rejectedProxy(value) || !Array.isArray(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
    const rawLength = lengthDescriptor?.value;
    if (
      !lengthDescriptor
      || !Object.hasOwn(lengthDescriptor, "value")
      || typeof rawLength !== "number"
      || !Number.isSafeInteger(rawLength)
      || rawLength < 0
      || rawLength % 2 !== 0
      || Reflect.ownKeys(descriptors).length !== rawLength + 1
    ) return null;
    const length = rawLength;
    const captured: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        !descriptor
        || !Object.hasOwn(descriptor, "value")
        || typeof descriptor.value !== "string"
      ) return null;
      captured.push(descriptor.value);
    }
    return Object.freeze(captured);
  } catch {
    return null;
  }
}

function metadataFromRawHeaders(
  pathname: string,
  search: string,
  rawHeaders: readonly string[],
): RelayV2BrokerClientUpgradeMetadata {
  const authorizationHeaders: string[] = [];
  const offeredProtocols: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const lowerName = rawHeaders[index].toLowerCase();
    const value = rawHeaders[index + 1];
    if (lowerName === "authorization") {
      authorizationHeaders.push(value);
    } else if (lowerName === "sec-websocket-protocol") {
      for (const protocol of value.split(",")) offeredProtocols.push(trimHttpOws(protocol));
    }
  }
  return Object.freeze(Object.assign(Object.create(null), {
    pathname,
    search,
    authorizationHeaders: Object.freeze(authorizationHeaders),
    legacyQuerySecret: null,
    offeredProtocols: Object.freeze(offeredProtocols),
  })) as RelayV2BrokerClientUpgradeMetadata;
}

function captureRequest(
  value: unknown,
  expectedSocket: Duplex,
): CapturedRequest | null {
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
    const capturedRawHeaders = captureRawHeaders(rawHeaders.value);
    if (!target || !capturedRawHeaders) return null;
    return Object.freeze({
      metadata: metadataFromRawHeaders(
        target.pathname,
        target.search,
        capturedRawHeaders,
      ),
      rawHeaders: capturedRawHeaders,
    });
  } catch {
    return null;
  }
}

function sameRequestCapture(left: CapturedRequest, right: CapturedRequest | null): boolean {
  if (!right) return false;
  if (
    left.metadata.pathname !== right.metadata.pathname
    || left.metadata.search !== right.metadata.search
    || left.rawHeaders.length !== right.rawHeaders.length
  ) return false;
  return left.rawHeaders.every((value, index) => value === right.rawHeaders[index]);
}

function hasExactNormalizedClientProtocol(request: IncomingMessage): boolean {
  try {
    const offered = request.headers["sec-websocket-protocol"];
    if (typeof offered !== "string") return false;
    const protocols = offered.split(",").map(trimHttpOws);
    return protocols.length === 1 && protocols[0] === CLIENT_SUBPROTOCOL;
  } catch {
    return false;
  }
}

function equivalentBufferView(head: Uint8Array): Buffer {
  return Buffer.isBuffer(head)
    ? head
    : Buffer.from(head.buffer, head.byteOffset, head.byteLength);
}

function endRejectResponse(
  socket: CapturedRejectSocket,
  status: (typeof REJECT_STATUSES)[number],
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof nodeSetTimeout> | null = null;
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (deadline !== null) {
        nodeClearTimeout(deadline);
        deadline = null;
      }
      if (error !== undefined && error !== null) {
        socket.destroyOnce();
        reject(failure());
      } else {
        resolve();
      }
    };
    try {
      deadline = nodeSetTimeout(() => settle(failure()), REJECT_END_DEADLINE_MS);
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

function captureConnectionDrain(value: unknown): Promise<void> | null {
  if (value === null || typeof value !== "object" || rejectedProxy(value)) return null;
  try {
    const drained = Reflect.getOwnPropertyDescriptor(value, "drained");
    return drained
      && Object.hasOwn(drained, "value")
      && nodeUtilTypes.isPromise(drained.value)
      ? drained.value as Promise<void>
      : null;
  } catch {
    return null;
  }
}

/**
 * Default-off Node client WSS ingress. It owns no HTTP(S) listener, bound
 * socket, port, credential authority, capability advertisement, or fallback.
 * The caller explicitly hands it one server Upgrade request/socket/head cut.
 */
export function createRelayV2BrokerClientWssNodeListenerFreeIngress(
  options: RelayV2BrokerClientWssNodeListenerFreeIngressOptions,
  bindPrivateCloseChild?: (
    child: RelayV2BrokerClientWssNodePrivateIngressChild,
  ) => void,
): RelayV2BrokerClientWssNodeListenerFreeIngress {
  const capturedOptions = captureExactDataRecord(options, OPTION_KEYS);
  const verifyV2AccessToken = capturedOptions?.verifyV2AccessToken;
  if (
    typeof verifyV2AccessToken !== "function"
    || rejectedProxy(verifyV2AccessToken)
  ) throw failure();

  const brandedSockets = new WeakSet<object>();
  const trustedSocketBrand = Object.freeze((socket: RelayV2BrokerClientWssSocket): boolean => (
    socket !== null
    && typeof socket === "object"
    && brandedSockets.has(socket as object)
  ));
  const webSocketServer = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: RELAY_V2_BROKER_LIMITS.maxFrameBytes,
    handleProtocols(protocols): string {
      if (protocols.size !== 1 || !protocols.has(CLIENT_SUBPROTOCOL)) throw failure();
      return CLIENT_SUBPROTOCOL;
    },
  });
  const runtime = captureRuntime(capturedOptions?.runtime);
  if (!runtime) {
    try { webSocketServer.close(() => undefined); } catch {}
    throw failure();
  }
  try {
    if (Reflect.apply(runtime.installTrustedSocketCapture, runtime.receiver, [
      WebSocket.prototype,
      trustedSocketBrand,
    ]) !== undefined) throw failure();
  } catch {
    try { webSocketServer.close(() => undefined); } catch {}
    throw failure();
  }
  const dispatch = new RelayV2BrokerClientUpgradeDispatchOwner({
    verifyV2AccessToken: verifyV2AccessToken as RelayV2BrokerClientUpgradeVerifyPort,
    prepareClientWssForCurrentHost: (input) => Reflect.apply(
      runtime.prepareClientWssForCurrentHost,
      runtime.receiver,
      [input],
    ) as ReturnType<RelayV2BrokerClientWssCurrentHostPreparePort>,
  });

  let lifecycle: "open" | "closing" | "closed" = "open";
  let activeNativeUpgrades = 0;
  const activeHandlers = new Set<Promise<void>>();
  let noServerClose: Deferred | null = null;
  let noServerCloseStarted = false;
  let ownedClose: Promise<void> | null = null;
  let publicClose: Promise<void> | null = null;
  let ingress!: RelayV2BrokerClientWssNodeListenerFreeIngress;

  const finishNoServerClose = (): void => {
    if (!noServerClose || noServerCloseStarted || activeNativeUpgrades !== 0) return;
    noServerCloseStarted = true;
    try {
      webSocketServer.close((error) => {
        if (error) noServerClose?.reject(failure());
        else noServerClose?.resolve();
      });
    } catch {
      noServerClose.reject(failure());
    }
  };

  const beginNoServerClose = (): Promise<void> => {
    if (noServerClose) return noServerClose.promise;
    noServerClose = deferred();
    finishNoServerClose();
    return noServerClose.promise;
  };

  const beginOwnedClose = (): Promise<void> => {
    if (ownedClose) return ownedClose;
    lifecycle = "closing";
    const published = deferred();
    ownedClose = published.promise;

    const nativeClose = beginNoServerClose();
    void Promise.allSettled([nativeClose]).then((settlements) => {
      lifecycle = "closed";
      if (settlements.some((result) => result.status === "rejected")) {
        published.reject(failure());
      } else {
        published.resolve();
      }
    });
    return ownedClose;
  };

  const stopUpgradedSocket = (
    webSocket: WebSocket,
    rawSocket: CapturedRejectSocket,
  ): void => {
    brandedSockets.delete(webSocket);
    try {
      if (webSocket.terminate() === undefined) return;
    } catch {}
    rawSocket.destroyOnce();
  };

  const handleUpgradeRequest = function handleUpgradeRequest(
    this: unknown,
    input: RelayV2BrokerClientWssNodeUpgradeRequestInput,
  ): Promise<"upgraded" | "rejected"> {
    if (this !== ingress) return rejectedFailure();

    const captured = captureExactDataRecord(input, INPUT_KEYS);
    if (!captured) return rejectedFailure();
    const rawSocket = captureRejectSocket(captured.socket);
    if (!rawSocket) return rejectedFailure();
    if (lifecycle !== "open") {
      return endRejectResponse(rawSocket, 503).then(
        () => "rejected" as const,
        () => { throw failure(); },
      );
    }
    if (
      rejectedProxy(captured.head)
      || !(captured.head instanceof Uint8Array)
    ) {
      return endRejectResponse(rawSocket, 400).then(
        () => "rejected" as const,
        () => { throw failure(); },
      );
    }

    const handlerBarrier = deferred();
    activeHandlers.add(handlerBarrier.promise);
    const operation = (async (): Promise<"upgraded" | "rejected"> => {
      const request = captureRequest(captured.request, rawSocket.receiver);
      if (!request) {
        await endRejectResponse(rawSocket, 400);
        return "rejected";
      }

      let dispatched: Awaited<ReturnType<RelayV2BrokerClientUpgradeDispatchOwner["dispatch"]>>;
      try {
        dispatched = await dispatch.dispatch(request.metadata);
      } catch {
        rawSocket.destroyOnce();
        throw failure();
      }
      if (dispatched.outcome === "reject") {
        await endRejectResponse(rawSocket, dispatched.status);
        return "rejected";
      }
      if (lifecycle !== "open") {
        await endRejectResponse(rawSocket, 503);
        return "rejected";
      }

      const reboundRequest = captureRequest(captured.request, rawSocket.receiver);
      if (!sameRequestCapture(request, reboundRequest)) {
        await endRejectResponse(rawSocket, 400);
        return "rejected";
      }
      if (!hasExactNormalizedClientProtocol(captured.request as IncomingMessage)) {
        await endRejectResponse(rawSocket, 426);
        return "rejected";
      }

      let phase: "invoking" | "returned" | "completed" | "failed" = "invoking";
      const callbacks: Array<Readonly<{
        requestMatched: boolean;
        socket: WebSocket | null;
      }>> = [];
      let upgradedSocket: WebSocket | null = null;
      const callback = (socket: WebSocket, callbackRequest: IncomingMessage): void => {
        const observation = Object.freeze({
          requestMatched: callbackRequest === captured.request,
          socket: socket instanceof WebSocket && !rejectedProxy(socket) ? socket : null,
        });
        if (phase === "invoking") {
          callbacks.push(observation);
          return;
        }
        if (observation.socket) stopUpgradedSocket(observation.socket, rawSocket);
        else rawSocket.destroyOnce();
        if (
          phase === "completed"
          && upgradedSocket
          && observation.socket !== upgradedSocket
        ) stopUpgradedSocket(upgradedSocket, rawSocket);
      };

      activeNativeUpgrades += 1;
      let nativeUpgradeReleased = false;
      const releaseNativeUpgrade = (): void => {
        if (nativeUpgradeReleased) return;
        nativeUpgradeReleased = true;
        activeNativeUpgrades -= 1;
        finishNoServerClose();
      };
      try {
        let nativeResult: unknown;
        try {
          nativeResult = webSocketServer.handleUpgrade(
            captured.request as IncomingMessage,
            rawSocket.receiver,
            equivalentBufferView(captured.head as Uint8Array),
            callback,
          );
        } catch {
          phase = "failed";
          for (const observation of callbacks) {
            if (observation.socket) stopUpgradedSocket(observation.socket, rawSocket);
          }
          rawSocket.destroyOnce();
          throw failure();
        }
        releaseNativeUpgrade();
        phase = "returned";
        const observation = callbacks[0];
        if (
          nativeResult !== undefined
          || callbacks.length !== 1
          || !observation
          || !observation.requestMatched
          || !observation.socket
          || observation.socket.protocol !== CLIENT_SUBPROTOCOL
          || observation.socket.extensions !== ""
        ) {
          phase = "failed";
          for (const candidate of callbacks) {
            if (candidate.socket) stopUpgradedSocket(candidate.socket, rawSocket);
          }
          rawSocket.destroyOnce();
          throw failure();
        }
        upgradedSocket = observation.socket;

        if (lifecycle !== "open") {
          phase = "failed";
          stopUpgradedSocket(upgradedSocket, rawSocket);
          await beginOwnedClose();
          throw failure();
        }

        let attached: unknown;
        try {
          brandedSockets.add(upgradedSocket);
          attached = Reflect.apply(runtime.attachPreparedClientWss, runtime.receiver, [
            Object.freeze({
              admissionReceipt: dispatched.admissionReceipt,
              alreadyUpgradedSocket: upgradedSocket as RelayV2BrokerClientWssSocket,
            }),
          ]);
        } catch {
          phase = "failed";
          stopUpgradedSocket(upgradedSocket, rawSocket);
          await beginOwnedClose();
          throw failure();
        } finally {
          brandedSockets.delete(upgradedSocket);
        }
        const connectionDrain = captureConnectionDrain(attached);
        if (!connectionDrain) {
          phase = "failed";
          stopUpgradedSocket(upgradedSocket, rawSocket);
          await beginOwnedClose();
          throw failure();
        }
        // The runtime may publish its first route effect on the microtask that
        // follows attach. Give a concurrent ingress close that exact cut, then
        // recheck before publishing the successful Upgrade result.
        await Promise.resolve();
        if (lifecycle !== "open") {
          phase = "failed";
          stopUpgradedSocket(upgradedSocket, rawSocket);
          await beginOwnedClose();
          throw failure();
        }
        phase = "completed";
        return "upgraded";
      } finally {
        releaseNativeUpgrade();
      }
    })();

    void operation.then(
      () => {
        activeHandlers.delete(handlerBarrier.promise);
        handlerBarrier.resolve();
      },
      () => {
        activeHandlers.delete(handlerBarrier.promise);
        handlerBarrier.reject(failure());
      },
    );
    return operation;
  };

  const closeAndDrain = function closeAndDrain(this: unknown): Promise<void> {
    if (this !== ingress) return rejectedFailure();
    if (publicClose) return publicClose;
    const admittedHandlers = [...activeHandlers];
    const owned = beginOwnedClose();
    publicClose = Promise.allSettled([owned, ...admittedHandlers]).then((settlements) => {
      if (settlements.some((settlement) => settlement.status === "rejected")) {
        throw failure();
      }
    });
    void publicClose.catch(() => undefined);
    return publicClose;
  };

  ingress = Object.freeze(Object.assign(Object.create(null), {
    handleUpgradeRequest,
    closeAndDrain,
  })) as RelayV2BrokerClientWssNodeListenerFreeIngress;
  if (bindPrivateCloseChild !== undefined) {
    if (typeof bindPrivateCloseChild !== "function" || rejectedProxy(bindPrivateCloseChild)) {
      void beginOwnedClose();
      throw failure();
    }
    let child!: RelayV2BrokerClientWssNodePrivateIngressChild;
    const closeChild = function closeChild(this: unknown): Promise<void> {
      return this === child ? ingress.closeAndDrain() : rejectedFailure();
    };
    child = Object.freeze(Object.assign(Object.create(null), {
      closeAndDrain: closeChild,
    })) as RelayV2BrokerClientWssNodePrivateIngressChild;
    try {
      Reflect.apply(bindPrivateCloseChild, undefined, [child]);
    } catch {
      void beginOwnedClose();
      throw failure();
    }
  }
  return ingress;
}
