import { createHash, randomUUID } from "node:crypto";
import type {
  TerminalControlDrainProof,
  TerminalControlLease,
  TerminalControlAgentRuntimeSettings,
  TerminalControlOwner,
  TerminalControlOwnershipView,
  TerminalControlRecoveryProof,
  TerminalControlRequest,
} from "./protocol";
import {
  TERMINAL_CONTROL_CAPABILITY_AGENT_RESULT,
  TERMINAL_CONTROL_CAPABILITY_AGENT_STATUS,
  TERMINAL_CONTROL_CAPABILITY_RENDERED_SNAPSHOT,
  TERMINAL_CONTROL_DEFAULT_LEASE_TTL_MS,
  TERMINAL_CONTROL_MAX_LEASE_TTL_MS,
  TERMINAL_CONTROL_MAX_AGENT_RESULT_BYTES,
  TERMINAL_CONTROL_MAX_OUTPUT_TAIL_BYTES,
  TERMINAL_CONTROL_MAX_RENDERED_SNAPSHOT_BYTES,
  TerminalControlProtocolError,
} from "./protocol";
import {
  TmuxTerminalControlBackend,
  TerminalControlAgentMessageNotAppliedError,
  type TerminalControlBackend,
  type TerminalControlExactTargetObservation,
  type TerminalControlOutputPosition,
} from "./backend";
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
const OUTPUT_CAPTURE_LIMIT_MESSAGE = "terminal output generation exceeded its bounded capture limit";
const LEGACY_CAPTURE_ROTATION_MESSAGE = "terminal output legacy capture requires bounded rotation";

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
  readonly targetExternalEpoch: number;
  state: RelayV2ExactClaimState;
  timer: NodeJS.Timeout | null;
}

interface RelayV2TargetExternalState {
  epoch: number;
  operations: number;
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

function plannedOutputRecoveryGeneration(target: TerminalControlTargetRecord): string {
  if (target.lifecycle !== "RECOVERY_REQUIRED" || !target.recovery) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "terminal output recovery has no persisted recovery identity",
    );
  }
  return createHash("sha256").update(JSON.stringify([
    "terminal-output-recovery-v1",
    target.controlTargetId,
    target.managedSession.name,
    target.managedSession.kind,
    target.managedSession.createdAt,
    target.backend.tmuxInstanceId,
    target.outputGeneration,
    target.ownership.fence,
    target.revision,
    target.recovery.reason,
    target.recovery.since,
    target.recovery.previousControlEpoch,
    target.recovery.previousOwnerKind ?? null,
    target.recovery.operationId ?? null,
  ])).digest("hex");
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

function isOutputCapacityError(error: unknown): error is TerminalControlProtocolError {
  return error instanceof TerminalControlProtocolError
    && error.code === "RESOURCE_EXHAUSTED"
    && error.message === OUTPUT_CAPTURE_LIMIT_MESSAGE;
}

function isOutputRotationError(error: unknown): error is TerminalControlProtocolError {
  return isOutputCapacityError(error)
    || (error instanceof TerminalControlProtocolError
      && error.code === "RESOURCE_EXHAUSTED"
      && error.message === LEGACY_CAPTURE_ROTATION_MESSAGE);
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
  // No operation can be replayed against a retired exact incarnation. Drop
  // its journal immediately so dead targets never amplify future input fsyncs.
  target.completedOperations = [];
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
  // Payload identity remains absolute across a recovery fence. In particular,
  // a caller may not reuse an uncertain operationId for different bytes.
  if (existing.payloadHash !== hash || existing.kind !== kind) {
    throw new TerminalControlProtocolError(
      "INVALID_REQUEST",
      "operationId was reused with different ownership or payload",
    );
  }
  // Recovery deliberately changes the lease fence and may change the Relay
  // process instance. The old operation is still uncertain under that fresh
  // lease: never replay it merely because ownership was re-established.
  if (existing.disposition === "in-doubt") {
    throw new TerminalControlProtocolError(
      "OPERATION_IN_DOUBT",
      "operation was accepted previously but its backend disposition is uncertain",
    );
  }
  if (existing.ownerInstanceId !== ownerInstanceId || existing.fence !== fence) {
    throw new TerminalControlProtocolError(
      "INVALID_REQUEST",
      "operationId was reused with different ownership or payload",
    );
  }
  return existing;
}

function operationResult(
  state: TerminalControlState,
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

function relayV2ExactObservedIdentity(
  input: TerminalControlRelayV2ExactTargetInput,
  observed: TerminalControlExactTargetObservation,
  requireTmuxIdentity: boolean,
): string | null {
  if (!observed
    || typeof observed !== "object"
    || !observed.managedSession
    || typeof observed.managedSession !== "object"
    || observed.managedSession.name !== input.managedTarget.name
    || observed.managedSession.kind !== input.managedTarget.kind
    || observed.managedIncarnation !== input.managedTarget.incarnation) {
    throw new TerminalControlProtocolError(
      "TARGET_GONE",
      "managed target changed during Relay v2 exact preparation",
    );
  }
  const createdAtMs = Date.parse(observed.managedSession.createdAt);
  if (!Number.isFinite(createdAtMs)
    || new Date(createdAtMs).toISOString() !== observed.managedSession.createdAt
    || typeof observed.paneIdentity !== "string"
    || observed.paneIdentity.length === 0
    || observed.paneIdentity.length > 128
    || /[\0\r\n]/.test(observed.paneIdentity)
    || (observed.tmuxInstanceId !== null
      && (typeof observed.tmuxInstanceId !== "string"
        || observed.tmuxInstanceId.length === 0
        || observed.tmuxInstanceId.length > 128
        || /[\0\r\n]/.test(observed.tmuxInstanceId)))) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "exact terminal backend identity is malformed",
    );
  }
  if (requireTmuxIdentity && observed.tmuxInstanceId === null) {
    throw new TerminalControlProtocolError(
      "RECOVERY_REQUIRED",
      "exact terminal backend identity is unavailable",
    );
  }
  return observed.tmuxInstanceId;
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
  /**
   * Persisted Relay v2 leases may be rebound from a short-lived reservation
   * owner to the stream owner without changing their fence. This registry is
   * the process-local producer cut: exactly one rebound owner may write that
   * fence at a time, even though several Relay v2 aliases validate against it.
   */
  private readonly interactiveOwners = new Map<string, TerminalControlOwner>();
  private readonly relayV2ProcessTarget: Readonly<{ kind: "local" | "ssh"; targetId: string }> | null;
  private readonly relayV2ExactTargetTtlMs: number;
  private readonly relayV2ExactClaims = new WeakMap<object, RelayV2ExactClaimRecord>();
  private readonly relayV2ExactLiveClaims = new Set<TerminalControlRelayV2ExactTargetClaim>();
  private readonly relayV2ExactObservations = new WeakMap<object, RelayV2ExactObservationRecord>();
  private readonly relayV2ExactLiveObservations = new Set<TerminalControlRelayV2ExactObservation>();
  private readonly relayV2ExactObserversByTarget = new Map<string, Set<TerminalControlRelayV2ExactObservation>>();
  private readonly relayV2TargetExternalStates = new Map<string, RelayV2TargetExternalState>();
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

  private registerInteractiveOwner(controlTargetId: string, owner: TerminalControlOwner): void {
    if (!isInteractiveOwner(owner)) return;
    const active = this.interactiveOwners.get(controlTargetId);
    if (active && !sameOwner(active, owner)) {
      throw new TerminalControlProtocolError(
        "RESOURCE_EXHAUSTED",
        "terminal input already has another active producer",
        true,
      );
    }
    this.interactiveOwners.set(controlTargetId, owner);
  }

  private unregisterInteractiveOwner(
    controlTargetId: string,
    owner: TerminalControlOwner,
  ): boolean {
    const active = this.interactiveOwners.get(controlTargetId);
    if (!active || !sameOwner(active, owner)) return false;
    this.interactiveOwners.delete(controlTargetId);
    return true;
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
    const targetExternal = this.relayV2TargetExternalStates.get(record.identity.controlTargetId);
    return !this.relayV2ExactClosed
      && this.relayV2ExternalOperations === 0
      && this.relayV2ExternalEpoch === record.externalEpoch
      && (targetExternal?.operations ?? 0) === 0
      && (targetExternal?.epoch ?? 0) === record.targetExternalEpoch
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

  private async relayV2WithdrawExactClaimsForTarget(controlTargetId: string): Promise<void> {
    const records: RelayV2ExactClaimRecord[] = [];
    for (const claim of [...this.relayV2ExactLiveClaims]) {
      const record = this.relayV2ExactClaims.get(claim as object);
      if (record?.identity.controlTargetId !== controlTargetId) continue;
      this.relayV2ExactLiveClaims.delete(claim);
      this.relayV2ExactClaims.delete(claim as object);
      if (record.state !== "consumed" && record.state !== "revoked") {
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

  private async relayV2TargetExternalOperation<T>(
    controlTargetId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const state = this.relayV2TargetExternalStates.get(controlTargetId) ?? {
      epoch: 0,
      operations: 0,
    };
    state.operations += 1;
    state.epoch += 1;
    this.relayV2TargetExternalStates.set(controlTargetId, state);
    try {
      await this.relayV2WithdrawExactClaimsForTarget(controlTargetId);
      return await operation();
    } finally {
      state.operations -= 1;
      state.epoch += 1;
    }
  }

  /**
   * Atomically reserves an exact terminal target. A missing exact current
   * record may be provisioned only through the backend's exact
   * kind/incarnation/pane seam; this never invokes the name-only v1
   * target.resolve path. Existing exact-current records retain the closed
   * inspect-only preparation path. The returned object is useful only to this
   * live authority.
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
      const exactInput = {
        managedName: input.managedTarget.name,
        managedKind: input.managedTarget.kind,
        managedIncarnation: input.managedTarget.incarnation,
        pane: input.pane,
      };
      const namedTargets = state.targets.filter((candidate) => (
        candidate.lifecycle !== "TARGET_GONE"
        && candidate.managedSession.name === input.managedTarget.name
      ));
      let provisionTarget = namedTargets.length === 0;
      let inspected: TerminalControlExactTargetObservation | null = null;
      if (namedTargets.length > 0 && this.backend.observeExactTarget !== undefined) {
        const observed = await this.backend.observeExactTarget(exactInput);
        const observedTmuxInstanceId = relayV2ExactObservedIdentity(
          input,
          observed,
          false,
        );
        const sameLifecycle = namedTargets.filter((candidate) => (
          candidate.managedSession.kind === observed.managedSession.kind
          && candidate.managedSession.createdAt === observed.managedSession.createdAt
        ));
        const exactMatches = observedTmuxInstanceId === null
          ? []
          : sameLifecycle.filter((candidate) => (
              candidate.backend.tmuxInstanceId === observedTmuxInstanceId
            ));
        // A missing tmux identity on the same persisted lifecycle is an
        // uncertainty, not authority to replace that lifecycle. The original
        // inspect-only path below must reject it.
        provisionTarget = exactMatches.length === 0
          && !(observedTmuxInstanceId === null && sameLifecycle.length > 0);
      }
      if (!provisionTarget) {
        inspected = await this.backend.inspectExactTarget!(exactInput);
        const inspectedTmuxInstanceId = relayV2ExactObservedIdentity(
          input,
          inspected,
          true,
        )!;
        const matches = namedTargets.filter((candidate) => (
          candidate.managedSession.kind === inspected!.managedSession.kind
          && candidate.managedSession.createdAt === inspected!.managedSession.createdAt
          && candidate.backend.tmuxInstanceId === inspectedTmuxInstanceId
        ));
        if (matches.length !== 1) {
          throw new TerminalControlProtocolError(
            matches.length === 0 ? "TARGET_NOT_FOUND" : "RECOVERY_REQUIRED",
            "exact terminal-control target is missing or ambiguous",
          );
        }
      } else {
        if (this.backend.establishExactTarget === undefined) {
          throw new TerminalControlProtocolError(
            "TARGET_NOT_FOUND",
            "exact terminal-control target is missing",
          );
        }
        inspected = await this.backend.establishExactTarget(exactInput);
        relayV2ExactObservedIdentity(input, inspected, true);
      }
      const inspectedTmuxInstanceId = inspected!.tmuxInstanceId!;
      const matches = namedTargets.filter((candidate) => (
        candidate.managedSession.kind === inspected!.managedSession.kind
        && candidate.managedSession.createdAt === inspected!.managedSession.createdAt
        && candidate.backend.tmuxInstanceId === inspectedTmuxInstanceId
      ));
      const target: TerminalControlTargetRecord = provisionTarget
        ? {
            controlTargetId: randomUUID(),
            lifecycle: "ACTIVE",
            managedSession: {
              name: inspected!.managedSession.name,
              kind: inspected!.managedSession.kind,
              createdAt: inspected!.managedSession.createdAt,
            },
            backend: {
              kind: "tmux",
              tmuxInstanceId: inspectedTmuxInstanceId,
            },
            outputGeneration: randomUUID(),
            ownership: { state: "FREE", fence: "0" },
            revision: "1",
            completedOperations: [],
            updatedAt: isoNow(this.now),
          }
        : matches[0];
      if (provisionTarget) {
        for (const stale of namedTargets) invalidateTarget(stale, this.now);
        state.targets.push(target);
        await this.prepareOutput(state, target, true);
      }
      // Relay v2 enters through the exact-target reservation path instead of
      // target.resolve / ownership.status.  Reconcile the same safely
      // abandonable non-Feishu states here before ensureOperable fences the
      // reservation.  Without this, an ownerless OUTPUT_CONTINUITY_UNCERTAIN
      // or a dead Relay lease can remain permanently unreachable even after
      // the exact tmux incarnation has already been proved above.
      await this.reconcileAbandonedOwnership(state, target);
      // An uncertain Relay write is not generally auto-recoverable. This
      // exact process/incarnation path may acknowledge it without replaying
      // it: the in-doubt journal survives and fences that operationId, while
      // only a later distinct operation can use the new reservation.
      await this.reconcileRelayV2ExactInDoubtOperation(state, target);
      ensureOperable(target);
      // ownership.status is serialized by this same canonical lock, but it
      // publishes its target-scoped fence before waiting for the lock. Read
      // that fence only after the exact persisted target is known and after
      // the final backend await, immediately before publishing HELD.
      const targetExternal = this.relayV2TargetExternalStates.get(target.controlTargetId);
      const targetExternalEpoch = targetExternal?.epoch ?? 0;
      if ((targetExternal?.operations ?? 0) !== 0) {
        throw new TerminalControlProtocolError(
          "RESOURCE_EXHAUSTED",
          "terminal-control target is busy",
          true,
        );
      }
      if (target.ownership.state !== "FREE") {
        throw new TerminalControlProtocolError(
          "RESOURCE_EXHAUSTED",
          "exact terminal-control target already has an input owner",
          true,
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
        targetExternalEpoch,
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
      targetExternalEpoch: prepared.targetExternalEpoch,
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
      const rejectFencedReservation = (): never => {
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
      };
      if (!this.relayV2ExactClaimCurrent(record)) {
        rejectFencedReservation();
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
      // The first observer must start from a pane snapshot produced while the
      // Host is fully live.  A generation prepared during controller shutdown
      // can be structurally valid yet contain only a partial late redraw (or
      // no bytes at all).  Rotate here so the first phone observer always gets
      // the complete current pane.  Additional concurrent observers stay on
      // the already-pinned generation and do not fence each other.
      const output = this.relayV2ExactObserverCount(target.controlTargetId) === 0
        ? await this.resetOutput(state, target)
        : await this.prepareOutput(state, target, true);
      // Exact target inspection/output preparation may yield while a same-target status
      // poll publishes its fence and waits on this lock. Recheck after the
      // final await, before releasing HELD or publishing the observation.
      if (!this.relayV2ExactClaimCurrent(record)) {
        rejectFencedReservation();
      }
      this.resetInteractiveOwners(target.controlTargetId);
      target.ownership = {
        state: "FREE",
        fence: nextDecimal(target.ownership.fence),
      };
      revision(target);
      target.updatedAt = isoNow(this.now);
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
        outputCursor: output.retainedStartCursor ?? output.cursor,
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
      // A transient identity probe cannot supersede an existing durable
      // recovery transaction. Keep it fenced and retry the exact proof later.
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
      // The target is already durably fenced. Preserve its exact recovery
      // identity so an interrupted explicit recovery derives the same planned
      // output generation on every retry and after controller restart.
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

  /**
   * Reopens only the canonical Relay-v2 exact lane after an uncertain Agent
   * message. The old operation journal is intentionally retained: retrying its
   * operationId remains OPERATION_IN_DOUBT, while a distinct later operation
   * may proceed on the fresh fence. Ordinary v1 acquisition, Feishu recovery,
   * raw terminal input, and every other unsafe recovery reason remain
   * explicitly gated.
   *
   * Exact target preparation has already inspected the full managed
   * incarnation before calling this method. We still reassert the backend
   * identity immediately before the deterministic recovery-generation cut so
   * a target change can never be mistaken for acknowledgement.
   */
  private async reconcileRelayV2ExactInDoubtOperation(
    state: TerminalControlState,
    target: TerminalControlTargetRecord,
  ): Promise<boolean> {
    const recoveryOperationId = target.recovery?.operationId;
    const recoveryOperation = recoveryOperationId === undefined
      ? undefined
      : target.completedOperations.find(
          (operation) => operation.operationId === recoveryOperationId,
        );
    if (target.lifecycle !== "RECOVERY_REQUIRED"
      || target.inFlight
      || !target.recovery
      || target.recovery.reason !== "OPERATION_IN_DOUBT"
      || target.recovery.previousOwnerKind !== "relay-v2"
      || !recoveryOperationId
      || recoveryOperation?.disposition !== "in-doubt"
      || recoveryOperation.kind !== "agent-message") {
      return false;
    }
    try {
      await this.backend.assertCurrent(target.managedSession, target.backend.tmuxInstanceId);
    } catch (error) {
      if (error instanceof TerminalControlProtocolError
        && (error.code === "TARGET_GONE" || error.code === "TARGET_NOT_FOUND")) {
        invalidateTarget(target, this.now);
        saveTerminalControlState(state, this.statePath);
        throw new TerminalControlProtocolError("TARGET_GONE", error.message);
      }
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        `could not prove the exact terminal backend lifecycle: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await this.recoverOutput(target);
    this.resetInteractiveOwners(target.controlTargetId);
    target.lifecycle = "ACTIVE";
    target.recovery = undefined;
    target.ownership = {
      state: "FREE",
      // markRecovery already advanced the fence before recording uncertainty.
      fence: target.ownership.fence,
    };
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
    capturePane = false,
  ): Promise<TerminalControlOutputPosition> {
    try {
      const output = await this.backend.prepareOutput(
        target.controlTargetId,
        target.managedSession.name,
        "0",
        target.outputGeneration,
        capturePane,
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
        && !target.inFlight
        && (
          (target.ownership.state === "FREE" && isOutputRotationError(error))
          || (target.ownership.state === "HELD" && target.ownership.owner.kind !== "feishu")
        )
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
  ): Promise<TerminalControlOutputPosition> {
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

  private async recoverOutput(
    target: TerminalControlTargetRecord,
  ): Promise<TerminalControlOutputPosition> {
    try {
      const output = await this.backend.recoverOutput(
        target.controlTargetId,
        target.managedSession.name,
        "0",
        target.outputGeneration,
        plannedOutputRecoveryGeneration(target),
      );
      target.outputGeneration = output.generation;
      return output;
    } catch (error) {
      throw new TerminalControlProtocolError(
        "RECOVERY_REQUIRED",
        `terminal output continuity is uncertain: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async handle(request: TerminalControlRequest): Promise<unknown> {
    if (request.type === "ping") return this.handleV1(request);
    if (request.type === "ownership.status") {
      return this.relayV2TargetExternalOperation(
        request.controlTargetId,
        () => this.handleV1(request),
      );
    }
    return this.relayV2ExternalOperation(() => this.handleV1(request));
  }

  private async handleV1(request: TerminalControlRequest): Promise<unknown> {
    if (request.type === "ping") {
      return {
        protocolVersion: 1,
        authority: "local-terminal-control",
        capabilities: [
          TERMINAL_CONTROL_CAPABILITY_RENDERED_SNAPSHOT,
          TERMINAL_CONTROL_CAPABILITY_AGENT_STATUS,
          TERMINAL_CONTROL_CAPABILITY_AGENT_RESULT,
        ],
      };
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
      const payload = `${normalized}\0${request.submit ? "1" : "0"}`
        + (request.runtime === undefined ? "" : `\0${JSON.stringify(request.runtime)}`);
      return this.executeInput(
        request.lease,
        request.operationId,
        request.pane,
        "agent-message",
        payload,
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
    if (request.type === "output.rendered-snapshot") {
      return this.renderedSnapshot(
        request.lease,
        request.outputGeneration,
        request.pane,
        request.maxBytes,
      );
    }
    if (request.type === "activity.agent-status") {
      return this.agentStatus(
        request.lease,
        request.outputGeneration,
        request.pane,
      );
    }
    if (request.type === "activity.agent-result") {
      return this.agentResult(
        request.lease,
        request.outputGeneration,
        request.pane,
        request.source,
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
        if (!this.unregisterInteractiveOwner(target.controlTargetId, lease.owner)) {
          const output = await this.prepareOutput(state, target);
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
      if (sameOwner(target.ownership.owner, nextOwner)) {
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
      if (target.lifecycle === "ACTIVE" && leaseExpired(target, this.now)) {
        markRecovery(state, target, "LEASE_EXPIRED", this.now);
        // Persist the recovery identity before touching tmux. The planned
        // output generation is derived only from this durable target record,
        // so a retry after any later interruption computes the same value.
        saveTerminalControlState(state, this.statePath);
      }
      if (target.lifecycle !== "RECOVERY_REQUIRED" || !target.recovery) {
        throw new TerminalControlProtocolError(
          "PERMISSION_DENIED",
          "force recovery is only available for a durably fenced recovery target",
        );
      }
      const previousOwnerKind = target.ownership.state === "FREE"
        ? target.recovery.previousOwnerKind
        : target.ownership.owner.kind;
      if (previousOwnerKind === "feishu" && proof.kind === "owner-unreachable") {
        throw new TerminalControlProtocolError(
          "PERMISSION_DENIED",
          "force takeover from Feishu requires a persisted turn cancellation or explicit in-doubt acknowledgement",
        );
      }
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
        throw new TerminalControlProtocolError(
          "RECOVERY_REQUIRED",
          `force recovery could not prove the exact terminal backend lifecycle: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // The explicit acknowledgement accepts that a persisted in-flight
      // operation may have taken effect. It is never replayed.
      completeInFlightAsInDoubt(target, this.now);
      const output = await this.recoverOutput(target);
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
      if (pane !== "0") {
        // The managed single-pane contract exposes one logical pane regardless
        // of the tmux pane-base-index. Reject it before preparing output or
        // persisting an in-flight operation so backend error codes never need
        // to imply whether a write may already have happened.
        throw new TerminalControlProtocolError(
          "INVALID_REQUEST",
          `managed single-pane target has no logical pane: ${pane}`,
        );
      }
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
        return operationResult(state, completed, true);
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
          const encoded = payload as string;
          const finalSeparator = encoded.lastIndexOf("\0");
          const finalSegment = encoded.slice(finalSeparator + 1);
          let runtime: TerminalControlAgentRuntimeSettings | undefined;
          let messageAndSubmit = encoded;
          if (finalSegment.startsWith("{")) {
            runtime = JSON.parse(finalSegment) as TerminalControlAgentRuntimeSettings;
            messageAndSubmit = encoded.slice(0, finalSeparator);
          }
          const separator = messageAndSubmit.lastIndexOf("\0");
          const message = messageAndSubmit.slice(0, separator);
          const submit = messageAndSubmit.slice(separator + 1) === "1";
          if (this.backend.sendAgentMessageFenced !== undefined) {
            await this.backend.sendAgentMessageFenced(
              target.managedSession,
              target.backend.tmuxInstanceId,
              output.generation,
              pane,
              message,
              submit,
              runtime,
            );
          } else {
            if (runtime !== undefined) {
              throw new TerminalControlProtocolError(
                "INVALID_REQUEST",
                "Agent runtime settings require the fenced terminal backend",
              );
            }
            await this.backend.sendAgentMessage(sessionName, pane, message, submit);
          }
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
        if (kind === "agent-message" && error instanceof TerminalControlAgentMessageNotAppliedError) {
          // This narrow backend error is emitted only before user-message paste. Preserve the
          // backend's target/recovery classification while proving this operation absent.
          target.inFlight = undefined;
          if (error.code === "TARGET_GONE" || error.code === "TARGET_NOT_FOUND") {
            invalidateTarget(target, this.now);
            saveTerminalControlState(state, this.statePath);
            throw new TerminalControlProtocolError("TARGET_GONE", error.message);
          }
          if (error.code === "RECOVERY_REQUIRED") {
            markRecovery(state, target, "BACKEND_IDENTITY_UNCERTAIN", this.now);
            saveTerminalControlState(state, this.statePath);
            throw error;
          }
          saveTerminalControlState(state, this.statePath);
          throw error;
        }
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
      return operationResult(state, record, false);
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

  private async renderedSnapshot(
    lease: TerminalControlLease,
    outputGeneration: string,
    pane: string,
    maxBytes = TERMINAL_CONTROL_MAX_RENDERED_SNAPSHOT_BYTES,
  ): Promise<unknown> {
    return this.locked(async (state) => {
      const target = targetById(state, lease.controlTargetId);
      if (lease.owner.kind !== "feishu" && lease.owner.kind !== "relay-v2") {
        throw new TerminalControlProtocolError(
          "PERMISSION_DENIED",
          "rendered terminal snapshots require the exact Feishu owner",
        );
      }
      await this.assertTargetCurrent(state, target);
      validateLease(state, target, lease, { allowDraining: true });
      if (pane !== "0") {
        throw new TerminalControlProtocolError(
          "INVALID_REQUEST",
          `managed single-pane target has no logical pane: ${pane}`,
        );
      }
      if (outputGeneration !== target.outputGeneration) {
        throw new TerminalControlProtocolError(
          "STALE_OUTPUT_CURSOR",
          "rendered terminal snapshot was fenced by an output generation change",
        );
      }
      const snapshot = await this.backend.captureRenderedSnapshot(
        target.managedSession,
        target.backend.tmuxInstanceId,
        outputGeneration,
        pane,
        maxBytes,
      );
      return {
        controlTargetId: target.controlTargetId,
        controlEpoch: state.controlEpoch,
        leaseId: lease.leaseId,
        fence: target.ownership.fence,
        ownerKind: "feishu",
        outputGeneration,
        pane,
        dataBase64: snapshot.dataBase64,
        truncated: snapshot.truncated,
      };
    });
  }

  private async agentStatus(
    lease: TerminalControlLease,
    outputGeneration: string,
    pane: string,
  ): Promise<unknown> {
    return this.locked(async (state) => {
      const target = targetById(state, lease.controlTargetId);
      if (lease.owner.kind !== "feishu" && lease.owner.kind !== "relay-v2") {
        throw new TerminalControlProtocolError(
          "PERMISSION_DENIED",
          "agent status observations require an exact Agent consumer owner",
        );
      }
      await this.assertTargetCurrent(state, target);
      validateLease(state, target, lease, { allowDraining: true });
      if (pane !== "0") {
        throw new TerminalControlProtocolError(
          "INVALID_REQUEST",
          `managed single-pane target has no logical pane: ${pane}`,
        );
      }
      if (outputGeneration !== target.outputGeneration) {
        throw new TerminalControlProtocolError(
          "STALE_OUTPUT_CURSOR",
          "agent status observation was fenced by an output generation change",
        );
      }
      const activity = await this.backend.agentStatus(
        target.managedSession,
        target.backend.tmuxInstanceId,
        outputGeneration,
        pane,
      );
      return {
        controlTargetId: target.controlTargetId,
        controlEpoch: state.controlEpoch,
        leaseId: lease.leaseId,
        fence: target.ownership.fence,
        ownerKind: lease.owner.kind,
        outputGeneration,
        pane,
        agentSupported: activity.agentSupported,
        agentRunning: activity.agentRunning,
        ...(activity.provider === undefined ? {} : { provider: activity.provider }),
        ...(activity.source === undefined ? {} : { source: activity.source }),
        ...(activity.progress === undefined ? {} : { progress: activity.progress }),
      };
    });
  }

  private async agentResult(
    lease: TerminalControlLease,
    outputGeneration: string,
    pane: string,
    source: import("./protocol").TerminalControlAgentSource,
    maxBytes = TERMINAL_CONTROL_MAX_AGENT_RESULT_BYTES,
  ): Promise<unknown> {
    return this.locked(async (state) => {
      const target = targetById(state, lease.controlTargetId);
      if (lease.owner.kind !== "feishu" && lease.owner.kind !== "relay-v2") {
        throw new TerminalControlProtocolError(
          "PERMISSION_DENIED",
          "Agent final response extraction requires an exact Agent consumer owner",
        );
      }
      await this.assertTargetCurrent(state, target);
      validateLease(state, target, lease, { allowDraining: true });
      if (pane !== "0") {
        throw new TerminalControlProtocolError(
          "INVALID_REQUEST",
          `managed single-pane target has no logical pane: ${pane}`,
        );
      }
      if (outputGeneration !== target.outputGeneration) {
        throw new TerminalControlProtocolError(
          "STALE_OUTPUT_CURSOR",
          "Agent final response extraction was fenced by an output generation change",
        );
      }
      const result = await this.backend.agentResult(
        target.managedSession,
        target.backend.tmuxInstanceId,
        outputGeneration,
        pane,
        source,
        maxBytes,
      );
      return {
        controlTargetId: target.controlTargetId,
        controlEpoch: state.controlEpoch,
        leaseId: lease.leaseId,
        fence: target.ownership.fence,
        ownerKind: lease.owner.kind,
        outputGeneration,
        pane,
        source: result.source,
        completedAt: result.completedAt,
        text: result.text,
        truncated: result.truncated,
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
      if (completed) return operationResult(state, completed, true);
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
      return operationResult(state, record, false);
    });
  }
}
