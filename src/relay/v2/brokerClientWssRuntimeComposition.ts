import { randomUUID } from "node:crypto";
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
import type { RelayV2BrokerHostWssTrustedSocketBrand } from "./brokerHostWssAdapter.js";
import {
  RelayV2BrokerCore,
  type RelayV2BrokerAction,
  type RelayV2AuthControlDecision,
  type RelayV2AuthControlRequest,
  type RelayV2BrokerAuthControlAuthority,
  type RelayV2BrokerConnectionAuthorization,
  type RelayV2ClientAdmission,
  type RelayV2BrokerResult,
  type RelayV2LiveAuthorizationFencePort,
  type RelayV2RouteOpenResult,
  type RelayV2StructuredError,
} from "./brokerCore.js";
import {
  type RelayV2BrokerHostProducerBinding,
  type RelayV2BrokerPreparedCall,
  type RelayV2BrokerProducerHandoff,
  type RelayV2BrokerProducerPort,
  type RelayV2BrokerProducerReceipt,
  type RelayV2BrokerProducerRegistration,
  type RelayV2BrokerProducerRegistry,
  type RelayV2BrokerProducerTarget,
} from "./brokerProducerRegistry.js";
import {
  bindRelayV2BrokerHostWssRuntimeFacade,
  type RelayV2BrokerHostWssRuntimeFacade,
  type RelayV2BrokerHostWssRuntimeOwnerBinding,
} from "./brokerHostWssRuntimeComposition.js";
import type { RelayV2CarrierPumpBrokerPort } from "./carrierPump.js";
import {
  RelayV2BrokerTransportCloseCoordinator,
  type RelayV2BrokerTransportCloseDeadlineScheduler,
  type RelayV2BrokerTransportCloseLease,
  type RelayV2BrokerTransportSocketRegistration,
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

/** The credential owner admitted by the default-off one-shot activation. */
export interface RelayV2BrokerActivatedCredentialAuthority
extends RelayV2BrokerAuthControlAuthority {
  readonly authorityContinuityReadiness: Readonly<{ status: string }>;
  close(): Promise<void>;
}

export type RelayV2BrokerClientWssRuntimeActivationOptions<
  Authority extends RelayV2BrokerActivatedCredentialAuthority =
    RelayV2BrokerActivatedCredentialAuthority,
> = Omit<RelayV2BrokerClientWssRuntimeCompositionOptions, "brokerOptions"> & {
  brokerOptions?: Omit<
    RelayV2BrokerCoreOptions,
    "outputReadyPort" | "onLiveAuthorizationClose" | "authControlAuthority"
  >;
  openCredentialAuthority(input: Readonly<{
    liveAuthorizationFence: RelayV2LiveAuthorizationFencePort;
  }>): Promise<Authority>;
};

export type RelayV2BrokerClientWssRuntimeActivation = Readonly<{
  runtime: RelayV2BrokerClientWssRuntimeComposition;
}>;

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

type CapturedCredentialAuthority = Readonly<{
  receiver: object;
  handle: Function;
}>;

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

function captureMethod(value: object, name: string): Function | null {
  let owner: object | null = value;
  try {
    while (owner) {
      if (isRejectedProxy(owner)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      if (descriptor) {
        return Object.hasOwn(descriptor, "value") && typeof descriptor.value === "function"
          ? descriptor.value
          : null;
      }
      owner = Object.getPrototypeOf(owner);
    }
  } catch {
    return null;
  }
  return null;
}

class CredentialAuthorityCloseOwner {
  private closeBarrier: Promise<void> | null = null;

  constructor(
    private readonly receiver: object,
    private readonly closeMethod: Function,
  ) {}

  close(): Promise<void> {
    if (this.closeBarrier) return this.closeBarrier;
    try {
      this.closeBarrier = Promise.resolve(
        Reflect.apply(this.closeMethod, this.receiver, []),
      ).then(() => undefined);
    } catch (error) {
      this.closeBarrier = Promise.reject(error);
    }
    void this.closeBarrier.catch(() => {});
    return this.closeBarrier;
  }
}

function captureCredentialAuthorityCloseOwner(
  value: unknown,
): CredentialAuthorityCloseOwner | null {
  if (value === null || typeof value !== "object" || isRejectedProxy(value)) return null;
  const closeMethod = captureMethod(value, "close");
  return closeMethod ? new CredentialAuthorityCloseOwner(value, closeMethod) : null;
}

function captureReadyCredentialAuthority(value: unknown): CapturedCredentialAuthority | null {
  if (value === null || typeof value !== "object" || isRejectedProxy(value)) return null;
  const handle = captureMethod(value, "handle");
  if (!handle) return null;
  try {
    const readiness = (value as { authorityContinuityReadiness?: unknown })
      .authorityContinuityReadiness;
    if (
      readiness === null
      || typeof readiness !== "object"
      || isRejectedProxy(readiness)
      || (readiness as { status?: unknown }).status !== "ready"
    ) return null;
  } catch {
    return null;
  }
  return Object.freeze({
    receiver: value,
    handle,
  });
}

/**
 * The Core must exist before its exact live fence can open the credential
 * owner. This bridge remains dormant until that owner is ready and is sealed
 * before either rollback or normal close can begin.
 */
class DormantRelayV2BrokerAuthControlAuthority
implements RelayV2BrokerAuthControlAuthority {
  private installed: CapturedCredentialAuthority | null = null;
  private phase: "dormant" | "bound" | "sealed" = "dormant";
  private readonly active = new Set<Promise<unknown>>();
  private drainBarrier: Promise<void> | null = null;

  bind(authority: CapturedCredentialAuthority): void {
    if (this.phase !== "dormant" || this.installed !== null) {
      throw new Error("Relay v2 Broker credential bridge is not dormant");
    }
    this.installed = authority;
    this.phase = "bound";
  }

  handle(request: RelayV2AuthControlRequest): Promise<RelayV2AuthControlDecision> {
    const installed = this.installed;
    if (this.phase !== "bound" || installed === null) {
      throw new Error("Relay v2 Broker credential authority is unavailable");
    }
    let result: RelayV2AuthControlDecision | Promise<RelayV2AuthControlDecision>;
    try {
      result = Reflect.apply(installed.handle, installed.receiver, [request]) as (
        RelayV2AuthControlDecision | Promise<RelayV2AuthControlDecision>
      );
    } catch (error) {
      result = Promise.reject(error);
    }
    const task = Promise.resolve(result);
    this.active.add(task);
    void task.then(
      () => { this.active.delete(task); },
      () => { this.active.delete(task); },
    );
    return task;
  }

  seal(): void {
    if (this.phase === "sealed") return;
    this.phase = "sealed";
  }

  drain(): Promise<void> {
    this.seal();
    if (this.drainBarrier) return this.drainBarrier;
    this.drainBarrier = Promise.allSettled([...this.active]).then(() => undefined);
    return this.drainBarrier;
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

function relayV2HostProducerAction(action: RelayV2BrokerAction): boolean {
  return action.kind === "host_output_ready"
    || action.kind === "send_host"
    || action.kind === "close_host"
    || action.kind === "pause_host_route"
    || action.kind === "resume_host_route";
}

interface RelayV2BrokerHostWssOwnerSession {
  readonly transportId: string;
  readonly connectionIncarnation: string;
  readonly producerGeneration: string;
  attach(authContext: RelayV2BrokerConnectionAuthorization): void;
  registerExpiry(): void;
  receiveHostFrame(bytes: Uint8Array, signal: AbortSignal): Promise<RelayV2BrokerProducerReceipt>;
  drainHostCarrier(options: Readonly<{
    maxFrames: number;
    maxBytes: number;
    controlOnly?: boolean;
  }>): readonly import("./brokerCore.js").RelayV2CarrierDelivery[];
  acknowledgeHostControlDelivery(deliveryId: string): RelayV2BrokerProducerReceipt;
  rejectHostControlDelivery(deliveryId: string): RelayV2BrokerProducerReceipt;
  acknowledgeHostDelivery(deliveryId: string): RelayV2BrokerProducerReceipt;
  disconnectHost(): RelayV2BrokerProducerReceipt;
  beginProducerClose(barrier: Promise<unknown>): void;
  terminalAndUnregister(): Promise<void>;
  rollbackConstruction(): Promise<void>;
}

class RelayV2BrokerHostWssOwnerSessionImpl
implements RelayV2BrokerHostWssOwnerSession {
  readonly transportId: string;
  readonly connectionIncarnation: string;
  readonly producerGeneration: string;

  private expiry: RelayV2BrokerAuthorizationExpiryDeadlineRegistration | null = null;
  private attached = false;
  private disconnected = false;
  private producerClosing = false;
  private terminalCleaned = false;
  private closeUnregistered = false;
  private terminalCleanup: Promise<void> | null = null;

  constructor(
    private readonly broker: RelayV2BrokerCore,
    private readonly transport: RelayV2BrokerManagedClientSocketTransport,
    private readonly expiryOwner: RelayV2BrokerAuthorizationExpiryDeadlineOwner,
    private readonly closeRegistration: RelayV2BrokerTransportSocketRegistration,
    private readonly producerRegistration: RelayV2BrokerProducerRegistration,
  ) {
    this.transportId = producerRegistration.target.transportId;
    this.connectionIncarnation = closeRegistration.connectionIncarnation;
    this.producerGeneration = producerRegistration.target.generation;
  }

  attach(authContext: RelayV2BrokerConnectionAuthorization): void {
    if (this.attached || this.disconnected || this.producerClosing) {
      throw new Error("Relay v2 Broker Host WSS owner session cannot attach");
    }
    this.broker.attachHostCarrier(
      this.transportId,
      authContext,
      this.connectionIncarnation,
    );
    this.attached = true;
  }

  registerExpiry(): void {
    if (!this.attached || this.expiry || this.disconnected) {
      throw new Error("Relay v2 Broker Host WSS expiry cannot register");
    }
    this.expiry = this.expiryOwner.register(
      "host",
      this.transportId,
      this.connectionIncarnation,
    );
  }

  async receiveHostFrame(
    bytes: Uint8Array,
    signal: AbortSignal,
  ): Promise<RelayV2BrokerProducerReceipt> {
    if (!this.attached || this.disconnected || this.terminalCleaned) return "rejected";
    let prepared: RelayV2BrokerPreparedCall;
    try {
      prepared = this.producerRegistration.prepareBrokerCall();
    } catch {
      return "rejected";
    }
    let result: RelayV2BrokerResult;
    try {
      result = await this.broker.receiveHostFrame(this.transportId, bytes, signal);
    } catch (error) {
      prepared.abandon();
      throw error;
    }
    return prepared.settle(result, (settled, handoff) => (
      this.settleBrokerResult(settled, handoff)
    ));
  }

  drainHostCarrier(options: Readonly<{
    maxFrames: number;
    maxBytes: number;
    controlOnly?: boolean;
  }>): readonly import("./brokerCore.js").RelayV2CarrierDelivery[] {
    if (!this.attached || this.disconnected || this.terminalCleaned) return [];
    return this.broker.drainHostCarrier(this.transportId, options);
  }

  acknowledgeHostControlDelivery(deliveryId: string): RelayV2BrokerProducerReceipt {
    return this.runBrokerCall(() => (
      this.broker.acknowledgeHostControlDelivery(this.transportId, deliveryId)
    ));
  }

  rejectHostControlDelivery(deliveryId: string): RelayV2BrokerProducerReceipt {
    return this.runBrokerCall(() => (
      this.broker.rejectHostControlDelivery(this.transportId, deliveryId)
    ));
  }

  acknowledgeHostDelivery(deliveryId: string): RelayV2BrokerProducerReceipt {
    return this.runBrokerCall(() => (
      this.broker.acknowledgeHostDelivery(this.transportId, deliveryId)
    ));
  }

  disconnectHost(): RelayV2BrokerProducerReceipt {
    if (this.disconnected) return "applied";
    this.disconnected = true;
    if (!this.attached) return "applied";
    return this.runBrokerCall(() => this.broker.disconnectHost(this.transportId), true);
  }

  beginProducerClose(barrier: Promise<unknown>): void {
    if (this.producerClosing) return;
    this.producerClosing = true;
    this.producerRegistration.beginClose(barrier);
  }

  terminalAndUnregister(): Promise<void> {
    if (this.terminalCleanup) return this.terminalCleanup;
    this.terminalCleaned = true;
    this.terminalCleanup = this.cleanupOwnerRegistrations();
    void this.terminalCleanup.catch(() => {});
    return this.terminalCleanup;
  }

  rollbackConstruction(): Promise<void> {
    if (!this.producerClosing) {
      this.producerClosing = true;
      this.producerRegistration.beginClose(Promise.resolve());
    }
    if (!this.disconnected) this.disconnectHost();
    this.terminalCleaned = true;
    return this.cleanupOwnerRegistrations();
  }

  private async cleanupOwnerRegistrations(): Promise<void> {
    const failures: unknown[] = [];
    if (this.expiry) {
      try {
        await this.expiry.unregister();
        this.expiry = null;
      } catch (error) {
        failures.push(error);
      }
    }
    if (!this.closeUnregistered) {
      try {
        this.closeRegistration.unregister();
        this.closeUnregistered = true;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Relay v2 Broker Host WSS owner cleanup failed");
    }
  }

  private runBrokerCall(
    invoke: () => RelayV2BrokerResult,
    allowDisconnected = false,
  ): RelayV2BrokerProducerReceipt {
    if (
      !this.attached
      || this.terminalCleaned
      || (this.disconnected && !allowDisconnected)
    ) return "rejected";
    try {
      return this.producerRegistration.runBrokerCall(
        invoke,
        (result, handoff) => this.settleBrokerResult(result, handoff),
      );
    } catch {
      return "rejected";
    }
  }

  private settleBrokerResult(
    result: RelayV2BrokerResult,
    handoff: RelayV2BrokerProducerHandoff,
  ): RelayV2BrokerProducerReceipt {
    let receipt: RelayV2BrokerProducerReceipt = "applied";
    const hostGroups = new Map<
      string,
      {
        target: RelayV2BrokerProducerTarget;
        actions: Array<Extract<RelayV2BrokerAction, { transportId: string }>>;
      }
    >();
    for (const action of result.actions) {
      if (!relayV2HostProducerAction(action)) {
        if (this.transport.applyBrokerAction(action) !== "applied") receipt = "rejected";
        continue;
      }
      const resolution = handoff.resolveHostActionTarget(action);
      if (resolution.status !== "resolved") {
        receipt = "rejected";
        continue;
      }
      const key = `${resolution.target.transportId}\0${resolution.target.generation}`;
      const group = hostGroups.get(key) ?? {
        target: resolution.target,
        actions: [],
      };
      group.actions.push(action as Extract<RelayV2BrokerAction, { transportId: string }>);
      hostGroups.set(key, group);
    }
    for (const group of hostGroups.values()) {
      if (handoff.apply(group.target, group.actions) !== "applied") {
        handoff.forceTerminal({
          kind: "target_failure",
          target: group.target,
          reason: "host_wss_broker_action_rejected",
        });
        receipt = "rejected";
      }
    }
    return receipt;
  }
}

class RelayV2BrokerClientWssRuntimeCompositionImpl
implements RelayV2BrokerClientWssRuntimeComposition {
  readonly hostPumpBrokerAuthority: RelayV2CarrierPumpBrokerPort;

  private readonly broker: RelayV2BrokerCore;
  private readonly transport: RelayV2BrokerManagedClientSocketTransport;
  private readonly producerRegistry: RelayV2BrokerProducerRegistry;
  private readonly closeCoordinator: RelayV2BrokerTransportCloseCoordinator;
  private readonly expiryOwner: RelayV2BrokerAuthorizationExpiryDeadlineOwner;
  private readonly hostWssOwnerBinding: RelayV2BrokerHostWssRuntimeOwnerBinding;
  private hostWssRuntime: RelayV2BrokerHostWssRuntimeFacade | null = null;
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
    this.producerRegistry = options.producerRegistry;
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
    this.hostWssOwnerBinding = Object.freeze({
      credentialAdmissionOpen: (): boolean => this.credentialAdmissionOpen(),
      createSession: (input: Readonly<{
        producerPort: RelayV2BrokerProducerPort;
        close(code: number, reason: string): unknown;
        forceDestroy(): unknown;
      }>): RelayV2BrokerHostWssOwnerSession => {
        const transportId = randomUUID();
        let closeRegistration: RelayV2BrokerTransportSocketRegistration | null = null;
        let producerRegistration: RelayV2BrokerProducerRegistration | null = null;
        try {
          closeRegistration = this.closeCoordinator.registerSocket({
            connectionKind: "host",
            transportId,
            close: (code, reason) => input.close(code, reason),
            forceDestroy: () => input.forceDestroy(),
          });
          producerRegistration = this.producerRegistry.registerHostProducer(
            transportId,
            input.producerPort,
          );
          producerRegistration.bindConnectionIncarnation(
            closeRegistration.connectionIncarnation,
          );
        } catch (error) {
          if (producerRegistration) {
            try { producerRegistration.beginClose(Promise.resolve()); } catch {}
          }
          try { closeRegistration?.unregister(); } catch {}
          try { input.forceDestroy(); } catch {}
          throw error;
        }
        if (!closeRegistration || !producerRegistration) {
          if (producerRegistration) {
            try { producerRegistration.beginClose(Promise.resolve()); } catch {}
          }
          try { closeRegistration?.unregister(); } catch {}
          try { input.forceDestroy(); } catch {}
          throw new Error("Relay v2 Broker Host WSS owner session did not open");
        }
        return new RelayV2BrokerHostWssOwnerSessionImpl(
          this.broker,
          this.transport,
          this.expiryOwner,
          closeRegistration,
          producerRegistration,
        );
      },
    });
  }

  installHostWssRuntime(
    trustedSocketPrototype: object,
    trustedSocketBrand: RelayV2BrokerHostWssTrustedSocketBrand,
  ): RelayV2BrokerHostWssRuntimeFacade {
    if (this.hostWssRuntime || this.closeDrain) {
      throw new Error("Relay v2 Broker Host WSS runtime was already installed or closed");
    }
    const runtime = bindRelayV2BrokerHostWssRuntimeFacade(
      this.hostWssOwnerBinding,
      trustedSocketPrototype,
      trustedSocketBrand,
    );
    this.hostWssRuntime = runtime;
    return runtime;
  }

  credentialActivationFence(): RelayV2LiveAuthorizationFencePort {
    return this.broker.liveAuthorizationFencePort;
  }

  private credentialAdmissionOpen(): boolean {
    return this.broker.inspectLiveAuthCompositionLatch() === "open"
      && this.broker.outputReadyCompositionState === "open";
  }

  credentialActivationPublishable(): boolean {
    return this.clientAdmissionOpen
      && this.clientEffectsOpen
      && this.closeDrain === null
      && this.credentialAdmissionOpen();
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
    let resolveClose!: () => void;
    let rejectClose!: (error: unknown) => void;
    const published = new Promise<void>((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });
    void published.catch(() => {});
    this.closeDrain = published;
    this.sealClientAdmission();
    this.clientEffectsOpen = false;
    const hostWssClosed = this.hostWssRuntime
      ? observeBarrier(() => this.hostWssRuntime!.closeAndDrain())
      : Promise.resolve();
    const failClosed = observeBarrier(() => this.serialize(() => {
      this.broker.liveAuthorizationFencePort.failClosed();
    }));
    const expiryClosed = observeBarrier(() => this.expiryOwner.close());
    const pending = [...this.pendingAttaches].map((attach) => attach.promise);
    void (async () => {
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
      await settle([hostWssClosed, failClosed, expiryClosed]);
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
    })().then(resolveClose, rejectClose);
    return published;
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

const HOST_WSS_RUNTIME_INSTALLATIONS = new WeakMap<
  object,
  {
    claimed: boolean;
    install(
      trustedSocketPrototype: object,
      trustedSocketBrand: RelayV2BrokerHostWssTrustedSocketBrand,
    ): RelayV2BrokerHostWssRuntimeFacade;
  }
>();

/** One-shot safe facade installation; no Core/registry/close seam is returned. */
export function installRelayV2BrokerHostWssRuntime(
  runtime: RelayV2BrokerClientWssRuntimeComposition,
  trustedSocketPrototype: object,
  trustedSocketBrand: RelayV2BrokerHostWssTrustedSocketBrand,
): RelayV2BrokerHostWssRuntimeFacade {
  if (runtime === null || typeof runtime !== "object" || isRejectedProxy(runtime)) {
    throw new Error("invalid Relay v2 Broker Host WSS runtime installation");
  }
  const state = HOST_WSS_RUNTIME_INSTALLATIONS.get(runtime);
  if (!state || state.claimed) {
    throw new Error("Relay v2 Broker Host WSS runtime was already installed");
  }
  state.claimed = true;
  return state.install(trustedSocketPrototype, trustedSocketBrand);
}

function createRelayV2BrokerClientWssRuntimeFacade(
  owner: RelayV2BrokerClientWssRuntimeCompositionImpl,
  closeAndDrain: () => Promise<void>,
): RelayV2BrokerClientWssRuntimeComposition {
  const sealClientAdmission = () => owner.sealClientAdmission();
  const facade = Object.freeze({
    hostPumpBrokerAuthority: owner.hostPumpBrokerAuthority,
    sealClientAdmission,
    prepareClientWss: (input: RelayV2BrokerClientWssPrepareInput) => (
      owner.prepareClientWss(input)
    ),
    attachPreparedClientWss: (input: RelayV2BrokerClientWssAttachPreparedInput) => (
      owner.attachPreparedClientWss(input)
    ),
    applyBrokerAction: (action: RelayV2BrokerAction) => owner.applyBrokerAction(action),
    closeAndDrain,
  });
  HOST_WSS_RUNTIME_INSTALLATIONS.set(facade, {
    claimed: false,
    install: (trustedSocketPrototype, trustedSocketBrand) => owner.installHostWssRuntime(
      trustedSocketPrototype,
      trustedSocketBrand,
    ),
  });
  return facade;
}

class RelayV2BrokerActivatedCredentialRuntimeCloseOwner {
  private closeDrain: Promise<void> | null = null;
  private authorityCloseOwner: CredentialAuthorityCloseOwner | null = null;
  private authorityCloseOwnerInstalled = false;

  constructor(
    private readonly runtimeOwner: RelayV2BrokerClientWssRuntimeCompositionImpl,
    private readonly bridge: DormantRelayV2BrokerAuthControlAuthority,
  ) {}

  installAuthorityCloseOwner(
    authorityCloseOwner: CredentialAuthorityCloseOwner | null,
  ): void {
    if (this.authorityCloseOwnerInstalled || this.closeDrain !== null) {
      throw new Error("Relay v2 Broker credential authority close owner is already installed");
    }
    this.authorityCloseOwner = authorityCloseOwner;
    this.authorityCloseOwnerInstalled = true;
  }

  closeAndDrain(): Promise<void> {
    if (this.closeDrain) return this.closeDrain;
    if (!this.authorityCloseOwnerInstalled) {
      this.authorityCloseOwnerInstalled = true;
    }
    const published = deferred();
    this.closeDrain = published.promise;

    // Both public admission and the private auth-control handoff are fenced in
    // this turn, before Core close signals can invoke an external socket owner.
    this.bridge.seal();
    this.runtimeOwner.sealClientAdmission();
    void this.finishCloseAndDrain().then(published.resolve, published.reject);
    return published.promise;
  }

  private async finishCloseAndDrain(): Promise<void> {
    const failures: unknown[] = [];
    const settle = async (barrier: Promise<unknown>): Promise<void> => {
      try {
        await barrier;
      } catch (error) {
        failures.push(error);
      }
    };

    let runtimeBarrier: Promise<void>;
    try {
      runtimeBarrier = this.runtimeOwner.closeAndDrain();
    } catch (error) {
      runtimeBarrier = Promise.reject(error);
    }
    await settle(runtimeBarrier);
    await settle(this.bridge.drain());
    if (this.authorityCloseOwner) {
      await settle(this.authorityCloseOwner.close());
    }

    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "Relay v2 Broker activated credential runtime close failed",
      );
    }
  }
}

async function rollbackRelayV2BrokerClientWssRuntimeActivation(
  closeOwner: RelayV2BrokerActivatedCredentialRuntimeCloseOwner,
  activationFailure: unknown,
): Promise<never> {
  try {
    await closeOwner.closeAndDrain();
  } catch (cleanupFailure) {
    throw new AggregateError(
      [activationFailure, cleanupFailure],
      "Relay v2 Broker credential activation rollback failed",
    );
  }
  throw activationFailure;
}

/**
 * Default-off only: this creates no listener, credential authority, E0 store,
 * process, retry owner, capability advertisement, or protocol fallback.
 */
export function createRelayV2BrokerClientWssRuntimeComposition(
  options: RelayV2BrokerClientWssRuntimeCompositionOptions,
): RelayV2BrokerClientWssRuntimeComposition {
  const owner = new RelayV2BrokerClientWssRuntimeCompositionImpl(options);
  return createRelayV2BrokerClientWssRuntimeFacade(
    owner,
    () => owner.closeAndDrain(),
  );
}

/**
 * Default-off, listener-free one-shot credential activation. The existing
 * registry/output-ready/Core/client owner is constructed exactly once. Only
 * that Core's live-authorization fence crosses into the opener; no runtime is
 * published until the returned authority is ready and bound to the dormant
 * auth-control bridge.
 */
export async function activateRelayV2BrokerClientWssRuntimeComposition<
  Authority extends RelayV2BrokerActivatedCredentialAuthority,
>(
  options: RelayV2BrokerClientWssRuntimeActivationOptions<Authority>,
): Promise<RelayV2BrokerClientWssRuntimeActivation> {
  if (
    options === null
    || typeof options !== "object"
    || isRejectedProxy(options)
  ) throw new Error("invalid Relay v2 Broker credential activation options");

  let openCredentialAuthority: Function;
  let runtimeOptions: Omit<
    RelayV2BrokerClientWssRuntimeCompositionOptions,
    "brokerOptions"
  > & { brokerOptions?: RelayV2BrokerClientWssRuntimeCompositionOptions["brokerOptions"] };
  try {
    openCredentialAuthority = options.openCredentialAuthority;
    if (typeof openCredentialAuthority !== "function") {
      throw new Error("invalid credential authority opener");
    }
    const brokerOptions = options.brokerOptions;
    if (brokerOptions && Object.hasOwn(brokerOptions, "authControlAuthority")) {
      throw new Error("credential auth-control authority must be activation-owned");
    }
    runtimeOptions = {
      producerRegistry: options.producerRegistry,
      resolveHostProducerBinding: options.resolveHostProducerBinding,
      clientSocketScheduler: options.clientSocketScheduler,
      deliveryTimeoutMs: options.deliveryTimeoutMs,
      closeTimeoutMs: options.closeTimeoutMs,
      authorizationExpiryScheduleAt: options.authorizationExpiryScheduleAt,
      transportCloseDeadlineScheduler: options.transportCloseDeadlineScheduler,
      brokerOptions: {
        ...brokerOptions,
      },
    };
  } catch {
    throw new Error("invalid Relay v2 Broker credential activation options");
  }

  const bridge = new DormantRelayV2BrokerAuthControlAuthority();
  const owner = new RelayV2BrokerClientWssRuntimeCompositionImpl({
    ...runtimeOptions,
    brokerOptions: {
      ...runtimeOptions.brokerOptions,
      authControlAuthority: bridge,
    },
  });
  const closeOwner = new RelayV2BrokerActivatedCredentialRuntimeCloseOwner(
    owner,
    bridge,
  );
  try {
    const openerInput = Object.freeze({
      liveAuthorizationFence: owner.credentialActivationFence(),
    });
    const opened = await Reflect.apply(openCredentialAuthority, undefined, [openerInput]);
    const authorityCloseOwner = captureCredentialAuthorityCloseOwner(opened);
    closeOwner.installAuthorityCloseOwner(authorityCloseOwner);
    const authority = captureReadyCredentialAuthority(opened);
    if (!authorityCloseOwner || !authority || !owner.credentialActivationPublishable()) {
      throw new Error("Relay v2 Broker credential authority is not ready");
    }
    bridge.bind(authority);
    if (!owner.credentialActivationPublishable()) {
      throw new Error("Relay v2 Broker credential activation crossed a fail-closed cut");
    }

    const runtime = createRelayV2BrokerClientWssRuntimeFacade(
      owner,
      () => closeOwner.closeAndDrain(),
    );
    return Object.freeze({ runtime });
  } catch (error) {
    return await rollbackRelayV2BrokerClientWssRuntimeActivation(
      closeOwner,
      error,
    );
  }
}
