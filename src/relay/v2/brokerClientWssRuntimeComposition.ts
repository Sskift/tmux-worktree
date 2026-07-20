import { types as nodeUtilTypes } from "node:util";

import {
  RelayV2BrokerAuthorizationExpiryDeadlineOwner,
  type RelayV2BrokerAuthorizationExpiryDeadlineRegistration,
  type RelayV2BrokerAuthorizationExpiryScheduleAt,
} from "./brokerAuthorizationExpiryDeadlineOwner.js";
import {
  createRelayV2BrokerClientSocketTransportComposition,
  type RelayV2BrokerClientSocketEffectReceipt,
  type RelayV2BrokerClientSocketRegistration,
  type RelayV2BrokerClientSocketRegistrationInput,
  type RelayV2BrokerClientSocketScheduler,
  type RelayV2BrokerClientSocketTransportCompositionOptions,
  type RelayV2BrokerManagedClientSocketTransport,
} from "./brokerClientSocketTransport.js";
import {
  createRelayV2BrokerClientWssAdapter,
  type RelayV2BrokerClientWssAdapter,
  type RelayV2BrokerClientWssSocket,
  type RelayV2BrokerClientWssTerminalEvidence,
} from "./brokerClientWssAdapter.js";
import {
  RelayV2BrokerCore,
  type RelayV2BrokerAction,
  type RelayV2BrokerConnectionAuthorization,
  type RelayV2ClientAdmission,
  type RelayV2BrokerResult,
  type RelayV2RouteOpenResult,
  type RelayV2StructuredError,
} from "./brokerCore.js";
import {
  type RelayV2BrokerHostProducerBinding,
  type RelayV2BrokerProducerRegistry,
  type RelayV2BrokerProducerTarget,
} from "./brokerProducerRegistry.js";
import type { RelayV2CarrierPumpBrokerPort } from "./carrierPump.js";
import {
  RelayV2BrokerTransportCloseCoordinator,
  type RelayV2BrokerTransportCloseDeadlineScheduler,
  type RelayV2BrokerTransportCloseLease,
} from "./brokerTransportCloseCoordinator.js";

type RelayV2BrokerCoreOptions = NonNullable<
  ConstructorParameters<typeof RelayV2BrokerCore>[0]
>;

const PREPARE_KEYS = Object.freeze([
  "connectionId",
  "trustedAuthContext",
  "hostProducerTarget",
] as const);

const ATTACH_PREPARED_KEYS = Object.freeze([
  "admissionReceipt",
  "alreadyUpgradedSocket",
] as const);

const defaultAuthorizationExpiryScheduleAt: RelayV2BrokerAuthorizationExpiryScheduleAt = (
  expiresAtMs,
  callback,
) => {
  const delayMs = Math.max(0, Math.min(2_147_483_647, expiresAtMs - Date.now()));
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
};

export interface RelayV2BrokerClientWssRuntimeCompositionOptions {
  brokerOptions?: Omit<
    RelayV2BrokerCoreOptions,
    "outputReadyPort" | "onLiveAuthorizationClose"
  >;
  producerRegistry: RelayV2BrokerProducerRegistry;
  resolveHostProducerBinding(
    fence: Parameters<
      RelayV2BrokerClientSocketTransportCompositionOptions["resolveHostProducerBinding"]
    >[0],
  ): RelayV2BrokerHostProducerBinding | undefined;
  clientSocketScheduler?: RelayV2BrokerClientSocketScheduler;
  deliveryTimeoutMs?: number;
  closeTimeoutMs?: number;
  authorizationExpiryScheduleAt?: RelayV2BrokerAuthorizationExpiryScheduleAt;
  transportCloseDeadlineScheduler?: RelayV2BrokerTransportCloseDeadlineScheduler;
}

export interface RelayV2BrokerClientWssPrepareInput {
  connectionId: string;
  trustedAuthContext: RelayV2BrokerConnectionAuthorization;
  hostProducerTarget: RelayV2BrokerProducerTarget;
}

declare const RELAY_V2_BROKER_CLIENT_WSS_ADMISSION_RECEIPT: unique symbol;

/** Process-local, owner-bound, one-shot proof of the pre-101 Core cut. */
export interface RelayV2BrokerClientWssAdmissionReceipt {
  readonly [RELAY_V2_BROKER_CLIENT_WSS_ADMISSION_RECEIPT]: never;
}

export type RelayV2BrokerClientWssPrepareResult = Readonly<
  | {
      outcome: "accept";
      admissionReceipt: RelayV2BrokerClientWssAdmissionReceipt;
    }
  | {
      outcome: "reject";
      status: 401 | 403 | 426 | 503;
      error: Readonly<RelayV2StructuredError>;
    }
>;

export interface RelayV2BrokerClientWssAttachPreparedInput {
  admissionReceipt: RelayV2BrokerClientWssAdmissionReceipt;
  alreadyUpgradedSocket: RelayV2BrokerClientWssSocket;
}

export interface RelayV2BrokerClientWssConnectionHandle {
  readonly connectionId: string;
  readonly incarnation: string;
  readonly openResult: RelayV2RouteOpenResult;
  readonly terminal: Promise<RelayV2BrokerClientWssTerminalEvidence>;
  /** Composition-owned drain: Core/expiry/close lease, then adapter cleanup. */
  readonly drained: Promise<void>;
}

export interface RelayV2BrokerClientWssRuntimeComposition {
  /** Exact bound handoff for the future Host carrier Pump owner only. */
  readonly hostPumpBrokerAuthority: RelayV2CarrierPumpBrokerPort;
  /** Synchronously and permanently fences only new client admission. */
  sealClientAdmission(): void;
  prepareClientWss(
    input: RelayV2BrokerClientWssPrepareInput,
  ): RelayV2BrokerClientWssPrepareResult;
  attachPreparedClientWss(
    input: RelayV2BrokerClientWssAttachPreparedInput,
  ): RelayV2BrokerClientWssConnectionHandle;
  applyBrokerAction(action: RelayV2BrokerAction): RelayV2BrokerClientSocketEffectReceipt;
  closeAndDrain(): Promise<void>;
}

type CapturedClientWssAttach = Readonly<{
  connectionId: string;
  authContext: RelayV2BrokerConnectionAuthorization;
  hostProducerTarget: RelayV2BrokerProducerTarget;
  alreadyUpgradedSocket: RelayV2BrokerClientWssSocket;
}>;

type AdmissionReceiptRecord = {
  readonly owner: RelayV2BrokerClientWssRuntimeCompositionImpl;
  readonly connectionId: string;
  readonly authContext: RelayV2BrokerConnectionAuthorization;
  readonly hostProducerTarget: RelayV2BrokerProducerTarget;
  phase: "issued" | "consumed";
};

const ADMISSION_RECEIPTS = new WeakMap<object, AdmissionReceiptRecord>();

type ConnectionRecord = {
  readonly connectionId: string;
  readonly incarnation: string;
  readonly lease: RelayV2BrokerTransportCloseLease;
  readonly adapter: RelayV2BrokerClientWssAdapter;
  readonly terminalOwner: ManagedRegistrationTerminalOwner;
  expiry: RelayV2BrokerAuthorizationExpiryDeadlineRegistration | null;
  readonly drained: Promise<void>;
};

type Deferred = {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
};

type NativeTerminalSocket = {
  readonly receiver: object;
  readonly on: Function;
  readonly removeListener: Function;
};

type RegistrationTerminalKind = "closed" | "errored";

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  void promise.catch(() => {});
  return Object.freeze({ promise, resolve, reject });
}

function isRejectedProxy(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  try {
    return nodeUtilTypes.isProxy(value);
  } catch {
    return true;
  }
}

function captureNativeTerminalSocket(socket: unknown): NativeTerminalSocket {
  if (socket === null || typeof socket !== "object" || isRejectedProxy(socket)) {
    throw new Error("invalid Relay v2 Broker client WSS terminal boundary");
  }
  const captureMethod = (name: "on" | "removeListener"): Function => {
    let owner: object | null = socket;
    while (owner) {
      if (isRejectedProxy(owner)) break;
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      if (descriptor) {
        if (Object.hasOwn(descriptor, "value") && typeof descriptor.value === "function") {
          return descriptor.value;
        }
        break;
      }
      owner = Object.getPrototypeOf(owner);
    }
    throw new Error("invalid Relay v2 Broker client WSS terminal method");
  };
  return Object.freeze({
    receiver: socket,
    on: captureMethod("on"),
    removeListener: captureMethod("removeListener"),
  });
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 128
    && value.trim() === value
    && !/[\0\r\n]/.test(value);
}

function invalidAuthorizationSnapshot(): RelayV2BrokerConnectionAuthorization {
  return Object.freeze(Object.create(null)) as RelayV2BrokerConnectionAuthorization;
}

function captureAuthorizationSnapshot(
  value: unknown,
): RelayV2BrokerConnectionAuthorization {
  if (value === null || typeof value !== "object" || isRejectedProxy(value)) {
    return invalidAuthorizationSnapshot();
  }
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) {
      return invalidAuthorizationSnapshot();
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        return invalidAuthorizationSnapshot();
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot) as RelayV2BrokerConnectionAuthorization;
  } catch {
    return invalidAuthorizationSnapshot();
  }
}

/** Canonical strict capture for the exact two-field Host producer target. */
export function captureRelayV2BrokerProducerTarget(
  value: unknown,
): RelayV2BrokerProducerTarget | null {
  if (value === null || typeof value !== "object" || isRejectedProxy(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== 2
      || !keys.every((key) => key === "transportId" || key === "generation")
    ) return null;
    const transportId = descriptors.transportId;
    const generation = descriptors.generation;
    if (
      !transportId
      || !Object.hasOwn(transportId, "value")
      || !isIdentifier(transportId.value)
      || !generation
      || !Object.hasOwn(generation, "value")
      || typeof generation.value !== "string"
      || !/^[1-9][0-9]*$/.test(generation.value)
    ) return null;
    return Object.freeze({
      transportId: transportId.value,
      generation: generation.value,
    });
  } catch {
    return null;
  }
}

function capturePrepareInput(
  input: RelayV2BrokerClientWssPrepareInput,
): Readonly<RelayV2BrokerClientWssPrepareInput> {
  if (input === null || typeof input !== "object" || isRejectedProxy(input)) {
    throw new Error("invalid Relay v2 Broker client WSS prepare input");
  }
  try {
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== PREPARE_KEYS.length
      || !keys.every((key) => typeof key === "string" && PREPARE_KEYS.includes(
        key as (typeof PREPARE_KEYS)[number],
      ))
    ) throw new Error("invalid prepare shape");
    const values = Object.create(null) as Record<string, unknown>;
    for (const key of PREPARE_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        throw new Error("invalid prepare descriptor");
      }
      values[key] = descriptor.value;
    }
    if (!isIdentifier(values.connectionId)) throw new Error("invalid connection ID");
    const hostProducerTarget = captureRelayV2BrokerProducerTarget(
      values.hostProducerTarget,
    );
    if (!hostProducerTarget) throw new Error("invalid Host producer target");
    return Object.freeze({
      connectionId: values.connectionId,
      trustedAuthContext: captureAuthorizationSnapshot(values.trustedAuthContext),
      hostProducerTarget,
    });
  } catch {
    throw new Error("invalid Relay v2 Broker client WSS prepare input");
  }
}

function captureAttachPreparedInput(
  input: RelayV2BrokerClientWssAttachPreparedInput,
): Readonly<RelayV2BrokerClientWssAttachPreparedInput> {
  if (input === null || typeof input !== "object" || isRejectedProxy(input)) {
    throw new Error("invalid Relay v2 Broker prepared client WSS attach input");
  }
  try {
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== ATTACH_PREPARED_KEYS.length
      || !keys.every((key) => typeof key === "string" && ATTACH_PREPARED_KEYS.includes(
        key as (typeof ATTACH_PREPARED_KEYS)[number],
      ))
    ) throw new Error("invalid prepared attach shape");
    const admissionReceipt = descriptors.admissionReceipt;
    const alreadyUpgradedSocket = descriptors.alreadyUpgradedSocket;
    if (
      !admissionReceipt
      || !Object.hasOwn(admissionReceipt, "value")
      || !alreadyUpgradedSocket
      || !Object.hasOwn(alreadyUpgradedSocket, "value")
    ) throw new Error("invalid prepared attach descriptor");
    return Object.freeze({
      admissionReceipt: admissionReceipt.value as RelayV2BrokerClientWssAdmissionReceipt,
      alreadyUpgradedSocket: alreadyUpgradedSocket.value as RelayV2BrokerClientWssSocket,
    });
  } catch {
    throw new Error("invalid Relay v2 Broker prepared client WSS attach input");
  }
}

function frozenAdmissionRejection(
  admission: Extract<RelayV2ClientAdmission, { outcome: "reject" }>,
): RelayV2BrokerClientWssPrepareResult {
  return Object.freeze({
    outcome: "reject" as const,
    status: admission.status,
    error: Object.freeze({ ...admission.error }),
  });
}

function closingAdmissionRejection(): RelayV2BrokerClientWssPrepareResult {
  return Object.freeze({
    outcome: "reject" as const,
    status: 503 as const,
    error: Object.freeze({
      code: "CAPABILITY_UNAVAILABLE" as const,
      message: "Broker client WSS runtime is closing",
      retryable: false,
      retryAfterMs: null,
      commandDisposition: "not_applicable" as const,
      details: null,
    }),
  });
}

function rejectedResult(): RelayV2BrokerResult {
  return Object.freeze({ accepted: false, actions: [] });
}

function observeBarrier(run: () => unknown): Promise<unknown> {
  try {
    return Promise.resolve(run());
  } catch (error) {
    return Promise.reject(error);
  }
}

function failedRegistration(
  connectionId: string,
  connectionIncarnation: string,
): RelayV2BrokerClientSocketRegistration {
  const result = rejectedResult();
  return Object.freeze({
    connectionId,
    connectionIncarnation,
    openResult: result,
    receive: () => result,
    writable: () => "rejected" as const,
    closed: () => result,
    errored: () => result,
  });
}

class ManagedRegistrationTerminalOwner {
  readonly terminal: Promise<RegistrationTerminalKind>;

  private readonly nativeSocket: NativeTerminalSocket;
  private registration: RelayV2BrokerClientSocketRegistration | null = null;
  private winner: RegistrationTerminalKind | null = null;
  private terminalResult: RelayV2BrokerResult | null = null;
  private terminalResolve!: (kind: RegistrationTerminalKind) => void;
  private listenersInstalled = false;
  private cleanupDrain: Promise<void> | null = null;
  private readonly closeListener: (this: object) => void;
  private readonly errorListener: (this: object) => void;

  constructor(nativeSocket: NativeTerminalSocket) {
    this.nativeSocket = nativeSocket;
    const owner = this;
    this.terminal = new Promise<RegistrationTerminalKind>((resolve) => {
      this.terminalResolve = resolve;
    });
    this.closeListener = function closeListener(this: object): void {
      if (this === nativeSocket.receiver) owner.finish("closed");
    };
    this.errorListener = function errorListener(this: object): void {
      if (this === nativeSocket.receiver) owner.finish("errored");
    };
  }

  bind(registration: RelayV2BrokerClientSocketRegistration): RelayV2BrokerClientSocketRegistration {
    if (this.registration) throw new Error("Relay v2 Broker terminal registration already bound");
    this.registration = registration;
    return Object.freeze({
      connectionId: registration.connectionId,
      connectionIncarnation: registration.connectionIncarnation,
      openResult: registration.openResult,
      receive: registration.receive,
      writable: registration.writable,
      closed: () => this.finish("closed"),
      errored: () => this.finish("errored"),
    });
  }

  installNativeGuard(): void {
    if (!this.registration || this.listenersInstalled) {
      throw new Error("Relay v2 Broker terminal guard cannot be installed");
    }
    const installed: Array<["close" | "error", Function]> = [];
    try {
      for (const [event, listener] of [
        ["close", this.closeListener],
        ["error", this.errorListener],
      ] as const) {
        installed.push([event, listener]);
        const receipt = Reflect.apply(this.nativeSocket.on, this.nativeSocket.receiver, [
          event,
          listener,
        ]);
        if (receipt !== this.nativeSocket.receiver) {
          throw new Error("Relay v2 Broker terminal guard install was rejected");
        }
      }
      this.listenersInstalled = true;
    } catch (error) {
      for (const [event, listener] of installed.reverse()) {
        try {
          Reflect.apply(this.nativeSocket.removeListener, this.nativeSocket.receiver, [
            event,
            listener,
          ]);
        } catch {
          // The caller will fail the attach and retain the real adapter drain.
        }
      }
      throw error;
    }
  }

  finish(kind: RegistrationTerminalKind): RelayV2BrokerResult {
    if (this.winner) return this.terminalResult ?? rejectedResult();
    this.winner = kind;
    const registration = this.registration;
    if (!registration) {
      this.terminalResult = rejectedResult();
    } else {
      try {
        this.terminalResult = kind === "closed"
          ? registration.closed()
          : registration.errored();
      } catch {
        this.terminalResult = rejectedResult();
      }
    }
    this.terminalResolve(kind);
    return this.terminalResult;
  }

  cleanup(): Promise<void> {
    if (this.cleanupDrain) return this.cleanupDrain;
    this.cleanupDrain = (async () => {
      await this.terminal;
      if (!this.listenersInstalled) return;
      this.listenersInstalled = false;
      let failure: unknown;
      for (const [event, listener] of [
        ["close", this.closeListener],
        ["error", this.errorListener],
      ] as const) {
        try {
          const receipt = Reflect.apply(
            this.nativeSocket.removeListener,
            this.nativeSocket.receiver,
            [event, listener],
          );
          if (receipt !== this.nativeSocket.receiver) {
            failure ??= new Error("Relay v2 Broker terminal guard cleanup was rejected");
          }
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure) throw failure;
    })();
    void this.cleanupDrain.catch(() => {});
    return this.cleanupDrain;
  }
}

class RelayV2BrokerClientWssRuntimeCompositionImpl
implements RelayV2BrokerClientWssRuntimeComposition {
  readonly hostPumpBrokerAuthority: RelayV2CarrierPumpBrokerPort;

  private readonly broker: RelayV2BrokerCore;
  private readonly transport: RelayV2BrokerManagedClientSocketTransport;
  private readonly closeCoordinator: RelayV2BrokerTransportCloseCoordinator;
  private readonly expiryOwner: RelayV2BrokerAuthorizationExpiryDeadlineOwner;
  private readonly connections = new Map<string, ConnectionRecord>();
  private readonly attachingConnectionIds = new Set<string>();
  private readonly pendingAttaches = new Set<Deferred>();
  private readonly partialDrains = new Set<Promise<void>>();
  private partialDrainFailure: unknown;
  private partialDrainFailed = false;
  private clientAdmissionOpen = true;
  private clientEffectsOpen = true;
  private serializerActive = false;
  private readonly serializerQueue: Array<{
    run: () => unknown;
    resolve(value: unknown): void;
    reject(error: unknown): void;
  }> = [];
  private closeDrain: Promise<void> | null = null;

  constructor(options: RelayV2BrokerClientWssRuntimeCompositionOptions) {
    this.closeCoordinator = new RelayV2BrokerTransportCloseCoordinator({
      deadlineScheduler: options.transportCloseDeadlineScheduler,
    });
    const transportComposition = createRelayV2BrokerClientSocketTransportComposition({
      brokerOptions: options.brokerOptions,
      producerRegistry: options.producerRegistry,
      resolveHostProducerBinding: options.resolveHostProducerBinding,
      scheduler: options.clientSocketScheduler,
      deliveryTimeoutMs: options.deliveryTimeoutMs,
      closeTimeoutMs: options.closeTimeoutMs,
    }, {
      onLiveAuthorizationClose: (signal) => {
        this.closeCoordinator.handleLiveAuthorizationClose(signal);
      },
    });
    this.broker = transportComposition.broker;
    this.transport = transportComposition.clientSocketTransport;
    this.hostPumpBrokerAuthority = Object.freeze({
      attachHostCarrier: (...args: Parameters<RelayV2BrokerCore["attachHostCarrier"]>) => (
        this.broker.attachHostCarrier(...args)
      ),
      receiveHostFrame: (...args: Parameters<RelayV2BrokerCore["receiveHostFrame"]>) => (
        this.broker.receiveHostFrame(...args)
      ),
      drainHostCarrier: (...args: Parameters<RelayV2BrokerCore["drainHostCarrier"]>) => (
        this.broker.drainHostCarrier(...args)
      ),
      acknowledgeHostControlDelivery: (
        ...args: Parameters<RelayV2BrokerCore["acknowledgeHostControlDelivery"]>
      ) => this.broker.acknowledgeHostControlDelivery(...args),
      acknowledgeHostDelivery: (
        ...args: Parameters<RelayV2BrokerCore["acknowledgeHostDelivery"]>
      ) => this.broker.acknowledgeHostDelivery(...args),
      sweepBackpressure: (...args: Parameters<RelayV2BrokerCore["sweepBackpressure"]>) => (
        this.broker.sweepBackpressure(...args)
      ),
      disconnectHost: (...args: Parameters<RelayV2BrokerCore["disconnectHost"]>) => (
        this.broker.disconnectHost(...args)
      ),
    });
    this.expiryOwner = new RelayV2BrokerAuthorizationExpiryDeadlineOwner({
      serializedCutPort: Object.freeze({
        recheckConnectionAccessExpiry: (
          connectionKind: "client" | "host",
          connectionId: string,
          connectionIncarnation: string,
        ) => this.serialize(() => this.broker.recheckConnectionAccessExpiry(
          connectionKind,
          connectionId,
          connectionIncarnation,
        )),
        failClosed: () => this.serialize(() => {
          this.broker.liveAuthorizationFencePort.failClosed();
        }),
      }),
      scheduleAt: options.authorizationExpiryScheduleAt
        ?? defaultAuthorizationExpiryScheduleAt,
    });
  }

  sealClientAdmission(): void {
    this.clientAdmissionOpen = false;
  }

  prepareClientWss(
    input: RelayV2BrokerClientWssPrepareInput,
  ): RelayV2BrokerClientWssPrepareResult {
    if (!this.clientAdmissionOpen) return closingAdmissionRejection();
    const captured = capturePrepareInput(input);
    if (
      this.connections.has(captured.connectionId)
      || this.attachingConnectionIds.has(captured.connectionId)
    ) {
      throw new Error("duplicate Relay v2 Broker client WSS connection ID");
    }
    const admission = this.broker.inspectClientAdmission(captured.trustedAuthContext);
    if (admission.outcome === "reject") return frozenAdmissionRejection(admission);
    if (!this.clientAdmissionOpen) return closingAdmissionRejection();

    const admissionReceipt = Object.freeze(
      Object.create(null),
    ) as RelayV2BrokerClientWssAdmissionReceipt;
    ADMISSION_RECEIPTS.set(admissionReceipt, {
      owner: this,
      connectionId: captured.connectionId,
      authContext: captured.trustedAuthContext,
      hostProducerTarget: captured.hostProducerTarget,
      phase: "issued",
    });
    return Object.freeze({ outcome: "accept", admissionReceipt });
  }

  attachPreparedClientWss(
    input: RelayV2BrokerClientWssAttachPreparedInput,
  ): RelayV2BrokerClientWssConnectionHandle {
    if (!this.clientAdmissionOpen) {
      throw new Error("Relay v2 Broker client WSS runtime is closing");
    }
    const prepared = captureAttachPreparedInput(input);
    if (!this.clientAdmissionOpen) {
      throw new Error("Relay v2 Broker client WSS runtime is closing");
    }
    const receipt = prepared.admissionReceipt;
    const receiptRecord = receipt !== null && typeof receipt === "object"
      ? ADMISSION_RECEIPTS.get(receipt)
      : undefined;
    if (
      !receiptRecord
      || receiptRecord.owner !== this
      || receiptRecord.phase !== "issued"
    ) {
      throw new Error("invalid Relay v2 Broker client WSS admission receipt");
    }
    receiptRecord.phase = "consumed";
    if (
      this.connections.has(receiptRecord.connectionId)
      || this.attachingConnectionIds.has(receiptRecord.connectionId)
    ) {
      throw new Error("stale Relay v2 Broker client WSS admission receipt");
    }
    const captured: CapturedClientWssAttach = Object.freeze({
      connectionId: receiptRecord.connectionId,
      authContext: receiptRecord.authContext,
      hostProducerTarget: receiptRecord.hostProducerTarget,
      alreadyUpgradedSocket: prepared.alreadyUpgradedSocket,
    });
    return this.attachCapturedClientWss(captured);
  }

  private attachCapturedClientWss(
    captured: CapturedClientWssAttach,
  ): RelayV2BrokerClientWssConnectionHandle {
    if (!this.clientAdmissionOpen) {
      throw new Error("Relay v2 Broker client WSS runtime is closing");
    }
    const nativeTerminalSocket = captureNativeTerminalSocket(captured.alreadyUpgradedSocket);
    if (!this.clientAdmissionOpen) {
      throw new Error("Relay v2 Broker client WSS runtime is closing");
    }
    if (
      this.connections.has(captured.connectionId)
      || this.attachingConnectionIds.has(captured.connectionId)
    ) {
      throw new Error("duplicate Relay v2 Broker client WSS connection ID");
    }
    this.attachingConnectionIds.add(captured.connectionId);
    const pending = deferred();
    this.pendingAttaches.add(pending);
    let record: ConnectionRecord | null = null;
    let partialDrain: Promise<void> | null = null;
    let transportFailure: unknown;
    let terminalOwner: ManagedRegistrationTerminalOwner | null = null;
    let managedRegistration: ReturnType<
      RelayV2BrokerTransportCloseCoordinator["registerManagedClientSocket"]
    > | null = null;

    try {
      const adapterTransport = Object.freeze({
        registerClientSocket: (registrationInput: RelayV2BrokerClientSocketRegistrationInput) => {
          if (managedRegistration) {
            throw new Error("Relay v2 Broker client WSS transport registered twice");
          }
          const socketPort = registrationInput.socket;
          managedRegistration = this.closeCoordinator.registerManagedClientSocket({
            connectionKind: "client",
            connectionId: registrationInput.connectionId,
            close: (code, reason) => socketPort.close(code, reason),
            forceDestroy: () => socketPort.forceDestroy(),
          });
          terminalOwner = new ManagedRegistrationTerminalOwner(nativeTerminalSocket);
          let registration: RelayV2BrokerClientSocketRegistration;
          try {
            registration = this.transport.registerManagedClientSocket(
              managedRegistration.lease,
              registrationInput,
            );
          } catch (error) {
            transportFailure = error;
            registration = failedRegistration(
              registrationInput.connectionId,
              managedRegistration.connectionIncarnation,
            );
          }
          const managedTerminalRegistration = terminalOwner.bind(registration);
          try {
            terminalOwner.installNativeGuard();
          } catch (error) {
            transportFailure ??= error;
          }
          return managedTerminalRegistration;
        },
        applyBrokerAction: (action: RelayV2BrokerAction) => (
          this.transport.applyBrokerAction(action)
        ),
      });
      const adapter = createRelayV2BrokerClientWssAdapter({
        connectionId: captured.connectionId,
        authContext: captured.authContext,
        hostProducerTarget: captured.hostProducerTarget,
        socket: captured.alreadyUpgradedSocket,
        transport: adapterTransport,
      });
      const closeRegistration = managedRegistration as ReturnType<
        RelayV2BrokerTransportCloseCoordinator["registerManagedClientSocket"]
      > | null;
      const boundTerminalOwner = terminalOwner as ManagedRegistrationTerminalOwner | null;
      if (
        !closeRegistration
        || !boundTerminalOwner
        || adapter.connectionIncarnation !== closeRegistration.connectionIncarnation
      ) {
        throw new Error("Relay v2 Broker client WSS incarnation binding failed");
      }
      record = this.installConnectionRecord(
        closeRegistration.lease,
        boundTerminalOwner,
        adapter,
      );
      this.connections.set(record.connectionId, record);

      if (transportFailure || !this.clientAdmissionOpen) {
        this.abortPartialConnection(record);
        throw new Error("Relay v2 Broker client WSS transport construction failed");
      }
      try {
        record.expiry = this.expiryOwner.register(
          "client",
          record.connectionId,
          record.incarnation,
        );
      } catch {
        this.abortPartialConnection(record);
        throw new Error("Relay v2 Broker client WSS expiry construction failed");
      }
      if (!this.clientAdmissionOpen) {
        this.abortPartialConnection(record);
        throw new Error("Relay v2 Broker client WSS runtime is closing");
      }

      return Object.freeze({
        connectionId: record.connectionId,
        incarnation: record.incarnation,
        openResult: record.adapter.openResult,
        terminal: record.adapter.terminal,
        drained: record.drained,
      });
    } catch (error) {
      const closeRegistration = managedRegistration as ReturnType<
        RelayV2BrokerTransportCloseCoordinator["registerManagedClientSocket"]
      > | null;
      const boundTerminalOwner = terminalOwner as ManagedRegistrationTerminalOwner | null;
      if (closeRegistration && !record) {
        this.transport.retireManagedClientSocket(closeRegistration.lease);
        this.closeCoordinator.forceDestroyManagedSocket(closeRegistration.lease);
        if (boundTerminalOwner) {
          partialDrain = this.drainPartialConnection(
            closeRegistration.lease,
            boundTerminalOwner,
          );
          this.partialDrains.add(partialDrain);
          void partialDrain.then(
            () => { this.partialDrains.delete(partialDrain!); },
            (drainError) => {
              this.partialDrains.delete(partialDrain!);
              if (!this.partialDrainFailed) this.partialDrainFailure = drainError;
              this.partialDrainFailed = true;
            },
          );
        }
      }
      throw error;
    } finally {
      if (partialDrain) {
        void partialDrain.then(
          () => {
            this.pendingAttaches.delete(pending);
            this.attachingConnectionIds.delete(captured.connectionId);
            pending.resolve();
          },
          (error) => {
            this.pendingAttaches.delete(pending);
            this.attachingConnectionIds.delete(captured.connectionId);
            pending.reject(error);
          },
        );
      } else {
        this.pendingAttaches.delete(pending);
        this.attachingConnectionIds.delete(captured.connectionId);
        pending.resolve();
      }
    }
  }

  applyBrokerAction(action: RelayV2BrokerAction): RelayV2BrokerClientSocketEffectReceipt {
    if (!this.clientEffectsOpen) return "rejected";
    return this.transport.applyBrokerAction(action);
  }

  closeAndDrain(): Promise<void> {
    if (this.closeDrain) return this.closeDrain;
    this.sealClientAdmission();
    this.clientEffectsOpen = false;
    const failClosed = observeBarrier(() => this.serialize(() => {
      this.broker.liveAuthorizationFencePort.failClosed();
    }));
    const expiryClosed = observeBarrier(() => this.expiryOwner.close());
    const pending = [...this.pendingAttaches].map((attach) => attach.promise);
    this.closeDrain = (async () => {
      let firstError: unknown;
      let failed = false;
      const settle = async (barriers: readonly Promise<unknown>[]): Promise<void> => {
        const results = await Promise.allSettled(barriers);
        for (const result of results) {
          if (result.status === "rejected" && !failed) {
            failed = true;
            firstError = result.reason;
          }
        }
      };
      await settle([failClosed, expiryClosed]);
      await settle(pending);
      await settle([...this.partialDrains]);
      if (this.partialDrainFailed && !failed) {
        failed = true;
        firstError = this.partialDrainFailure;
      }
      while (this.connections.size > 0) {
        await settle([...this.connections.values()].map((record) => record.drained));
      }
      if (failed) throw firstError;
    })();
    void this.closeDrain.catch(() => {});
    return this.closeDrain;
  }

  private installConnectionRecord(
    lease: RelayV2BrokerTransportCloseLease,
    terminalOwner: ManagedRegistrationTerminalOwner,
    adapter: RelayV2BrokerClientWssAdapter,
  ): ConnectionRecord {
    let record!: ConnectionRecord;
    const drained = terminalOwner.terminal.then(async () => {
      let failure: unknown;
      let failed = false;
      if (record.expiry) {
        try {
          await record.expiry.unregister();
        } catch (error) {
          failed = true;
          failure = error;
        }
      }
      try {
        if (!this.closeCoordinator.terminalAndUnregisterManagedSocket(lease) && !failed) {
          failed = true;
          failure = new Error("Relay v2 Broker client WSS close lease terminal mismatch");
        }
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
      const cleanup = await Promise.allSettled([
        observeBarrier(() => terminalOwner.cleanup()),
        adapter.drained,
      ]);
      for (const result of cleanup) {
        if (result.status === "rejected" && !failed) {
          failed = true;
          failure = result.reason;
        }
      }
      if (this.connections.get(adapter.connectionId) === record) {
        this.connections.delete(adapter.connectionId);
      }
      if (failed) throw failure;
    });
    void drained.catch(() => {});
    record = {
      connectionId: adapter.connectionId,
      incarnation: adapter.connectionIncarnation,
      lease,
      adapter,
      terminalOwner,
      expiry: null,
      drained,
    };
    return record;
  }

  private abortPartialConnection(record: ConnectionRecord): void {
    this.transport.retireManagedClientSocket(record.lease);
    this.closeCoordinator.forceDestroyManagedSocket(record.lease);
  }

  private async drainPartialConnection(
    lease: RelayV2BrokerTransportCloseLease,
    terminalOwner: ManagedRegistrationTerminalOwner,
  ): Promise<void> {
    await terminalOwner.terminal;
    let failure: unknown;
    let failed = false;
    try {
      if (!this.closeCoordinator.terminalAndUnregisterManagedSocket(lease)) {
        failed = true;
        failure = new Error("Relay v2 Broker partial client WSS close lease terminal mismatch");
      }
    } catch (error) {
      failed = true;
      failure = error;
    }
    const cleanup = await Promise.allSettled([
      observeBarrier(() => terminalOwner.cleanup()),
    ]);
    if (cleanup[0].status === "rejected" && !failed) {
      failed = true;
      failure = cleanup[0].reason;
    }
    if (failed) throw failure;
  }

  private serialize<T>(run: () => T): T | Promise<T> {
    if (this.serializerActive) {
      return new Promise<T>((resolve, reject) => {
        this.serializerQueue.push({
          run,
          resolve: (value) => resolve(value as T),
          reject,
        });
      });
    }
    this.serializerActive = true;
    try {
      return run();
    } finally {
      this.serializerActive = false;
      this.drainSerializerQueue();
    }
  }

  private drainSerializerQueue(): void {
    if (this.serializerActive) return;
    const next = this.serializerQueue.shift();
    if (!next) return;
    this.serializerActive = true;
    try {
      next.resolve(next.run());
    } catch (error) {
      next.reject(error);
    } finally {
      this.serializerActive = false;
      this.drainSerializerQueue();
    }
  }
}

/**
 * Default-off only: this creates no listener, credential authority, E0 store,
 * process, retry owner, capability advertisement, or protocol fallback.
 */
export function createRelayV2BrokerClientWssRuntimeComposition(
  options: RelayV2BrokerClientWssRuntimeCompositionOptions,
): RelayV2BrokerClientWssRuntimeComposition {
  const owner = new RelayV2BrokerClientWssRuntimeCompositionImpl(options);
  const sealClientAdmission = () => owner.sealClientAdmission();
  return Object.freeze({
    hostPumpBrokerAuthority: owner.hostPumpBrokerAuthority,
    sealClientAdmission,
    prepareClientWss: (input: RelayV2BrokerClientWssPrepareInput) => (
      owner.prepareClientWss(input)
    ),
    attachPreparedClientWss: (input: RelayV2BrokerClientWssAttachPreparedInput) => (
      owner.attachPreparedClientWss(input)
    ),
    applyBrokerAction: (action: RelayV2BrokerAction) => owner.applyBrokerAction(action),
    closeAndDrain: () => owner.closeAndDrain(),
  });
}
