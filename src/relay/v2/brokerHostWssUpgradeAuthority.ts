import { types as nodeUtilTypes } from "node:util";

import type {
  RelayV2BrokerHostWssSocket,
  RelayV2BrokerHostWssTrustedSocketBrand,
} from "./brokerHostWssAdapter.js";
import type {
  RelayV2BrokerHostWssAdmissionClaim,
  RelayV2BrokerHostWssAdmissionReceipt,
  RelayV2BrokerHostWssConnectionHandle,
  RelayV2BrokerHostWssRuntimeFacade,
} from "./brokerHostWssRuntimeComposition.js";

const UPGRADE_INPUT_KEYS = Object.freeze([
  "admissionReceipt",
  "request",
  "socket",
  "head",
] as const);

const promiseThen = Promise.prototype.then;

export interface RelayV2BrokerHostPendingUpgradeSocket {
  destroy(): unknown;
}

export type RelayV2BrokerHostNativeUpgradeCallback = (
  this: void,
  socket: RelayV2BrokerHostWssSocket,
  request: object,
) => void;

/** Injected equivalent of one `WebSocketServer({ noServer: true }).handleUpgrade`. */
export interface RelayV2BrokerHostNativeUpgradePort {
  handleUpgrade(
    request: object,
    socket: RelayV2BrokerHostPendingUpgradeSocket,
    head: Uint8Array,
    callback: RelayV2BrokerHostNativeUpgradeCallback,
  ): unknown;
}

export interface RelayV2BrokerHostWssUpgradeInput {
  readonly admissionReceipt: RelayV2BrokerHostWssAdmissionReceipt;
  readonly request: object;
  readonly socket: RelayV2BrokerHostPendingUpgradeSocket;
  readonly head: Uint8Array;
}

export interface RelayV2BrokerHostWssUpgradeHandoff {
  upgrade(input: RelayV2BrokerHostWssUpgradeInput): RelayV2BrokerHostWssConnectionHandle;
  closeAndDrain(): Promise<void>;
}

export interface RelayV2BrokerHostWssUpgradeAuthority {
  readonly trustedSocketPrototype: object;
  readonly trustedSocketBrand: RelayV2BrokerHostWssTrustedSocketBrand;
  readonly handoff: RelayV2BrokerHostWssUpgradeHandoff;
}

export interface RelayV2BrokerHostWssUpgradeAuthorityOptions {
  readonly trustedSocketPrototype: object;
  readonly nativeUpgrade: RelayV2BrokerHostNativeUpgradePort;
  readonly claimPreparedHostWss: Pick<
    RelayV2BrokerHostWssRuntimeFacade,
    "claimPreparedHostWss"
  >["claimPreparedHostWss"];
}

type CapturedProperty = Readonly<{
  receiver: object;
  descriptor: PropertyDescriptor;
}>;

type CapturedUpgradedSocket = Readonly<{
  receiver: RelayV2BrokerHostWssSocket & object;
  readProtocol(): unknown;
  terminate: Function;
  close: Function;
}>;

type CapturedRawSocket = Readonly<{
  receiver: RelayV2BrokerHostPendingUpgradeSocket & object;
  destroy: Function;
  close(): boolean;
}>;

type CapturedAdmissionClaim = Readonly<{
  receiver: RelayV2BrokerHostWssAdmissionClaim & object;
  attach: Function;
}>;

type CallbackObservation = Readonly<{
  receiverMatched: boolean;
  requestMatched: boolean;
  socket: CapturedUpgradedSocket | null;
}>;

type ConnectionRecord = {
  readonly socket: CapturedUpgradedSocket;
  readonly drained: Promise<void>;
};

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
  return new Error("Relay v2 Broker Host native Upgrade failed");
}

function captureDataRecord(
  value: unknown,
  exactKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== "object" || rejectedProxy(value)) return null;
  try {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== exactKeys.length
      || keys.some((key) => typeof key !== "string" || !exactKeys.includes(key))
    ) return null;
    const captured = Object.create(null) as Record<string, unknown>;
    for (const key of exactKeys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
      captured[key] = descriptor.value;
    }
    return captured;
  } catch {
    return null;
  }
}

function captureProperty(receiver: object, name: string): CapturedProperty | null {
  let owner: object | null = receiver;
  try {
    while (owner !== null) {
      if (rejectedProxy(owner)) return null;
      const descriptor = Reflect.getOwnPropertyDescriptor(owner, name);
      if (descriptor !== undefined) {
        return Object.freeze({ receiver, descriptor: Object.freeze({ ...descriptor }) });
      }
      owner = Reflect.getPrototypeOf(owner);
    }
  } catch {
    return null;
  }
  return null;
}

function captureMethod(receiver: object, name: string): Function | null {
  const property = captureProperty(receiver, name);
  if (
    !property
    || !Object.hasOwn(property.descriptor, "value")
    || typeof property.descriptor.value !== "function"
    || rejectedProxy(property.descriptor.value)
  ) return null;
  return property.descriptor.value;
}

function captureReadonlyFact(receiver: object, name: string): PropertyDescriptor | null {
  const property = captureProperty(receiver, name);
  if (!property) return null;
  const descriptor = property.descriptor;
  if (Object.hasOwn(descriptor, "value")) return descriptor;
  return typeof descriptor.get === "function"
    && descriptor.set === undefined
    && !rejectedProxy(descriptor.get)
    ? descriptor
    : null;
}

function readFact(receiver: object, descriptor: PropertyDescriptor): unknown {
  return Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : Reflect.apply(descriptor.get as Function, receiver, []);
}

function captureRawSocket(value: unknown): CapturedRawSocket | null {
  if (value === null || typeof value !== "object" || rejectedProxy(value)) return null;
  const destroy = captureMethod(value, "destroy");
  if (!destroy) return null;
  let closed = false;
  return Object.freeze({
    receiver: value as RelayV2BrokerHostPendingUpgradeSocket & object,
    destroy,
    close: () => {
      if (closed) return true;
      closed = true;
      try {
        const result = Reflect.apply(destroy, value, []);
        return result === undefined || result === value;
      } catch {
        return false;
      }
    },
  });
}

function captureAdmissionClaim(value: unknown): CapturedAdmissionClaim | null {
  const captured = captureDataRecord(value, ["attach"]);
  if (!captured || typeof captured.attach !== "function" || rejectedProxy(captured.attach)) {
    return null;
  }
  try {
    if (!Object.isFrozen(value) || Reflect.getPrototypeOf(value) !== null) return null;
  } catch {
    return null;
  }
  return Object.freeze({
    receiver: value as RelayV2BrokerHostWssAdmissionClaim & object,
    attach: captured.attach,
  });
}

function captureConnectionHandle(value: unknown): Readonly<{
  handle: RelayV2BrokerHostWssConnectionHandle;
  drained: Promise<void>;
}> | null {
  if (value === null || typeof value !== "object" || rejectedProxy(value)) return null;
  try {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, "drained");
    if (
      !descriptor
      || !Object.hasOwn(descriptor, "value")
      || !nodeUtilTypes.isPromise(descriptor.value)
    ) return null;
    return Object.freeze({
      handle: value as RelayV2BrokerHostWssConnectionHandle,
      drained: descriptor.value as Promise<void>,
    });
  } catch {
    return null;
  }
}

/**
 * Default-off, listener-free owner for the sole native Host Upgrade cut.
 * It neither creates a server/listener nor selects a protocol fallback.
 */
export function createRelayV2BrokerHostWssUpgradeAuthority(
  options: RelayV2BrokerHostWssUpgradeAuthorityOptions,
): RelayV2BrokerHostWssUpgradeAuthority {
  const values = captureDataRecord(options, [
    "trustedSocketPrototype",
    "nativeUpgrade",
    "claimPreparedHostWss",
  ]);
  if (!values) throw failure();

  const trustedPrototype = values.trustedSocketPrototype;
  const nativeUpgrade = values.nativeUpgrade;
  const claimPreparedHostWss = values.claimPreparedHostWss;
  if (
    trustedPrototype === null
    || typeof trustedPrototype !== "object"
    || rejectedProxy(trustedPrototype)
    || nativeUpgrade === null
    || typeof nativeUpgrade !== "object"
    || rejectedProxy(nativeUpgrade)
    || typeof claimPreparedHostWss !== "function"
    || rejectedProxy(claimPreparedHostWss)
  ) throw failure();

  const handleUpgrade = captureMethod(nativeUpgrade, "handleUpgrade");
  const protocol = captureReadonlyFact(trustedPrototype, "protocol");
  const terminate = captureMethod(trustedPrototype, "terminate");
  const close = captureMethod(trustedPrototype, "close");
  if (!handleUpgrade || !protocol || !terminate || !close) throw failure();

  let lifecycle: "open" | "closing" | "closed" = "open";
  let activeOperations = 0;
  let closeStarted = false;
  let closePromise: Promise<void> | null = null;
  let resolveClose: (() => void) | null = null;
  let rejectClose: ((error: unknown) => void) | null = null;
  let cleanupFailed = false;
  const brandedSockets = new WeakSet<object>();
  const connections = new Set<ConnectionRecord>();

  const trustedSocketBrand: RelayV2BrokerHostWssTrustedSocketBrand = Object.freeze(
    (socket: RelayV2BrokerHostWssSocket): boolean => (
      socket !== null
      && typeof socket === "object"
      && brandedSockets.has(socket as object)
    ),
  );

  const captureUpgradedSocket = (value: unknown): CapturedUpgradedSocket | null => {
    if (value === null || typeof value !== "object" || rejectedProxy(value)) return null;
    try {
      if (Reflect.getPrototypeOf(value) !== trustedPrototype) return null;
    } catch {
      return null;
    }
    return Object.freeze({
      receiver: value as RelayV2BrokerHostWssSocket & object,
      readProtocol: () => readFact(value, protocol),
      terminate,
      close,
    });
  };

  const stopUpgradedSocket = (
    socket: CapturedUpgradedSocket,
    reason: "upgrade_failed" | "authority_closed",
  ): boolean => {
    brandedSockets.delete(socket.receiver);
    try {
      if (Reflect.apply(socket.terminate, socket.receiver, []) === undefined) return true;
    } catch {}
    try {
      return Reflect.apply(socket.close, socket.receiver, [1013, reason]) === undefined;
    } catch {
      return false;
    }
  };

  const observeConnection = (
    socket: CapturedUpgradedSocket,
    drained: Promise<void>,
  ): void => {
    const record: ConnectionRecord = { socket, drained };
    connections.add(record);
    const observation = promiseThen.call(
      drained,
      () => {
        brandedSockets.delete(socket.receiver);
        connections.delete(record);
      },
      () => {
        cleanupFailed = true;
        brandedSockets.delete(socket.receiver);
        connections.delete(record);
      },
    );
    void promiseThen.call(observation, undefined, () => undefined);
  };

  const finishClose = (): void => {
    if (closeStarted || lifecycle !== "closing" || activeOperations !== 0) return;
    closeStarted = true;
    const records = [...connections];
    for (const record of records) {
      if (!stopUpgradedSocket(record.socket, "authority_closed")) cleanupFailed = true;
    }
    const barriers = records.map((record) => record.drained);
    void Promise.allSettled(barriers).then((settlements) => {
      lifecycle = "closed";
      if (cleanupFailed || settlements.some((result) => result.status === "rejected")) {
        rejectClose?.(failure());
      } else {
        resolveClose?.();
      }
      resolveClose = null;
      rejectClose = null;
    });
  };

  let handoff!: RelayV2BrokerHostWssUpgradeHandoff;

  const upgrade = function upgrade(
    this: unknown,
    input: RelayV2BrokerHostWssUpgradeInput,
  ): RelayV2BrokerHostWssConnectionHandle {
    if (this !== handoff || lifecycle !== "open") throw failure();
    const captured = captureDataRecord(input, UPGRADE_INPUT_KEYS);
    if (!captured) throw failure();
    if (
      captured.request === null
      || typeof captured.request !== "object"
      || rejectedProxy(captured.request)
      || rejectedProxy(captured.head)
      || !(captured.head instanceof Uint8Array)
    ) throw failure();

    const rawSocket = captureRawSocket(captured.socket);
    let claimedAdmission: CapturedAdmissionClaim | null = null;
    try {
      claimedAdmission = captureAdmissionClaim(Reflect.apply(
        claimPreparedHostWss as Function,
        undefined,
        [Object.freeze({ receipt: captured.admissionReceipt })],
      ));
    } catch {}
    if (!claimedAdmission) {
      if (rawSocket && !rawSocket.close()) cleanupFailed = true;
      throw failure();
    }
    if (!rawSocket) throw failure();
    if (lifecycle !== "open") {
      if (!rawSocket.close()) cleanupFailed = true;
      throw failure();
    }

    activeOperations += 1;
    let phase: "invoking" | "returned" | "completed" | "failed" = "invoking";
    const observations: CallbackObservation[] = [];
    let acceptedSocket: CapturedUpgradedSocket | null = null;

    const closeObservations = (reason: "upgrade_failed" | "authority_closed"): void => {
      const stopped = new Set<object>();
      let needsRawClose = observations.length === 0;
      for (const observation of observations) {
        if (!observation.socket) {
          needsRawClose = true;
          continue;
        }
        if (stopped.has(observation.socket.receiver)) continue;
        stopped.add(observation.socket.receiver);
        if (!stopUpgradedSocket(observation.socket, reason)) needsRawClose = true;
      }
      if (acceptedSocket && !stopped.has(acceptedSocket.receiver)) {
        if (!stopUpgradedSocket(acceptedSocket, reason)) needsRawClose = true;
      }
      if (needsRawClose && !rawSocket.close()) cleanupFailed = true;
    };

    const callback = function callback(
      this: unknown,
      socket: RelayV2BrokerHostWssSocket,
      request: object,
    ): void {
      const observation = Object.freeze({
        receiverMatched: this === undefined,
        requestMatched: request === captured.request,
        socket: captureUpgradedSocket(socket),
      });
      if (phase === "invoking") {
        observations.push(observation);
        return;
      }
      if (observation.socket) {
        if (!stopUpgradedSocket(observation.socket, "upgrade_failed")) {
          if (!rawSocket.close()) cleanupFailed = true;
        }
      } else if (!rawSocket.close()) {
        cleanupFailed = true;
      }
      if (
        phase === "completed"
        && acceptedSocket
        && observation.socket?.receiver !== acceptedSocket.receiver
      ) {
        if (!stopUpgradedSocket(acceptedSocket, "upgrade_failed")) cleanupFailed = true;
      }
    } as RelayV2BrokerHostNativeUpgradeCallback;

    try {
      let nativeResult: unknown;
      try {
        nativeResult = Reflect.apply(handleUpgrade, nativeUpgrade, [
          captured.request,
          rawSocket.receiver,
          captured.head,
          callback,
        ]);
      } catch {
        phase = "failed";
        closeObservations("upgrade_failed");
        throw failure();
      }
      phase = "returned";
      const observation = observations[0];
      if (
        nativeResult !== undefined
        || lifecycle !== "open"
        || observations.length !== 1
        || !observation
        || !observation.receiverMatched
        || !observation.requestMatched
        || !observation.socket
      ) {
        phase = "failed";
        closeObservations(lifecycle === "open" ? "upgrade_failed" : "authority_closed");
        throw failure();
      }
      let selectedProtocol: unknown;
      try {
        selectedProtocol = observation.socket.readProtocol();
      } catch {
        selectedProtocol = null;
      }
      if (selectedProtocol !== "tw-relay.host.v2") {
        phase = "failed";
        closeObservations("upgrade_failed");
        throw failure();
      }

      acceptedSocket = observation.socket;
      brandedSockets.add(acceptedSocket.receiver);
      let attached: unknown;
      try {
        attached = Reflect.apply(claimedAdmission.attach, claimedAdmission.receiver, [Object.freeze({
          alreadyUpgradedSocket: acceptedSocket.receiver,
        })]);
      } catch {
        phase = "failed";
        closeObservations("upgrade_failed");
        throw failure();
      }
      const connection = captureConnectionHandle(attached);
      if (!connection || lifecycle !== "open") {
        phase = "failed";
        closeObservations(lifecycle === "open" ? "upgrade_failed" : "authority_closed");
        throw failure();
      }
      observeConnection(acceptedSocket, connection.drained);
      phase = "completed";
      return connection.handle;
    } catch {
      throw failure();
    } finally {
      activeOperations -= 1;
      finishClose();
    }
  };

  const closeAndDrain = function closeAndDrain(this: unknown): Promise<void> {
    if (this !== handoff) {
      const rejected = Promise.reject(failure());
      void rejected.catch(() => undefined);
      return rejected;
    }
    if (closePromise) return closePromise;
    lifecycle = "closing";
    closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    void closePromise.catch(() => undefined);
    finishClose();
    return closePromise;
  };

  handoff = Object.freeze(Object.assign(Object.create(null), {
    upgrade,
    closeAndDrain,
  })) as RelayV2BrokerHostWssUpgradeHandoff;

  return Object.freeze({
    trustedSocketPrototype: trustedPrototype,
    trustedSocketBrand,
    handoff,
  });
}
