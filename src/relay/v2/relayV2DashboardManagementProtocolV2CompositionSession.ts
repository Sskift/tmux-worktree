import { types as nodeUtilTypes } from "node:util";
import {
  claimRelayV2DashboardManagementCompositionForProtocolV2Session,
  type RelayV2DashboardManagementComposition,
  type RelayV2DashboardManagementCompositionOptions,
} from "./relayV2DashboardManagementComposition.js";
import {
  RELAY_V2_DASHBOARD_MANAGEMENT_ORDINARY_FAILURE_EXIT_CODE,
  createRelayV2DashboardManagementProtocolV2StdioSession,
  type RelayV2DashboardManagementStdioIo,
} from "./relayV2DashboardManagementStdio.js";
import type {
  RelayV2DashboardManagementProtocolV2Request,
} from "./relayV2DashboardManagementProtocolV2.js";
import {
  abortRelayV2HostDashboardManagementBinding,
  claimRelayV2HostDashboardManagementPort,
  type RelayV2HostDashboardManagementBinding,
  type RelayV2HostDashboardManagementPort,
} from "./hostRuntimeComposition.js";
type DataRecord = Record<string, unknown>;
type SessionCompositionOwnerOptions = Omit<
  RelayV2DashboardManagementCompositionOptions,
  "signal" | "hostManagementBinding"
>;

export interface RelayV2DashboardManagementProtocolV2CompositionSessionOptions
extends SessionCompositionOwnerOptions {
  readonly hostManagementPort: RelayV2HostDashboardManagementPort;
  readonly signal: AbortSignal;
  readonly runtimeVersion: string;
  readonly io: RelayV2DashboardManagementStdioIo;
}

export interface RelayV2DashboardManagementProtocolV2CompositionSession {
  run(): Promise<number>;
  closeAndDrain(): Promise<void>;
}

export class RelayV2DashboardManagementProtocolV2CompositionSessionClosedError
  extends Error {
  constructor() {
    super("Relay v2 Dashboard management protocol v2 composition session closed");
    this.name = "RelayV2DashboardManagementProtocolV2CompositionSessionClosedError";
  }
}

interface SessionSignature {
  readonly ownerOptions: SessionCompositionOwnerOptions;
  readonly hostManagementPort: RelayV2HostDashboardManagementPort;
  readonly externalSignal: AbortSignal;
  readonly externalAbort: CapturedNativeAbortSignal;
  readonly runtimeVersion: string;
  readonly rawIo: object;
  readonly input: AsyncIterable<Uint8Array>;
  readonly inputIteratorFactory: (...args: unknown[]) => unknown;
  readonly writeFrame: (frame: string) => Promise<void>;
}

interface SessionActivation {
  readonly signature: SessionSignature;
  readonly handle: RelayV2DashboardManagementProtocolV2CompositionSession;
}

interface ClosableInput {
  readonly input: AsyncIterable<Uint8Array>;
  close(): void;
}

interface CapturedNativeAbortSignal {
  readonly initiallyAborted: boolean;
  isCurrentlyAborted(): boolean;
  addAbortListener(listener: EventListener): void;
  removeAbortListener(listener: EventListener): void;
}

interface SessionOwnedAbortController {
  readonly signal: AbortSignal;
  abort(): void;
}

const credentialAuthoritySessions = new WeakMap<object, SessionActivation>();
const credentialCoordinatorSessions = new WeakMap<object, SessionActivation>();
const hostManagementPortSessions = new WeakMap<object, SessionActivation>();
const INPUT_CLOSED = Symbol("relay-v2-dashboard-management-input-closed");
const MAX_METHOD_PROTOTYPE_DEPTH = 32;

function closed(): never {
  throw new RelayV2DashboardManagementProtocolV2CompositionSessionClosedError();
}

function isObject(value: unknown): value is DataRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nativePrototype(constructor: Function): object {
  const descriptor = Object.getOwnPropertyDescriptor(constructor, "prototype");
  if (!descriptor
    || !Object.hasOwn(descriptor, "value")
    || !isObject(descriptor.value)) return closed();
  return descriptor.value;
}

function nativeDataFunction(owner: object, key: PropertyKey): (...args: unknown[]) => unknown {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (!descriptor
    || !Object.hasOwn(descriptor, "value")
    || typeof descriptor.value !== "function") return closed();
  return descriptor.value as (...args: unknown[]) => unknown;
}

function nativeGetter(owner: object, key: PropertyKey): (...args: unknown[]) => unknown {
  const descriptor = Object.getOwnPropertyDescriptor(owner, key);
  if (!descriptor || typeof descriptor.get !== "function") return closed();
  return descriptor.get as (...args: unknown[]) => unknown;
}

const NATIVE_ABORT_CONTROLLER = AbortController;
const NATIVE_EVENT_TARGET_PROTOTYPE = nativePrototype(EventTarget);
const NATIVE_ABORT_CONTROLLER_PROTOTYPE = nativePrototype(NATIVE_ABORT_CONTROLLER);
const NATIVE_ABORT_SIGNAL_PROTOTYPE = nativePrototype(AbortSignal);
const NATIVE_ADD_EVENT_LISTENER = nativeDataFunction(
  NATIVE_EVENT_TARGET_PROTOTYPE,
  "addEventListener",
);
const NATIVE_REMOVE_EVENT_LISTENER = nativeDataFunction(
  NATIVE_EVENT_TARGET_PROTOTYPE,
  "removeEventListener",
);
const NATIVE_ABORTED_GETTER = nativeGetter(NATIVE_ABORT_SIGNAL_PROTOTYPE, "aborted");
const NATIVE_ABORT_CONTROLLER_SIGNAL_GETTER = nativeGetter(
  NATIVE_ABORT_CONTROLLER_PROTOTYPE,
  "signal",
);
const NATIVE_ABORT_CONTROLLER_ABORT = nativeDataFunction(
  NATIVE_ABORT_CONTROLLER_PROTOTYPE,
  "abort",
);
const NATIVE_IS_PROXY = nativeDataFunction(nodeUtilTypes, "isProxy");
const ABORT_SIGNAL_OVERRIDE_KEYS = Object.freeze([
  "aborted",
  "addEventListener",
  "removeEventListener",
] as const);

function captureNativeAbortSignal(value: unknown): CapturedNativeAbortSignal {
  if (!isObject(value)) return closed();
  let initiallyAborted: unknown;
  let prototype: object | null;
  let hasOverride = false;
  try {
    // Node's AbortSignal getter is implemented in JavaScript and can enter a
    // Proxy get trap while reading its private symbol, so reject Proxy
    // receivers with the captured native predicate before applying it.
    if (Reflect.apply(NATIVE_IS_PROXY, undefined, [value]) !== false) return closed();
    initiallyAborted = Reflect.apply(NATIVE_ABORTED_GETTER, value, []);
    prototype = Object.getPrototypeOf(value) as object | null;
    hasOverride = ABORT_SIGNAL_OVERRIDE_KEYS.some(
      (key) => Object.getOwnPropertyDescriptor(value, key) !== undefined,
    );
  } catch {
    return closed();
  }
  if (typeof initiallyAborted !== "boolean"
    || prototype !== NATIVE_ABORT_SIGNAL_PROTOTYPE
    || hasOverride) return closed();
  const signal = value as AbortSignal;
  return Object.freeze({
    initiallyAborted,
    isCurrentlyAborted(): boolean {
      let current: unknown;
      try {
        current = Reflect.apply(NATIVE_ABORTED_GETTER, signal, []);
      } catch {
        return closed();
      }
      return typeof current === "boolean" ? current : closed();
    },
    addAbortListener(listener: EventListener): void {
      Reflect.apply(NATIVE_ADD_EVENT_LISTENER, signal, [
        "abort",
        listener,
        { once: true },
      ]);
    },
    removeAbortListener(listener: EventListener): void {
      Reflect.apply(NATIVE_REMOVE_EVENT_LISTENER, signal, ["abort", listener]);
    },
  });
}

function createSessionOwnedAbortController(): SessionOwnedAbortController {
  let controller: object;
  let signal: unknown;
  try {
    controller = Reflect.construct(NATIVE_ABORT_CONTROLLER, []) as object;
    signal = Reflect.apply(NATIVE_ABORT_CONTROLLER_SIGNAL_GETTER, controller, []);
  } catch {
    return closed();
  }
  if (!isObject(signal)) return closed();
  return Object.freeze({
    signal: signal as AbortSignal,
    abort(): void {
      Reflect.apply(NATIVE_ABORT_CONTROLLER_ABORT, controller, []);
    },
  });
}

function exactDataObject(value: unknown, expected: readonly string[]): DataRecord {
  if (!isObject(value)) return closed();
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return closed();
  }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.length
    || keys.some((key) => !expected.includes(key))
    || expected.some((key) => {
      const descriptor = descriptors[key];
      return !descriptor || !Object.hasOwn(descriptor, "value");
    })) return closed();
  return Object.fromEntries(expected.map((key) => [key, descriptors[key].value]));
}

function captureDataMethod(
  value: unknown,
  key: PropertyKey,
  required: boolean,
): ((...args: unknown[]) => unknown) | null {
  if (!isObject(value)) return closed();
  const seen = new Set<object>();
  let owner: object | null = value;
  for (let depth = 0; owner !== null; depth += 1) {
    if (depth >= MAX_METHOD_PROTOTYPE_DEPTH || seen.has(owner)) return closed();
    try {
      if (Reflect.apply(NATIVE_IS_PROXY, undefined, [owner]) !== false) return closed();
    } catch {
      return closed();
    }
    seen.add(owner);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(owner, key);
    } catch {
      return closed();
    }
    if (descriptor !== undefined) {
      if (!Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
        return closed();
      }
      return descriptor.value as (...args: unknown[]) => unknown;
    }
    try {
      owner = Object.getPrototypeOf(owner) as object | null;
    } catch {
      return closed();
    }
  }
  return required ? closed() : null;
}

function captureOptions(
  options: RelayV2DashboardManagementProtocolV2CompositionSessionOptions,
): SessionSignature {
  const fields = exactDataObject(options, [
    "credentialAuthority",
    "credentialExchangeCoordinator",
    "hostManagementPort",
    "hostId",
    "hostEpoch",
    "hostInstanceId",
    "credentialReference",
    "bootstrapSecretReference",
    "refreshSecretReference",
    "signal",
    "clock",
    "runtimeVersion",
    "io",
  ]);
  const io = exactDataObject(fields.io, ["input", "writeFrame"]);
  const inputIteratorFactory = captureDataMethod(io.input, Symbol.asyncIterator, true);
  const externalAbort = captureNativeAbortSignal(fields.signal);
  if (!isObject(fields.credentialAuthority)
    || !isObject(fields.credentialExchangeCoordinator)
    || typeof fields.hostManagementPort !== "function"
    || typeof fields.clock !== "function"
    || typeof fields.runtimeVersion !== "string"
    || !isObject(fields.io)
    || !isObject(io.input)
    || typeof io.writeFrame !== "function") return closed();
  const ownerOptions = Object.freeze({
    credentialAuthority: fields.credentialAuthority,
    credentialExchangeCoordinator: fields.credentialExchangeCoordinator,
    hostId: fields.hostId,
    hostEpoch: fields.hostEpoch,
    hostInstanceId: fields.hostInstanceId,
    credentialReference: fields.credentialReference,
    bootstrapSecretReference: fields.bootstrapSecretReference,
    refreshSecretReference: fields.refreshSecretReference,
    clock: fields.clock,
  }) as SessionCompositionOwnerOptions;
  return Object.freeze({
    ownerOptions,
    hostManagementPort: fields.hostManagementPort as RelayV2HostDashboardManagementPort,
    externalSignal: fields.signal,
    externalAbort,
    runtimeVersion: fields.runtimeVersion,
    rawIo: fields.io,
    input: io.input,
    inputIteratorFactory,
    writeFrame: io.writeFrame,
  }) as SessionSignature;
}

function sameSignature(left: SessionSignature, right: SessionSignature): boolean {
  const a = left.ownerOptions;
  const b = right.ownerOptions;
  return a.credentialAuthority === b.credentialAuthority
    && a.credentialExchangeCoordinator === b.credentialExchangeCoordinator
    && left.hostManagementPort === right.hostManagementPort
    && a.hostId === b.hostId
    && a.hostEpoch === b.hostEpoch
    && a.hostInstanceId === b.hostInstanceId
    && a.credentialReference === b.credentialReference
    && a.bootstrapSecretReference === b.bootstrapSecretReference
    && a.refreshSecretReference === b.refreshSecretReference
    && a.clock === b.clock
    && left.externalSignal === right.externalSignal
    && left.runtimeVersion === right.runtimeVersion
    && left.rawIo === right.rawIo
    && left.input === right.input
    && left.inputIteratorFactory === right.inputIteratorFactory
    && left.writeFrame === right.writeFrame;
}

function existingSession(signature: SessionSignature): SessionActivation | null {
  const composition = signature.ownerOptions;
  const records = [
    credentialAuthoritySessions.get(composition.credentialAuthority),
    credentialCoordinatorSessions.get(composition.credentialExchangeCoordinator),
    hostManagementPortSessions.get(signature.hostManagementPort),
  ];
  const existing = records.filter(
    (record): record is SessionActivation => record !== undefined,
  );
  if (existing.length === 0) return null;
  const winner = existing[0];
  if (existing.length !== records.length
    || existing.some((record) => record !== winner)
    || !sameSignature(winner.signature, signature)) return closed();
  return winner;
}

function createClosableInput(
  rawInput: AsyncIterable<Uint8Array>,
  iteratorFactory: (...args: unknown[]) => unknown,
): ClosableInput {
  let inputClosed = false;
  let resolveClosed!: (value: typeof INPUT_CLOSED) => void;
  const closedSignal = new Promise<typeof INPUT_CLOSED>((resolve) => {
    resolveClosed = resolve;
  });

  const iterate = async function* (): AsyncGenerator<Uint8Array, void, void> {
    const iterator = Reflect.apply(iteratorFactory, rawInput, []);
    if (!isObject(iterator)) return closed();
    const next = captureDataMethod(iterator, "next", true);
    const finish = captureDataMethod(iterator, "return", false);
    try {
      while (!inputClosed) {
        const pendingNext = Promise.resolve().then(
          () => Reflect.apply(next, iterator, []),
        );
        const result = await Promise.race([pendingNext, closedSignal]);
        if (result === INPUT_CLOSED) {
          void pendingNext.catch(() => {});
          break;
        }
        if (!isObject(result) || typeof result.done !== "boolean") return closed();
        if (result.done) break;
        yield result.value as Uint8Array;
      }
    } finally {
      if (inputClosed && finish !== null) {
        void Promise.resolve().then(
          () => Reflect.apply(finish, iterator, []),
        ).catch(() => {});
      }
    }
  };

  return Object.freeze({
    input: Object.freeze({ [Symbol.asyncIterator]: iterate }),
    close(): void {
      if (inputClosed) return;
      inputClosed = true;
      resolveClosed(INPUT_CLOSED);
    },
  });
}

function createFixedWrite(
  rawIo: object,
  writeFrame: (frame: string) => Promise<void>,
): (frame: string) => Promise<void> {
  return (frame) => Reflect.apply(writeFrame, rawIo, [frame]);
}

/**
 * Default-off, unwired owner for one exact protocol-v2 management session.
 * It constructs the canonical real-adapter composition itself and binds only
 * that composition to the existing serial stdio owner. It has no CLI, Tauri,
 * process, socket, credential, capability, selector, retry, or v1 fallback.
 */
export function createRelayV2DashboardManagementProtocolV2CompositionSession(
  options: RelayV2DashboardManagementProtocolV2CompositionSessionOptions,
): RelayV2DashboardManagementProtocolV2CompositionSession {
  const signature = captureOptions(options);
  const existing = existingSession(signature);
  if (existing !== null) return existing.handle;

  let composition: RelayV2DashboardManagementComposition | null = null;
  let hostManagementBinding: RelayV2HostDashboardManagementBinding | null = null;
  const hostIdentity = Object.freeze({
    hostId: signature.ownerOptions.hostId,
    hostEpoch: signature.ownerOptions.hostEpoch,
    hostInstanceId: signature.ownerOptions.hostInstanceId,
    credentialReference: signature.ownerOptions.credentialReference,
  });
  const ownerAbort = createSessionOwnedAbortController();
  let abortObserved = signature.externalAbort.initiallyAborted;
  let ownerAbortForwarded = false;
  let forwardAbort: (() => void) | null = null;
  let abortListenerInstalled = false;
  const forwardOwnerAbort = (): void => {
    if (ownerAbortForwarded) return;
    try {
      ownerAbort.abort();
      ownerAbortForwarded = true;
    } catch {}
  };
  const abortListener: EventListener = () => {
    abortObserved = true;
    forwardOwnerAbort();
    forwardAbort?.();
  };
  const removeAbortListener = (): void => {
    if (!abortListenerInstalled) return;
    abortListenerInstalled = false;
    try {
      signature.externalAbort.removeAbortListener(abortListener);
    } catch {}
  };
  const closableInput = createClosableInput(
    signature.input,
    signature.inputIteratorFactory,
  );
  let accepting = true;
  let externallyClosed = false;
  let runState: "idle" | "running" | "done" = "idle";
  let closePromise: Promise<void> | null = null;

  const beginCloseAndDrain = (): Promise<void> => {
    accepting = false;
    closableInput.close();
    if (closePromise !== null) return closePromise;
    const activeComposition = composition;
    if (activeComposition === null) {
      closePromise = Promise.reject(
        new RelayV2DashboardManagementProtocolV2CompositionSessionClosedError(),
      );
      return closePromise;
    }
    closePromise = Promise.resolve().then(
      () => activeComposition.closeAndDrain(),
    ).catch(() => {
      throw new RelayV2DashboardManagementProtocolV2CompositionSessionClosedError();
    }).finally(() => {
      removeAbortListener();
    });
    return closePromise;
  };

  const onAbort = (): void => {
    externallyClosed = true;
    void beginCloseAndDrain().catch(() => {});
  };

  const handler = Object.freeze(Object.assign(Object.create(null), {
    handle(request: RelayV2DashboardManagementProtocolV2Request) {
      const activeComposition = composition;
      if (!accepting || activeComposition === null) {
        return Promise.reject(
          new RelayV2DashboardManagementProtocolV2CompositionSessionClosedError(),
        );
      }
      return activeComposition.handleRequest(request);
    },
  }));
  const stdio = createRelayV2DashboardManagementProtocolV2StdioSession({
    runtimeVersion: signature.runtimeVersion,
    handler,
    io: Object.freeze({
      input: closableInput.input,
      writeFrame: createFixedWrite(signature.rawIo, signature.writeFrame),
    }),
  });

  const run = (): Promise<number> => {
    if (runState !== "idle") {
      externallyClosed = true;
      return beginCloseAndDrain().then(
        () => RELAY_V2_DASHBOARD_MANAGEMENT_ORDINARY_FAILURE_EXIT_CODE,
        () => RELAY_V2_DASHBOARD_MANAGEMENT_ORDINARY_FAILURE_EXIT_CODE,
      );
    }
    runState = "running";
    return (async () => {
      let result = RELAY_V2_DASHBOARD_MANAGEMENT_ORDINARY_FAILURE_EXIT_CODE;
      if (!externallyClosed) {
        try {
          result = await stdio.run();
        } catch {}
      }
      accepting = false;
      closableInput.close();
      try {
        await beginCloseAndDrain();
      } catch {
        result = RELAY_V2_DASHBOARD_MANAGEMENT_ORDINARY_FAILURE_EXIT_CODE;
      }
      runState = "done";
      return externallyClosed
        ? RELAY_V2_DASHBOARD_MANAGEMENT_ORDINARY_FAILURE_EXIT_CODE
        : result;
    })();
  };

  const closeAndDrain = (): Promise<void> => {
    externallyClosed = true;
    return beginCloseAndDrain();
  };
  const handle = Object.freeze(Object.assign(Object.create(null), {
    run,
    closeAndDrain,
  })) as RelayV2DashboardManagementProtocolV2CompositionSession;
  const activation = Object.freeze({ signature, handle });

  try {
    if (abortObserved) forwardOwnerAbort();
    signature.externalAbort.addAbortListener(abortListener);
    abortListenerInstalled = true;
    if (signature.externalAbort.isCurrentlyAborted()) abortListener();
    hostManagementBinding = claimRelayV2HostDashboardManagementPort(
      signature.hostManagementPort,
      hostIdentity,
      signature.ownerOptions.credentialAuthority,
    );
    if (hostManagementBinding === null) return closed();
    composition = claimRelayV2DashboardManagementCompositionForProtocolV2Session(
      Object.freeze({
        ...signature.ownerOptions,
        hostManagementBinding,
        signal: ownerAbort.signal,
      }),
    );
  } catch {
    if (hostManagementBinding !== null) {
      abortRelayV2HostDashboardManagementBinding(
        hostManagementBinding,
        hostIdentity,
        signature.ownerOptions.credentialAuthority,
      );
    }
    accepting = false;
    closableInput.close();
    removeAbortListener();
    return closed();
  }

  credentialAuthoritySessions.set(signature.ownerOptions.credentialAuthority, activation);
  credentialCoordinatorSessions.set(
    signature.ownerOptions.credentialExchangeCoordinator,
    activation,
  );
  hostManagementPortSessions.set(signature.hostManagementPort, activation);
  forwardAbort = onAbort;
  if (abortObserved) onAbort();
  return handle;
}
