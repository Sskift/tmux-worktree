import { types as nodeTypes } from "node:util";
import {
  RelayV2HostCarrierActor,
  type RelayV2HostCarrierConnection,
  type RelayV2HostCarrierStatus,
  type RelayV2HostCarrierTransport,
} from "./hostCarrier.js";
import type {
  RelayV2HostConnectorAttemptDrainEvidence,
  RelayV2HostConnectorAttemptDrainInput,
  RelayV2HostConnectorAttemptFactoryPort,
  RelayV2HostConnectorAttemptPort,
  RelayV2HostConnectorAttemptStartInput,
} from "./hostConnectorController.js";
import {
  RELAY_V2_HOST_CREDENTIAL_REFERENCE_NAMESPACE,
} from "./hostCredentialAuthority.js";
import { isRelayV2AuthIdentifier } from "./token.js";

const MAX_COUNTER = 18_446_744_073_709_551_615n;
const MAX_IDENTIFIER_BYTES = 128;
const drainHandleAdapterKey = Object.freeze({});
const nativePromiseThen = Promise.prototype.then;

type MaybePromise<T> = T | Promise<T>;
type DataRecord = Record<string, unknown>;

export interface RelayV2HostConnectorCarrierAttemptFactoryInput
extends RelayV2HostConnectorAttemptStartInput {}

export interface RelayV2HostConnectorCarrierAttemptFactoryResult {
  readonly actor: RelayV2HostCarrierActor;
  readonly transport: RelayV2HostCarrierTransport;
  readonly drainHandle: RelayV2HostConnectorCarrierAttemptDrainHandle;
}

export interface RelayV2HostConnectorCarrierAttemptFactoryPort {
  createAttempt(
    input: Readonly<RelayV2HostConnectorCarrierAttemptFactoryInput>,
  ): MaybePromise<RelayV2HostConnectorCarrierAttemptFactoryResult>;
}

export interface RelayV2HostConnectorCarrierAttemptDrainHandleOptions {
  readonly transport: RelayV2HostCarrierTransport;
  /** Installs the actor-created callbacks into this exact transport lifecycle. */
  readonly bindConnection: (connection: RelayV2HostCarrierConnection) => void;
  /** Resolves with the exact supplied proof only after the transport is drained. */
  readonly awaitDrained: (proof: object) => Promise<object>;
}

export interface RelayV2HostConnectorCarrierAttemptAdapterOptions {
  readonly factory: RelayV2HostConnectorCarrierAttemptFactoryPort;
}

interface CapturedFactory {
  readonly receiver: object;
  readonly createAttempt: RelayV2HostConnectorCarrierAttemptFactoryPort["createAttempt"];
}

interface CapturedTransport {
  readonly receiver: object;
  readonly trySend: RelayV2HostCarrierTransport["trySend"];
  readonly bufferedAmount: RelayV2HostCarrierTransport["bufferedAmount"];
  readonly close: RelayV2HostCarrierTransport["close"];
}

interface TransportGate {
  readonly facade: RelayV2HostCarrierTransport;
  close(code: number, reason: string): void;
  failed(): boolean;
}

interface CallbackFence {
  readonly callback: (status: Readonly<RelayV2HostCarrierStatus>) => void;
  attach(actor: RelayV2HostCarrierActor): void;
  fence(): void;
  failed(): boolean;
}

function failure(): RelayV2HostConnectorCarrierAttemptAdapterError {
  return new RelayV2HostConnectorCarrierAttemptAdapterError();
}

function isObject(value: unknown): value is DataRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExactNativePromise(value: unknown): value is Promise<unknown> {
  if (!nodeTypes.isPromise(value) || nodeTypes.isProxy(value)) return false;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.getPrototypeOf(value) === Promise.prototype
      && !Object.hasOwn(descriptors, "then")
      && !Object.hasOwn(descriptors, "constructor");
  } catch {
    return false;
  }
}

function ignorePromiseRejection(promise: Promise<unknown>): void {
  Reflect.apply(nativePromiseThen, promise, [undefined, () => undefined]);
}

function exactDataObject(value: unknown, expected: readonly string[]): DataRecord {
  if (!isObject(value) || nodeTypes.isProxy(value)) throw failure();
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw failure();
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.length
    || keys.some((key) => typeof key !== "string" || !expected.includes(key))
    || expected.some((key) => {
      const descriptor = descriptors[key];
      return !descriptor || !Object.hasOwn(descriptor, "value");
    })) throw failure();
  return Object.fromEntries(expected.map((key) => [key, descriptors[key].value]));
}

function captureMethod(value: unknown, name: string): Function {
  if (!isObject(value) || nodeTypes.isProxy(value)) throw failure();
  let owner: object | null = value;
  while (owner !== null) {
    if (nodeTypes.isProxy(owner)) throw failure();
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(owner, name);
    } catch {
      throw failure();
    }
    if (descriptor !== undefined) {
      if (!Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
        throw failure();
      }
      return descriptor.value;
    }
    try {
      owner = Object.getPrototypeOf(owner);
    } catch {
      throw failure();
    }
  }
  throw failure();
}

function identifier(value: unknown): string {
  if (!isRelayV2AuthIdentifier(value)
    || Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES
    || /(?:twcap2|twref2|twenroll2|twhostboot2)\./i.test(value)) throw failure();
  return value;
}

function credentialReference(value: unknown): string {
  const reference = identifier(value);
  if (!reference.startsWith(RELAY_V2_HOST_CREDENTIAL_REFERENCE_NAMESPACE)
    || reference.length === RELAY_V2_HOST_CREDENTIAL_REFERENCE_NAMESPACE.length) throw failure();
  return reference;
}

function counter(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) throw failure();
  try {
    if (BigInt(value) > MAX_COUNTER) throw failure();
  } catch (error) {
    if (error instanceof RelayV2HostConnectorCarrierAttemptAdapterError) throw error;
    throw failure();
  }
  return value;
}

function captureFactory(value: unknown): CapturedFactory {
  if (!isObject(value)) throw failure();
  const createAttempt = captureMethod(value, "createAttempt");
  return Object.freeze({
    receiver: value,
    createAttempt: createAttempt as RelayV2HostConnectorCarrierAttemptFactoryPort["createAttempt"],
  });
}

function captureTransport(value: unknown): CapturedTransport {
  if (!isObject(value)) throw failure();
  return Object.freeze({
    receiver: value,
    trySend: captureMethod(value, "trySend") as RelayV2HostCarrierTransport["trySend"],
    bufferedAmount: captureMethod(
      value,
      "bufferedAmount",
    ) as RelayV2HostCarrierTransport["bufferedAmount"],
    close: captureMethod(value, "close") as RelayV2HostCarrierTransport["close"],
  });
}

function createTransportGate(transport: CapturedTransport): TransportGate {
  let closed = false;
  let closeFailed = false;
  const close = (code: number, reason: string): void => {
    if (closed) return;
    closed = true;
    try {
      Reflect.apply(transport.close, transport.receiver, [code, reason]);
    } catch {
      closeFailed = true;
    }
  };
  const facade: RelayV2HostCarrierTransport = Object.freeze({
    trySend(frame: Uint8Array, deliveryToken: string): boolean {
      if (closed) return false;
      const accepted = Reflect.apply(transport.trySend, transport.receiver, [frame, deliveryToken]);
      if (typeof accepted !== "boolean") throw failure();
      return accepted;
    },
    bufferedAmount(): number {
      const amount = Reflect.apply(transport.bufferedAmount, transport.receiver, []);
      if (!Number.isSafeInteger(amount) || amount < 0) throw failure();
      return amount;
    },
    close,
  });
  return Object.freeze({
    facade,
    close,
    failed: () => closeFailed,
  });
}

function captureStatus(value: unknown): DataRecord | null {
  if (!isObject(value) || nodeTypes.isProxy(value)) return null;
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== "string")) return null;
  const record: DataRecord = {};
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, "value")) return null;
    record[key] = descriptor.value;
  }
  return record;
}

function sameStatus(left: unknown, right: unknown): boolean {
  const a = captureStatus(left);
  const b = captureStatus(right);
  if (!a || !b) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return aKeys.length === bKeys.length
    && aKeys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
}

function createCallbackFence(
  forward: (status: Readonly<RelayV2HostCarrierStatus>) => void,
): CallbackFence {
  let active = true;
  let actor: RelayV2HostCarrierActor | null = null;
  let callbackBeforeCapture = false;
  let callbackFailed = false;
  const callback = (status: Readonly<RelayV2HostCarrierStatus>): void => {
    if (!active) return;
    if (actor === null) {
      callbackBeforeCapture = true;
      return;
    }
    let canonicalStatus: RelayV2HostCarrierStatus | null;
    try {
      canonicalStatus = Reflect.apply(RelayV2HostCarrierActor.prototype.status, actor, []);
    } catch {
      callbackFailed = true;
      return;
    }
    if (!sameStatus(status, canonicalStatus)) {
      callbackFailed = true;
      return;
    }
    try {
      forward(status);
    } catch {
      callbackFailed = true;
    }
  };
  return Object.freeze({
    callback,
    attach(value: RelayV2HostCarrierActor): void {
      if (actor !== null || callbackBeforeCapture) throw failure();
      actor = value;
    },
    fence(): void { active = false; },
    failed: () => callbackBeforeCapture || callbackFailed,
  });
}

function drainInput(value: unknown): RelayV2HostConnectorAttemptDrainInput {
  const fields = exactDataObject(value, [
    "controllerGeneration", "carrierGeneration", "connectorId",
  ]);
  const controllerGeneration = counter(fields.controllerGeneration);
  const generation = fields.carrierGeneration;
  if (generation !== null
    && (!Number.isSafeInteger(generation) || (generation as number) <= 0)) throw failure();
  const connectorId = fields.connectorId === null ? null : identifier(fields.connectorId);
  return Object.freeze({
    controllerGeneration,
    carrierGeneration: generation as number | null,
    connectorId,
  });
}

/**
 * Opaque, exact-transport drain authority. The adapter can consume it, but
 * ordinary property reflection cannot recover its transport, callbacks, or
 * proof state.
 */
export class RelayV2HostConnectorCarrierAttemptDrainHandle {
  readonly #transport: RelayV2HostCarrierTransport;
  readonly #bindConnection: (connection: RelayV2HostCarrierConnection) => void;
  readonly #awaitDrained: (proof: object) => Promise<object>;
  #bound = false;
  #drainPromise: Promise<void> | null = null;

  constructor(options: RelayV2HostConnectorCarrierAttemptDrainHandleOptions) {
    const fields = exactDataObject(options, ["transport", "bindConnection", "awaitDrained"]);
    if (!isObject(fields.transport)
      || typeof fields.bindConnection !== "function"
      || typeof fields.awaitDrained !== "function") throw failure();
    this.#transport = fields.transport as RelayV2HostCarrierTransport;
    this.#bindConnection = fields.bindConnection as (connection: RelayV2HostCarrierConnection) => void;
    this.#awaitDrained = fields.awaitDrained as (proof: object) => Promise<object>;
  }

  static matches(
    adapterKey: unknown,
    value: unknown,
    transport: RelayV2HostCarrierTransport,
  ): value is RelayV2HostConnectorCarrierAttemptDrainHandle {
    if (adapterKey !== drainHandleAdapterKey) return false;
    if (typeof value !== "object" || value === null) return false;
    try {
      return Object.getPrototypeOf(value)
          === RelayV2HostConnectorCarrierAttemptDrainHandle.prototype
        && (value as RelayV2HostConnectorCarrierAttemptDrainHandle).#transport === transport;
    } catch {
      return false;
    }
  }

  static bind(
    adapterKey: unknown,
    handle: RelayV2HostConnectorCarrierAttemptDrainHandle,
    transport: RelayV2HostCarrierTransport,
    connection: RelayV2HostCarrierConnection,
  ): void {
    if (!this.matches(adapterKey, handle, transport)
      || handle.#bound
      || handle.#drainPromise !== null) {
      throw failure();
    }
    handle.#bound = true;
    const result = Reflect.apply(handle.#bindConnection, undefined, [connection]);
    if (result !== undefined) throw failure();
  }

  static drain(
    adapterKey: unknown,
    handle: RelayV2HostConnectorCarrierAttemptDrainHandle,
    transport: RelayV2HostCarrierTransport,
  ): Promise<void> {
    if (!this.matches(adapterKey, handle, transport)) {
      return Promise.reject(failure());
    }
    if (handle.#drainPromise !== null) return handle.#drainPromise;
    const proof = Object.freeze(Object.create(null) as object);
    let result: unknown;
    try {
      result = Reflect.apply(handle.#awaitDrained, undefined, [proof]);
    } catch {
      handle.#drainPromise = Promise.reject(failure());
      ignorePromiseRejection(handle.#drainPromise);
      return handle.#drainPromise;
    }
    if (!isExactNativePromise(result)) {
      handle.#drainPromise = Promise.reject(failure());
      ignorePromiseRejection(handle.#drainPromise);
      return handle.#drainPromise;
    }
    handle.#drainPromise = Reflect.apply(nativePromiseThen, result, [
      (returnedProof: unknown) => {
        if (returnedProof !== proof) throw failure();
      },
      () => { throw failure(); },
    ]) as Promise<void>;
    ignorePromiseRejection(handle.#drainPromise);
    return handle.#drainPromise;
  }
}

export class RelayV2HostConnectorCarrierAttemptAdapterError extends Error {
  constructor() {
    super("Relay v2 host connector carrier attempt failed");
    this.name = "RelayV2HostConnectorCarrierAttemptAdapterError";
  }
}

class CanonicalAttempt implements RelayV2HostConnectorAttemptPort {
  readonly #controllerGeneration: string;
  readonly #carrierGeneration: number;
  readonly #actor: RelayV2HostCarrierActor;
  readonly #transport: RelayV2HostCarrierTransport;
  readonly #gate: TransportGate;
  readonly #drainHandle: RelayV2HostConnectorCarrierAttemptDrainHandle;
  readonly #fence: CallbackFence;
  #disposePromise: Promise<RelayV2HostConnectorAttemptDrainEvidence> | null = null;

  constructor(input: Readonly<{
    controllerGeneration: string;
    carrierGeneration: number;
    actor: RelayV2HostCarrierActor;
    transport: RelayV2HostCarrierTransport;
    gate: TransportGate;
    drainHandle: RelayV2HostConnectorCarrierAttemptDrainHandle;
    fence: CallbackFence;
  }>) {
    this.#controllerGeneration = input.controllerGeneration;
    this.#carrierGeneration = input.carrierGeneration;
    this.#actor = input.actor;
    this.#transport = input.transport;
    this.#gate = input.gate;
    this.#drainHandle = input.drainHandle;
    this.#fence = input.fence;
  }

  readonly disposeAndDrain = (
    rawInput: Readonly<RelayV2HostConnectorAttemptDrainInput>,
  ): Promise<RelayV2HostConnectorAttemptDrainEvidence> => {
    if (this.#disposePromise !== null) return this.#disposePromise;

    // Fence before parsing caller data or invoking either lifecycle owner.
    this.#fence.fence();
    let parsed: RelayV2HostConnectorAttemptDrainInput | null = null;
    let invalid = false;
    try {
      parsed = drainInput(rawInput);
      if (parsed.controllerGeneration !== this.#controllerGeneration
        || (parsed.carrierGeneration !== null
          && parsed.carrierGeneration !== this.#carrierGeneration)) invalid = true;
    } catch {
      invalid = true;
    }

    try {
      Reflect.apply(RelayV2HostCarrierActor.prototype.dispose, this.#actor, []);
    } catch {
      invalid = true;
    }
    this.#gate.close(1000, "host_shutdown");
    const drain = RelayV2HostConnectorCarrierAttemptDrainHandle.drain(
      drainHandleAdapterKey,
      this.#drainHandle,
      this.#transport,
    );

    this.#disposePromise = drain.then(() => {
      if (invalid || this.#gate.failed() || parsed === null) throw failure();
      return Object.freeze({
        status: "closed_and_drained" as const,
        controllerGeneration: parsed.controllerGeneration,
        carrierGeneration: parsed.carrierGeneration,
        connectorId: parsed.connectorId,
      });
    }, () => {
      throw failure();
    });
    ignorePromiseRejection(this.#disposePromise);
    return this.#disposePromise;
  };
}

/**
 * Default-off adapter from the controller attempt port to one canonical
 * HostCarrier actor plus one injected transport lifecycle. It creates no
 * socket, credential, process, retry timer, readiness, or production wiring.
 */
export class RelayV2HostConnectorCarrierAttemptAdapter
implements RelayV2HostConnectorAttemptFactoryPort {
  readonly #factory: CapturedFactory;
  #lastControllerGeneration = 0n;

  constructor(options: RelayV2HostConnectorCarrierAttemptAdapterOptions) {
    const fields = exactDataObject(options, ["factory"]);
    this.#factory = captureFactory(fields.factory);
  }

  readonly startAttempt = async (
    rawInput: Readonly<RelayV2HostConnectorAttemptStartInput>,
  ): Promise<RelayV2HostConnectorAttemptPort> => {
    let fields: DataRecord;
    try {
      fields = exactDataObject(rawInput, [
        "requestId",
        "controllerGeneration",
        "hostId",
        "hostEpoch",
        "hostInstanceId",
        "credentialReference",
        "signal",
        "onCarrierStatus",
      ]);
    } catch {
      throw failure();
    }
    const requestId = identifier(fields.requestId);
    const controllerGeneration = counter(fields.controllerGeneration);
    const hostId = identifier(fields.hostId);
    const hostEpoch = identifier(fields.hostEpoch);
    const hostInstanceId = identifier(fields.hostInstanceId);
    const exactCredentialReference = credentialReference(fields.credentialReference);
    if (!(fields.signal instanceof AbortSignal) || typeof fields.onCarrierStatus !== "function") {
      throw failure();
    }
    const numericGeneration = BigInt(controllerGeneration);
    if (numericGeneration <= this.#lastControllerGeneration) throw failure();
    this.#lastControllerGeneration = numericGeneration;

    const forward = fields.onCarrierStatus as (
      status: Readonly<RelayV2HostCarrierStatus>,
    ) => void;
    const fence = createCallbackFence(forward);
    const factoryInput = Object.freeze({
      requestId,
      controllerGeneration,
      hostId,
      hostEpoch,
      hostInstanceId,
      credentialReference: exactCredentialReference,
      signal: fields.signal as AbortSignal,
      onCarrierStatus: fence.callback,
    });

    let actor: RelayV2HostCarrierActor | null = null;
    let transport: RelayV2HostCarrierTransport | null = null;
    let capturedTransport: CapturedTransport | null = null;
    let gate: TransportGate | null = null;
    let drainHandle: RelayV2HostConnectorCarrierAttemptDrainHandle | null = null;

    try {
      const pendingResult = Reflect.apply(
        this.#factory.createAttempt,
        this.#factory.receiver,
        [factoryInput],
      );
      const rawResult = isExactNativePromise(pendingResult)
        ? await pendingResult
        : pendingResult;
      const result = exactDataObject(rawResult, ["actor", "transport", "drainHandle"]);
      actor = result.actor as RelayV2HostCarrierActor;
      transport = result.transport as RelayV2HostCarrierTransport;
      drainHandle = result.drainHandle as RelayV2HostConnectorCarrierAttemptDrainHandle;

      capturedTransport = captureTransport(transport);
      gate = createTransportGate(capturedTransport);
      if (!RelayV2HostCarrierActor.isCanonicalConnectorAttemptActor(actor, {
        hostId,
        hostEpoch,
        hostInstanceId,
        onCarrierStatus: fence.callback,
      })) throw failure();
      if (Reflect.apply(RelayV2HostCarrierActor.prototype.status, actor, []) !== null) {
        throw failure();
      }
      if (!RelayV2HostConnectorCarrierAttemptDrainHandle.matches(
        drainHandleAdapterKey,
        drainHandle,
        transport,
      )) {
        throw failure();
      }
      fence.attach(actor);

      const connection = Reflect.apply(RelayV2HostCarrierActor.prototype.connect, actor, [
        gate.facade,
        exactCredentialReference,
      ]) as RelayV2HostCarrierConnection;
      if (!Number.isSafeInteger(connection.generation) || connection.generation <= 0) {
        throw failure();
      }
      RelayV2HostConnectorCarrierAttemptDrainHandle.bind(
        drainHandleAdapterKey,
        drainHandle,
        transport,
        connection,
      );
      if (fence.failed()) throw failure();

      return Object.freeze(new CanonicalAttempt({
        controllerGeneration,
        carrierGeneration: connection.generation,
        actor,
        transport,
        gate,
        drainHandle,
        fence,
      }));
    } catch {
      fence.fence();
      if (actor !== null
        && RelayV2HostCarrierActor.isCanonicalConnectorAttemptActor(actor, {
          hostId,
          hostEpoch,
          hostInstanceId,
          onCarrierStatus: fence.callback,
        })) {
        try { Reflect.apply(RelayV2HostCarrierActor.prototype.dispose, actor, []); } catch {}
      }
      gate?.close(1000, "host_shutdown");
      if (drainHandle !== null && transport !== null) {
        try {
          await RelayV2HostConnectorCarrierAttemptDrainHandle.drain(
            drainHandleAdapterKey,
            drainHandle,
            transport,
          );
        } catch {}
      }
      throw failure();
    }
  };
}
