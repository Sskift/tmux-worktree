import { types as nodeUtilTypes } from "node:util";

import {
  RELAY_V2_BROKER_LIMITS,
  type RelayV2BrokerConnectionAuthorization,
  type RelayV2BrokerResult,
  type RelayV2RouteOpenResult,
} from "./brokerCore.js";
import type { RelayV2BrokerProducerTarget } from "./brokerProducerRegistry.js";
import type {
  RelayV2BrokerClientSocketEffectReceipt,
  RelayV2BrokerClientSocketFrameMetadata,
  RelayV2BrokerClientSocketPort,
  RelayV2BrokerClientSocketRegistration,
  RelayV2BrokerClientSocketTransport,
  RelayV2BrokerClientSocketWriteCompletion,
} from "./brokerClientSocketTransport.js";

const CLIENT_PROTOCOL = "tw-relay.v2";
const OPEN = 1;
const CLOSING = 2;
const MAX_UINT64 = 18_446_744_073_709_551_615n;
const nativeUint8ArraySlice = Uint8Array.prototype.slice;

const INPUT_KEYS = Object.freeze([
  "connectionId",
  "authContext",
  "hostProducerTarget",
  "socket",
  "transport",
] as const);
const AUTHORIZATION_KEYS = Object.freeze([
  "scheme",
  "role",
  "hostId",
  "principalId",
  "grantId",
  "clientInstanceId",
  "jti",
  "kid",
  "expiresAtMs",
  "authorizationRevision",
  "authorizationFence",
] as const);
const TARGET_KEYS = Object.freeze(["transportId", "generation"] as const);
const REGISTRATION_KEYS = Object.freeze([
  "connectionId",
  "connectionIncarnation",
  "openResult",
  "receive",
  "writable",
  "closed",
  "errored",
] as const);

type DataRecord = Record<string, unknown>;
type SocketEventName = "message" | "close" | "error";
type SocketListener = (this: object, ...args: unknown[]) => void;

/** The minimum already-upgraded `ws` surface consumed by this adapter. */
export interface RelayV2BrokerClientWssSocket {
  readonly readyState: number;
  readonly protocol: string;
  readonly extensions: string;
  readonly bufferedAmount: number;
  on(event: SocketEventName, listener: SocketListener): unknown;
  removeListener(event: SocketEventName, listener: SocketListener): unknown;
  send(
    data: Uint8Array,
    options: Readonly<{ binary: false; compress: false }>,
    callback: (error?: unknown) => void,
  ): unknown;
  pause(): unknown;
  resume(): unknown;
  close(code: number, reason: string): unknown;
  terminate(): unknown;
}

export interface RelayV2BrokerClientWssAdapterInput {
  readonly connectionId: string;
  /** Trusted post-Upgrade client authorization; no credential string is accepted here. */
  readonly authContext: RelayV2BrokerConnectionAuthorization;
  /** Exact B7a producer target selected by the upstream admission owner. */
  readonly hostProducerTarget: RelayV2BrokerProducerTarget;
  readonly socket: RelayV2BrokerClientWssSocket;
  readonly transport: RelayV2BrokerClientSocketTransport;
}

export type RelayV2BrokerClientWssTerminalEvidence = Readonly<
  | { kind: "closed"; code: number | null }
  | { kind: "errored" }
>;

export interface RelayV2BrokerClientWssAdapter {
  readonly connectionId: string;
  readonly connectionIncarnation: string;
  /** Exact result produced by RelayV2BrokerClientSocketTransport. */
  readonly openResult: RelayV2RouteOpenResult;
  /** Settles at the first native close/error event. */
  readonly terminal: Promise<RelayV2BrokerClientWssTerminalEvidence>;
  /** Settles after terminal fencing and listener/write-callback cleanup. */
  readonly drained: Promise<void>;
}

export class RelayV2BrokerClientWssAdapterError extends Error {
  constructor() {
    super("Relay v2 broker client WebSocket adapter rejected its boundary");
    this.name = "RelayV2BrokerClientWssAdapterError";
  }
}

type CapturedSocket = Readonly<{
  receiver: object;
  on: Function;
  removeListener: Function;
  send: Function;
  pause: Function;
  resume: Function;
  close: Function;
  terminate: Function;
}>;

type CapturedRegistration = Readonly<{
  connectionId: string;
  connectionIncarnation: string;
  openResult: RelayV2RouteOpenResult;
  receive: RelayV2BrokerClientSocketRegistration["receive"];
  writable: RelayV2BrokerClientSocketRegistration["writable"];
  closed: RelayV2BrokerClientSocketRegistration["closed"];
  errored: RelayV2BrokerClientSocketRegistration["errored"];
}>;

type PendingWrite = {
  readonly complete: (receipt: RelayV2BrokerClientSocketWriteCompletion) => void;
  nativeCompleted: boolean;
  completionQueued: boolean;
};

function failure(): RelayV2BrokerClientWssAdapterError {
  return new RelayV2BrokerClientWssAdapterError();
}

function isRejectedProxy(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return false;
  }
  try {
    return nodeUtilTypes.isProxy(value);
  } catch {
    return true;
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 128
    && value.trim() === value
    && !/[\0\r\n]/.test(value);
}

function exactDataRecord(value: unknown, keys: readonly string[]): DataRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value) || isRejectedProxy(value)) {
    throw failure();
  }
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw failure();
  }
  const actualKeys = Reflect.ownKeys(descriptors);
  if (
    actualKeys.length !== keys.length
    || actualKeys.some((key) => typeof key !== "string" || !keys.includes(key))
  ) throw failure();
  const record: DataRecord = Object.create(null) as DataRecord;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw failure();
    record[key] = descriptor.value;
  }
  return record;
}

function captureAuthorization(value: unknown): RelayV2BrokerConnectionAuthorization {
  const fields = exactDataRecord(value, AUTHORIZATION_KEYS);
  if (
    fields.scheme !== "twcap2"
    || fields.role !== "client"
    || !isIdentifier(fields.hostId)
    || !isIdentifier(fields.principalId)
    || !isIdentifier(fields.grantId)
    || !isIdentifier(fields.clientInstanceId)
    || !isIdentifier(fields.jti)
    || !isIdentifier(fields.kid)
    || !isIdentifier(fields.authorizationFence)
    || !Number.isSafeInteger(fields.expiresAtMs)
    || (fields.expiresAtMs as number) < 0
    || typeof fields.authorizationRevision !== "string"
    || !/^(0|[1-9][0-9]*)$/.test(fields.authorizationRevision)
  ) throw failure();
  try {
    if (BigInt(fields.authorizationRevision) > MAX_UINT64) throw failure();
  } catch {
    throw failure();
  }
  return Object.freeze({
    scheme: "twcap2",
    role: "client",
    hostId: fields.hostId,
    principalId: fields.principalId,
    grantId: fields.grantId,
    clientInstanceId: fields.clientInstanceId,
    jti: fields.jti,
    kid: fields.kid,
    expiresAtMs: fields.expiresAtMs,
    authorizationRevision: fields.authorizationRevision,
    authorizationFence: fields.authorizationFence,
  }) as RelayV2BrokerConnectionAuthorization;
}

function captureTarget(value: unknown): RelayV2BrokerProducerTarget {
  const fields = exactDataRecord(value, TARGET_KEYS);
  if (!isIdentifier(fields.transportId)
    || typeof fields.generation !== "string"
    || !/^[1-9][0-9]*$/.test(fields.generation)) throw failure();
  return Object.freeze({
    transportId: fields.transportId,
    generation: fields.generation,
  });
}

function captureMethod(value: object, name: string): Function {
  let owner: object | null = value;
  while (owner !== null) {
    if (isRejectedProxy(owner)) throw failure();
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(owner, name);
      owner = descriptor === undefined ? Object.getPrototypeOf(owner) : owner;
    } catch {
      throw failure();
    }
    if (descriptor !== undefined) {
      if (!Object.hasOwn(descriptor, "value")
        || typeof descriptor.value !== "function"
        || isRejectedProxy(descriptor.value)) throw failure();
      return descriptor.value;
    }
  }
  throw failure();
}

function captureSocket(value: unknown): CapturedSocket {
  if (value === null || typeof value !== "object" || isRejectedProxy(value)) throw failure();
  return Object.freeze({
    receiver: value,
    on: captureMethod(value, "on"),
    removeListener: captureMethod(value, "removeListener"),
    send: captureMethod(value, "send"),
    pause: captureMethod(value, "pause"),
    resume: captureMethod(value, "resume"),
    close: captureMethod(value, "close"),
    terminate: captureMethod(value, "terminate"),
  });
}

/**
 * Strict fakes expose own data facts. A real `ws` instance exposes these as
 * get-only properties on its `WebSocket` prototype; no other accessor owner is
 * invoked.
 */
function readSocketFact(socket: object, name: string): unknown {
  let owner: object | null = socket;
  while (owner !== null) {
    if (isRejectedProxy(owner)) throw failure();
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(owner, name);
    } catch {
      throw failure();
    }
    if (descriptor !== undefined) {
      if (Object.hasOwn(descriptor, "value")) return descriptor.value;
      if (
        owner === socket
        || typeof descriptor.get !== "function"
        || descriptor.set !== undefined
        || isRejectedProxy(descriptor.get)
      ) throw failure();
      const constructorDescriptor = Object.getOwnPropertyDescriptor(owner, "constructor");
      if (
        !constructorDescriptor
        || !Object.hasOwn(constructorDescriptor, "value")
        || typeof constructorDescriptor.value !== "function"
        || constructorDescriptor.value.name !== "WebSocket"
        || constructorDescriptor.value.prototype !== owner
      ) throw failure();
      try {
        return Reflect.apply(descriptor.get, socket, []);
      } catch {
        throw failure();
      }
    }
    try {
      owner = Object.getPrototypeOf(owner);
    } catch {
      throw failure();
    }
  }
  throw failure();
}

function assertOpenClientSocket(socket: object, afterRead: () => void = () => {}): void {
  const readyState = readSocketFact(socket, "readyState");
  afterRead();
  const protocol = readSocketFact(socket, "protocol");
  afterRead();
  const extensions = readSocketFact(socket, "extensions");
  afterRead();
  if (readyState !== OPEN || protocol !== CLIENT_PROTOCOL || extensions !== "") throw failure();
}

function readBufferedAmount(socket: object): number {
  const amount = readSocketFact(socket, "bufferedAmount");
  if (!Number.isSafeInteger(amount) || (amount as number) < 0) throw failure();
  return amount as number;
}

function copyBytes(value: unknown): Uint8Array | undefined {
  if (isRejectedProxy(value)) return undefined;
  try {
    if (value instanceof Uint8Array) {
      if (value.byteLength > RELAY_V2_BROKER_LIMITS.maxFrameBytes) return undefined;
      return Reflect.apply(nativeUint8ArraySlice, value, []) as Uint8Array;
    }
    if (value instanceof ArrayBuffer) {
      if (value.byteLength > RELAY_V2_BROKER_LIMITS.maxFrameBytes) return undefined;
      return new Uint8Array(value.slice(0));
    }
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || length < 0) return undefined;
    const ownKeys = Reflect.ownKeys(descriptors);
    if (
      ownKeys.length !== length + 1
      || ownKeys.some((key) => {
        if (key === "length") return false;
        if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) return true;
        const index = Number(key);
        return !Number.isSafeInteger(index) || index < 0 || index >= length;
      })
    ) return undefined;
    const parts: Uint8Array[] = [];
    let total = 0;
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return undefined;
      const part = descriptor.value;
      if (!(part instanceof Uint8Array) || isRejectedProxy(part)) return undefined;
      total += part.byteLength;
      if (!Number.isSafeInteger(total) || total > RELAY_V2_BROKER_LIMITS.maxFrameBytes) {
        return undefined;
      }
      parts.push(Reflect.apply(nativeUint8ArraySlice, part, []) as Uint8Array);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return bytes;
  } catch {
    return undefined;
  }
}

function captureRegistration(value: unknown, connectionId: string): CapturedRegistration {
  const fields = exactDataRecord(value, REGISTRATION_KEYS);
  if (
    fields.connectionId !== connectionId
    || !isIdentifier(fields.connectionIncarnation)
    || fields.openResult === null
    || typeof fields.openResult !== "object"
    || isRejectedProxy(fields.openResult)
  ) throw failure();
  for (const name of ["receive", "writable", "closed", "errored"] as const) {
    if (typeof fields[name] !== "function" || isRejectedProxy(fields[name])) throw failure();
  }
  return Object.freeze({
    connectionId,
    connectionIncarnation: fields.connectionIncarnation,
    openResult: fields.openResult as RelayV2RouteOpenResult,
    receive: fields.receive as RelayV2BrokerClientSocketRegistration["receive"],
    writable: fields.writable as RelayV2BrokerClientSocketRegistration["writable"],
    closed: fields.closed as RelayV2BrokerClientSocketRegistration["closed"],
    errored: fields.errored as RelayV2BrokerClientSocketRegistration["errored"],
  });
}

function callVoidSocketMethod(
  socket: CapturedSocket,
  method: Function,
  args: readonly unknown[],
): RelayV2BrokerClientSocketEffectReceipt {
  try {
    return Reflect.apply(method, socket.receiver, args) === undefined ? "applied" : "rejected";
  } catch {
    return "rejected";
  }
}

/**
 * Adapts one already-upgraded client `ws` socket into the existing transport.
 * It performs no HTTP admission, authentication, routing, retry, or expiry work.
 */
export function createRelayV2BrokerClientWssAdapter(
  input: RelayV2BrokerClientWssAdapterInput,
): RelayV2BrokerClientWssAdapter {
  const fields = exactDataRecord(input, INPUT_KEYS);
  if (!isIdentifier(fields.connectionId)) throw failure();
  // Capture both mutable authority inputs before the first socket callback can
  // reenter this setup. The adapter never retains their caller-owned objects.
  const authContext = captureAuthorization(fields.authContext);
  const hostProducerTarget = captureTarget(fields.hostProducerTarget);
  const socket = captureSocket(fields.socket);
  const transport = fields.transport;
  if (transport === null || typeof transport !== "object" || isRejectedProxy(transport)) {
    throw failure();
  }
  const registerClientSocket = captureMethod(transport, "registerClientSocket");

  type SetupPhase = "captured" | "installing" | "registering" | "registered" | "failed";
  type EffectPhase = "open" | "closing" | "terminating" | "terminal";

  let registration: CapturedRegistration | null = null;
  let setupPhase: SetupPhase = "captured";
  let effectPhase: EffectPhase = "open";
  let inboundFenced = false;
  let setupBoundaryFailure = false;
  let pendingTerminal: RelayV2BrokerClientWssTerminalEvidence | null = null;
  let cleanupFailed = false;
  let terminateInvoked = false;
  let drainSettled = false;
  let terminalWinner: RelayV2BrokerClientWssTerminalEvidence | null = null;
  let terminalResolve!: (value: RelayV2BrokerClientWssTerminalEvidence) => void;
  let drainedResolve!: () => void;
  let drainedReject!: (reason: unknown) => void;
  const terminal = new Promise<RelayV2BrokerClientWssTerminalEvidence>((resolve) => {
    terminalResolve = resolve;
  });
  const drained = new Promise<void>((resolve, reject) => {
    drainedResolve = resolve;
    drainedReject = reject;
  });
  const pendingWrites = new Set<PendingWrite>();
  const installedListeners: Array<readonly [SocketEventName, SocketListener]> = [];

  const markFailure = (): void => {
    cleanupFailed = true;
  };

  const rejectDrainNow = (): void => {
    markFailure();
    if (drainSettled) return;
    drainSettled = true;
    drainedReject(failure());
  };

  const removeListeners = (): void => {
    for (const [event, listener] of installedListeners.splice(0)) {
      try {
        if (Reflect.apply(socket.removeListener, socket.receiver, [event, listener]) !== socket.receiver) {
          markFailure();
        }
      } catch {
        markFailure();
      }
    }
  };

  const terminateOnce = (): RelayV2BrokerClientSocketEffectReceipt => {
    if (terminateInvoked) return "rejected";
    terminateInvoked = true;
    const receipt = callVoidSocketMethod(socket, socket.terminate, []);
    if (receipt !== "applied") {
      if (setupPhase === "registered") rejectDrainNow();
      else markFailure();
    }
    return receipt;
  };

  const fenceEffects = (next: "closing" | "terminating"): void => {
    if (effectPhase === "terminal") return;
    effectPhase = next;
    inboundFenced = true;
    pendingWrites.clear();
  };

  const beginTerminating = (): RelayV2BrokerClientSocketEffectReceipt => {
    if (effectPhase === "terminal" || effectPhase === "terminating") return "rejected";
    fenceEffects("terminating");
    return terminateOnce();
  };

  const failEffectAndTerminate = (): void => {
    if (effectPhase !== "terminal" && effectPhase !== "terminating") {
      fenceEffects("terminating");
    }
    markFailure();
    if (effectPhase !== "terminal") terminateOnce();
  };

  const finishTerminal = (evidence: RelayV2BrokerClientWssTerminalEvidence): void => {
    if (terminalWinner) return;
    terminalWinner = evidence;
    effectPhase = "terminal";
    inboundFenced = true;
    pendingWrites.clear();
    if (registration) {
      try {
        const method = evidence.kind === "closed" ? registration.closed : registration.errored;
        Reflect.apply(method, undefined, []) as RelayV2BrokerResult;
      } catch {
        markFailure();
      }
    }
    removeListeners();
    terminalResolve(evidence);
    queueMicrotask(() => {
      if (drainSettled) return;
      drainSettled = true;
      if (cleanupFailed) drainedReject(failure());
      else drainedResolve();
    });
  };

  const rejectInbound = (): void => {
    if (effectPhase !== "open" || inboundFenced) return;
    inboundFenced = true;
    if (!registration) {
      setupBoundaryFailure = true;
      return;
    }
    try {
      Reflect.apply(registration.receive, undefined, [
        new Uint8Array(0),
        Object.freeze({ opcode: "binary", compressed: false }),
      ]);
    } catch {
      failEffectAndTerminate();
    }
  };

  const messageListener: SocketListener = function message(data, isBinary): void {
    if (effectPhase !== "open" || inboundFenced) return;
    if (this !== socket.receiver || typeof isBinary !== "boolean") {
      rejectInbound();
      return;
    }
    const bytes = copyBytes(data);
    if (!bytes || !registration) {
      rejectInbound();
      return;
    }
    const metadata: RelayV2BrokerClientSocketFrameMetadata = Object.freeze({
      opcode: isBinary ? "binary" : "text",
      compressed: false,
    });
    try {
      Reflect.apply(registration.receive, undefined, [bytes, metadata]);
    } catch {
      failEffectAndTerminate();
    }
  };

  const closeListener: SocketListener = function close(code): void {
    if (this !== socket.receiver) {
      rejectInbound();
      return;
    }
    const evidence = Object.freeze({
      kind: "closed" as const,
      code: Number.isSafeInteger(code) && (code as number) >= 0 && (code as number) <= 4_999
        ? code as number
        : null,
    });
    if (!registration) {
      pendingTerminal ??= evidence;
      return;
    }
    finishTerminal(evidence);
  };

  const errorListener: SocketListener = function error(): void {
    if (this !== socket.receiver) {
      rejectInbound();
      return;
    }
    const evidence = Object.freeze({ kind: "errored" as const });
    if (!registration) {
      pendingTerminal ??= evidence;
      return;
    }
    finishTerminal(evidence);
  };

  const setupMayContinue = (): void => {
    if (setupPhase !== "installing" || pendingTerminal || setupBoundaryFailure) throw failure();
  };

  const socketPort: RelayV2BrokerClientSocketPort = Object.freeze({
    bufferedState() {
      let frames = 0;
      for (const write of pendingWrites) {
        if (!write.nativeCompleted) frames += 1;
      }
      return Object.freeze({ bytes: readBufferedAmount(socket.receiver), frames });
    },
    send(bytes, complete) {
      let state: unknown;
      try {
        state = readSocketFact(socket.receiver, "readyState");
      } catch {
        return "rejected";
      }
      if (
        effectPhase !== "open"
        || state !== OPEN
        || !(bytes instanceof Uint8Array)
        || isRejectedProxy(bytes)
        || typeof complete !== "function"
        || isRejectedProxy(complete)
      ) return "rejected";
      let outbound: Uint8Array;
      try {
        outbound = Reflect.apply(nativeUint8ArraySlice, bytes, []) as Uint8Array;
      } catch {
        return "rejected";
      }
      const write: PendingWrite = {
        complete,
        nativeCompleted: false,
        completionQueued: false,
      };
      pendingWrites.add(write);
      let callbackSeen = false;
      let callbackReceipt: RelayV2BrokerClientSocketWriteCompletion = "rejected";
      let returned = false;
      let accepted = false;
      const queueCompletion = (): void => {
        if (write.completionQueued) return;
        write.nativeCompleted = true;
        write.completionQueued = true;
        queueMicrotask(() => {
          if (effectPhase !== "open" || !pendingWrites.delete(write)) return;
          try {
            Reflect.apply(write.complete, undefined, [callbackReceipt]);
          } catch {
            failEffectAndTerminate();
          }
        });
      };
      const callback = (error?: unknown): void => {
        if (callbackSeen || !pendingWrites.has(write)) return;
        callbackSeen = true;
        callbackReceipt = error === undefined ? "delivered" : "rejected";
        if (returned && accepted) queueCompletion();
      };
      let result: unknown;
      try {
        result = Reflect.apply(socket.send, socket.receiver, [
          outbound,
          Object.freeze({ binary: false as const, compress: false as const }),
          callback,
        ]);
      } catch {
        returned = true;
        pendingWrites.delete(write);
        return "rejected";
      }
      returned = true;
      let committedState: unknown;
      try {
        committedState = readSocketFact(socket.receiver, "readyState");
      } catch {
        pendingWrites.delete(write);
        return "rejected";
      }
      if (
        result !== undefined
        || effectPhase !== "open"
        || committedState !== OPEN
        || !pendingWrites.has(write)
      ) {
        pendingWrites.delete(write);
        return "rejected";
      }
      accepted = true;
      if (callbackSeen) queueCompletion();
      return "applied";
    },
    pause() {
      let state: unknown;
      try {
        state = readSocketFact(socket.receiver, "readyState");
      } catch {
        return "rejected";
      }
      if (effectPhase !== "open" || state !== OPEN) return "rejected";
      const receipt = callVoidSocketMethod(socket, socket.pause, []);
      return receipt === "applied" && effectPhase === "open" ? "applied" : "rejected";
    },
    resume() {
      let state: unknown;
      try {
        state = readSocketFact(socket.receiver, "readyState");
      } catch {
        return "rejected";
      }
      if (effectPhase !== "open" || state !== OPEN) return "rejected";
      const receipt = callVoidSocketMethod(socket, socket.resume, []);
      return receipt === "applied" && effectPhase === "open" ? "applied" : "rejected";
    },
    close(code, reason) {
      let state: unknown;
      try {
        state = readSocketFact(socket.receiver, "readyState");
      } catch {
        return "rejected";
      }
      if (effectPhase !== "open" || (state !== OPEN && state !== CLOSING)) return "rejected";
      fenceEffects("closing");
      return callVoidSocketMethod(socket, socket.close, [code, reason]);
    },
    forceDestroy() {
      if (effectPhase === "terminal" || effectPhase === "terminating") return "rejected";
      return beginTerminating();
    },
  });

  try {
    assertOpenClientSocket(socket.receiver);
    setupPhase = "installing";
    for (const [event, listener] of [
      ["error", errorListener],
      ["close", closeListener],
      ["message", messageListener],
    ] as const) {
      // Own cleanup before invoking `on`: a socket may install and then throw,
      // return a foreign identity, or synchronously invoke this listener.
      installedListeners.push([event, listener]);
      const result = Reflect.apply(socket.on, socket.receiver, [event, listener]);
      if (result !== socket.receiver) throw failure();
      setupMayContinue();
    }
    assertOpenClientSocket(socket.receiver, setupMayContinue);
    setupMayContinue();
    setupPhase = "registering";
    const rawRegistration = Reflect.apply(registerClientSocket, transport, [{
      connectionId: fields.connectionId,
      authContext,
      hostProducerTarget,
      socket: socketPort,
    }]);
    registration = captureRegistration(rawRegistration, fields.connectionId);
    setupPhase = "registered";
  } catch (error) {
    setupPhase = "failed";
    fenceEffects("terminating");
    removeListeners();
    terminateOnce();
    void terminal.catch(() => undefined);
    void drained.catch(() => undefined);
    if (error instanceof RelayV2BrokerClientWssAdapterError) throw error;
    throw failure();
  }

  if (setupBoundaryFailure && !pendingTerminal) {
    inboundFenced = false;
    rejectInbound();
  }
  if (pendingTerminal) finishTerminal(pendingTerminal);

  return Object.freeze({
    connectionId: registration.connectionId,
    connectionIncarnation: registration.connectionIncarnation,
    openResult: registration.openResult,
    terminal,
    drained,
  });
}
