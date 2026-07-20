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
  type RelayV2BrokerResult,
  type RelayV2RouteOpenResult,
} from "./brokerCore.js";
import {
  type RelayV2BrokerHostProducerBinding,
  type RelayV2BrokerProducerRegistry,
  type RelayV2BrokerProducerTarget,
} from "./brokerProducerRegistry.js";
import {
  RelayV2BrokerTransportCloseCoordinator,
  type RelayV2BrokerTransportCloseDeadlineScheduler,
  type RelayV2BrokerTransportCloseLease,
} from "./brokerTransportCloseCoordinator.js";

type RelayV2BrokerCoreOptions = NonNullable<
  ConstructorParameters<typeof RelayV2BrokerCore>[0]
>;

const ATTACH_KEYS = Object.freeze([
  "connectionId",
  "authContext",
  "hostProducerTarget",
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

export interface RelayV2BrokerClientWssAttachInput {
  connectionId: string;
  authContext: RelayV2BrokerConnectionAuthorization;
  hostProducerTarget: RelayV2BrokerProducerTarget;
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

export type RelayV2BrokerHostPumpAuthority = Readonly<Pick<
  RelayV2BrokerCore,
  | "attachHostCarrier"
  | "receiveHostFrame"
  | "drainHostCarrier"
  | "acknowledgeHostControlDelivery"
  | "acknowledgeHostDelivery"
  | "sweepBackpressure"
  | "disconnectHost"
>>;

export interface RelayV2BrokerClientWssRuntimeComposition {
  /** Exact bound handoff for the future Host carrier Pump owner only. */
  readonly hostPumpBrokerAuthority: RelayV2BrokerHostPumpAuthority;
  attachClientWss(
    input: RelayV2BrokerClientWssAttachInput,
  ): RelayV2BrokerClientWssConnectionHandle;
  applyBrokerAction(action: RelayV2BrokerAction): RelayV2BrokerClientSocketEffectReceipt;
  closeAndDrain(): Promise<void>;
}

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

function captureAttachInput(input: RelayV2BrokerClientWssAttachInput): Readonly<
  RelayV2BrokerClientWssAttachInput
> {
  if (input === null || typeof input !== "object" || isRejectedProxy(input)) {
    throw new Error("invalid Relay v2 Broker client WSS attach input");
  }
  try {
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== ATTACH_KEYS.length
      || !keys.every((key) => typeof key === "string" && ATTACH_KEYS.includes(
        key as (typeof ATTACH_KEYS)[number],
      ))
    ) throw new Error("invalid attach shape");
    const values = Object.create(null) as Record<string, unknown>;
    for (const key of ATTACH_KEYS) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        throw new Error("invalid attach descriptor");
      }
      values[key] = descriptor.value;
    }
    return Object.freeze({
      connectionId: values.connectionId as string,
      authContext: values.authContext as RelayV2BrokerConnectionAuthorization,
      hostProducerTarget: values.hostProducerTarget as RelayV2BrokerProducerTarget,
      alreadyUpgradedSocket: values.alreadyUpgradedSocket as RelayV2BrokerClientWssSocket,
    });
  } catch {
    throw new Error("invalid Relay v2 Broker client WSS attach input");
  }
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
  readonly hostPumpBrokerAuthority: RelayV2BrokerHostPumpAuthority;

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
  private accepting = true;
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

  attachClientWss(
    input: RelayV2BrokerClientWssAttachInput,
  ): RelayV2BrokerClientWssConnectionHandle {
    if (!this.accepting) throw new Error("Relay v2 Broker client WSS runtime is closing");
    const captured = captureAttachInput(input);
    const nativeTerminalSocket = captureNativeTerminalSocket(captured.alreadyUpgradedSocket);
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

      if (transportFailure || !this.accepting) {
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
      if (!this.accepting) {
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
    if (!this.accepting) return "rejected";
    return this.transport.applyBrokerAction(action);
  }

  closeAndDrain(): Promise<void> {
    if (this.closeDrain) return this.closeDrain;
    this.accepting = false;
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
  return Object.freeze({
    hostPumpBrokerAuthority: owner.hostPumpBrokerAuthority,
    attachClientWss: (input: RelayV2BrokerClientWssAttachInput) => (
      owner.attachClientWss(input)
    ),
    applyBrokerAction: (action: RelayV2BrokerAction) => owner.applyBrokerAction(action),
    closeAndDrain: () => owner.closeAndDrain(),
  });
}
