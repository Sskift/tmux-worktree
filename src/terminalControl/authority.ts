import { createHash, randomUUID } from "node:crypto";
import type {
  TerminalControlDrainProof,
  TerminalControlLease,
  TerminalControlOwner,
  TerminalControlOwnershipView,
  TerminalControlRecoveryProof,
  TerminalControlRequest,
} from "./protocol";
import {
  TERMINAL_CONTROL_DEFAULT_LEASE_TTL_MS,
  TERMINAL_CONTROL_MAX_LEASE_TTL_MS,
  TERMINAL_CONTROL_MAX_OUTPUT_TAIL_BYTES,
  TerminalControlProtocolError,
} from "./protocol";
import { TmuxTerminalControlBackend, type TerminalControlBackend } from "./backend";
import {
  acquireTerminalControlStoreLock,
  leaseFromTarget,
  loadTerminalControlState,
  nextDecimal,
  releaseTerminalControlStoreLock,
  sameOwner,
  saveTerminalControlState,
  terminalControlStatePath,
  type TerminalControlOperationRecord,
  type TerminalControlRecoveryReason,
  type TerminalControlState,
  type TerminalControlTargetRecord,
} from "./store";

const MAX_COMPLETED_OPERATIONS = 128;

export interface TerminalControlRelayV2ExactTargetInput {
  schemaVersion: 1;
  hostId: string;
  scopeId: string;
  sessionId: string;
  pane: number;
  processTarget: {
    kind: "local" | "ssh";
    targetId: string;
  };
  backendInstanceKey: string;
  managedTarget: {
    name: string;
    kind: "worktree" | "terminal";
    incarnation: string;
  };
  owner: TerminalControlOwner & { kind: "relay-v2" };
}

export interface TerminalControlRelayV2ExactTargetIdentity {
  schemaVersion: 1;
  controlTargetId: string;
  controlEpoch: string;
  targetIncarnationProof: string;
}

declare const terminalControlRelayV2ExactTargetClaimBrand: unique symbol;

/** Opaque, process-local authority. It has no wire or persisted representation. */
export interface TerminalControlRelayV2ExactTargetClaim {
  readonly [terminalControlRelayV2ExactTargetClaimBrand]: true;
}

declare const terminalControlRelayV2ExactObservationBrand: unique symbol;

/**
 * Opaque, process-local read-observation handle. It pins one exact target
 * binding and one output generation; it never grants input ownership and has
 * no wire or persisted representation.
 */
export interface TerminalControlRelayV2ExactObservation {
  readonly [terminalControlRelayV2ExactObservationBrand]: true;
}

export interface TerminalControlRelayV2ExactObservationBinding {
  schemaVersion: 1;
  controlTargetId: string;
  controlEpoch: string;
  targetIncarnationProof: string;
  outputGeneration: string;
  outputCursor: number;
}

export interface TerminalControlRelayV2ExactObservationOpen {
  observation: TerminalControlRelayV2ExactObservation;
  binding: TerminalControlRelayV2ExactObservationBinding;
}

export interface TerminalControlRelayV2ExactObservationTail {
  controlEpoch: string;
  outputGeneration: string;
  cursor: number;
  dataBase64: string;
  nextCursor: number;
}

export interface TerminalControlRelayV2ExactTargetPreparation {
  preparationId: string;
  claim: TerminalControlRelayV2ExactTargetClaim;
  identity: TerminalControlRelayV2ExactTargetIdentity;
  expiresAt: string;
}

export interface TerminalControlRelayV2ExactTargetAuthorityPort {
  prepareRelayV2ExactTarget(
    input: TerminalControlRelayV2ExactTargetInput,
  ): Promise<TerminalControlRelayV2ExactTargetPreparation>;
  fenceRelayV2ExactTarget(
    claim: TerminalControlRelayV2ExactTargetClaim,
    input: TerminalControlRelayV2ExactTargetInput,
  ): void;
  consumeRelayV2ExactTarget(
    claim: TerminalControlRelayV2ExactTargetClaim,
    input: TerminalControlRelayV2ExactTargetInput,
    owner?: TerminalControlOwner & { kind: "relay-v2" },
  ): TerminalControlLease;
  consumeRelayV2ExactObservation(
    claim: TerminalControlRelayV2ExactTargetClaim,
    input: TerminalControlRelayV2ExactTargetInput,
    identity: TerminalControlRelayV2ExactTargetIdentity,
  ): Promise<TerminalControlRelayV2ExactObservationOpen>;
  tailRelayV2ExactObservation(
    observation: TerminalControlRelayV2ExactObservation,
    cursor: number,
    maxBytes?: number,
  ): Promise<TerminalControlRelayV2ExactObservationTail>;
  closeRelayV2ExactObservation(
    observation: TerminalControlRelayV2ExactObservation,
  ): Promise<void>;
  rollbackRelayV2ExactTarget(claim: TerminalControlRelayV2ExactTargetClaim): Promise<boolean>;
}

export interface TerminalControlAuthorityOptions {
  statePath?: string;
  backend?: TerminalControlBackend;
  now?: () => Date;
  /** Exact process identity is opt-in and does not alter terminal-control v1. */
  relayV2ProcessTarget?: Readonly<{ kind: "local" | "ssh"; targetId: string }>;
  /** Tests may shrink this owner-bound reservation TTL. */
  relayV2ExactTargetTtlMs?: number;
}

type RelayV2ExactClaimState = "prepared" | "admitted" | "consumed" | "revoked";

interface RelayV2ExactClaimRecord {
  readonly input: TerminalControlRelayV2ExactTargetInput;
  readonly inputJson: string;
  readonly preparationId: string;
  readonly identity: TerminalControlRelayV2ExactTargetIdentity;
  readonly lease: TerminalControlLease;
  readonly externalEpoch: number;
  state: RelayV2ExactClaimState;
  timer: NodeJS.Timeout | null;
}

interface RelayV2ExactObservationRecord {
  readonly controlTargetId: string;
  readonly controlEpoch: string;
  readonly targetIncarnationProof: string;
  readonly outputGeneration: string;
  readonly pane: string;
  state: "open" | "closed";
}

function isoNow(now: () => Date): string {
  return now().toISOString();
}

function revision(target: TerminalControlTargetRecord): void {
  target.revision = nextDecimal(target.revision);
}

function ownershipView(
  state: TerminalControlState,
  target: TerminalControlTargetRecord,
  outputCursor = 0,
): TerminalControlOwnershipView {
  const base: TerminalControlOwnershipView = {
    controlTargetId: target.controlTargetId,
    controlEpoch: state.controlEpoch,
    state: target.lifecycle === "ACTIVE" ? target.ownership.state : target.lifecycle,
    fence: target.ownership.fence,
    outputGeneration: target.outputGeneration,
    outputCursor,
    revision: target.revision,
  };
  if (target.ownership.state !== "FREE") {
    base.ownerKind = target.ownership.owner.kind;
    base.leaseExpiresAt = target.ownership.leaseExpiresAt;
  } else if (target.recovery?.previousOwnerKind) {
    base.ownerKind = target.recovery.previousOwnerKind;
  }
  if (target.ownership.state === "DRAINING") {
    base.nextOwnerKind = target.ownership.handoff.nextOwner.kind;
    base.handoffId = target.ownership.handoff.handoffId;
  }
  return base;
}

function targetById(state: TerminalControlState, controlTargetId: string): TerminalControlTargetRecord {
  const target = state.targets.find((candidate) => candidate.controlTargetId === controlTargetId);
  if (!target) {
    throw new TerminalControlProtocolError("TARGET_NOT_FOUND", "control target is unknown");
  }
  return target;
}

function ensureOperable(target: TerminalControlTargetRecord): void {
  if (target.lifecycle === "TARGET_GONE") {
    throw new TerminalControlProtocolError("TARGET_GONE", "control target backend lifecycle has ended");
  }
  if (target.lifecycle === "RECOVERY_REQUIRED" || target.inFlight) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "terminal-control continuity is uncertain; explicit local recovery is required",
    );
  }
}

function expiresAt(now: () => Date, ttlMs = TERMINAL_CONTROL_DEFAULT_LEASE_TTL_MS): string {
  return new Date(now().getTime() + ttlMs).toISOString();
}

function leaseExpired(target: TerminalControlTargetRecord, now: () => Date): boolean {
  if (target.ownership.state === "FREE") return false;
  return Date.parse(target.ownership.leaseExpiresAt) <= now().getTime();
}

function isAbandonableNonFeishuLease(target: TerminalControlTargetRecord): boolean {
  return target.lifecycle === "ACTIVE"
    && target.ownership.state === "HELD"
    && target.ownership.owner.kind !== "feishu"
    && target.inFlight === undefined;
}

function isAutoRecoverableNonFeishuState(target: TerminalControlTargetRecord): boolean {
  if (target.lifecycle !== "RECOVERY_REQUIRED" || target.inFlight || !target.recovery) return false;
  if (target.recovery.previousOwnerKind === "feishu" || target.recovery.operationId) return false;
  return !["OPERATION_IN_DOUBT", "DRAIN_UNCERTAIN"].includes(target.recovery.reason);
}

function appendOperation(
  target: TerminalControlTargetRecord,
  operation: TerminalControlOperationRecord,
): void {
  target.completedOperations.push(operation);
  if (target.completedOperations.length <= MAX_COMPLETED_OPERATIONS) return;
  const removable = target.completedOperations.findIndex((candidate) => candidate.disposition === "committed");
  if (removable >= 0) target.completedOperations.splice(removable, 1);
}

function completeInFlightAsInDoubt(
  target: TerminalControlTargetRecord,
  now: () => Date,
): string | undefined {
  const operation = target.inFlight;
  if (!operation) return undefined;
  appendOperation(target, {
    operationId: operation.operationId,
    ownerInstanceId: operation.ownerInstanceId,
    fence: operation.fence,
    payloadHash: operation.payloadHash,
    kind: operation.kind,
    disposition: "in-doubt",
    ...(operation.outputGeneration === undefined ? {} : { outputGeneration: operation.outputGeneration }),
    ...(operation.outputCursor === undefined ? {} : { outputCursor: operation.outputCursor }),
    completedAt: isoNow(now),
  });
  target.inFlight = undefined;
  return operation.operationId;
}

function markRecovery(
  state: TerminalControlState,
  target: TerminalControlTargetRecord,
  reason: TerminalControlRecoveryReason,
  now: () => Date,
  options: { previousControlEpoch?: string; operationId?: string } = {},
): void {
  const previousOwnerKind = target.ownership.state === "FREE"
    ? target.recovery?.previousOwnerKind
    : target.ownership.owner.kind;
  const inFlightOperationId = completeInFlightAsInDoubt(target, now);
  const operationId = options.operationId ?? inFlightOperationId;
  target.lifecycle = "RECOVERY_REQUIRED";
  target.ownership = {
    state: "FREE",
    fence: nextDecimal(target.ownership.fence),
  };
  target.recovery = {
    reason,
    since: isoNow(now),
    previousControlEpoch: options.previousControlEpoch ?? state.controlEpoch,
    ...(previousOwnerKind === undefined ? {} : { previousOwnerKind }),
    ...(operationId === undefined ? {} : { operationId }),
  };
  revision(target);
  target.updatedAt = isoNow(now);
}

function invalidateTarget(target: TerminalControlTargetRecord, now: () => Date): void {
  target.lifecycle = "TARGET_GONE";
  target.ownership = {
    state: "FREE",
    fence: nextDecimal(target.ownership.fence),
  };
  target.inFlight = undefined;
  target.recovery = undefined;
  revision(target);
  target.updatedAt = isoNow(now);
}

function validateLease(
  state: TerminalControlState,
  target: TerminalControlTargetRecord,
  lease: TerminalControlLease,
  options: { allowDraining?: boolean } = {},
): void {
  ensureOperable(target);
  if (lease.controlTargetId !== target.controlTargetId || lease.controlEpoch !== state.controlEpoch) {
    throw new TerminalControlProtocolError("PERMISSION_DENIED", "terminal input lease is fenced");
  }
  if (target.ownership.state === "FREE") {
    throw new TerminalControlProtocolError("PERMISSION_DENIED", "target has no current input owner");
  }
  if (target.ownership.state === "DRAINING" && !options.allowDraining) {
    throw new TerminalControlProtocolError("HANDOFF_PENDING", "target is draining for ownership handoff");
  }
  if (
    target.ownership.leaseId !== lease.leaseId
    || target.ownership.fence !== lease.fence
    || !sameInputOwnerClass(target.ownership.owner, lease.owner)
  ) {
    throw new TerminalControlProtocolError("PERMISSION_DENIED", "terminal input lease is fenced");
  }
}

function isInteractiveOwner(owner: TerminalControlOwner): boolean {
  return owner.kind !== "feishu";
}

function sameInputOwnerClass(left: TerminalControlOwner, right: TerminalControlOwner): boolean {
  if (isInteractiveOwner(left) && isInteractiveOwner(right)) return true;
  return sameOwner(left, right);
}

function leaseForOwner(
  state: TerminalControlState,
  target: TerminalControlTargetRecord,
  owner: TerminalControlOwner,
): TerminalControlLease {
  const lease = leaseFromTarget(state, target);
  if (!sameInputOwnerClass(lease.owner, owner)) {
    throw new TerminalControlProtocolError("PERMISSION_DENIED", "terminal input lease is fenced");
  }
  return sameOwner(lease.owner, owner) ? lease : { ...lease, owner };
}

function payloadHash(kind: string, pane: string, payload: Buffer | string): string {
  return createHash("sha256")
    .update("tmux-worktree/terminal-control/operation/v1\0", "utf8")
    .update(kind, "utf8")
    .update("\0", "utf8")
    .update(pane, "utf8")
    .update("\0", "utf8")
    .update(payload)
    .digest("hex");
}

function existingOperation(
  target: TerminalControlTargetRecord,
  operationId: string,
  ownerInstanceId: string,
  fence: string,
  hash: string,
  kind: TerminalControlOperationRecord["kind"],
): TerminalControlOperationRecord | undefined {
  const existing = target.completedOperations.find((operation) => operation.operationId === operationId);
  if (!existing) return undefined;
  if (
    existing.ownerInstanceId !== ownerInstanceId
    || existing.fence !== fence
    || existing.payloadHash !== hash
    || existing.kind !== kind
  ) {
    throw new TerminalControlProtocolError(
      "INVALID_REQUEST",
      "operationId was reused with different ownership or payload",
    );
  }
  if (existing.disposition === "in-doubt") {
    throw new TerminalControlProtocolError(
      "OPERATION_IN_DOUBT",
      "operation was accepted previously but its backend disposition is uncertain",
    );
  }
  return existing;
}

function operationResult(
  state: TerminalControlState,
  target: TerminalControlTargetRecord,
  operation: TerminalControlOperationRecord,
  deduplicated: boolean,
): Record<string, unknown> {
  return {
    operationId: operation.operationId,
    accepted: true,
    deduplicated,
    controlEpoch: state.controlEpoch,
    fence: operation.fence,
    ...(operation.outputGeneration === undefined ? {} : { outputGeneration: operation.outputGeneration }),
    ...(operation.outputCursor === undefined ? {} : { outputCursor: operation.outputCursor }),
  };
}

function relayV2ExactBoundedId(value: unknown, maxBytes = 128): string {
  if (typeof value !== "string"
    || value.length === 0
    || value.trim() !== value
    || /[\0\r\n]/.test(value)
    || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new TerminalControlProtocolError("INVALID_REQUEST", "Relay v2 exact target identity is invalid");
  }
  return value;
}

function relayV2ExactCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(relayV2ExactCanonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${relayV2ExactCanonicalJson(record[key])}`
  )).join(",")}}`;
}

function relayV2ExactInput(value: TerminalControlRelayV2ExactTargetInput): TerminalControlRelayV2ExactTargetInput {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.pane)
    || value.pane < 0
    || value.pane > 65_535
    || !value.processTarget
    || (value.processTarget.kind !== "local" && value.processTarget.kind !== "ssh")
    || !value.managedTarget
    || (value.managedTarget.kind !== "worktree" && value.managedTarget.kind !== "terminal")
    || !/^twinc2\.[A-Za-z0-9_-]{43}$/.test(value.managedTarget.incarnation)
    || !value.owner
    || value.owner.kind !== "relay-v2") {
    throw new TerminalControlProtocolError("INVALID_REQUEST", "Relay v2 exact target input is malformed");
  }
  return {
    schemaVersion: 1,
    hostId: relayV2ExactBoundedId(value.hostId),
    scopeId: relayV2ExactBoundedId(value.scopeId),
    sessionId: relayV2ExactBoundedId(value.sessionId),
    pane: value.pane,
    processTarget: {
      kind: value.processTarget.kind,
      targetId: relayV2ExactBoundedId(value.processTarget.targetId),
    },
    backendInstanceKey: relayV2ExactBoundedId(value.backendInstanceKey),
    managedTarget: {
      name: relayV2ExactBoundedId(value.managedTarget.name),
      kind: value.managedTarget.kind,
      incarnation: value.managedTarget.incarnation,
    },
    owner: {
      kind: "relay-v2",
      instanceId: relayV2ExactBoundedId(value.owner.instanceId, 256),
    },
  };
}

function ownerRelayV2ExactConsumer(
  value: TerminalControlOwner & { kind: "relay-v2" },
): TerminalControlOwner & { kind: "relay-v2" } {
  if (!value || typeof value !== "object" || value.kind !== "relay-v2") {
    throw new TerminalControlProtocolError(
      "INVALID_REQUEST",
      "Relay v2 exact target consumer owner is invalid",
    );
  }
  return {
    kind: "relay-v2",
    instanceId: relayV2ExactBoundedId(value.instanceId, 256),
  };
}

function relayV2ExactIdentity(
  value: TerminalControlRelayV2ExactTargetIdentity,
): TerminalControlRelayV2ExactTargetIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1) {
    throw new TerminalControlProtocolError("INVALID_REQUEST", "Relay v2 exact target identity is malformed");
  }
  return {
    schemaVersion: 1,
    controlTargetId: relayV2ExactBoundedId(value.controlTargetId),
    controlEpoch: relayV2ExactBoundedId(value.controlEpoch),
    targetIncarnationProof: relayV2ExactBoundedId(value.targetIncarnationProof),
  };
}

function relayV2TargetIncarnationProof(input: {
  request: TerminalControlRelayV2ExactTargetInput;
  state: TerminalControlState;
  target: TerminalControlTargetRecord;
  paneIdentity: string;
}): string {
  const digest = createHash("sha256").update(relayV2ExactCanonicalJson({
    domain: "tmux-worktree.terminal-control.relay-v2-exact-target.v1",
    request: input.request,
    controlEpoch: input.state.controlEpoch,
    controlTargetId: input.target.controlTargetId,
    targetRevision: input.target.revision,
    targetCreatedAt: input.target.managedSession.createdAt,
    tmuxInstanceId: input.target.backend.tmuxInstanceId,
    outputGeneration: input.target.outputGeneration,
    paneIdentity: input.paneIdentity,
  }), "utf8").digest("base64url");
  return `twct2.${digest}`;
}

export class TerminalControlAuthority implements TerminalControlRelayV2ExactTargetAuthorityPort {
  private readonly statePath: string;
  private readonly backend: TerminalControlBackend;
  private readonly now: () => Date;
  private readonly interactiveOwners = new Map<string, Map<string, TerminalControlOwner>>();
  private readonly relayV2ProcessTarget: Readonly<{ kind: "local" | "ssh"; targetId: string }> | null;
  private readonly relayV2ExactTargetTtlMs: number;
  private readonly relayV2ExactClaims = new WeakMap<object, RelayV2ExactClaimRecord>();
  private readonly relayV2ExactLiveClaims = new Set<TerminalControlRelayV2ExactTargetClaim>();
  private readonly relayV2ExactObservations = new WeakMap<object, RelayV2ExactObservationRecord>();
  private readonly relayV2ExactLiveObservations = new Set<TerminalControlRelayV2ExactObservation>();
  private readonly relayV2ExactObserversByTarget = new Map<string, Set<TerminalControlRelayV2ExactObservation>>();
  private relayV2ExternalEpoch = 0;
  private relayV2ExternalOperations = 0;
  private relayV2ExactClosed = false;

  constructor(options: TerminalControlAuthorityOptions = {}) {
    this.statePath = options.statePath ?? terminalControlStatePath();
    this.backend = options.backend ?? new TmuxTerminalControlBackend();
    this.now = options.now ?? (() => new Date());
    if (options.relayV2ProcessTarget !== undefined
      && (options.relayV2ProcessTarget === null
        || (options.relayV2ProcessTarget.kind !== "local"
          && options.relayV2ProcessTarget.kind !== "ssh"))) {
      throw new TypeError("Relay v2 terminal-control process target is invalid");
    }
    this.relayV2ProcessTarget = options.relayV2ProcessTarget === undefined
      ? null
      : Object.freeze({
          kind: options.relayV2ProcessTarget.kind,
          targetId: relayV2ExactBoundedId(options.relayV2ProcessTarget.targetId),
        });
    const ttl = options.relayV2ExactTargetTtlMs ?? 30_000;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > TERMINAL_CONTROL_MAX_LEASE_TTL_MS) {
      throw new TypeError("Relay v2 exact target reservation TTL is invalid");
    }
    this.relayV2ExactTargetTtlMs = ttl;
  }

  private interactiveOwnerKey(owner: TerminalControlOwner): string {
    return `${owner.kind}\0${owner.instanceId}`;
  }

  private registerInteractiveOwner(controlTargetId: string, owner: TerminalControlOwner): void {
    if (!isInteractiveOwner(owner)) return;
    let owners = this.interactiveOwners.get(controlTargetId);
    if (!owners) {
      owners = new Map();
      this.interactiveOwners.set(controlTargetId, owners);
    }
    owners.set(this.interactiveOwnerKey(owner), owner);
  }

  private unregisterInteractiveOwner(
    controlTargetId: string,
    owner: TerminalControlOwner,
  ): { registered: boolean; remaining?: TerminalControlOwner } {
    const owners = this.interactiveOwners.get(controlTargetId);
    if (!owners || !owners.delete(this.interactiveOwnerKey(owner))) return { registered: false };
    const remaining = owners.values().next().value as TerminalControlOwner | undefined;
    if (!remaining) this.interactiveOwners.delete(controlTargetId);
    return { registered: true, remaining };
  }

  private resetInteractiveOwners(controlTargetId: string): void {
    this.interactiveOwners.delete(controlTargetId);
  }

  private relayV2ExactClaimRecord(
    claim: TerminalControlRelayV2ExactTargetClaim,
  ): RelayV2ExactClaimRecord {
    const record = this.relayV2ExactClaims.get(claim as object);
    if (!record) {
      throw new TerminalControlProtocolError(
        "PERMISSION_DENIED",
        "Relay v2 exact target claim is not owned by this authority",
      );
    }
    return record;
  }

  private relayV2ExactClaimCurrent(record: RelayV2ExactClaimRecord): boolean {
    return !this.relayV2ExactClosed
      && this.relayV2ExternalOperations === 0
      && this.relayV2ExternalEpoch === record.externalEpoch
      && Date.parse(record.lease.expiresAt) > this.now().getTime();
  }

  private async relayV2RollbackRecord(record: RelayV2ExactClaimRecord): Promise<boolean> {
    if (record.timer) clearTimeout(record.timer);
    record.timer = null;
    record.state = "revoked";
    return this.locked(async (state) => {
      const target = state.targets.find(
        (candidate) => candidate.controlTargetId === record.lease.controlTargetId,
      );
      if (!target
        || state.controlEpoch !== record.lease.controlEpoch
        || target.ownership.state === "FREE"
        || target.ownership.state === "DRAINING"
        || target.ownership.leaseId !== record.lease.leaseId
        || target.ownership.fence !== record.lease.fence
        || !sameOwner(target.ownership.owner, record.lease.owner)) {
        return false;
      }
      this.resetInteractiveOwners(target.controlTargetId);
      target.ownership = {
        state: "FREE",
        fence: nextDecimal(target.ownership.fence),
      };
      revision(target);
      target.updatedAt = isoNow(this.now);
      saveTerminalControlState(state, this.statePath);
      return true;
    });
  }

  private async relayV2WithdrawAllExactClaims(): Promise<void> {
    const records: RelayV2ExactClaimRecord[] = [];
    for (const claim of this.relayV2ExactLiveClaims) {
      const record = this.relayV2ExactClaims.get(claim as object);
      this.relayV2ExactLiveClaims.delete(claim);
      this.relayV2ExactClaims.delete(claim as object);
      if (record && record.state !== "consumed" && record.state !== "revoked") {
        record.state = "revoked";
        records.push(record);
      }
    }
    const settled = await Promise.allSettled(records.map((record) => (
      this.relayV2RollbackRecord(record)
    )));
    const failed = settled.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  private async relayV2ExternalOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.relayV2ExternalOperations += 1;
    this.relayV2ExternalEpoch += 1;
    try {
      await this.relayV2WithdrawAllExactClaims();
      return await operation();
    } finally {
      this.relayV2ExternalOperations -= 1;
      this.relayV2ExternalEpoch += 1;
    }
  }

  /**
   * Atomically reserves an already-existing exact terminal target. This never
   * invokes v1 target.resolve, creates a target, prepares output, or attaches
   * observation. The returned object is useful only to this live authority.
   */
  async prepareRelayV2ExactTarget(
    rawInput: TerminalControlRelayV2ExactTargetInput,
  ): Promise<TerminalControlRelayV2ExactTargetPreparation> {
    return this.prepareRelayV2ExactTargetForProcess(rawInput, this.relayV2ProcessTarget);
  }

  /**
   * Issues a process-local view for one remote compound connection. The view
   * owns no state: every operation remains on this authority and its exact
   * claim registry. It exists only because a long-lived daemon cannot bake a
   * caller-specific configured SSH target into its constructor.
   */
  captureRelayV2ExactProcessTarget(
    rawTarget: Readonly<{ kind: "local" | "ssh"; targetId: string }>,
  ): TerminalControlRelayV2ExactTargetAuthorityPort {
    if (!rawTarget
      || (rawTarget.kind !== "local" && rawTarget.kind !== "ssh")) {
      throw new TerminalControlProtocolError(
        "INVALID_REQUEST",
        "Relay v2 exact process target is invalid",
      );
    }
    const target = Object.freeze({
      kind: rawTarget.kind,
      targetId: relayV2ExactBoundedId(rawTarget.targetId),
    });
    const view = Object.create(null) as TerminalControlRelayV2ExactTargetAuthorityPort;
    Object.defineProperties(view, {
      prepareRelayV2ExactTarget: {
        value: (input: TerminalControlRelayV2ExactTargetInput) => (
          this.prepareRelayV2ExactTargetForProcess(input, target)
        ),
        enumerable: true,
      },
      fenceRelayV2ExactTarget: {
        value: this.fenceRelayV2ExactTarget.bind(this),
        enumerable: true,
      },
      consumeRelayV2ExactTarget: {
        value: this.consumeRelayV2ExactTarget.bind(this),
        enumerable: true,
      },
      consumeRelayV2ExactObservation: {
        value: this.consumeRelayV2ExactObservation.bind(this),
        enumerable: true,
      },
      tailRelayV2ExactObservation: {
        value: this.tailRelayV2ExactObservation.bind(this),
        enumerable: true,
      },
      closeRelayV2ExactObservation: {
        value: this.closeRelayV2ExactObservation.bind(this),
        enumerable: true,
      },
      rollbackRelayV2ExactTarget: {
        value: this.rollbackRelayV2ExactTarget.bind(this),
        enumerable: true,
      },
    });
    return Object.freeze(view);
  }

  private async prepareRelayV2ExactTargetForProcess(
    rawInput: TerminalControlRelayV2ExactTargetInput,
    expectedProcessTarget: Readonly<{ kind: "local" | "ssh"; targetId: string }> | null,
  ): Promise<TerminalControlRelayV2ExactTargetPreparation> {
    const input = relayV2ExactInput(rawInput);
    if (this.relayV2ExactClosed
      || expectedProcessTarget === null
      || this.backend.inspectExactTarget === undefined) {
      throw new TerminalControlProtocolError(
        "PERMISSION_DENIED",
        "Relay v2 exact terminal target authority is unavailable",
      );
    }
    if (input.processTarget.kind !== expectedProcessTarget.kind
      || input.processTarget.targetId !== expectedProcessTarget.targetId) {
      throw new TerminalControlProtocolError(
        "PERMISSION_DENIED",
        "Relay v2 exact terminal target crossed process authority",
      );
    }
    if (this.relayV2ExternalOperations !== 0) {
      throw new TerminalControlProtocolError("RESOURCE_EXHAUSTED", "terminal-control is busy", true);
    }
    const externalEpoch = this.relayV2ExternalEpoch;
    const prepared = await this.locked(async (state) => {
      if (this.relayV2ExactClosed
        || this.relayV2ExternalOperations !== 0
        || this.relayV2ExternalEpoch !== externalEpoch) {
        throw new TerminalControlProtocolError("RESOURCE_EXHAUSTED", "terminal-control is busy", true);
      }
      const inspected = await this.backend.inspectExactTarget!({
        managedName: input.managedTarget.name,
        managedKind: input.managedTarget.kind,
        managedIncarnation: input.managedTarget.incarnation,
        pane: input.pane,
      });
      if (inspected.managedSession.name !== input.managedTarget.name
        || inspected.managedSession.kind !== input.managedTarget.kind
        || inspected.managedIncarnation !== input.managedTarget.incarnation) {
        throw new TerminalControlProtocolError(
          "TARGET_GONE",
          "managed target changed during Relay v2 exact preparation",
        );
      }
      const matches = state.targets.filter((candidate) => (
        candidate.lifecycle !== "TARGET_GONE"
        && candidate.managedSession.name === input.managedTarget.name
        && candidate.managedSession.kind === input.managedTarget.kind
        && candidate.managedSession.createdAt === inspected.managedSession.createdAt
        && candidate.backend.tmuxInstanceId === inspected.tmuxInstanceId
      ));
      if (matches.length !== 1) {
        throw new TerminalControlProtocolError(
          matches.length === 0 ? "TARGET_NOT_FOUND" : "RECOVERY_REQUIRED",
          "exact terminal-control target is missing or ambiguous",
        );
      }
      const target = matches[0];
      ensureOperable(target);
      if (target.ownership.state !== "FREE") {
        throw new TerminalControlProtocolError(
          "PERMISSION_DENIED",
          "exact terminal-control target already has an input owner",
        );
      }
      target.ownership = {
        state: "HELD",
        fence: nextDecimal(target.ownership.fence),
        owner: { ...input.owner },
        leaseId: randomUUID(),
        leaseExpiresAt: expiresAt(this.now, this.relayV2ExactTargetTtlMs),
      };
      this.resetInteractiveOwners(target.controlTargetId);
      this.registerInteractiveOwner(target.controlTargetId, input.owner);
      revision(target);
      target.updatedAt = isoNow(this.now);
      saveTerminalControlState(state, this.statePath);
      const identity: TerminalControlRelayV2ExactTargetIdentity = {
        schemaVersion: 1,
        controlTargetId: target.controlTargetId,
        controlEpoch: state.controlEpoch,
        targetIncarnationProof: relayV2TargetIncarnationProof({
          request: input,
          state,
          target,
          paneIdentity: inspected.paneIdentity,
        }),
      };
      return {
        identity,
        lease: leaseForOwner(state, target, input.owner),
      };
    });
    const claim = Object.freeze(Object.create(null)) as TerminalControlRelayV2ExactTargetClaim;
    const record: RelayV2ExactClaimRecord = {
      input,
      inputJson: relayV2ExactCanonicalJson(input),
      preparationId: randomUUID(),
      identity: Object.freeze({ ...prepared.identity }),
      lease: Object.freeze({ ...prepared.lease, owner: Object.freeze({ ...prepared.lease.owner }) }),
      externalEpoch,
      state: "prepared",
      timer: null,
    };
    this.relayV2ExactClaims.set(claim as object, record);
    this.relayV2ExactLiveClaims.add(claim);
    record.timer = setTimeout(() => {
      void this.rollbackRelayV2ExactTarget(claim).catch(() => undefined);
    }, this.relayV2ExactTargetTtlMs);
    record.timer.unref?.();
    if (!this.relayV2ExactClaimCurrent(record)) {
      await this.rollbackRelayV2ExactTarget(claim);
      throw new TerminalControlProtocolError(
        "PERMISSION_DENIED",
        "Relay v2 exact terminal target preparation was fenced",
      );
    }
    return Object.freeze({
      preparationId: record.preparationId,
      claim,
      identity: Object.freeze({ ...record.identity }),
      expiresAt: record.lease.expiresAt,
    });
  }

  fenceRelayV2ExactTarget(
    claim: TerminalControlRelayV2ExactTargetClaim,
    rawInput: TerminalControlRelayV2ExactTargetInput,
  ): void {
    const input = relayV2ExactInput(rawInput);
    const record = this.relayV2ExactClaimRecord(claim);
    if (record.state !== "prepared"
      || record.inputJson !== relayV2ExactCanonicalJson(input)
      || !this.relayV2ExactClaimCurrent(record)) {
      throw new TerminalControlProtocolError(
        "PERMISSION_DENIED",
        "Relay v2 exact terminal target claim is stale or mismatched",
      );
    }
    record.state = "admitted";
  }

  consumeRelayV2ExactTarget(
    claim: TerminalControlRelayV2ExactTargetClaim,
    rawInput: TerminalControlRelayV2ExactTargetInput,
    rawConsumerOwner: TerminalControlOwner & { kind: "relay-v2" } = rawInput.owner,
  ): TerminalControlLease {
    const input = relayV2ExactInput(rawInput);
    const consumerOwner = ownerRelayV2ExactConsumer(rawConsumerOwner);
    const record = this.relayV2ExactClaimRecord(claim);
    if (record.state !== "admitted"
      || record.inputJson !== relayV2ExactCanonicalJson(input)
      || !this.relayV2ExactClaimCurrent(record)) {
      throw new TerminalControlProtocolError(
        "PERMISSION_DENIED",
        "Relay v2 exact terminal target claim cannot be consumed",
      );
    }
    record.state = "consumed";
    if (record.timer) clearTimeout(record.timer);
    record.timer = null;
    this.resetInteractiveOwners(record.lease.controlTargetId);
    this.registerInteractiveOwner(record.lease.controlTargetId, consumerOwner);
    this.relayV2ExactLiveClaims.delete(claim);
    this.relayV2ExactClaims.delete(claim as object);
    return { ...record.lease, owner: { ...consumerOwner } };
  }

  private relayV2ExactObservationRecord(
    observation: TerminalControlRelayV2ExactObservation,
  ): RelayV2ExactObservationRecord {
    const record = this.relayV2ExactObservations.get(observation as object);
    if (!record) {
      throw new TerminalControlProtocolError(
        "PERMISSION_DENIED",
        "Relay v2 exact observation is not owned by this authority",
      );
    }
    return record;
  }

  private relayV2ExactObserverCount(controlTargetId: string): number {
    return this.relayV2ExactObserversByTarget.get(controlTargetId)?.size ?? 0;
  }

  private relayV2ExactRetireObservation(observation: TerminalControlRelayV2ExactObservation): void {
    const record = this.relayV2ExactObservations.get(observation as object);
    if (record) record.state = "closed";
    this.relayV2ExactLiveObservations.delete(observation);
    if (!record) return;
    const observers = this.relayV2ExactObserversByTarget.get(record.controlTargetId);
    if (!observers) return;
    observers.delete(observation);
    if (observers.size === 0) this.relayV2ExactObserversByTarget.delete(record.controlTargetId);
  }

  /**
   * Retires observers whose pinned epoch/generation or target lifecycle can
   * no longer match, so a stale observer never suppresses the deferred
   * output reset of a later release or close.
   */
  private relayV2ExactPruneStaleObservers(
    state: TerminalControlState,
    target: TerminalControlTargetRecord,
  ): void {
    const observers = this.relayV2ExactObserversByTarget.get(target.controlTargetId);
    if (!observers) return;
    for (const observation of [...observers]) {
      const record = this.relayV2ExactObservations.get(observation as object);
      if (!record
        || record.state === "closed"
        || target.lifecycle === "TARGET_GONE"
        || record.controlEpoch !== state.controlEpoch
        || record.outputGeneration !== target.outputGeneration) {
        this.relayV2ExactRetireObservation(observation);
      }
    }
  }

  /**
   * Atomically consumes an admitted claim into a read-only observation. The
   * claim is burned synchronously, so no other path can consume it while the
   * canonical lock is taken; inside that same lock the live backend is
   * re-inspected (a same-name recreation since prepare is TARGET_GONE), the
   * incarnation proof and target record are re-verified, the HELD
   * reservation returns to FREE without an output reset, the observer is
   * registered, and the controlEpoch/outputGeneration/outputCursor cut is
   * returned. The resulting handle never grants input ownership.
   */
  async consumeRelayV2ExactObservation(
    claim: TerminalControlRelayV2ExactTargetClaim,
    rawInput: TerminalControlRelayV2ExactTargetInput,
    rawIdentity: TerminalControlRelayV2ExactTargetIdentity,
  ): Promise<TerminalControlRelayV2ExactObservationOpen> {
    if (this.backend.inspectExactTarget === undefined) {
      throw new TerminalControlProtocolError(
        "PERMISSION_DENIED",
        "Relay v2 exact terminal target authority is unavailable",
      );
    }
    const inspectExactTarget = this.backend.inspectExactTarget;
    const input = relayV2ExactInput(rawInput);
    const identity = relayV2ExactIdentity(rawIdentity);
    const record = this.relayV2ExactClaimRecord(claim);
    if (record.state !== "admitted"
      || record.inputJson !== relayV2ExactCanonicalJson(input)
      || relayV2ExactCanonicalJson(identity) !== relayV2ExactCanonicalJson(record.identity)
      || !this.relayV2ExactClaimCurrent(record)) {
      throw new TerminalControlProtocolError(
        "PERMISSION_DENIED",
        "Relay v2 exact terminal target claim cannot be consumed for observation",
      );
    }
    record.state = "consumed";
    if (record.timer) clearTimeout(record.timer);
    record.timer = null;
    this.relayV2ExactLiveClaims.delete(claim);
    this.relayV2ExactClaims.delete(claim as object);
    const observation = Object.freeze(
      Object.create(null),
    ) as TerminalControlRelayV2ExactObservation;
    const observed = await this.locked(async (state) => {
      const target = state.targets.find(
        (candidate) => candidate.controlTargetId === record.identity.controlTargetId,
      );
      const reservationMatches = target !== undefined
        && state.controlEpoch === record.identity.controlEpoch
        && target.ownership.state === "HELD"
        && target.ownership.leaseId === record.lease.leaseId
        && target.ownership.fence === record.lease.fence
        && sameOwner(target.ownership.owner, record.lease.owner);
      if (!target) {
        throw new TerminalControlProtocolError("TARGET_NOT_FOUND", "control target is unknown");
      }
      if (!reservationMatches) {
        throw new TerminalControlProtocolError(
          "PERMISSION_DENIED",
          "Relay v2 exact observation target record is fenced",
        );
      }
      if (this.relayV2ExactClosed
        || this.relayV2ExternalOperations !== 0
        || this.relayV2ExternalEpoch !== record.externalEpoch) {
        // The reservation is still ours; free it before fencing this consume.
        this.resetInteractiveOwners(target.controlTargetId);
        target.ownership = {
          state: "FREE",
          fence: nextDecimal(target.ownership.fence),
        };
        revision(target);
        target.updatedAt = isoNow(this.now);
        saveTerminalControlState(state, this.statePath);
        throw new TerminalControlProtocolError(
          "PERMISSION_DENIED",
          "Relay v2 exact terminal target claim cannot be consumed for observation",
        );
      }
      ensureOperable(target);
      let inspected;
      try {
        inspected = await inspectExactTarget.call(this.backend, {
          managedName: record.input.managedTarget.name,
          managedKind: record.input.managedTarget.kind,
          managedIncarnation: record.input.managedTarget.incarnation,
          pane: record.input.pane,
        });
      } catch (error) {
        if (
          error instanceof TerminalControlProtocolError
          && (error.code === "TARGET_GONE" || error.code === "TARGET_NOT_FOUND")
        ) {
          invalidateTarget(target, this.now);
          saveTerminalControlState(state, this.statePath);
          throw new TerminalControlProtocolError("TARGET_GONE", error.message);
        }
        markRecovery(state, target, "BACKEND_IDENTITY_UNCERTAIN", this.now);
        saveTerminalControlState(state, this.statePath);
        throw new TerminalControlProtocolError(
          "RECOVERY_REQUIRED",
          `could not prove the exact terminal backend lifecycle: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (inspected.managedSession.name !== record.input.managedTarget.name
        || inspected.managedSession.kind !== record.input.managedTarget.kind
        || inspected.managedSession.createdAt !== target.managedSession.createdAt
        || inspected.managedIncarnation !== record.input.managedTarget.incarnation
        || inspected.tmuxInstanceId !== target.backend.tmuxInstanceId) {
        invalidateTarget(target, this.now);
        saveTerminalControlState(state, this.statePath);
        throw new TerminalControlProtocolError(
          "TARGET_GONE",
          "managed target changed before Relay v2 exact observation",
        );
      }
      const proof = relayV2TargetIncarnationProof({
        request: record.input,
        state,
        target,
        paneIdentity: inspected.paneIdentity,
      });
      if (proof !== record.identity.targetIncarnationProof) {
        invalidateTarget(target, this.now);
        saveTerminalControlState(state, this.statePath);
        throw new TerminalControlProtocolError(
          "TARGET_GONE",
          "managed target changed before Relay v2 exact observation",
        );
      }
      this.resetInteractiveOwners(target.controlTargetId);
      target.ownership = {
        state: "FREE",
        fence: nextDecimal(target.ownership.fence),
      };
      revision(target);
      target.updatedAt = isoNow(this.now);
      const output = await this.prepareOutput(state, target);
      const observationRecord: RelayV2ExactObservationRecord = {
        controlTargetId: record.identity.controlTargetId,
        controlEpoch: record.identity.controlEpoch,
        targetIncarnationProof: record.identity.targetIncarnationProof,
        outputGeneration: target.outputGeneration,
        pane: String(record.input.pane),
        state: "open",
      };
      this.relayV2ExactObservations.set(observation as object, observationRecord);
      this.relayV2ExactLiveObservations.add(observation);
      let observers = this.relayV2ExactObserversByTarget.get(observationRecord.controlTargetId);
      if (!observers) {
        observers = new Set();
        this.relayV2ExactObserversByTarget.set(observationRecord.controlTargetId, observers);
      }
      observers.add(observation);
      saveTerminalControlState(state, this.statePath);
      return {
        outputGeneration: target.outputGeneration,
        outputCursor: output.cursor,
        controlEpoch: record.identity.controlEpoch,
        controlTargetId: record.identity.controlTargetId,
        targetIncarnationProof: record.identity.targetIncarnationProof,
      };
    });
    return Object.freeze({
      observation,
      binding: Object.freeze({
        schemaVersion: 1 as const,
        controlTargetId: observed.controlTargetId,
        controlEpoch: observed.controlEpoch,
        targetIncarnationProof: observed.targetIncarnationProof,
        outputGeneration: observed.outputGeneration,
        outputCursor: observed.outputCursor,
      }),
    });
  }

  /**
   * Tails the pinned output generation along the exact observation binding.
   * Cursor fencing follows the existing output.tail semantics: a rotated
   * generation or controller epoch rejects with STALE_OUTPUT_CURSOR, a gone
   * target rejects with TARGET_GONE.
   */
  async tailRelayV2ExactObservation(
    observation: TerminalControlRelayV2ExactObservation,
    cursor: number,
    maxBytes = TERMINAL_CONTROL_MAX_OUTPUT_TAIL_BYTES,
  ): Promise<TerminalControlRelayV2ExactObservationTail> {
    if (!Number.isSafeInteger(cursor) || cursor < 0
      || !Number.isSafeInteger(maxBytes)
      || maxBytes < 1
      || maxBytes > TERMINAL_CONTROL_MAX_OUTPUT_TAIL_BYTES) {
      throw new TerminalControlProtocolError(
        "INVALID_REQUEST",
        "Relay v2 exact observation tail bounds are invalid",
      );
    }
    const record = this.relayV2ExactObservationRecord(observation);
    if (record.state !== "open" || this.relayV2ExactClosed) {
      throw new TerminalControlProtocolError(
        "PERMISSION_DENIED",
        "Relay v2 exact observation is closed",
      );
    }
    return this.locked(async (state) => {
      if (record.state !== "open" || this.relayV2ExactClosed) {
        throw new TerminalControlProtocolError(
          "PERMISSION_DENIED",
          "Relay v2 exact observation is closed",
        );
      }
      const target = state.targets.find(
        (candidate) => candidate.controlTargetId === record.controlTargetId,
      );
      if (!target) {
        throw new TerminalControlProtocolError("TARGET_NOT_FOUND", "control target is unknown");
      }
      if (target.lifecycle === "TARGET_GONE") {
        this.relayV2ExactPruneStaleObservers(state, target);
        throw new TerminalControlProtocolError(
          "TARGET_GONE",
          "control target backend lifecycle has ended",
        );
      }
      this.relayV2ExactPruneStaleObservers(state, target);
      if (record.state !== "open") {
        throw new TerminalControlProtocolError(
          "STALE_OUTPUT_CURSOR",
          "terminal output cursor was fenced by an ownership or controller generation change",
        );
      }
      try {
        await this.assertTargetCurrent(state, target);
      } catch (error) {
        this.relayV2ExactPruneStaleObservers(state, target);
        throw error;
      }
      this.relayV2ExactPruneStaleObservers(state, target);
      if (record.state !== "open") {
        throw new TerminalControlProtocolError(
          "STALE_OUTPUT_CURSOR",
          "terminal output cursor was fenced by an ownership or controller generation change",
        );
      }
      let chunk;
      try {
        chunk = await this.backend.tailOutput(
          target.controlTargetId,
          target.managedSession.name,
          record.pane,
          record.outputGeneration,
          cursor,
          maxBytes,
        );
      } catch (error) {
        if (error instanceof TerminalControlProtocolError && error.code === "STALE_OUTPUT_CURSOR") {
          throw error;
        }
        markRecovery(state, target, "OUTPUT_CONTINUITY_UNCERTAIN", this.now);
        saveTerminalControlState(state, this.statePath);
        throw new TerminalControlProtocolError(
          "RECOVERY_REQUIRED",
          `terminal output continuity is uncertain: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return Object.freeze({
        controlEpoch: state.controlEpoch,
        outputGeneration: chunk.generation,
        cursor: chunk.cursor,
        dataBase64: chunk.dataBase64,
        nextCursor: chunk.nextCursor,
      });
    });
  }

  /**
   * Idempotently releases one exact observation. The deferred
   * output-generation reset and its persistence complete before the observer
   * is deregistered, so a failure keeps the observation open and retryable;
   * stale observations are fenced without owing a reset.
   */
  async closeRelayV2ExactObservation(
    observation: TerminalControlRelayV2ExactObservation,
  ): Promise<void> {
    const record = this.relayV2ExactObservations.get(observation as object);
    if (!record || record.state === "closed") return;
    if (!this.relayV2ExactClosed) {
      await this.locked(async (state) => {
        const target = state.targets.find(
          (candidate) => candidate.controlTargetId === record.controlTargetId,
        );
        if (!target) return;
        this.relayV2ExactPruneStaleObservers(state, target);
        if (record.state !== "open"
          || target.lifecycle !== "ACTIVE"
          || target.ownership.state !== "FREE"
          || target.inFlight
          || this.relayV2ExactObserverCount(record.controlTargetId) !== 1) {
          return;
        }
        await this.resetOutput(state, target);
        revision(target);
        target.updatedAt = isoNow(this.now);
        saveTerminalControlState(state, this.statePath);
      });
    }
    this.relayV2ExactRetireObservation(observation);
  }

  async rollbackRelayV2ExactTarget(
    claim: TerminalControlRelayV2ExactTargetClaim,
  ): Promise<boolean> {
    const record = this.relayV2ExactClaims.get(claim as object);
    if (!record || record.state === "consumed" || record.state === "revoked") return false;
    record.state = "revoked";
    this.relayV2ExactLiveClaims.delete(claim);
    this.relayV2ExactClaims.delete(claim as object);
    return this.relayV2RollbackRecord(record);
  }

  async closeRelayV2ExactTargetAuthority(): Promise<void> {
    if (this.relayV2ExactClosed) return;
    // Claim rollback precedes observation close so each deferred reset sees
    // the post-rollback FREE state; any failure keeps this authority open
    // and the whole close retryable.
    await this.relayV2WithdrawAllExactClaims();
    for (const observation of [...this.relayV2ExactLiveObservations]) {
      await this.closeRelayV2ExactObservation(observation);
    }
    this.relayV2ExactClosed = true;
    this.relayV2ExternalEpoch += 1;
  }

  async initializeContinuity(): Promise<string> {
    return this.relayV2ExternalOperation(() => this.locked(async (state) => {
      const previousControlEpoch = state.controlEpoch;
      state.controlEpoch = randomUUID();
      for (const target of state.targets) {
        if (target.lifecycle === "TARGET_GONE") continue;
        // Never erase a persisted uncertainty record on another restart. In
        // particular, its operationId is what prevents an in-doubt write from
        // later being mistaken for an idle, safely abandonable local lease.
        if (target.lifecycle === "RECOVERY_REQUIRED") continue;
        if (target.inFlight) {
          markRecovery(state, target, "OPERATION_IN_DOUBT", this.now, {
            previousControlEpoch,
          });
        } else if (target.ownership.state === "DRAINING") {
          markRecovery(state, target, "DRAIN_UNCERTAIN", this.now, {
            previousControlEpoch,
          });
        } else if (target.ownership.state === "HELD") {
          markRecovery(state, target, "CONTROLLER_RESTARTED", this.now, {
            previousControlEpoch,
          });
        }
      }
      saveTerminalControlState(state, this.statePath);
      return state.controlEpoch;
    }));
  }

  private async locked<T>(operation: (state: TerminalControlState) => Promise<T>): Promise<T> {
    const lock = await acquireTerminalControlStoreLock(`${this.statePath}.lock`);
    try {
      const state = loadTerminalControlState(this.statePath);
      return await operation(state);
    } finally {
      releaseTerminalControlStoreLock(lock);
    }
  }

  private async reconcileAbandonedOwnership(
    state: TerminalControlState,
    target: TerminalControlTargetRecord,
  ): Promise<boolean> {
    if (target.lifecycle === "ACTIVE" && leaseExpired(target, this.now)) {
      const abandonable = isAbandonableNonFeishuLease(target);
      markRecovery(
        state,
        target,
        target.ownership.state === "DRAINING" ? "DRAIN_UNCERTAIN" : "LEASE_EXPIRED",
        this.now,
      );
      saveTerminalControlState(state, this.statePath);
      if (!abandonable) return false;
    }
    if (!isAutoRecoverableNonFeishuState(target)) return false;

    try {
      await this.backend.assertCurrent(target.managedSession, target.backend.tmuxInstanceId);
    } catch (error) {
      if (
        error instanceof TerminalControlProtocolError
        && (error.code === "TARGET_GONE" || error.code === "TARGET_NOT_FOUND")
      ) {
        invalidateTarget(target, this.now);
        saveTerminalControlState(state, this.statePath);
        throw new TerminalControlProtocolError("TARGET_GONE", error.message);
      }
      markRecovery(state, target, "BACKEND_IDENTITY_UNCERTAIN", this.now);
      saveTerminalControlState(state, this.statePath);
      return false;
    }

    try {
      const output = await this.backend.resetOutput(
        target.controlTargetId,
        target.managedSession.name,
        "0",
        target.outputGeneration,
      );
      target.outputGeneration = output.generation;
    } catch {
      markRecovery(state, target, "OUTPUT_CONTINUITY_UNCERTAIN", this.now);
      saveTerminalControlState(state, this.statePath);
      return false;
    }
    target.lifecycle = "ACTIVE";
    target.recovery = undefined;
    target.ownership = {
      state: "FREE",
      // markRecovery already advanced this fence before recovery was entered.
      fence: target.ownership.fence,
    };
    this.resetInteractiveOwners(target.controlTargetId);
    revision(target);
    target.updatedAt = isoNow(this.now);
    saveTerminalControlState(state, this.statePath);
    return true;
  }

  private async assertTargetCurrent(
    state: TerminalControlState,
    target: TerminalControlTargetRecord,
  ): Promise<void> {
    await this.reconcileAbandonedOwnership(state, target);
    ensureOperable(target);
    try {
      await this.backend.assertCurrent(target.managedSession, target.backend.tmuxInstanceId);
    } catch (error) {
      if (
        error instanceof TerminalControlProtocolError
        && (error.code === "TARGET_GONE" || error.code === "TARGET_NOT_FOUND")
      ) {
        invalidateTarget(target, this.now);
        saveTerminalControlState(state, this.statePath);
        throw new TerminalControlProtocolError("TARGET_GONE", error.message);
      }
      markRecovery(state, target, "BACKEND_IDENTITY_UNCERTAIN", this.now);
      saveTerminalControlState(state, this.statePath);
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        `could not prove the exact terminal backend lifecycle: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async prepareOutput(
    state: TerminalControlState,
    target: TerminalControlTargetRecord,
  ): Promise<{ generation: string; cursor: number }> {
    try {
      const output = await this.backend.prepareOutput(
        target.controlTargetId,
        target.managedSession.name,
        "0",
        target.outputGeneration,
      );
      target.outputGeneration = output.generation;
      return output;
    } catch (error) {
      // Dashboard/Relay/local producers do not own a Feishu output turn. If
      // their otherwise idle capture disappeared, rotate the observation
      // generation and rebuild pane_pipe before treating the terminal as
      // unavailable. Feishu and every draining/in-flight state remain strict.
      if (
        target.lifecycle === "ACTIVE"
        && target.ownership.state === "HELD"
        && target.ownership.owner.kind !== "feishu"
        && !target.inFlight
      ) {
        try {
          await this.backend.assertCurrent(target.managedSession, target.backend.tmuxInstanceId);
          const repaired = await this.backend.resetOutput(
            target.controlTargetId,
            target.managedSession.name,
            "0",
            target.outputGeneration,
          );
          target.outputGeneration = repaired.generation;
          revision(target);
          target.updatedAt = isoNow(this.now);
          saveTerminalControlState(state, this.statePath);
          return repaired;
        } catch {
          // The normal recovery path below persists and fences this failure.
        }
      }
      markRecovery(state, target, "OUTPUT_CONTINUITY_UNCERTAIN", this.now);
      saveTerminalControlState(state, this.statePath);
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        `terminal output continuity is uncertain: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async resetOutput(
    state: TerminalControlState,
    target: TerminalControlTargetRecord,
  ): Promise<{ generation: string; cursor: number }> {
    try {
      const output = await this.backend.resetOutput(
        target.controlTargetId,
        target.managedSession.name,
        "0",
        target.outputGeneration,
      );
      target.outputGeneration = output.generation;
      return output;
    } catch (error) {
      markRecovery(state, target, "OUTPUT_CONTINUITY_UNCERTAIN", this.now);
      saveTerminalControlState(state, this.statePath);
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        `terminal output continuity is uncertain: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async handle(request: TerminalControlRequest): Promise<unknown> {
    return this.relayV2ExternalOperation(() => this.handleV1(request));
  }

  private async handleV1(request: TerminalControlRequest): Promise<unknown> {
    if (request.type === "ping") {
      return { protocolVersion: 1, authority: "local-terminal-control" };
    }
    if (request.type === "target.resolve") return this.resolveTarget(request.sessionName);
    if (request.type === "ownership.status") return this.status(request.controlTargetId);
    if (request.type === "lease.acquire") return this.acquire(request.controlTargetId, request.owner, request.ttlMs);
    if (request.type === "lease.renew") return this.renew(request.lease, request.ttlMs);
    if (request.type === "lease.release") return this.release(request.lease);
    if (request.type === "handoff.begin") {
      return this.beginHandoff(request.controlTargetId, request.nextOwner, request.currentLease);
    }
    if (request.type === "handoff.commit") {
      return this.commitHandoff(
        request.handoffId,
        request.currentLease,
        request.drain,
        request.ttlMs,
      );
    }
    if (request.type === "handoff.cancel") {
      return this.cancelHandoff(request.handoffId, request.currentLease);
    }
    if (request.type === "handoff.withdraw") {
      return this.withdrawHandoff(
        request.controlTargetId,
        request.handoffId,
        request.nextOwner,
      );
    }
    if (request.type === "handoff.force") {
      return this.forceHandoff(
        request.controlTargetId,
        request.expectedControlEpoch,
        request.nextOwner,
        request.proof,
        request.acknowledgeUncertainOperation,
        request.ttlMs,
      );
    }
    if (request.type === "input.raw") {
      return this.executeInput(
        request.lease,
        request.operationId,
        request.pane,
        "raw",
        Buffer.from(request.dataBase64, "base64"),
      );
    }
    if (request.type === "input.agent-message") {
      const normalized = request.message.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      return this.executeInput(
        request.lease,
        request.operationId,
        request.pane,
        "agent-message",
        `${normalized}\0${request.submit ? "1" : "0"}`,
      );
    }
    if (request.type === "input.scroll") {
      return this.executeInput(
        request.lease,
        request.operationId,
        request.pane,
        "scroll",
        `${request.direction}:${request.lines}`,
      );
    }
    if (request.type === "lifecycle.kill") {
      return this.executeLifecycleKill(request.lease, request.operationId);
    }
    if (request.type === "output.tail") {
      return this.tailOutput(
        request.controlTargetId,
        request.controlEpoch,
        request.outputGeneration,
        request.cursor,
        request.maxBytes,
      );
    }
    return this.executeInput(
      request.lease,
      request.operationId,
      request.pane,
      "resize",
      `${request.cols}x${request.rows}`,
    );
  }

  private async resolveTarget(sessionName: string): Promise<unknown> {
    return this.locked(async (state) => {
      const resolved = await this.backend.resolveManagedSession(sessionName);
      let changed = false;
      for (const existing of state.targets) {
        if (
          existing.lifecycle !== "TARGET_GONE"
          && existing.managedSession.name === resolved.managedSession.name
          && (
            existing.managedSession.kind !== resolved.managedSession.kind
            || existing.managedSession.createdAt !== resolved.managedSession.createdAt
            || existing.backend.tmuxInstanceId !== resolved.tmuxInstanceId
          )
        ) {
          invalidateTarget(existing, this.now);
          changed = true;
        }
      }
      let target = state.targets.find((candidate) =>
        candidate.lifecycle !== "TARGET_GONE"
        && candidate.managedSession.name === resolved.managedSession.name
        && candidate.managedSession.kind === resolved.managedSession.kind
        && candidate.managedSession.createdAt === resolved.managedSession.createdAt
        && candidate.backend.tmuxInstanceId === resolved.tmuxInstanceId
      );
      if (!target) {
        target = {
          controlTargetId: randomUUID(),
          lifecycle: "ACTIVE",
          managedSession: {
            name: resolved.managedSession.name,
            kind: resolved.managedSession.kind,
            createdAt: resolved.managedSession.createdAt,
          },
          backend: { kind: "tmux", tmuxInstanceId: resolved.tmuxInstanceId },
          outputGeneration: randomUUID(),
          ownership: { state: "FREE", fence: "0" },
          revision: "1",
          completedOperations: [],
          updatedAt: isoNow(this.now),
        };
        state.targets.push(target);
        changed = true;
      }
      if (target.inFlight && target.lifecycle === "ACTIVE") {
        markRecovery(state, target, "OPERATION_IN_DOUBT", this.now);
        changed = true;
      }
      await this.reconcileAbandonedOwnership(state, target);
      const output = target.lifecycle === "ACTIVE"
        ? await this.prepareOutput(state, target)
        : { generation: target.outputGeneration, cursor: 0 };
      if (changed) saveTerminalControlState(state, this.statePath);
      return {
        controlTargetId: target.controlTargetId,
        controlEpoch: state.controlEpoch,
        managedSession: target.managedSession,
        ownership: ownershipView(state, target, output.cursor),
      };
    });
  }

  private async status(controlTargetId: string): Promise<TerminalControlOwnershipView> {
    return this.locked(async (state) => {
      const target = targetById(state, controlTargetId);
      let changed = false;
      if (target.inFlight && target.lifecycle === "ACTIVE") {
        markRecovery(state, target, "OPERATION_IN_DOUBT", this.now);
        changed = true;
      }
      await this.reconcileAbandonedOwnership(state, target);
      if (target.lifecycle === "ACTIVE") {
        await this.assertTargetCurrent(state, target);
      }
      const output = target.lifecycle === "ACTIVE"
        ? await this.prepareOutput(state, target)
        : { generation: target.outputGeneration, cursor: 0 };
      if (changed) saveTerminalControlState(state, this.statePath);
      return ownershipView(state, target, output.cursor);
    });
  }

  private async acquire(
    controlTargetId: string,
    owner: TerminalControlOwner,
    ttlMs = TERMINAL_CONTROL_DEFAULT_LEASE_TTL_MS,
  ): Promise<unknown> {
    return this.locked(async (state) => {
      const target = targetById(state, controlTargetId);
      await this.assertTargetCurrent(state, target);
      if (target.ownership.state === "FREE") {
        const output = await this.prepareOutput(state, target);
        target.ownership = {
          state: "HELD",
          fence: nextDecimal(target.ownership.fence),
          owner,
          leaseId: randomUUID(),
          leaseExpiresAt: expiresAt(this.now, ttlMs),
        };
        this.resetInteractiveOwners(target.controlTargetId);
        this.registerInteractiveOwner(target.controlTargetId, owner);
        revision(target);
        target.updatedAt = isoNow(this.now);
        saveTerminalControlState(state, this.statePath);
        return { lease: leaseForOwner(state, target, owner), ownership: ownershipView(state, target, output.cursor) };
      }
      if (target.ownership.state === "HELD" && sameInputOwnerClass(target.ownership.owner, owner)) {
        const output = await this.prepareOutput(state, target);
        if (isInteractiveOwner(owner)) {
          this.registerInteractiveOwner(target.controlTargetId, owner);
          target.ownership.leaseExpiresAt = expiresAt(this.now, ttlMs);
          revision(target);
          target.updatedAt = isoNow(this.now);
          saveTerminalControlState(state, this.statePath);
        }
        return { lease: leaseForOwner(state, target, owner), ownership: ownershipView(state, target, output.cursor) };
      }
      if (
        target.ownership.state === "HELD"
        && isInteractiveOwner(target.ownership.owner)
        && owner.kind === "feishu"
      ) {
        const output = await this.resetOutput(state, target);
        this.resetInteractiveOwners(target.controlTargetId);
        target.ownership = {
          state: "HELD",
          fence: nextDecimal(target.ownership.fence),
          owner,
          leaseId: randomUUID(),
          leaseExpiresAt: expiresAt(this.now, ttlMs),
        };
        revision(target);
        target.updatedAt = isoNow(this.now);
        saveTerminalControlState(state, this.statePath);
        return { lease: leaseForOwner(state, target, owner), ownership: ownershipView(state, target, output.cursor) };
      }
      if (target.ownership.state === "DRAINING" && sameOwner(target.ownership.handoff.nextOwner, owner)) {
        throw new TerminalControlProtocolError("HANDOFF_PENDING", "target is still draining its previous input owner");
      }
      throw new TerminalControlProtocolError(
        "PERMISSION_DENIED",
        `terminal input is owned by ${target.ownership.owner.kind}`,
      );
    });
  }

  private async renew(
    lease: TerminalControlLease,
    ttlMs = TERMINAL_CONTROL_DEFAULT_LEASE_TTL_MS,
  ): Promise<unknown> {
    return this.locked(async (state) => {
      const target = targetById(state, lease.controlTargetId);
      await this.assertTargetCurrent(state, target);
      validateLease(state, target, lease, { allowDraining: true });
      if (target.ownership.state === "FREE") {
        throw new TerminalControlProtocolError("PERMISSION_DENIED", "target has no current input owner");
      }
      this.registerInteractiveOwner(target.controlTargetId, lease.owner);
      target.ownership.leaseExpiresAt = expiresAt(this.now, ttlMs);
      revision(target);
      target.updatedAt = isoNow(this.now);
      const output = await this.prepareOutput(state, target);
      saveTerminalControlState(state, this.statePath);
      return {
        lease: leaseForOwner(state, target, lease.owner),
        ownership: ownershipView(state, target, output.cursor),
      };
    });
  }

  private async release(lease: TerminalControlLease): Promise<TerminalControlOwnershipView> {
    return this.locked(async (state) => {
      const target = targetById(state, lease.controlTargetId);
      await this.assertTargetCurrent(state, target);
      validateLease(state, target, lease, { allowDraining: true });
      if (target.ownership.state === "DRAINING") {
        throw new TerminalControlProtocolError(
          "HANDOFF_PENDING",
          "draining ownership must commit or cancel its handoff; it cannot pass through FREE",
        );
      }
      if (isInteractiveOwner(lease.owner)) {
        const detached = this.unregisterInteractiveOwner(target.controlTargetId, lease.owner);
        if (!detached.registered) {
          const output = await this.prepareOutput(state, target);
          return ownershipView(state, target, output.cursor);
        }
        if (detached.remaining) {
          const output = await this.prepareOutput(state, target);
          if (target.ownership.state !== "HELD") {
            throw new TerminalControlProtocolError(
              "INTERNAL",
              "terminal-control release no longer owns the target",
            );
          }
          if (!sameOwner(target.ownership.owner, detached.remaining)) {
            target.ownership.owner = detached.remaining;
            revision(target);
            target.updatedAt = isoNow(this.now);
            saveTerminalControlState(state, this.statePath);
          }
          return ownershipView(state, target, output.cursor);
        }
      }
      // An active exact read observation keeps the detached route continuous:
      // the last interactive release still returns to FREE, but the output
      // generation is not reset until the last observer closes. Stale
      // observers are retired first so they cannot suppress the reset.
      this.relayV2ExactPruneStaleObservers(state, target);
      const output = this.relayV2ExactObserverCount(target.controlTargetId) > 0
        ? await this.prepareOutput(state, target)
        : await this.resetOutput(state, target);
      this.resetInteractiveOwners(target.controlTargetId);
      target.ownership = { state: "FREE", fence: nextDecimal(target.ownership.fence) };
      revision(target);
      target.updatedAt = isoNow(this.now);
      saveTerminalControlState(state, this.statePath);
      return ownershipView(state, target, output.cursor);
    });
  }

  private async beginHandoff(
    controlTargetId: string,
    nextOwner: TerminalControlOwner,
    currentLease?: TerminalControlLease,
  ): Promise<unknown> {
    return this.locked(async (state) => {
      const target = targetById(state, controlTargetId);
      await this.assertTargetCurrent(state, target);
      if (target.ownership.state === "FREE") {
        const output = await this.prepareOutput(state, target);
        target.ownership = {
          state: "HELD",
          fence: nextDecimal(target.ownership.fence),
          owner: nextOwner,
          leaseId: randomUUID(),
          leaseExpiresAt: expiresAt(this.now),
        };
        this.resetInteractiveOwners(target.controlTargetId);
        this.registerInteractiveOwner(target.controlTargetId, nextOwner);
        revision(target);
        target.updatedAt = isoNow(this.now);
        saveTerminalControlState(state, this.statePath);
        return { lease: leaseFromTarget(state, target), ownership: ownershipView(state, target, output.cursor) };
      }
      if (target.ownership.state === "DRAINING") {
        if (sameOwner(target.ownership.handoff.nextOwner, nextOwner)) {
          const output = await this.prepareOutput(state, target);
          return { ownership: ownershipView(state, target, output.cursor) };
        }
        throw new TerminalControlProtocolError("HANDOFF_PENDING", "another ownership handoff is already draining");
      }
      if (currentLease) {
        validateLease(state, target, currentLease);
      } else if (
        target.ownership.owner.kind !== "feishu"
        || (nextOwner.kind !== "dashboard" && nextOwner.kind !== "local-cli")
      ) {
        throw new TerminalControlProtocolError(
          "PERMISSION_DENIED",
          "only a controlled local owner may request a lease-less graceful takeover from Feishu",
        );
      }
      if (sameInputOwnerClass(target.ownership.owner, nextOwner)) {
        const output = await this.prepareOutput(state, target);
        this.registerInteractiveOwner(target.controlTargetId, nextOwner);
        return { lease: leaseForOwner(state, target, nextOwner), ownership: ownershipView(state, target, output.cursor) };
      }
      target.ownership = {
        state: "DRAINING",
        fence: target.ownership.fence,
        owner: target.ownership.owner,
        leaseId: target.ownership.leaseId,
        leaseExpiresAt: target.ownership.leaseExpiresAt,
        handoff: {
          handoffId: randomUUID(),
          nextOwner,
          requestedAt: isoNow(this.now),
        },
      };
      revision(target);
      target.updatedAt = isoNow(this.now);
      const output = await this.prepareOutput(state, target);
      saveTerminalControlState(state, this.statePath);
      return { ownership: ownershipView(state, target, output.cursor) };
    });
  }

  private async commitHandoff(
    handoffId: string,
    currentLease: TerminalControlLease,
    drain: TerminalControlDrainProof,
    ttlMs = TERMINAL_CONTROL_DEFAULT_LEASE_TTL_MS,
  ): Promise<unknown> {
    return this.locked(async (state) => {
      const target = targetById(state, currentLease.controlTargetId);
      await this.assertTargetCurrent(state, target);
      validateLease(state, target, currentLease, { allowDraining: true });
      if (target.ownership.state !== "DRAINING" || target.ownership.handoff.handoffId !== handoffId) {
        throw new TerminalControlProtocolError("INVALID_REQUEST", "handoff is not current");
      }
      target.ownership.handoff.drain = drain;
      if (drain.disposition === "uncertain") {
        markRecovery(state, target, "DRAIN_UNCERTAIN", this.now);
        saveTerminalControlState(state, this.statePath);
        throw new TerminalControlProtocolError(
          "RECOVERY_REQUIRED",
          "handoff drain disposition is uncertain; ownership was not transferred",
        );
      }
      const nextOwner = target.ownership.handoff.nextOwner;
      const output = await this.resetOutput(state, target);
      this.resetInteractiveOwners(target.controlTargetId);
      target.ownership = {
        state: "HELD",
        fence: nextDecimal(target.ownership.fence),
        owner: nextOwner,
        leaseId: randomUUID(),
        leaseExpiresAt: expiresAt(this.now, ttlMs),
      };
      this.registerInteractiveOwner(target.controlTargetId, nextOwner);
      target.recovery = undefined;
      revision(target);
      target.updatedAt = isoNow(this.now);
      saveTerminalControlState(state, this.statePath);
      return { lease: leaseFromTarget(state, target), ownership: ownershipView(state, target, output.cursor) };
    });
  }

  private async cancelHandoff(
    handoffId: string,
    currentLease: TerminalControlLease,
  ): Promise<TerminalControlOwnershipView> {
    return this.locked(async (state) => {
      const target = targetById(state, currentLease.controlTargetId);
      await this.assertTargetCurrent(state, target);
      validateLease(state, target, currentLease, { allowDraining: true });
      if (target.ownership.state !== "DRAINING" || target.ownership.handoff.handoffId !== handoffId) {
        throw new TerminalControlProtocolError("INVALID_REQUEST", "handoff is not current");
      }
      target.ownership = {
        state: "HELD",
        fence: target.ownership.fence,
        owner: target.ownership.owner,
        leaseId: target.ownership.leaseId,
        leaseExpiresAt: target.ownership.leaseExpiresAt,
      };
      revision(target);
      target.updatedAt = isoNow(this.now);
      const output = await this.prepareOutput(state, target);
      saveTerminalControlState(state, this.statePath);
      return ownershipView(state, target, output.cursor);
    });
  }

  private async withdrawHandoff(
    controlTargetId: string,
    handoffId: string,
    nextOwner: TerminalControlOwner,
  ): Promise<TerminalControlOwnershipView> {
    return this.locked(async (state) => {
      const target = targetById(state, controlTargetId);
      await this.assertTargetCurrent(state, target);
      if (
        target.ownership.state !== "DRAINING"
        || target.ownership.handoff.handoffId !== handoffId
        || !sameOwner(target.ownership.handoff.nextOwner, nextOwner)
      ) {
        throw new TerminalControlProtocolError(
          "PERMISSION_DENIED",
          "only the exact pending next owner may withdraw this handoff",
        );
      }
      target.ownership = {
        state: "HELD",
        fence: target.ownership.fence,
        owner: target.ownership.owner,
        leaseId: target.ownership.leaseId,
        leaseExpiresAt: target.ownership.leaseExpiresAt,
      };
      revision(target);
      target.updatedAt = isoNow(this.now);
      const output = await this.prepareOutput(state, target);
      saveTerminalControlState(state, this.statePath);
      return ownershipView(state, target, output.cursor);
    });
  }

  private async forceHandoff(
    controlTargetId: string,
    expectedControlEpoch: string,
    nextOwner: TerminalControlOwner,
    proof: TerminalControlRecoveryProof,
    acknowledgeUncertainOperation: boolean,
    ttlMs = TERMINAL_CONTROL_DEFAULT_LEASE_TTL_MS,
  ): Promise<unknown> {
    if (
      (nextOwner.kind !== "dashboard" && nextOwner.kind !== "local-cli")
      || !acknowledgeUncertainOperation
    ) {
      throw new TerminalControlProtocolError(
        "PERMISSION_DENIED",
        "force takeover requires a controlled local owner and persisted external cancellation proof",
      );
    }
    return this.locked(async (state) => {
      const target = targetById(state, controlTargetId);
      if (state.controlEpoch !== expectedControlEpoch) {
        throw new TerminalControlProtocolError(
          "PERMISSION_DENIED",
          "force takeover was prepared for a stale controller epoch",
        );
      }
      if (target.lifecycle === "TARGET_GONE") {
        throw new TerminalControlProtocolError("TARGET_GONE", "control target backend lifecycle has ended");
      }
      const previousOwnerKind = target.ownership.state === "FREE"
        ? target.recovery?.previousOwnerKind
        : target.ownership.owner.kind;
      if (previousOwnerKind === "feishu" && proof.kind === "owner-unreachable") {
        throw new TerminalControlProtocolError(
          "PERMISSION_DENIED",
          "force takeover from Feishu requires a persisted turn cancellation or explicit in-doubt acknowledgement",
        );
      }
      if (target.lifecycle === "ACTIVE" && leaseExpired(target, this.now)) {
        markRecovery(state, target, "LEASE_EXPIRED", this.now);
      }
      if (target.lifecycle === "RECOVERY_REQUIRED" || target.inFlight) {
        try {
          await this.backend.assertCurrent(target.managedSession, target.backend.tmuxInstanceId);
        } catch (error) {
          if (
            error instanceof TerminalControlProtocolError
            && (error.code === "TARGET_GONE" || error.code === "TARGET_NOT_FOUND")
          ) {
            invalidateTarget(target, this.now);
            saveTerminalControlState(state, this.statePath);
            throw new TerminalControlProtocolError(
              "TARGET_GONE",
              error.message,
            );
          }
          if (target.lifecycle !== "RECOVERY_REQUIRED") {
            markRecovery(state, target, "BACKEND_IDENTITY_UNCERTAIN", this.now);
          }
          saveTerminalControlState(state, this.statePath);
          throw new TerminalControlProtocolError(
            "RECOVERY_REQUIRED",
            `force recovery could not prove the exact terminal backend lifecycle: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        // The explicit acknowledgement accepts that the persisted in-flight
        // operation may have taken effect. Advancing the fence is the recovery
        // boundary; the old operation is never replayed by this authority.
        completeInFlightAsInDoubt(target, this.now);
      } else {
        await this.assertTargetCurrent(state, target);
      }
      const output = await this.resetOutput(state, target);
      this.resetInteractiveOwners(target.controlTargetId);
      target.lifecycle = "ACTIVE";
      target.recovery = undefined;
      target.ownership = {
        state: "HELD",
        fence: nextDecimal(target.ownership.fence),
        owner: nextOwner,
        leaseId: randomUUID(),
        leaseExpiresAt: expiresAt(this.now, ttlMs),
      };
      this.registerInteractiveOwner(target.controlTargetId, nextOwner);
      revision(target);
      target.updatedAt = isoNow(this.now);
      saveTerminalControlState(state, this.statePath);
      return { lease: leaseFromTarget(state, target), ownership: ownershipView(state, target, output.cursor) };
    });
  }

  private async executeInput(
    lease: TerminalControlLease,
    operationId: string,
    pane: string,
    kind: TerminalControlOperationRecord["kind"],
    payload: Buffer | string,
  ): Promise<unknown> {
    return this.locked(async (state) => {
      const target = targetById(state, lease.controlTargetId);
      const hasFencedRawPath = kind === "raw"
        && this.backend.rawInputPosition !== undefined
        && this.backend.writeRawFenced !== undefined;
      if (hasFencedRawPath) {
        await this.reconcileAbandonedOwnership(state, target);
      } else {
        await this.assertTargetCurrent(state, target);
      }
      validateLease(state, target, lease);
      this.registerInteractiveOwner(target.controlTargetId, lease.owner);
      const hash = payloadHash(kind, pane, payload);
      const completed = existingOperation(
        target,
        operationId,
        lease.owner.instanceId,
        lease.fence,
        hash,
        kind,
      );
      if (completed) {
        if (hasFencedRawPath) await this.assertTargetCurrent(state, target);
        return operationResult(state, target, completed, true);
      }
      let output: { generation: string; cursor: number };
      if (hasFencedRawPath) {
        try {
          output = await this.backend.rawInputPosition!(
            target.controlTargetId,
            target.outputGeneration,
          );
        } catch (error) {
          if (lease.owner.kind !== "feishu" && target.ownership.state === "HELD" && !target.inFlight) {
            try {
              await this.backend.assertCurrent(target.managedSession, target.backend.tmuxInstanceId);
              output = await this.backend.resetOutput(
                target.controlTargetId,
                target.managedSession.name,
                "0",
                target.outputGeneration,
              );
              target.outputGeneration = output.generation;
              revision(target);
              target.updatedAt = isoNow(this.now);
              saveTerminalControlState(state, this.statePath);
            } catch {
              markRecovery(state, target, "OUTPUT_CONTINUITY_UNCERTAIN", this.now);
              saveTerminalControlState(state, this.statePath);
              throw new TerminalControlProtocolError(
                "RECOVERY_REQUIRED",
                `terminal output continuity is uncertain: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          } else {
            markRecovery(state, target, "OUTPUT_CONTINUITY_UNCERTAIN", this.now);
            saveTerminalControlState(state, this.statePath);
            throw new TerminalControlProtocolError(
              "RECOVERY_REQUIRED",
              `terminal output continuity is uncertain: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      } else {
        output = await this.prepareOutput(state, target);
      }
      target.inFlight = {
        operationId,
        ownerInstanceId: lease.owner.instanceId,
        fence: lease.fence,
        payloadHash: hash,
        kind,
        outputGeneration: output.generation,
        outputCursor: output.cursor,
        startedAt: isoNow(this.now),
      };
      revision(target);
      target.updatedAt = isoNow(this.now);
      saveTerminalControlState(state, this.statePath);
      try {
        const sessionName = target.managedSession.name;
        if (kind === "raw") {
          if (hasFencedRawPath) {
            await this.backend.writeRawFenced!(
              target.managedSession,
              target.backend.tmuxInstanceId,
              output.generation,
              pane,
              payload as Buffer,
            );
          } else {
            await this.backend.writeRaw(sessionName, pane, payload as Buffer);
          }
        } else if (kind === "agent-message") {
          const separator = (payload as string).lastIndexOf("\0");
          await this.backend.sendAgentMessage(
            sessionName,
            pane,
            (payload as string).slice(0, separator),
            (payload as string).slice(separator + 1) === "1",
          );
        } else if (kind === "scroll") {
          const match = /^(up|down):(\d+)$/.exec(payload as string);
          if (!match) throw new Error("invalid normalized scroll payload");
          await this.backend.scroll(
            sessionName,
            pane,
            match[1] as "up" | "down",
            Number(match[2]),
          );
        } else {
          const match = /^(\d+)x(\d+)$/.exec(payload as string);
          if (!match) throw new Error("invalid normalized resize payload");
          await this.backend.resize(sessionName, pane, Number(match[1]), Number(match[2]));
        }
      } catch (error) {
        if (
          hasFencedRawPath
          && error instanceof TerminalControlProtocolError
          && ["TARGET_GONE", "TARGET_NOT_FOUND", "RECOVERY_REQUIRED"].includes(error.code)
        ) {
          // writeRawFenced only returns these errors from pre-write checks or
          // the false branch of tmux if-shell, which proves paste-buffer did
          // not run. Clear the durable in-flight marker without classifying
          // the raw bytes themselves as ambiguous.
          target.inFlight = undefined;
          if (error.code === "TARGET_GONE" || error.code === "TARGET_NOT_FOUND") {
            invalidateTarget(target, this.now);
            saveTerminalControlState(state, this.statePath);
            throw new TerminalControlProtocolError("TARGET_GONE", error.message);
          }
          markRecovery(state, target, "BACKEND_IDENTITY_UNCERTAIN", this.now);
          saveTerminalControlState(state, this.statePath);
          throw new TerminalControlProtocolError("RECOVERY_REQUIRED", error.message);
        }
        markRecovery(state, target, "OPERATION_IN_DOUBT", this.now, { operationId });
        try { saveTerminalControlState(state, this.statePath); } catch {}
        throw new TerminalControlProtocolError(
          "OPERATION_IN_DOUBT",
          `terminal backend write did not reach a provable boundary: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const record: TerminalControlOperationRecord = {
        operationId,
        ownerInstanceId: lease.owner.instanceId,
        fence: lease.fence,
        payloadHash: hash,
        kind,
        disposition: "committed",
        outputGeneration: output.generation,
        outputCursor: output.cursor,
        completedAt: isoNow(this.now),
      };
      appendOperation(target, record);
      target.inFlight = undefined;
      revision(target);
      target.updatedAt = isoNow(this.now);
      saveTerminalControlState(state, this.statePath);
      return operationResult(state, target, record, false);
    });
  }

  private async tailOutput(
    controlTargetId: string,
    controlEpoch: string,
    outputGeneration: string,
    cursor: number,
    maxBytes = TERMINAL_CONTROL_MAX_OUTPUT_TAIL_BYTES,
  ): Promise<unknown> {
    return this.locked(async (state) => {
      const target = targetById(state, controlTargetId);
      if (controlEpoch !== state.controlEpoch || outputGeneration !== target.outputGeneration) {
        throw new TerminalControlProtocolError(
          "STALE_OUTPUT_CURSOR",
          "terminal output cursor was fenced by an ownership or controller generation change",
        );
      }
      await this.assertTargetCurrent(state, target);
      let chunk;
      try {
        chunk = await this.backend.tailOutput(
          target.controlTargetId,
          target.managedSession.name,
          "0",
          outputGeneration,
          cursor,
          maxBytes,
        );
      } catch (error) {
        if (error instanceof TerminalControlProtocolError && error.code === "STALE_OUTPUT_CURSOR") {
          throw error;
        }
        markRecovery(state, target, "OUTPUT_CONTINUITY_UNCERTAIN", this.now);
        saveTerminalControlState(state, this.statePath);
        throw new TerminalControlProtocolError(
          "RECOVERY_REQUIRED",
          `terminal output continuity is uncertain: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return {
        controlTargetId: target.controlTargetId,
        controlEpoch: state.controlEpoch,
        fence: target.ownership.fence,
        ownerKind: target.ownership.state === "FREE" ? undefined : target.ownership.owner.kind,
        outputGeneration: chunk.generation,
        cursor: chunk.cursor,
        dataBase64: chunk.dataBase64,
        nextCursor: chunk.nextCursor,
      };
    });
  }

  private async executeLifecycleKill(
    lease: TerminalControlLease,
    operationId: string,
  ): Promise<unknown> {
    return this.locked(async (state) => {
      const target = targetById(state, lease.controlTargetId);
      const hash = payloadHash("lifecycle-kill", "0", target.managedSession.name);
      const completed = existingOperation(
        target,
        operationId,
        lease.owner.instanceId,
        lease.fence,
        hash,
        "lifecycle-kill",
      );
      if (completed) return operationResult(state, target, completed, true);
      await this.assertTargetCurrent(state, target);
      validateLease(state, target, lease);
      const output = await this.prepareOutput(state, target);
      target.inFlight = {
        operationId,
        ownerInstanceId: lease.owner.instanceId,
        fence: lease.fence,
        payloadHash: hash,
        kind: "lifecycle-kill",
        outputGeneration: output.generation,
        outputCursor: output.cursor,
        startedAt: isoNow(this.now),
      };
      revision(target);
      target.updatedAt = isoNow(this.now);
      saveTerminalControlState(state, this.statePath);
      try {
        await this.backend.killManaged(target.managedSession.name);
      } catch (error) {
        try {
          await this.backend.assertCurrent(target.managedSession, target.backend.tmuxInstanceId);
          target.inFlight = undefined;
          revision(target);
          target.updatedAt = isoNow(this.now);
          saveTerminalControlState(state, this.statePath);
          throw error;
        } catch (proofError) {
          if (proofError === error) throw error;
          markRecovery(state, target, "OPERATION_IN_DOUBT", this.now, { operationId });
          try { saveTerminalControlState(state, this.statePath); } catch {}
          throw new TerminalControlProtocolError(
            "OPERATION_IN_DOUBT",
            "managed target closure did not reach a provable boundary",
          );
        }
      }
      const record: TerminalControlOperationRecord = {
        operationId,
        ownerInstanceId: lease.owner.instanceId,
        fence: lease.fence,
        payloadHash: hash,
        kind: "lifecycle-kill",
        disposition: "committed",
        outputGeneration: output.generation,
        outputCursor: output.cursor,
        completedAt: isoNow(this.now),
      };
      appendOperation(target, record);
      target.inFlight = undefined;
      invalidateTarget(target, this.now);
      saveTerminalControlState(state, this.statePath);
      return operationResult(state, target, record, false);
    });
  }
}
