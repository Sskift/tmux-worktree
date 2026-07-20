import { randomUUID } from "node:crypto";
import { RELAY_V2_CARRIER_ROUTE_HARD_LIMIT } from "./carrierLimits.js";
import {
  type RelayV2BrokerAction,
  type RelayV2BrokerConnectionAuthorization,
  type RelayV2BrokerResult,
  type RelayV2CarrierDelivery,
  type RelayV2BrokerCore,
} from "./brokerCore.js";
import {
  type RelayV2BrokerHostProducerBinding,
  type RelayV2BrokerPreparedCall,
  type RelayV2BrokerProducerAction,
  type RelayV2BrokerProducerEffectFence,
  type RelayV2BrokerProducerPort,
  type RelayV2BrokerProducerReceipt,
  type RelayV2BrokerProducerRegistration,
  type RelayV2BrokerProducerRegistry,
  type RelayV2BrokerProducerHandoff,
  type RelayV2BrokerProducerTarget,
  type RelayV2BrokerProducerTerminalFailure,
} from "./brokerProducerRegistry.js";
import {
  decodeRelayV2WebSocketFrame,
  encodeRelayV2WebSocketFrame,
} from "./codec.js";
import type {
  RelayV2HostCarrierActor,
  RelayV2HostCarrierConnection,
  RelayV2HostCarrierTransport,
} from "./hostCarrier.js";

const PRESSURE_TIMEOUT_MS = 5_000;
const DEFAULT_DELIVERY_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 16 * 1_048_576;
const MANDATORY_ACTION_BYTES_HARD_FLOOR = 1_048_576;
const MAX_EMERGENCY_ACTION_BYTES = 16 * 1_048_576;

export type RelayV2CarrierPumpDirection = "host_to_broker" | "broker_to_host";

export interface RelayV2CarrierPumpQueueLimits {
  maxBytesPerDirection?: number;
  lowWaterBytesPerDirection?: number;
  maxFramesPerDirection?: number;
  lowWaterFramesPerDirection?: number;
  controlReserveBytesPerDirection?: number;
  controlReserveFramesPerDirection?: number;
  maxBytesPerRoute?: number;
  maxFramesPerRoute?: number;
  maxPendingActions?: number;
  maxPendingActionBytes?: number;
}

export type RelayV2CarrierPumpBrokerPort = Readonly<Pick<
  RelayV2BrokerCore,
  | "attachHostCarrier"
  | "receiveHostFrame"
  | "drainHostCarrier"
  | "acknowledgeHostControlDelivery"
  | "acknowledgeHostDelivery"
  | "sweepBackpressure"
  | "disconnectHost"
>>;

export interface RelayV2CarrierPumpOptions {
  broker: RelayV2CarrierPumpBrokerPort;
  host: RelayV2HostCarrierActor;
  transportId: string;
  hostAuthContext: RelayV2BrokerConnectionAuthorization;
  credentialReference: string;
  queueLimits?: RelayV2CarrierPumpQueueLimits;
  deliveryTimeoutMs?: number;
  now?: () => number;
  /** The callback must run asynchronously. It returns a cancellation fence. */
  schedule?: (delayMs: number, callback: () => void) => () => void;
  /** Client socket/read-side effects stay outside both carrier state owners. */
  onBrokerAction?: (
    action: RelayV2BrokerAction,
    signal: AbortSignal,
    fence: RelayV2BrokerActionFence,
  ) => void | Promise<void>;
  /**
   * Installs the same socket owner's irreversible identity fence and applies
   * the cleanup synchronously. Only literal true is a successful receipt.
   */
  onForceBrokerAction: (
    action: RelayV2BrokerAction,
    fence: RelayV2BrokerActionFence,
  ) => boolean;
  /**
   * Opt-in B7a owner. Omission preserves the standalone Pump foundation and
   * does not wire a listener, server, capability, or production composition.
   */
  producerRegistry?: RelayV2BrokerProducerRegistry;
}

export type RelayV2BrokerHostCarrierPumpProducerComposition = Readonly<{
  target: RelayV2BrokerProducerTarget;
  binding: RelayV2BrokerHostProducerBinding;
}>;

export interface RelayV2BrokerActionFence {
  readonly identity: string;
  readonly generation: string;
  /** Socket owners must check this immediately before applying async effects. */
  mayApply(): boolean;
}

/**
 * Bounded receipt for carrier queues and mutation/action fences. It does not
 * cancel a persistent auth-authority transaction already handed off by Broker.
 */
export type RelayV2CarrierPumpCloseReceipt = Readonly<{
  outcome: "closed" | "terminal_failure";
  code: number;
  reason: string;
  failedMandatoryActions: number;
}>;

export interface RelayV2CarrierPumpSnapshot {
  phase: "idle" | "running" | "closing" | "closed" | "terminal_failure";
  hostToBroker: { frames: number; bytes: number };
  brokerToHost: { frames: number; bytes: number };
  blockedHostRoutes: string[];
  pausedClients: string[];
  pendingActions: number;
  pendingActionBytes: number;
  mandatoryActions: number;
  mandatoryActionBytes: number;
  inFlightHostDelivery: boolean;
  inFlightBrokerAction: boolean;
  inFlightCloseActions: number;
  closeActionFailures: number;
  scheduledTimers: number;
  closeCode: number | null;
  closeReason: string | null;
  terminalFailure: string | null;
}

interface PumpLimits {
  maxBytes: number;
  lowWaterBytes: number;
  maxFrames: number;
  lowWaterFrames: number;
  controlReserveBytes: number;
  controlReserveFrames: number;
  maxBytesPerRoute: number;
  maxFramesPerRoute: number;
  maxPendingActions: number;
  maxPendingActionBytes: number;
  maxMandatoryActions: number;
  maxMandatoryActionBytes: number;
}

type PumpFrame = {
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  /** Decoded public payload bytes; carrier controls are zero. */
  readonly routeByteLength: number;
  readonly type: string;
  readonly routeId: string | null;
  readonly control: boolean;
  state: "pending" | "processing" | "complete";
};

type HostFrame = PumpFrame & {
  readonly deliveryToken: string;
};

type BrokerFrame = PumpFrame & {
  readonly deliveryId: string | null;
  readonly registrationFence: boolean;
};

type DirectionState<T extends PumpFrame> = {
  entries: T[];
  bytes: number;
  routeCursor: number;
  pressureSinceMs: number | null;
};

type AsyncAttempt = {
  readonly generation: number;
  readonly id: number;
  readonly abort: AbortController;
  readonly cancelDeadline: () => void;
};

type PreparedCallHolder = {
  call: RelayV2BrokerPreparedCall | null;
};

type HostDeliveryAttempt = AsyncAttempt & {
  readonly deliveryToken: string;
  readonly preparedCallHolder: PreparedCallHolder;
};

type PendingAction = {
  readonly action: RelayV2BrokerAction;
  readonly bytes: number;
  readonly mandatory: boolean;
  readonly ownerFence: OwnerFenceState;
  readonly emergency: boolean;
  state: "pending" | "processing";
};

type BrokerActionAttempt = AsyncAttempt & {
  readonly entry: PendingAction;
};

type CloseAction = {
  readonly action: RelayV2BrokerAction;
  readonly bytes: number;
  readonly id: number;
  readonly dedupeKey: string;
  readonly ownerFence: OwnerFenceState;
  readonly emergency: boolean;
  state: "pending" | "inflight" | "settled" | "forcing" | "forced" | "force_failed";
};

type RetiredBrokerActionAttempt = {
  readonly generation: number;
  readonly id: number;
  readonly entry: PendingAction;
};

type OwnerFenceState = {
  readonly identity: string;
  readonly generation: string;
  readonly view: RelayV2BrokerActionFence;
  fenced: boolean;
};

type ProducerReadyTurn = Readonly<{
  readyEpoch: string;
}>;

function takePreparedCall(
  holder: PreparedCallHolder,
): RelayV2BrokerPreparedCall | null {
  const preparedCall = holder.call;
  holder.call = null;
  return preparedCall;
}

function positive(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new Error("Relay v2 carrier pump limits must be positive safe integers");
  }
  return selected;
}

function makeLimits(input: RelayV2CarrierPumpQueueLimits = {}): PumpLimits {
  const maxBytes = positive(input.maxBytesPerDirection, DEFAULT_MAX_BYTES);
  const lowWaterBytes = positive(input.lowWaterBytesPerDirection, 8 * 1_048_576);
  const maxFrames = positive(input.maxFramesPerDirection, 1_024);
  const lowWaterFrames = positive(input.lowWaterFramesPerDirection, 512);
  const controlReserveBytes = positive(input.controlReserveBytesPerDirection, 65_536);
  const controlReserveFrames = positive(input.controlReserveFramesPerDirection, 16);
  const maxBytesPerRoute = positive(input.maxBytesPerRoute, 1_048_576);
  const maxFramesPerRoute = positive(input.maxFramesPerRoute, 128);
  const maxPendingActions = positive(input.maxPendingActions, 256);
  const maxPendingActionBytes = positive(input.maxPendingActionBytes, 1_048_576);
  if (maxBytes > DEFAULT_MAX_BYTES
    || lowWaterBytes >= maxBytes
    || controlReserveBytes >= maxBytes
    || lowWaterFrames >= maxFrames
    || controlReserveFrames >= maxFrames
    || maxBytesPerRoute > maxBytes
    || maxFramesPerRoute > maxFrames) {
    throw new Error("Relay v2 carrier pump queue watermarks are invalid");
  }
  return {
    maxBytes,
    lowWaterBytes,
    maxFrames,
    lowWaterFrames,
    controlReserveBytes,
    controlReserveFrames,
    maxBytesPerRoute,
    maxFramesPerRoute,
    maxPendingActions,
    maxPendingActionBytes,
    // Mandatory cleanup has a separate reserve but stays in the same registry.
    // Every legal configuration admits BrokerCore's bounded route cleanups
    // plus its single carrier close without using the emergency entry.
    maxMandatoryActions: Math.max(
      maxPendingActions + controlReserveFrames,
      RELAY_V2_CARRIER_ROUTE_HARD_LIMIT + 1,
    ),
    // One MiB covers the fixed 256-route producer bound even when every
    // 128-byte identifier expands to its canonical JSON escape form. It is
    // independent from the ordinary action byte budget and remains finite.
    maxMandatoryActionBytes: Math.max(
      maxPendingActionBytes,
      MANDATORY_ACTION_BYTES_HARD_FLOOR,
    ),
  };
}

function safeNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Relay v2 carrier pump clock returned an invalid timestamp");
  }
  return value;
}

type ActionSinkAssimilation =
  | { kind: "synchronous" }
  | { kind: "rejected" }
  | { kind: "pending"; settlement: Promise<void> };

function assimilateActionSinkResult(result: unknown): ActionSinkAssimilation {
  if (result === undefined) return { kind: "synchronous" };
  let then: unknown;
  try {
    then = (result as { then?: unknown }).then;
  } catch {
    return { kind: "rejected" };
  }
  if (typeof then !== "function") return { kind: "rejected" };
  const settlement = new Promise<void>((resolve, reject) => {
    try {
      Reflect.apply(then, result, [() => resolve(), (error: unknown) => reject(error)]);
    } catch (error) {
      reject(error);
    }
  });
  return { kind: "pending", settlement };
}

function frameIdentity(bytes: Uint8Array): {
  type: string;
  routeId: string | null;
  control: boolean;
  routeByteLength: number;
} {
  const frame = decodeRelayV2WebSocketFrame("carrier", bytes, {
    opcode: "text",
    compressed: false,
  }).frame;
  const type = frame.type as string;
  const routeByteLength = type === "route.data"
    ? Buffer.from((frame.payload as { data: string }).data, "base64").byteLength
    : 0;
  return {
    type,
    routeId: typeof frame.routeId === "string" ? frame.routeId : null,
    control: type !== "route.data",
    routeByteLength,
  };
}

function routeUsage<T extends PumpFrame>(
  state: DirectionState<T>,
  routeId: string,
): { frames: number; bytes: number } {
  let frames = 0;
  let bytes = 0;
  for (const entry of state.entries) {
    if (entry.routeId !== routeId || entry.control) continue;
    frames += 1;
    bytes += entry.routeByteLength;
  }
  return { frames, bytes };
}

/**
 * Bounded asynchronous ownership adapter between the production broker core
 * and production host carrier actor. It owns only delivery queues, ACK fences,
 * scheduling and shutdown. Connector, route, sequence, dialect and business
 * authority remain in the two cores.
 */
export class RelayV2BrokerHostCarrierPump implements RelayV2HostCarrierTransport {
  private readonly limits: PumpLimits;
  private readonly deliveryTimeoutMs: number;
  private readonly now: () => number;
  private readonly schedule: (delayMs: number, callback: () => void) => () => void;
  private readonly connectionIncarnation: string | null;
  private producerRegistration: RelayV2BrokerProducerRegistration | null = null;
  private producerCloseStarted = false;
  private disconnectPreparedCall: RelayV2BrokerPreparedCall | null = null;
  private disconnectCallPreparationAttempted = false;
  private pendingProducerReadyTurn: ProducerReadyTurn | null = null;
  private readonly hostToBroker: DirectionState<HostFrame> = {
    entries: [], bytes: 0, routeCursor: 0, pressureSinceMs: null,
  };
  private readonly brokerToHost: DirectionState<BrokerFrame> = {
    entries: [], bytes: 0, routeCursor: 0, pressureSinceMs: null,
  };
  private readonly blockedHostRoutes = new Set<string>();
  private readonly pausedClients = new Set<string>();
  private readonly pendingActions: PendingAction[] = [];
  private pendingActionBytes = 0;
  private mandatoryActionBytes = 0;
  private mandatoryActionCount = 0;
  private readonly ownerFenceStates = new Map<string, Set<OwnerFenceState>>();
  private hostConnection: RelayV2HostCarrierConnection | null = null;
  private phase: RelayV2CarrierPumpSnapshot["phase"] = "idle";
  private pumpTimer: { cancel: () => void } | null = null;
  private pressureTimer: { deadlineMs: number; cancel: () => void } | null = null;
  private ackTimer: { cancel: () => void } | null = null;
  private closeTimer: { cancel: () => void } | null = null;
  private closeAdmissionTimer: { cancel: () => void } | null = null;
  private lifecycleGeneration = 1;
  private nextAttemptId = 0;
  private hostDeliveryAttempt: HostDeliveryAttempt | null = null;
  private brokerActionAttempt: BrokerActionAttempt | null = null;
  private retiredBrokerActionAttempt: RetiredBrokerActionAttempt | null = null;
  private closeActionsPrepared = false;
  private closeActionAbort: AbortController | null = null;
  private closeActions: CloseAction[] = [];
  private closeActionBytes = 0;
  private closeDrainGeneration = 0;
  private closeActionFailures = 0;
  private terminalFailureReason: string | null = null;
  private closeAdmissionSealed = false;
  private brokerDisconnected = false;
  private actionAdmissionStopped = false;
  private forceCallbackActive = false;
  private readonly completedCloseActionKeys: string[] = [];
  private running = false;
  private hostWritable = true;
  private brokerWritable = true;
  private notifyHostWritable = false;
  private closeRequest: {
    code: number;
    reason: string;
    drainBrokerControl: boolean;
  } | null = null;
  private closedWith: { code: number; reason: string } | null = null;
  private closeBarrierSettled = false;
  private resolveCloseBarrier!: (receipt: RelayV2CarrierPumpCloseReceipt) => void;
  private closeBarrier: Promise<RelayV2CarrierPumpCloseReceipt>;
  readonly producerComposition: RelayV2BrokerHostCarrierPumpProducerComposition | null;

  constructor(private readonly options: RelayV2CarrierPumpOptions) {
    this.limits = makeLimits(options.queueLimits);
    this.deliveryTimeoutMs = positive(
      options.deliveryTimeoutMs,
      DEFAULT_DELIVERY_TIMEOUT_MS,
    );
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? ((delayMs, callback) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return () => clearTimeout(timer);
    });
    this.closeBarrier = new Promise((resolve) => {
      this.resolveCloseBarrier = resolve;
    });
    if (options.producerRegistry) {
      this.connectionIncarnation = randomUUID();
      const port = Object.create(null) as Record<string, unknown>;
      Object.defineProperties(port, {
        apply: {
          value: (
            actions: readonly Readonly<RelayV2BrokerProducerAction>[],
            fence: RelayV2BrokerProducerEffectFence,
          ) => this.applyProducerActions(actions, fence),
        },
        forceTerminal: {
          value: (
            failure: RelayV2BrokerProducerTerminalFailure,
            fence: RelayV2BrokerProducerEffectFence,
          ) => this.forceProducerTerminal(failure, fence),
        },
      });
      const registration = options.producerRegistry.registerHostProducer(
        options.transportId,
        port as unknown as RelayV2BrokerProducerPort,
      );
      const binding = registration.bindConnectionIncarnation(this.connectionIncarnation);
      this.producerRegistration = registration;
      this.producerComposition = Object.freeze({
        target: registration.target,
        binding,
      });
    } else {
      this.connectionIncarnation = null;
      this.producerComposition = null;
    }
  }

  start(): RelayV2HostCarrierConnection {
    if (this.phase !== "idle") throw new Error("Relay v2 carrier pump already started");
    this.phase = "running";
    let attached = false;
    try {
      if (this.connectionIncarnation === null) {
        this.options.broker.attachHostCarrier(
          this.options.transportId,
          this.options.hostAuthContext,
        );
      } else {
        this.options.broker.attachHostCarrier(
          this.options.transportId,
          this.options.hostAuthContext,
          this.connectionIncarnation,
        );
      }
      attached = true;
      this.hostConnection = this.options.host.connect(
        this,
        this.options.credentialReference,
      );
    } catch (error) {
      const disconnectPrepared = !attached || this.prepareDisconnectBrokerCall();
      // Start failure is a terminal owner cut too. Publish it locally and to
      // B7a before rollback can invoke another component.
      this.pendingProducerReadyTurn = null;
      this.lifecycleGeneration += 1;
      this.phase = "closed";
      this.closedWith = { code: 1013, reason: "carrier_pump_start_failure" };
      this.beginProducerClose();
      if (attached && !disconnectPrepared) {
        this.terminalFailureReason = "broker_disconnect_provenance_unavailable";
        this.phase = "terminal_failure";
      } else if (attached) {
        const disconnected = this.disconnectBrokerForClose();
        if (disconnected) {
          for (const action of disconnected.actions) {
            if (this.producerComposition && this.isHostProducerAction(action)) continue;
            if (!this.forceStartRollbackAction(action)) {
              this.terminalFailureReason = "start_rollback_cleanup_rejected";
              this.phase = "terminal_failure";
            }
          }
        } else {
          this.terminalFailureReason = "broker_disconnect_failure";
          this.phase = "terminal_failure";
        }
      }
      this.hostToBroker.entries = [];
      this.hostToBroker.bytes = 0;
      this.brokerToHost.entries = [];
      this.brokerToHost.bytes = 0;
      this.settleCloseBarrier(
        this.phase === "terminal_failure" ? "terminal_failure" : "closed",
      );
      throw error;
    }
    this.wake();
    return this.hostConnection;
  }

  snapshot(): RelayV2CarrierPumpSnapshot {
    return {
      phase: this.phase,
      hostToBroker: {
        frames: this.hostToBroker.entries.length,
        bytes: this.hostToBroker.bytes,
      },
      brokerToHost: {
        frames: this.brokerToHost.entries.length,
        bytes: this.brokerToHost.bytes,
      },
      blockedHostRoutes: [...this.blockedHostRoutes].sort(),
      pausedClients: [...this.pausedClients].sort(),
      pendingActions: this.pendingActions.length,
      pendingActionBytes: this.pendingActionBytes,
      mandatoryActions: this.mandatoryActionCount + this.closeActions.filter((entry) => (
        entry.state !== "settled" && entry.state !== "forced"
      )).length,
      mandatoryActionBytes: this.mandatoryActionBytes + this.closeActionBytes,
      inFlightHostDelivery: this.hostDeliveryAttempt !== null,
      inFlightBrokerAction: this.brokerActionAttempt !== null,
      inFlightCloseActions: this.closeActions.filter((entry) => (
        entry.state === "inflight"
      )).length,
      closeActionFailures: this.closeActionFailures,
      scheduledTimers: [
        this.pumpTimer,
        this.pressureTimer,
        this.ackTimer,
        this.closeTimer,
        this.closeAdmissionTimer,
        this.hostDeliveryAttempt,
        this.brokerActionAttempt,
      ].filter((value) => value !== null).length,
      closeCode: this.closedWith?.code ?? null,
      closeReason: this.closedWith?.reason ?? null,
      terminalFailure: this.terminalFailureReason,
    };
  }

  /** Feed edge-triggered results from broker client/socket operations. */
  acceptBrokerResult(result: RelayV2BrokerResult): void {
    if ((this.phase !== "running" && this.phase !== "closing")
      || this.actionAdmissionStopped || this.forceCallbackActive) return;
    const actions = this.producerComposition
      ? result.actions.filter((action) => !this.isHostProducerAction(action))
      : result.actions;
    this.acceptBrokerActions(actions, false);
    if (this.phase === "closing") {
      this.beginCloseDrain();
      this.advanceCloseDrain();
    } else {
      this.wake();
    }
  }

  /** Notify the adapter after a broker method queued carrier output. */
  writable(direction?: RelayV2CarrierPumpDirection): void {
    if (direction === "host_to_broker") {
      this.hostWritable = true;
      this.notifyHostWritable = true;
    }
    if (direction === "broker_to_host") this.brokerWritable = true;
    this.wake();
  }

  private producerFenceMayApply(fence: RelayV2BrokerProducerEffectFence): boolean {
    const composition = this.producerComposition;
    if (
      !composition
      || fence.target.transportId !== composition.target.transportId
      || fence.target.generation !== composition.target.generation
    ) return false;
    try {
      return fence.mayApply() === true;
    } catch {
      return false;
    }
  }

  private applyProducerActions(
    actions: readonly Readonly<RelayV2BrokerProducerAction>[],
    fence: RelayV2BrokerProducerEffectFence,
  ): RelayV2BrokerProducerReceipt {
    if (
      this.phase !== "running"
      || this.actionAdmissionStopped
      || this.forceCallbackActive
      || !this.producerFenceMayApply(fence)
      || actions.length === 0
    ) return "rejected";

    const ready = actions.filter((action) => action.kind === "host_output_ready");
    if (ready.length > 0) {
      if (
        actions.length !== 1
        || fence.source.kind !== "internal"
        || !this.acceptProducerReadyTurn(ready[0]!)
      ) return "rejected";
      return "applied";
    }

    // Preflight the whole ordinary batch before the first Pump mutation. A
    // close_host is the terminal item: this preserves BrokerCore's canonical
    // [terminal send_host, close_host] ordering and prevents a silently
    // skipped suffix. The existing Pump transition then owns the batch once.
    const closeCount = actions.filter((action) => action.kind === "close_host").length;
    if (
      closeCount > 1
      || (closeCount === 1 && actions.at(-1)?.kind !== "close_host")
      || actions.some((action) => !this.producerActionTargetsThisPump(action, fence))
      || !this.producerFenceMayApply(fence)
    ) return "rejected";
    this.acceptBrokerActions(actions, true);
    const phaseAfterApply = this.phase as RelayV2CarrierPumpSnapshot["phase"];
    if (phaseAfterApply === "closing") {
      this.beginCloseDrain();
      this.advanceCloseDrain();
    } else if (phaseAfterApply === "running") {
      this.wake();
    }
    return "applied";
  }

  private producerActionTargetsThisPump(
    action: Readonly<RelayV2BrokerProducerAction>,
    fence: RelayV2BrokerProducerEffectFence,
  ): boolean {
    if (action.kind === "host_output_ready") return false;
    if (action.transportId !== this.options.transportId) return false;
    let hasIncarnation = false;
    try {
      hasIncarnation = Reflect.getOwnPropertyDescriptor(
        action,
        "connectionIncarnation",
      ) !== undefined;
    } catch {
      return false;
    }
    if (hasIncarnation) {
      return action.connectionIncarnation === this.connectionIncarnation;
    }
    return action.kind === "close_host"
      && fence.source.kind === "host"
      && fence.source.transportId === this.options.transportId
      && fence.source.generation === fence.target.generation;
  }

  private acceptProducerReadyTurn(
    action: Extract<RelayV2BrokerProducerAction, { kind: "host_output_ready" }>,
  ): boolean {
    let keys: readonly PropertyKey[];
    try {
      keys = Reflect.ownKeys(action);
    } catch {
      return false;
    }
    if (
      keys.length !== 4
      || !keys.every((key) => (
        key === "kind"
        || key === "transportId"
        || key === "connectionIncarnation"
        || key === "readyEpoch"
      ))
      || action.transportId !== this.options.transportId
      || action.connectionIncarnation !== this.connectionIncarnation
      || !/^[1-9][0-9]*$/.test(action.readyEpoch)
      || this.phase !== "running"
    ) return false;
    // Multiple callbacks that arrive before the scheduled turn share one
    // bounded permit. A later real Core edge may reuse the same queue epoch
    // after this permit has been consumed (for example, after a delivery ACK).
    this.pendingProducerReadyTurn = Object.freeze({ readyEpoch: action.readyEpoch });
    this.wake();
    return true;
  }

  private forceProducerTerminal(
    failure: RelayV2BrokerProducerTerminalFailure,
    fence: RelayV2BrokerProducerEffectFence,
  ): RelayV2BrokerProducerReceipt {
    const composition = this.producerComposition;
    if (
      !composition
      || failure.target.transportId !== composition.target.transportId
      || failure.target.generation !== composition.target.generation
      || !this.producerFenceMayApply(fence)
      || this.phase === "closed"
      || this.phase === "terminal_failure"
    ) return "rejected";
    void this.shutdown(1013, "broker_producer_terminal_failure");
    return this.producerFenceMayApply(fence) ? "applied" : "rejected";
  }

  private isHostProducerAction(action: RelayV2BrokerAction): action is RelayV2BrokerProducerAction {
    return action.kind === "host_output_ready"
      || action.kind === "send_host"
      || action.kind === "close_host"
      || action.kind === "pause_host_route"
      || action.kind === "resume_host_route";
  }

  private applyPreparedBrokerResult(
    result: RelayV2BrokerResult,
    handoff: RelayV2BrokerProducerHandoff,
    applyLocalActions = true,
  ): RelayV2BrokerProducerReceipt {
    const localActions: RelayV2BrokerAction[] = [];
    const targetGroups = new Map<
      string,
      { target: RelayV2BrokerProducerTarget; actions: RelayV2BrokerProducerAction[] }
    >();
    let invalidResolution = false;
    let staleResolution = false;

    // Resolve every Host action before the first target Pump mutation. The
    // resolver is bound to the pre-invoke generation high-water, so a later
    // replacement can never become the target of this settled result.
    for (const action of result.actions) {
      if (!this.isHostProducerAction(action)) {
        localActions.push(action);
        continue;
      }
      const resolution = handoff.resolveHostActionTarget(action);
      if (resolution.status !== "resolved") {
        if (resolution.status === "invalid") invalidResolution = true;
        else staleResolution = true;
        continue;
      }
      const key = `${resolution.target.transportId}\0${resolution.target.generation}`;
      const group = targetGroups.get(key);
      if (group) group.actions.push(action);
      else targetGroups.set(key, { target: resolution.target, actions: [action] });
    }

    if (applyLocalActions && localActions.length > 0) {
      this.acceptBrokerActions(localActions, false);
    }

    let receipt: RelayV2BrokerProducerReceipt =
      invalidResolution || staleResolution ? "rejected" : "applied";
    let sourceFailureReason = invalidResolution
      ? "broker_result_host_provenance_invalid"
      : null;
    for (const group of targetGroups.values()) {
      if (handoff.apply(group.target, group.actions) === "applied") continue;
      receipt = "rejected";
      if (
        handoff.source.kind === "host"
        && handoff.source.transportId === group.target.transportId
        && handoff.source.generation === group.target.generation
      ) {
        sourceFailureReason ??= "broker_result_host_source_rejected";
      } else {
        handoff.forceTerminal({
          kind: "target_failure",
          target: group.target,
          reason: "broker_result_host_target_rejected",
        });
      }
    }
    // Invalid provenance belongs to the source, but it must not starve local
    // work or any independently resolved target group from the same result.
    // Multiple invalid actions collapse to one exact producer failure.
    if (sourceFailureReason) {
      handoff.forceTerminal({
        kind: "producer_failure",
        reason: sourceFailureReason,
      });
    }
    return receipt;
  }

  private invokeSynchronousBrokerCall<Result extends RelayV2BrokerResult>(
    invoke: () => Result,
    applyLocalActions = true,
  ): { result: Result; receipt: RelayV2BrokerProducerReceipt | null } {
    const prepared = this.producerRegistration?.prepareBrokerCall() ?? null;
    let result: Result;
    try {
      result = invoke();
    } catch (error) {
      prepared?.abandon();
      throw error;
    }
    if (!prepared) return { result, receipt: null };
    return {
      result,
      receipt: prepared.settle(
        result,
        (settled, handoff) => this.applyPreparedBrokerResult(
          settled,
          handoff,
          applyLocalActions,
        ),
      ),
    };
  }

  private beginProducerClose(): void {
    const registration = this.producerRegistration;
    if (!registration || this.producerCloseStarted) return;
    this.producerCloseStarted = true;
    registration.beginClose(this.closeBarrier);
  }

  private prepareDisconnectBrokerCall(): boolean {
    if (this.brokerDisconnected) return true;
    if (this.disconnectCallPreparationAttempted) {
      return this.producerComposition === null || this.disconnectPreparedCall !== null;
    }
    this.disconnectCallPreparationAttempted = true;
    try {
      this.disconnectPreparedCall = this.producerRegistration?.prepareBrokerCall() ?? null;
      return this.producerComposition === null || this.disconnectPreparedCall !== null;
    } catch {
      this.disconnectPreparedCall = null;
      return false;
    }
  }

  private forceStartRollbackAction(action: RelayV2BrokerAction): boolean {
    const ownerFence = this.createOwnerFence(action, this.lifecycleGeneration);
    this.installOwnerFence(ownerFence.identity);
    let accepted = false;
    this.forceCallbackActive = true;
    try {
      accepted = this.options.onForceBrokerAction(
        structuredClone(action),
        ownerFence.view,
      ) === true;
    } catch {
      accepted = false;
    } finally {
      this.forceCallbackActive = false;
      this.releaseOwnerFence(ownerFence);
    }
    return accepted;
  }

  setWritable(direction: RelayV2CarrierPumpDirection, writable: boolean): void {
    if (direction === "host_to_broker") {
      this.hostWritable = writable;
      if (writable) this.notifyHostWritable = true;
    } else {
      this.brokerWritable = writable;
    }
    if (writable) this.wake();
  }

  /** Deterministic sweep hook; production also schedules this automatically. */
  sweep(): void {
    if (this.phase !== "running") return;
    let call: ReturnType<typeof this.invokeSynchronousBrokerCall>;
    try {
      call = this.invokeSynchronousBrokerCall(() => (
        this.options.broker.sweepBackpressure(this.options.transportId)
      ));
    } catch {
      this.requestClose(1013, "broker_sweep_failure");
      this.beginCloseDrain();
      return;
    }
    const swept = call.result;
    if (call.receipt === null) this.acceptBrokerResult(swept);
    this.notifyHostWritable = true;
    if (swept.actions.length > 0) {
      // The route/carrier owners have started their close path. Give their
      // bounded control frames one secondary interval to settle before the
      // adapter closes the whole transport for an unacknowledged orphan.
      const now = safeNow(this.now);
      if (this.hostToBroker.pressureSinceMs !== null) {
        this.hostToBroker.pressureSinceMs = now;
      }
      if (this.brokerToHost.pressureSinceMs !== null) {
        this.brokerToHost.pressureSinceMs = now;
      }
      this.refreshPressureTimer();
    } else {
      this.evaluatePressure(true);
    }
    this.wake();
  }

  whenCloseSettled(): Promise<RelayV2CarrierPumpCloseReceipt> {
    return this.closeBarrier;
  }

  shutdown(
    code = 1000,
    reason = "carrier_pump_shutdown",
  ): Promise<RelayV2CarrierPumpCloseReceipt> {
    if (this.phase === "closed" || this.phase === "terminal_failure") {
      return this.closeBarrier;
    }
    this.requestClose(code, reason);
    this.beginCloseDrain();
    return this.closeBarrier;
  }

  /** RelayV2HostCarrierTransport: synchronous ownership transfer only. */
  trySend(frame: Uint8Array, deliveryToken: string): boolean {
    if (this.phase !== "running" || !this.hostWritable) return false;
    let identity: ReturnType<typeof frameIdentity>;
    try {
      identity = frameIdentity(frame);
    } catch {
      this.requestClose(4400, "invalid_host_carrier_frame");
      this.wake();
      return false;
    }
    if (!identity.control && identity.routeId !== null
      && this.blockedHostRoutes.has(identity.routeId)) {
      return false;
    }
    if (!this.canAdmit(
      this.hostToBroker,
      frame.byteLength,
      identity.routeByteLength,
      identity.routeId,
      identity.control,
    )) {
      this.notePressure(this.hostToBroker);
      return false;
    }
    this.hostToBroker.entries.push({
      bytes: frame.slice(),
      byteLength: frame.byteLength,
      routeByteLength: identity.routeByteLength,
      type: identity.type,
      routeId: identity.routeId,
      control: identity.control,
      state: "pending",
      deliveryToken,
    });
    this.hostToBroker.bytes += frame.byteLength;
    this.noteBoundaryPressure(this.hostToBroker, identity.routeId, identity.control);
    this.wake();
    return true;
  }

  /** Bytes accepted from HostCarrier and not yet removed before full-token ACK. */
  bufferedAmount(): number {
    return this.hostToBroker.bytes;
  }

  /** RelayV2HostCarrierTransport close callback. Never reenters synchronously. */
  close(code: number, reason: string): void {
    this.requestClose(code, reason);
    this.wake();
  }

  private canAdmit<T extends PumpFrame>(
    state: DirectionState<T>,
    bytes: number,
    routeBytes: number,
    routeId: string | null,
    control: boolean,
  ): boolean {
    const byteCeiling = this.limits.maxBytes - (control ? 0 : this.limits.controlReserveBytes);
    const frameCeiling = this.limits.maxFrames - (control ? 0 : this.limits.controlReserveFrames);
    if (bytes > byteCeiling - state.bytes || state.entries.length >= frameCeiling) return false;
    if (routeId !== null && !control) {
      const usage = routeUsage(state, routeId);
      if (routeBytes > this.limits.maxBytesPerRoute - usage.bytes
        || usage.frames >= this.limits.maxFramesPerRoute) return false;
    }
    return true;
  }

  private wake(): void {
    if (this.phase === "closed" || this.phase === "terminal_failure"
      || this.pumpTimer || this.running) return;
    const cancel = this.schedule(0, () => {
      if (this.pumpTimer?.cancel !== cancel) return;
      this.pumpTimer = null;
      this.run();
    });
    this.pumpTimer = { cancel };
  }

  private run(): void {
    if (this.running || this.phase === "closed") return;
    this.running = true;
    try {
      let producerDrainTurn = this.producerComposition === null
        || this.pendingProducerReadyTurn !== null;
      this.pendingProducerReadyTurn = null;
      let progressed = true;
      while (progressed && this.phase === "running") {
        progressed = false;
        if (this.notifyHostWritable && this.hostWritable && this.hostConnection) {
          this.notifyHostWritable = false;
          this.hostConnection.writable();
          progressed = true;
        }
        if (producerDrainTurn) {
          progressed = this.drainBrokerCore() || progressed;
          if (this.producerComposition !== null) producerDrainTurn = false;
        }
        progressed = this.deliverBrokerFrame() || progressed;
        if (this.closeRequest) break;
        progressed = this.deliverHostFrame() || progressed;
        progressed = this.dispatchAction() || progressed;
      }
      if (this.phase === "closing") {
        this.beginCloseDrain();
        while (this.canDrainBrokerControlNow() && this.deliverBrokerFrame()) {
          // Terminal carrier control is bounded by the close deadline.
        }
        this.advanceCloseDrain();
      } else {
        this.evaluatePressure(false);
      }
    } catch {
      this.requestClose(1013, "carrier_pump_failure");
      this.beginCloseDrain();
    } finally {
      this.running = false;
      if (this.hasImmediateWork()) this.wake();
    }
  }

  private drainBrokerCore(): boolean {
    if (this.phase !== "running") return false;
    const totalFrameCapacity = this.limits.maxFrames - this.brokerToHost.entries.length;
    const totalByteCapacity = this.limits.maxBytes - this.brokerToHost.bytes;
    if (totalFrameCapacity <= 0 || totalByteCapacity <= 0) return false;
    const controls = this.options.broker.drainHostCarrier(this.options.transportId, {
      maxFrames: 1,
      maxBytes: totalByteCapacity,
      controlOnly: true,
    });
    if (controls.length > 0) {
      this.enqueueBrokerDelivery(controls[0]!);
      return true;
    }
    const frameCapacity = this.limits.maxFrames
      - this.limits.controlReserveFrames
      - this.brokerToHost.entries.length;
    const byteCapacity = this.limits.maxBytes
      - this.limits.controlReserveBytes
      - this.brokerToHost.bytes;
    if (frameCapacity <= 0 || byteCapacity <= 0) return false;
    const deliveries = this.options.broker.drainHostCarrier(this.options.transportId, {
      maxFrames: 1,
      maxBytes: byteCapacity,
    });
    if (deliveries.length === 0) return false;
    this.enqueueBrokerDelivery(deliveries[0]!);
    return true;
  }

  private enqueueBrokerDelivery(delivery: RelayV2CarrierDelivery): void {
    const identity = frameIdentity(delivery.wire);
    if (!this.canAdmit(
      this.brokerToHost,
      delivery.wire.byteLength,
      identity.routeByteLength,
      identity.routeId,
      identity.control,
    )) {
      this.requestClose(1013, "broker_to_host_pump_overflow");
      return;
    }
    this.brokerToHost.entries.push({
      bytes: delivery.wire.slice(),
      byteLength: delivery.wire.byteLength,
      routeByteLength: identity.routeByteLength,
      type: identity.type,
      routeId: identity.routeId,
      control: identity.control,
      state: "pending",
      deliveryId: delivery.deliveryId,
      registrationFence: false,
    });
    this.brokerToHost.bytes += delivery.wire.byteLength;
    this.noteBoundaryPressure(this.brokerToHost, identity.routeId, identity.control);
  }

  private acceptBrokerActions(
    actions: readonly RelayV2BrokerAction[],
    hostProvenanceChecked: boolean,
  ): void {
    for (const action of actions) {
      if (this.phase === "closed" || this.phase === "terminal_failure"
        || this.actionAdmissionStopped) break;
      if (
        this.producerComposition
        && this.isHostProducerAction(action)
        && !hostProvenanceChecked
      ) continue;
      const mandatory = this.requiredDuringClose(action);
      if (this.phase === "closing" && !mandatory) continue;
      this.clearTerminalClientPressure(action);
      if (action.kind === "send_host") {
        if (action.transportId !== this.options.transportId) {
          this.queueAction(action);
          continue;
        }
        let bytes: Uint8Array;
        let identity: ReturnType<typeof frameIdentity>;
        try {
          bytes = encodeRelayV2WebSocketFrame("carrier", action.frame);
          identity = frameIdentity(bytes);
        } catch {
          this.requestClose(4400, "invalid_broker_carrier_frame");
          continue;
        }
        if (this.phase === "closing"
          && identity.type !== "carrier.error"
          && identity.type !== "host.superseded") {
          continue;
        }
        if (this.phase === "closing" && this.closeRequest) {
          this.closeRequest.drainBrokerControl = true;
        }
        if (!this.canAdmit(
          this.brokerToHost,
          bytes.byteLength,
          identity.routeByteLength,
          identity.routeId,
          identity.control,
        )) {
          this.notePressure(this.brokerToHost);
          this.requestClose(1013, "broker_control_pump_overflow");
          continue;
        }
        this.brokerToHost.entries.push({
          bytes,
          byteLength: bytes.byteLength,
          routeByteLength: identity.routeByteLength,
          type: identity.type,
          routeId: identity.routeId,
          control: identity.control,
          state: "pending",
          deliveryId: action.deliveryId ?? null,
          registrationFence: identity.type === "host.registered",
        });
        this.brokerToHost.bytes += bytes.byteLength;
        this.noteBoundaryPressure(this.brokerToHost, identity.routeId, identity.control);
        continue;
      }
      if (action.kind === "pause_host_route") {
        if (!this.blockedHostRoutes.has(action.routeId)
          && this.blockedHostRoutes.size >= this.limits.maxFrames) {
          this.requestClose(1013, "carrier_pump_pressure_source_overflow");
        }
        this.blockedHostRoutes.add(action.routeId);
        this.notePressure(this.hostToBroker);
      } else if (action.kind === "resume_host_route") {
        if (this.blockedHostRoutes.delete(action.routeId)) {
          this.notifyHostWritable = true;
        }
      } else if (action.kind === "pause_client") {
        if (!this.pausedClients.has(action.connectionId)
          && this.pausedClients.size >= this.limits.maxFrames) {
          this.requestClose(1013, "carrier_pump_pressure_source_overflow");
        }
        this.pausedClients.add(action.connectionId);
        this.notePressure(this.brokerToHost);
      } else if (action.kind === "resume_client") {
        this.pausedClients.delete(action.connectionId);
      } else if (action.kind === "close_host"
        && action.transportId === this.options.transportId) {
        const terminalControlQueued = this.brokerToHost.entries.some((entry) => (
          entry.type === "carrier.error" || entry.type === "host.superseded"
        ));
        this.requestClose(action.closeCode, action.reason, terminalControlQueued);
      }
      this.queueAction(action);
    }
  }

  private clearTerminalClientPressure(action: RelayV2BrokerAction): void {
    if (action.kind !== "close_client" && action.kind !== "route_unavailable") return;
    if (!this.pausedClients.delete(action.connectionId)) return;
    this.evaluatePressure(false);
  }

  private queueAction(action: RelayV2BrokerAction): void {
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(action), "utf8");
    } catch {
      this.requestClose(1013, "carrier_pump_action_encoding_failure");
      return;
    }
    const mandatory = this.requiredDuringClose(action);
    if (this.phase === "closing" && this.closeActionsPrepared) {
      if (!mandatory || this.actionAdmissionStopped) return;
      this.addCloseAction(
        action,
        bytes,
        this.createOwnerFence(action, this.lifecycleGeneration),
        "pending",
        false,
      );
      this.advanceCloseDrain();
      return;
    }
    const ordinaryCount = this.pendingActions.length - this.mandatoryActionCount;
    const ordinaryBytes = this.pendingActionBytes - this.mandatoryActionBytes;
    const admitted = mandatory
      ? this.mandatoryActionCount < this.limits.maxMandatoryActions
        && bytes <= this.limits.maxMandatoryActionBytes - this.mandatoryActionBytes
      : ordinaryCount < this.limits.maxPendingActions
        && bytes <= this.limits.maxPendingActionBytes - ordinaryBytes;
    if (!admitted && mandatory) {
      const emergencyAlreadyRegistered = this.pendingActions.some((entry) => entry.emergency);
      if (!emergencyAlreadyRegistered && bytes <= MAX_EMERGENCY_ACTION_BYTES) {
        this.pendingActions.push({
          action: structuredClone(action),
          bytes,
          mandatory: true,
          ownerFence: this.createOwnerFence(action, this.lifecycleGeneration),
          emergency: true,
          state: "pending",
        });
        this.pendingActionBytes += bytes;
        this.mandatoryActionCount += 1;
        this.mandatoryActionBytes += bytes;
        this.requestClose(1013, "carrier_pump_mandatory_action_overflow");
        this.beginCloseDrain();
      } else {
        this.requestClose(1013, "carrier_pump_mandatory_action_overflow");
        this.beginCloseDrain();
        if (this.phase === "closing") {
          this.addCloseAction(
            action,
            bytes,
            this.createOwnerFence(action, this.lifecycleGeneration),
            "pending",
            true,
          );
          this.advanceCloseDrain();
        }
      }
      return;
    }
    if (!admitted) {
      this.requestClose(1013, "carrier_pump_action_overflow");
      return;
    }
    this.pendingActions.push({
      action: structuredClone(action),
      bytes,
      mandatory,
      ownerFence: this.createOwnerFence(action, this.lifecycleGeneration),
      emergency: false,
      state: "pending",
    });
    this.pendingActionBytes += bytes;
    if (mandatory) {
      this.mandatoryActionCount += 1;
      this.mandatoryActionBytes += bytes;
    }
  }

  private brokerActionIdentity(action: RelayV2BrokerAction): string {
    if ("connectionId" in action) return `client:${action.connectionId}`;
    if (action.kind === "send_host") return `host-control:${action.transportId}`;
    if ("transportId" in action) return `host:${action.transportId}`;
    return `transport:${this.options.transportId}`;
  }

  private createOwnerFence(
    action: RelayV2BrokerAction,
    generation: number,
  ): OwnerFenceState {
    const identity = this.brokerActionIdentity(action);
    const state = {} as OwnerFenceState;
    const view = Object.freeze({
      identity,
      generation: `${this.options.transportId}:${generation}`,
      mayApply: () => !state.fenced,
    });
    Object.assign(state, {
      identity,
      generation: view.generation,
      view,
      fenced: false,
    });
    let states = this.ownerFenceStates.get(identity);
    if (!states) {
      states = new Set();
      this.ownerFenceStates.set(identity, states);
    }
    states.add(state);
    return state;
  }

  private installOwnerFence(identity: string): void {
    for (const state of this.ownerFenceStates.get(identity) ?? []) state.fenced = true;
  }

  private installAllOwnerFences(): void {
    for (const states of this.ownerFenceStates.values()) {
      for (const state of states) state.fenced = true;
    }
  }

  private releaseOwnerFence(state: OwnerFenceState): void {
    const states = this.ownerFenceStates.get(state.identity);
    states?.delete(state);
    if (states?.size === 0) this.ownerFenceStates.delete(state.identity);
  }

  private removePendingAction(entry: PendingAction, preserveFence = false): void {
    const index = this.pendingActions.indexOf(entry);
    if (index >= 0) this.pendingActions.splice(index, 1);
    this.pendingActionBytes = Math.max(0, this.pendingActionBytes - entry.bytes);
    if (entry.mandatory) {
      this.mandatoryActionCount = Math.max(0, this.mandatoryActionCount - 1);
      this.mandatoryActionBytes = Math.max(0, this.mandatoryActionBytes - entry.bytes);
    }
    if (!preserveFence) this.releaseOwnerFence(entry.ownerFence);
  }

  private dispatchAction(): boolean {
    if (this.brokerActionAttempt) return false;
    const entry = this.pendingActions[0];
    if (!entry || entry.state !== "pending") return false;
    const sink = this.options.onBrokerAction;
    if (!sink) {
      if (entry.mandatory) {
        this.requestClose(1013, "carrier_pump_missing_action_owner");
        this.beginCloseDrain();
        return true;
      }
      this.removePendingAction(entry);
      return true;
    }
    entry.state = "processing";
    const generation = this.lifecycleGeneration;
    const id = ++this.nextAttemptId;
    const abort = new AbortController();
    const weakPump = new WeakRef(this);
    const cancelDeadline = this.schedule(this.deliveryTimeoutMs, () => {
      weakPump.deref()?.timeoutBrokerAction(generation, id);
    });
    this.brokerActionAttempt = { generation, id, abort, cancelDeadline, entry };
    let result: void | Promise<void>;
    try {
      result = sink(structuredClone(entry.action), abort.signal, entry.ownerFence.view);
    } catch {
      this.failBrokerAction(generation, id);
      return true;
    }
    const assimilation = assimilateActionSinkResult(result);
    if (assimilation.kind === "synchronous") {
      this.completeBrokerAction(generation, id);
      return true;
    }
    if (assimilation.kind === "rejected") {
      this.failBrokerAction(generation, id);
      return true;
    }
    void assimilation.settlement.then(
      () => { weakPump.deref()?.completeBrokerAction(generation, id); },
      () => { weakPump.deref()?.failBrokerAction(generation, id); },
    );
    return true;
  }

  private deliverBrokerFrame(): boolean {
    if (!this.brokerWritable || !this.hostConnection) return false;
    const entry = this.selectPending(this.brokerToHost, new Set());
    if (!entry) return false;
    if (entry.type === "route.unbind" && entry.routeId !== null) {
      // Fence Host admission before touching any pump-owned reverse data.
      // Pending deliveries are rejected back to HostCarrier; an already
      // handed Broker receive is an uncertainty barrier until it settles or
      // its own deadline closes the carrier.
      this.blockedHostRoutes.add(entry.routeId);
      if (!this.releaseUnacceptedRoute(entry.routeId)) return false;
    }
    entry.state = "processing";
    const generation = this.hostConnection.generation;
    this.hostConnection.receive(entry.bytes.slice(), { opcode: "text", compressed: false });
    const status = this.options.host.status();
    const terminalControl = entry.type === "carrier.error" || entry.type === "host.superseded";
    const hostAccepted = status?.generation === generation
      && (status.phase === "registered"
        || (terminalControl && (status.phase === "offline" || status.phase === "superseded")));
    if (!hostAccepted) {
      this.requestClose(status?.closeCode ?? 4400, "host_rejected_broker_delivery");
      return true;
    }
    this.removeEntry(this.brokerToHost, entry);
    if (entry.type === "route.unbind" && entry.routeId !== null) {
      this.blockedHostRoutes.delete(entry.routeId);
    }
    let acknowledged: RelayV2BrokerResult | null = null;
    let acknowledgementReceipt: RelayV2BrokerProducerReceipt | null = null;
    if (entry.deliveryId !== null) {
      try {
        const call = this.invokeSynchronousBrokerCall(() => (
          entry.registrationFence
            ? this.options.broker.acknowledgeHostControlDelivery(
                this.options.transportId,
                entry.deliveryId!,
              )
            : this.options.broker.acknowledgeHostDelivery(
                this.options.transportId,
                entry.deliveryId!,
              )
        ));
        acknowledged = call.result;
        acknowledgementReceipt = call.receipt;
      } catch {
        this.requestClose(1013, entry.registrationFence
          ? "registration_delivery_provenance_unavailable"
          : "broker_delivery_ack_provenance_unavailable");
      }
    }
    if (acknowledged) {
      if (acknowledgementReceipt === null) {
        this.acceptBrokerActions(acknowledged.actions, false);
      }
      if (!acknowledged.accepted) {
        this.requestClose(1013, entry.registrationFence
          ? "registration_delivery_commit_rejected"
          : "broker_delivery_ack_rejected");
      }
    }
    this.evaluatePressure(false);
    return true;
  }

  private deliverHostFrame(): boolean {
    if (!this.hostWritable || this.hostDeliveryAttempt) return false;
    const entry = this.selectPending(this.hostToBroker, this.blockedHostRoutes);
    if (!entry) return false;
    if (entry.control && entry.routeId !== null
      && this.blockedHostRoutes.has(entry.routeId)
      && (entry.type === "route.close" || entry.type === "route.unbound")) {
      if (!this.releaseUnacceptedRoute(entry.routeId)) return true;
      this.blockedHostRoutes.delete(entry.routeId);
    }
    entry.state = "processing";
    const generation = this.lifecycleGeneration;
    const id = ++this.nextAttemptId;
    const abort = new AbortController();
    const weakPump = new WeakRef(this);
    const preparedCallHolder: PreparedCallHolder = { call: null };
    const cancelDeadline = this.schedule(this.deliveryTimeoutMs, () => {
      const pump = weakPump.deref();
      if (pump) pump.timeoutHostDelivery(generation, id, preparedCallHolder);
      else takePreparedCall(preparedCallHolder)?.abandon();
    });
    try {
      preparedCallHolder.call = this.producerRegistration?.prepareBrokerCall() ?? null;
    } catch {
      cancelDeadline();
      entry.state = "pending";
      this.requestClose(1013, "host_delivery_provenance_unavailable");
      this.beginCloseDrain();
      return true;
    }
    this.hostDeliveryAttempt = {
      generation,
      id,
      abort,
      cancelDeadline,
      deliveryToken: entry.deliveryToken,
      preparedCallHolder,
    };
    let result: Promise<RelayV2BrokerResult>;
    try {
      result = this.options.broker.receiveHostFrame(
        this.options.transportId,
        entry.bytes.slice(),
        abort.signal,
      );
    } catch {
      this.failHostDelivery(generation, id, preparedCallHolder);
      return true;
    }
    void Promise.resolve(result).then(
      (settled) => {
        const pump = weakPump.deref();
        if (pump) pump.completeHostDelivery(generation, id, preparedCallHolder, settled);
        else takePreparedCall(preparedCallHolder)?.abandon();
      },
      () => {
        const pump = weakPump.deref();
        if (pump) pump.failHostDelivery(generation, id, preparedCallHolder);
        else takePreparedCall(preparedCallHolder)?.abandon();
      },
    );
    return true;
  }

  private completeHostDelivery(
    generation: number,
    id: number,
    preparedCallHolder: PreparedCallHolder,
    result: RelayV2BrokerResult,
  ): void {
    const attempt = this.hostDeliveryAttempt;
    if (!attempt || attempt.generation !== generation || attempt.id !== id
      || attempt.preparedCallHolder !== preparedCallHolder
      || generation !== this.lifecycleGeneration || this.phase !== "running") {
      takePreparedCall(preparedCallHolder)?.abandon();
      return;
    }
    attempt.cancelDeadline();
    this.hostDeliveryAttempt = null;
    const entry = this.hostToBroker.entries.find((candidate) => (
      candidate.deliveryToken === attempt.deliveryToken && candidate.state === "processing"
    ));
    if (!entry) {
      takePreparedCall(preparedCallHolder)?.abandon();
      this.requestClose(1013, "carrier_pump_delivery_fence_lost");
      this.beginCloseDrain();
      return;
    }
    const preparedCall = takePreparedCall(preparedCallHolder);
    if (preparedCall) {
      try {
        preparedCall.settle(
          result,
          (settled, handoff) => this.applyPreparedBrokerResult(settled, handoff),
        );
      } catch {
        if (this.phase === "running") {
          this.requestClose(1013, "host_delivery_settlement_failure");
        }
        this.beginCloseDrain();
        return;
      }
    } else {
      this.acceptBrokerActions(result.actions, false);
    }
    if (this.closeRequest) {
      this.wake();
      return;
    }
    const pressureRejected = !result.accepted
      && result.error?.code === "SLOW_CONSUMER"
      && entry.routeId !== null;
    if (pressureRejected) {
      entry.state = "pending";
      this.blockedHostRoutes.add(entry.routeId!);
      this.notePressure(this.hostToBroker);
      this.wake();
      return;
    }
    // A valid negative carrier response such as route.rejected was fully
    // processed. Protocol failures always carry close_host above.
    entry.state = "complete";
    this.scheduleHostAcknowledgements();
    this.wake();
  }

  private timeoutHostDelivery(
    generation: number,
    id: number,
    preparedCallHolder: PreparedCallHolder,
  ): void {
    const attempt = this.hostDeliveryAttempt;
    if (!attempt || attempt.generation !== generation || attempt.id !== id
      || attempt.preparedCallHolder !== preparedCallHolder
      || generation !== this.lifecycleGeneration) {
      takePreparedCall(preparedCallHolder)?.abandon();
      return;
    }
    attempt.abort.abort();
    attempt.cancelDeadline();
    takePreparedCall(preparedCallHolder)?.abandon();
    this.hostDeliveryAttempt = null;
    this.requestClose(1013, "host_delivery_timeout");
    this.beginCloseDrain();
  }

  private failHostDelivery(
    generation: number,
    id: number,
    preparedCallHolder: PreparedCallHolder,
  ): void {
    const attempt = this.hostDeliveryAttempt;
    if (!attempt || attempt.generation !== generation || attempt.id !== id
      || attempt.preparedCallHolder !== preparedCallHolder
      || generation !== this.lifecycleGeneration) {
      takePreparedCall(preparedCallHolder)?.abandon();
      return;
    }
    attempt.abort.abort();
    attempt.cancelDeadline();
    takePreparedCall(attempt.preparedCallHolder)?.abandon();
    this.hostDeliveryAttempt = null;
    this.requestClose(1013, "host_delivery_failure");
    this.beginCloseDrain();
  }

  private completeBrokerAction(generation: number, id: number): void {
    const retired = this.retiredBrokerActionAttempt;
    if (retired?.generation === generation && retired.id === id) {
      const closeEntry = retired.entry.mandatory
        ? this.closeActions.find((entry) => (
            entry.dedupeKey === this.closeActionDedupeKey(retired.entry.action)
          ))
        : null;
      if (closeEntry) this.markCloseAction(closeEntry, "settled");
      else this.releaseOwnerFence(retired.entry.ownerFence);
      this.retiredBrokerActionAttempt = null;
      this.advanceCloseDrain();
      return;
    }
    const attempt = this.brokerActionAttempt;
    if (!attempt || attempt.generation !== generation || attempt.id !== id
      || generation !== this.lifecycleGeneration || this.phase !== "running") return;
    attempt.cancelDeadline();
    this.brokerActionAttempt = null;
    const entry = this.pendingActions[0];
    if (!entry || entry.state !== "processing") {
      this.requestClose(1013, "carrier_pump_action_fence_lost");
      this.beginCloseDrain();
      return;
    }
    this.removePendingAction(entry);
    this.wake();
  }

  private timeoutBrokerAction(generation: number, id: number): void {
    const attempt = this.brokerActionAttempt;
    if (!attempt || attempt.generation !== generation || attempt.id !== id
      || generation !== this.lifecycleGeneration) return;
    attempt.cancelDeadline();
    this.requestClose(1013, "broker_action_timeout");
    this.beginCloseDrain();
  }

  private failBrokerAction(generation: number, id: number): void {
    const retired = this.retiredBrokerActionAttempt;
    if (retired?.generation === generation && retired.id === id) {
      this.retiredBrokerActionAttempt = null;
      this.closeActionFailures += 1;
      const closeEntry = retired.entry.mandatory
        ? this.closeActions.find((entry) => (
            entry.dedupeKey === this.closeActionDedupeKey(retired.entry.action)
          ))
        : null;
      if (closeEntry) this.forceCloseAction(closeEntry);
      else this.releaseOwnerFence(retired.entry.ownerFence);
      this.advanceCloseDrain();
      return;
    }
    const attempt = this.brokerActionAttempt;
    if (!attempt || attempt.generation !== generation || attempt.id !== id
      || generation !== this.lifecycleGeneration) return;
    this.installOwnerFence(attempt.entry.ownerFence.identity);
    attempt.abort.abort();
    attempt.cancelDeadline();
    this.removePendingAction(attempt.entry);
    this.brokerActionAttempt = null;
    this.requestClose(1013, "carrier_pump_action_sink_failure");
    this.beginCloseDrain();
  }

  private releaseUnacceptedRoute(routeId: string): boolean {
    if (!this.hostConnection) return false;
    const rejected = this.hostToBroker.entries.filter((entry) => (
      entry.routeId === routeId && !entry.control && entry.state !== "complete"
    ));
    if (this.hostDeliveryAttempt && rejected.some((entry) => (
      entry.deliveryToken === this.hostDeliveryAttempt?.deliveryToken
    ))) {
      return false;
    }
    let removed = false;
    for (const entry of rejected.reverse()) {
      this.removeEntry(this.hostToBroker, entry);
      this.hostConnection.rejectUnaccepted(entry.deliveryToken);
      removed = true;
      if (this.phase === "closing" || this.phase === "closed") return false;
    }
    if (removed) this.scheduleHostAcknowledgements();
    this.evaluatePressure(false);
    return true;
  }

  private scheduleHostAcknowledgements(): void {
    if (this.ackTimer || this.phase !== "running") return;
    const cancel = this.schedule(0, () => {
      if (this.ackTimer?.cancel !== cancel) return;
      this.ackTimer = null;
      this.acknowledgeHostFrames();
    });
    this.ackTimer = { cancel };
  }

  private acknowledgeHostFrames(): void {
    if (this.phase !== "running" || !this.hostConnection) return;
    let crossedLowWater = false;
    while (this.hostToBroker.entries[0]?.state === "complete") {
      const entry = this.hostToBroker.entries[0]!;
      // The transport buffer is reduced before the complete delivery token is
      // ACKed. HostCarrier's bufferedAmount fence can therefore prove that no
      // synchronous or premature release occurred.
      this.removeEntry(this.hostToBroker, entry);
      crossedLowWater = this.belowLowWater(this.hostToBroker) || crossedLowWater;
      this.hostConnection.acknowledge(entry.deliveryToken);
      if (this.phase !== "running") return;
    }
    if (crossedLowWater) this.hostConnection.writable();
    this.evaluatePressure(false);
    this.wake();
  }

  private selectPending<T extends PumpFrame>(
    state: DirectionState<T>,
    blockedRoutes: ReadonlySet<string>,
  ): T | undefined {
    const control = state.entries.find((entry) => (
      entry.state === "pending"
      && entry.control
      && (this.routeHeadIsEligible(state, entry)
        || (entry.routeId !== null
          && blockedRoutes.has(entry.routeId)
          && (entry.type === "route.close" || entry.type === "route.unbound")))
    ));
    if (control) return control;
    const routeIds: string[] = [];
    for (const entry of state.entries) {
      if (entry.state !== "pending" || entry.routeId === null
        || !this.routeHeadIsEligible(state, entry)
        || blockedRoutes.has(entry.routeId) || routeIds.includes(entry.routeId)) continue;
      routeIds.push(entry.routeId);
    }
    if (routeIds.length === 0) return undefined;
    if (state.routeCursor >= routeIds.length) state.routeCursor = 0;
    const routeId = routeIds[state.routeCursor]!;
    state.routeCursor = (state.routeCursor + 1) % routeIds.length;
    return state.entries.find((entry) => (
      entry.state === "pending" && entry.routeId === routeId
    ));
  }

  private routeHeadIsEligible<T extends PumpFrame>(
    state: DirectionState<T>,
    candidate: T,
  ): boolean {
    if (candidate.routeId === null) return true;
    const candidateIndex = state.entries.indexOf(candidate);
    return !state.entries.slice(0, candidateIndex).some((earlier) => (
      earlier.routeId === candidate.routeId && earlier.state !== "complete"
    ));
  }

  private removeEntry<T extends PumpFrame>(state: DirectionState<T>, entry: T): void {
    const index = state.entries.indexOf(entry);
    if (index < 0) return;
    state.entries.splice(index, 1);
    state.bytes -= entry.byteLength;
    if (state.routeCursor >= state.entries.length) state.routeCursor = 0;
  }

  private belowLowWater<T extends PumpFrame>(state: DirectionState<T>): boolean {
    return state.bytes < this.limits.lowWaterBytes
      && state.entries.length < this.limits.lowWaterFrames;
  }

  private noteBoundaryPressure<T extends PumpFrame>(
    state: DirectionState<T>,
    routeId: string | null,
    control: boolean,
  ): void {
    const byteCeiling = this.limits.maxBytes - (control ? 0 : this.limits.controlReserveBytes);
    const frameCeiling = this.limits.maxFrames - (control ? 0 : this.limits.controlReserveFrames);
    const routeAtBoundary = routeId !== null && !control
      ? (() => {
          const usage = routeUsage(state, routeId);
          return usage.bytes >= this.limits.maxBytesPerRoute
            || usage.frames >= this.limits.maxFramesPerRoute;
        })()
      : false;
    if (state.bytes >= byteCeiling
      || state.entries.length >= frameCeiling
      || routeAtBoundary) {
      this.notePressure(state);
    }
  }

  private notePressure<T extends PumpFrame>(state: DirectionState<T>): void {
    state.pressureSinceMs ??= safeNow(this.now);
    this.refreshPressureTimer();
  }

  private refreshPressureTimer(): void {
    if (this.phase !== "running") return;
    const starts = [
      this.hostToBroker.pressureSinceMs,
      this.brokerToHost.pressureSinceMs,
    ].filter((value): value is number => value !== null);
    if (starts.length === 0) {
      this.pressureTimer?.cancel();
      this.pressureTimer = null;
      return;
    }
    const deadlineMs = Math.min(...starts) + PRESSURE_TIMEOUT_MS;
    if (this.pressureTimer?.deadlineMs === deadlineMs) return;
    this.pressureTimer?.cancel();
    const cancel = this.schedule(
      Math.max(0, deadlineMs - safeNow(this.now)),
      () => {
        if (this.pressureTimer?.cancel !== cancel) return;
        this.pressureTimer = null;
        this.sweep();
      },
    );
    this.pressureTimer = { deadlineMs, cancel };
  }

  private evaluatePressure(afterSweep: boolean): void {
    if (this.belowLowWater(this.hostToBroker) && this.blockedHostRoutes.size === 0) {
      this.hostToBroker.pressureSinceMs = null;
    }
    if (this.belowLowWater(this.brokerToHost) && this.pausedClients.size === 0) {
      this.brokerToHost.pressureSinceMs = null;
    }
    const now = safeNow(this.now);
    const expired = [this.hostToBroker, this.brokerToHost].some((state) => (
      state.pressureSinceMs !== null
      && now - state.pressureSinceMs >= PRESSURE_TIMEOUT_MS
    ));
    if (expired && afterSweep) {
      // Owner sweeps ran first. Remaining adapter pressure has no safe route
      // authority to invent, so the transport is failed closed.
      this.requestClose(1013, "carrier_pump_pressure_timeout");
    }
    this.refreshPressureTimer();
  }

  private hasImmediateWork(): boolean {
    if (this.phase === "closing") {
      return this.brokerWritable && this.canDrainBrokerControlNow();
    }
    if (!this.brokerActionAttempt
      && this.pendingActions.some((entry) => entry.state === "pending")) return true;
    if (this.pendingProducerReadyTurn !== null) return true;
    if (this.brokerWritable && this.brokerToHost.entries.some((entry) => (
      entry.state === "pending"
      && this.routeHeadIsEligible(this.brokerToHost, entry)
      && !this.unbindWaitsForHostDelivery(entry)
    ))) {
      return true;
    }
    if (!this.hostDeliveryAttempt
      && this.hostWritable && this.hostToBroker.entries.some((entry) => (
      entry.state === "pending"
      && this.routeHeadIsEligible(this.hostToBroker, entry)
      && (entry.control
        || (entry.routeId !== null && !this.blockedHostRoutes.has(entry.routeId)))
    ))) return true;
    return false;
  }

  private unbindWaitsForHostDelivery(entry: BrokerFrame): boolean {
    if (entry.type !== "route.unbind" || entry.routeId === null
      || !this.hostDeliveryAttempt) return false;
    return this.hostToBroker.entries.some((candidate) => (
      candidate.routeId === entry.routeId
      && candidate.deliveryToken === this.hostDeliveryAttempt?.deliveryToken
      && candidate.state === "processing"
    ));
  }

  private requestClose(code: number, reason: string, drainBrokerControl = false): void {
    if (this.phase === "closed" || this.phase === "terminal_failure") return;
    if (this.closeRequest) {
      this.closeRequest.drainBrokerControl ||= drainBrokerControl;
      return;
    }
    // Establish the Pump-local hard cut before the registry close cut and
    // before any external abort/cancel callback can reenter. The exact effect
    // that created this cut remains valid until it returns; B7a rejects every
    // new ordinary effect while the registration is closing.
    if (!this.prepareDisconnectBrokerCall()) {
      this.finishTerminalFailure("broker_disconnect_provenance_unavailable");
      return;
    }
    this.pendingProducerReadyTurn = null;
    this.lifecycleGeneration += 1;
    this.phase = "closing";
    this.closeRequest = { code, reason, drainBrokerControl };
    this.beginProducerClose();
    this.hostDeliveryAttempt?.abort.abort();
    this.hostDeliveryAttempt?.cancelDeadline();
    if (this.hostDeliveryAttempt) {
      takePreparedCall(this.hostDeliveryAttempt.preparedCallHolder)?.abandon();
    }
    this.hostDeliveryAttempt = null;
    const actionAttempt = this.brokerActionAttempt;
    const processing = this.pendingActions[0]?.state === "processing"
      ? this.pendingActions[0]!
      : null;
    if (processing) this.removePendingAction(processing, true);
    if (actionAttempt) {
      this.installOwnerFence(actionAttempt.entry.ownerFence.identity);
      actionAttempt.abort.abort();
      actionAttempt.cancelDeadline();
      // Abort is advisory: the sink may already own an external side effect.
      // Its real settlement remains a close barrier until the fresh deadline.
      this.retiredBrokerActionAttempt = {
        generation: actionAttempt.generation,
        id: actionAttempt.id,
        entry: actionAttempt.entry,
      };
    }
    this.brokerActionAttempt = null;
    this.pressureTimer?.cancel();
    this.pressureTimer = null;
    this.ackTimer?.cancel();
    this.ackTimer = null;
    const terminalControls = this.brokerToHost.entries.filter((entry) => (
      entry.type === "carrier.error" || entry.type === "host.superseded"
    ));
    this.brokerToHost.entries = terminalControls;
    this.brokerToHost.bytes = terminalControls.reduce(
      (total, entry) => total + entry.byteLength,
      0,
    );
  }

  private shouldDrainBrokerControl(): boolean {
    return this.closeRequest?.drainBrokerControl === true
      && this.brokerToHost.entries.some((entry) => (
        entry.type === "carrier.error" || entry.type === "host.superseded"
      ));
  }

  private isTerminalFailure(): boolean {
    return this.phase === "terminal_failure";
  }

  private canDrainBrokerControlNow(): boolean {
    if (!this.shouldDrainBrokerControl()) return false;
    return this.brokerToHost.entries.some((entry) => (
      entry.state === "pending"
      && (entry.type === "carrier.error" || entry.type === "host.superseded")
    ));
  }

  private beginCloseDrain(): void {
    if (this.phase === "closed" || this.phase === "terminal_failure") return;
    if (!this.closeRequest) {
      this.requestClose(1000, "carrier_pump_shutdown");
    }
    if (!this.closeActionsPrepared) {
      this.closeActionsPrepared = true;
      const generation = ++this.closeDrainGeneration;
      this.closeActionAbort = new AbortController();
      this.closeActionFailures = 0;
      this.closeActions = [];
      this.closeActionBytes = 0;
      this.completedCloseActionKeys.splice(0);
      this.closeAdmissionSealed = false;
      const pending = this.pendingActions.splice(0);
      this.pendingActionBytes = 0;
      this.mandatoryActionBytes = 0;
      this.mandatoryActionCount = 0;
      for (const entry of pending) {
        if (!entry.mandatory) {
          this.releaseOwnerFence(entry.ownerFence);
          continue;
        }
        this.addCloseAction(
          entry.action,
          entry.bytes,
          entry.ownerFence,
          "pending",
          entry.emergency,
        );
        if (this.isTerminalFailure()) return;
      }
      const retired = this.retiredBrokerActionAttempt;
      if (retired && retired.entry.mandatory) {
        this.addCloseAction(
          retired.entry.action,
          retired.entry.bytes,
          retired.entry.ownerFence,
          "inflight",
        );
      }
      const disconnected = this.disconnectBrokerForClose();
      if (!disconnected || this.isTerminalFailure()) return;
      for (const entry of [...this.closeActions]) {
        if (entry.emergency && entry.state === "pending"
          && !this.forceRegisteredOverflow(entry)) return;
      }
      for (const action of disconnected.actions) {
        if (this.actionAdmissionStopped || this.isTerminalFailure()) break;
        if (this.producerComposition && this.isHostProducerAction(action)) continue;
        let bytes = 0;
        try {
          bytes = Buffer.byteLength(JSON.stringify(action), "utf8");
        } catch {
          this.closeActionFailures += 1;
          continue;
        }
        this.clearTerminalClientPressure(action);
        this.addCloseAction(
          action,
          bytes,
          this.createOwnerFence(action, this.lifecycleGeneration),
          "pending",
        );
      }
      if (this.isTerminalFailure()) return;
      const weakPump = new WeakRef(this);
      const cancel = this.schedule(this.deliveryTimeoutMs, () => {
        const pump = weakPump.deref();
        if (!pump || pump.closeDrainGeneration !== generation
          || pump.phase !== "closing") return;
        pump.expireCloseDrain();
      });
      this.closeTimer = { cancel };
      const cancelAdmission = this.schedule(0, () => {
        if (this.closeAdmissionTimer?.cancel !== cancelAdmission
          || this.phase !== "closing") return;
        this.closeAdmissionTimer = null;
        this.closeAdmissionSealed = true;
        this.advanceCloseDrain();
      });
      this.closeAdmissionTimer = { cancel: cancelAdmission };
    }
    this.advanceCloseDrain();
  }

  private disconnectBrokerForClose(): RelayV2BrokerResult | null {
    if (this.brokerDisconnected) {
      this.disconnectPreparedCall?.abandon();
      this.disconnectPreparedCall = null;
      return { accepted: true, actions: [] };
    }
    const preparedCall = this.disconnectPreparedCall;
    this.disconnectPreparedCall = null;
    if (this.producerComposition && !preparedCall) {
      this.actionAdmissionStopped = true;
      this.finishTerminalFailure("broker_disconnect_provenance_unavailable");
      return null;
    }
    let result: RelayV2BrokerResult;
    try {
      result = this.options.broker.disconnectHost(this.options.transportId);
    } catch {
      preparedCall?.abandon();
      this.actionAdmissionStopped = true;
      this.finishTerminalFailure("broker_disconnect_failure");
      return null;
    }
    this.brokerDisconnected = true;
    if (preparedCall) {
      try {
        const receipt = preparedCall.settle(
          result,
          (settled, handoff) => this.applyPreparedBrokerResult(
            settled,
            handoff,
            false,
          ),
        );
        if (receipt === "rejected") this.closeActionFailures += 1;
      } catch {
        this.actionAdmissionStopped = true;
        this.finishTerminalFailure("broker_disconnect_settlement_failure");
        return null;
      }
    }
    // Every route owned by this carrier is now terminal in BrokerCore. Do
    // not leave edge-triggered pause state behind when a cleanup action has
    // to take the emergency/failed force path and the remaining batch is
    // intentionally no longer admitted.
    this.pausedClients.clear();
    this.brokerToHost.pressureSinceMs = null;
    return result;
  }

  private requiredDuringClose(action: RelayV2BrokerAction): boolean {
    if (action.kind === "close_client"
      || action.kind === "route_unavailable"
      || action.kind === "close_host") return true;
    return action.kind === "send_host"
      && (action.frame.type === "carrier.error" || action.frame.type === "host.superseded");
  }

  private closeActionDedupeKey(action: RelayV2BrokerAction): string {
    const detail = action.kind === "send_host" ? String(action.frame.type) : action.kind;
    return `${this.brokerActionIdentity(action)}:${detail}:${this.closeDrainGeneration}`;
  }

  private addCloseAction(
    action: RelayV2BrokerAction,
    bytes: number,
    ownerFence: OwnerFenceState,
    state: CloseAction["state"],
    emergency = false,
  ): CloseAction | null {
    const dedupeKey = this.closeActionDedupeKey(action);
    const existing = this.closeActions.find((entry) => entry.dedupeKey === dedupeKey);
    if (existing) {
      if (existing.ownerFence !== ownerFence) this.releaseOwnerFence(ownerFence);
      return existing;
    }
    if (this.completedCloseActionKeys.includes(dedupeKey)) {
      this.releaseOwnerFence(ownerFence);
      return null;
    }
    const ordinaryCapacity = this.closeActions.length < this.limits.maxMandatoryActions
      && bytes <= this.limits.maxMandatoryActionBytes - this.closeActionBytes;
    const useEmergency = emergency || !ordinaryCapacity;
    const emergencyCapacity = this.closeActions.length < this.limits.maxMandatoryActions + 1
      && bytes <= MAX_EMERGENCY_ACTION_BYTES
      && bytes <= this.limits.maxMandatoryActionBytes
        + MAX_EMERGENCY_ACTION_BYTES - this.closeActionBytes;
    if (useEmergency && !emergencyCapacity) {
      this.releaseOwnerFence(ownerFence);
      this.actionAdmissionStopped = true;
      this.finishTerminalFailure("mandatory_registry_exhausted");
      return null;
    }
    const entry: CloseAction = {
      action: structuredClone(action),
      bytes,
      id: ++this.nextAttemptId,
      dedupeKey,
      ownerFence,
      emergency: useEmergency,
      state,
    };
    this.closeActions.push(entry);
    this.closeActionBytes += bytes;
    if (useEmergency && this.brokerDisconnected && state === "pending") {
      this.forceRegisteredOverflow(entry);
    }
    return entry;
  }

  private terminalCloseAction(action: RelayV2BrokerAction): boolean {
    return action.kind === "send_host"
      && (action.frame.type === "carrier.error" || action.frame.type === "host.superseded");
  }

  private closeHostBlocked(entry: CloseAction): boolean {
    if (entry.action.kind !== "close_host") return false;
    const transportId = entry.action.transportId;
    if (transportId === this.options.transportId
      && this.shouldDrainBrokerControl()) return true;
    return this.closeActions.some((candidate) => {
      const action = candidate.action;
      return action.kind === "send_host"
        && action.transportId === transportId
        && this.terminalCloseAction(action)
        && candidate.state !== "settled"
        && candidate.state !== "forced";
    });
  }

  private closeActionBlockedByRetired(entry: CloseAction): boolean {
    const retired = this.retiredBrokerActionAttempt?.entry.action;
    if (!retired) return false;
    if (retired.kind === "send_host" && this.terminalCloseAction(retired)) {
      return entry.action.kind === "close_host"
        && entry.action.transportId === retired.transportId;
    }
    if (!("connectionId" in retired) || !("connectionId" in entry.action)) return false;
    return retired.connectionId === entry.action.connectionId;
  }

  private markCloseAction(
    entry: CloseAction,
    state: "settled" | "forced",
  ): void {
    if (entry.state === "settled" || entry.state === "forced") return;
    this.closeActionBytes = Math.max(0, this.closeActionBytes - entry.bytes);
    entry.state = state;
    this.releaseOwnerFence(entry.ownerFence);
    const index = this.closeActions.indexOf(entry);
    if (index >= 0) this.closeActions.splice(index, 1);
    this.completedCloseActionKeys.push(entry.dedupeKey);
    const maxKeys = this.limits.maxMandatoryActions + 1;
    if (this.completedCloseActionKeys.length > maxKeys) {
      this.completedCloseActionKeys.splice(0, this.completedCloseActionKeys.length - maxKeys);
    }
  }

  private forceBrokerAction(entry: CloseAction): boolean {
    if (entry.state === "settled" || entry.state === "forced") return true;
    if (entry.state === "forcing" || entry.state === "force_failed") return false;
    // Mark first so a synchronous shutdown/reentry cannot dispatch or force
    // this identity twice. The irreversible lease fence is installed before
    // calling the socket owner, not after its side effect.
    entry.state = "forcing";
    this.installOwnerFence(entry.ownerFence.identity);
    let accepted = false;
    this.forceCallbackActive = true;
    try {
      accepted = this.options.onForceBrokerAction(
        structuredClone(entry.action),
        entry.ownerFence.view,
      ) === true;
    } catch {
      accepted = false;
    } finally {
      this.forceCallbackActive = false;
    }
    if (accepted) {
      this.markCloseAction(entry, "forced");
      return true;
    }
    entry.state = "force_failed";
    this.closeActionFailures += 1;
    return false;
  }

  private forceCloseAction(entry: CloseAction): boolean {
    const accepted = this.forceBrokerAction(entry);
    if (!accepted && entry.state === "force_failed"
      && this.phase !== "closed" && this.phase !== "terminal_failure") {
      this.actionAdmissionStopped = true;
      this.finishTerminalFailure("mandatory_force_rejected");
    }
    return accepted;
  }

  private forceRegisteredOverflow(entry: CloseAction): boolean {
    return this.forceCloseAction(entry);
  }

  private settleCloseAction(generation: number, id: number, rejected: boolean): void {
    if (generation !== this.closeDrainGeneration || this.phase !== "closing") return;
    const entry = this.closeActions.find((candidate) => (
      candidate.id === id && candidate.state === "inflight"
    ));
    if (!entry) return;
    if (rejected) {
      this.closeActionFailures += 1;
      this.forceCloseAction(entry);
    } else {
      this.markCloseAction(entry, "settled");
    }
    this.advanceCloseDrain();
  }

  private dispatchCloseActions(): void {
    if (this.phase !== "closing") return;
    const sink = this.options.onBrokerAction;
    const abort = this.closeActionAbort;
    // Handoff every independent cleanup now. Only the same-identity retired
    // effect and terminal-control -> close_host dependency may delay an entry.
    for (const entry of [...this.closeActions]) {
      if (entry.state !== "pending"
        || this.closeHostBlocked(entry)
        || this.closeActionBlockedByRetired(entry)) continue;
      if (!sink || !abort) {
        if (!this.forceCloseAction(entry)) return;
        continue;
      }
      entry.state = "inflight";
      const generation = this.closeDrainGeneration;
      let result: void | Promise<void>;
      try {
        result = sink(
          structuredClone(entry.action),
          abort.signal,
          entry.ownerFence.view,
        );
      } catch {
        this.closeActionFailures += 1;
        if (!this.forceCloseAction(entry)) return;
        continue;
      }
      const assimilation = assimilateActionSinkResult(result);
      if (assimilation.kind === "synchronous") {
        this.markCloseAction(entry, "settled");
        continue;
      }
      if (assimilation.kind === "rejected") {
        this.closeActionFailures += 1;
        if (!this.forceCloseAction(entry)) return;
        continue;
      }
      const weakPump = new WeakRef(this);
      void assimilation.settlement.then(
        () => { weakPump.deref()?.settleCloseAction(generation, entry.id, false); },
        () => { weakPump.deref()?.settleCloseAction(generation, entry.id, true); },
      );
    }
  }

  private expireCloseDrain(): void {
    this.closeTimer = null;
    this.closeAdmissionTimer?.cancel();
    this.closeAdmissionTimer = null;
    this.closeAdmissionSealed = true;
    this.installAllOwnerFences();
    this.disconnectPreparedCall?.abandon();
    this.disconnectPreparedCall = null;
    this.closeActionAbort?.abort();
    this.closeDrainGeneration += 1;
    const retired = this.retiredBrokerActionAttempt;
    this.retiredBrokerActionAttempt = null;
    // The synchronous outlet installs the final socket/generation fence for
    // every action whose async effect never settled or was never safe to start.
    for (const entry of [...this.closeActions]) {
      if (!this.forceCloseAction(entry)) break;
    }
    if (retired) this.releaseOwnerFence(retired.entry.ownerFence);
    if (this.phase === "terminal_failure") return;
    if (this.closeRequest) this.closeRequest.drainBrokerControl = false;
    if (this.closeActions.some((entry) => entry.state === "force_failed")) {
      this.finishTerminalFailure("mandatory_force_rejected");
    } else {
      this.finishClose();
    }
  }

  private advanceCloseDrain(): void {
    if (this.phase !== "closing" || !this.closeActionsPrepared) return;
    this.dispatchCloseActions();
    if (this.brokerWritable && this.canDrainBrokerControlNow()) this.wake();
    if (!this.retiredBrokerActionAttempt
      && this.closeAdmissionSealed
      && !this.shouldDrainBrokerControl()
      && this.closeActions.length === 0) {
      this.finishClose();
    }
  }

  private settleCloseBarrier(outcome: "closed" | "terminal_failure"): void {
    if (this.closeBarrierSettled) return;
    this.closeBarrierSettled = true;
    const close = this.closeRequest ?? this.closedWith
      ?? { code: 1013, reason: "carrier_pump_terminal_failure" };
    this.resolveCloseBarrier(Object.freeze({
      outcome,
      code: close.code,
      reason: outcome === "terminal_failure"
        ? this.terminalFailureReason ?? close.reason
        : close.reason,
      failedMandatoryActions: this.closeActions.filter((entry) => (
        entry.state === "force_failed"
      )).length,
    }));
  }

  private finishTerminalFailure(reason: string): void {
    if (this.phase === "closed" || this.phase === "terminal_failure") return;
    this.actionAdmissionStopped = true;
    this.pendingProducerReadyTurn = null;
    this.terminalFailureReason = reason;
    this.lifecycleGeneration += 1;
    this.phase = "terminal_failure";
    this.beginProducerClose();
    // A terminal receipt is the final owner boundary. Fence every lease that
    // may already have crossed an async sink before aborting or resolving the
    // barrier; generation checks inside the pump cannot undo a late external
    // socket effect.
    this.installAllOwnerFences();
    this.disconnectPreparedCall?.abandon();
    this.disconnectPreparedCall = null;
    this.hostDeliveryAttempt?.abort.abort();
    this.hostDeliveryAttempt?.cancelDeadline();
    if (this.hostDeliveryAttempt) {
      takePreparedCall(this.hostDeliveryAttempt.preparedCallHolder)?.abandon();
    }
    this.hostDeliveryAttempt = null;
    this.brokerActionAttempt?.abort.abort();
    this.brokerActionAttempt?.cancelDeadline();
    this.brokerActionAttempt = null;
    this.pumpTimer?.cancel();
    this.pumpTimer = null;
    this.pressureTimer?.cancel();
    this.pressureTimer = null;
    this.ackTimer?.cancel();
    this.ackTimer = null;
    this.closeTimer?.cancel();
    this.closeTimer = null;
    this.closeAdmissionTimer?.cancel();
    this.closeAdmissionTimer = null;
    this.closeActionAbort?.abort();
    this.closeActionAbort = null;
    this.closeDrainGeneration += 1;
    const close = this.closeRequest ?? { code: 1013, reason };
    this.hostConnection?.closed(close.code);
    this.hostConnection = null;
    // Mandatory registry and its now-permanently-fenced owner states are
    // retained because the external socket owner did not acknowledge cleanup.
    this.settleCloseBarrier("terminal_failure");
  }

  private finishClose(): void {
    if (this.phase === "closed" || this.phase === "terminal_failure") return;
    const close = this.closeRequest ?? { code: 1000, reason: "carrier_pump_shutdown" };
    this.pendingProducerReadyTurn = null;
    this.beginProducerClose();
    this.closedWith = { code: close.code, reason: close.reason };
    this.disconnectPreparedCall?.abandon();
    this.disconnectPreparedCall = null;
    this.lifecycleGeneration += 1;
    this.hostDeliveryAttempt?.abort.abort();
    this.hostDeliveryAttempt?.cancelDeadline();
    if (this.hostDeliveryAttempt) {
      takePreparedCall(this.hostDeliveryAttempt.preparedCallHolder)?.abandon();
    }
    this.hostDeliveryAttempt = null;
    this.brokerActionAttempt?.abort.abort();
    this.brokerActionAttempt?.cancelDeadline();
    this.brokerActionAttempt = null;
    this.pumpTimer?.cancel();
    this.pumpTimer = null;
    this.pressureTimer?.cancel();
    this.pressureTimer = null;
    this.ackTimer?.cancel();
    this.ackTimer = null;
    this.closeTimer?.cancel();
    this.closeTimer = null;
    this.closeAdmissionTimer?.cancel();
    this.closeAdmissionTimer = null;
    this.closeActionAbort = null;
    this.closeDrainGeneration += 1;
    this.retiredBrokerActionAttempt = null;
    this.closeActions = [];
    this.closeActionBytes = 0;
    this.completedCloseActionKeys.splice(0);
    this.pendingActions.splice(0);
    this.pendingActionBytes = 0;
    this.mandatoryActionBytes = 0;
    this.mandatoryActionCount = 0;
    this.hostToBroker.entries = [];
    this.hostToBroker.bytes = 0;
    this.brokerToHost.entries = [];
    this.brokerToHost.bytes = 0;
    this.blockedHostRoutes.clear();
    this.pausedClients.clear();
    this.hostConnection?.closed(close.code);
    this.hostConnection = null;
    this.closeRequest = null;
    this.closeActionsPrepared = false;
    this.phase = "closed";
    this.settleCloseBarrier("closed");
  }
}
