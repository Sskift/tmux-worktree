import { types as nodeUtilTypes } from "node:util";
import {
  RELAY_V2_BROKER_LIMITS,
  type RelayV2BrokerAction,
  type RelayV2BrokerResult,
} from "./brokerCore.js";

export const RELAY_V2_BROKER_PRODUCER_MAX_ACTIONS =
  RELAY_V2_BROKER_LIMITS.maxBackpressureSweepActionsPerCarrier;

export type RelayV2BrokerProducerReceipt = "applied" | "rejected";

type RelayV2BrokerProducerActionKind =
  | "send_host"
  | "close_host"
  | "pause_host_route"
  | "resume_host_route";

export type RelayV2BrokerProducerAction = Extract<
  RelayV2BrokerAction,
  { kind: RelayV2BrokerProducerActionKind }
>;

const HOST_PRODUCER_ACTION_KINDS = new Set<RelayV2BrokerProducerActionKind>([
  "send_host",
  "close_host",
  "pause_host_route",
  "resume_host_route",
]);

// Generic structural ceilings only: action + frame wrappers fit above the
// codec's maximum JSON nesting, without duplicating any Broker action schema.
const PRODUCER_SNAPSHOT_MAX_DEPTH = 18;
const PRODUCER_SNAPSHOT_MAX_DIRECT_KEYS = 256;
const PRODUCER_SNAPSHOT_MAX_NODES = 16_384;

export type RelayV2BrokerProducerTarget = Readonly<{
  transportId: string;
  generation: string;
}>;

export type RelayV2BrokerProducerSource = Readonly<
  | {
      kind: "host";
      transportId: string;
      generation: string;
      partitionId: string;
    }
  | {
      kind: "internal";
      partitionId: string;
    }
>;

export interface RelayV2BrokerProducerEffectFence {
  readonly source: RelayV2BrokerProducerSource;
  readonly target: RelayV2BrokerProducerTarget;
  readonly effectEpoch: string;
  readonly leaseId: string;
  mayApply(): boolean;
}

export type RelayV2BrokerProducerTerminalFailure = Readonly<
  | {
      kind: "producer_failure";
      source: Extract<RelayV2BrokerProducerSource, { kind: "host" }>;
      target: RelayV2BrokerProducerTarget;
      reason: string;
    }
  | {
      kind: "target_failure";
      source: RelayV2BrokerProducerSource;
      target: RelayV2BrokerProducerTarget;
      reason: string;
    }
>;

export type RelayV2BrokerProducerTerminalFailureRequest =
  | Readonly<{
      kind: "producer_failure";
      reason: string;
    }>
  | Readonly<{
      kind: "target_failure";
      target: RelayV2BrokerProducerTarget;
      reason: string;
    }>;

/**
 * A carrier adapter implements this exact synchronous seam. Registration
 * captures both own data methods once and later calls them with this object as
 * their receiver. Literal `applied` is the only successful receipt.
 */
export interface RelayV2BrokerProducerPort {
  apply(
    actions: readonly Readonly<RelayV2BrokerProducerAction>[],
    fence: RelayV2BrokerProducerEffectFence,
  ): RelayV2BrokerProducerReceipt;
  forceTerminal(
    failure: RelayV2BrokerProducerTerminalFailure,
    fence: RelayV2BrokerProducerEffectFence,
  ): RelayV2BrokerProducerReceipt;
}

/**
 * The result remains owned and interpreted by the caller. This handoff only
 * owns exact Host target admission and effect fencing for the active source
 * partition surrounding that result.
 */
export interface RelayV2BrokerProducerHandoff {
  readonly source: RelayV2BrokerProducerSource;
  apply(
    target: RelayV2BrokerProducerTarget,
    actions: readonly RelayV2BrokerProducerAction[],
  ): RelayV2BrokerProducerReceipt;
  forceTerminal(
    failure: RelayV2BrokerProducerTerminalFailureRequest,
  ): RelayV2BrokerProducerReceipt;
}

export type RelayV2BrokerResultPartition<
  Result extends RelayV2BrokerResult = RelayV2BrokerResult,
> = (
  result: Result,
  handoff: RelayV2BrokerProducerHandoff,
) => RelayV2BrokerProducerReceipt;

export interface RelayV2BrokerProducerRegistration {
  readonly target: RelayV2BrokerProducerTarget;
  /** The source lease exists before invoke and through the whole partition. */
  runBrokerCall<Result extends RelayV2BrokerResult>(
    invoke: () => Result,
    partition: RelayV2BrokerResultPartition<Result>,
  ): RelayV2BrokerProducerReceipt;
  /**
   * Immediately closes ordinary target admission. The exact producer remains
   * a valid source until this Pump-owned native Promise settles.
   */
  beginClose(closeBarrier: Promise<unknown>): void;
}

type CapturedProducerPort = {
  readonly receiver: object;
  readonly apply: (...args: unknown[]) => unknown;
  readonly forceTerminal: (...args: unknown[]) => unknown;
};

type EffectLease = {
  readonly epoch: bigint;
  readonly leaseId: string;
  active: boolean;
};

type ProducerEntry = {
  readonly transportId: string;
  readonly generation: string;
  readonly target: RelayV2BrokerProducerTarget;
  readonly port: CapturedProducerPort;
  phase: "active" | "closing" | "retired";
  closeBarrierSettled: boolean;
  sourcePartitions: number;
  targetEffects: number;
  effectEpoch: bigint;
  currentEffect: EffectLease | null;
};

type SourcePartition = {
  readonly id: string;
  readonly source: RelayV2BrokerProducerSource;
  readonly producer: ProducerEntry | null;
  active: boolean;
  failed: boolean;
  consumedActions: number;
};

type OwnDataRecord = {
  readonly keys: readonly string[];
  readonly values: Readonly<Record<string, unknown>>;
};

type SnapshotState = {
  readonly ancestors: WeakSet<object>;
  nodes: number;
};

type ImmutableJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ImmutableJsonValue[]
  | Readonly<Record<string, ImmutableJsonValue>>;

function isRejectedProxy(value: unknown): boolean {
  if (
    !((typeof value === "object" && value !== null) || typeof value === "function")
  ) return false;
  try {
    return nodeUtilTypes.isProxy(value);
  } catch {
    return true;
  }
}

const NATIVE_PROMISE_OBSERVER = () => undefined;

function observeRejectedNativePromise(value: unknown): void {
  try {
    if (!nodeUtilTypes.isPromise(value)) return;
    // Both callbacks return undefined, so the otherwise-unobserved child
    // Promise resolves on either settlement. Never inspect arbitrary `then`.
    Reflect.apply(Promise.prototype.then, value, [
      NATIVE_PROMISE_OBSERVER,
      NATIVE_PROMISE_OBSERVER,
    ]);
  } catch {
    // A hostile Promise subclass cannot escape this synchronous fail-closed
    // boundary or turn rejection observation into a registry exception.
  }
}

function isPlainObject(value: unknown): value is object {
  if (value === null || typeof value !== "object") return false;
  if (isRejectedProxy(value)) return false;
  try {
    const prototype = Reflect.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function readOwnDataRecord(value: unknown): OwnDataRecord | undefined {
  if (!isPlainObject(value)) return undefined;
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) return undefined;
    const keys = ownKeys as string[];
    const values = Object.create(null) as Record<string, unknown>;
    for (const key of keys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      values[key] = descriptor.value;
    }
    return { keys, values };
  } catch {
    return undefined;
  }
}

function isOpaqueSynchronousBrokerResult(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (isRejectedProxy(value)) return false;
  try {
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;

    // Do not assimilate or read `then`. Any own/inherited descriptor would
    // make this opaque result asynchronous or shape-ambiguous at the seam.
    let cursor: object | null = value;
    while (cursor !== null) {
      if (Reflect.getOwnPropertyDescriptor(cursor, "then") !== undefined) return false;
      cursor = Reflect.getPrototypeOf(cursor);
    }

    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return false;
    for (const key of keys) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function hasExactKeys(record: OwnDataRecord, expected: readonly string[]): boolean {
  return record.keys.length === expected.length
    && record.keys.every((key) => expected.includes(key));
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 128
    && value.trim() === value
    && !/[\0\r\n]/.test(value);
}

function isGeneration(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

function isReason(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 256
    && value.trim() === value
    && !/[\0\r\n]/.test(value);
}

function captureProducerPort(port: unknown): CapturedProducerPort | undefined {
  const record = readOwnDataRecord(port);
  if (!record || !hasExactKeys(record, ["apply", "forceTerminal"])) return undefined;
  const apply = record.values.apply;
  const forceTerminal = record.values.forceTerminal;
  if (
    typeof apply !== "function"
    || typeof forceTerminal !== "function"
    || isRejectedProxy(apply)
    || isRejectedProxy(forceTerminal)
  ) return undefined;
  return Object.freeze({
    receiver: port as object,
    apply: apply as (...args: unknown[]) => unknown,
    forceTerminal: forceTerminal as (...args: unknown[]) => unknown,
  });
}

function readTarget(value: unknown): RelayV2BrokerProducerTarget | undefined {
  const record = readOwnDataRecord(value);
  if (!record || !hasExactKeys(record, ["transportId", "generation"])) return undefined;
  const transportId = record.values.transportId;
  const generation = record.values.generation;
  if (!isIdentifier(transportId) || !isGeneration(generation)) return undefined;
  return Object.freeze({ transportId, generation });
}

function snapshotJsonValue(
  value: unknown,
  state: SnapshotState,
  depth: number,
): ImmutableJsonValue | undefined {
  state.nodes += 1;
  if (state.nodes > PRODUCER_SNAPSHOT_MAX_NODES) return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "object" || isRejectedProxy(value)) return undefined;
  if (depth > PRODUCER_SNAPSHOT_MAX_DEPTH || state.ancestors.has(value)) return undefined;

  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.getPrototypeOf(value) !== Array.prototype) return undefined;
      const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
      if (!lengthDescriptor || !("value" in lengthDescriptor)) return undefined;
      const length = lengthDescriptor.value;
      if (
        typeof length !== "number"
        || !Number.isSafeInteger(length)
        || length < 0
        || length > PRODUCER_SNAPSHOT_MAX_NODES - state.nodes
      ) return undefined;
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== "string")) return undefined;
      const expected = new Set<string>(["length"]);
      for (let index = 0; index < length; index += 1) expected.add(String(index));
      if (keys.length !== expected.size || keys.some((key) => !expected.has(key as string))) {
        return undefined;
      }
      const snapshot: ImmutableJsonValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
          return undefined;
        }
        const child = snapshotJsonValue(descriptor.value, state, depth + 1);
        if (child === undefined) return undefined;
        snapshot.push(child);
      }
      return Object.freeze(snapshot);
    }

    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > PRODUCER_SNAPSHOT_MAX_DIRECT_KEYS
      || keys.some((key) => typeof key !== "string")
    ) return undefined;
    const snapshot = Object.create(prototype) as Record<string, ImmutableJsonValue>;
    for (const key of keys as string[]) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
        return undefined;
      }
      const child = snapshotJsonValue(descriptor.value, state, depth + 1);
      if (child === undefined) return undefined;
      Reflect.defineProperty(snapshot, key, {
        value: child,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(snapshot) as Readonly<Record<string, ImmutableJsonValue>>;
  } catch {
    return undefined;
  } finally {
    state.ancestors.delete(value);
  }
}

function snapshotAction(
  value: unknown,
  targetTransportId: string,
  state: SnapshotState,
): Readonly<RelayV2BrokerProducerAction> | undefined {
  const record = readOwnDataRecord(value);
  const kind = record?.values.kind;
  if (
    !record
    || typeof kind !== "string"
    || !HOST_PRODUCER_ACTION_KINDS.has(kind as RelayV2BrokerProducerActionKind)
    || record.values.transportId !== targetTransportId
  ) return undefined;
  const snapshot = snapshotJsonValue(value, state, 0);
  if (snapshot === undefined || snapshot === null || Array.isArray(snapshot)) return undefined;
  return snapshot as unknown as Readonly<RelayV2BrokerProducerAction>;
}

function snapshotActionBatch(
  value: unknown,
  targetTransportId: string,
  remainingActions: number,
): readonly Readonly<RelayV2BrokerProducerAction>[] | undefined {
  try {
    if (isRejectedProxy(value)) return undefined;
    if (!Array.isArray(value)) return undefined;
    if (Reflect.getPrototypeOf(value) !== Array.prototype) return undefined;
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor)) return undefined;
    const length = lengthDescriptor.value;
    if (
      typeof length !== "number"
      || !Number.isSafeInteger(length)
      || length < 1
      || length > RELAY_V2_BROKER_PRODUCER_MAX_ACTIONS
      || length > remainingActions
    ) return undefined;
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) return undefined;
    const expected = new Set<string>(["length"]);
    for (let index = 0; index < length; index += 1) expected.add(String(index));
    if (keys.length !== expected.size || keys.some((key) => !expected.has(key as string))) {
      return undefined;
    }
    const snapshots: Readonly<RelayV2BrokerProducerAction>[] = [];
    const state: SnapshotState = { ancestors: new WeakSet<object>(), nodes: 0 };
    for (let index = 0; index < length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
        return undefined;
      }
      const action = snapshotAction(descriptor.value, targetTransportId, state);
      if (!action) return undefined;
      snapshots.push(action);
    }
    return Object.freeze(snapshots);
  } catch {
    return undefined;
  }
}

function observeNativePromise(
  promise: unknown,
  settled: () => void,
): boolean {
  try {
    Reflect.apply(Promise.prototype.then, promise, [settled, settled]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Default-off in-memory owner for Host carrier producer generations and
 * synchronous Broker result effect partitions. It owns no BrokerCore state,
 * socket, queue, route, timer, or production composition.
 */
export class RelayV2BrokerProducerRegistry {
  private readonly producers = new Map<string, ProducerEntry>();
  private readonly partitions = new Map<string, SourcePartition>();
  private nextGeneration = 0n;
  private nextPartitionId = 0n;
  private nextLeaseId = 0n;

  registerHostProducer(
    transportId: string,
    port: RelayV2BrokerProducerPort,
  ): RelayV2BrokerProducerRegistration {
    if (!isIdentifier(transportId)) {
      throw new Error("invalid Relay v2 Broker producer transport ID");
    }
    if (this.producers.has(transportId)) {
      throw new Error("Relay v2 Broker producer transport is already registered");
    }
    const capturedPort = captureProducerPort(port);
    if (!capturedPort) {
      throw new Error("invalid Relay v2 Broker producer port");
    }
    const generation = (++this.nextGeneration).toString(10);
    const target = Object.freeze({ transportId, generation });
    const entry: ProducerEntry = {
      transportId,
      generation,
      target,
      port: capturedPort,
      phase: "active",
      closeBarrierSettled: false,
      sourcePartitions: 0,
      targetEffects: 0,
      effectEpoch: 0n,
      currentEffect: null,
    };
    this.producers.set(transportId, entry);

    return Object.freeze({
      target,
      runBrokerCall: <Result extends RelayV2BrokerResult>(
        invoke: () => Result,
        partition: RelayV2BrokerResultPartition<Result>,
      ) => this.runProducerBrokerCall(entry, invoke, partition),
      beginClose: (closeBarrier: Promise<unknown>) => {
        this.beginProducerClose(entry, closeBarrier);
      },
    });
  }

  /** One-shot source for Broker calls that do not originate from a carrier. */
  runInternalBrokerCall<Result extends RelayV2BrokerResult>(
    invoke: () => Result,
    partition: RelayV2BrokerResultPartition<Result>,
  ): RelayV2BrokerProducerReceipt {
    this.validateBrokerCallCallbacks(invoke, partition);
    const source = Object.freeze({
      kind: "internal" as const,
      partitionId: (++this.nextPartitionId).toString(10),
    });
    const active: SourcePartition = {
      id: source.partitionId,
      source,
      producer: null,
      active: true,
      failed: false,
      consumedActions: 0,
    };
    this.partitions.set(active.id, active);
    return this.runBrokerCall(active, invoke, partition);
  }

  private runProducerBrokerCall<Result extends RelayV2BrokerResult>(
    entry: ProducerEntry,
    invoke: () => Result,
    partition: RelayV2BrokerResultPartition<Result>,
  ): RelayV2BrokerProducerReceipt {
    this.validateBrokerCallCallbacks(invoke, partition);
    if (!this.canStartSourcePartition(entry)) return "rejected";
    const source = Object.freeze({
      kind: "host" as const,
      transportId: entry.transportId,
      generation: entry.generation,
      partitionId: (++this.nextPartitionId).toString(10),
    });
    const active: SourcePartition = {
      id: source.partitionId,
      source,
      producer: entry,
      active: true,
      failed: false,
      consumedActions: 0,
    };
    entry.sourcePartitions += 1;
    this.partitions.set(active.id, active);
    return this.runBrokerCall(active, invoke, partition);
  }

  private runBrokerCall<Result extends RelayV2BrokerResult>(
    source: SourcePartition,
    invoke: () => Result,
    partition: RelayV2BrokerResultPartition<Result>,
  ): RelayV2BrokerProducerReceipt {
    try {
      const result = Reflect.apply(invoke, undefined, []);
      if (!isOpaqueSynchronousBrokerResult(result)) {
        observeRejectedNativePromise(result);
        return this.rejectSourcePartition(source);
      }
      const handoff = this.createHandoff(source);
      const receipt = Reflect.apply(partition, undefined, [result, handoff]);
      if (receipt !== "applied" && receipt !== "rejected") {
        observeRejectedNativePromise(receipt);
        source.failed = true;
      }
      return receipt === "applied" && !source.failed ? "applied" : "rejected";
    } finally {
      this.retireSourcePartition(source);
    }
  }

  private validateBrokerCallCallbacks(
    invoke: unknown,
    partition: unknown,
  ): void {
    if (typeof invoke !== "function" || typeof partition !== "function") {
      throw new Error("Relay v2 Broker producer call requires synchronous callbacks");
    }
  }

  private createHandoff(source: SourcePartition): RelayV2BrokerProducerHandoff {
    return Object.freeze({
      source: source.source,
      apply: (
        target: RelayV2BrokerProducerTarget,
        actions: readonly RelayV2BrokerProducerAction[],
      ) => this.applyTargetBatch(source, target, actions),
      forceTerminal: (failure: RelayV2BrokerProducerTerminalFailureRequest) => (
        this.forceTargetTerminal(source, failure)
      ),
    });
  }

  private applyTargetBatch(
    source: SourcePartition,
    requestedTarget: unknown,
    requestedActions: unknown,
  ): RelayV2BrokerProducerReceipt {
    if (!this.isSourcePartitionActive(source)) return "rejected";
    const target = readTarget(requestedTarget);
    if (!target) return this.rejectSourcePartition(source);
    const entry = this.exactTarget(target);
    if (!entry || entry.phase !== "active") return this.rejectSourcePartition(source);
    const actions = snapshotActionBatch(
      requestedActions,
      target.transportId,
      RELAY_V2_BROKER_PRODUCER_MAX_ACTIONS - source.consumedActions,
    );
    if (!actions) return this.rejectSourcePartition(source);
    if (
      source.consumedActions
        > RELAY_V2_BROKER_PRODUCER_MAX_ACTIONS - actions.length
    ) return this.rejectSourcePartition(source);
    // A valid group spends its source-partition budget before any adapter
    // call. Rejects, throws, and stale admission discovered below never refund
    // it; later independent groups remain usable only while budget remains.
    source.consumedActions += actions.length;
    return this.invokeTargetEffect(
      source,
      entry,
      "active",
      entry.port.apply,
      [actions],
    );
  }

  private forceTargetTerminal(
    source: SourcePartition,
    request: unknown,
  ): RelayV2BrokerProducerReceipt {
    if (!this.isSourcePartitionActive(source)) return "rejected";
    const record = readOwnDataRecord(request);
    if (!record) return this.rejectSourcePartition(source);
    const kind = record.values.kind;
    const reason = record.values.reason;
    if (!isReason(reason)) return this.rejectSourcePartition(source);

    let target: RelayV2BrokerProducerTarget;
    let failure: RelayV2BrokerProducerTerminalFailure;
    if (kind === "producer_failure") {
      if (!hasExactKeys(record, ["kind", "reason"]) || source.source.kind !== "host") {
        return this.rejectSourcePartition(source);
      }
      target = Object.freeze({
        transportId: source.source.transportId,
        generation: source.source.generation,
      });
      failure = Object.freeze({
        kind,
        source: source.source,
        target,
        reason,
      });
    } else if (kind === "target_failure") {
      if (!hasExactKeys(record, ["kind", "target", "reason"])) {
        return this.rejectSourcePartition(source);
      }
      const parsedTarget = readTarget(record.values.target);
      if (!parsedTarget) return this.rejectSourcePartition(source);
      target = parsedTarget;
      failure = Object.freeze({
        kind,
        source: source.source,
        target,
        reason,
      });
    } else {
      return this.rejectSourcePartition(source);
    }

    const entry = this.exactTarget(target);
    if (!entry || entry.phase === "retired") return this.rejectSourcePartition(source);
    return this.invokeTargetEffect(
      source,
      entry,
      "closing_allowed",
      entry.port.forceTerminal,
      [failure],
    );
  }

  private invokeTargetEffect(
    source: SourcePartition,
    target: ProducerEntry,
    targetAdmission: "active" | "closing_allowed",
    method: (...args: unknown[]) => unknown,
    args: readonly unknown[],
  ): RelayV2BrokerProducerReceipt {
    const current = this.producers.get(target.transportId);
    const targetPhaseValid = targetAdmission === "active"
      ? target.phase === "active"
      : target.phase === "active" || target.phase === "closing";
    if (
      !this.isSourcePartitionActive(source)
      || !current
      || current !== target
      || current.generation !== target.generation
      || !targetPhaseValid
    ) return this.rejectSourcePartition(source);

    const effect: EffectLease = {
      epoch: target.effectEpoch + 1n,
      leaseId: (++this.nextLeaseId).toString(10),
      active: true,
    };
    target.effectEpoch = effect.epoch;
    target.currentEffect = effect;
    target.targetEffects += 1;
    const fence: RelayV2BrokerProducerEffectFence = Object.freeze({
      source: source.source,
      target: target.target,
      effectEpoch: effect.epoch.toString(10),
      leaseId: effect.leaseId,
      mayApply: () => this.mayApplyEffect(
        source,
        target,
        effect,
        targetAdmission,
      ),
    });

    let receipt: unknown = "rejected";
    try {
      receipt = Reflect.apply(method, target.port.receiver, [...args, fence]);
      if (receipt !== "applied" || !fence.mayApply()) {
        if (receipt !== "rejected") observeRejectedNativePromise(receipt);
        return this.rejectSourcePartition(source);
      }
      return "applied";
    } catch {
      return this.rejectSourcePartition(source);
    } finally {
      effect.active = false;
      if (target.currentEffect === effect) target.currentEffect = null;
      target.targetEffects -= 1;
      this.maybeRetireProducer(target);
    }
  }

  private mayApplyEffect(
    source: SourcePartition,
    target: ProducerEntry,
    effect: EffectLease,
    targetAdmission: "active" | "closing_allowed",
  ): boolean {
    const current = this.producers.get(target.transportId);
    const currentEffect = target.currentEffect;
    const targetPhaseValid = targetAdmission === "active"
      ? target.phase === "active"
      : target.phase === "active" || target.phase === "closing";
    return effect.active
      && this.isSourcePartitionActive(source)
      && current === target
      && current.generation === target.generation
      && targetPhaseValid
      && currentEffect === effect
      && currentEffect.epoch === effect.epoch
      && currentEffect.leaseId === effect.leaseId;
  }

  private isSourcePartitionActive(source: SourcePartition): boolean {
    if (!source.active || this.partitions.get(source.id) !== source) return false;
    if (!source.producer) return source.source.kind === "internal";
    return source.source.kind === "host"
      && this.producers.get(source.producer.transportId) === source.producer
      && source.producer.generation === source.source.generation
      && source.producer.phase !== "retired";
  }

  private rejectSourcePartition(source: SourcePartition): "rejected" {
    // This latches the final call receipt but deliberately leaves the active
    // partition available for independent mandatory target groups and exact
    // terminal cleanup from the same opaque Broker result.
    if (source.active) source.failed = true;
    return "rejected";
  }

  private canStartSourcePartition(entry: ProducerEntry): boolean {
    if (this.producers.get(entry.transportId) !== entry) return false;
    if (entry.phase === "active") return true;
    return entry.phase === "closing" && !entry.closeBarrierSettled;
  }

  private exactTarget(target: RelayV2BrokerProducerTarget): ProducerEntry | undefined {
    const entry = this.producers.get(target.transportId);
    return entry?.generation === target.generation ? entry : undefined;
  }

  private beginProducerClose(entry: ProducerEntry, closeBarrier: unknown): void {
    if (this.producers.get(entry.transportId) !== entry || entry.phase !== "active") {
      throw new Error("Relay v2 Broker producer registration is not active");
    }
    // Target admission closes before touching the external barrier. Exact
    // source partitions remain admitted until its settlement callback runs.
    entry.phase = "closing";
    const settled = () => {
      if (entry.phase !== "closing" || entry.closeBarrierSettled) return;
      entry.closeBarrierSettled = true;
      this.maybeRetireProducer(entry);
    };
    if (!observeNativePromise(closeBarrier, settled)) {
      settled();
      throw new Error("Relay v2 Broker producer close barrier must be a native Promise");
    }
  }

  private retireSourcePartition(source: SourcePartition): void {
    if (!source.active) return;
    source.active = false;
    this.partitions.delete(source.id);
    if (source.producer) {
      source.producer.sourcePartitions -= 1;
      this.maybeRetireProducer(source.producer);
    }
  }

  private maybeRetireProducer(entry: ProducerEntry): void {
    if (
      entry.phase !== "closing"
      || !entry.closeBarrierSettled
      || entry.sourcePartitions !== 0
      || entry.targetEffects !== 0
    ) return;
    entry.phase = "retired";
    entry.currentEffect = null;
    if (this.producers.get(entry.transportId) === entry) {
      this.producers.delete(entry.transportId);
    }
  }
}
