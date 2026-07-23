import { types as nodeTypes } from "node:util";
import type { TerminalControlLease, TerminalControlOwner } from "../../terminalControl/protocol.js";
import { TerminalControlProtocolError } from "../../terminalControl/protocol.js";
import type {
  RelayV2ExactTerminalControlTargetInputV1,
} from "./canonicalTerminalTargetResolverAdapter.js";
import type {
  RelayV2ExactCompoundObservationBindingV1,
  RelayV2RemoteExactTerminalControlCompoundAdapterV1,
} from "./remoteExactTerminalControlCompoundV1.js";
import type {
  RelayV2TerminalBackendClose,
  RelayV2TerminalBackendObserver,
  RelayV2TerminalByteBackend,
  RelayV2TerminalByteHandle,
  RelayV2TerminalCanonicalTargetBindingV1,
  RelayV2TerminalExactEffectTargetV1,
  RelayV2TerminalResolvedTarget,
} from "./terminalManager.js";

const RELAY_V2_TERMINAL_EXACT_EFFECT_TARGET = Symbol.for(
  "tmux-worktree.relay-v2.terminal-exact-effect-target",
);

const DEFAULT_IDLE_POLL_MS = 25;
const MAX_OBSERVED_CHUNK_BYTES = 384 * 1024;
const MAX_HINT_COLS = 1_000;
const MAX_HINT_ROWS = 500;

function bounded(value: unknown, maxBytes = 128): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || /[\0\r\n]/.test(value)
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new TerminalControlProtocolError(
      "PERMISSION_DENIED",
      "observed byte plane exact target is invalid",
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}

/**
 * One-shot own-data snapshot of a plain record at this boundary. Proxies,
 * accessors, symbol keys, non-enumerable keys, extra keys, and foreign
 * prototypes are rejected; every later validation reads only the snapshot.
 */
function snapshotExactDataRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | null {
  if (value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeTypes.isProxy(value)) return null;
  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    return null;
  }
  if (prototype !== Object.prototype && prototype !== null) return null;
  const allowed = [...required, ...optional];
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) => typeof key !== "string" || !allowed.includes(key))) return null;
  const invalidDescriptor = (descriptor: PropertyDescriptor | undefined): boolean => (
    descriptor === undefined
    || !Object.hasOwn(descriptor, "value")
    || descriptor.enumerable !== true
  );
  if (required.some((key) => invalidDescriptor(descriptors[key]))
    || optional.some((key) => (
      descriptors[key] !== undefined && invalidDescriptor(descriptors[key])
    ))) return null;
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of allowed) {
    const descriptor = descriptors[key];
    if (descriptor !== undefined) snapshot[key] = descriptor.value;
  }
  return snapshot;
}

function invalidTarget(): never {
  throw new TerminalControlProtocolError(
    "PERMISSION_DENIED",
    "observed byte plane exact target is invalid",
  );
}

function resolvedTarget(value: unknown): RelayV2TerminalResolvedTarget {
  const snapshot = snapshotExactDataRecord(value, [
    "hostId", "scopeId", "sessionId", "pane", "canonicalTargetId", "controlTargetId",
  ]);
  if (snapshot === null
    || !Number.isSafeInteger(snapshot.pane)
    || (snapshot.pane as number) < 0
    || (snapshot.pane as number) > 65_535) {
    invalidTarget();
  }
  return Object.freeze({
    hostId: bounded(snapshot.hostId),
    scopeId: bounded(snapshot.scopeId),
    sessionId: bounded(snapshot.sessionId),
    pane: snapshot.pane as number,
    canonicalTargetId: bounded(snapshot.canonicalTargetId),
    controlTargetId: bounded(snapshot.controlTargetId),
  });
}

function canonicalTargetBinding(
  value: unknown,
  expected?: RelayV2TerminalResolvedTarget,
): RelayV2TerminalCanonicalTargetBindingV1 {
  const snapshot = snapshotExactDataRecord(value, [
    "schemaVersion", "hostId", "scopeId", "sessionId", "pane", "processTarget",
    "backendInstanceKey", "managedTarget", "exactControlIdentity",
  ]);
  if (snapshot === null || snapshot.schemaVersion !== 1) invalidTarget();
  const processTarget = snapshotExactDataRecord(snapshot.processTarget, ["kind", "targetId"]);
  const managedTarget = snapshotExactDataRecord(snapshot.managedTarget, [
    "name", "kind", "incarnation",
  ]);
  const identity = snapshotExactDataRecord(snapshot.exactControlIdentity, [
    "schemaVersion", "controlTargetId", "controlEpoch", "targetIncarnationProof",
  ]);
  if (processTarget === null
    || (processTarget.kind !== "local" && processTarget.kind !== "ssh")
    || managedTarget === null
    || (managedTarget.kind !== "worktree" && managedTarget.kind !== "terminal")
    || identity === null
    || identity.schemaVersion !== 1
    || !Number.isSafeInteger(snapshot.pane)
    || (snapshot.pane as number) < 0
    || (snapshot.pane as number) > 65_535) {
    invalidTarget();
  }
  const binding: RelayV2TerminalCanonicalTargetBindingV1 = Object.freeze({
    schemaVersion: 1,
    hostId: bounded(snapshot.hostId),
    scopeId: bounded(snapshot.scopeId),
    sessionId: bounded(snapshot.sessionId),
    pane: snapshot.pane as number,
    processTarget: Object.freeze({
      kind: processTarget.kind,
      targetId: bounded(processTarget.targetId),
    }),
    backendInstanceKey: bounded(snapshot.backendInstanceKey),
    managedTarget: Object.freeze({
      name: bounded(managedTarget.name),
      kind: managedTarget.kind,
      incarnation: bounded(managedTarget.incarnation, 256),
    }),
    exactControlIdentity: Object.freeze({
      schemaVersion: 1,
      controlTargetId: bounded(identity.controlTargetId),
      controlEpoch: bounded(identity.controlEpoch),
      targetIncarnationProof: bounded(identity.targetIncarnationProof),
    }),
  });
  if (expected !== undefined
    && (binding.hostId !== expected.hostId
      || binding.scopeId !== expected.scopeId
      || binding.sessionId !== expected.sessionId
      || binding.pane !== expected.pane
      || binding.backendInstanceKey !== expected.canonicalTargetId
      || binding.exactControlIdentity.controlTargetId !== expected.controlTargetId)) {
    throw new TerminalControlProtocolError(
      "PERMISSION_DENIED",
      "observed byte plane exact target binding crossed its resolved target",
    );
  }
  return binding;
}

function exactEffectTarget(value: unknown): RelayV2TerminalCanonicalTargetBindingV1 {
  if (value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeTypes.isProxy(value)) {
    throw new TerminalControlProtocolError(
      "PERMISSION_DENIED",
      "observed byte plane requires an exact effect target",
    );
  }
  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new TerminalControlProtocolError(
      "PERMISSION_DENIED",
      "observed byte plane requires an exact effect target",
    );
  }
  const stringKeys = ["schemaVersion", "resolvedTarget", "binding"] as const;
  const brand = descriptors[RELAY_V2_TERMINAL_EXACT_EFFECT_TARGET];
  if ((prototype !== Object.prototype && prototype !== null)
    || Reflect.ownKeys(descriptors).length !== 4
    || brand === undefined
    || !Object.hasOwn(brand, "value")
    || brand.enumerable !== true
    || brand.value !== true
    || stringKeys.some((key) => {
      const descriptor = descriptors[key];
      return descriptor === undefined
        || !Object.hasOwn(descriptor, "value")
        || descriptor.enumerable !== true;
    })) {
    throw new TerminalControlProtocolError(
      "PERMISSION_DENIED",
      "observed byte plane requires an exact effect target",
    );
  }
  if (descriptors.schemaVersion!.value !== 1) invalidTarget();
  const resolved = resolvedTarget(descriptors.resolvedTarget!.value);
  return canonicalTargetBinding(descriptors.binding!.value, resolved);
}

function owner(value: unknown): TerminalControlOwner & { kind: "relay-v2" } {
  const snapshot = snapshotExactDataRecord(value, ["kind", "instanceId"]);
  if (snapshot === null || snapshot.kind !== "relay-v2") {
    throw new TerminalControlProtocolError(
      "PERMISSION_DENIED",
      "observed byte plane lease owner is invalid",
    );
  }
  return Object.freeze({
    kind: "relay-v2",
    instanceId: bounded(snapshot.instanceId, 256),
  });
}

interface CapturedObserver {
  readonly receiver: object;
  readonly onBytes: (data: Uint8Array) => unknown;
  readonly onClosed: (result: RelayV2TerminalBackendClose) => unknown;
}

interface CapturedPortMethod {
  readonly receiver: object;
  readonly method: (...args: never[]) => unknown;
}

/**
 * Captures one callable once, walking the own/prototype chain with descriptor
 * checks and rejecting Proxies. The original receiver is preserved for every
 * later Reflect.apply, so `this` is never lost and the foreign property is
 * never re-read.
 */
function capturePortMethod(value: unknown, key: string): CapturedPortMethod | null {
  if (value === null
    || (typeof value !== "object" && typeof value !== "function")
    || nodeTypes.isProxy(value)) return null;
  const receiver = value as object;
  const seen = new Set<object>();
  let owner: object | null = receiver;
  for (let depth = 0; owner !== null && depth < 32; depth += 1) {
    if (nodeTypes.isProxy(owner) || seen.has(owner)) return null;
    seen.add(owner);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(owner, key);
    } catch {
      return null;
    }
    if (descriptor !== undefined) {
      if (!Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
        return null;
      }
      return Object.freeze({
        receiver,
        method: descriptor.value as (...args: never[]) => unknown,
      });
    }
    try {
      owner = Object.getPrototypeOf(owner) as object | null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Snapshots the observer's callables once. Every later callback uses
 * Reflect.apply with the original receiver, so a foreign accessor can never
 * substitute a callback after open and `this` is never lost.
 */
function captureObserver(value: unknown): CapturedObserver {
  const snapshot = snapshotExactDataRecord(value, ["onBytes", "onClosed"]);
  if (snapshot === null
    || typeof snapshot.onBytes !== "function"
    || typeof snapshot.onClosed !== "function") {
    throw new TerminalControlProtocolError(
      "PERMISSION_DENIED",
      "observed byte plane observer is invalid",
    );
  }
  return Object.freeze({
    receiver: value as object,
    onBytes: snapshot.onBytes as (data: Uint8Array) => unknown,
    onClosed: snapshot.onClosed as (result: RelayV2TerminalBackendClose) => unknown,
  });
}

function displaySizeHint(value: unknown): Readonly<{ cols: number; rows: number }> {
  const snapshot = snapshotExactDataRecord(value, ["cols", "rows"]);
  if (snapshot === null
    || !Number.isSafeInteger(snapshot.cols)
    || (snapshot.cols as number) < 1
    || (snapshot.cols as number) > MAX_HINT_COLS
    || !Number.isSafeInteger(snapshot.rows)
    || (snapshot.rows as number) < 1
    || (snapshot.rows as number) > MAX_HINT_ROWS) {
    throw new TerminalControlProtocolError(
      "INVALID_REQUEST",
      "observed byte plane display size hint is invalid",
    );
  }
  return Object.freeze({
    cols: snapshot.cols as number,
    rows: snapshot.rows as number,
  });
}

function openOptions(value: unknown): {
  maxChunkBytes: number;
  displaySizeHint: Readonly<{ cols: number; rows: number }>;
} {
  const snapshot = snapshotExactDataRecord(value, ["maxChunkBytes", "displaySizeHint"]);
  if (snapshot === null
    || !Number.isSafeInteger(snapshot.maxChunkBytes)
    || (snapshot.maxChunkBytes as number) < 1
    || (snapshot.maxChunkBytes as number) > MAX_OBSERVED_CHUNK_BYTES) {
    throw new TerminalControlProtocolError(
      "PERMISSION_DENIED",
      "observed byte plane open options are invalid",
    );
  }
  return Object.freeze({
    maxChunkBytes: snapshot.maxChunkBytes as number,
    displaySizeHint: displaySizeHint(snapshot.displaySizeHint),
  });
}

interface ObservationChunk {
  readonly bytes: Buffer;
  readonly nextCursor: number;
}

/**
 * Byte-plane validation of one tail chunk. The compound owner already
 * validated the frame shape; this boundary re-proves the exact own-data
 * snapshot, the pinned observation identity, canonical Base64, and exact
 * cursor continuity before any byte is trusted. An empty payload is the
 * existing idle signal ("" round-trips canonically, nextCursor === cursor).
 */
function observationChunk(
  value: unknown,
  observation: RelayV2ExactCompoundObservationBindingV1,
  expectedCursor: number,
  maxChunkBytes: number,
): ObservationChunk | null {
  const snapshot = snapshotExactDataRecord(value, [
    "controlEpoch", "outputGeneration", "cursor", "dataBase64", "nextCursor",
  ]);
  if (snapshot === null
    || snapshot.controlEpoch !== observation.controlEpoch
    || snapshot.outputGeneration !== observation.outputGeneration
    || !Number.isSafeInteger(snapshot.cursor)
    || (snapshot.cursor as number) < 0
    || snapshot.cursor !== expectedCursor
    || !Number.isSafeInteger(snapshot.nextCursor)
    || (snapshot.nextCursor as number) < 0
    || typeof snapshot.dataBase64 !== "string") {
    return null;
  }
  const encoded = snapshot.dataBase64 as string;
  // Reject before decoding: a canonical Base64 payload of at most
  // maxChunkBytes decoded bytes never exceeds this encoded length, so an
  // oversize string fails without allocating its decoded buffer first.
  if (encoded.length > 4 * Math.ceil(maxChunkBytes / 3)) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded
    || bytes.byteLength > maxChunkBytes
    || snapshot.nextCursor !== (snapshot.cursor as number) + bytes.byteLength) {
    return null;
  }
  return Object.freeze({
    bytes,
    nextCursor: snapshot.nextCursor as number,
  });
}

/**
 * Byte-plane validation of the observation cut returned at open. The same
 * exact own-data snapshot discipline applies here, and the cut must re-prove
 * the binding's exact control identity before any record is built from it.
 */
function observationCut(
  value: unknown,
  binding: RelayV2TerminalCanonicalTargetBindingV1,
): RelayV2ExactCompoundObservationBindingV1 {
  const snapshot = snapshotExactDataRecord(value, [
    "schemaVersion", "controlTargetId", "controlEpoch", "targetIncarnationProof",
    "outputGeneration", "outputCursor",
  ]);
  if (snapshot === null
    || snapshot.schemaVersion !== 1
    || !Number.isSafeInteger(snapshot.outputCursor)
    || (snapshot.outputCursor as number) < 0
    || snapshot.controlTargetId !== binding.exactControlIdentity.controlTargetId
    || snapshot.controlEpoch !== binding.exactControlIdentity.controlEpoch
    || snapshot.targetIncarnationProof
      !== binding.exactControlIdentity.targetIncarnationProof) {
    throw new TerminalControlProtocolError(
      "PERMISSION_DENIED",
      "observed byte plane observation cut crossed its binding",
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    controlTargetId: bounded(snapshot.controlTargetId),
    controlEpoch: bounded(snapshot.controlEpoch),
    targetIncarnationProof: bounded(snapshot.targetIncarnationProof),
    outputGeneration: bounded(snapshot.outputGeneration),
    outputCursor: snapshot.outputCursor as number,
  });
}

export interface RelayV2TerminalControlObservedLazyLeasePortV1 {
  consumePreparedLeaseForBinding(
    binding: RelayV2TerminalCanonicalTargetBindingV1,
    owner: TerminalControlOwner & { kind: "relay-v2" },
  ): Promise<TerminalControlLease>;
}

export interface RelayV2TerminalControlObservedBytePlaneAdapterOptionsV1 {
  readonly exactTargets: RelayV2RemoteExactTerminalControlCompoundAdapterV1;
  /** Idle tail poll interval; test isolation may shorten it. */
  readonly idlePollMs?: number;
}

interface ObservedHandleRecord {
  readonly binding: RelayV2TerminalCanonicalTargetBindingV1;
  readonly bindingJson: string;
  readonly observation: RelayV2ExactCompoundObservationBindingV1;
  readonly maxChunkBytes: number;
  readonly observer: CapturedObserver;
  cursor: number;
  displaySizeHint: Readonly<{ cols: number; rows: number }>;
  paused: boolean;
  closed: boolean;
  callbacksFenced: boolean;
  onClosedDelivered: boolean;
  pumping: boolean;
  pendingBytes: Buffer | null;
  leasePreparing: boolean;
  inflightTail: Promise<void> | null;
  closeBarrier: Promise<void> | null;
  cleanupBarrier: Promise<void> | null;
  closeSelf(): Promise<void>;
}

/**
 * The captured exact-compound port this adapter consumes. Every method is
 * captured once at construction with its original receiver and invoked
 * through Reflect.apply, so no foreign property is ever re-read.
 */
type ExactTargetsPort = Pick<
  RelayV2RemoteExactTerminalControlCompoundAdapterV1,
  | "observePreparedTargetForBinding"
  | "tailObservedTarget"
  | "prepareObservedTargetLease"
  | "fenceExactTargetForAdmission"
  | "consumePreparedLeaseForBinding"
  | "closeObservedTarget"
>;

/**
 * Byte-plane consumer over the host-side exact compound owner. It owns no
 * claim, ring, tmux access, generic output.tail, retry, or fallback: every
 * observation, tail, lazy lease, and close travels the same per-target
 * compound channel owned by RelayV2RemoteExactTerminalControlCompoundAdapterV1,
 * and TerminalControlAuthority on the target host remains the only lease,
 * input, resize, and output authority.
 */
export class RelayV2TerminalControlObservedBytePlaneAdapterV1
implements RelayV2TerminalByteBackend {
  private readonly exactTargets: ExactTargetsPort;
  private readonly idlePollMs: number;
  private readonly records = new Map<string, ObservedHandleRecord>();
  private admissionClosed = false;
  private adapterCloseBarrier: Promise<void> | null = null;
  readonly lazyLeasePort: RelayV2TerminalControlObservedLazyLeasePortV1;

  constructor(options: RelayV2TerminalControlObservedBytePlaneAdapterOptionsV1) {
    const snapshot = snapshotExactDataRecord(options, ["exactTargets"], ["idlePollMs"]);
    if (snapshot === null
      || (snapshot.idlePollMs !== undefined
        && (!Number.isSafeInteger(snapshot.idlePollMs)
          || (snapshot.idlePollMs as number) < 1))) {
      throw new TypeError("observed byte plane adapter options are invalid");
    }
    const methods = Object.create(null) as Record<string, CapturedPortMethod>;
    for (const key of [
      "observePreparedTargetForBinding",
      "tailObservedTarget",
      "prepareObservedTargetLease",
      "fenceExactTargetForAdmission",
      "consumePreparedLeaseForBinding",
      "closeObservedTarget",
    ]) {
      const captured = capturePortMethod(snapshot.exactTargets, key);
      if (captured === null) {
        throw new TypeError("observed byte plane adapter options are invalid");
      }
      methods[key] = captured;
    }
    const call = <T>(key: string, args: readonly unknown[]): T => Reflect.apply(
      methods[key].method,
      methods[key].receiver,
      [...args],
    ) as T;
    const port: ExactTargetsPort = {
      observePreparedTargetForBinding: (binding) => (
        call("observePreparedTargetForBinding", [binding])
      ),
      tailObservedTarget: (observation, cursor, maxBytes) => (
        call("tailObservedTarget", [observation, cursor, maxBytes])
      ),
      prepareObservedTargetLease: (observation) => (
        call("prepareObservedTargetLease", [observation])
      ),
      fenceExactTargetForAdmission: (input, evidence) => {
        call("fenceExactTargetForAdmission", [input, evidence]);
      },
      consumePreparedLeaseForBinding: (binding, consumerOwner) => (
        call("consumePreparedLeaseForBinding", [binding, consumerOwner])
      ),
      closeObservedTarget: (observation) => (
        call("closeObservedTarget", [observation])
      ),
    };
    this.exactTargets = Object.freeze(port);
    this.idlePollMs = (snapshot.idlePollMs as number | undefined) ?? DEFAULT_IDLE_POLL_MS;
    const lazyLeasePort: RelayV2TerminalControlObservedLazyLeasePortV1 = {
      consumePreparedLeaseForBinding: (binding, consumerOwner) => (
        this.consumeLazyLease(binding, consumerOwner)
      ),
    };
    this.lazyLeasePort = Object.freeze(lazyLeasePort);
  }

  private idle(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.idlePollMs);
      timer.unref?.();
    });
  }

  /**
   * The single cleanup authority for one attachment. The record is deleted
   * only after closeObservedTarget is confirmed (including the compound
   * owner's internal claim rollback). A failure is never swallowed: the
   * barrier resets, the record stays fenced in the map, and a later
   * drain/close retries the same record. Both waits stay on bounded
   * primitives only: the in-flight tail and the close-observe each travel
   * the compound channel's bounded requestOne (30s timeout + socket
   * destroy/kill), so cleanup never waits on an unbounded promise.
   */
  private ensureCleanup(record: ObservedHandleRecord): Promise<void> {
    if (record.cleanupBarrier !== null) return record.cleanupBarrier;
    record.cleanupBarrier = (async () => {
      try {
        if (record.inflightTail !== null) await record.inflightTail;
        await this.exactTargets.closeObservedTarget(record.observation);
      } catch (error) {
        record.cleanupBarrier = null;
        throw error;
      }
      this.records.delete(record.bindingJson);
    })();
    return record.cleanupBarrier;
  }

  /** Fences callbacks and drops any buffered chunk; returns true exactly once. */
  private fenceRecord(record: ObservedHandleRecord): boolean {
    record.callbacksFenced = true;
    record.pendingBytes = null;
    if (record.closed || record.onClosedDelivered) return false;
    record.onClosedDelivered = true;
    return true;
  }

  private async failClosed(record: ObservedHandleRecord): Promise<void> {
    if (!this.fenceRecord(record)) return;
    try {
      await Reflect.apply(record.observer.onClosed, record.observer.receiver, [
        { reason: "backend_error", exitCode: null },
      ]);
    } catch {
      // A fenced observer rejection cannot reopen the attachment.
    }
    // The fenced observation is never left to leak behind the dropped handle:
    // cleanup starts here, and a cleanup failure keeps the record fenced in
    // the map (barrier reset by ensureCleanup) for adapter.close() to retry
    // and surface. A consumer-initiated close still goes through the record's
    // own barrier and never passes through here.
    void this.ensureCleanup(record).catch(() => undefined);
  }

  /**
   * Fences the record from the manager serializer without awaiting the
   * observer: the observer re-enters that serializer, so awaiting it here
   * would deadlock the queue. Source order is preserved because every earlier
   * onBytes call was already serialized before this fence.
   */
  private failClosedFromSerializer(record: ObservedHandleRecord): void {
    if (!this.fenceRecord(record)) return;
    try {
      void Promise.resolve(Reflect.apply(
        record.observer.onClosed,
        record.observer.receiver,
        [{ reason: "backend_error", exitCode: null }],
      )).catch(() => undefined);
    } catch {
      // A fenced observer failure cannot reopen the attachment.
    }
  }

  private pump(record: ObservedHandleRecord): void {
    if (record.pumping) return;
    record.pumping = true;
    void (async () => {
      try {
        while (!record.closed
          && !record.paused
          && !record.callbacksFenced) {
          if (record.pendingBytes !== null) {
            // A chunk buffered while paused is delivered before any newer tail.
            const pending = record.pendingBytes;
            record.pendingBytes = null;
            try {
              await Reflect.apply(record.observer.onBytes, record.observer.receiver, [pending]);
            } catch {
              await this.failClosed(record);
              return;
            }
            if (record.closed || record.callbacksFenced) return;
            continue;
          }
          let chunkValue;
          const inflight = this.exactTargets.tailObservedTarget(
            record.observation,
            record.cursor,
            record.maxChunkBytes,
          );
          record.inflightTail = inflight.then(() => undefined, () => undefined);
          try {
            chunkValue = await inflight;
          } catch {
            record.inflightTail = null;
            // The authority fenced or rejected this observation (including
            // STALE_OUTPUT_CURSOR). Fail closed exactly once; never retry.
            await this.failClosed(record);
            return;
          }
          record.inflightTail = null;
          if (record.closed || record.callbacksFenced) return;
          const chunk = observationChunk(
            chunkValue,
            record.observation,
            record.cursor,
            record.maxChunkBytes,
          );
          if (chunk === null) {
            await this.failClosed(record);
            return;
          }
          record.cursor = chunk.nextCursor;
          if (chunk.bytes.byteLength === 0) {
            await this.idle();
            continue;
          }
          if (record.paused) {
            // Pause landed while this tail was in flight: buffer the chunk in
            // order and stop pushing until resume. It is never dropped and
            // never delivered past the fence.
            record.pendingBytes = chunk.bytes;
            return;
          }
          try {
            await Reflect.apply(
              record.observer.onBytes,
              record.observer.receiver,
              [chunk.bytes],
            );
          } catch {
            await this.failClosed(record);
            return;
          }
          if (record.closed || record.callbacksFenced) return;
        }
      } finally {
        record.pumping = false;
      }
    })();
  }

  async open(
    target: RelayV2TerminalExactEffectTargetV1,
    options: {
      maxChunkBytes: number;
      displaySizeHint: { cols: number; rows: number };
    },
    observer: RelayV2TerminalBackendObserver,
  ): Promise<RelayV2TerminalByteHandle> {
    if (this.admissionClosed) {
      throw new TerminalControlProtocolError(
        "RESOURCE_EXHAUSTED",
        "observed byte plane admission is closed",
        true,
      );
    }
    const binding = exactEffectTarget(target);
    const openInput = openOptions(options);
    const capturedObserver = captureObserver(observer);
    if (this.records.has(canonicalJson(binding))) {
      throw new TerminalControlProtocolError(
        "PERMISSION_DENIED",
        "observed byte plane attachment is not fresh",
      );
    }
    // Every foreign input is already snapshotted above; nothing is re-read
    // after this await. The returned cut is snapshotted and re-correlated
    // with the binding before any record is built from it.
    const observation = observationCut(
      await this.exactTargets.observePreparedTargetForBinding(binding),
      binding,
    );
    const record: ObservedHandleRecord = {
      binding,
      bindingJson: canonicalJson(binding),
      observation,
      maxChunkBytes: openInput.maxChunkBytes,
      observer: capturedObserver,
      cursor: observation.outputCursor,
      displaySizeHint: openInput.displaySizeHint,
      paused: false,
      closed: false,
      callbacksFenced: false,
      onClosedDelivered: false,
      pumping: false,
      pendingBytes: null,
      leasePreparing: false,
      inflightTail: null,
      closeBarrier: null,
      cleanupBarrier: null,
      closeSelf: () => {
        record.closed = true;
        record.callbacksFenced = true;
        record.pendingBytes = null;
        // The drain path must be able to retry a failed cleanup, so it goes
        // through the retryable barrier instead of the memoized close.
        return this.ensureCleanup(record);
      },
    };
    const close = (): Promise<void> => {
      if (record.closeBarrier !== null) return record.closeBarrier;
      record.closed = true;
      record.callbacksFenced = true;
      record.pendingBytes = null;
      // Close settles on the record's single cleanup barrier. An in-flight
      // observer callback is fenced, never awaited: the manager re-enters
      // this close after fencing its generation.
      record.closeBarrier = this.ensureCleanup(record);
      return record.closeBarrier;
    };
    this.records.set(record.bindingJson, record);
    this.pump(record);
    return Object.freeze({
      pause(): Promise<void> {
        record.paused = true;
        return Promise.resolve();
      },
      resume: (): Promise<void> => {
        record.paused = false;
        if (!record.closed && !record.callbacksFenced) this.pump(record);
        return Promise.resolve();
      },
      setDisplaySizeHint(size: { cols: number; rows: number }): Promise<void> {
        let hint: Readonly<{ cols: number; rows: number }>;
        try {
          hint = displaySizeHint(size);
        } catch (error) {
          return Promise.reject(error);
        }
        record.displaySizeHint = hint;
        return Promise.resolve();
      },
      close,
    });
  }

  private async consumeLazyLease(
    binding: RelayV2TerminalCanonicalTargetBindingV1,
    consumerOwner: TerminalControlOwner & { kind: "relay-v2" },
  ): Promise<TerminalControlLease> {
    const parsedOwner = owner(consumerOwner);
    const bindingJson = canonicalJson(canonicalTargetBinding(binding));
    const matches = [...this.records.values()].filter((record) => (
      !record.closed && !record.callbacksFenced && record.bindingJson === bindingJson
    ));
    if (matches.length !== 1) {
      throw new TerminalControlProtocolError(
        "PERMISSION_DENIED",
        "observed byte plane observation is unavailable",
      );
    }
    const record = matches[0];
    if (record.leasePreparing) {
      throw new TerminalControlProtocolError(
        "PERMISSION_DENIED",
        "observed byte plane lease preparation is already in flight",
      );
    }
    record.leasePreparing = true;
    try {
      // Re-prepare, fence, and consume strictly in order on the same compound
      // channel that owns this observation.
      const evidence = await this.exactTargets.prepareObservedTargetLease(record.observation);
      const { exactControlToken: _token, exactControlIdentity, ...input } = evidence;
      const exactInput = input as RelayV2ExactTerminalControlTargetInputV1;
      this.exactTargets.fenceExactTargetForAdmission(exactInput, evidence);
      const freshBinding: RelayV2TerminalCanonicalTargetBindingV1 = {
        ...input,
        schemaVersion: 1,
        exactControlIdentity,
      };
      const lease = await this.exactTargets.consumePreparedLeaseForBinding(
        freshBinding,
        parsedOwner,
      );
      record.leasePreparing = false;
      return lease;
    } catch (error) {
      // Any failure fails closed once and stays there: fence the attachment
      // (the pump stops, callbacks are fenced, onClosed is delivered exactly
      // once without being awaited on this serializer), then run cleanup
      // through the record's retryable barrier. A cleanup failure is never
      // swallowed: the record stays fenced in the map and adapter.close()
      // re-drains it, so the claim cannot leak past the fence and nothing is
      // left re-enterable.
      this.failClosedFromSerializer(record);
      await this.ensureCleanup(record).catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.adapterCloseBarrier !== null) return this.adapterCloseBarrier;
    this.admissionClosed = true;
    const drain = (async () => {
      let firstFailure: unknown = null;
      for (const record of [...this.records.values()]) {
        try {
          await record.closeSelf();
        } catch (error) {
          if (firstFailure === null) firstFailure = error;
        }
      }
      if (firstFailure !== null) throw firstFailure;
    })();
    this.adapterCloseBarrier = drain;
    try {
      await drain;
    } catch (error) {
      // A failed drain is explicit and retryable: unfinished records stay
      // fenced in the map, the first failure surfaces here, and the next
      // close() re-drains them. New opens stay fenced regardless.
      this.adapterCloseBarrier = null;
      throw error;
    }
  }
}
