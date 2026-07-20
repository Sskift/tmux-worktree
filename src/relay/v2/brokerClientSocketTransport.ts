import { randomUUID } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import {
  RELAY_V2_BROKER_LIMITS,
  RelayV2BrokerCore,
  relayV2BrokerOutputReadyMayDrain,
  type RelayV2BrokerAction,
  type RelayV2BrokerConnectionAuthorization,
  type RelayV2BrokerOutputReadyFence,
  type RelayV2BrokerOutputReadyPort,
  type RelayV2BrokerResult,
  type RelayV2RouteOpenResult,
} from "./brokerCore.js";
import {
  type RelayV2BrokerHostProducerBinding,
  type RelayV2BrokerProducerHandoff,
  type RelayV2BrokerProducerReceipt,
  type RelayV2BrokerProducerRegistry,
  type RelayV2BrokerProducerTarget,
} from "./brokerProducerRegistry.js";
import {
  consumeRelayV2BrokerClientTransportCloseLease,
  type RelayV2BrokerTransportCloseLease,
} from "./brokerTransportCloseCoordinator.js";
import { encodeRelayV2WebSocketFrame } from "./codec.js";

const DEFAULT_DELIVERY_TIMEOUT_MS = 5_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

export type RelayV2BrokerClientSocketEffectReceipt = "applied" | "rejected";
export type RelayV2BrokerClientSocketWriteCompletion = "delivered" | "rejected";

export interface RelayV2BrokerClientSocketBufferState {
  bytes: number;
  frames: number;
}

/**
 * Narrow socket wrapper. A future listener adapter translates its concrete
 * WebSocket API into these literal receipts; this foundation owns no listener.
 */
export interface RelayV2BrokerClientSocketPort {
  bufferedState(): RelayV2BrokerClientSocketBufferState;
  send(
    bytes: Uint8Array,
    complete: (receipt: RelayV2BrokerClientSocketWriteCompletion) => void,
  ): RelayV2BrokerClientSocketEffectReceipt;
  pause(): RelayV2BrokerClientSocketEffectReceipt;
  resume(): RelayV2BrokerClientSocketEffectReceipt;
  close(code: number, reason: string): RelayV2BrokerClientSocketEffectReceipt;
  forceDestroy(): RelayV2BrokerClientSocketEffectReceipt;
}

export interface RelayV2BrokerClientSocketScheduler {
  schedule(delayMs: number, callback: () => void): () => void;
}

export interface RelayV2BrokerClientSocketFrameMetadata {
  opcode: "text" | "binary";
  compressed: boolean;
}

export interface RelayV2BrokerClientSocketRegistrationInput {
  connectionId: string;
  authContext: RelayV2BrokerConnectionAuthorization;
  /** Exact B7a generation captured by the Upgrade/current-carrier owner. */
  hostProducerTarget: RelayV2BrokerProducerTarget;
  socket: RelayV2BrokerClientSocketPort;
}

export interface RelayV2BrokerClientSocketRegistration {
  readonly connectionId: string;
  /** Passes unchanged into BrokerCore.openClientRoute. */
  readonly connectionIncarnation: string;
  readonly openResult: RelayV2RouteOpenResult;
  receive(
    bytes: Uint8Array,
    metadata: RelayV2BrokerClientSocketFrameMetadata,
  ): RelayV2BrokerResult;
  /** One concrete writable edge drains at most one Broker delivery. */
  writable(): RelayV2BrokerClientSocketEffectReceipt;
  /** Underlying socket terminal callbacks; each unbinds at most once. */
  closed(): RelayV2BrokerResult;
  errored(): RelayV2BrokerResult;
}

type RelayV2BrokerCoreOptions = NonNullable<
  ConstructorParameters<typeof RelayV2BrokerCore>[0]
>;

export interface RelayV2BrokerClientSocketTransportCompositionOptions {
  brokerOptions?: Omit<RelayV2BrokerCoreOptions, "outputReadyPort">;
  producerRegistry: RelayV2BrokerProducerRegistry;
  /** Returns a registry-created exact Host incarnation/generation receipt. */
  resolveHostProducerBinding(
    fence: Extract<RelayV2BrokerOutputReadyFence, { kind: "host" }>,
  ): RelayV2BrokerHostProducerBinding | undefined;
  scheduler?: RelayV2BrokerClientSocketScheduler;
  deliveryTimeoutMs?: number;
  closeTimeoutMs?: number;
}

export interface RelayV2BrokerClientSocketTransport {
  registerClientSocket(
    input: RelayV2BrokerClientSocketRegistrationInput,
  ): RelayV2BrokerClientSocketRegistration;
  applyBrokerAction(action: RelayV2BrokerAction): RelayV2BrokerClientSocketEffectReceipt;
}

export interface RelayV2BrokerManagedClientSocketTransport
extends RelayV2BrokerClientSocketTransport {
  registerManagedClientSocket(
    lease: RelayV2BrokerTransportCloseLease,
    input: RelayV2BrokerClientSocketRegistrationInput,
  ): RelayV2BrokerClientSocketRegistration;
  retireManagedClientSocket(lease: RelayV2BrokerTransportCloseLease): RelayV2BrokerResult;
}

export interface RelayV2BrokerClientSocketTransportComposition {
  readonly broker: RelayV2BrokerCore;
  readonly clientSocketTransport: RelayV2BrokerManagedClientSocketTransport;
}

type CapturedSocket = {
  readonly receiver: object;
  readonly bufferedState: (...args: unknown[]) => unknown;
  readonly send: (...args: unknown[]) => unknown;
  readonly pause: (...args: unknown[]) => unknown;
  readonly resume: (...args: unknown[]) => unknown;
  readonly close: (...args: unknown[]) => unknown;
  readonly forceDestroy: (...args: unknown[]) => unknown;
};

type OutboundAttempt = {
  readonly deliveryId: string;
  readonly token: string;
  cancelDeadline: (() => void) | null;
  deadlineArmed: boolean;
  deadlineFiredEarly: boolean;
  settled: boolean;
};

type CloseDeadline = {
  readonly token: string;
  cancel: (() => void) | null;
  armed: boolean;
  firedEarly: boolean;
};

type ClientEntry = {
  readonly connectionId: string;
  readonly connectionIncarnation: string;
  readonly hostProducerTarget: RelayV2BrokerProducerTarget;
  readonly socket: CapturedSocket;
  readonly managed: boolean;
  phase: "open" | "closing" | "closed";
  routeOpened: boolean;
  paused: boolean;
  pauseTransition: Readonly<{ token: string; desired: boolean }> | null;
  unbindStarted: boolean;
  unbindResult: RelayV2BrokerResult | null;
  outbound: OutboundAttempt | null;
  pendingReadyFence: Extract<RelayV2BrokerOutputReadyFence, { kind: "client" }> | null;
  lastAutoReadyEpoch: string | null;
  readyTurnQueued: boolean;
  closeDeadline: CloseDeadline | null;
  terminalWriteToken: string | null;
  closeRequested: boolean;
  forceDestroyRequested: boolean;
};

type HostReadyEntry = {
  fence: Extract<RelayV2BrokerOutputReadyFence, { kind: "host" }>;
};

type SocketMethodName = Exclude<keyof CapturedSocket, "receiver">;

const SOCKET_METHODS = Object.freeze([
  "bufferedState",
  "send",
  "pause",
  "resume",
  "close",
  "forceDestroy",
] as const satisfies readonly SocketMethodName[]);

const defaultScheduler: RelayV2BrokerClientSocketScheduler = Object.freeze({
  schedule(delayMs: number, callback: () => void): () => void {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
});

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

function positiveBounded(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > maximum) {
    throw new Error("invalid Relay v2 client socket transport limit");
  }
  return selected;
}

function rejectedBrokerResult(): RelayV2BrokerResult {
  return { accepted: false, actions: [] };
}

function captureSocket(port: unknown): CapturedSocket | undefined {
  if (port === null || typeof port !== "object" || isRejectedProxy(port)) return undefined;
  try {
    const keys = Reflect.ownKeys(port);
    if (
      keys.length !== SOCKET_METHODS.length
      || keys.some((key) => typeof key !== "string" || !SOCKET_METHODS.includes(
        key as SocketMethodName,
      ))
    ) return undefined;
    const captured = Object.create(null) as Record<SocketMethodName, (...args: unknown[]) => unknown>;
    for (const name of SOCKET_METHODS) {
      const descriptor = Reflect.getOwnPropertyDescriptor(port, name);
      if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") {
        return undefined;
      }
      if (isRejectedProxy(descriptor.value)) return undefined;
      captured[name] = descriptor.value as (...args: unknown[]) => unknown;
    }
    return Object.freeze({ receiver: port, ...captured }) as CapturedSocket;
  } catch {
    return undefined;
  }
}

function readBufferState(value: unknown): RelayV2BrokerClientSocketBufferState | undefined {
  if (value === null || typeof value !== "object" || isRejectedProxy(value)) return undefined;
  try {
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 2
      || keys.some((key) => key !== "bytes" && key !== "frames")
    ) return undefined;
    const bytesDescriptor = Reflect.getOwnPropertyDescriptor(value, "bytes");
    const framesDescriptor = Reflect.getOwnPropertyDescriptor(value, "frames");
    if (
      !bytesDescriptor
      || !("value" in bytesDescriptor)
      || !framesDescriptor
      || !("value" in framesDescriptor)
      || !Number.isSafeInteger(bytesDescriptor.value)
      || bytesDescriptor.value < 0
      || !Number.isSafeInteger(framesDescriptor.value)
      || framesDescriptor.value < 0
    ) return undefined;
    return { bytes: bytesDescriptor.value, frames: framesDescriptor.value };
  } catch {
    return undefined;
  }
}

function isHostProducerTarget(value: unknown): value is RelayV2BrokerProducerTarget {
  if (value === null || typeof value !== "object" || isRejectedProxy(value)) return false;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || !keys.every((key) => (
      key === "transportId" || key === "generation"
    ))) return false;
    const transportId = Reflect.getOwnPropertyDescriptor(value, "transportId");
    const generation = Reflect.getOwnPropertyDescriptor(value, "generation");
    return !!transportId
      && "value" in transportId
      && isIdentifier(transportId.value)
      && !!generation
      && "value" in generation
      && typeof generation.value === "string"
      && /^[1-9][0-9]*$/.test(generation.value);
  } catch {
    return false;
  }
}

/**
 * Default-off client WebSocket transport owner. BrokerCore remains the sole
 * route/queue/backpressure authority; B7a remains the exact Host producer
 * generation owner. No Relay listener or production carrier Pump is wired by
 * this class. `host_output_ready` requires the later B7c port-to-Pump binding.
 */
class RelayV2BrokerClientSocketTransportImpl
implements RelayV2BrokerManagedClientSocketTransport {
  private broker!: RelayV2BrokerCore;
  private brokerBound = false;
  private readonly producerRegistry: RelayV2BrokerProducerRegistry;
  private readonly resolveHostProducerBinding:
    RelayV2BrokerClientSocketTransportCompositionOptions["resolveHostProducerBinding"];
  private readonly scheduler: RelayV2BrokerClientSocketScheduler;
  private readonly deliveryTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly clients = new Map<string, ClientEntry>();
  private readonly managedClients = new WeakMap<object, ClientEntry>();
  private readonly hostReady = new Map<string, HostReadyEntry>();

  constructor(
    options: RelayV2BrokerClientSocketTransportCompositionOptions,
    installReadyConsumer: (
      consumer: (fence: RelayV2BrokerOutputReadyFence) => void,
    ) => void,
  ) {
    this.producerRegistry = options.producerRegistry;
    this.resolveHostProducerBinding = options.resolveHostProducerBinding;
    if (typeof this.resolveHostProducerBinding !== "function") {
      throw new Error("Relay v2 client socket transport requires a Host binding resolver");
    }
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.deliveryTimeoutMs = positiveBounded(
      options.deliveryTimeoutMs,
      DEFAULT_DELIVERY_TIMEOUT_MS,
      DEFAULT_DELIVERY_TIMEOUT_MS,
    );
    this.closeTimeoutMs = positiveBounded(
      options.closeTimeoutMs,
      DEFAULT_CLOSE_TIMEOUT_MS,
      DEFAULT_CLOSE_TIMEOUT_MS,
    );
    installReadyConsumer((fence) => this.acceptOutputReady(fence));
  }

  bindBroker(broker: RelayV2BrokerCore): void {
    if (this.brokerBound) throw new Error("Relay v2 client transport Broker is already bound");
    this.broker = broker;
    this.brokerBound = true;
  }

  registerClientSocket(
    input: RelayV2BrokerClientSocketRegistrationInput,
  ): RelayV2BrokerClientSocketRegistration {
    return this.registerClientSocketWithIncarnation(input, randomUUID());
  }

  registerManagedClientSocket(
    lease: RelayV2BrokerTransportCloseLease,
    input: RelayV2BrokerClientSocketRegistrationInput,
  ): RelayV2BrokerClientSocketRegistration {
    const connectionIncarnation = consumeRelayV2BrokerClientTransportCloseLease(
      lease,
      input.connectionId,
    );
    return this.registerClientSocketWithIncarnation(input, connectionIncarnation, lease);
  }

  retireManagedClientSocket(
    lease: RelayV2BrokerTransportCloseLease,
  ): RelayV2BrokerResult {
    if (lease === null || typeof lease !== "object") return rejectedBrokerResult();
    const entry = this.managedClients.get(lease);
    if (!entry) return rejectedBrokerResult();
    const result = this.unbindOnce(entry, "broker_shutdown");
    this.finalize(entry);
    return result;
  }

  private registerClientSocketWithIncarnation(
    input: RelayV2BrokerClientSocketRegistrationInput,
    connectionIncarnation: string,
    lease?: RelayV2BrokerTransportCloseLease,
  ): RelayV2BrokerClientSocketRegistration {
    if (!isIdentifier(input.connectionId) || this.clients.has(input.connectionId)) {
      throw new Error("invalid or duplicate Relay v2 client socket connection ID");
    }
    if (!isHostProducerTarget(input.hostProducerTarget)) {
      throw new Error("invalid Relay v2 client socket Host producer target");
    }
    const socket = captureSocket(input.socket);
    if (!socket) throw new Error("invalid Relay v2 client socket port");
    const entry: ClientEntry = {
      connectionId: input.connectionId,
      connectionIncarnation,
      hostProducerTarget: Object.freeze({
        transportId: input.hostProducerTarget.transportId,
        generation: input.hostProducerTarget.generation,
      }),
      socket,
      managed: lease !== undefined,
      phase: "open",
      routeOpened: false,
      paused: false,
      pauseTransition: null,
      unbindStarted: false,
      unbindResult: null,
      outbound: null,
      pendingReadyFence: null,
      lastAutoReadyEpoch: null,
      readyTurnQueued: false,
      closeDeadline: null,
      terminalWriteToken: null,
      closeRequested: false,
      forceDestroyRequested: false,
    };
    this.clients.set(entry.connectionId, entry);
    if (lease) this.managedClients.set(lease, entry);

    let openResult: RelayV2RouteOpenResult;
    try {
      openResult = this.runEntryBrokerCall(entry, () => this.broker.openClientRoute(
        entry.connectionId,
        input.authContext,
        entry.connectionIncarnation,
      ));
    } catch (error) {
      if (entry.managed) this.unbindOnce(entry, "broker_shutdown");
      this.finalize(entry);
      throw error;
    }
    if (!openResult.accepted && entry.phase === "open") {
      this.beginBoundedClose(entry, 1013, "route_open_rejected");
    }

    return Object.freeze({
      connectionId: entry.connectionId,
      connectionIncarnation: entry.connectionIncarnation,
      openResult,
      receive: (bytes: Uint8Array, metadata: RelayV2BrokerClientSocketFrameMetadata) => (
        this.receive(entry, bytes, metadata)
      ),
      writable: () => this.writable(entry),
      closed: () => this.closed(entry),
      errored: () => this.errored(entry),
    });
  }

  /**
   * Client-local outlet for a Host carrier Pump's onBrokerAction sink. Host
   * actions remain owned by that exact Pump/B7a producer generation.
   */
  applyBrokerAction(action: RelayV2BrokerAction): RelayV2BrokerClientSocketEffectReceipt {
    if (this.isHostAction(action)) return "rejected";
    return this.applyClientAction(action);
  }

  private acceptOutputReady(fence: RelayV2BrokerOutputReadyFence): void {
    if (!relayV2BrokerOutputReadyMayDrain(fence)) return;
    if (fence.kind === "client") {
      const entry = this.clients.get(fence.connectionId);
      if (
        !entry
        || entry.connectionIncarnation !== fence.connectionIncarnation
        || entry.phase !== "open"
      ) return;
      entry.pendingReadyFence = fence;
      if (entry.lastAutoReadyEpoch === fence.readyEpoch) return;
      entry.lastAutoReadyEpoch = fence.readyEpoch;
      if (entry.readyTurnQueued) return;
      entry.readyTurnQueued = true;
      queueMicrotask(() => this.runClientReadyTurn(entry));
      return;
    }

    const key = `${fence.transportId}\0${fence.connectionIncarnation}`;
    const current = this.hostReady.get(key);
    if (current) {
      current.fence = fence;
      return;
    }
    this.hostReady.set(key, { fence });
    queueMicrotask(() => {
      const pending = this.hostReady.get(key);
      this.hostReady.delete(key);
      if (pending) this.deliverHostReady(pending.fence);
    });
  }

  private runClientReadyTurn(entry: ClientEntry): void {
    entry.readyTurnQueued = false;
    const fence = entry.pendingReadyFence;
    if (
      !fence
      || entry.outbound
      || !this.isCurrentOpen(entry)
      || !relayV2BrokerOutputReadyMayDrain(fence)
    ) return;
    this.drainOne(entry, fence);
    if (
      entry.pendingReadyFence === fence
      && !relayV2BrokerOutputReadyMayDrain(fence)
    ) entry.pendingReadyFence = null;
  }

  private deliverHostReady(
    fence: Extract<RelayV2BrokerOutputReadyFence, { kind: "host" }>,
  ): void {
    if (!relayV2BrokerOutputReadyMayDrain(fence)) return;
    const owner = this.producerRegistry.inspectHostProducerOwner(
      fence.transportId,
      fence.connectionIncarnation,
    );
    if (owner.status === "stale") return;
    if (owner.status === "current_unbound") {
      this.forceHostReadyTarget(fence, owner.target, "host_output_ready_binding_missing");
      return;
    }
    const canonicalBinding = owner.binding;
    let binding: RelayV2BrokerHostProducerBinding | undefined;
    let resolverFailed = false;
    try {
      binding = this.resolveHostProducerBinding(fence);
    } catch {
      resolverFailed = true;
    }
    if (resolverFailed || binding !== canonicalBinding) {
      const target = this.producerRegistry.resolveHostProducerBinding(
        canonicalBinding,
        fence.transportId,
        fence.connectionIncarnation,
      );
      if (target) {
        this.forceHostReadyTarget(fence, target, "host_output_ready_resolver_failed");
      }
      return;
    }
    let target = this.producerRegistry.resolveHostProducerBinding(
      binding,
      fence.transportId,
      fence.connectionIncarnation,
    );
    if (
      !target
      || !relayV2BrokerOutputReadyMayDrain(fence)
    ) return;
    const action = Object.freeze({
      kind: "host_output_ready" as const,
      transportId: fence.transportId,
      connectionIncarnation: fence.connectionIncarnation,
      readyEpoch: fence.readyEpoch,
    });
    this.producerRegistry.runInternalBrokerCall(
      () => ({ accepted: true, actions: [action] }),
      (_result, handoff) => {
        const current = this.producerRegistry.inspectHostProducerOwner(
          fence.transportId,
          fence.connectionIncarnation,
        );
        if (current.status !== "current" || current.binding !== binding) return "rejected";
        target = this.producerRegistry.resolveHostProducerBinding(
          binding,
          fence.transportId,
          fence.connectionIncarnation,
        );
        if (!target || !relayV2BrokerOutputReadyMayDrain(fence)) return "rejected";
        const applied = handoff.apply(target, [action]);
        if (applied === "applied") return "applied";
        handoff.forceTerminal({
          kind: "target_failure",
          target,
          reason: "host_output_ready_rejected",
        });
        return "rejected";
      },
    );
  }

  private forceHostReadyTarget(
    fence: Extract<RelayV2BrokerOutputReadyFence, { kind: "host" }>,
    target: RelayV2BrokerProducerTarget,
    reason: string,
  ): void {
    this.producerRegistry.runInternalBrokerCall(
      () => ({ accepted: false, actions: [] }),
      (_result, handoff) => {
        if (!relayV2BrokerOutputReadyMayDrain(fence)) return "rejected";
        return handoff.forceTerminal({ kind: "target_failure", target, reason });
      },
    );
  }

  private writable(entry: ClientEntry): RelayV2BrokerClientSocketEffectReceipt {
    if (!this.isCurrentOpen(entry) || entry.outbound) return "rejected";
    const fence = entry.pendingReadyFence;
    const receipt = this.drainOne(
      entry,
      fence && relayV2BrokerOutputReadyMayDrain(fence) ? fence : null,
    );
    if (fence && !relayV2BrokerOutputReadyMayDrain(fence)) {
      entry.pendingReadyFence = null;
    }
    return receipt;
  }

  private drainOne(
    entry: ClientEntry,
    fence: Extract<RelayV2BrokerOutputReadyFence, { kind: "client" }> | null,
  ): RelayV2BrokerClientSocketEffectReceipt {
    if (
      !this.isCurrentOpen(entry)
      || entry.outbound
      || !entry.routeOpened
      || (fence && !relayV2BrokerOutputReadyMayDrain(fence))
    ) return "rejected";
    const before = this.socketBufferState(entry);
    if (!before) {
      this.beginBoundedClose(entry, 1013, "invalid_client_socket_buffer_state");
      return "rejected";
    }
    if (
      before.bytes >= RELAY_V2_BROKER_LIMITS.routeBufferedBytesPerDirection
      || before.frames >= RELAY_V2_BROKER_LIMITS.maxQueuedRouteFrames
    ) return "rejected";
    if (!this.isCurrentOpen(entry) || (fence && !relayV2BrokerOutputReadyMayDrain(fence))) {
      return "rejected";
    }
    const [delivery] = this.broker.drainClient(entry.connectionId, {
      maxFrames: 1,
      maxBytes: RELAY_V2_BROKER_LIMITS.routeBufferedBytesPerDirection - before.bytes,
    });
    if (!delivery) return "applied";
    if (
      delivery.connectionId !== entry.connectionId
      || delivery.bytes.byteLength > RELAY_V2_BROKER_LIMITS.maxFrameBytes
      || before.frames + 1 > RELAY_V2_BROKER_LIMITS.maxQueuedRouteFrames
      || before.bytes + delivery.bytes.byteLength
        > RELAY_V2_BROKER_LIMITS.routeBufferedBytesPerDirection
    ) {
      this.beginBoundedClose(entry, 1013, "invalid_client_delivery_boundary");
      return "rejected";
    }
    return this.sendDelivery(entry, delivery.deliveryId, delivery.bytes);
  }

  private sendDelivery(
    entry: ClientEntry,
    deliveryId: string,
    source: Uint8Array,
  ): RelayV2BrokerClientSocketEffectReceipt {
    let bytes: Uint8Array;
    try {
      bytes = source.slice();
    } catch {
      this.beginBoundedClose(entry, 1013, "client_delivery_copy_failure");
      return "rejected";
    }
    const afterDrain = this.socketBufferState(entry);
    if (
      !afterDrain
      || afterDrain.frames + 1 > RELAY_V2_BROKER_LIMITS.maxQueuedRouteFrames
      || afterDrain.bytes + bytes.byteLength
        > RELAY_V2_BROKER_LIMITS.routeBufferedBytesPerDirection
      || !this.isCurrentOpen(entry)
    ) {
      this.beginBoundedClose(entry, 1013, "client_socket_boundary_changed");
      return "rejected";
    }
    const token = randomUUID();
    const attempt: OutboundAttempt = {
      deliveryId,
      token,
      cancelDeadline: null,
      deadlineArmed: false,
      deadlineFiredEarly: false,
      settled: false,
    };
    entry.outbound = attempt;
    try {
      const cancelDeadline = this.scheduler.schedule(this.deliveryTimeoutMs, () => {
        if (!attempt.deadlineArmed) {
          attempt.deadlineFiredEarly = true;
          return;
        }
        this.deliveryTimedOut(entry, deliveryId, token);
      });
      if (typeof cancelDeadline !== "function") {
        throw new Error("invalid Relay v2 delivery deadline cancellation receipt");
      }
      attempt.cancelDeadline = cancelDeadline;
      attempt.deadlineArmed = true;
    } catch {
      if (entry.outbound === attempt) entry.outbound = null;
      this.beginBoundedClose(entry, 1013, "client_delivery_timer_failure");
      return "rejected";
    }
    if (attempt.deadlineFiredEarly) {
      this.deliveryTimedOut(entry, deliveryId, token);
      return "rejected";
    }

    let sendReturned = false;
    let accepted = false;
    let earlyCompletionObserved = false;
    let earlyCompletion: unknown;
    const complete = (receipt: RelayV2BrokerClientSocketWriteCompletion) => {
      if (!sendReturned) {
        if (!earlyCompletionObserved) {
          earlyCompletionObserved = true;
          earlyCompletion = receipt;
        }
        return;
      }
      if (!accepted) return;
      this.completeDelivery(entry, deliveryId, token, receipt, true);
    };
    let receipt: unknown = "rejected";
    try {
      if (!this.isCurrentOpen(entry) || entry.outbound !== attempt) {
        throw new Error("stale client delivery effect");
      }
      receipt = Reflect.apply(entry.socket.send, entry.socket.receiver, [bytes.slice(), complete]);
    } catch {
      receipt = "rejected";
    }
    sendReturned = true;
    accepted = receipt === "applied" && this.isCurrentOpen(entry) && entry.outbound === attempt;
    if (!accepted) {
      this.cancelDeliveryDeadline(attempt);
      if (entry.outbound === attempt) entry.outbound = null;
      this.beginBoundedClose(entry, 1013, "client_delivery_rejected");
      return "rejected";
    }
    if (earlyCompletionObserved) {
      this.completeDelivery(entry, deliveryId, token, earlyCompletion, false);
    }
    return "applied";
  }

  private completeDelivery(
    entry: ClientEntry,
    deliveryId: string,
    token: string,
    receipt: unknown,
    allowCompletionDrain: boolean,
  ): void {
    const attempt = entry.outbound;
    if (
      !attempt
      || attempt.deliveryId !== deliveryId
      || attempt.token !== token
      || attempt.settled
    ) return;
    attempt.settled = true;
    this.cancelDeliveryDeadline(attempt);
    if (
      receipt !== "delivered"
      || !this.isCurrentOpen(entry)
      || entry.outbound !== attempt
    ) {
      if (entry.outbound === attempt) entry.outbound = null;
      if (this.clients.get(entry.connectionId) === entry) {
        this.beginBoundedClose(entry, 1013, "client_delivery_failed");
      }
      return;
    }
    entry.outbound = null;
    let acknowledged: RelayV2BrokerResult;
    try {
      acknowledged = this.runEntryBrokerCall(entry, () => (
        this.broker.acknowledgeClientDelivery(entry.connectionId, deliveryId)
      ));
    } catch {
      this.beginBoundedClose(entry, 1013, "client_delivery_ack_failure");
      return;
    }
    if (!acknowledged.accepted) {
      this.beginBoundedClose(entry, 1013, "client_delivery_ack_rejected");
      return;
    }
    // An asynchronous socket completion is one real progress edge. A
    // completion invoked inside send() only acknowledges this frame; it cannot
    // recursively manufacture progress and must wait for writable().
    if (allowCompletionDrain && this.isCurrentOpen(entry)) {
      const fence = entry.pendingReadyFence;
      this.drainOne(
        entry,
        fence && relayV2BrokerOutputReadyMayDrain(fence) ? fence : null,
      );
      if (fence && !relayV2BrokerOutputReadyMayDrain(fence)) {
        entry.pendingReadyFence = null;
      }
    }
  }

  private deliveryTimedOut(entry: ClientEntry, deliveryId: string, token: string): void {
    const attempt = entry.outbound;
    if (
      !attempt
      || attempt.deliveryId !== deliveryId
      || attempt.token !== token
      || attempt.settled
      || !this.isCurrentOpen(entry)
    ) return;
    attempt.settled = true;
    this.cancelDeliveryDeadline(attempt);
    entry.outbound = null;
    this.beginBoundedClose(entry, 1013, "client_delivery_timeout");
  }

  private cancelDeliveryDeadline(attempt: OutboundAttempt): void {
    const cancel = attempt.cancelDeadline;
    attempt.cancelDeadline = null;
    if (!cancel) return;
    try {
      Reflect.apply(cancel, undefined, []);
    } catch {
      // Cancellation failure cannot revive or acknowledge the exact attempt.
    }
  }

  private receive(
    entry: ClientEntry,
    source: unknown,
    metadata: unknown,
  ): RelayV2BrokerResult {
    if (!this.isCurrentOpen(entry)) return rejectedBrokerResult();
    let bytes: Uint8Array;
    let validMetadata = false;
    try {
      if (!isRejectedProxy(metadata) && metadata !== null && typeof metadata === "object") {
        const keys = Reflect.ownKeys(metadata);
        const opcode = Reflect.getOwnPropertyDescriptor(metadata, "opcode");
        const compressed = Reflect.getOwnPropertyDescriptor(metadata, "compressed");
        validMetadata = keys.length === 2
          && keys.every((key) => key === "opcode" || key === "compressed")
          && !!opcode
          && "value" in opcode
          && opcode.value === "text"
          && !!compressed
          && "value" in compressed
          && compressed.value === false;
      }
      if (
        !validMetadata
        || !(source instanceof Uint8Array)
        || isRejectedProxy(source)
        || source.byteLength > RELAY_V2_BROKER_LIMITS.maxFrameBytes
      ) throw new Error("invalid client frame boundary");
      bytes = source.slice();
    } catch {
      const result = this.unbindOnce(entry, "protocol_error");
      this.beginBoundedClose(entry, 4400, "invalid_client_frame");
      return result;
    }
    try {
      return this.runEntryBrokerCall(entry, () => (
        this.broker.forwardClientFrame(entry.connectionId, bytes)
      ));
    } catch {
      const result = this.unbindOnce(entry, "protocol_error");
      this.beginBoundedClose(entry, 1013, "client_frame_dispatch_failure");
      return result;
    }
  }

  private runEntryBrokerCall<Result extends RelayV2BrokerResult>(
    entry: ClientEntry,
    invoke: () => Result,
  ): Result {
    let result: Result | undefined;
    const receipt = this.producerRegistry.runInternalBrokerCall(
      () => {
        result = invoke();
        return result;
      },
      (settled, handoff) => this.applyBrokerResult(entry, settled, handoff),
    );
    if (!result) throw new Error("Relay v2 client Broker call did not return synchronously");
    if (receipt !== "applied" && entry.phase === "open") {
      this.beginBoundedClose(entry, 1013, "client_broker_action_rejected");
    }
    return result;
  }

  private applyBrokerResult(
    source: ClientEntry,
    result: RelayV2BrokerResult,
    handoff: RelayV2BrokerProducerHandoff,
  ): RelayV2BrokerProducerReceipt {
    let receipt: RelayV2BrokerProducerReceipt = "applied";
    for (const action of result.actions) {
      if (this.isHostAction(action)) {
        const applied = action.transportId === source.hostProducerTarget.transportId
          && handoff.apply(source.hostProducerTarget, [action]) === "applied";
        if (!applied) {
          handoff.forceTerminal({
            kind: "target_failure",
            target: source.hostProducerTarget,
            reason: "client_broker_host_action_rejected",
          });
          receipt = "rejected";
        }
        continue;
      }
      if (this.applyBrokerAction(action) !== "applied") receipt = "rejected";
    }
    return receipt;
  }

  private isHostAction(action: RelayV2BrokerAction): action is Extract<
    RelayV2BrokerAction,
    { transportId: string }
  > {
    return action.kind === "host_output_ready"
      || action.kind === "send_host"
      || action.kind === "close_host"
      || action.kind === "pause_host_route"
      || action.kind === "resume_host_route";
  }

  private applyClientAction(
    action: Exclude<RelayV2BrokerAction, { transportId: string }>,
  ): RelayV2BrokerClientSocketEffectReceipt {
    const entry = this.clients.get(action.connectionId);
    if (
      !entry
      || entry.connectionIncarnation !== action.connectionIncarnation
      || entry.phase === "closed"
    ) return "rejected";
    switch (action.kind) {
      case "route_opened":
        if (entry.phase !== "open") return "rejected";
        entry.routeOpened = true;
        // Deliberately no relay.welcome/capability fabrication here.
        return "applied";
      case "pause_client":
        return this.setPaused(entry, true);
      case "resume_client":
        return this.setPaused(entry, false);
      case "close_client":
        return this.beginBoundedClose(entry, action.closeCode, action.reason);
      case "route_unavailable": {
        let bytes: Uint8Array;
        try {
          bytes = encodeRelayV2WebSocketFrame("public", {
            protocolVersion: 2,
            kind: "event",
            type: "relay.unavailable",
            hostId: action.hostId,
            payload: { error: structuredClone(action.error) },
          });
        } catch {
          return this.beginBoundedClose(
            entry,
            action.closeCode,
            "route_unavailable_encoding_failure",
          );
        }
        return this.beginBoundedClose(
          entry,
          action.closeCode,
          "route_unavailable",
          bytes,
        );
      }
    }
  }

  private setPaused(
    entry: ClientEntry,
    paused: boolean,
  ): RelayV2BrokerClientSocketEffectReceipt {
    if (!this.isCurrentOpen(entry)) return "rejected";
    if (entry.pauseTransition) {
      if (entry.pauseTransition.desired === paused) return "applied";
      this.beginBoundedClose(entry, 1013, "client_pause_reentrant_conflict");
      return "rejected";
    }
    if (entry.paused === paused) return "applied";
    const method = paused ? entry.socket.pause : entry.socket.resume;
    const transition = Object.freeze({ token: randomUUID(), desired: paused });
    entry.pauseTransition = transition;
    let receipt: unknown = "rejected";
    try {
      if (!this.isCurrentOpen(entry) || entry.pauseTransition !== transition) {
        throw new Error("stale client pause transition");
      }
      receipt = Reflect.apply(method, entry.socket.receiver, []);
    } catch {
      receipt = "rejected";
    }
    if (
      receipt !== "applied"
      || !this.isCurrentOpen(entry)
      || entry.pauseTransition !== transition
    ) {
      if (entry.pauseTransition === transition) entry.pauseTransition = null;
      this.beginBoundedClose(entry, 1013, paused
        ? "client_pause_rejected"
        : "client_resume_rejected");
      return "rejected";
    }
    entry.pauseTransition = null;
    entry.paused = paused;
    return "applied";
  }

  private beginBoundedClose(
    entry: ClientEntry,
    code: number,
    reason: string,
    terminalBytes?: Uint8Array,
  ): RelayV2BrokerClientSocketEffectReceipt {
    if (entry.phase === "closed") return "rejected";
    if (entry.phase === "closing") return "applied";
    if (this.clients.get(entry.connectionId) !== entry) return "rejected";
    entry.phase = "closing";
    entry.pendingReadyFence = null;
    entry.pauseTransition = null;
    if (entry.outbound) this.cancelDeliveryDeadline(entry.outbound);
    entry.outbound = null;
    this.unbindOnce(entry, reason === "route_unavailable" ? "broker_shutdown" : "protocol_error");

    if (!this.armCloseDeadline(entry)) return "rejected";
    if (!this.isCurrentClosing(entry)) return "rejected";
    if (terminalBytes) return this.sendTerminalThenClose(entry, terminalBytes, code, reason);
    return this.requestSocketClose(entry, code, reason);
  }

  private armCloseDeadline(entry: ClientEntry): boolean {
    const deadline: CloseDeadline = {
      token: randomUUID(),
      cancel: null,
      armed: false,
      firedEarly: false,
    };
    entry.closeDeadline = deadline;
    try {
      const cancel = this.scheduler.schedule(this.closeTimeoutMs, () => {
        if (!deadline.armed) {
          deadline.firedEarly = true;
          return;
        }
        this.closeDeadlineElapsed(entry, deadline.token);
      });
      if (typeof cancel !== "function") {
        throw new Error("invalid Relay v2 close deadline cancellation receipt");
      }
      deadline.cancel = cancel;
      deadline.armed = true;
    } catch {
      if (entry.closeDeadline === deadline) entry.closeDeadline = null;
      this.forceDestroy(entry);
      return false;
    }
    if (deadline.firedEarly) {
      this.closeDeadlineElapsed(entry, deadline.token);
      return false;
    }
    return true;
  }

  private closeDeadlineElapsed(entry: ClientEntry, token: string): void {
    const deadline = entry.closeDeadline;
    if (
      !deadline
      || deadline.token !== token
      || !deadline.armed
      || !this.isCurrentClosing(entry)
    ) return;
    this.cancelCloseDeadline(entry);
    this.forceDestroy(entry);
  }

  private cancelCloseDeadline(entry: ClientEntry): void {
    const deadline = entry.closeDeadline;
    entry.closeDeadline = null;
    const cancel = deadline?.cancel;
    if (!cancel) return;
    try {
      Reflect.apply(cancel, undefined, []);
    } catch {
      // The exact owner is already fenced; a hostile cancellation receipt is
      // not allowed to reopen it or escape terminal cleanup.
    }
  }

  private sendTerminalThenClose(
    entry: ClientEntry,
    source: Uint8Array,
    code: number,
    reason: string,
  ): RelayV2BrokerClientSocketEffectReceipt {
    const buffer = this.socketBufferState(entry);
    if (
      !buffer
      || buffer.frames + 1 > RELAY_V2_BROKER_LIMITS.maxQueuedRouteFrames
      || buffer.bytes + source.byteLength
        > RELAY_V2_BROKER_LIMITS.routeBufferedBytesPerDirection
      || !this.isCurrentClosing(entry)
    ) return this.requestSocketClose(entry, code, reason);
    const token = randomUUID();
    entry.terminalWriteToken = token;
    let sendReturned = false;
    let accepted = false;
    let earlyObserved = false;
    let early: unknown;
    const complete = (receipt: RelayV2BrokerClientSocketWriteCompletion) => {
      if (!sendReturned) {
        if (!earlyObserved) {
          earlyObserved = true;
          early = receipt;
        }
        return;
      }
      if (!accepted) return;
      this.completeTerminalWrite(entry, token, receipt, code, reason);
    };
    let receipt: unknown = "rejected";
    try {
      if (!this.isCurrentClosing(entry) || entry.terminalWriteToken !== token) {
        throw new Error("stale terminal socket write");
      }
      receipt = Reflect.apply(entry.socket.send, entry.socket.receiver, [source.slice(), complete]);
    } catch {
      receipt = "rejected";
    }
    sendReturned = true;
    accepted = receipt === "applied"
      && this.isCurrentClosing(entry)
      && entry.terminalWriteToken === token;
    if (!accepted) {
      entry.terminalWriteToken = null;
      return this.requestSocketClose(entry, code, reason);
    }
    if (earlyObserved) this.completeTerminalWrite(entry, token, early, code, reason);
    return "applied";
  }

  private completeTerminalWrite(
    entry: ClientEntry,
    token: string,
    receipt: unknown,
    code: number,
    reason: string,
  ): void {
    if (
      entry.terminalWriteToken !== token
      || !this.isCurrentClosing(entry)
    ) return;
    entry.terminalWriteToken = null;
    if (receipt === "delivered") {
      this.requestSocketClose(entry, code, reason);
    } else {
      this.forceDestroy(entry);
    }
  }

  private requestSocketClose(
    entry: ClientEntry,
    code: number,
    reason: string,
  ): RelayV2BrokerClientSocketEffectReceipt {
    if (!this.isCurrentClosing(entry)) return "rejected";
    if (entry.closeRequested) return "applied";
    entry.closeRequested = true;
    let receipt: unknown = "rejected";
    try {
      if (!this.isCurrentClosing(entry)) return "rejected";
      receipt = Reflect.apply(entry.socket.close, entry.socket.receiver, [code, reason]);
    } catch {
      receipt = "rejected";
    }
    if (receipt === "applied") return "applied";
    return this.forceDestroy(entry);
  }

  private forceDestroy(entry: ClientEntry): RelayV2BrokerClientSocketEffectReceipt {
    if (!this.isCurrentClosing(entry)) return "rejected";
    if (entry.forceDestroyRequested) return "applied";
    entry.forceDestroyRequested = true;
    let receipt: unknown = "rejected";
    try {
      if (!this.isCurrentClosing(entry)) return "rejected";
      receipt = Reflect.apply(entry.socket.forceDestroy, entry.socket.receiver, []);
    } catch {
      receipt = "rejected";
    } finally {
      this.finalize(entry);
    }
    return receipt === "applied" ? "applied" : "rejected";
  }

  private closed(entry: ClientEntry): RelayV2BrokerResult {
    if (this.clients.get(entry.connectionId) === entry && entry.phase === "open") {
      entry.phase = "closing";
    }
    const result = this.unbindOnce(entry, "client_closed");
    this.finalize(entry);
    return result;
  }

  private errored(entry: ClientEntry): RelayV2BrokerResult {
    if (!entry.managed) {
      if (entry.phase === "open") {
        this.beginBoundedClose(entry, 1013, "client_socket_error");
      }
      return this.unbindOnce(entry, "protocol_error");
    }
    if (this.clients.get(entry.connectionId) === entry && entry.phase === "open") {
      entry.phase = "closing";
    }
    const result = this.unbindOnce(entry, "protocol_error");
    this.finalize(entry);
    return result;
  }

  private unbindOnce(
    entry: ClientEntry,
    reason: Parameters<RelayV2BrokerCore["unbindClient"]>[1],
  ): RelayV2BrokerResult {
    if (entry.unbindStarted) return entry.unbindResult ?? rejectedBrokerResult();
    entry.unbindStarted = true;
    if (this.clients.get(entry.connectionId) !== entry) {
      entry.unbindResult = rejectedBrokerResult();
      return entry.unbindResult;
    }
    try {
      entry.unbindResult = this.runEntryBrokerCall(entry, () => (
        this.broker.unbindClient(entry.connectionId, reason)
      ));
    } catch {
      entry.unbindResult = rejectedBrokerResult();
    }
    return entry.unbindResult;
  }

  private socketBufferState(
    entry: ClientEntry,
  ): RelayV2BrokerClientSocketBufferState | undefined {
    try {
      if (this.clients.get(entry.connectionId) !== entry || entry.phase === "closed") {
        return undefined;
      }
      return readBufferState(Reflect.apply(
        entry.socket.bufferedState,
        entry.socket.receiver,
        [],
      ));
    } catch {
      return undefined;
    }
  }

  private isCurrentOpen(entry: ClientEntry): boolean {
    return entry.phase === "open" && this.clients.get(entry.connectionId) === entry;
  }

  private isCurrentClosing(entry: ClientEntry): boolean {
    return entry.phase === "closing" && this.clients.get(entry.connectionId) === entry;
  }

  private finalize(entry: ClientEntry): void {
    if (entry.phase === "closed") return;
    entry.phase = "closed";
    this.cancelCloseDeadline(entry);
    if (entry.outbound) this.cancelDeliveryDeadline(entry.outbound);
    entry.outbound = null;
    entry.pendingReadyFence = null;
    entry.pauseTransition = null;
    entry.terminalWriteToken = null;
    if (this.clients.get(entry.connectionId) === entry) {
      this.clients.delete(entry.connectionId);
    }
  }
}

/**
 * The only construction surface for this default-off transport. The ready
 * consumer closure exists before Core construction, and neither object can
 * escape until the Core reference has been bound back into the adapter.
 */
export function createRelayV2BrokerClientSocketTransportComposition(
  options: RelayV2BrokerClientSocketTransportCompositionOptions,
): RelayV2BrokerClientSocketTransportComposition {
  let readyConsumer: ((fence: RelayV2BrokerOutputReadyFence) => void) | null = null;
  const transport = new RelayV2BrokerClientSocketTransportImpl(options, (consumer) => {
    if (readyConsumer) throw new Error("Relay v2 Broker ready consumer already installed");
    readyConsumer = consumer;
  });
  if (!readyConsumer) throw new Error("Relay v2 Broker ready consumer was not installed");
  const outputReadyPort: RelayV2BrokerOutputReadyPort = Object.freeze({
    ready(fence: RelayV2BrokerOutputReadyFence): void {
      // Only the module-owned consumer is reachable here; no injected
      // scheduler, resolver, socket, registry, or Core call occurs inline.
      readyConsumer!(fence);
    },
  });
  const broker = new RelayV2BrokerCore({
    ...options.brokerOptions,
    outputReadyPort,
  });
  transport.bindBroker(broker);
  return Object.freeze({
    broker,
    clientSocketTransport: transport,
  });
}
