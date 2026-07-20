import { types as nodeTypes } from "node:util";
import WebSocket from "ws";
import { RELAY_V2_CARRIER_FRAME_BYTES } from "./codec.js";
import type {
  RelayV2HostCarrierConnection,
  RelayV2HostCarrierTransport,
} from "./hostCarrier.js";
import {
  captureRelayV2HostCredentialConnectionAdmission,
  claimRelayV2HostCredentialConnectionAuthorization,
  createRelayV2HostCredentialConnectionTransportOwner,
  finalizeRelayV2HostCredentialConnectionAuthorization,
  isRelayV2HostCredentialAuthority,
  releaseRelayV2HostCredentialConnectionAuthorization,
  releaseRelayV2HostCredentialConnectionAdmission,
  type RelayV2HostCredentialAuthority,
  type RelayV2HostCredentialConnectionAdmission,
  type RelayV2HostCredentialConnectionAuthorization,
  type RelayV2HostCredentialConnectionRequestFinalizationPort,
  type RelayV2HostCredentialConnectionTransportOwner,
} from "./hostCredentialAuthority.js";
import type {
  RelayV2HostManagedConnectorTransportLifecycle,
  RelayV2HostManagedConnectorTransportLifecycleFactoryInput,
  RelayV2HostManagedConnectorTransportLifecycleFactoryPort,
} from "./hostRuntimeComposition.js";

export const RELAY_V2_HOST_WSS_SUBPROTOCOL = "tw-relay.host.v2" as const;

const DEFAULT_MAX_BUFFERED_BYTES = 16 * 1_048_576;
const DEFAULT_CLOSE_DRAIN_DEADLINE_MS = 5_000;
const MAX_CLOSE_DRAIN_DEADLINE_MS = 30_000;
const factoryAuthorityKey = Object.freeze({});

type DataRecord = Record<string, unknown>;
type CloseDrainScheduler = (delayMs: number, callback: () => void) => () => void;

export interface RelayV2HostWssConstructorOptions {
  readonly perMessageDeflate: false;
  readonly maxPayload: number;
  readonly finishRequest: (request: object, webSocket: object) => void;
}

export interface RelayV2HostWssConstructorPort {
  new (
    address: string,
    protocols: string[],
    options: RelayV2HostWssConstructorOptions,
  ): object;
}

export interface RelayV2HostWssTransportLifecycleFactoryOptions {
  readonly relayUrl: string;
  readonly credentialAuthority: RelayV2HostCredentialAuthority;
  readonly webSocketConstructor?: RelayV2HostWssConstructorPort;
  readonly maxBufferedBytes?: number;
  readonly closeDrainDeadlineMs?: number;
  readonly scheduleCloseDrain?: CloseDrainScheduler;
}

export interface RelayV2HostWssPreparedAttemptInput
extends RelayV2HostManagedConnectorTransportLifecycleFactoryInput {
  readonly credentialReferences: unknown;
}

interface PreparedAttempt {
  readonly input: RelayV2HostManagedConnectorTransportLifecycleFactoryInput;
  readonly admission: RelayV2HostCredentialConnectionAdmission;
}

interface CapturedSocket {
  readonly receiver: object;
  readonly on: Function;
  readonly removeListener: Function;
  readonly send: Function;
  readonly close: Function;
  readonly terminate: Function;
}

interface CapturedConnection {
  readonly receiver: object;
  readonly receive: Function;
  readonly acknowledge: Function;
  readonly writable: Function;
  readonly closed: Function;
}

interface CapturedHandshakeRequest {
  readonly receiver: object;
  readonly setHeader: Function;
  readonly end: Function;
  readonly destroy: Function;
}

interface CapturedHandshakeRequestDestroy {
  readonly receiver: object;
  readonly destroy: Function;
}

interface AcceptedFrame {
  readonly bytes: Uint8Array;
  readonly deliveryToken: string;
}

interface SocketListeners {
  readonly open: () => void;
  readonly message: (data: unknown, isBinary: unknown) => void;
  readonly error: () => void;
  readonly close: (code: unknown) => void;
  readonly unexpectedResponse: () => void;
}

export class RelayV2HostWssTransportLifecycleError extends Error {
  constructor() {
    super("Relay v2 host WSS transport lifecycle failed");
    this.name = "RelayV2HostWssTransportLifecycleError";
  }
}

function failure(): RelayV2HostWssTransportLifecycleError {
  return new RelayV2HostWssTransportLifecycleError();
}

function exactDataObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): DataRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || nodeTypes.isProxy(value)) throw failure();
  let descriptors: PropertyDescriptorMap;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw failure();
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw failure();
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))
    || required.some((key) => !Object.hasOwn(descriptors, key))
    || keys.some((key) => !Object.hasOwn(descriptors[key as string], "value"))) {
    throw failure();
  }
  return Object.fromEntries(
    (keys as string[]).map((key) => [key, descriptors[key].value]),
  );
}

function captureMethod(value: unknown, name: string): Function {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) throw failure();
  let owner: object | null = value;
  while (owner !== null) {
    if (nodeTypes.isProxy(owner)) throw failure();
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(owner, name); } catch { throw failure(); }
    if (descriptor !== undefined) {
      if (!Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
        throw failure();
      }
      return descriptor.value;
    }
    try { owner = Object.getPrototypeOf(owner); } catch { throw failure(); }
  }
  throw failure();
}

function positiveBound(value: unknown, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected)
    || (selected as number) <= 0
    || (selected as number) > maximum) throw failure();
  return selected as number;
}

function exactHostUrl(value: unknown): string {
  if (typeof value !== "string") throw failure();
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw failure(); }
  if (parsed.protocol !== "wss:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.hostname === "") throw failure();
  parsed.pathname = "/host";
  return parsed.toString();
}

function captureLifecycleInput(
  value: unknown,
): RelayV2HostManagedConnectorTransportLifecycleFactoryInput {
  const fields = exactDataObject(value, [
    "requestId", "controllerGeneration", "hostId", "hostEpoch",
    "hostInstanceId", "credentialReference", "signal",
  ]);
  for (const name of [
    "requestId", "controllerGeneration", "hostId", "hostEpoch",
    "hostInstanceId", "credentialReference",
  ]) {
    if (typeof fields[name] !== "string" || fields[name] === "") throw failure();
  }
  if (!(fields.signal instanceof AbortSignal)) throw failure();
  return Object.freeze({
    requestId: fields.requestId as string,
    controllerGeneration: fields.controllerGeneration as string,
    hostId: fields.hostId as string,
    hostEpoch: fields.hostEpoch as string,
    hostInstanceId: fields.hostInstanceId as string,
    credentialReference: fields.credentialReference as string,
    signal: fields.signal,
  });
}

function sameLifecycleInput(
  left: RelayV2HostManagedConnectorTransportLifecycleFactoryInput,
  right: RelayV2HostManagedConnectorTransportLifecycleFactoryInput,
): boolean {
  return left.requestId === right.requestId
    && left.controllerGeneration === right.controllerGeneration
    && left.hostId === right.hostId
    && left.hostEpoch === right.hostEpoch
    && left.hostInstanceId === right.hostInstanceId
    && left.credentialReference === right.credentialReference
    && left.signal === right.signal;
}

function captureSocket(value: unknown): CapturedSocket {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) throw failure();
  return Object.freeze({
    receiver: value,
    on: captureMethod(value, "on"),
    removeListener: captureMethod(value, "removeListener"),
    send: captureMethod(value, "send"),
    close: captureMethod(value, "close"),
    terminate: captureMethod(value, "terminate"),
  });
}

function captureConnection(value: unknown): CapturedConnection {
  const fields = exactDataObject(value, [
    "generation", "receive", "acknowledge", "rejectUnaccepted", "writable", "closed",
  ]);
  if (!Number.isSafeInteger(fields.generation) || (fields.generation as number) <= 0
    || typeof fields.receive !== "function"
    || typeof fields.acknowledge !== "function"
    || typeof fields.rejectUnaccepted !== "function"
    || typeof fields.writable !== "function"
    || typeof fields.closed !== "function") throw failure();
  return Object.freeze({
    receiver: value as object,
    receive: fields.receive as Function,
    acknowledge: fields.acknowledge as Function,
    writable: fields.writable as Function,
    closed: fields.closed as Function,
  });
}

function captureHandshakeRequestDestroy(value: unknown): CapturedHandshakeRequestDestroy {
  if (typeof value !== "object" || value === null || nodeTypes.isProxy(value)) throw failure();
  const destroy = captureMethod(value, "destroy");
  let destroyed = false;
  return Object.freeze({
    receiver: value,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      Reflect.apply(destroy, value, []);
    },
  });
}

function captureHandshakeRequest(
  destroyOwner: CapturedHandshakeRequestDestroy,
): CapturedHandshakeRequest {
  return Object.freeze({
    receiver: destroyOwner.receiver,
    setHeader: captureMethod(destroyOwner.receiver, "setHeader"),
    end: captureMethod(destroyOwner.receiver, "end"),
    destroy: destroyOwner.destroy,
  });
}

function destroyHandshakeRequest(request: CapturedHandshakeRequestDestroy | null): void {
  if (request === null) return;
  try { Reflect.apply(request.destroy, request.receiver, []); } catch {}
}

function createRequestFinalizationPort(
  request: CapturedHandshakeRequest,
  isCurrent: () => boolean,
): RelayV2HostCredentialConnectionRequestFinalizationPort {
  let spent = false;
  const port = Object.create(null) as RelayV2HostCredentialConnectionRequestFinalizationPort;
  Object.defineProperty(port, "finalize", {
    configurable: false,
    enumerable: false,
    writable: false,
    value(authorizationValue: string): void {
      if (spent
        || typeof authorizationValue !== "string"
        || !authorizationValue.startsWith("Bearer ")
        || authorizationValue.length === "Bearer ".length) throw failure();
      spent = true;
      try {
        if (!isCurrent()) throw failure();
        Reflect.apply(request.setHeader, request.receiver, [
          "Authorization",
          authorizationValue,
        ]);
        if (!isCurrent()) throw failure();
        Reflect.apply(request.end, request.receiver, []);
        if (!isCurrent()) throw failure();
      } catch {
        destroyHandshakeRequest(request);
        throw failure();
      }
    },
  });
  return Object.freeze(port);
}

function socketState(socket: CapturedSocket): number | null {
  let value: unknown;
  try { value = Reflect.get(socket.receiver, "readyState", socket.receiver); } catch { return null; }
  return Number.isSafeInteger(value) ? value as number : null;
}

function socketString(socket: CapturedSocket, name: "protocol" | "extensions"): string | null {
  let value: unknown;
  try { value = Reflect.get(socket.receiver, name, socket.receiver); } catch { return null; }
  return typeof value === "string" ? value : null;
}

function binaryFrame(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer)) return null;
  return Uint8Array.from(value);
}

function defaultCloseDrainScheduler(delayMs: number, callback: () => void): () => void {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
}

function createLifecycle(input: Readonly<{
  endpoint: string;
  webSocketConstructor: RelayV2HostWssConstructorPort;
  credentialAuthority: RelayV2HostCredentialAuthority;
  transportOwner: RelayV2HostCredentialConnectionTransportOwner;
  admission: RelayV2HostCredentialConnectionAdmission;
  attempt: RelayV2HostManagedConnectorTransportLifecycleFactoryInput;
  maxBufferedBytes: number;
  closeDrainDeadlineMs: number;
  scheduleCloseDrain: CloseDrainScheduler;
}>): RelayV2HostManagedConnectorTransportLifecycle {
  const accepted: AcceptedFrame[] = [];
  const deliveryTokens = new Set<string>();
  let ownedBytes = 0;
  let writing: AcceptedFrame | null = null;
  let connection: CapturedConnection | null = null;
  let socket: CapturedSocket | null = null;
  let listeners: SocketListeners | null = null;
  let phase: "unbound" | "connecting" | "open" | "closing" | "closed" = "unbound";
  let admissionOwned = true;
  let actorCallbacksActive = false;
  let closeNotified = false;
  let closeDeadlineCancel: (() => void) | null = null;
  let drainProof: object | null = null;
  let drainPromise: Promise<object> | null = null;
  let resolveDrain: ((proof: object) => void) | null = null;
  let closedCleanupComplete = false;

  const removeListeners = (): void => {
    if (socket === null || listeners === null) return;
    for (const [event, listener] of [
      ["open", listeners.open],
      ["message", listeners.message],
      ["error", listeners.error],
      ["close", listeners.close],
      ["unexpected-response", listeners.unexpectedResponse],
    ] as const) {
      try {
        Reflect.apply(socket.removeListener, socket.receiver, [event, listener]);
      } catch {}
    }
    listeners = null;
  };

  const releaseAdmission = (): void => {
    if (!admissionOwned) return;
    admissionOwned = false;
    releaseRelayV2HostCredentialConnectionAdmission(
      input.credentialAuthority,
      input.transportOwner,
      input.admission,
    );
  };

  const notifyClosed = (code?: number): void => {
    if (closeNotified) return;
    closeNotified = true;
    const activeConnection = connection;
    actorCallbacksActive = false;
    accepted.length = 0;
    deliveryTokens.clear();
    writing = null;
    ownedBytes = 0;
    if (activeConnection !== null) {
      try {
        Reflect.apply(activeConnection.closed, activeConnection.receiver, [code]);
      } catch {}
    }
  };

  const settleDrain = (): void => {
    if (!closedCleanupComplete || drainProof === null || resolveDrain === null) return;
    const resolve = resolveDrain;
    resolveDrain = null;
    try { resolve(drainProof); } catch {}
  };

  const finishClosed = (): void => {
    if (phase === "closed") return;
    phase = "closed";
    actorCallbacksActive = false;
    try { input.attempt.signal.removeEventListener("abort", abortAttempt); } catch {}
    const cancel = closeDeadlineCancel;
    closeDeadlineCancel = null;
    if (cancel !== null) {
      try { cancel(); } catch {}
    }
    try { removeListeners(); } catch {}
    try { releaseAdmission(); } catch {}
    try { notifyClosed(); } catch {}
    closedCleanupComplete = true;
    settleDrain();
  };

  const terminateAndFinish = (): void => {
    const activeSocket = socket;
    actorCallbacksActive = false;
    removeListeners();
    if (activeSocket !== null && socketState(activeSocket) !== 3) {
      try { Reflect.apply(activeSocket.terminate, activeSocket.receiver, []); } catch {}
    }
    finishClosed();
  };

  const startCloseDeadline = (): void => {
    if (closeDeadlineCancel !== null || phase === "closed") return;
    let cancel: unknown;
    let fired = false;
    try {
      cancel = input.scheduleCloseDrain(
        input.closeDrainDeadlineMs,
        () => {
          fired = true;
          terminateAndFinish();
        },
      );
    } catch {
      terminateAndFinish();
      return;
    }
    if (typeof cancel !== "function") {
      terminateAndFinish();
      return;
    }
    if (fired || phase === "closed") {
      try { Reflect.apply(cancel as Function, undefined, []); } catch {}
      return;
    }
    closeDeadlineCancel = cancel as () => void;
  };

  const closeSocket = (code: number, reason: string): void => {
    if (phase === "closed" || phase === "closing") return;
    phase = "closing";
    notifyClosed(code);
    releaseAdmission();
    const activeSocket = socket;
    if (activeSocket === null) {
      finishClosed();
      return;
    }
    const state = socketState(activeSocket);
    if (phase !== "closing" || socket !== activeSocket) return;
    if (state === 3) {
      finishClosed();
      return;
    }
    try {
      Reflect.apply(activeSocket.close, activeSocket.receiver, [code, reason]);
    } catch {
      terminateAndFinish();
      return;
    }
    if (phase === "closing" && socket === activeSocket) startCloseDeadline();
  };

  const protocolFailure = (): void => closeSocket(4406, "protocol_error");

  const flush = (): void => {
    if (phase !== "open" || socket === null || connection === null
      || !actorCallbacksActive || writing !== null) return;
    const item = accepted[0];
    if (item === undefined) return;
    writing = item;
    let returned: unknown;
    let sendAccepted = false;
    let callbackObserved = false;
    let callbackFailed = false;
    let settlementScheduled = false;
    let settled = false;
    const settleWrite = (): void => {
      settlementScheduled = false;
      if (!sendAccepted || !callbackObserved) return;
      if (settled) {
        if (phase === "open" && actorCallbacksActive) closeSocket(1011, "write_failed");
        return;
      }
      if (phase !== "open" || !actorCallbacksActive
        || writing !== item || accepted[0] !== item) return;
      settled = true;
      if (callbackFailed) {
        closeSocket(1011, "write_failed");
        return;
      }
      accepted.shift();
      deliveryTokens.delete(item.deliveryToken);
      writing = null;
      ownedBytes -= item.bytes.byteLength;
      const activeConnection = connection;
      if (activeConnection === null) {
        closeSocket(1011, "write_failed");
        return;
      }
      try {
        Reflect.apply(activeConnection.acknowledge, activeConnection.receiver, [
          item.deliveryToken,
        ]);
        if (phase !== "open" || !actorCallbacksActive) return;
        Reflect.apply(activeConnection.writable, activeConnection.receiver, []);
      } catch {
        closeSocket(1011, "write_failed");
        return;
      }
      flush();
    };
    const scheduleSettlement = (): void => {
      if (settlementScheduled) return;
      settlementScheduled = true;
      queueMicrotask(settleWrite);
    };
    try {
      returned = Reflect.apply(socket.send, socket.receiver, [
        item.bytes,
        Object.freeze({ binary: true, compress: false }),
        (error?: unknown): void => {
          if (callbackObserved) callbackFailed = true;
          callbackObserved = true;
          if (error !== undefined && error !== null) callbackFailed = true;
          if (sendAccepted) scheduleSettlement();
        },
      ]);
    } catch {
      closeSocket(1011, "write_failed");
      return;
    }
    if (returned !== undefined) {
      closeSocket(1011, "write_refused");
      return;
    }
    sendAccepted = true;
    if (callbackObserved) scheduleSettlement();
  };

  const onOpen = (): void => {
    const activeSocket = socket;
    if (activeSocket === null || phase !== "connecting") return;
    const state = socketState(activeSocket);
    if (phase !== "connecting" || socket !== activeSocket) return;
    const protocol = socketString(activeSocket, "protocol");
    if (phase !== "connecting" || socket !== activeSocket) return;
    const extensions = socketString(activeSocket, "extensions");
    if (phase !== "connecting" || socket !== activeSocket) return;
    if (state !== 1
      || protocol !== RELAY_V2_HOST_WSS_SUBPROTOCOL
      || extensions !== "") {
      protocolFailure();
      return;
    }
    phase = "open";
    flush();
  };

  const onMessage = (data: unknown, isBinary: unknown): void => {
    if (phase !== "open" || !actorCallbacksActive || connection === null) return;
    const bytes = isBinary === true ? binaryFrame(data) : null;
    if (bytes === null || bytes.byteLength > RELAY_V2_CARRIER_FRAME_BYTES) {
      protocolFailure();
      return;
    }
    try {
      Reflect.apply(connection.receive, connection.receiver, [bytes]);
    } catch {
      protocolFailure();
    }
  };

  const onError = (): void => {
    if (phase === "closed" || phase === "closing") return;
    closeSocket(1011, "transport_error");
  };

  const onClose = (code: unknown): void => {
    if (phase === "closed") return;
    const safeCode = Number.isInteger(code) && (code as number) >= 0
      && (code as number) <= 65_535 ? code as number : undefined;
    notifyClosed(safeCode);
    finishClosed();
  };

  const onUnexpectedResponse = (): void => protocolFailure();

  function abortAttempt(): void {
    closeSocket(1000, "host_shutdown");
  }

  const openSocket = (): void => {
    if (phase !== "unbound" || input.attempt.signal.aborted) throw failure();
    let rawSocket: unknown;
    let authorization: RelayV2HostCredentialConnectionAuthorization | null = null;
    let authorizationOwned = false;
    let handshakeRequest: CapturedHandshakeRequest | null = null;
    let requestWebSocket: object | null = null;
    let requestFinalizationCalls = 0;
    let requestFinalizationFailed = false;
    let requestCaptureOpen = true;
    try {
      authorization = claimRelayV2HostCredentialConnectionAuthorization(
        input.credentialAuthority,
        input.transportOwner,
        input.admission,
      );
      admissionOwned = false;
      authorizationOwned = true;
      const finishRequest = (request: object, webSocket: object): void => {
        requestFinalizationCalls += 1;
        let destroyOwner: CapturedHandshakeRequestDestroy | null = null;
        try {
          destroyOwner = captureHandshakeRequestDestroy(request);
        } catch {
          requestFinalizationFailed = true;
          closeSocket(4406, "protocol_error");
          throw failure();
        }
        if (!requestCaptureOpen
          || requestFinalizationCalls !== 1
          || typeof webSocket !== "object"
          || webSocket === null
          || nodeTypes.isProxy(webSocket)) {
          requestFinalizationFailed = true;
          destroyHandshakeRequest(destroyOwner);
          destroyHandshakeRequest(handshakeRequest);
          closeSocket(4406, "protocol_error");
          throw failure();
        }
        try {
          handshakeRequest = captureHandshakeRequest(destroyOwner);
          requestWebSocket = webSocket;
        } catch {
          requestFinalizationFailed = true;
          destroyHandshakeRequest(destroyOwner);
          destroyHandshakeRequest(handshakeRequest);
          closeSocket(4406, "protocol_error");
          throw failure();
        }
      };
      try {
        rawSocket = Reflect.construct(input.webSocketConstructor, [
          input.endpoint,
          [RELAY_V2_HOST_WSS_SUBPROTOCOL],
          Object.freeze({
            perMessageDeflate: false,
            maxPayload: RELAY_V2_CARRIER_FRAME_BYTES,
            finishRequest,
          }),
        ]);
      } finally {
        requestCaptureOpen = false;
      }
      if (requestFinalizationCalls !== 1
        || requestFinalizationFailed
        || handshakeRequest === null
        || requestWebSocket !== rawSocket
        || phase !== "unbound") throw failure();
      const capturedSocket = captureSocket(rawSocket);
      if (phase !== "unbound") throw failure();
      socket = capturedSocket;
      finalizeRelayV2HostCredentialConnectionAuthorization(
        input.credentialAuthority,
        input.transportOwner,
        authorization,
        createRequestFinalizationPort(
          handshakeRequest,
          () => phase === "unbound" && socket === capturedSocket,
        ),
      );
      authorizationOwned = false;
      if (phase !== "unbound" || socket !== capturedSocket) throw failure();
      phase = "connecting";
      listeners = Object.freeze({
        open: onOpen,
        message: onMessage,
        error: onError,
        close: onClose,
        unexpectedResponse: onUnexpectedResponse,
      });
      for (const [event, listener] of [
        ["open", listeners.open],
        ["message", listeners.message],
        ["error", listeners.error],
        ["close", listeners.close],
        ["unexpected-response", listeners.unexpectedResponse],
      ] as const) {
        Reflect.apply(socket.on, socket.receiver, [event, listener]);
        if (phase !== "connecting" || socket !== capturedSocket) throw failure();
      }
      input.attempt.signal.addEventListener("abort", abortAttempt, { once: true });
      if (phase !== "connecting" || socket !== capturedSocket) throw failure();
      if (input.attempt.signal.aborted) {
        abortAttempt();
      } else {
        const state = socketState(capturedSocket);
        if (phase !== "connecting" || socket !== capturedSocket) throw failure();
        if (state === 1) {
          onOpen();
        } else if (state !== 0) {
          protocolFailure();
        }
      }
    } catch {
      actorCallbacksActive = false;
      if (authorizationOwned && authorization !== null) {
        releaseRelayV2HostCredentialConnectionAuthorization(
          input.credentialAuthority,
          input.transportOwner,
          authorization,
        );
        authorizationOwned = false;
      }
      destroyHandshakeRequest(handshakeRequest);
      if (socket !== null) {
        terminateAndFinish();
      } else {
        if (typeof rawSocket === "object" && rawSocket !== null) {
          try {
            Reflect.apply(captureMethod(rawSocket, "terminate"), rawSocket, []);
          } catch {}
        }
        finishClosed();
      }
      throw failure();
    }
  };

  const transport: RelayV2HostCarrierTransport = Object.freeze({
    trySend(frame: Uint8Array, deliveryToken: string): boolean {
      if ((phase !== "unbound" && phase !== "connecting" && phase !== "open")
        || !(frame instanceof Uint8Array)
        || !(frame.buffer instanceof ArrayBuffer)
        || frame.byteLength > RELAY_V2_CARRIER_FRAME_BYTES
        || typeof deliveryToken !== "string"
        || deliveryToken === ""
        || Buffer.byteLength(deliveryToken, "utf8") > 128
        || deliveryTokens.has(deliveryToken)
        || ownedBytes > input.maxBufferedBytes - frame.byteLength) return false;
      const acceptedFrame = Object.freeze({
        bytes: Uint8Array.from(frame),
        deliveryToken,
      });
      accepted.push(acceptedFrame);
      deliveryTokens.add(deliveryToken);
      ownedBytes += acceptedFrame.bytes.byteLength;
      flush();
      return true;
    },
    bufferedAmount(): number {
      return ownedBytes;
    },
    close(code: number, reason: string): void {
      closeSocket(code, reason);
    },
  });

  return Object.freeze({
    transport,
    bindConnection(rawConnection: RelayV2HostCarrierConnection): void {
      if (connection !== null || phase !== "unbound") throw failure();
      connection = captureConnection(rawConnection);
      actorCallbacksActive = true;
      openSocket();
    },
    awaitDrained(proof: object): Promise<object> {
      if (typeof proof !== "object" || proof === null || nodeTypes.isProxy(proof)) {
        return Promise.reject(failure());
      }
      if (drainPromise !== null) {
        return proof === drainProof ? drainPromise : Promise.reject(failure());
      }
      drainProof = proof;
      if (phase === "closed" && closedCleanupComplete) {
        drainPromise = Promise.resolve(proof);
        return drainPromise;
      }
      drainPromise = new Promise<object>((resolve) => { resolveDrain = resolve; });
      if (phase !== "closing") closeSocket(1000, "host_shutdown");
      return drainPromise;
    },
  });
}

/**
 * Default-off client lifecycle factory. Construction validates only closed
 * ports and configuration; a socket is created later, during exact connection
 * binding, after both consumers have accepted one credential cut.
 */
export class RelayV2HostWssTransportLifecycleFactory
implements RelayV2HostManagedConnectorTransportLifecycleFactoryPort {
  readonly #endpoint: string;
  readonly #credentialAuthority: RelayV2HostCredentialAuthority;
  readonly #webSocketConstructor: RelayV2HostWssConstructorPort;
  readonly #maxBufferedBytes: number;
  readonly #closeDrainDeadlineMs: number;
  readonly #scheduleCloseDrain: CloseDrainScheduler;
  readonly #transportOwner: RelayV2HostCredentialConnectionTransportOwner;
  readonly #pending = new Map<string, PreparedAttempt>();

  constructor(options: RelayV2HostWssTransportLifecycleFactoryOptions) {
    const fields = exactDataObject(options, ["relayUrl", "credentialAuthority"], [
      "webSocketConstructor", "maxBufferedBytes", "closeDrainDeadlineMs",
      "scheduleCloseDrain",
    ]);
    if (!isRelayV2HostCredentialAuthority(fields.credentialAuthority)) throw failure();
    const webSocketConstructor = fields.webSocketConstructor ?? WebSocket;
    if (typeof webSocketConstructor !== "function" || nodeTypes.isProxy(webSocketConstructor)) {
      throw failure();
    }
    const scheduleCloseDrain = fields.scheduleCloseDrain ?? defaultCloseDrainScheduler;
    if (typeof scheduleCloseDrain !== "function" || nodeTypes.isProxy(scheduleCloseDrain)) {
      throw failure();
    }
    const endpoint = exactHostUrl(fields.relayUrl);
    this.#endpoint = endpoint;
    this.#credentialAuthority = fields.credentialAuthority;
    this.#webSocketConstructor = webSocketConstructor as RelayV2HostWssConstructorPort;
    this.#transportOwner = createRelayV2HostCredentialConnectionTransportOwner(
      this.#credentialAuthority,
    );
    this.#maxBufferedBytes = positiveBound(
      fields.maxBufferedBytes,
      DEFAULT_MAX_BUFFERED_BYTES,
      DEFAULT_MAX_BUFFERED_BYTES,
    );
    this.#closeDrainDeadlineMs = positiveBound(
      fields.closeDrainDeadlineMs,
      DEFAULT_CLOSE_DRAIN_DEADLINE_MS,
      MAX_CLOSE_DRAIN_DEADLINE_MS,
    );
    this.#scheduleCloseDrain = scheduleCloseDrain as CloseDrainScheduler;
  }

  static prepareAttempt(
    authorityKey: unknown,
    factory: RelayV2HostWssTransportLifecycleFactory,
    rawInput: RelayV2HostWssPreparedAttemptInput,
  ): RelayV2HostCredentialConnectionAdmission {
    if (authorityKey !== factoryAuthorityKey
      || !(factory instanceof RelayV2HostWssTransportLifecycleFactory)) throw failure();
    const fields = exactDataObject(rawInput, [
      "requestId", "controllerGeneration", "hostId", "hostEpoch",
      "hostInstanceId", "credentialReference", "signal", "credentialReferences",
    ]);
    if (fields.credentialReferences !== factory.#credentialAuthority) throw failure();
    const input = captureLifecycleInput(Object.fromEntries(
      Object.entries(fields).filter(([key]) => key !== "credentialReferences"),
    ));
    if (input.signal.aborted || factory.#pending.has(input.controllerGeneration)) throw failure();
    let admission: RelayV2HostCredentialConnectionAdmission;
    try {
      admission = captureRelayV2HostCredentialConnectionAdmission(
        factory.#credentialAuthority,
        factory.#transportOwner,
        Object.freeze({
          requestId: input.requestId,
          controllerGeneration: input.controllerGeneration,
          hostId: input.hostId,
          hostEpoch: input.hostEpoch,
          hostInstanceId: input.hostInstanceId,
          credentialReference: input.credentialReference,
        }),
      );
    } catch {
      throw failure();
    }
    factory.#pending.set(input.controllerGeneration, Object.freeze({ input, admission }));
    return admission;
  }

  static releasePreparedAttempt(
    authorityKey: unknown,
    factory: RelayV2HostWssTransportLifecycleFactory,
    admission: RelayV2HostCredentialConnectionAdmission,
  ): void {
    if (authorityKey !== factoryAuthorityKey
      || !(factory instanceof RelayV2HostWssTransportLifecycleFactory)) return;
    for (const [generation, prepared] of factory.#pending) {
      if (prepared.admission !== admission) continue;
      factory.#pending.delete(generation);
      releaseRelayV2HostCredentialConnectionAdmission(
        factory.#credentialAuthority,
        factory.#transportOwner,
        admission,
      );
      return;
    }
  }

  createTransportLifecycle(
    rawInput: Readonly<RelayV2HostManagedConnectorTransportLifecycleFactoryInput>,
  ): RelayV2HostManagedConnectorTransportLifecycle {
    const input = captureLifecycleInput(rawInput);
    const prepared = this.#pending.get(input.controllerGeneration);
    if (prepared === undefined) throw failure();
    this.#pending.delete(input.controllerGeneration);
    if (!sameLifecycleInput(prepared.input, input) || input.signal.aborted) {
      releaseRelayV2HostCredentialConnectionAdmission(
        this.#credentialAuthority,
        this.#transportOwner,
        prepared.admission,
      );
      throw failure();
    }
    return createLifecycle({
      endpoint: this.#endpoint,
      webSocketConstructor: this.#webSocketConstructor,
      credentialAuthority: this.#credentialAuthority,
      transportOwner: this.#transportOwner,
      admission: prepared.admission,
      attempt: input,
      maxBufferedBytes: this.#maxBufferedBytes,
      closeDrainDeadlineMs: this.#closeDrainDeadlineMs,
      scheduleCloseDrain: this.#scheduleCloseDrain,
    });
  }
}

export function prepareRelayV2HostWssTransportLifecycleAttempt(
  value: unknown,
  input: RelayV2HostWssPreparedAttemptInput,
): RelayV2HostCredentialConnectionAdmission | null {
  if (!(value instanceof RelayV2HostWssTransportLifecycleFactory)) return null;
  return RelayV2HostWssTransportLifecycleFactory.prepareAttempt(
    factoryAuthorityKey,
    value,
    input,
  );
}

export function releaseRelayV2HostWssTransportLifecyclePreparedAttempt(
  value: unknown,
  admission: RelayV2HostCredentialConnectionAdmission | null,
): void {
  if (admission === null || !(value instanceof RelayV2HostWssTransportLifecycleFactory)) return;
  RelayV2HostWssTransportLifecycleFactory.releasePreparedAttempt(
    factoryAuthorityKey,
    value,
    admission,
  );
}
