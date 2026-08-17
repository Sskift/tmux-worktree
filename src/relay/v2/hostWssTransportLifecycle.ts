import { TextDecoder, types as nodeTypes } from "node:util";
import { checkServerIdentity } from "node:tls";
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
import {
  captureRelayV2HostTlsCaTrust,
  type RelayV2HostTlsCaTrust,
} from "./hostTlsTrustMaterial.js";

export const RELAY_V2_HOST_WSS_SUBPROTOCOL = "tw-relay.host.v2" as const;

const DEFAULT_MAX_BUFFERED_BYTES = 16 * 1_048_576;
const DEFAULT_CLOSE_DRAIN_DEADLINE_MS = 5_000;
const MAX_CLOSE_DRAIN_DEADLINE_MS = 30_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const MAX_HANDSHAKE_TIMEOUT_MS = 120_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_MISSED_PONG_LIMIT = 2;
const NODE_CHECK_SERVER_IDENTITY = checkServerIdentity;
const NODE_IS_PROXY = nodeTypes.isProxy;
const OBJECT_PROTOTYPE = Object.prototype;
const OBJECT_CREATE = Object.create;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTORS = Object.getOwnPropertyDescriptors;
const OBJECT_HAS_OWN = Object.hasOwn;
const REFLECT_APPLY = Reflect.apply;
const REFLECT_CONSTRUCT = Reflect.construct;
const REFLECT_GET = Reflect.get;
const REFLECT_OWN_KEYS = Reflect.ownKeys;
const ARRAY_IS_ARRAY = Array.isArray;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const NUMBER_IS_INTEGER = Number.isInteger;
const STRING_STARTS_WITH = String.prototype.startsWith;
const UINT8_ARRAY_CONSTRUCTOR = Uint8Array;
const UINT8_ARRAY_FROM = Uint8Array.from;
const URL_CONSTRUCTOR = URL;
const URL_PROTOTYPE = URL_CONSTRUCTOR.prototype;
const URL_PROTOCOL_DESCRIPTOR =
  OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(URL_PROTOTYPE, "protocol");
const URL_USERNAME_DESCRIPTOR =
  OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(URL_PROTOTYPE, "username");
const URL_PASSWORD_DESCRIPTOR =
  OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(URL_PROTOTYPE, "password");
const URL_PATHNAME_DESCRIPTOR =
  OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(URL_PROTOTYPE, "pathname");
const URL_SEARCH_DESCRIPTOR =
  OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(URL_PROTOTYPE, "search");
const URL_HASH_DESCRIPTOR =
  OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(URL_PROTOTYPE, "hash");
const URL_HOSTNAME_DESCRIPTOR =
  OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(URL_PROTOTYPE, "hostname");
const URL_TO_STRING_DESCRIPTOR =
  OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(URL_PROTOTYPE, "toString");
const URL_PROTOCOL_GETTER = URL_PROTOCOL_DESCRIPTOR?.get;
const URL_USERNAME_GETTER = URL_USERNAME_DESCRIPTOR?.get;
const URL_PASSWORD_GETTER = URL_PASSWORD_DESCRIPTOR?.get;
const URL_PATHNAME_GETTER = URL_PATHNAME_DESCRIPTOR?.get;
const URL_PATHNAME_SETTER = URL_PATHNAME_DESCRIPTOR?.set;
const URL_SEARCH_GETTER = URL_SEARCH_DESCRIPTOR?.get;
const URL_HASH_GETTER = URL_HASH_DESCRIPTOR?.get;
const URL_HOSTNAME_GETTER = URL_HOSTNAME_DESCRIPTOR?.get;
const URL_TO_STRING = URL_TO_STRING_DESCRIPTOR?.value;
const URL_INTRINSICS_VALID =
  isUrlGetterDescriptor(URL_PROTOCOL_DESCRIPTOR)
  && isUrlGetterDescriptor(URL_USERNAME_DESCRIPTOR)
  && isUrlGetterDescriptor(URL_PASSWORD_DESCRIPTOR)
  && isUrlGetterDescriptor(URL_PATHNAME_DESCRIPTOR)
  && typeof URL_PATHNAME_DESCRIPTOR?.set === "function"
  && isUrlGetterDescriptor(URL_SEARCH_DESCRIPTOR)
  && isUrlGetterDescriptor(URL_HASH_DESCRIPTOR)
  && isUrlGetterDescriptor(URL_HOSTNAME_DESCRIPTOR)
  && isUrlMethodDescriptor(URL_TO_STRING_DESCRIPTOR);
const factoryAuthorityKey = OBJECT_FREEZE({});
const fatalUtf8Decoder = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

type DataRecord = Record<string, unknown>;
type CloseDrainScheduler = (delayMs: number, callback: () => void) => () => void;

function isUrlGetterDescriptor(
  descriptor: PropertyDescriptor | undefined,
): boolean {
  return descriptor !== undefined
    && typeof descriptor.get === "function"
    && descriptor.enumerable === true
    && descriptor.configurable === true
    && !OBJECT_HAS_OWN(descriptor, "value")
    && !OBJECT_HAS_OWN(descriptor, "writable");
}

function isUrlMethodDescriptor(
  descriptor: PropertyDescriptor | undefined,
): boolean {
  return descriptor !== undefined
    && typeof descriptor.value === "function"
    && descriptor.writable === true
    && descriptor.enumerable === true
    && descriptor.configurable === true
    && !OBJECT_HAS_OWN(descriptor, "get")
    && !OBJECT_HAS_OWN(descriptor, "set");
}

export interface RelayV2HostWssConstructorOptions {
  readonly perMessageDeflate: false;
  readonly maxPayload: number;
  readonly rejectUnauthorized: true;
  readonly checkServerIdentity: typeof checkServerIdentity;
  readonly handshakeTimeout: number;
  readonly ca?: readonly (string | Uint8Array)[];
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
  /** Default-off CA-only extension; omission keeps explicit system trust. */
  readonly tlsTrust?: RelayV2HostTlsCaTrust;
  readonly webSocketConstructor?: RelayV2HostWssConstructorPort;
  readonly maxBufferedBytes?: number;
  readonly closeDrainDeadlineMs?: number;
  /** Bounds TCP/TLS/WebSocket opening before HostCarrier heartbeat ownership exists. */
  readonly handshakeTimeoutMs?: number;
  readonly scheduleCloseDrain?: CloseDrainScheduler;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatMissedPongLimit?: number;
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
  readonly ping: Function;
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
  readonly pong: () => void;
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
  if (typeof value !== "object" || value === null || ARRAY_IS_ARRAY(value)
    || NODE_IS_PROXY(value)) throw failure();
  let descriptors: PropertyDescriptorMap;
  try {
    if (OBJECT_GET_PROTOTYPE_OF(value) !== OBJECT_PROTOTYPE) throw failure();
    descriptors = OBJECT_GET_OWN_PROPERTY_DESCRIPTORS(value);
  } catch {
    throw failure();
  }
  const keys = REFLECT_OWN_KEYS(descriptors);
  const captured: DataRecord = OBJECT_CREATE(null);
  for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    const key = keys[keyIndex];
    if (typeof key !== "string") throw failure();
    let allowed = false;
    for (let index = 0; index < required.length; index += 1) {
      if (key === required[index]) {
        allowed = true;
        break;
      }
    }
    for (let index = 0; !allowed && index < optional.length; index += 1) {
      if (key === optional[index]) {
        allowed = true;
        break;
      }
    }
    const descriptor = descriptors[key];
    if (!allowed || descriptor === undefined || !OBJECT_HAS_OWN(descriptor, "value")) {
      throw failure();
    }
    captured[key] = descriptor.value;
  }
  for (let index = 0; index < required.length; index += 1) {
    if (!OBJECT_HAS_OWN(descriptors, required[index]!)) throw failure();
  }
  return OBJECT_FREEZE(captured);
}

function captureMethod(value: unknown, name: string): Function {
  if (typeof value !== "object" || value === null || NODE_IS_PROXY(value)) throw failure();
  let owner: object | null = value;
  while (owner !== null) {
    if (NODE_IS_PROXY(owner)) throw failure();
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(owner, name);
    } catch {
      throw failure();
    }
    if (descriptor !== undefined) {
      if (!OBJECT_HAS_OWN(descriptor, "value") || typeof descriptor.value !== "function") {
        throw failure();
      }
      return descriptor.value;
    }
    try { owner = OBJECT_GET_PROTOTYPE_OF(owner); } catch { throw failure(); }
  }
  throw failure();
}

function positiveBound(value: unknown, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!NUMBER_IS_SAFE_INTEGER(selected)
    || (selected as number) <= 0
    || (selected as number) > maximum) throw failure();
  return selected as number;
}

function exactHostUrl(value: unknown): string {
  if (typeof value !== "string") throw failure();
  let parsed: URL;
  try { parsed = new URL_CONSTRUCTOR(value); } catch { throw failure(); }
  if (!URL_INTRINSICS_VALID
    || typeof URL_PROTOCOL_GETTER !== "function"
    || typeof URL_USERNAME_GETTER !== "function"
    || typeof URL_PASSWORD_GETTER !== "function"
    || typeof URL_PATHNAME_GETTER !== "function"
    || typeof URL_PATHNAME_SETTER !== "function"
    || typeof URL_SEARCH_GETTER !== "function"
    || typeof URL_HASH_GETTER !== "function"
    || typeof URL_HOSTNAME_GETTER !== "function"
    || typeof URL_TO_STRING !== "function") throw failure();
  let protocol: unknown;
  let username: unknown;
  let password: unknown;
  let pathname: unknown;
  let search: unknown;
  let hash: unknown;
  let hostname: unknown;
  try {
    protocol = REFLECT_APPLY(URL_PROTOCOL_GETTER, parsed, []);
    username = REFLECT_APPLY(URL_USERNAME_GETTER, parsed, []);
    password = REFLECT_APPLY(URL_PASSWORD_GETTER, parsed, []);
    pathname = REFLECT_APPLY(URL_PATHNAME_GETTER, parsed, []);
    search = REFLECT_APPLY(URL_SEARCH_GETTER, parsed, []);
    hash = REFLECT_APPLY(URL_HASH_GETTER, parsed, []);
    hostname = REFLECT_APPLY(URL_HOSTNAME_GETTER, parsed, []);
  } catch {
    throw failure();
  }
  if (protocol !== "wss:"
    || username !== ""
    || password !== ""
    || pathname !== "/"
    || search !== ""
    || hash !== ""
    || typeof hostname !== "string"
    || hostname === "") throw failure();
  let endpoint: unknown;
  try {
    REFLECT_APPLY(URL_PATHNAME_SETTER, parsed, ["/host"]);
    endpoint = REFLECT_APPLY(URL_TO_STRING, parsed, []);
  } catch {
    throw failure();
  }
  if (typeof endpoint !== "string") throw failure();
  return endpoint;
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
  return OBJECT_FREEZE({
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
  if (typeof value !== "object" || value === null || NODE_IS_PROXY(value)) throw failure();
  return OBJECT_FREEZE({
    receiver: value,
    on: captureMethod(value, "on"),
    removeListener: captureMethod(value, "removeListener"),
    send: captureMethod(value, "send"),
    close: captureMethod(value, "close"),
    terminate: captureMethod(value, "terminate"),
    ping: captureMethod(value, "ping"),
  });
}

function captureConnection(value: unknown): CapturedConnection {
  const fields = exactDataObject(value, [
    "generation", "receive", "acknowledge", "rejectUnaccepted", "writable", "closed",
  ]);
  if (!NUMBER_IS_SAFE_INTEGER(fields.generation) || (fields.generation as number) <= 0
    || typeof fields.receive !== "function"
    || typeof fields.acknowledge !== "function"
    || typeof fields.rejectUnaccepted !== "function"
    || typeof fields.writable !== "function"
    || typeof fields.closed !== "function") throw failure();
  return OBJECT_FREEZE({
    receiver: value as object,
    receive: fields.receive as Function,
    acknowledge: fields.acknowledge as Function,
    writable: fields.writable as Function,
    closed: fields.closed as Function,
  });
}

function captureHandshakeRequestDestroy(value: unknown): CapturedHandshakeRequestDestroy {
  if (typeof value !== "object" || value === null || NODE_IS_PROXY(value)) throw failure();
  const destroy = captureMethod(value, "destroy");
  let destroyed = false;
  return OBJECT_FREEZE({
    receiver: value,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      REFLECT_APPLY(destroy, value, []);
    },
  });
}

function captureHandshakeRequest(
  destroyOwner: CapturedHandshakeRequestDestroy,
): CapturedHandshakeRequest {
  return OBJECT_FREEZE({
    receiver: destroyOwner.receiver,
    setHeader: captureMethod(destroyOwner.receiver, "setHeader"),
    end: captureMethod(destroyOwner.receiver, "end"),
    destroy: destroyOwner.destroy,
  });
}

function destroyHandshakeRequest(request: CapturedHandshakeRequestDestroy | null): void {
  if (request === null) return;
  try { REFLECT_APPLY(request.destroy, request.receiver, []); } catch {}
}

function createRequestFinalizationPort(
  request: CapturedHandshakeRequest,
  isCurrent: () => boolean,
): RelayV2HostCredentialConnectionRequestFinalizationPort {
  let spent = false;
  const port = OBJECT_CREATE(null) as RelayV2HostCredentialConnectionRequestFinalizationPort;
  OBJECT_DEFINE_PROPERTY(port, "finalize", {
    configurable: false,
    enumerable: false,
    writable: false,
    value(authorizationValue: string): void {
      if (spent
        || typeof authorizationValue !== "string"
        || typeof STRING_STARTS_WITH !== "function"
        || !REFLECT_APPLY(STRING_STARTS_WITH, authorizationValue, ["Bearer "])
        || authorizationValue.length === "Bearer ".length) throw failure();
      spent = true;
      try {
        if (!isCurrent()) throw failure();
        REFLECT_APPLY(request.setHeader, request.receiver, [
          "Authorization",
          authorizationValue,
        ]);
        if (!isCurrent()) throw failure();
        REFLECT_APPLY(request.end, request.receiver, []);
        if (!isCurrent()) throw failure();
      } catch {
        destroyHandshakeRequest(request);
        throw failure();
      }
    },
  });
  return OBJECT_FREEZE(port);
}

function socketState(socket: CapturedSocket): number | null {
  let value: unknown;
  try { value = REFLECT_GET(socket.receiver, "readyState", socket.receiver); } catch { return null; }
  return NUMBER_IS_SAFE_INTEGER(value) ? value as number : null;
}

function socketString(socket: CapturedSocket, name: "protocol" | "extensions"): string | null {
  let value: unknown;
  try { value = REFLECT_GET(socket.receiver, name, socket.receiver); } catch { return null; }
  return typeof value === "string" ? value : null;
}

function textFrame(value: unknown): Uint8Array | null {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (!(value instanceof Uint8Array) || !(value.buffer instanceof ArrayBuffer)) return null;
  return REFLECT_APPLY(UINT8_ARRAY_FROM, UINT8_ARRAY_CONSTRUCTOR, [value]);
}

function strictUtf8Text(value: Uint8Array): string | null {
  try {
    const text = fatalUtf8Decoder.decode(value);
    const roundTrip = Buffer.from(text, "utf8");
    const raw = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return roundTrip.byteLength === raw.byteLength && roundTrip.equals(raw) ? text : null;
  } catch {
    return null;
  }
}

function defaultCloseDrainScheduler(delayMs: number, callback: () => void): () => void {
  const timer = setTimeout(callback, delayMs);
  // This is the transport's bounded clean-close barrier. Keep it referenced:
  // the hidden one-shot Dashboard child may have no other active libuv handle
  // after its stdio reaches EOF, and an unresolved Promise alone cannot keep
  // Node alive long enough to force-close the socket and release the native
  // credential cell admission claim. The deadline remains bounded by the
  // factory limit and is cancelled as soon as the socket closes normally.
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
  handshakeTimeoutMs: number;
  scheduleCloseDrain: CloseDrainScheduler;
  tlsTrust: RelayV2HostTlsCaTrust | undefined;
  heartbeatIntervalMs: number;
  heartbeatMissedPongLimit: number;
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
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatMissedPongs = 0;
  let heartbeatStopped = false;

  const stopHeartbeat = (): void => {
    if (heartbeatStopped) return;
    heartbeatStopped = true;
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (socket !== null && listeners !== null) {
      try {
        REFLECT_APPLY(socket.removeListener, socket.receiver, ["pong", listeners.pong]);
      } catch {}
    }
  };

  const removeListeners = (): void => {
    if (socket === null || listeners === null) return;
    for (const [event, listener] of [
      ["open", listeners.open],
      ["message", listeners.message],
      ["error", listeners.error],
      ["close", listeners.close],
      ["unexpected-response", listeners.unexpectedResponse],
      ["pong", listeners.pong],
    ] as const) {
      try {
        REFLECT_APPLY(socket.removeListener, socket.receiver, [event, listener]);
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
        REFLECT_APPLY(activeConnection.closed, activeConnection.receiver, [code]);
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
    try { stopHeartbeat(); } catch {}
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
      try { REFLECT_APPLY(activeSocket.terminate, activeSocket.receiver, []); } catch {}
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
      try { REFLECT_APPLY(cancel as Function, undefined, []); } catch {}
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
      REFLECT_APPLY(activeSocket.close, activeSocket.receiver, [code, reason]);
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
    const text = strictUtf8Text(item.bytes);
    if (text === null) {
      closeSocket(1011, "write_failed");
      return;
    }
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
        REFLECT_APPLY(activeConnection.acknowledge, activeConnection.receiver, [
          item.deliveryToken,
        ]);
        if (phase !== "open" || !actorCallbacksActive) return;
        REFLECT_APPLY(activeConnection.writable, activeConnection.receiver, []);
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
      returned = REFLECT_APPLY(socket.send, socket.receiver, [
        text,
        OBJECT_FREEZE({ binary: false, compress: false }),
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
    heartbeatMissedPongs = 0;
    heartbeatStopped = false;
    const heartbeatTick = (): void => {
      if (heartbeatStopped || phase !== "open") return;
      heartbeatMissedPongs += 1;
      if (heartbeatMissedPongs > input.heartbeatMissedPongLimit) {
        terminateAndFinish();
        return;
      }
      try {
        REFLECT_APPLY(activeSocket.ping, activeSocket.receiver, []);
      } catch {
        terminateAndFinish();
      }
    };
    heartbeatTick();
    heartbeatTimer = setInterval(heartbeatTick, input.heartbeatIntervalMs);
    flush();
  };

  const onPong = (): void => {
    heartbeatMissedPongs = 0;
  };

  const onMessage = (data: unknown, isBinary: unknown): void => {
    if (phase !== "open" || !actorCallbacksActive || connection === null) return;
    const bytes = isBinary === false ? textFrame(data) : null;
    if (bytes === null || bytes.byteLength > RELAY_V2_CARRIER_FRAME_BYTES) {
      protocolFailure();
      return;
    }
    try {
      REFLECT_APPLY(connection.receive, connection.receiver, [bytes]);
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
    const safeCode = NUMBER_IS_INTEGER(code) && (code as number) >= 0
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
          || NODE_IS_PROXY(webSocket)) {
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
        rawSocket = REFLECT_CONSTRUCT(input.webSocketConstructor, [
          input.endpoint,
          [RELAY_V2_HOST_WSS_SUBPROTOCOL],
          OBJECT_FREEZE({
            perMessageDeflate: false,
            maxPayload: RELAY_V2_CARRIER_FRAME_BYTES,
            rejectUnauthorized: true,
            checkServerIdentity: NODE_CHECK_SERVER_IDENTITY,
            handshakeTimeout: input.handshakeTimeoutMs,
            ...(input.tlsTrust === undefined
              ? {}
              : { ca: input.tlsTrust.certificateAuthorities }),
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
      listeners = OBJECT_FREEZE({
        open: onOpen,
        message: onMessage,
        error: onError,
        close: onClose,
        unexpectedResponse: onUnexpectedResponse,
        pong: onPong,
      });
      for (const [event, listener] of [
        ["open", listeners.open],
        ["message", listeners.message],
        ["error", listeners.error],
        ["close", listeners.close],
        ["unexpected-response", listeners.unexpectedResponse],
        ["pong", listeners.pong],
      ] as const) {
        REFLECT_APPLY(socket.on, socket.receiver, [event, listener]);
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
            REFLECT_APPLY(captureMethod(rawSocket, "terminate"), rawSocket, []);
          } catch {}
        }
        finishClosed();
      }
      throw failure();
    }
  };

  const transport: RelayV2HostCarrierTransport = OBJECT_FREEZE({
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
      const acceptedFrame = OBJECT_FREEZE({
        bytes: REFLECT_APPLY(UINT8_ARRAY_FROM, UINT8_ARRAY_CONSTRUCTOR, [frame]),
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

  return OBJECT_FREEZE({
    transport,
    bindConnection(rawConnection: RelayV2HostCarrierConnection): void {
      if (connection !== null || phase !== "unbound") throw failure();
      connection = captureConnection(rawConnection);
      actorCallbacksActive = true;
      openSocket();
    },
    awaitDrained(proof: object): Promise<object> {
      if (typeof proof !== "object" || proof === null || NODE_IS_PROXY(proof)) {
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
  readonly #handshakeTimeoutMs: number;
  readonly #scheduleCloseDrain: CloseDrainScheduler;
  readonly #tlsTrust: RelayV2HostTlsCaTrust | undefined;
  readonly #transportOwner: RelayV2HostCredentialConnectionTransportOwner;
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatMissedPongLimit: number;
  readonly #pending = new Map<string, PreparedAttempt>();

  constructor(options: RelayV2HostWssTransportLifecycleFactoryOptions) {
    const fields = exactDataObject(options, ["relayUrl", "credentialAuthority"], [
      "webSocketConstructor", "maxBufferedBytes", "closeDrainDeadlineMs",
      "handshakeTimeoutMs", "scheduleCloseDrain", "tlsTrust", "heartbeatIntervalMs",
      "heartbeatMissedPongLimit",
    ]);
    if (!isRelayV2HostCredentialAuthority(fields.credentialAuthority)) throw failure();
    const webSocketConstructor = fields.webSocketConstructor ?? WebSocket;
    if (typeof webSocketConstructor !== "function" || NODE_IS_PROXY(webSocketConstructor)) {
      throw failure();
    }
    const scheduleCloseDrain = fields.scheduleCloseDrain ?? defaultCloseDrainScheduler;
    if (typeof scheduleCloseDrain !== "function" || NODE_IS_PROXY(scheduleCloseDrain)) {
      throw failure();
    }
    const endpoint = exactHostUrl(fields.relayUrl);
    let tlsTrust: RelayV2HostTlsCaTrust | undefined;
    try {
      tlsTrust = fields.tlsTrust === undefined
        ? undefined
        : captureRelayV2HostTlsCaTrust(fields.tlsTrust);
    } catch {
      throw failure();
    }
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
    this.#handshakeTimeoutMs = positiveBound(
      fields.handshakeTimeoutMs,
      DEFAULT_HANDSHAKE_TIMEOUT_MS,
      MAX_HANDSHAKE_TIMEOUT_MS,
    );
    this.#scheduleCloseDrain = scheduleCloseDrain as CloseDrainScheduler;
    this.#tlsTrust = tlsTrust;
    this.#heartbeatIntervalMs = positiveBound(
      fields.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      Number.MAX_SAFE_INTEGER,
    );
    this.#heartbeatMissedPongLimit = positiveBound(
      fields.heartbeatMissedPongLimit,
      DEFAULT_HEARTBEAT_MISSED_PONG_LIMIT,
      Number.MAX_SAFE_INTEGER,
    );
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
    const input = captureLifecycleInput(OBJECT_FREEZE({
      requestId: fields.requestId,
      controllerGeneration: fields.controllerGeneration,
      hostId: fields.hostId,
      hostEpoch: fields.hostEpoch,
      hostInstanceId: fields.hostInstanceId,
      credentialReference: fields.credentialReference,
      signal: fields.signal,
    }));
    if (input.signal.aborted || factory.#pending.has(input.controllerGeneration)) throw failure();
    let admission: RelayV2HostCredentialConnectionAdmission;
    try {
      admission = captureRelayV2HostCredentialConnectionAdmission(
        factory.#credentialAuthority,
        factory.#transportOwner,
        OBJECT_FREEZE({
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
    factory.#pending.set(
      input.controllerGeneration,
      OBJECT_FREEZE({ input, admission }),
    );
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
      handshakeTimeoutMs: this.#handshakeTimeoutMs,
      scheduleCloseDrain: this.#scheduleCloseDrain,
      tlsTrust: this.#tlsTrust,
      heartbeatIntervalMs: this.#heartbeatIntervalMs,
      heartbeatMissedPongLimit: this.#heartbeatMissedPongLimit,
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
