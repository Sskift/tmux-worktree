import { createHash, randomBytes } from "node:crypto";
import { issueRelayV2CanonicalBackendInstanceKey } from "./canonicalBackendIdentity.js";
import { encodeRelayV2WebSocketFrame } from "./codec.js";
import type { RelayV2JsonObject } from "./codecSchema.js";
import { relayV2CommandReservationLedgerState } from "./hostCommandPlane.js";
import type {
  RelayV2CanonicalBackendOutcome,
  RelayV2CommandRequestFingerprint,
  RelayV2CommandResolutionTransaction,
  RelayV2CommandResourceCommitEvidence,
  RelayV2CommandResourceCommitIntent,
  RelayV2CommandResourceMutationOwner,
  RelayV2CommandResourceReservationBinding,
  RelayV2CommandResourceReservationIntent,
  RelayV2CommandResourceReservationResult,
  RelayV2CommandResourceSettlementIntent,
  RelayV2CommandResourceTransaction,
} from "./hostCommandPlane.js";
import {
  type RelayV2HostJson,
  type RelayV2HostStateCommit,
  type RelayV2HostStateCriticalSection,
  type RelayV2HostStateSnapshot,
  type RelayV2HostStateStore,
  type RelayV2HostStateTransaction,
} from "./hostState.js";

/**
 * Relay v2 H2 materialized-state foundation only.
 *
 * Pinned snapshot lifecycle, cursor, lease, quota, release, and recovery belong
 * to the separate stateSnapshotSpool foundation. This module only exposes the
 * minimal materialized-cut source used by that owner. The capacity reservation
 * below is only H1 create admission metadata inside H0; it cannot publish or
 * serve a state snapshot.
 */

const MATERIALIZED_STATE_KEY = "h2:resource-state:v1";
const SCOPES_REVISION_KEY = "scopes";
const SESSIONS_REVISION_PREFIX = "sessions:";
const MATERIALIZED_STATE_VERSION = 1 as const;
const RECONCILE_MAX_ATTEMPTS = 3;
const RECONCILE_RETRY_BASE_MS = 5;

const RELAY_V2_MATERIALIZED_CUT_CANDIDATE_LIMITS = Object.freeze({
  maxCandidates: 16,
  maxRetainedBytes: 536_870_912,
  maxBufferedEventsPerCandidate: 512,
  maxBufferedBytesPerCandidate: 4_194_304,
  candidateTtlMs: 300_000,
});

export const RELAY_V2_MATERIALIZED_CAPACITY = Object.freeze({
  maxSnapshotRecords: 100_000,
  maxSnapshotCanonicalBytes: 268_435_456,
});

export const RELAY_V2_RESOURCE_RESERVATION_LIMITS = Object.freeze({
  maxSessionCanonicalBytes: 65_536,
});

export type RelayV2ScopeKind = "local" | "ssh";
export type RelayV2ScopeReachability = "online" | "unreachable";
export type RelayV2DiscoveryCompleteness = "complete" | "partial";

export interface RelayV2Scope {
  scopeId: string;
  displayName: string;
  kind: RelayV2ScopeKind;
  reachability: RelayV2ScopeReachability;
}

export interface RelayV2Session {
  scopeId: string;
  sessionId: string;
  kind: "worktree" | "terminal";
  displayName: string;
  state: "running";
  project: string | null;
  label: string | null;
  cwd: string | null;
  attached: boolean;
  windowCount: number;
  createdAtMs: number;
  activityAtMs: number;
}

export interface RelayV2DiscoveryError {
  code: string;
  message: string;
  retryable: boolean;
  commandDisposition: "not_applicable";
  retryAfterMs?: number | null;
}

export interface RelayV2DiscoveredSession {
  /** Backend instance key; authority also includes hostEpoch, scopeId, and kind. */
  backendIdentity: string;
  kind: RelayV2Session["kind"];
  displayName: string;
  state: "running";
  project: string | null;
  label: string | null;
  cwd: string | null;
  attached: boolean;
  windowCount: number;
  createdAtMs: number;
  activityAtMs: number;
  /** Optional authoritative creation marker; display/name equality is never correlation. */
  reservationCorrelation?: RelayV2DiscoveredReservationCorrelation | null;
}

export interface RelayV2DiscoveredReservationCorrelation {
  schemaVersion: 1;
  reservationId: string;
  hostEpoch: string;
  principalId: string;
  hostId: string;
  commandId: string;
  requestFingerprint: RelayV2CommandRequestFingerprint;
}

export interface RelayV2DiscoveredScope {
  /** Stable backend identity on this relay-host. Never exposed on the wire. */
  backendIdentity: string;
  displayName: string;
  kind: RelayV2ScopeKind;
  reachability: RelayV2ScopeReachability;
  sessionsCompleteness: RelayV2DiscoveryCompleteness;
  sessions: readonly RelayV2DiscoveredSession[];
  error: RelayV2DiscoveryError | null;
  /** Describes marker coverage only; marker absence never proves no side effect. */
  reservationCorrelationCompleteness?: "complete" | "unavailable";
}

export interface RelayV2ResourceDiscoveryScan {
  coverage: RelayV2DiscoveryCompleteness;
  scopes: readonly RelayV2DiscoveredScope[];
  /** Process-local exact-target evidence; deliberately omitted from JSON/storage. */
  [RELAY_V2_RESOURCE_RESOLVER_CUT]?: RelayV2ResourceResolverDiscoveryCut;
}

export interface RelayV2ResourceDiscovery {
  scan(): Promise<RelayV2ResourceDiscoveryScan>;
}

export interface RelayV2ResourceResolverProcessTarget {
  kind: RelayV2ScopeKind;
  targetId: string;
}

export interface RelayV2ResourceResolverScopeEvidence {
  scopeBackendIdentity: string;
  processTarget: RelayV2ResourceResolverProcessTarget;
  capabilities: readonly string[];
}

export interface RelayV2ResourceResolverSessionEvidence {
  scopeBackendIdentity: string;
  sessionBackendIdentity: string;
  backendKind: RelayV2Session["kind"];
  processTarget: RelayV2ResourceResolverProcessTarget;
  capabilities: readonly string[];
  managedTarget: {
    name: string;
    kind: RelayV2Session["kind"];
    incarnation: string;
  };
}

/**
 * One immutable discovery/config winner. isCurrent() is checked inside the H0
 * serializer, so a concurrent reconfiguration cannot publish its old targets.
 */
export interface RelayV2ResourceResolverDiscoveryCut {
  generation: string;
  scopeTargets: readonly RelayV2ResourceResolverScopeEvidence[];
  sessionTargets: readonly RelayV2ResourceResolverSessionEvidence[];
  isCurrent(): boolean;
}

export const RELAY_V2_RESOURCE_RESOLVER_CUT = Symbol.for(
  "tmux-worktree.relay-v2.resource-resolver-cut",
);

export interface RelayV2CanonicalResourceResolverToken {
  schemaVersion: 1;
  hostEpoch: string;
  resourceMappingDigest: string;
  discoveryGeneration: string;
}

export interface RelayV2CanonicalResolvedScopeTarget {
  authorization: "evidence_only";
  hostEpoch: string;
  discoveryGeneration: string;
  scopeId: string;
  processTarget: RelayV2ResourceResolverProcessTarget;
  capabilities: readonly string[];
}

export interface RelayV2CanonicalResolvedSessionTarget
extends RelayV2CanonicalResolvedScopeTarget {
  sessionId: string;
  backendInstanceKey: string;
  managedTarget: {
    name: string;
    kind: RelayV2Session["kind"];
    incarnation: string;
  };
}

export type RelayV2CanonicalResourceResolutionResult =
  | {
      kind: "positive";
      target: RelayV2CanonicalResolvedScopeTarget | RelayV2CanonicalResolvedSessionTarget;
    }
  | {
      kind: "complete_negative";
      code: "SCOPE_NOT_FOUND" | "SESSION_NOT_FOUND";
    };

export interface RelayV2CanonicalResourceResolutionFence {
  schemaVersion: 1;
  token: RelayV2CanonicalResourceResolverToken;
  expectedScopeId: string;
  expectedSessionId: string | null;
  result: RelayV2CanonicalResourceResolutionResult;
}

/**
 * Exact, side-effect-free H2 discovery evidence. A resource cut never proves a
 * command-level PROJECT_NOT_FOUND/PANE_NOT_FOUND result and never grants
 * execution authority. The composed canonical resolver must first fence its
 * command owner (including catalog, pane, and terminal lease identities), bind
 * that proof to the command request/target, and only then delegate this opaque
 * resource cut to the synchronous H2 seam inside the H0 admission transaction.
 * This foundation is not connected to H1/H3 production composition.
 */
export interface RelayV2CanonicalResourceResolverPort {
  captureToken(expectedHostEpoch: string): Promise<RelayV2CanonicalResourceResolverToken>;
  resolveScope(
    token: RelayV2CanonicalResourceResolverToken,
    scopeId: string,
  ): Promise<RelayV2CanonicalResolvedScopeTarget>;
  resolveSession(
    token: RelayV2CanonicalResourceResolverToken,
    scopeId: string,
    sessionId: string,
  ): Promise<RelayV2CanonicalResolvedSessionTarget>;
  resolveScopeForAdmission(
    token: RelayV2CanonicalResourceResolverToken,
    scopeId: string,
  ): Promise<RelayV2CanonicalResourceResolutionFence>;
  resolveSessionForAdmission(
    token: RelayV2CanonicalResourceResolverToken,
    scopeId: string,
    sessionId: string,
  ): Promise<RelayV2CanonicalResourceResolutionFence>;
  fenceResourceCutForAdmission(
    transaction: RelayV2CommandResolutionTransaction,
    fence: RelayV2CanonicalResourceResolutionFence,
  ): void;
}

export interface RelayV2FencedNegativeCandidate {
  reservationId: string;
  hostEpoch: string;
  principalId: string;
  hostId: string;
  commandId: string;
  requestFingerprint: RelayV2CommandRequestFingerprint;
  operation: "create_worktree" | "create_terminal";
  scopeId: string;
  /** Candidates with positive backend evidence are never offered. */
  boundBackendInstanceKey: null;
}

export interface RelayV2FencedNegativeEvidence extends RelayV2FencedNegativeCandidate {
  schemaVersion: 1;
  authority: "canonical_executor";
  disposition: "fenced_no_side_effect";
}

/** Optional canonical-operation barrier. Discovery absence is never evidence. */
export interface RelayV2ReservationSettlementAuthority {
  fencedNegativeEvidence(
    candidates: readonly RelayV2FencedNegativeCandidate[],
  ): Promise<readonly RelayV2FencedNegativeEvidence[]>;
}

export interface RelayV2StateEventSink<T = RelayV2JsonObject> {
  /** False means the bounded queue cannot preserve event continuity. */
  enqueue(item: T): boolean;
  close?(error: RelayV2MaterializedStateError): void;
}

export interface RelayV2WelcomeCut {
  hostEpoch: string;
  hostInstanceId: string;
  eventSeq: string;
  requiresSnapshot: boolean;
}

export type RelayV2MaterializedReadinessReason =
  | "ready"
  | "aggregate_authority_not_established"
  | "aggregate_coverage_partial"
  | "capacity_exceeded"
  | "partial_online_scope"
  | "scope_without_complete_authority"
  | "persisted_capacity_exceeded"
  | "reconcile_generation_conflict"
  | "materialized_authority_conflict"
  | "commit_uncertain"
  | "host_epoch_changed";

export interface RelayV2MaterializedReadiness {
  snapshotMaterializationReady: boolean;
  reason: RelayV2MaterializedReadinessReason;
  closeV2Routes: boolean;
  hostEpoch: string;
  eventSeq: string;
  totalRecords: number;
  totalCanonicalBytes: number;
}

/**
 * Runtime adapter boundary. Applying an unavailable signal must synchronously
 * withdraw snapshot.revision/event.sequence readiness and fence existing v2
 * routes before returning true. This foundation never advertises capability.
 */
export interface RelayV2MaterializedReadinessSink {
  apply(readiness: RelayV2MaterializedReadiness): boolean;
}

interface RelayV2SessionTarget {
  hostEpoch: string;
  scopeId: string;
  sessionId: string;
  scopeBackendIdentity: string;
  sessionBackendIdentity: string;
  scopeReachability: RelayV2ScopeReachability;
  sessionsCompleteness: RelayV2DiscoveryCompleteness;
  sessionsAuthorityEstablished: boolean;
  item: RelayV2Session;
}

interface RelayV2MaterializedCapacityAssessment {
  withinCapacity: boolean;
  totalRecords: number;
  totalCanonicalBytes: number;
}

export type RelayV2ProspectiveSession = Omit<
  RelayV2DiscoveredSession,
  "backendIdentity" | "reservationCorrelation"
>;

export interface RelayV2ResourceReservationPlan {
  logicalTarget: RelayV2HostJson;
  session: RelayV2ProspectiveSession;
}

export interface RelayV2MaterializedReconcileResult {
  events: RelayV2JsonObject[];
  snapshot: RelayV2HostStateSnapshot;
  readiness: RelayV2MaterializedReadiness;
}

export type RelayV2MaterializedStateCutRecord =
  | { recordType: "scope"; item: RelayV2Scope }
  | {
      recordType: "sessions_scope";
      scopeId: string;
      revision: string;
      completeness: "complete";
    }
  | { recordType: "session"; scopeId: string; item: RelayV2Session };

export interface RelayV2MaterializedStateCut {
  hostEpoch: string;
  throughEventSeq: string;
  scopesRevision: string;
  records: RelayV2MaterializedStateCutRecord[];
}

export interface RelayV2MaterializedStateCutAdmissionEstimate {
  hostEpoch: string;
  totalRecords: number;
  totalCanonicalBytes: number;
}

declare const relayV2MaterializedStateCutCandidateLeaseBrand: unique symbol;
declare const relayV2MaterializedStateCutActivationLeaseBrand: unique symbol;

/**
 * Instance-private H0 lease for one exact serializer cut. It has no JSON or
 * structured-clone representation; only its issuing cut source can inspect or
 * fence it. A candidate is not an H2 readiness receipt.
 */
export interface RelayV2MaterializedStateCutCandidateLease {
  readonly [relayV2MaterializedStateCutCandidateLeaseBrand]: true;
}

/**
 * Process-local exact lease for the subscriber that consumed one candidate.
 * Only the issuing H0 cut source can release it; it is never persisted or
 * serialized.
 */
export interface RelayV2MaterializedStateCutActivationLease {
  readonly [relayV2MaterializedStateCutActivationLeaseBrand]: true;
}

export interface RelayV2MaterializedStateCutCandidate {
  hostId: string;
  hostEpoch: string;
  hostInstanceId: string;
  materializedSourceGeneration: string;
  materializedGeneration: string;
  materializedCutIdentity: string;
  cutRecordCount: number;
  cutCanonicalBytes: number;
  subscriptionQueueGeneration: string;
  cut: RelayV2MaterializedStateCut;
}

/**
 * Read-only H0/H2 seam for the pinned snapshot spool.
 *
 * captureCandidate() projects every counter and record from one H0 serializer
 * cut and installs its bounded W+1 provisional subscriber before releasing the
 * serializer. It never performs discovery or other backend I/O.
 * admissionEstimate() uses the same materialized authority's conservative
 * capacity measure, including H1 capacity reservations that the cut
 * deliberately does not project.
 */
export interface RelayV2MaterializedStateCutSource {
  currentHostEpoch(): Promise<string>;
  withHostEpochFence<T>(
    expectedHostEpoch: string,
    operation: () => T | Promise<T>,
  ): Promise<T>;
  admissionEstimate(
    expectedHostEpoch: string,
  ): Promise<RelayV2MaterializedStateCutAdmissionEstimate>;
  captureCandidate(
    expectedHostEpoch: string,
  ): Promise<RelayV2MaterializedStateCutCandidateLease>;
  inspectCandidate(
    lease: RelayV2MaterializedStateCutCandidateLease,
  ): RelayV2MaterializedStateCutCandidate;
  withCandidateFence<T>(
    lease: RelayV2MaterializedStateCutCandidateLease,
    operation: (candidate: RelayV2MaterializedStateCutCandidate) => T | Promise<T>,
  ): Promise<T>;
  activateCandidate(
    lease: RelayV2MaterializedStateCutCandidateLease,
    sink: RelayV2StateEventSink<RelayV2JsonObject>,
    beforeDrain: (candidate: RelayV2MaterializedStateCutCandidate) => true,
    afterAttach: (
      candidate: RelayV2MaterializedStateCutCandidate,
      activation: RelayV2MaterializedStateCutActivationLease,
    ) => true,
  ): Promise<RelayV2MaterializedStateCutActivationLease>;
  releaseCandidateActivation(
    activation: RelayV2MaterializedStateCutActivationLease,
  ): void;
  /** A new spool owner synchronously withdraws prior in-process H2 authority. */
  withdrawSnapshotOwnerAuthority(): Promise<void>;
  releaseCandidate(lease: RelayV2MaterializedStateCutCandidateLease): void;
}

export type RelayV2MaterializedErrorCode =
  | "BUSY"
  | "CAPABILITY_UNAVAILABLE"
  | "HOST_EPOCH_MISMATCH"
  | "IDEMPOTENCY_CONFLICT"
  | "INTERNAL"
  | "INVALID_ARGUMENT"
  | "SESSION_NOT_FOUND"
  | "SNAPSHOT_TOO_LARGE"
  | "SCOPE_NOT_FOUND";

const RELAY_V2_MATERIALIZED_STATE_ERROR = Symbol.for(
  "tmux-worktree.relay-v2.materialized-state-error",
);

export class RelayV2MaterializedStateError extends Error {
  readonly [RELAY_V2_MATERIALIZED_STATE_ERROR] = true;

  constructor(
    readonly code: RelayV2MaterializedErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> | null = null,
  ) {
    super(message);
    this.name = "RelayV2MaterializedStateError";
  }
}

export function isRelayV2MaterializedStateError(
  error: unknown,
): error is RelayV2MaterializedStateError {
  return !!error
    && typeof error === "object"
    && (error as Record<PropertyKey, unknown>)[RELAY_V2_MATERIALIZED_STATE_ERROR] === true;
}

interface PersistedSession {
  backendIdentity: string;
  item: RelayV2Session;
  originReservation: PersistedReservationIdentity | null;
}

interface PersistedScope {
  backendIdentity: string;
  item: RelayV2Scope;
  sessionsCompleteness: RelayV2DiscoveryCompleteness;
  sessionsAuthorityEstablished: boolean;
  sessionsError: RelayV2DiscoveryError | null;
  sessions: PersistedSession[];
}

interface PersistedCapacityReservation {
  reservationId: string;
  hostEpoch: string;
  principalId: string;
  hostId: string;
  commandId: string;
  requestFingerprint: RelayV2CommandRequestFingerprint;
  operation: "create_worktree" | "create_terminal";
  scopeId: string;
  logicalTarget: RelayV2HostJson;
  reservedSessionId: string;
  plannedSession: RelayV2ProspectiveSession;
  boundBackendIdentity: string | null;
  uncertain: boolean;
  reservedRecords: 1;
  reservedCanonicalBytes: number;
}

interface PersistedReservationIdentity {
  reservationId: string;
  hostEpoch: string;
  principalId: string;
  hostId: string;
  commandId: string;
  requestFingerprint: RelayV2CommandRequestFingerprint;
}

interface PersistedNegativeSettlement extends PersistedReservationIdentity {
  operation: "create_worktree" | "create_terminal";
  scopeId: string;
  backendKind: RelayV2Session["kind"];
}

interface PersistedMaterializedState {
  version: typeof MATERIALIZED_STATE_VERSION;
  generation: string;
  aggregateAuthorityEstablished: boolean;
  aggregateCoverage: RelayV2DiscoveryCompleteness;
  usedScopeIds: string[];
  usedSessionIds: string[];
  scopes: PersistedScope[];
  capacityReservations: PersistedCapacityReservation[];
  negativeSettlements: PersistedNegativeSettlement[];
}

interface Subscriber {
  epoch: string;
  sink: RelayV2StateEventSink<RelayV2JsonObject>;
  enqueue: (item: RelayV2JsonObject) => unknown;
  close: ((error: RelayV2MaterializedStateError) => unknown) | null;
  activationLease: object | null;
  closed: boolean;
}

interface PublishedCanonicalResolver {
  token: RelayV2CanonicalResourceResolverToken;
  discoveryCut: RelayV2ResourceResolverDiscoveryCut;
  scopes: ReadonlyMap<string, RelayV2CanonicalResolvedScopeTarget>;
  sessions: ReadonlyMap<string, RelayV2CanonicalResolvedSessionTarget>;
}

interface MaterializedPublicationOutcome {
  readiness: RelayV2MaterializedReadiness;
  accepted: boolean;
}

interface MaterializedCutCandidateRecord extends RelayV2MaterializedStateCutCandidate {
  sourceIdentity: object;
  leaseNonce: string;
  subscriptionIdentity: object;
  capturedAtMs: number;
  expiresAtMs: number;
  lastQueuedEventSeq: string;
  bufferedEventCount: number;
  bufferedCanonicalBytes: number;
  retainedBytes: number;
  events: RelayV2JsonObject[];
}

interface MaterializedCutActivationRecord {
  activation: RelayV2MaterializedStateCutActivationLease;
  sourceIdentity: object;
  sourceGeneration: string;
  subscriptionIdentity: object;
  subscriptionQueueGeneration: string;
  candidateNonce: string;
  activationNonce: string;
  sinkIdentity: object;
  subscriber: Subscriber;
}

type MaterializedCutCandidateLimits = typeof RELAY_V2_MATERIALIZED_CUT_CANDIDATE_LIMITS;

export interface RelayV2MaterializedStateTestHooks {
  afterSnapshotCandidateSubscriptionInstall?: () => void;
}

interface PendingChange {
  scopeId: string;
  dimension: "scopes" | "sessions";
  identity: string;
  change: Record<string, unknown>;
}

type MaterializedCapacity = typeof RELAY_V2_MATERIALIZED_CAPACITY;
type ResourceReservationLimits = typeof RELAY_V2_RESOURCE_RESERVATION_LIMITS;

export interface RelayV2MaterializedStateOptions {
  hostId: string;
  discovery: RelayV2ResourceDiscovery;
  store: Pick<RelayV2HostStateStore, "serialize">;
  readinessSink: RelayV2MaterializedReadinessSink;
  reservationSettlementAuthority?: RelayV2ReservationSettlementAuthority;
  /** Tests may only shrink frozen capacity boundaries. */
  testCapacityLimits?: Partial<MaterializedCapacity>;
  /** Tests may only shrink the frozen conservative Session charge. */
  testReservationLimits?: Partial<ResourceReservationLimits>;
  /** Tests may only shrink the provisional W+1 candidate boundaries. */
  testSnapshotCandidateLimits?: Partial<MaterializedCutCandidateLimits>;
  /** Deterministic clock injection only; production composition must omit it. */
  now?: () => number;
  /** Deterministic fault injection only; production composition must omit it. */
  testHooks?: RelayV2MaterializedStateTestHooks;
}

const EMPTY_STATE: PersistedMaterializedState = {
  version: MATERIALIZED_STATE_VERSION,
  generation: "0",
  aggregateAuthorityEstablished: false,
  aggregateCoverage: "partial",
  usedScopeIds: [],
  usedSessionIds: [],
  scopes: [],
  capacityReservations: [],
  negativeSettlements: [],
};

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sessionBackendAuthorityKey(
  hostEpoch: string,
  scopeId: string,
  backendKind: RelayV2Session["kind"],
  backendInstanceKey: string,
): string {
  return canonicalJson({ hostEpoch, scopeId, backendKind, backendInstanceKey });
}

function discoveredSessionAuthorityKey(session: RelayV2DiscoveredSession): string {
  return canonicalJson({
    backendKind: session.kind,
    backendInstanceKey: session.backendIdentity,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function consumeThenable(value: unknown): boolean {
  try {
    if (((typeof value === "object" && value !== null) || typeof value === "function")
      && typeof (value as { then?: unknown }).then === "function") {
      void Promise.resolve(value).catch(() => undefined);
      return true;
    }
  } catch {
    return true;
  }
  return false;
}

function strictSynchronousTrue(value: unknown): value is true {
  return !consumeThenable(value) && value === true;
}

function closeSubscriber(
  sink: RelayV2StateEventSink<RelayV2JsonObject>,
  error: RelayV2MaterializedStateError,
): void {
  try {
    consumeThenable(sink.close?.(error) as unknown);
  } catch {}
}

function captureSubscriber(
  epoch: string,
  sink: RelayV2StateEventSink<RelayV2JsonObject>,
  activationLease: object | null,
): Subscriber {
  if ((typeof sink !== "object" && typeof sink !== "function") || sink === null) {
    throw new RelayV2MaterializedStateError("INVALID_ARGUMENT", "subscriber sink is invalid");
  }
  let enqueue: unknown;
  let close: unknown;
  try {
    enqueue = sink.enqueue;
    close = sink.close;
  } catch {
    throw new RelayV2MaterializedStateError("INVALID_ARGUMENT", "subscriber sink is invalid");
  }
  if (typeof enqueue !== "function" || (close !== undefined && typeof close !== "function")) {
    throw new RelayV2MaterializedStateError("INVALID_ARGUMENT", "subscriber sink is invalid");
  }
  const exactEnqueue = enqueue;
  const exactClose = close;
  return {
    epoch,
    sink,
    enqueue: (item) => Reflect.apply(exactEnqueue, sink, [item]),
    close: exactClose === undefined
      ? null
      : (error) => Reflect.apply(exactClose, sink, [error]),
    activationLease,
    closed: false,
  };
}

function closeCapturedSubscriber(
  subscriber: Subscriber,
  error: RelayV2MaterializedStateError,
): void {
  if (subscriber.closed) return;
  subscriber.closed = true;
  try {
    consumeThenable(subscriber.close?.(error));
  } catch {}
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = new Set(keys);
  return keys.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => expected.has(key));
}

function isCommitUncertain(error: unknown): boolean {
  return isRecord(error)
    && error.code === "RELAY_V2_HOST_STATE_COMMIT_UNCERTAIN";
}

function isPersistedCapacityError(error: unknown): boolean {
  return isRecord(error)
    && error.code === "RELAY_V2_HOST_STATE_CAPACITY_EXCEEDED";
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function waitForReconcileRetry(attempt: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, RECONCILE_RETRY_BASE_MS * attempt);
  });
}

function advanceMaterializedGeneration(state: PersistedMaterializedState): void {
  state.generation = (BigInt(state.generation) + 1n).toString(10);
}

function issueUnusedOpaqueId(
  transaction: Pick<RelayV2CommandResourceTransaction, "issueOpaqueId">,
  prefix: "scope" | "ses" | "res",
  unavailable: ReadonlySet<string>,
): string {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = transaction.issueOpaqueId(prefix);
    if (!unavailable.has(candidate)) return candidate;
  }
  throw new RelayV2MaterializedStateError(
    "INTERNAL",
    `opaque ${prefix} identity allocation repeatedly collided with lineage authority`,
  );
}

function assertSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RelayV2MaterializedStateError("INTERNAL", `invalid materialized ${label}`);
  }
}

function assertString(value: unknown, label: string, maxBytes: number): asserts value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > maxBytes
    || value.includes("\0")
  ) {
    throw new RelayV2MaterializedStateError("INTERNAL", `invalid materialized ${label}`);
  }
}

function validateOpaqueInput(value: string, label: string): void {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > 128
    || value.includes("\0")
  ) {
    throw new RelayV2MaterializedStateError("INVALID_ARGUMENT", `${label} is invalid`);
  }
}

function isCanonicalCounter(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
}

function normalizeCanonicalResolverToken(
  value: unknown,
): RelayV2CanonicalResourceResolverToken {
  if (!isRecord(value)
    || !exactKeys(value, [
      "schemaVersion", "hostEpoch", "resourceMappingDigest", "discoveryGeneration",
    ])
    || value.schemaVersion !== 1) {
    throw new RelayV2MaterializedStateError("INVALID_ARGUMENT", "resolver token is invalid");
  }
  for (const field of [
    "hostEpoch", "resourceMappingDigest", "discoveryGeneration",
  ] as const) {
    validateOpaqueInput(value[field] as string, `resolver token ${field}`);
  }
  return clone(value) as unknown as RelayV2CanonicalResourceResolverToken;
}

function normalizeCanonicalResolutionFence(
  value: unknown,
): RelayV2CanonicalResourceResolutionFence {
  if (!isRecord(value)
    || !exactKeys(value, [
      "schemaVersion", "token", "expectedScopeId", "expectedSessionId", "result",
    ])
    || value.schemaVersion !== 1) {
    throw new RelayV2MaterializedStateError("INVALID_ARGUMENT", "resolution fence is invalid");
  }
  const token = normalizeCanonicalResolverToken(value.token);
  validateOpaqueInput(value.expectedScopeId as string, "resolution fence expectedScopeId");
  if (value.expectedSessionId !== null) {
    validateOpaqueInput(
      value.expectedSessionId as string,
      "resolution fence expectedSessionId",
    );
  }
  if (!isRecord(value.result)) {
    throw new RelayV2MaterializedStateError("INVALID_ARGUMENT", "resolution fence result is invalid");
  }
  if (value.result.kind === "positive") {
    if (!exactKeys(value.result, ["kind", "target"]) || !isRecord(value.result.target)) {
      throw new RelayV2MaterializedStateError("INVALID_ARGUMENT", "positive resolution fence is invalid");
    }
  } else if (value.result.kind === "complete_negative") {
    if (!exactKeys(value.result, ["kind", "code"])
      || (value.result.code !== "SCOPE_NOT_FOUND"
        && value.result.code !== "SESSION_NOT_FOUND")) {
      throw new RelayV2MaterializedStateError("INVALID_ARGUMENT", "negative resolution fence is invalid");
    }
  } else {
    throw new RelayV2MaterializedStateError("INVALID_ARGUMENT", "resolution fence result is invalid");
  }
  return clone({
    schemaVersion: 1,
    token,
    expectedScopeId: value.expectedScopeId,
    expectedSessionId: value.expectedSessionId,
    result: value.result,
  }) as RelayV2CanonicalResourceResolutionFence;
}

function resolverCutIsCurrent(cut: RelayV2ResourceResolverDiscoveryCut): boolean {
  try {
    return cut.isCurrent() === true;
  } catch {
    return false;
  }
}

function validateScope(value: unknown): asserts value is RelayV2Scope {
  if (!isRecord(value) || !exactKeys(value, [
    "scopeId", "displayName", "kind", "reachability",
  ])) {
    throw new RelayV2MaterializedStateError("INTERNAL", "invalid materialized Scope");
  }
  assertString(value.scopeId, "scopeId", 128);
  assertString(value.displayName, "scope displayName", 128);
  if (value.kind !== "local" && value.kind !== "ssh") {
    throw new RelayV2MaterializedStateError("INTERNAL", "invalid materialized scope kind");
  }
  if (value.reachability !== "online" && value.reachability !== "unreachable") {
    throw new RelayV2MaterializedStateError("INTERNAL", "invalid materialized reachability");
  }
}

function validateSession(value: unknown, scopeId?: string): asserts value is RelayV2Session {
  if (!isRecord(value) || !exactKeys(value, [
    "scopeId", "sessionId", "kind", "displayName", "state", "project",
    "label", "cwd", "attached", "windowCount", "createdAtMs", "activityAtMs",
  ])) {
    throw new RelayV2MaterializedStateError("INTERNAL", "invalid materialized Session");
  }
  assertString(value.scopeId, "session scopeId", 128);
  assertString(value.sessionId, "sessionId", 128);
  assertString(value.displayName, "session displayName", 128);
  if (scopeId !== undefined && value.scopeId !== scopeId) {
    throw new RelayV2MaterializedStateError("INTERNAL", "Session belongs to another scope");
  }
  if (value.kind !== "worktree" && value.kind !== "terminal") {
    throw new RelayV2MaterializedStateError("INTERNAL", "invalid materialized Session kind");
  }
  if (value.state !== "running" || typeof value.attached !== "boolean") {
    throw new RelayV2MaterializedStateError("INTERNAL", "invalid materialized Session state");
  }
  assertSafeInteger(value.windowCount, "Session windowCount");
  assertSafeInteger(value.createdAtMs, "Session createdAtMs");
  assertSafeInteger(value.activityAtMs, "Session activityAtMs");
  for (const [name, fieldValue, maxBytes] of [
    ["project", value.project, 128],
    ["label", value.label, 128],
    ["cwd", value.cwd, 4_096],
  ] as const) {
    if (fieldValue !== null) assertString(fieldValue, `Session ${name}`, maxBytes);
  }
  if (value.kind === "worktree" && (value.project === null || value.cwd === null)) {
    throw new RelayV2MaterializedStateError("INTERNAL", "worktree Session is incomplete");
  }
  if (value.kind === "terminal" && (value.label === null || value.cwd === null)) {
    throw new RelayV2MaterializedStateError("INTERNAL", "terminal Session is incomplete");
  }
}

function validateDiscoveryError(value: unknown): asserts value is RelayV2DiscoveryError {
  if (!isRecord(value)) {
    throw new RelayV2MaterializedStateError("INTERNAL", "invalid discovery error");
  }
  const keys = Object.hasOwn(value, "retryAfterMs")
    ? ["code", "message", "retryable", "commandDisposition", "retryAfterMs"]
    : ["code", "message", "retryable", "commandDisposition"];
  if (!exactKeys(value, keys)) {
    throw new RelayV2MaterializedStateError("INTERNAL", "invalid discovery error shape");
  }
  assertString(value.code, "discovery error code", 128);
  assertString(value.message, "discovery error message", 4_096);
  if (typeof value.retryable !== "boolean" || value.commandDisposition !== "not_applicable") {
    throw new RelayV2MaterializedStateError("INTERNAL", "invalid discovery error fields");
  }
  if (Object.hasOwn(value, "retryAfterMs") && value.retryAfterMs !== null) {
    assertSafeInteger(value.retryAfterMs, "discovery retryAfterMs");
  }
  try {
    encodeRelayV2WebSocketFrame("public", {
      protocolVersion: 2,
      kind: "response",
      type: "sessions.snapshot",
      requestId: "validation",
      hostId: "validation",
      hostEpoch: "validation",
      payload: {
        coverageComplete: false,
        throughEventSeq: null,
        scopes: [{
          scopeId: "validation",
          revision: "0",
          completeness: "partial",
          items: [],
          error: value,
        }],
      },
    } as RelayV2JsonObject);
  } catch {
    throw new RelayV2MaterializedStateError("INTERNAL", "discovery error violates v2 schema");
  }
}

function normalizeDiscoveredSession(
  session: RelayV2DiscoveredSession,
): RelayV2DiscoveredSession {
  assertString(session.backendIdentity, "discovered session backend identity", 4_096);
  validateSession({
    scopeId: "validation",
    sessionId: "validation",
    kind: session.kind,
    displayName: session.displayName,
    state: session.state,
    project: session.project,
    label: session.label,
    cwd: session.cwd,
    attached: session.attached,
    windowCount: session.windowCount,
    createdAtMs: session.createdAtMs,
    activityAtMs: session.activityAtMs,
  }, "validation");
  if (session.reservationCorrelation !== undefined
    && session.reservationCorrelation !== null) {
    parseDiscoveredReservationCorrelation(session.reservationCorrelation);
  }
  return clone(session);
}

function reservationItem(
  scopeId: string,
  sessionId: string,
  session: RelayV2ProspectiveSession,
): RelayV2Session {
  const item = {
    scopeId,
    sessionId,
    kind: session.kind,
    displayName: session.displayName,
    state: session.state,
    project: session.project,
    label: session.label,
    cwd: session.cwd,
    attached: session.attached,
    windowCount: session.windowCount,
    createdAtMs: session.createdAtMs,
    activityAtMs: session.activityAtMs,
  };
  validateSession(item, scopeId);
  return clone(item);
}

function canonicalSessionRecordBytes(scopeId: string, item: RelayV2Session): number {
  return Buffer.byteLength(canonicalJson({ recordType: "session", scopeId, item }), "utf8");
}

function normalizeReservationPlan(
  value: RelayV2HostJson,
  scopeId: string,
  operation: "create_terminal" | "create_worktree",
): RelayV2ResourceReservationPlan {
  if (!isRecord(value) || !exactKeys(value, ["logicalTarget", "session"])) {
    throw new RelayV2MaterializedStateError("INVALID_ARGUMENT", "resource reservation plan is invalid");
  }
  if (!isRecord(value.session) || !exactKeys(value.session, [
    "kind", "displayName", "state", "project", "label", "cwd", "attached",
    "windowCount", "createdAtMs", "activityAtMs",
  ])) {
    throw new RelayV2MaterializedStateError("INVALID_ARGUMENT", "planned Session is invalid");
  }
  const plan = value as unknown as RelayV2ResourceReservationPlan;
  if (!isRecord(plan.logicalTarget)
    || Buffer.byteLength(canonicalJson(plan.logicalTarget), "utf8") > 16_384) {
    throw new RelayV2MaterializedStateError("INVALID_ARGUMENT", "logical create target is invalid");
  }
  const item = reservationItem(scopeId, "ses_00000000000000000000000000000000", plan.session);
  if (
    (operation === "create_terminal" && item.kind !== "terminal")
    || (operation === "create_worktree" && item.kind !== "worktree")
  ) {
    throw new RelayV2MaterializedStateError("INVALID_ARGUMENT", "create plan Session kind is invalid");
  }
  return clone(plan);
}

function parseMaterializedState(snapshot: RelayV2HostStateSnapshot): PersistedMaterializedState {
  const raw = snapshot.materialized[MATERIALIZED_STATE_KEY];
  if (raw === undefined) return clone(EMPTY_STATE);
  if (!isRecord(raw) || !exactKeys(raw, [
    "version", "generation", "aggregateAuthorityEstablished", "aggregateCoverage",
    "usedScopeIds", "usedSessionIds", "scopes", "capacityReservations",
    "negativeSettlements",
  ])) {
    throw new RelayV2MaterializedStateError("INTERNAL", "materialized resource root is malformed");
  }
  if (
    raw.version !== MATERIALIZED_STATE_VERSION
    || typeof raw.generation !== "string"
    || !/^(?:0|[1-9][0-9]*)$/.test(raw.generation)
    || typeof raw.aggregateAuthorityEstablished !== "boolean"
    || (raw.aggregateCoverage !== "complete" && raw.aggregateCoverage !== "partial")
    || !Array.isArray(raw.usedScopeIds)
    || !Array.isArray(raw.usedSessionIds)
    || !Array.isArray(raw.scopes)
    || !Array.isArray(raw.capacityReservations)
    || !Array.isArray(raw.negativeSettlements)
  ) {
    throw new RelayV2MaterializedStateError("INTERNAL", "materialized resource fields are malformed");
  }
  if (raw.aggregateCoverage === "complete" && !raw.aggregateAuthorityEstablished) {
    throw new RelayV2MaterializedStateError(
      "INTERNAL",
      "complete aggregate coverage lacks established authority",
    );
  }
  const usedScopeIds = new Set<string>();
  for (const scopeId of raw.usedScopeIds) {
    if (typeof scopeId !== "string" || !/^scope_[0-9a-f]{32}$/.test(scopeId)
      || usedScopeIds.has(scopeId)) {
      throw new RelayV2MaterializedStateError("INTERNAL", "used scope ID authority is malformed");
    }
    usedScopeIds.add(scopeId);
  }
  const usedSessionIds = new Set<string>();
  for (const sessionId of raw.usedSessionIds) {
    if (typeof sessionId !== "string" || !/^ses_[0-9a-f]{32}$/.test(sessionId)
      || usedSessionIds.has(sessionId)) {
      throw new RelayV2MaterializedStateError("INTERNAL", "used Session ID authority is malformed");
    }
    usedSessionIds.add(sessionId);
  }
  const scopeIds = new Set<string>();
  const liveSessionIds = new Set<string>();
  const scopeBackends = new Set<string>();
  const reservationIds = new Set<string>();
  const reservationCommandTuples = new Set<string>();
  const boundBackendAuthorityKeys = new Set<string>();
  for (const scope of raw.scopes) {
    if (!isRecord(scope) || !exactKeys(scope, [
      "backendIdentity", "item", "sessionsCompleteness",
      "sessionsAuthorityEstablished", "sessionsError", "sessions",
    ])) {
      throw new RelayV2MaterializedStateError("INTERNAL", "materialized scope is malformed");
    }
    assertString(scope.backendIdentity, "scope backend identity", 4_096);
    validateScope(scope.item);
    if (!usedScopeIds.has(scope.item.scopeId)
      || scopeIds.has(scope.item.scopeId)
      || scopeBackends.has(scope.backendIdentity)) {
      throw new RelayV2MaterializedStateError("INTERNAL", "materialized scope identity is duplicated");
    }
    scopeIds.add(scope.item.scopeId);
    scopeBackends.add(scope.backendIdentity);
    if (scope.sessionsCompleteness !== "complete" && scope.sessionsCompleteness !== "partial") {
      throw new RelayV2MaterializedStateError("INTERNAL", "sessions completeness is malformed");
    }
    if (typeof scope.sessionsAuthorityEstablished !== "boolean") {
      throw new RelayV2MaterializedStateError("INTERNAL", "sessions authority marker is malformed");
    }
    if (scope.sessionsCompleteness === "complete") {
      if (scope.sessionsError !== null || !scope.sessionsAuthorityEstablished) {
        throw new RelayV2MaterializedStateError("INTERNAL", "complete scope lacks authority");
      }
    } else {
      validateDiscoveryError(scope.sessionsError);
    }
    if (!Array.isArray(scope.sessions)) {
      throw new RelayV2MaterializedStateError("INTERNAL", "materialized sessions are malformed");
    }
    const sessionBackends = new Set<string>();
    for (const session of scope.sessions) {
      if (!isRecord(session) || !exactKeys(session, ["backendIdentity", "item", "originReservation"])) {
        throw new RelayV2MaterializedStateError("INTERNAL", "materialized session is malformed");
      }
      assertString(session.backendIdentity, "session backend identity", 4_096);
      validateSession(session.item, scope.item.scopeId);
      if (session.originReservation !== null) {
        const origin = parseReservationIdentity(session.originReservation);
        const commandTuple = canonicalReservationTuple(origin);
        if (origin.hostEpoch !== snapshot.hostEpoch
          || reservationIds.has(origin.reservationId)
          || reservationCommandTuples.has(commandTuple)) {
          throw new RelayV2MaterializedStateError(
            "INTERNAL",
            "mapped reservation origin crossed lineage or command authority",
          );
        }
        reservationIds.add(origin.reservationId);
        reservationCommandTuples.add(commandTuple);
        const mappedBackendAuthority = sessionBackendAuthorityKey(
          snapshot.hostEpoch,
          scope.item.scopeId,
          session.item.kind,
          session.backendIdentity,
        );
        if (boundBackendAuthorityKeys.has(mappedBackendAuthority)) {
          throw new RelayV2MaterializedStateError(
            "INTERNAL",
            "mapped backend authority is duplicated",
          );
        }
        boundBackendAuthorityKeys.add(mappedBackendAuthority);
      }
      const backendKey = sessionBackendAuthorityKey(
        snapshot.hostEpoch,
        scope.item.scopeId,
        session.item.kind,
        session.backendIdentity,
      );
      if (!usedSessionIds.has(session.item.sessionId)
        || liveSessionIds.has(session.item.sessionId)
        || sessionBackends.has(backendKey)) {
        throw new RelayV2MaterializedStateError("INTERNAL", "materialized session identity is duplicated");
      }
      liveSessionIds.add(session.item.sessionId);
      sessionBackends.add(backendKey);
    }
  }
  const reservedSessionIds = new Set<string>();
  const reservedLogicalTargets = new Set<string>();
  for (const reservation of raw.capacityReservations) {
    if (!isRecord(reservation) || !exactKeys(reservation, [
      "reservationId", "hostEpoch", "principalId", "hostId", "commandId",
      "requestFingerprint", "operation", "scopeId", "logicalTarget", "reservedSessionId",
      "plannedSession", "boundBackendIdentity", "uncertain",
      "reservedRecords", "reservedCanonicalBytes",
    ])) {
      throw new RelayV2MaterializedStateError("INTERNAL", "capacity reservation is malformed");
    }
    assertString(reservation.reservationId, "capacity reservation ID", 128);
    assertString(reservation.hostEpoch, "capacity reservation hostEpoch", 128);
    assertString(reservation.principalId, "capacity reservation principalId", 128);
    assertString(reservation.hostId, "capacity reservation hostId", 128);
    assertString(reservation.commandId, "capacity reservation commandId", 128);
    assertString(reservation.scopeId, "capacity reservation scope ID", 128);
    assertString(reservation.reservedSessionId, "reserved Session ID", 128);
    if (!isRecord(reservation.logicalTarget)
      || Buffer.byteLength(canonicalJson(reservation.logicalTarget), "utf8") > 16_384) {
      throw new RelayV2MaterializedStateError("INTERNAL", "reserved logical target is malformed");
    }
    if (reservation.boundBackendIdentity !== null) {
      assertString(reservation.boundBackendIdentity, "bound backend identity", 4_096);
    }
    parseRequestFingerprint(reservation.requestFingerprint);
    const plannedItem = reservationItem(
      reservation.scopeId,
      "ses_00000000000000000000000000000000",
      reservation.plannedSession as RelayV2ProspectiveSession,
    );
    if (
      reservation.hostEpoch !== snapshot.hostEpoch
      || (reservation.operation !== "create_worktree" && reservation.operation !== "create_terminal")
      || (reservation.operation === "create_worktree" && plannedItem.kind !== "worktree")
      || (reservation.operation === "create_terminal" && plannedItem.kind !== "terminal")
      || typeof reservation.uncertain !== "boolean"
      || reservation.reservedRecords !== 1
      || !Number.isSafeInteger(reservation.reservedCanonicalBytes)
      || (reservation.reservedCanonicalBytes as number) <= 0
      || canonicalSessionRecordBytes(reservation.scopeId, plannedItem)
        > (reservation.reservedCanonicalBytes as number)
    ) {
      throw new RelayV2MaterializedStateError("INTERNAL", "capacity reservation charge is invalid");
    }
    const commandTuple = canonicalReservationTuple({
      hostEpoch: reservation.hostEpoch as string,
      principalId: reservation.principalId as string,
      hostId: reservation.hostId as string,
      commandId: reservation.commandId as string,
    });
    const logicalTargetKey = `${reservation.scopeId}\0${canonicalJson(reservation.logicalTarget)}`;
    const boundBackendAuthorityKey = reservation.boundBackendIdentity === null
      ? null
      : sessionBackendAuthorityKey(
          snapshot.hostEpoch,
          reservation.scopeId,
          plannedItem.kind,
          reservation.boundBackendIdentity,
        );
    if (
      !scopeIds.has(reservation.scopeId)
      || reservationIds.has(reservation.reservationId)
      || reservationCommandTuples.has(commandTuple)
      || reservedSessionIds.has(reservation.reservedSessionId)
      || liveSessionIds.has(reservation.reservedSessionId)
      || !usedSessionIds.has(reservation.reservedSessionId)
      || reservedLogicalTargets.has(logicalTargetKey)
      || (boundBackendAuthorityKey !== null
        && boundBackendAuthorityKeys.has(boundBackendAuthorityKey))
    ) {
      throw new RelayV2MaterializedStateError("INTERNAL", "capacity reservation binding is invalid");
    }
    reservationIds.add(reservation.reservationId);
    reservationCommandTuples.add(commandTuple);
    reservedSessionIds.add(reservation.reservedSessionId);
    reservedLogicalTargets.add(logicalTargetKey);
    if (boundBackendAuthorityKey !== null) {
      boundBackendAuthorityKeys.add(boundBackendAuthorityKey);
    }
  }
  for (const settlement of raw.negativeSettlements) {
    if (!isRecord(settlement) || !exactKeys(settlement, [
      "reservationId", "hostEpoch", "principalId", "hostId", "commandId",
      "requestFingerprint", "operation", "scopeId", "backendKind",
    ])) {
      throw new RelayV2MaterializedStateError("INTERNAL", "negative settlement is malformed");
    }
    const identity = parseReservationIdentity({
      reservationId: settlement.reservationId,
      hostEpoch: settlement.hostEpoch,
      principalId: settlement.principalId,
      hostId: settlement.hostId,
      commandId: settlement.commandId,
      requestFingerprint: settlement.requestFingerprint,
    });
    assertString(settlement.scopeId, "negative settlement scope ID", 128);
    if ((settlement.operation !== "create_worktree"
        && settlement.operation !== "create_terminal")
      || (settlement.backendKind !== "worktree" && settlement.backendKind !== "terminal")
      || settlement.backendKind !== (settlement.operation === "create_worktree"
        ? "worktree"
        : "terminal")) {
      throw new RelayV2MaterializedStateError("INTERNAL", "negative settlement kind is invalid");
    }
    const commandTuple = canonicalReservationTuple(identity);
    if (identity.hostEpoch !== snapshot.hostEpoch
      || !usedScopeIds.has(settlement.scopeId)
      || reservationIds.has(identity.reservationId)
      || reservationCommandTuples.has(commandTuple)) {
      throw new RelayV2MaterializedStateError(
        "INTERNAL",
        "negative settlement crossed reservation authority",
      );
    }
    reservationIds.add(identity.reservationId);
    reservationCommandTuples.add(commandTuple);
  }
  return clone(raw) as unknown as PersistedMaterializedState;
}

function hasWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** RFC-8785/JCS-equivalent for the H2 JSON domain. */
export function canonicalizeRelayV2MaterializedJson(value: unknown): string {
  const seen = new Set<object>();
  const visit = (item: unknown): string => {
    if (item === null || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "string") {
      if (!hasWellFormedUnicode(item)) {
        throw new RelayV2MaterializedStateError("INTERNAL", "materialized string has invalid Unicode");
      }
      return JSON.stringify(item);
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        throw new RelayV2MaterializedStateError("INTERNAL", "non-finite materialized number");
      }
      return JSON.stringify(item);
    }
    if (typeof item !== "object") {
      throw new RelayV2MaterializedStateError("INTERNAL", "non-JSON materialized value");
    }
    if (seen.has(item)) {
      throw new RelayV2MaterializedStateError("INTERNAL", "cyclic materialized value");
    }
    seen.add(item);
    let canonical: string;
    if (Array.isArray(item)) {
      canonical = `[${item.map((entry) => visit(entry)).join(",")}]`;
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new RelayV2MaterializedStateError("INTERNAL", "non-plain materialized object");
      }
      const record = item as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      for (const key of keys) {
        if (!hasWellFormedUnicode(key)) {
          throw new RelayV2MaterializedStateError("INTERNAL", "materialized key has invalid Unicode");
        }
      }
      canonical = `{${keys.map((key) => (
        `${JSON.stringify(key)}:${visit(record[key])}`
      )).join(",")}}`;
    }
    seen.delete(item);
    return canonical;
  };
  return visit(value);
}

const canonicalJson = canonicalizeRelayV2MaterializedJson;

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalResolverResourceMappingDigest(
  hostEpoch: string,
  state: PersistedMaterializedState,
): string {
  const digest = createHash("sha256").update(canonicalJson({
    hostEpoch,
    aggregateAuthorityEstablished: state.aggregateAuthorityEstablished,
    aggregateCoverage: state.aggregateCoverage,
    scopes: state.scopes,
  }), "utf8").digest("base64url");
  return `twrmap1.${digest}`;
}

function parseRequestFingerprint(value: unknown): RelayV2CommandRequestFingerprint {
  if (!isRecord(value)
    || !exactKeys(value, ["schemaVersion", "algorithm", "digest"])
    || value.schemaVersion !== 1
    || value.algorithm !== "sha256-rfc8785"
    || typeof value.digest !== "string"
    || !/^[0-9a-f]{64}$/.test(value.digest)) {
    throw new RelayV2MaterializedStateError("INTERNAL", "reservation fingerprint is malformed");
  }
  return clone(value) as unknown as RelayV2CommandRequestFingerprint;
}

function parseReservationBinding(
  value: unknown,
): RelayV2CommandResourceReservationBinding {
  if (!isRecord(value)
    || !exactKeys(value, ["schemaVersion", "owner", "reservationId"])
    || value.schemaVersion !== 1
    || value.owner !== "relay_v2_resource_state") {
    throw new RelayV2MaterializedStateError("INTERNAL", "reservation binding is malformed");
  }
  assertString(value.reservationId, "reservation binding ID", 128);
  return clone(value) as unknown as RelayV2CommandResourceReservationBinding;
}

function parseReservationIdentity(value: unknown): PersistedReservationIdentity {
  if (!isRecord(value) || !exactKeys(value, [
    "reservationId", "hostEpoch", "principalId", "hostId", "commandId", "requestFingerprint",
  ])) {
    throw new RelayV2MaterializedStateError("INTERNAL", "Session reservation origin is malformed");
  }
  for (const field of ["reservationId", "hostEpoch", "principalId", "hostId", "commandId"] as const) {
    assertString(value[field], `reservation origin ${field}`, 128);
  }
  parseRequestFingerprint(value.requestFingerprint);
  return clone(value) as unknown as PersistedReservationIdentity;
}

function parseDiscoveredReservationCorrelation(
  value: unknown,
): RelayV2DiscoveredReservationCorrelation {
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion", "reservationId", "hostEpoch", "principalId", "hostId", "commandId",
    "requestFingerprint",
  ]) || value.schemaVersion !== 1) {
    throw new RelayV2MaterializedStateError("INTERNAL", "discovery reservation correlation is malformed");
  }
  const identity = parseReservationIdentity({
    reservationId: value.reservationId,
    hostEpoch: value.hostEpoch,
    principalId: value.principalId,
    hostId: value.hostId,
    commandId: value.commandId,
    requestFingerprint: value.requestFingerprint,
  });
  return { schemaVersion: 1, ...identity };
}

function canonicalReservationCommandKey(identity: Omit<PersistedReservationIdentity, "reservationId">): string {
  return canonicalJson({
    hostEpoch: identity.hostEpoch,
    principalId: identity.principalId,
    hostId: identity.hostId,
    commandId: identity.commandId,
    requestFingerprint: identity.requestFingerprint,
  });
}

function canonicalReservationTuple(identity: {
  hostEpoch: string;
  principalId: string;
  hostId: string;
  commandId: string;
}): string {
  return canonicalJson({
    hostEpoch: identity.hostEpoch,
    principalId: identity.principalId,
    hostId: identity.hostId,
    commandId: identity.commandId,
  });
}

function sameReservationIdentity(
  left: PersistedReservationIdentity,
  right: PersistedReservationIdentity,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function reservationIdentity(
  reservation: PersistedCapacityReservation,
): PersistedReservationIdentity {
  return {
    reservationId: reservation.reservationId,
    hostEpoch: reservation.hostEpoch,
    principalId: reservation.principalId,
    hostId: reservation.hostId,
    commandId: reservation.commandId,
    requestFingerprint: clone(reservation.requestFingerprint),
  };
}

function negativeSettlementFor(
  reservation: PersistedCapacityReservation,
): PersistedNegativeSettlement {
  return {
    ...reservationIdentity(reservation),
    operation: reservation.operation,
    scopeId: reservation.scopeId,
    backendKind: reservation.plannedSession.kind,
  };
}

function appendNegativeSettlement(
  state: PersistedMaterializedState,
  reservation: PersistedCapacityReservation,
): void {
  const settlement = negativeSettlementFor(reservation);
  const existing = state.negativeSettlements.find((candidate) => (
    candidate.reservationId === settlement.reservationId
  ));
  if (existing !== undefined) {
    if (!sameJson(existing, settlement)) {
      throw new RelayV2MaterializedStateError(
        "INTERNAL",
        "negative settlement replay crossed reservation authority",
      );
    }
    return;
  }
  state.negativeSettlements.push(settlement);
}

function reservationIdentityFromCorrelation(
  correlation: RelayV2DiscoveredReservationCorrelation,
): PersistedReservationIdentity {
  return {
    reservationId: correlation.reservationId,
    hostEpoch: correlation.hostEpoch,
    principalId: correlation.principalId,
    hostId: correlation.hostId,
    commandId: correlation.commandId,
    requestFingerprint: clone(correlation.requestFingerprint),
  };
}

function reservationIdentityFromIntent(
  intent: RelayV2CommandResourceReservationIntent | RelayV2CommandResourceCommitIntent
    | RelayV2CommandResourceSettlementIntent,
  reservationId: string,
): PersistedReservationIdentity {
  return {
    reservationId,
    hostEpoch: intent.hostEpoch,
    principalId: intent.principalId,
    hostId: intent.hostId,
    commandId: intent.commandId,
    requestFingerprint: parseRequestFingerprint(intent.requestFingerprint),
  };
}

function validateResourceIntentIdentity(
  intent: RelayV2CommandResourceReservationIntent | RelayV2CommandResourceCommitIntent
    | RelayV2CommandResourceSettlementIntent,
  hostId: string,
): void {
  if (intent.schemaVersion !== 1 || intent.owner !== "relay_v2_resource_state") {
    throw new RelayV2MaterializedStateError("INTERNAL", "resource mutation intent is malformed");
  }
  for (const [label, value] of [
    ["principalId", intent.principalId],
    ["hostId", intent.hostId],
    ["hostEpoch", intent.hostEpoch],
    ["commandId", intent.commandId],
    ["scopeId", intent.scopeId],
  ] as const) validateOpaqueInput(value, label);
  parseRequestFingerprint(intent.requestFingerprint);
  if (intent.hostId !== hostId) {
    throw new RelayV2MaterializedStateError("INVALID_ARGUMENT", "resource mutation targets another host");
  }
}

function materializedSnapshotForTransaction(
  transaction: Pick<
    RelayV2CommandResourceTransaction,
    "getMaterializedRecord" | "getMaterializedReadinessFence"
  >,
  hostEpoch: string,
): RelayV2HostStateSnapshot {
  const materialized: Record<string, RelayV2HostJson> = {};
  const current = transaction.getMaterializedRecord(MATERIALIZED_STATE_KEY);
  if (current !== undefined) materialized[MATERIALIZED_STATE_KEY] = current;
  return {
    hostEpoch,
    hostInstanceId: "h2-resource-transaction",
    commitSeq: "0",
    eventSeq: "0",
    revisions: {},
    commands: {},
    materialized,
    materializedReadinessFence: transaction.getMaterializedReadinessFence(),
  };
}

function putMaterializedState(
  transaction: Pick<RelayV2CommandResourceTransaction, "putMaterializedRecord">,
  hostEpoch: string,
  state: PersistedMaterializedState,
): void {
  parseMaterializedState({
    hostEpoch,
    hostInstanceId: "h2-resource-write-validation",
    commitSeq: "0",
    eventSeq: "0",
    revisions: {},
    commands: {},
    materialized: { [MATERIALIZED_STATE_KEY]: state as unknown as RelayV2HostJson },
    materializedReadinessFence: null,
  });
  transaction.putMaterializedRecord(
    MATERIALIZED_STATE_KEY,
    state as unknown as RelayV2HostJson,
  );
}

function revisionsForTransaction(
  transaction: RelayV2CommandResourceTransaction,
  state: PersistedMaterializedState,
): Record<string, string> {
  const revisions: Record<string, string> = {
    [SCOPES_REVISION_KEY]: transaction.getRevision(SCOPES_REVISION_KEY) ?? "0",
  };
  for (const scope of state.scopes) {
    revisions[sessionRevisionKey(scope.item.scopeId)] =
      transaction.getRevision(sessionRevisionKey(scope.item.scopeId)) ?? "0";
  }
  return revisions;
}

function rejection(
  code: "BUSY" | "CAPABILITY_UNAVAILABLE" | "INVALID_ARGUMENT",
  message: string,
): RelayV2CommandResourceReservationResult {
  return {
    kind: "rejected",
    error: {
      code,
      message,
      retryable: code !== "INVALID_ARGUMENT",
      commandDisposition: "not_accepted",
      details: null,
    },
  };
}

function discoveredSessionFromBackendOutcome(
  outcome: RelayV2CanonicalBackendOutcome,
): RelayV2DiscoveredSession {
  if (outcome.schemaVersion !== 1
    || typeof outcome.backendInstanceKey !== "string"
    || !isRecord(outcome.evidence)
    || !exactKeys(outcome.evidence, ["session"])
    || !isRecord(outcome.evidence.session)
    || !exactKeys(outcome.evidence.session, [
      "kind", "displayName", "state", "project", "label", "cwd", "attached",
      "windowCount", "createdAtMs", "activityAtMs",
    ])) {
    throw new RelayV2MaterializedStateError("INTERNAL", "canonical backend Session evidence is malformed");
  }
  return normalizeDiscoveredSession({
    backendIdentity: outcome.backendInstanceKey,
    ...(clone(outcome.evidence.session) as unknown as RelayV2ProspectiveSession),
  });
}

function sessionRevisionKey(scopeId: string): string {
  return `${SESSIONS_REVISION_PREFIX}${scopeId}`;
}

function revisionFor(snapshot: RelayV2HostStateSnapshot, key: string): string {
  return snapshot.revisions[key] ?? "0";
}

function normalizeResolverProcessTarget(
  value: unknown,
): RelayV2ResourceResolverProcessTarget {
  if (!isRecord(value)
    || !exactKeys(value, ["kind", "targetId"])
    || (value.kind !== "local" && value.kind !== "ssh")) {
    throw new RelayV2MaterializedStateError("INTERNAL", "resolver process target is malformed");
  }
  assertString(value.targetId, "resolver process target ID", 128);
  return { kind: value.kind, targetId: value.targetId };
}

function normalizeResolverCapabilities(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new RelayV2MaterializedStateError("INTERNAL", "resolver capabilities are malformed");
  }
  const capabilities = value.map((capability) => {
    assertString(capability, "resolver capability", 128);
    return capability;
  });
  if (new Set(capabilities).size !== capabilities.length) {
    throw new RelayV2MaterializedStateError("INTERNAL", "resolver capabilities are duplicated");
  }
  return capabilities;
}

function resolverEvidenceSessionKey(
  scopeBackendIdentity: string,
  backendKind: RelayV2Session["kind"],
  sessionBackendIdentity: string,
): string {
  return canonicalJson({ scopeBackendIdentity, backendKind, sessionBackendIdentity });
}

function normalizeResolverDiscoveryCut(
  value: unknown,
  scopes: readonly RelayV2DiscoveredScope[],
): RelayV2ResourceResolverDiscoveryCut {
  if (!isRecord(value)
    || !exactKeys(value, ["generation", "scopeTargets", "sessionTargets", "isCurrent"])
    || !Array.isArray(value.scopeTargets)
    || !Array.isArray(value.sessionTargets)
    || typeof value.isCurrent !== "function") {
    throw new RelayV2MaterializedStateError("INTERNAL", "resolver discovery cut is malformed");
  }
  assertString(value.generation, "resolver discovery generation", 128);
  const discoveredScopes = new Map(scopes.map((scope) => [scope.backendIdentity, scope]));
  const scopeKeys = new Set<string>();
  const scopeTargets = value.scopeTargets.map((raw) => {
    if (!isRecord(raw)
      || !exactKeys(raw, ["scopeBackendIdentity", "processTarget", "capabilities"])) {
      throw new RelayV2MaterializedStateError("INTERNAL", "resolver Scope evidence is malformed");
    }
    assertString(raw.scopeBackendIdentity, "resolver Scope backend identity", 4_096);
    const discovered = discoveredScopes.get(raw.scopeBackendIdentity);
    const processTarget = normalizeResolverProcessTarget(raw.processTarget);
    if (!discovered || discovered.kind !== processTarget.kind
      || scopeKeys.has(raw.scopeBackendIdentity)) {
      throw new RelayV2MaterializedStateError("INTERNAL", "resolver Scope evidence crossed authority");
    }
    scopeKeys.add(raw.scopeBackendIdentity);
    return {
      scopeBackendIdentity: raw.scopeBackendIdentity,
      processTarget,
      capabilities: normalizeResolverCapabilities(raw.capabilities),
    };
  });
  const discoveredSessions = new Set(scopes.flatMap((scope) => (
    scope.sessions.map((session) => resolverEvidenceSessionKey(
      scope.backendIdentity,
      session.kind,
      session.backendIdentity,
    ))
  )));
  const sessionKeys = new Set<string>();
  const sessionTargets = value.sessionTargets.map((raw) => {
    if (!isRecord(raw)
      || !exactKeys(raw, [
        "scopeBackendIdentity", "sessionBackendIdentity", "backendKind",
        "processTarget", "capabilities", "managedTarget",
      ])
      || (raw.backendKind !== "worktree" && raw.backendKind !== "terminal")
      || !isRecord(raw.managedTarget)
      || !exactKeys(raw.managedTarget, ["name", "kind", "incarnation"])
      || raw.managedTarget.kind !== raw.backendKind) {
      throw new RelayV2MaterializedStateError("INTERNAL", "resolver Session evidence is malformed");
    }
    assertString(raw.scopeBackendIdentity, "resolver Session Scope backend identity", 4_096);
    assertString(raw.sessionBackendIdentity, "resolver Session backend identity", 4_096);
    assertString(raw.managedTarget.name, "resolver managed Session name", 128);
    assertString(raw.managedTarget.incarnation, "resolver managed Session incarnation", 128);
    const key = resolverEvidenceSessionKey(
      raw.scopeBackendIdentity,
      raw.backendKind,
      raw.sessionBackendIdentity,
    );
    const processTarget = normalizeResolverProcessTarget(raw.processTarget);
    const scopeTarget = scopeTargets.find((candidate) => (
      candidate.scopeBackendIdentity === raw.scopeBackendIdentity
    ));
    if (!discoveredSessions.has(key)
      || sessionKeys.has(key)
      || scopeTarget === undefined
      || !sameJson(scopeTarget.processTarget, processTarget)) {
      throw new RelayV2MaterializedStateError("INTERNAL", "resolver Session evidence crossed authority");
    }
    sessionKeys.add(key);
    const capabilities = normalizeResolverCapabilities(raw.capabilities);
    if (!sameJson(scopeTarget.capabilities, capabilities)) {
      throw new RelayV2MaterializedStateError("INTERNAL", "resolver capabilities crossed Scope authority");
    }
    let expectedBackendIdentity: string;
    try {
      expectedBackendIdentity = issueRelayV2CanonicalBackendInstanceKey({
        processTarget,
        incarnation: raw.managedTarget.incarnation,
      });
    } catch {
      throw new RelayV2MaterializedStateError(
        "INTERNAL",
        "resolver managed Session incarnation is invalid",
      );
    }
    if (expectedBackendIdentity !== raw.sessionBackendIdentity) {
      throw new RelayV2MaterializedStateError(
        "INTERNAL",
        "resolver managed Session incarnation crossed backend authority",
      );
    }
    return {
      scopeBackendIdentity: raw.scopeBackendIdentity,
      sessionBackendIdentity: raw.sessionBackendIdentity,
      backendKind: raw.backendKind,
      processTarget,
      capabilities,
      managedTarget: {
        name: raw.managedTarget.name,
        kind: raw.managedTarget.kind,
        incarnation: raw.managedTarget.incarnation,
      },
    };
  });
  return {
    generation: value.generation,
    scopeTargets,
    sessionTargets,
    isCurrent: () => (value.isCurrent as () => unknown)() === true,
  };
}

function normalizeScan(scan: RelayV2ResourceDiscoveryScan): RelayV2ResourceDiscoveryScan {
  if (!scan || (scan.coverage !== "complete" && scan.coverage !== "partial") || !Array.isArray(scan.scopes)) {
    throw new RelayV2MaterializedStateError("INTERNAL", "discovery returned an invalid scan");
  }
  const scopeBackends = new Set<string>();
  const correlationIds = new Set<string>();
  const scopes = scan.scopes.map((scope) => {
    assertString(scope.backendIdentity, "discovered scope backend identity", 4_096);
    if (scopeBackends.has(scope.backendIdentity)) {
      throw new RelayV2MaterializedStateError("INTERNAL", "discovery returned duplicate scopes");
    }
    scopeBackends.add(scope.backendIdentity);
    validateScope({
      scopeId: "validation",
      displayName: scope.displayName,
      kind: scope.kind,
      reachability: scope.reachability,
    });
    if (scope.sessionsCompleteness !== "complete" && scope.sessionsCompleteness !== "partial") {
      throw new RelayV2MaterializedStateError("INTERNAL", "discovery completeness is invalid");
    }
    const reservationCorrelationCompleteness =
      scope.reservationCorrelationCompleteness ?? "unavailable";
    if (reservationCorrelationCompleteness !== "complete"
      && reservationCorrelationCompleteness !== "unavailable") {
      throw new RelayV2MaterializedStateError("INTERNAL", "reservation correlation coverage is invalid");
    }
    if (scope.sessionsCompleteness === "complete") {
      if (scope.error !== null) {
        throw new RelayV2MaterializedStateError("INTERNAL", "complete discovery has an error");
      }
    } else {
      validateDiscoveryError(scope.error);
    }
    const sessionBackends = new Set<string>();
    const sessions: RelayV2DiscoveredSession[] = scope.sessions.map((
      session: RelayV2DiscoveredSession,
    ) => {
      const normalized = normalizeDiscoveredSession(session);
      const authorityKey = discoveredSessionAuthorityKey(normalized);
      if (sessionBackends.has(authorityKey)) {
        throw new RelayV2MaterializedStateError("INTERNAL", "discovery returned duplicate sessions");
      }
      sessionBackends.add(authorityKey);
      if (normalized.reservationCorrelation) {
        const correlation = parseDiscoveredReservationCorrelation(
          normalized.reservationCorrelation,
        );
        if (correlationIds.has(correlation.reservationId)) {
          throw new RelayV2MaterializedStateError(
            "INTERNAL",
            "discovery duplicated reservation correlation across the scan",
          );
        }
        correlationIds.add(correlation.reservationId);
      }
      return normalized;
    }).sort((left: RelayV2DiscoveredSession, right: RelayV2DiscoveredSession) => (
      utf8Compare(discoveredSessionAuthorityKey(left), discoveredSessionAuthorityKey(right))
    ));
    return { ...clone(scope), reservationCorrelationCompleteness, sessions };
  }).sort((left, right) => utf8Compare(left.backendIdentity, right.backendIdentity));
  const normalized: RelayV2ResourceDiscoveryScan = { coverage: scan.coverage, scopes };
  const resolverCut = scan[RELAY_V2_RESOURCE_RESOLVER_CUT];
  if (resolverCut !== undefined) {
    Object.defineProperty(normalized, RELAY_V2_RESOURCE_RESOLVER_CUT, {
      value: normalizeResolverDiscoveryCut(resolverCut, scopes),
      enumerable: false,
    });
  }
  return normalized;
}

function unreachableDiscoveryError(): RelayV2DiscoveryError {
  return {
    code: "SCOPE_UNREACHABLE",
    message: "SSH scope is unreachable; no complete backend refresh was performed",
    retryable: true,
    commandDisposition: "not_applicable",
  };
}

function stateEvent(
  hostId: string,
  hostEpoch: string,
  scopeId: string,
  eventSeq: string,
  revision: string,
  dimension: "scopes" | "sessions",
  change: Record<string, unknown>,
): RelayV2JsonObject {
  const event = {
    protocolVersion: 2,
    kind: "event",
    type: `${dimension}.changed`,
    hostId,
    hostEpoch,
    scopeId,
    eventSeq,
    payload: {
      dimension,
      resourceKey: dimension === "scopes" ? "scopes" : scopeId,
      resultingRevision: revision,
      change,
    },
  } as RelayV2JsonObject;
  encodeRelayV2WebSocketFrame("public", event);
  return event;
}

function sessionTarget(
  hostEpoch: string,
  scope: PersistedScope,
  session: PersistedSession,
): RelayV2SessionTarget {
  return {
    hostEpoch,
    scopeId: scope.item.scopeId,
    sessionId: session.item.sessionId,
    scopeBackendIdentity: scope.backendIdentity,
    sessionBackendIdentity: session.backendIdentity,
    scopeReachability: scope.item.reachability,
    sessionsCompleteness: scope.sessionsCompleteness,
    sessionsAuthorityEstablished: scope.sessionsAuthorityEstablished,
    item: clone(session.item),
  };
}

class MaterializedMutation {
  readonly state: PersistedMaterializedState;
  readonly changes: PendingChange[] = [];
  readonly #issueOpaqueId: (prefix?: string) => string;
  readonly #usedScopeIds: Set<string>;
  readonly #usedSessionIds: Set<string>;

  constructor(
    readonly hostEpoch: string,
    state: PersistedMaterializedState,
    transaction: Pick<RelayV2CommandResourceTransaction, "issueOpaqueId">,
    private readonly baseRevisions: Record<string, string>,
    private readonly capacity: MaterializedCapacity,
  ) {
    this.state = clone(state);
    this.#issueOpaqueId = (prefix) => transaction.issueOpaqueId(prefix);
    this.#usedScopeIds = new Set(this.state.usedScopeIds);
    this.#usedSessionIds = new Set(this.state.usedSessionIds);
  }

  preflightCapacity(): RelayV2MaterializedCapacityAssessment {
    return capacityAssessment(
      this.state,
      this.baseRevisions,
      this.capacity,
      this.changes,
    );
  }

  resolveSession(scopeId: string, sessionId: string): RelayV2SessionTarget | null {
    const scope = this.state.scopes.find((candidate) => candidate.item.scopeId === scopeId);
    const session = scope?.sessions.find((candidate) => candidate.item.sessionId === sessionId);
    return scope && session ? sessionTarget(this.hostEpoch, scope, session) : null;
  }

  issueScopeId(): string {
    const id = issueUnusedOpaqueId(
      { issueOpaqueId: this.#issueOpaqueId },
      "scope",
      this.#usedScopeIds,
    );
    this.#usedScopeIds.add(id);
    this.state.usedScopeIds.push(id);
    return id;
  }

  issueSessionId(): string {
    const id = issueUnusedOpaqueId(
      { issueOpaqueId: this.#issueOpaqueId },
      "ses",
      this.#usedSessionIds,
    );
    this.#usedSessionIds.add(id);
    this.state.usedSessionIds.push(id);
    return id;
  }

  materializeReservation(
    reservation: PersistedCapacityReservation,
    discovered: RelayV2DiscoveredSession,
  ): RelayV2SessionTarget {
    const reservationIndex = this.state.capacityReservations.findIndex((candidate) => (
      candidate.reservationId === reservation.reservationId
    ));
    if (reservationIndex < 0) {
      throw new RelayV2MaterializedStateError(
        "INVALID_ARGUMENT",
        "capacity reservation is not active in this host lineage",
      );
    }
    const [active] = this.state.capacityReservations.splice(reservationIndex, 1);
    const scope = this.state.scopes.find((candidate) => (
      candidate.item.scopeId === active.scopeId
    ));
    if (!scope) {
      throw new RelayV2MaterializedStateError("SCOPE_NOT_FOUND", "reserved scope is not materialized");
    }
    const normalized = normalizeDiscoveredSession(discovered);
    if (normalized.kind !== active.plannedSession.kind) {
      throw new RelayV2MaterializedStateError("INTERNAL", "executor changed reserved backend kind");
    }
    if (active.boundBackendIdentity !== null
      && normalized.backendIdentity !== active.boundBackendIdentity) {
      throw new RelayV2MaterializedStateError("INTERNAL", "executor returned another backend target");
    }
    const sessionId = active.reservedSessionId;
    const actualItem = reservationItem(
      active.scopeId,
      sessionId,
      normalized,
    );
    if (canonicalSessionRecordBytes(active.scopeId, actualItem) > active.reservedCanonicalBytes) {
      throw new RelayV2MaterializedStateError(
        "INTERNAL",
        "executor exceeded the admitted materialized Session bound",
      );
    }
    const authorityKey = sessionBackendAuthorityKey(
      this.hostEpoch,
      scope.item.scopeId,
      normalized.kind,
      normalized.backendIdentity,
    );
    const collision = scope.sessions.find((session) => sessionBackendAuthorityKey(
      this.hostEpoch,
      scope.item.scopeId,
      session.item.kind,
      session.backendIdentity,
    ) === authorityKey);
    if (collision) {
      if (collision.originReservation !== null) {
        throw new RelayV2MaterializedStateError("INTERNAL", "backend incarnation belongs to another reservation");
      }
      collision.originReservation = reservationIdentity(active);
      return this.upsertNormalizedSession(scope, normalized);
    }
    return this.upsertNormalizedSession(
      scope,
      normalized,
      sessionId,
      reservationIdentity(active),
    );
  }

  updateReservationMapping(
    origin: PersistedReservationIdentity,
    scopeId: string,
    discovered: RelayV2DiscoveredSession,
  ): RelayV2SessionTarget | null {
    const scope = this.state.scopes.find((candidate) => candidate.item.scopeId === scopeId);
    const session = scope?.sessions.find((candidate) => (
      candidate.originReservation !== null
      && sameReservationIdentity(candidate.originReservation, origin)
    ));
    if (!scope || !session) return null;
    const normalized = normalizeDiscoveredSession(discovered);
    if (sessionBackendAuthorityKey(
      this.hostEpoch,
      scopeId,
      normalized.kind,
      normalized.backendIdentity,
    ) !== sessionBackendAuthorityKey(
      this.hostEpoch,
      scopeId,
      session.item.kind,
      session.backendIdentity,
    )) {
      throw new RelayV2MaterializedStateError("INTERNAL", "reservation mapping backend changed");
    }
    return this.upsertNormalizedSession(scope, normalized);
  }

  private upsertNormalizedSession(
    scope: PersistedScope,
    normalized: RelayV2DiscoveredSession,
    reservedSessionId?: string,
    originReservation: PersistedReservationIdentity | null = null,
  ): RelayV2SessionTarget {
    const scopeId = scope.item.scopeId;
    let session = scope.sessions.find((candidate) => (
      sessionBackendAuthorityKey(
        this.hostEpoch,
        scopeId,
        candidate.item.kind,
        candidate.backendIdentity,
      ) === sessionBackendAuthorityKey(
        this.hostEpoch,
        scopeId,
        normalized.kind,
        normalized.backendIdentity,
      )
    ));
    const isNew = session === undefined;
    if (!session) {
      session = {
        backendIdentity: normalized.backendIdentity,
        originReservation: originReservation === null ? null : clone(originReservation),
        item: {
          scopeId,
          sessionId: reservedSessionId ?? this.issueSessionId(),
          kind: normalized.kind,
          displayName: normalized.displayName,
          state: normalized.state,
          project: normalized.project,
          label: normalized.label,
          cwd: normalized.cwd,
          attached: normalized.attached,
          windowCount: normalized.windowCount,
          createdAtMs: normalized.createdAtMs,
          activityAtMs: normalized.activityAtMs,
        },
      };
      scope.sessions.push(session);
    }
    const desired: RelayV2Session = {
      scopeId,
      sessionId: session.item.sessionId,
      kind: normalized.kind,
      displayName: normalized.displayName,
      state: normalized.state,
      project: normalized.project,
      label: normalized.label,
      cwd: normalized.cwd,
      attached: normalized.attached,
      windowCount: normalized.windowCount,
      createdAtMs: normalized.createdAtMs,
      activityAtMs: normalized.activityAtMs,
    };
    if (isNew || !sameJson(session.item, desired)) {
      this.changes.push({
        scopeId,
        dimension: "sessions",
        identity: desired.sessionId,
        change: { op: "upsert", item: clone(desired) },
      });
    }
    session.item = desired;
    return sessionTarget(this.hostEpoch, scope, session);
  }

  deleteSession(scopeId: string, sessionId: string): boolean {
    const scope = this.state.scopes.find((candidate) => candidate.item.scopeId === scopeId);
    if (!scope) throw new RelayV2MaterializedStateError("SCOPE_NOT_FOUND", "scope is not materialized");
    const index = scope.sessions.findIndex((candidate) => candidate.item.sessionId === sessionId);
    if (index < 0) return false;
    scope.sessions.splice(index, 1);
    this.changes.push({
      scopeId,
      dimension: "sessions",
      identity: sessionId,
      change: { op: "delete", sessionId },
    });
    return true;
  }
}

function scanAuthorityConflict(
  state: PersistedMaterializedState,
  scan: RelayV2ResourceDiscoveryScan,
  negativeEvidence: readonly RelayV2FencedNegativeEvidence[],
): string | null {
  const activeById = new Map(state.capacityReservations.map((reservation) => (
    [reservation.reservationId, reservation]
  )));
  const mappedById = new Map(state.scopes.flatMap((scope) => (
    scope.sessions.flatMap((session) => session.originReservation === null ? [] : [[
      session.originReservation.reservationId,
      { scope, session, origin: session.originReservation },
    ] as const])
  )));
  const negativeById = new Map(state.negativeSettlements.map((settlement) => (
    [settlement.reservationId, settlement]
  )));
  const negativeEvidenceIds = new Set(negativeEvidence.map((evidence) => evidence.reservationId));
  const scopeByBackend = new Map(state.scopes.map((scope) => [scope.backendIdentity, scope]));
  for (const observedScope of scan.scopes) {
    const materializedScope = scopeByBackend.get(observedScope.backendIdentity);
    for (const discovered of observedScope.sessions) {
      if (discovered.reservationCorrelation === undefined
        || discovered.reservationCorrelation === null) continue;
      const correlation = parseDiscoveredReservationCorrelation(
        discovered.reservationCorrelation,
      );
      if (negativeById.has(correlation.reservationId)) {
        return "positive discovery evidence contradicted a persisted negative settlement";
      }
      if (negativeEvidenceIds.has(correlation.reservationId)) {
        return "positive discovery evidence contradicted canonical negative evidence";
      }
      const active = activeById.get(correlation.reservationId);
      if (active !== undefined) {
        if (!sameReservationIdentity(
          reservationIdentity(active),
          reservationIdentityFromCorrelation(correlation),
        )
          || materializedScope?.item.scopeId !== active.scopeId
          || discovered.kind !== active.plannedSession.kind
          || (active.boundBackendIdentity !== null
            && discovered.backendIdentity !== active.boundBackendIdentity)) {
          return "discovery correlation crossed active reservation authority";
        }
        continue;
      }
      const mapped = mappedById.get(correlation.reservationId);
      if (mapped === undefined) {
        return "discovery carried an unknown reservation correlation";
      }
      if (!sameReservationIdentity(mapped.origin, reservationIdentityFromCorrelation(correlation))
        || materializedScope?.item.scopeId !== mapped.scope.item.scopeId
        || discovered.backendIdentity !== mapped.session.backendIdentity
        || discovered.kind !== mapped.session.item.kind) {
        return "discovery correlation crossed mapped Session authority";
      }
    }
  }
  return null;
}

function applyDiscovery(
  mutation: MaterializedMutation,
  scan: RelayV2ResourceDiscoveryScan,
): void {
  const scopesByBackend = new Map(
    mutation.state.scopes.map((scope) => [scope.backendIdentity, scope]),
  );
  const observedBackends = new Set(scan.scopes.map((scope) => scope.backendIdentity));

  for (const observed of scan.scopes) {
    let scope = scopesByBackend.get(observed.backendIdentity);
    const isNewScope = scope === undefined;
    if (!scope) {
      const established = observed.reachability === "online"
        && observed.sessionsCompleteness === "complete";
      scope = {
        backendIdentity: observed.backendIdentity,
        item: {
          scopeId: mutation.issueScopeId(),
          displayName: observed.displayName,
          kind: observed.kind,
          reachability: observed.reachability,
        },
        sessionsCompleteness: established ? "complete" : "partial",
        sessionsAuthorityEstablished: established,
        sessionsError: established
          ? null
          : clone(observed.error ?? unreachableDiscoveryError()),
        sessions: [],
      };
      scopesByBackend.set(observed.backendIdentity, scope);
    }
    const desiredScope: RelayV2Scope = {
      scopeId: scope.item.scopeId,
      displayName: observed.displayName,
      kind: observed.kind,
      reachability: observed.reachability,
    };
    if (isNewScope || !sameJson(scope.item, desiredScope)) {
      mutation.changes.push({
        scopeId: desiredScope.scopeId,
        dimension: "scopes",
        identity: desiredScope.scopeId,
        change: { op: "upsert", item: clone(desiredScope) },
      });
    }
    const preserveLastKnown = observed.reachability === "unreachable"
      && scope.sessionsAuthorityEstablished;
    const discoveredSessions = preserveLastKnown ? [] : observed.sessions;
    const effectiveCompleteness: RelayV2DiscoveryCompleteness = preserveLastKnown
      ? "complete"
      : observed.reachability === "unreachable"
        ? "partial"
        : observed.sessionsCompleteness;
    const effectiveError = effectiveCompleteness === "complete"
      ? null
      : clone(observed.error ?? unreachableDiscoveryError());
    const authorityKey = (kind: RelayV2Session["kind"], backendInstanceKey: string) => (
      sessionBackendAuthorityKey(
        mutation.hostEpoch,
        desiredScope.scopeId,
        kind,
        backendInstanceKey,
      )
    );
    const sessionsByBackend = new Map(scope.sessions.map((session) => [
      authorityKey(session.item.kind, session.backendIdentity),
      session,
    ]));
    const observedSessions = new Set(discoveredSessions.map((session) => (
      authorityKey(session.kind, session.backendIdentity)
    )));
    const activeReservations = mutation.state.capacityReservations.filter((reservation) => (
      reservation.scopeId === desiredScope.scopeId
    ));
    const reservationsById = new Map(activeReservations.map((reservation) => (
      [reservation.reservationId, reservation]
    )));
    for (const discovered of discoveredSessions) {
      const correlation = discovered.reservationCorrelation === undefined
        || discovered.reservationCorrelation === null
        ? null
        : parseDiscoveredReservationCorrelation(discovered.reservationCorrelation);
      const correlatedReservation = correlation === null
        ? undefined
        : reservationsById.get(correlation.reservationId);
      if (correlation !== null && correlatedReservation !== undefined && !sameReservationIdentity(
        reservationIdentity(correlatedReservation),
        reservationIdentityFromCorrelation(correlation),
      )) {
        throw new RelayV2MaterializedStateError("INTERNAL", "discovery correlation crossed command identity");
      }
      const reservation = correlatedReservation;
      const discoveredAuthorityKey = authorityKey(discovered.kind, discovered.backendIdentity);
      let session = sessionsByBackend.get(discoveredAuthorityKey);
      const isNewSession = session === undefined;
      if (reservation !== undefined) {
        const target = mutation.materializeReservation(reservation, discovered);
        const materialized = scope.sessions.find((candidate) => (
          candidate.item.sessionId === target.sessionId
        ));
        if (!materialized) {
          throw new RelayV2MaterializedStateError("INTERNAL", "reserved Session was not materialized");
        }
        sessionsByBackend.set(discoveredAuthorityKey, materialized);
        reservationsById.delete(reservation.reservationId);
        continue;
      }
      if (!session) {
        session = {
          backendIdentity: discovered.backendIdentity,
          originReservation: null,
          item: {
            scopeId: desiredScope.scopeId,
            sessionId: mutation.issueSessionId(),
            kind: discovered.kind,
            displayName: discovered.displayName,
            state: discovered.state,
            project: discovered.project,
            label: discovered.label,
            cwd: discovered.cwd,
            attached: discovered.attached,
            windowCount: discovered.windowCount,
            createdAtMs: discovered.createdAtMs,
            activityAtMs: discovered.activityAtMs,
          },
        };
        sessionsByBackend.set(discoveredAuthorityKey, session);
      }
      const desired: RelayV2Session = {
        scopeId: desiredScope.scopeId,
        sessionId: session.item.sessionId,
        kind: discovered.kind,
        displayName: discovered.displayName,
        state: discovered.state,
        project: discovered.project,
        label: discovered.label,
        cwd: discovered.cwd,
        attached: discovered.attached,
        windowCount: discovered.windowCount,
        createdAtMs: discovered.createdAtMs,
        activityAtMs: discovered.activityAtMs,
      };
      if (isNewSession || !sameJson(session.item, desired)) {
        mutation.changes.push({
          scopeId: desiredScope.scopeId,
          dimension: "sessions",
          identity: desired.sessionId,
          change: { op: "upsert", item: clone(desired) },
        });
      }
      session.item = desired;
    }
    if (!preserveLastKnown && effectiveCompleteness === "complete") {
      for (const [backendAuthorityKey, session] of sessionsByBackend) {
        if (observedSessions.has(backendAuthorityKey)) continue;
        sessionsByBackend.delete(backendAuthorityKey);
        mutation.changes.push({
          scopeId: desiredScope.scopeId,
          dimension: "sessions",
          identity: session.item.sessionId,
          change: { op: "delete", sessionId: session.item.sessionId },
        });
      }
      scope.sessionsAuthorityEstablished = true;
    }
    scope.item = desiredScope;
    scope.sessionsCompleteness = effectiveCompleteness;
    scope.sessionsError = effectiveError;
    scope.sessions = [...sessionsByBackend.values()]
      .sort((left, right) => utf8Compare(left.item.sessionId, right.item.sessionId));
  }

  let reservationPreventedCompleteDeletion = false;
  if (scan.coverage === "complete") {
    for (const [backendIdentity, scope] of scopesByBackend) {
      if (observedBackends.has(backendIdentity)) continue;
      const scopeReservations = mutation.state.capacityReservations.filter((reservation) => (
        reservation.scopeId === scope.item.scopeId
      ));
      if (scopeReservations.length > 0) {
        reservationPreventedCompleteDeletion = true;
        continue;
      }
      scopesByBackend.delete(backendIdentity);
      mutation.changes.push({
        scopeId: scope.item.scopeId,
        dimension: "scopes",
        identity: scope.item.scopeId,
        change: { op: "delete", scopeId: scope.item.scopeId },
      });
    }
  }

  mutation.state.aggregateCoverage = reservationPreventedCompleteDeletion
    ? "partial"
    : scan.coverage;
  if (scan.coverage === "complete") mutation.state.aggregateAuthorityEstablished = true;
  mutation.state.scopes = [...scopesByBackend.values()]
    .sort((left, right) => utf8Compare(left.item.scopeId, right.item.scopeId));
  const retainedScopeIds = new Set(mutation.state.scopes.map((scope) => scope.item.scopeId));
  if (mutation.state.capacityReservations.some((reservation) => (
    !retainedScopeIds.has(reservation.scopeId)
  ))) {
    throw new RelayV2MaterializedStateError(
      "INTERNAL",
      "reconciliation cannot delete a scope with an active capacity reservation",
    );
  }
}

function fencedNegativeCandidate(
  reservation: PersistedCapacityReservation,
): RelayV2FencedNegativeCandidate {
  if (reservation.boundBackendIdentity !== null) {
    throw new RelayV2MaterializedStateError(
      "INTERNAL",
      "positive backend evidence cannot become a fenced-negative candidate",
    );
  }
  return {
    reservationId: reservation.reservationId,
    hostEpoch: reservation.hostEpoch,
    principalId: reservation.principalId,
    hostId: reservation.hostId,
    commandId: reservation.commandId,
    requestFingerprint: clone(reservation.requestFingerprint),
    operation: reservation.operation,
    scopeId: reservation.scopeId,
    boundBackendInstanceKey: null,
  };
}

function sameFencedNegativeIdentity(
  left: RelayV2FencedNegativeCandidate,
  right: RelayV2FencedNegativeCandidate,
): boolean {
  return left.reservationId === right.reservationId
    && left.hostEpoch === right.hostEpoch
    && left.principalId === right.principalId
    && left.hostId === right.hostId
    && left.commandId === right.commandId
    && canonicalJson(left.requestFingerprint) === canonicalJson(right.requestFingerprint)
    && left.operation === right.operation
    && left.scopeId === right.scopeId
    && left.boundBackendInstanceKey === null
    && right.boundBackendInstanceKey === null;
}

function normalizeFencedNegativeEvidence(
  value: readonly RelayV2FencedNegativeEvidence[],
  candidates: readonly RelayV2FencedNegativeCandidate[],
): RelayV2FencedNegativeEvidence[] {
  if (!Array.isArray(value)) {
    throw new RelayV2MaterializedStateError("INTERNAL", "negative settlement authority returned invalid evidence");
  }
  const candidateById = new Map(candidates.map((candidate) => [candidate.reservationId, candidate]));
  const seen = new Set<string>();
  return value.map((evidence) => {
    if (!isRecord(evidence) || !exactKeys(evidence, [
      "schemaVersion", "authority", "disposition", "reservationId", "hostEpoch",
      "principalId", "hostId", "commandId", "requestFingerprint", "operation", "scopeId",
      "boundBackendInstanceKey",
    ]) || evidence.schemaVersion !== 1
      || evidence.authority !== "canonical_executor"
      || evidence.disposition !== "fenced_no_side_effect"
      || evidence.boundBackendInstanceKey !== null
      || (evidence.operation !== "create_worktree" && evidence.operation !== "create_terminal")) {
      throw new RelayV2MaterializedStateError("INTERNAL", "negative settlement evidence is malformed");
    }
    const normalized = clone(evidence) as unknown as RelayV2FencedNegativeEvidence;
    parseRequestFingerprint(normalized.requestFingerprint);
    const candidate = candidateById.get(normalized.reservationId);
    if (candidate === undefined || !sameFencedNegativeIdentity(candidate, normalized)) {
      throw new RelayV2MaterializedStateError("INTERNAL", "negative settlement evidence crossed reservation identity");
    }
    if (seen.has(normalized.reservationId)) {
      throw new RelayV2MaterializedStateError("INTERNAL", "negative settlement evidence is duplicated");
    }
    seen.add(normalized.reservationId);
    return normalized;
  });
}

function applyFencedNegativeEvidence(
  mutation: MaterializedMutation,
  transaction: RelayV2HostStateTransaction,
  scan: RelayV2ResourceDiscoveryScan,
  evidence: readonly RelayV2FencedNegativeEvidence[],
): void {
  const positiveCorrelationIds = new Set(scan.scopes.flatMap((scope) => (
    scope.sessions.flatMap((session) => session.reservationCorrelation
      ? [session.reservationCorrelation.reservationId]
      : [])
  )));
  for (const proof of evidence) {
    if (positiveCorrelationIds.has(proof.reservationId)) {
      throw new RelayV2MaterializedStateError(
        "INTERNAL",
        "canonical negative evidence conflicts with positive reservation correlation",
      );
    }
    const index = mutation.state.capacityReservations.findIndex((reservation) => (
      reservation.reservationId === proof.reservationId
    ));
    if (index < 0) {
      throw new RelayV2MaterializedStateError("INTERNAL", "negative evidence reservation disappeared");
    }
    const reservation = mutation.state.capacityReservations[index]!;
    if (!reservation.uncertain
      || reservation.boundBackendIdentity !== null
      || !sameFencedNegativeIdentity(fencedNegativeCandidate(reservation), proof)
      || relayV2CommandReservationLedgerState(transaction, {
        hostEpoch: reservation.hostEpoch,
        principalId: reservation.principalId,
        hostId: reservation.hostId,
        commandId: reservation.commandId,
        requestFingerprint: reservation.requestFingerprint,
      }) !== "in_doubt") {
      throw new RelayV2MaterializedStateError(
        "INTERNAL",
        "negative evidence does not match an uncertain H1 reservation",
      );
    }
    appendNegativeSettlement(mutation.state, reservation);
    mutation.state.capacityReservations.splice(index, 1);
  }
}

function prospectiveRevisions(
  baseRevisions: Record<string, string>,
  changes: readonly PendingChange[],
  reservations: readonly PersistedCapacityReservation[],
): Record<string, string> {
  const revisions = { ...baseRevisions };
  const revisionKeys = [
    ...changes.map((change) => (
      change.dimension === "scopes" ? SCOPES_REVISION_KEY : sessionRevisionKey(change.scopeId)
    )),
    ...reservations.map((reservation) => sessionRevisionKey(reservation.scopeId)),
  ];
  for (const key of revisionKeys) {
    revisions[key] = (BigInt(revisions[key] ?? "0") + 1n).toString(10);
  }
  return revisions;
}

function measureProjectedMaterializedCapacity(
  state: PersistedMaterializedState,
  baseRevisions: Record<string, string>,
  changes: readonly PendingChange[] = [],
): { totalRecords: number; totalCanonicalBytes: number } {
  return measureMaterializedRecords(
    state,
    prospectiveRevisions(baseRevisions, changes, state.capacityReservations),
  );
}

function capacityAssessment(
  state: PersistedMaterializedState,
  baseRevisions: Record<string, string>,
  capacity: MaterializedCapacity,
  changes: readonly PendingChange[] = [],
): RelayV2MaterializedCapacityAssessment {
  const measured = measureProjectedMaterializedCapacity(state, baseRevisions, changes);
  return {
    withinCapacity: measured.totalRecords <= capacity.maxSnapshotRecords
      && measured.totalCanonicalBytes <= capacity.maxSnapshotCanonicalBytes,
    ...measured,
  };
}

function finalizeMutation(
  hostId: string,
  mutation: MaterializedMutation,
  transaction: Pick<
    RelayV2CommandResourceTransaction,
    "allocateRevision" | "allocateEventSeq" | "putMaterializedRecord"
  >,
): RelayV2JsonObject[] {
  const events: RelayV2JsonObject[] = [];
  const changes = [...mutation.changes].sort((left, right) => {
    const scopeOrder = utf8Compare(left.scopeId, right.scopeId);
    if (scopeOrder !== 0) return scopeOrder;
    if (left.dimension !== right.dimension) return left.dimension === "scopes" ? -1 : 1;
    const leftDelete = left.change.op === "delete";
    const rightDelete = right.change.op === "delete";
    if (leftDelete !== rightDelete) return leftDelete ? -1 : 1;
    return utf8Compare(left.identity, right.identity);
  });
  for (const pending of changes) {
    const revision = transaction.allocateRevision(
      pending.dimension === "scopes" ? SCOPES_REVISION_KEY : sessionRevisionKey(pending.scopeId),
    );
    events.push(stateEvent(
      hostId,
      mutation.hostEpoch,
      pending.scopeId,
      transaction.allocateEventSeq(),
      revision,
      pending.dimension,
      pending.change,
    ));
  }
  advanceMaterializedGeneration(mutation.state);
  putMaterializedState(transaction, mutation.hostEpoch, mutation.state);
  return events;
}

function measureMaterializedRecords(
  state: PersistedMaterializedState,
  revisions: Record<string, string>,
): { totalRecords: number; totalCanonicalBytes: number } {
  let totalRecords = 0;
  let totalCanonicalBytes = 2;
  const add = (record: unknown) => {
    const bytes = Buffer.byteLength(canonicalJson(record), "utf8");
    totalCanonicalBytes += bytes + (totalRecords === 0 ? 0 : 1);
    totalRecords += 1;
  };
  for (const scope of [...state.scopes].sort((left, right) => (
    utf8Compare(left.item.scopeId, right.item.scopeId)
  ))) {
    add({ recordType: "scope", item: scope.item });
    add({
      recordType: "sessions_scope",
      scopeId: scope.item.scopeId,
      revision: revisions[sessionRevisionKey(scope.item.scopeId)] ?? "0",
      completeness: "complete",
    });
    for (const session of [...scope.sessions].sort((left, right) => (
      utf8Compare(left.item.sessionId, right.item.sessionId)
    ))) {
      add({ recordType: "session", scopeId: scope.item.scopeId, item: session.item });
    }
  }
  for (const reservation of [...state.capacityReservations].sort((left, right) => {
    const scopeOrder = utf8Compare(left.scopeId, right.scopeId);
    return scopeOrder !== 0 ? scopeOrder : utf8Compare(left.reservationId, right.reservationId);
  })) {
    totalCanonicalBytes += reservation.reservedCanonicalBytes + (totalRecords === 0 ? 0 : 1);
    totalRecords += reservation.reservedRecords;
  }
  return { totalRecords, totalCanonicalBytes };
}

function readinessFor(
  snapshot: RelayV2HostStateSnapshot,
  state: PersistedMaterializedState,
  capacity: MaterializedCapacity,
): RelayV2MaterializedReadiness {
  if (snapshot.materializedReadinessFence !== null) {
    return withdrawnReadiness(snapshot, snapshot.materializedReadinessFence.reason);
  }
  const measured = measureProjectedMaterializedCapacity(state, snapshot.revisions);
  let reason: RelayV2MaterializedReadinessReason = "ready";
  if (!state.aggregateAuthorityEstablished) reason = "aggregate_authority_not_established";
  else if (state.aggregateCoverage !== "complete") reason = "aggregate_coverage_partial";
  else if (
    measured.totalRecords > capacity.maxSnapshotRecords
    || measured.totalCanonicalBytes > capacity.maxSnapshotCanonicalBytes
  ) reason = "capacity_exceeded";
  else if (state.scopes.some((scope) => !scope.sessionsAuthorityEstablished)) {
    reason = "scope_without_complete_authority";
  } else if (state.scopes.some((scope) => (
    scope.item.reachability === "online" && scope.sessionsCompleteness === "partial"
  ))) {
    reason = "partial_online_scope";
  }
  return {
    snapshotMaterializationReady: reason === "ready",
    reason,
    closeV2Routes: reason !== "ready",
    hostEpoch: snapshot.hostEpoch,
    eventSeq: snapshot.eventSeq,
    ...measured,
  };
}

function projectMaterializedStateCut(
  snapshot: RelayV2HostStateSnapshot,
  state: PersistedMaterializedState,
): RelayV2MaterializedStateCut {
  const records: RelayV2MaterializedStateCutRecord[] = [];
  for (const scope of [...state.scopes].sort((left, right) => (
    utf8Compare(left.item.scopeId, right.item.scopeId)
  ))) {
    records.push({ recordType: "scope", item: clone(scope.item) });
    records.push({
      recordType: "sessions_scope",
      scopeId: scope.item.scopeId,
      revision: revisionFor(snapshot, sessionRevisionKey(scope.item.scopeId)),
      completeness: "complete",
    });
    for (const session of [...scope.sessions].sort((left, right) => (
      utf8Compare(left.item.sessionId, right.item.sessionId)
    ))) {
      records.push({
        recordType: "session",
        scopeId: scope.item.scopeId,
        item: clone(session.item),
      });
    }
  }
  return {
    hostEpoch: snapshot.hostEpoch,
    throughEventSeq: snapshot.eventSeq,
    scopesRevision: revisionFor(snapshot, SCOPES_REVISION_KEY),
    records,
  };
}

function materializedCutIdentity(
  hostId: string,
  snapshot: RelayV2HostStateSnapshot,
  state: PersistedMaterializedState,
  cut: RelayV2MaterializedStateCut,
): string {
  const digest = createHash("sha256").update(canonicalJson({
    schemaVersion: 1,
    hostId,
    hostEpoch: snapshot.hostEpoch,
    hostInstanceId: snapshot.hostInstanceId,
    materializedGeneration: state.generation,
    throughEventSeq: cut.throughEventSeq,
    scopesRevision: cut.scopesRevision,
    records: cut.records,
  }), "utf8").digest("base64url");
  return `twh2cut1.${digest}`;
}

type ContinuityFenceReason = "commit_uncertain" | "host_epoch_changed";

function continuityFenceReadiness(
  snapshot: RelayV2HostStateSnapshot,
  reason: ContinuityFenceReason,
): RelayV2MaterializedReadiness {
  return {
    snapshotMaterializationReady: false,
    reason,
    closeV2Routes: true,
    hostEpoch: snapshot.hostEpoch,
    eventSeq: snapshot.eventSeq,
    totalRecords: 0,
    totalCanonicalBytes: 0,
  };
}

function withdrawnReadiness(
  snapshot: RelayV2HostStateSnapshot,
  reason: "persisted_capacity_exceeded"
    | "reconcile_generation_conflict"
    | "materialized_authority_conflict",
): RelayV2MaterializedReadiness {
  return {
    snapshotMaterializationReady: false,
    reason,
    closeV2Routes: true,
    hostEpoch: snapshot.hostEpoch,
    eventSeq: snapshot.eventSeq,
    totalRecords: 0,
    totalCanonicalBytes: 0,
  };
}

function assertExpectedEpoch(expected: string, actual: string): void {
  if (expected !== actual) {
    throw new RelayV2MaterializedStateError(
      "HOST_EPOCH_MISMATCH",
      "Relay v2 host lineage does not match",
      { expectedHostEpoch: expected, actualHostEpoch: actual },
    );
  }
}

function ensureConvenienceFrame(frame: RelayV2JsonObject): void {
  try {
    encodeRelayV2WebSocketFrame("public", frame);
  } catch {
    throw new RelayV2MaterializedStateError(
      "SNAPSHOT_TOO_LARGE",
      "single-frame snapshot exceeds its frozen boundary; use state.snapshot",
      { useStateSnapshot: true },
    );
  }
}

export class RelayV2MaterializedStateFoundation {
  readonly hostId: string;
  readonly capacity: MaterializedCapacity;
  readonly reservationLimits: ResourceReservationLimits;
  readonly commandResourceMutationOwner: RelayV2CommandResourceMutationOwner;
  readonly snapshotCutSource: RelayV2MaterializedStateCutSource;
  readonly canonicalTargetResolver: RelayV2CanonicalResourceResolverPort;

  private readonly discovery: RelayV2ResourceDiscovery;
  private readonly reservationSettlementAuthority: RelayV2ReservationSettlementAuthority | undefined;
  private readonly store: Pick<RelayV2HostStateStore, "serialize">;
  private readonly readinessSink: RelayV2MaterializedReadinessSink;
  private readonly now: () => number;
  private readonly snapshotCandidateLimits: Readonly<MaterializedCutCandidateLimits>;
  private readonly testHooks: RelayV2MaterializedStateTestHooks | undefined;
  private readonly snapshotCutSourceIdentity = Object.freeze(Object.create(null)) as object;
  private readonly materializedSourceGeneration = randomBytes(32).toString("base64url");
  private readonly subscribers = new Map<string | object, Subscriber>();
  private readonly snapshotCutCandidates = new Map<object, MaterializedCutCandidateRecord>();
  private readonly snapshotCutActivations = new Map<object, MaterializedCutActivationRecord>();
  private snapshotCutCandidateRetainedBytes = 0;
  private publishedCanonicalResolver: PublishedCanonicalResolver | null = null;
  private reconcileInFlight: Promise<RelayV2MaterializedReconcileResult> | null = null;
  private observedHostEpoch: string | null = null;
  private continuityFenceReason: ContinuityFenceReason | null = null;

  constructor(options: RelayV2MaterializedStateOptions) {
    validateOpaqueInput(options.hostId, "hostId");
    this.hostId = options.hostId;
    this.discovery = options.discovery;
    this.reservationSettlementAuthority = options.reservationSettlementAuthority;
    this.store = options.store;
    this.readinessSink = options.readinessSink;
    this.now = options.now ?? Date.now;
    this.testHooks = options.testHooks;
    this.capacity = Object.freeze({
      ...RELAY_V2_MATERIALIZED_CAPACITY,
      ...options.testCapacityLimits,
    });
    for (const [name, value] of Object.entries(this.capacity)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`invalid Relay v2 materialized capacity ${name}`);
      }
    }
    if (
      this.capacity.maxSnapshotRecords > RELAY_V2_MATERIALIZED_CAPACITY.maxSnapshotRecords
      || this.capacity.maxSnapshotCanonicalBytes
        > RELAY_V2_MATERIALIZED_CAPACITY.maxSnapshotCanonicalBytes
    ) {
      throw new Error("Relay v2 frozen materialized capacity cannot be widened");
    }
    this.reservationLimits = Object.freeze({
      ...RELAY_V2_RESOURCE_RESERVATION_LIMITS,
      ...options.testReservationLimits,
    });
    for (const [name, value] of Object.entries(this.reservationLimits)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`invalid Relay v2 resource reservation limit ${name}`);
      }
    }
    if (this.reservationLimits.maxSessionCanonicalBytes
      > RELAY_V2_RESOURCE_RESERVATION_LIMITS.maxSessionCanonicalBytes) {
      throw new Error("Relay v2 frozen resource reservation limits cannot be widened");
    }
    this.snapshotCandidateLimits = Object.freeze({
      ...RELAY_V2_MATERIALIZED_CUT_CANDIDATE_LIMITS,
      ...options.testSnapshotCandidateLimits,
    });
    for (const [name, value] of Object.entries(this.snapshotCandidateLimits)) {
      const production = RELAY_V2_MATERIALIZED_CUT_CANDIDATE_LIMITS[
        name as keyof MaterializedCutCandidateLimits
      ];
      if (!Number.isSafeInteger(value) || value <= 0 || value > production) {
        throw new Error(`invalid or widened Relay v2 snapshot candidate limit ${name}`);
      }
    }
    this.commandResourceMutationOwner = Object.freeze({
      reserve: (
        transaction: RelayV2CommandResourceTransaction,
        intent: RelayV2CommandResourceReservationIntent,
      ) => this.reserveCommandResource(transaction, intent),
      commit: (
        transaction: RelayV2CommandResourceTransaction,
        intent: RelayV2CommandResourceCommitIntent,
      ) => this.commitCommandResource(transaction, intent),
      settle: (
        transaction: RelayV2CommandResourceTransaction,
        intent: RelayV2CommandResourceSettlementIntent,
      ) => this.settleCommandResource(transaction, intent),
      hasPendingSettlement: (
        transaction: RelayV2CommandResourceTransaction,
        intent: RelayV2CommandResourceSettlementIntent,
      ) => this.hasPendingCommandResourceSettlement(transaction, intent),
      publishCommitted: (
        snapshot: RelayV2HostStateSnapshot,
        evidence: RelayV2CommandResourceCommitEvidence,
      ) => {
        this.publishedCanonicalResolver = null;
        this.afterCommit(
          snapshot,
          evidence.events,
          readinessFor(snapshot, parseMaterializedState(snapshot), this.capacity),
        );
      },
      fenceCommitUncertain: (snapshot: RelayV2HostStateSnapshot) => {
        this.publishedCanonicalResolver = null;
        this.fenceCommitUncertain(snapshot);
      },
      fencePersistedCapacity: (snapshot: RelayV2HostStateSnapshot) => {
        this.publishedCanonicalResolver = null;
        this.withdrawReadiness(snapshot, "persisted_capacity_exceeded");
      },
      fenceMaterializedAuthority: (snapshot: RelayV2HostStateSnapshot) => {
        this.publishedCanonicalResolver = null;
        this.withdrawReadiness(snapshot, "materialized_authority_conflict");
      },
    });
    this.snapshotCutSource = Object.freeze({
      currentHostEpoch: () => this.currentSnapshotHostEpoch(),
      withHostEpochFence: <T>(
        expectedHostEpoch: string,
        operation: () => T | Promise<T>,
      ) => this.withSnapshotHostEpochFence(expectedHostEpoch, operation),
      admissionEstimate: (expectedHostEpoch: string) => (
        this.estimateMaterializedStateCutAdmission(expectedHostEpoch)
      ),
      captureCandidate: (expectedHostEpoch: string) => (
        this.captureMaterializedStateCutCandidate(expectedHostEpoch)
      ),
      inspectCandidate: (lease: RelayV2MaterializedStateCutCandidateLease) => (
        this.inspectMaterializedStateCutCandidate(lease)
      ),
      withCandidateFence: <T>(
        lease: RelayV2MaterializedStateCutCandidateLease,
        operation: (candidate: RelayV2MaterializedStateCutCandidate) => T | Promise<T>,
      ) => this.withMaterializedStateCutCandidateFence(lease, operation),
      activateCandidate: (
        lease: RelayV2MaterializedStateCutCandidateLease,
        sink: RelayV2StateEventSink<RelayV2JsonObject>,
        beforeDrain: (candidate: RelayV2MaterializedStateCutCandidate) => true,
        afterAttach: (
          candidate: RelayV2MaterializedStateCutCandidate,
          activation: RelayV2MaterializedStateCutActivationLease,
        ) => true,
      ) => this.activateMaterializedStateCutCandidate(
        lease,
        sink,
        beforeDrain,
        afterAttach,
      ),
      releaseCandidateActivation: (
        activation: RelayV2MaterializedStateCutActivationLease,
      ) => {
        this.releaseMaterializedStateCutActivation(activation);
      },
      withdrawSnapshotOwnerAuthority: () => this.withdrawSnapshotOwnerAuthority(),
      releaseCandidate: (lease: RelayV2MaterializedStateCutCandidateLease) => {
        this.releaseMaterializedStateCutCandidate(lease);
      },
    });
    this.canonicalTargetResolver = Object.freeze({
      captureToken: (expectedHostEpoch: string) => (
        this.captureCanonicalResolverToken(expectedHostEpoch)
      ),
      resolveScope: (token: RelayV2CanonicalResourceResolverToken, scopeId: string) => (
        this.resolveCanonicalScopeTarget(token, scopeId)
      ),
      resolveSession: (
        token: RelayV2CanonicalResourceResolverToken,
        scopeId: string,
        sessionId: string,
      ) => this.resolveCanonicalSessionTarget(token, scopeId, sessionId),
      resolveScopeForAdmission: (
        token: RelayV2CanonicalResourceResolverToken,
        scopeId: string,
      ) => this.resolveCanonicalScopeForAdmission(token, scopeId),
      resolveSessionForAdmission: (
        token: RelayV2CanonicalResourceResolverToken,
        scopeId: string,
        sessionId: string,
      ) => this.resolveCanonicalSessionForAdmission(token, scopeId, sessionId),
      fenceResourceCutForAdmission: (
        transaction: RelayV2CommandResolutionTransaction,
        fence: RelayV2CanonicalResourceResolutionFence,
      ) => this.fenceCanonicalResourceCutForAdmission(
        transaction,
        fence,
      ),
    });
  }

  private reserveCommandResource(
    transaction: RelayV2CommandResourceTransaction,
    intent: RelayV2CommandResourceReservationIntent,
  ): RelayV2CommandResourceReservationResult {
    validateResourceIntentIdentity(intent, this.hostId);
    if (intent.operation !== "create_worktree" && intent.operation !== "create_terminal") {
      throw new RelayV2MaterializedStateError("INTERNAL", "only create commands reserve H2 capacity");
    }
    const snapshot = materializedSnapshotForTransaction(transaction, intent.hostEpoch);
    const state = parseMaterializedState(snapshot);
    let plan: RelayV2ResourceReservationPlan;
    try {
      plan = normalizeReservationPlan(intent.reservationPlan, intent.scopeId, intent.operation);
    } catch (error) {
      if (error instanceof RelayV2MaterializedStateError && error.code === "INVALID_ARGUMENT") {
        return rejection("INVALID_ARGUMENT", error.message);
      }
      throw error;
    }
    const commandKey = canonicalReservationCommandKey({
      hostEpoch: intent.hostEpoch,
      principalId: intent.principalId,
      hostId: intent.hostId,
      commandId: intent.commandId,
      requestFingerprint: intent.requestFingerprint,
    });
    const commandTuple = canonicalReservationTuple(intent);
    const existingReservation = state.capacityReservations.find((candidate) => (
      canonicalReservationCommandKey(reservationIdentity(candidate)) === commandKey
    ));
    const existingMapping = state.scopes.flatMap((scope) => scope.sessions).find((session) => (
      session.originReservation !== null
      && canonicalReservationCommandKey(session.originReservation) === commandKey
    ));
    const existingNegative = state.negativeSettlements.find((settlement) => (
      canonicalReservationCommandKey(settlement) === commandKey
    ));

    // Exact replay is resolved before current readiness. H1 ordinarily avoids
    // this call via its cmd:v1 record, but this ordering protects restart and
    // commit-uncertain replay at the narrow boundary too.
    const replayId = existingReservation?.reservationId
      ?? existingMapping?.originReservation?.reservationId;
    if (replayId !== undefined) {
      if (existingReservation !== undefined && (
        existingReservation.operation !== intent.operation
        || existingReservation.scopeId !== intent.scopeId
        || canonicalJson(existingReservation.logicalTarget) !== canonicalJson(plan.logicalTarget)
      )) {
        throw new RelayV2MaterializedStateError(
          "IDEMPOTENCY_CONFLICT",
          "command identity is already bound to another logical target",
        );
      }
      return {
        kind: "reserved",
        binding: {
          schemaVersion: 1,
          owner: "relay_v2_resource_state",
          reservationId: replayId,
        },
      };
    }
    if (existingNegative !== undefined) {
      throw new RelayV2MaterializedStateError(
        "IDEMPOTENCY_CONFLICT",
        "command identity already has durable negative settlement authority",
      );
    }
    const conflictingTuple = [
      ...state.capacityReservations.map(reservationIdentity),
      ...state.scopes.flatMap((scope) => scope.sessions.flatMap((session) => (
        session.originReservation === null ? [] : [session.originReservation]
      ))),
      ...state.negativeSettlements,
    ].some((candidate) => canonicalReservationTuple(candidate) === commandTuple);
    if (conflictingTuple) {
      throw new RelayV2MaterializedStateError(
        "IDEMPOTENCY_CONFLICT",
        "command identity is already bound to another request fingerprint",
      );
    }

    const revisions = revisionsForTransaction(transaction, state);
    const readiness = readinessFor({ ...snapshot, revisions }, state, this.capacity);
    if (!readiness.snapshotMaterializationReady) {
      return rejection(
        "CAPABILITY_UNAVAILABLE",
        `materialized create admission is unavailable: ${readiness.reason}`,
      );
    }
    const scope = state.scopes.find((candidate) => candidate.item.scopeId === intent.scopeId);
    if (!scope) return rejection("INVALID_ARGUMENT", "create scope is not materialized");
    if (scope.item.reachability !== "online"
      || scope.sessionsCompleteness !== "complete"
      || !scope.sessionsAuthorityEstablished) {
      return rejection("CAPABILITY_UNAVAILABLE", "create scope lacks complete online authority");
    }
    if (state.capacityReservations.some((reservation) => (
        reservation.scopeId === intent.scopeId
        && canonicalJson(reservation.logicalTarget) === canonicalJson(plan.logicalTarget)
      ))) {
      return rejection("BUSY", "logical create target already has an active reservation");
    }
    const reservationId = issueUnusedOpaqueId(
      transaction,
      "res",
      new Set([
        ...state.capacityReservations.map((reservation) => reservation.reservationId),
        ...state.scopes.flatMap((candidateScope) => candidateScope.sessions.flatMap((session) => (
          session.originReservation === null ? [] : [session.originReservation.reservationId]
        ))),
        ...state.negativeSettlements.map((settlement) => settlement.reservationId),
      ]),
    );
    const reservedSessionId = issueUnusedOpaqueId(
      transaction,
      "ses",
      new Set(state.usedSessionIds),
    );
    const plannedItem = reservationItem(
      intent.scopeId,
      reservedSessionId,
      plan.session,
    );
    if (canonicalSessionRecordBytes(intent.scopeId, plannedItem)
      > this.reservationLimits.maxSessionCanonicalBytes) {
      return rejection("CAPABILITY_UNAVAILABLE", "planned Session exceeds its conservative bound");
    }
    const next = clone(state);
    next.usedSessionIds.push(reservedSessionId);
    next.capacityReservations.push({
      reservationId,
      hostEpoch: intent.hostEpoch,
      principalId: intent.principalId,
      hostId: intent.hostId,
      commandId: intent.commandId,
      requestFingerprint: clone(intent.requestFingerprint),
      operation: intent.operation,
      scopeId: intent.scopeId,
      logicalTarget: clone(plan.logicalTarget),
      reservedSessionId,
      plannedSession: clone(plan.session),
      boundBackendIdentity: null,
      uncertain: false,
      reservedRecords: 1,
      reservedCanonicalBytes: this.reservationLimits.maxSessionCanonicalBytes,
    });
    const prospective = capacityAssessment(next, revisions, this.capacity);
    if (!prospective.withinCapacity) {
      return rejection("CAPABILITY_UNAVAILABLE", "create reservation exceeds materialized capacity");
    }
    advanceMaterializedGeneration(next);
    putMaterializedState(transaction, intent.hostEpoch, next);
    return {
      kind: "reserved",
      binding: {
        schemaVersion: 1,
        owner: "relay_v2_resource_state",
        reservationId,
      },
    };
  }

  private commitCommandResource(
    transaction: RelayV2CommandResourceTransaction,
    intent: RelayV2CommandResourceCommitIntent,
  ): RelayV2CommandResourceCommitEvidence {
    validateResourceIntentIdentity(intent, this.hostId);
    const snapshot = materializedSnapshotForTransaction(transaction, intent.hostEpoch);
    const state = parseMaterializedState(snapshot);
    const revisions = revisionsForTransaction(transaction, state);
    const mutation = new MaterializedMutation(
      intent.hostEpoch,
      state,
      transaction,
      revisions,
      this.capacity,
    );

    if (intent.operation === "kill_session") {
      if (intent.sessionId === null || intent.reservationBinding !== null) {
        throw new RelayV2MaterializedStateError("INTERNAL", "kill resource intent is malformed");
      }
      const target = mutation.resolveSession(intent.scopeId, intent.sessionId);
      if (!target || target.sessionBackendIdentity !== intent.backendOutcome.backendInstanceKey) {
        throw new RelayV2MaterializedStateError("INTERNAL", "kill outcome targets another Session");
      }
      mutation.deleteSession(intent.scopeId, intent.sessionId);
      const prospective = mutation.preflightCapacity();
      if (!prospective.withinCapacity) {
        throw new RelayV2MaterializedStateError("CAPABILITY_UNAVAILABLE", "kill projection exceeds capacity");
      }
      const events = finalizeMutation(this.hostId, mutation, transaction);
      return {
        schemaVersion: 1,
        owner: "relay_v2_resource_state",
        operation: intent.operation,
        principalId: intent.principalId,
        hostId: intent.hostId,
        hostEpoch: intent.hostEpoch,
        scopeId: intent.scopeId,
        sessionId: intent.sessionId,
        result: { sessionId: intent.sessionId, terminated: true },
        events,
        evidence: { backendInstanceKey: intent.backendOutcome.backendInstanceKey },
      };
    }

    if (intent.operation !== "create_worktree" && intent.operation !== "create_terminal"
      || intent.sessionId !== null || intent.reservationBinding === null) {
      throw new RelayV2MaterializedStateError("INTERNAL", "create resource intent is malformed");
    }
    const binding = parseReservationBinding(intent.reservationBinding);
    const expectedIdentity = reservationIdentityFromIntent(intent, binding.reservationId);
    const active = state.capacityReservations.find((candidate) => (
      candidate.reservationId === binding.reservationId
    ));
    const mapped = state.scopes.flatMap((scope) => scope.sessions).find((session) => (
      session.originReservation !== null
      && session.originReservation.reservationId === binding.reservationId
    ));
    if (active !== undefined && !sameReservationIdentity(reservationIdentity(active), expectedIdentity)) {
      throw new RelayV2MaterializedStateError("INTERNAL", "reservation binding belongs to another command");
    }
    if (mapped?.originReservation !== null && mapped?.originReservation !== undefined
      && !sameReservationIdentity(mapped.originReservation, expectedIdentity)) {
      throw new RelayV2MaterializedStateError("INTERNAL", "reservation mapping belongs to another command");
    }
    if (active === undefined && mapped === undefined) {
      throw new RelayV2MaterializedStateError("INTERNAL", "create reservation disappeared before finalization");
    }
    const discovered = discoveredSessionFromBackendOutcome(intent.backendOutcome);
    const sessionBound = active?.reservedCanonicalBytes
      ?? this.reservationLimits.maxSessionCanonicalBytes;
    const measuredItem = reservationItem(
      intent.scopeId,
      mapped?.item.sessionId ?? active?.reservedSessionId
        ?? "ses_00000000000000000000000000000000",
      discovered,
    );
    if (canonicalSessionRecordBytes(intent.scopeId, measuredItem) > sessionBound) {
      throw new RelayV2MaterializedStateError(
        "INTERNAL",
        "executor exceeded the admitted materialized Session bound",
      );
    }
    let target: RelayV2SessionTarget | null;
    if (active !== undefined) {
      if (active.operation !== intent.operation
        || active.scopeId !== intent.scopeId
        || (active.boundBackendIdentity !== null
          && active.boundBackendIdentity !== discovered.backendIdentity)) {
        throw new RelayV2MaterializedStateError("INTERNAL", "create outcome diverges from its reservation");
      }
      target = mutation.materializeReservation(active, discovered);
    } else {
      target = mutation.updateReservationMapping(expectedIdentity, intent.scopeId, discovered);
    }
    if (target === null) {
      throw new RelayV2MaterializedStateError("INTERNAL", "reserved Session mapping is unavailable");
    }
    const prospective = mutation.preflightCapacity();
    if (!prospective.withinCapacity) {
      throw new RelayV2MaterializedStateError("INTERNAL", "reservation finalization exceeded capacity");
    }
    const events = finalizeMutation(this.hostId, mutation, transaction);
    return {
      schemaVersion: 1,
      owner: "relay_v2_resource_state",
      operation: intent.operation,
      principalId: intent.principalId,
      hostId: intent.hostId,
      hostEpoch: intent.hostEpoch,
      scopeId: intent.scopeId,
      sessionId: target.sessionId,
      result: { session: clone(target.item) as unknown as RelayV2JsonObject },
      events,
      evidence: {
        reservationId: binding.reservationId,
        backendInstanceKey: discovered.backendIdentity,
      },
    };
  }

  private settleCommandResource(
    transaction: RelayV2CommandResourceTransaction,
    intent: RelayV2CommandResourceSettlementIntent,
  ): "retained" | "retained_fenced" | "released" | "consumed" {
    validateResourceIntentIdentity(intent, this.hostId);
    if (intent.operation !== "create_worktree" && intent.operation !== "create_terminal") {
      throw new RelayV2MaterializedStateError("INTERNAL", "only create reservations can settle");
    }
    const snapshot = materializedSnapshotForTransaction(transaction, intent.hostEpoch);
    const state = parseMaterializedState(snapshot);
    const commandKey = canonicalReservationCommandKey({
      hostEpoch: intent.hostEpoch,
      principalId: intent.principalId,
      hostId: intent.hostId,
      commandId: intent.commandId,
      requestFingerprint: intent.requestFingerprint,
    });
    const binding = intent.reservationBinding === null
      ? null
      : parseReservationBinding(intent.reservationBinding);
    const activeIndex = state.capacityReservations.findIndex((candidate) => (
      binding !== null
        ? candidate.reservationId === binding.reservationId
        : canonicalReservationCommandKey(reservationIdentity(candidate)) === commandKey
    ));
    const mapped = state.scopes.flatMap((scope) => scope.sessions).find((session) => (
      session.originReservation !== null
      && (binding !== null
        ? session.originReservation.reservationId === binding.reservationId
        : canonicalReservationCommandKey(session.originReservation) === commandKey)
    ));
    if (mapped !== undefined) {
      const origin = mapped.originReservation!;
      if (canonicalReservationCommandKey(origin) !== commandKey) {
        throw new RelayV2MaterializedStateError("INTERNAL", "reservation binding crossed command identity");
      }
      return "consumed";
    }
    const negative = state.negativeSettlements.find((settlement) => (
      binding !== null
        ? settlement.reservationId === binding.reservationId
        : canonicalReservationCommandKey(settlement) === commandKey
    ));
    if (negative !== undefined) {
      if (canonicalReservationCommandKey(negative) !== commandKey
        || negative.operation !== intent.operation
        || negative.scopeId !== intent.scopeId) {
        throw new RelayV2MaterializedStateError(
          "INTERNAL",
          "negative settlement crossed command identity",
        );
      }
      if (intent.disposition === "retain_uncertain") {
        throw new RelayV2MaterializedStateError(
          "INTERNAL",
          "uncertain settlement cannot reopen negative authority",
        );
      }
      return "released";
    }
    if (activeIndex < 0) {
      if (intent.disposition === "retain_uncertain") {
        throw new RelayV2MaterializedStateError("INTERNAL", "uncertain reservation disappeared");
      }
      return "released";
    }
    const reservation = state.capacityReservations[activeIndex]!;
    if (canonicalReservationCommandKey(reservationIdentity(reservation)) !== commandKey
      || reservation.operation !== intent.operation
      || reservation.scopeId !== intent.scopeId) {
      throw new RelayV2MaterializedStateError("INTERNAL", "reservation settlement crossed command identity");
    }
    if (intent.backendOutcome !== null) {
      if (reservation.boundBackendIdentity !== null
        && intent.backendOutcome.backendInstanceKey !== reservation.boundBackendIdentity) {
        throw new RelayV2MaterializedStateError("INTERNAL", "uncertain backend differs from reservation");
      }
      const backendAuthority = sessionBackendAuthorityKey(
        intent.hostEpoch,
        reservation.scopeId,
        reservation.plannedSession.kind,
        intent.backendOutcome.backendInstanceKey,
      );
      const reservationCollision = state.capacityReservations.some((candidate) => (
        candidate.reservationId !== reservation.reservationId
        && candidate.boundBackendIdentity !== null
        && sessionBackendAuthorityKey(
          intent.hostEpoch,
          candidate.scopeId,
          candidate.plannedSession.kind,
          candidate.boundBackendIdentity,
        ) === backendAuthority
      ));
      const mappedCollision = state.scopes.some((scope) => scope.sessions.some((session) => (
        session.originReservation !== null
        && session.originReservation.reservationId !== reservation.reservationId
        && sessionBackendAuthorityKey(
          intent.hostEpoch,
          scope.item.scopeId,
          session.item.kind,
          session.backendIdentity,
        ) === backendAuthority
      )));
      if (reservationCollision || mappedCollision) {
        reservation.uncertain = true;
        transaction.latchMaterializedReadinessFence(
          "materialized_authority_conflict",
        );
        advanceMaterializedGeneration(state);
        putMaterializedState(transaction, intent.hostEpoch, state);
        return "retained_fenced";
      }
      reservation.boundBackendIdentity = intent.backendOutcome.backendInstanceKey;
    }
    if (intent.disposition === "retain_uncertain") {
      reservation.uncertain = true;
      advanceMaterializedGeneration(state);
      putMaterializedState(transaction, intent.hostEpoch, state);
      return "retained";
    }
    if (intent.disposition === "release_no_side_effect"
      && reservation.boundBackendIdentity !== null) {
      throw new RelayV2MaterializedStateError("INTERNAL", "bound reservation cannot be released as no-side-effect");
    }
    appendNegativeSettlement(state, reservation);
    state.capacityReservations.splice(activeIndex, 1);
    advanceMaterializedGeneration(state);
    putMaterializedState(transaction, intent.hostEpoch, state);
    return "released";
  }

  private hasPendingCommandResourceSettlement(
    transaction: RelayV2CommandResourceTransaction,
    intent: RelayV2CommandResourceSettlementIntent,
  ): boolean {
    validateResourceIntentIdentity(intent, this.hostId);
    const state = parseMaterializedState(
      materializedSnapshotForTransaction(transaction, intent.hostEpoch),
    );
    const commandKey = canonicalReservationCommandKey({
      hostEpoch: intent.hostEpoch,
      principalId: intent.principalId,
      hostId: intent.hostId,
      commandId: intent.commandId,
      requestFingerprint: intent.requestFingerprint,
    });
    const binding = intent.reservationBinding === null
      ? null
      : parseReservationBinding(intent.reservationBinding);
    const active = state.capacityReservations.find((reservation) => (
      binding === null
        ? canonicalReservationCommandKey(reservationIdentity(reservation)) === commandKey
        : reservation.reservationId === binding.reservationId
    ));
    if (active === undefined) return false;
    if (canonicalReservationCommandKey(reservationIdentity(active)) !== commandKey
      || active.operation !== intent.operation
      || active.scopeId !== intent.scopeId) {
      throw new RelayV2MaterializedStateError(
        "INTERNAL",
        "pending settlement lookup crossed command identity",
      );
    }
    return true;
  }

  private async captureCanonicalResolverToken(
    expectedHostEpoch: string,
  ): Promise<RelayV2CanonicalResourceResolverToken> {
    validateOpaqueInput(expectedHostEpoch, "expectedHostEpoch");
    return this.store.serialize((section) => {
      const snapshot = section.read();
      this.observeLineage(snapshot);
      assertExpectedEpoch(expectedHostEpoch, snapshot.hostEpoch);
      const state = parseMaterializedState(snapshot);
      const publication = this.requireCanonicalResolver(snapshot, state);
      return clone(publication.token);
    });
  }

  private async resolveCanonicalScopeTarget(
    rawToken: RelayV2CanonicalResourceResolverToken,
    scopeId: string,
  ): Promise<RelayV2CanonicalResolvedScopeTarget> {
    const token = normalizeCanonicalResolverToken(rawToken);
    validateOpaqueInput(scopeId, "scopeId");
    return this.store.serialize((section) => {
      const snapshot = section.read();
      this.observeLineage(snapshot);
      assertExpectedEpoch(token.hostEpoch, snapshot.hostEpoch);
      const state = parseMaterializedState(snapshot);
      const publication = this.requireCanonicalResolver(snapshot, state, token);
      const target = publication.scopes.get(scopeId);
      if (target === undefined) {
        throw new RelayV2MaterializedStateError(
          "SCOPE_NOT_FOUND",
          "Scope is absent from the complete canonical resolver cut",
        );
      }
      return clone(target);
    });
  }

  private async resolveCanonicalSessionTarget(
    rawToken: RelayV2CanonicalResourceResolverToken,
    scopeId: string,
    sessionId: string,
  ): Promise<RelayV2CanonicalResolvedSessionTarget> {
    const token = normalizeCanonicalResolverToken(rawToken);
    validateOpaqueInput(scopeId, "scopeId");
    validateOpaqueInput(sessionId, "sessionId");
    return this.store.serialize((section) => {
      const snapshot = section.read();
      this.observeLineage(snapshot);
      assertExpectedEpoch(token.hostEpoch, snapshot.hostEpoch);
      const state = parseMaterializedState(snapshot);
      const publication = this.requireCanonicalResolver(snapshot, state, token);
      if (!publication.scopes.has(scopeId)) {
        throw new RelayV2MaterializedStateError(
          "SCOPE_NOT_FOUND",
          "Scope is absent from the complete canonical resolver cut",
        );
      }
      const target = publication.sessions.get(`${scopeId}\0${sessionId}`);
      if (target === undefined) {
        throw new RelayV2MaterializedStateError(
          "SESSION_NOT_FOUND",
          "Session is absent from the complete canonical resolver cut",
        );
      }
      return clone(target);
    });
  }

  private async resolveCanonicalScopeForAdmission(
    token: RelayV2CanonicalResourceResolverToken,
    scopeId: string,
  ): Promise<RelayV2CanonicalResourceResolutionFence> {
    let result: RelayV2CanonicalResourceResolutionResult;
    try {
      result = { kind: "positive", target: await this.resolveCanonicalScopeTarget(token, scopeId) };
    } catch (error) {
      if (!isRelayV2MaterializedStateError(error) || error.code !== "SCOPE_NOT_FOUND") throw error;
      result = { kind: "complete_negative", code: "SCOPE_NOT_FOUND" };
    }
    return normalizeCanonicalResolutionFence({
      schemaVersion: 1,
      token,
      expectedScopeId: scopeId,
      expectedSessionId: null,
      result,
    });
  }

  private async resolveCanonicalSessionForAdmission(
    token: RelayV2CanonicalResourceResolverToken,
    scopeId: string,
    sessionId: string,
  ): Promise<RelayV2CanonicalResourceResolutionFence> {
    let result: RelayV2CanonicalResourceResolutionResult;
    try {
      result = {
        kind: "positive",
        target: await this.resolveCanonicalSessionTarget(token, scopeId, sessionId),
      };
    } catch (error) {
      if (!isRelayV2MaterializedStateError(error)
        || (error.code !== "SCOPE_NOT_FOUND" && error.code !== "SESSION_NOT_FOUND")) throw error;
      result = { kind: "complete_negative", code: error.code };
    }
    return normalizeCanonicalResolutionFence({
      schemaVersion: 1,
      token,
      expectedScopeId: scopeId,
      expectedSessionId: sessionId,
      result,
    });
  }

  private fenceCanonicalResourceCutForAdmission(
    transaction: RelayV2CommandResolutionTransaction,
    rawFence: RelayV2CanonicalResourceResolutionFence,
  ): void {
    const fence = normalizeCanonicalResolutionFence(rawFence);
    const { token, expectedScopeId, expectedSessionId, result } = fence;
    if (transaction.hostEpoch !== token.hostEpoch) {
      throw new RelayV2MaterializedStateError(
        "CAPABILITY_UNAVAILABLE",
        "canonical target admission fence crossed host lineage",
      );
    }
    if (transaction.getMaterializedReadinessFence() !== null) {
      throw new RelayV2MaterializedStateError(
        "CAPABILITY_UNAVAILABLE",
        "canonical target admission fence observed withdrawn materialized readiness",
      );
    }
    const snapshot = materializedSnapshotForTransaction(transaction, transaction.hostEpoch);
    const state = parseMaterializedState(snapshot);
    const publication = this.requireCanonicalResolver(snapshot, state, token);
    if (result.kind === "complete_negative") {
      const scope = publication.scopes.get(expectedScopeId);
      const exactAbsence = result.code === "SCOPE_NOT_FOUND"
        ? scope === undefined
        : expectedSessionId !== null
          && scope !== undefined
          && !publication.sessions.has(`${expectedScopeId}\0${expectedSessionId}`);
      if (!exactAbsence) {
        throw new RelayV2MaterializedStateError(
          "CAPABILITY_UNAVAILABLE",
          "canonical negative admission evidence is stale or inexact",
        );
      }
      return;
    }
    const target = result.target;
    const exactIdentity = target.scopeId === expectedScopeId
      && (expectedSessionId === null || ("sessionId" in target
        && target.sessionId === expectedSessionId));
    const expected = !exactIdentity
      ? undefined
      : expectedSessionId === null
        ? publication.scopes.get(expectedScopeId)
        : publication.sessions.get(`${expectedScopeId}\0${expectedSessionId}`);
    if (expected === undefined || !sameJson(expected, target)) {
      throw new RelayV2MaterializedStateError(
        "CAPABILITY_UNAVAILABLE",
        "canonical target admission evidence is stale or inexact",
      );
    }
  }

  private requireCanonicalResolver(
    snapshot: RelayV2HostStateSnapshot,
    state: PersistedMaterializedState,
    token?: RelayV2CanonicalResourceResolverToken,
  ): PublishedCanonicalResolver {
    const publication = this.publishedCanonicalResolver;
    if (publication === null
      || !resolverCutIsCurrent(publication.discoveryCut)
      || publication.token.hostEpoch !== snapshot.hostEpoch
      || publication.token.resourceMappingDigest
        !== canonicalResolverResourceMappingDigest(snapshot.hostEpoch, state)
      || (token !== undefined && !sameJson(token, publication.token))) {
      throw new RelayV2MaterializedStateError(
        "CAPABILITY_UNAVAILABLE",
        "canonical target resolver has no current complete discovery cut",
      );
    }
    return publication;
  }

  private publishCanonicalResolver(
    snapshot: RelayV2HostStateSnapshot,
    scan: RelayV2ResourceDiscoveryScan,
  ): void {
    this.publishedCanonicalResolver = null;
    const discoveryCut = scan[RELAY_V2_RESOURCE_RESOLVER_CUT];
    if (discoveryCut === undefined
      || scan.coverage !== "complete"
      || !resolverCutIsCurrent(discoveryCut)) return;
    const state = parseMaterializedState(snapshot);
    if (state.aggregateCoverage !== "complete"
      || !state.aggregateAuthorityEstablished
      || state.scopes.some((scope) => (
        scope.item.reachability !== "online"
        || scope.sessionsCompleteness !== "complete"
        || !scope.sessionsAuthorityEstablished
      ))) return;
    const scopeEvidence = new Map(discoveryCut.scopeTargets.map((target) => (
      [target.scopeBackendIdentity, target]
    )));
    const sessionEvidence = new Map(discoveryCut.sessionTargets.map((target) => [
      resolverEvidenceSessionKey(
        target.scopeBackendIdentity,
        target.backendKind,
        target.sessionBackendIdentity,
      ),
      target,
    ]));
    if (scopeEvidence.size !== state.scopes.length
      || sessionEvidence.size !== state.scopes.reduce((total, scope) => (
        total + scope.sessions.length
      ), 0)) return;
    const scopes = new Map<string, RelayV2CanonicalResolvedScopeTarget>();
    const sessions = new Map<string, RelayV2CanonicalResolvedSessionTarget>();
    for (const scope of state.scopes) {
      const evidence = scopeEvidence.get(scope.backendIdentity);
      if (evidence === undefined || evidence.processTarget.kind !== scope.item.kind) return;
      const resolvedScope: RelayV2CanonicalResolvedScopeTarget = {
        authorization: "evidence_only",
        hostEpoch: snapshot.hostEpoch,
        discoveryGeneration: discoveryCut.generation,
        scopeId: scope.item.scopeId,
        processTarget: clone(evidence.processTarget),
        capabilities: clone(evidence.capabilities),
      };
      scopes.set(scope.item.scopeId, resolvedScope);
      for (const session of scope.sessions) {
        const sessionTarget = sessionEvidence.get(resolverEvidenceSessionKey(
          scope.backendIdentity,
          session.item.kind,
          session.backendIdentity,
        ));
        if (sessionTarget === undefined
          || !sameJson(sessionTarget.processTarget, evidence.processTarget)
          || !sameJson(sessionTarget.capabilities, evidence.capabilities)
          || sessionTarget.managedTarget.kind !== session.item.kind) return;
        sessions.set(`${scope.item.scopeId}\0${session.item.sessionId}`, {
          ...clone(resolvedScope),
          sessionId: session.item.sessionId,
          backendInstanceKey: session.backendIdentity,
          managedTarget: clone(sessionTarget.managedTarget),
        });
      }
    }
    const token: RelayV2CanonicalResourceResolverToken = {
      schemaVersion: 1,
      hostEpoch: snapshot.hostEpoch,
      resourceMappingDigest: canonicalResolverResourceMappingDigest(snapshot.hostEpoch, state),
      discoveryGeneration: discoveryCut.generation,
    };
    this.publishedCanonicalResolver = { token, discoveryCut, scopes, sessions };
  }

  reconcile(): Promise<RelayV2MaterializedReconcileResult> {
    if (this.reconcileInFlight !== null) return this.reconcileInFlight;
    const promise = Promise.resolve().then(() => this.runReconcile());
    this.reconcileInFlight = promise;
    void promise.finally(() => {
      if (this.reconcileInFlight === promise) this.reconcileInFlight = null;
    }).catch(() => {});
    return promise;
  }

  private async runReconcile(): Promise<RelayV2MaterializedReconcileResult> {
    for (let attemptNumber = 1; attemptNumber <= RECONCILE_MAX_ATTEMPTS; attemptNumber += 1) {
      const scanCut = await this.store.serialize((section) => {
        const snapshot = section.read();
        this.observeLineage(snapshot);
        const state = parseMaterializedState(snapshot);
        return {
          hostEpoch: snapshot.hostEpoch,
          generation: state.generation,
          candidates: state.capacityReservations
            .filter((reservation) => (
              reservation.uncertain && reservation.boundBackendIdentity === null
            ))
            .map(fencedNegativeCandidate),
        };
      });
      const scan = normalizeScan(await this.discovery.scan());
      const negativeEvidence = this.reservationSettlementAuthority === undefined
        || scanCut.candidates.length === 0
        ? []
        : normalizeFencedNegativeEvidence(
            await this.reservationSettlementAuthority.fencedNegativeEvidence(
              clone(scanCut.candidates),
            ),
            scanCut.candidates,
          );
      const attempt = await this.store.serialize((section) => {
        const before = section.read();
        this.observeLineage(before);
        const current = parseMaterializedState(before);
        if (before.hostEpoch !== scanCut.hostEpoch
          || current.generation !== scanCut.generation
          || (scan[RELAY_V2_RESOURCE_RESOLVER_CUT] !== undefined
            && !resolverCutIsCurrent(scan[RELAY_V2_RESOURCE_RESOLVER_CUT]))) {
          if (attemptNumber === RECONCILE_MAX_ATTEMPTS) {
            this.latchPersistentWithdrawal(section, "reconcile_generation_conflict");
            return { kind: "exhausted" as const };
          }
          return { kind: "stale" as const };
        }
        let commit: RelayV2HostStateCommit<{
          events: RelayV2JsonObject[];
          authorityConflict: string | null;
        }>;
        try {
          commit = section.transaction((transaction) => {
            const authorityConflict = scanAuthorityConflict(
              current,
              scan,
              negativeEvidence,
            );
            if (authorityConflict !== null) {
              transaction.latchMaterializedReadinessFence(
                "materialized_authority_conflict",
              );
              return { events: [], authorityConflict };
            }
            const mutation = new MaterializedMutation(
              before.hostEpoch,
              current,
              transaction,
              before.revisions,
              this.capacity,
            );
            applyFencedNegativeEvidence(mutation, transaction, scan, negativeEvidence);
            applyDiscovery(mutation, scan);
            const events = finalizeMutation(this.hostId, mutation, transaction);
            transaction.clearMaterializedReadinessFence();
            return { events, authorityConflict: null };
          });
        } catch (error) {
          if (isCommitUncertain(error)) {
            this.fenceCommitUncertain(section.read());
          } else if (isPersistedCapacityError(error)) {
            this.latchPersistentWithdrawal(section, "persisted_capacity_exceeded");
            throw new RelayV2MaterializedStateError(
              "CAPABILITY_UNAVAILABLE",
              "persisted host state budget rejected reconciliation before publication",
            );
          }
          throw error;
        }
        const publication = this.afterCommit(
          commit.snapshot,
          commit.value.events,
          readinessFor(
            commit.snapshot,
            parseMaterializedState(commit.snapshot),
            this.capacity,
          ),
        );
        if (commit.value.authorityConflict === null && publication.accepted) {
          this.publishCanonicalResolver(commit.snapshot, scan);
        } else {
          this.publishedCanonicalResolver = null;
        }
        if (commit.value.authorityConflict !== null) {
          throw new RelayV2MaterializedStateError(
            "INTERNAL",
            commit.value.authorityConflict,
          );
        }
        return {
          kind: "applied" as const,
          value: {
            events: clone(commit.value.events),
            snapshot: commit.snapshot,
            readiness: publication.readiness,
          },
        };
      });
      if (attempt.kind === "applied") return attempt.value;
      if (attempt.kind === "exhausted") {
        throw new RelayV2MaterializedStateError(
          "CAPABILITY_UNAVAILABLE",
          "materialized reconciliation could not obtain a stable H0 generation",
        );
      }
      await waitForReconcileRetry(attemptNumber);
    }
    throw new RelayV2MaterializedStateError("INTERNAL", "unreachable reconciliation retry state");
  }

  /**
   * Captures W, validates a real host.welcome against that cut, registers the
   * W+1 subscriber, and enqueues welcome under the H0 serializer.
   */
  async linearizeWelcome(
    subscriberId: string,
    sink: RelayV2StateEventSink<RelayV2JsonObject>,
    buildWelcome: (cut: RelayV2WelcomeCut) => RelayV2JsonObject,
  ): Promise<RelayV2JsonObject> {
    validateOpaqueInput(subscriberId, "subscriberId");
    const subscriber = captureSubscriber("", sink, null);
    return this.store.serialize((section) => {
      if (this.subscribers.has(subscriberId)) {
        throw new RelayV2MaterializedStateError("BUSY", "subscriber is already active");
      }
      const snapshot = section.read();
      this.observeLineage(snapshot);
      const readiness = readinessFor(snapshot, parseMaterializedState(snapshot), this.capacity);
      if (!readiness.snapshotMaterializationReady) {
        const unavailable = this.continuityFenceReason === null
          ? readiness
          : continuityFenceReadiness(snapshot, this.continuityFenceReason);
        this.applyReadiness(unavailable);
        throw new RelayV2MaterializedStateError(
          "CAPABILITY_UNAVAILABLE",
          `materialized state is not snapshot-ready: ${readiness.reason}`,
        );
      }
      const requiresSnapshot = this.continuityFenceReason !== null;
      const welcome = buildWelcome({
        hostEpoch: snapshot.hostEpoch,
        hostInstanceId: snapshot.hostInstanceId,
        eventSeq: snapshot.eventSeq,
        requiresSnapshot,
      });
      this.validateWelcome(welcome, snapshot, requiresSnapshot);
      if (!this.applyReadiness(readiness)) {
        this.closeAllSubscribers(
          new RelayV2MaterializedStateError("CAPABILITY_UNAVAILABLE", "readiness adapter rejected state"),
        );
        throw new RelayV2MaterializedStateError("CAPABILITY_UNAVAILABLE", "readiness adapter rejected state");
      }
      this.dropSubscribersFromOtherLineages(snapshot.hostEpoch);
      subscriber.epoch = snapshot.hostEpoch;
      this.subscribers.set(subscriberId, subscriber);
      let accepted = false;
      try { accepted = strictSynchronousTrue(subscriber.enqueue(clone(welcome))); } catch {}
      if (!accepted) {
        this.subscribers.delete(subscriberId);
        closeCapturedSubscriber(subscriber, new RelayV2MaterializedStateError(
          "BUSY",
          "subscriber rejected host.welcome synchronously",
        ));
        if (this.continuityFenceReason !== null) {
          this.applyReadiness(continuityFenceReadiness(snapshot, this.continuityFenceReason));
        }
        throw new RelayV2MaterializedStateError("BUSY", "subscriber rejected host.welcome");
      }
      this.continuityFenceReason = null;
      return clone(welcome);
    });
  }

  unsubscribe(subscriberId: string): void {
    this.subscribers.delete(subscriberId);
  }

  async readiness(expectedHostEpoch?: string): Promise<RelayV2MaterializedReadiness> {
    return this.store.serialize((section) => {
      const snapshot = section.read();
      this.observeLineage(snapshot);
      if (expectedHostEpoch !== undefined) assertExpectedEpoch(expectedHostEpoch, snapshot.hostEpoch);
      if (this.continuityFenceReason !== null) {
        return continuityFenceReadiness(snapshot, this.continuityFenceReason);
      }
      return readinessFor(snapshot, parseMaterializedState(snapshot), this.capacity);
    });
  }

  private async currentSnapshotHostEpoch(): Promise<string> {
    return this.store.serialize((section) => {
      const snapshot = section.read();
      this.observeLineage(snapshot);
      return snapshot.hostEpoch;
    });
  }

  private async withSnapshotHostEpochFence<T>(
    expectedHostEpoch: string,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    validateOpaqueInput(expectedHostEpoch, "expectedHostEpoch");
    return this.store.serialize(async (section) => {
      const snapshot = section.read();
      this.observeLineage(snapshot);
      assertExpectedEpoch(expectedHostEpoch, snapshot.hostEpoch);
      return await operation();
    });
  }

  private async captureMaterializedStateCutCandidate(
    expectedHostEpoch: string,
  ): Promise<RelayV2MaterializedStateCutCandidateLease> {
    validateOpaqueInput(expectedHostEpoch, "expectedHostEpoch");
    return this.store.serialize((section) => {
      const now = this.readSnapshotCandidateNow();
      this.pruneExpiredSnapshotCutCandidates(now);
      const snapshot = section.read();
      this.observeLineage(snapshot);
      assertExpectedEpoch(expectedHostEpoch, snapshot.hostEpoch);
      const state = parseMaterializedState(snapshot);
      const readiness = readinessFor(snapshot, state, this.capacity);
      if (!readiness.snapshotMaterializationReady || this.continuityFenceReason !== null) {
        throw new RelayV2MaterializedStateError(
          "CAPABILITY_UNAVAILABLE",
          `materialized state is not snapshot-ready: ${this.continuityFenceReason ?? readiness.reason}`,
          { readinessReason: this.continuityFenceReason ?? readiness.reason },
        );
      }
      if (this.snapshotCutCandidates.size >= this.snapshotCandidateLimits.maxCandidates) {
        throw new RelayV2MaterializedStateError(
          "BUSY",
          "materialized snapshot cut candidate capacity is exhausted",
        );
      }
      const cut = projectMaterializedStateCut(snapshot, state);
      const cutCanonicalBytes = Buffer.byteLength(canonicalJson(cut.records), "utf8");
      if (cut.records.length > readiness.totalRecords
        || cutCanonicalBytes > readiness.totalCanonicalBytes
        || this.snapshotCutCandidateRetainedBytes + cutCanonicalBytes
          > this.snapshotCandidateLimits.maxRetainedBytes) {
        throw new RelayV2MaterializedStateError(
          "BUSY",
          "materialized snapshot cut candidate byte capacity is exhausted",
        );
      }
      const record: MaterializedCutCandidateRecord = {
        hostId: this.hostId,
        hostEpoch: snapshot.hostEpoch,
        hostInstanceId: snapshot.hostInstanceId,
        materializedSourceGeneration: this.materializedSourceGeneration,
        materializedGeneration: state.generation,
        materializedCutIdentity: materializedCutIdentity(
          this.hostId,
          snapshot,
          state,
          cut,
        ),
        cutRecordCount: cut.records.length,
        cutCanonicalBytes,
        subscriptionQueueGeneration: randomBytes(32).toString("base64url"),
        cut,
        sourceIdentity: this.snapshotCutSourceIdentity,
        leaseNonce: randomBytes(32).toString("base64url"),
        subscriptionIdentity: Object.freeze(Object.create(null)) as object,
        capturedAtMs: now,
        expiresAtMs: now + this.snapshotCandidateLimits.candidateTtlMs,
        lastQueuedEventSeq: cut.throughEventSeq,
        bufferedEventCount: 0,
        bufferedCanonicalBytes: 0,
        retainedBytes: cutCanonicalBytes,
        events: [],
      };
      if (!Number.isSafeInteger(record.expiresAtMs)) {
        throw new RelayV2MaterializedStateError(
          "INTERNAL",
          "materialized snapshot cut candidate lifetime overflowed",
        );
      }
      // A function cannot be serialized or structured-cloned. Exact object
      // identity plus the private nonce and source/subscription identities in
      // this registry are the only candidate authority.
      const lease = Object.freeze(() => undefined) as unknown as
        RelayV2MaterializedStateCutCandidateLease;
      this.snapshotCutCandidates.set(lease as object, record);
      this.snapshotCutCandidateRetainedBytes += record.retainedBytes;
      try {
        this.testHooks?.afterSnapshotCandidateSubscriptionInstall?.();
      } catch (error) {
        this.revokeSnapshotCutCandidate(lease as object, record);
        throw error;
      }
      return lease;
    });
  }

  private inspectMaterializedStateCutCandidate(
    lease: RelayV2MaterializedStateCutCandidateLease,
  ): RelayV2MaterializedStateCutCandidate {
    const record = this.materializedStateCutCandidateRecord(lease);
    return clone({
      hostId: record.hostId,
      hostEpoch: record.hostEpoch,
      hostInstanceId: record.hostInstanceId,
      materializedSourceGeneration: record.materializedSourceGeneration,
      materializedGeneration: record.materializedGeneration,
      materializedCutIdentity: record.materializedCutIdentity,
      cutRecordCount: record.cutRecordCount,
      cutCanonicalBytes: record.cutCanonicalBytes,
      subscriptionQueueGeneration: record.subscriptionQueueGeneration,
      cut: record.cut,
    });
  }

  private async withMaterializedStateCutCandidateFence<T>(
    lease: RelayV2MaterializedStateCutCandidateLease,
    operation: (candidate: RelayV2MaterializedStateCutCandidate) => T | Promise<T>,
  ): Promise<T> {
    return this.store.serialize(async (section) => {
      const now = this.readSnapshotCandidateNow();
      this.pruneExpiredSnapshotCutCandidates(now);
      const record = this.materializedStateCutCandidateRecord(lease);
      const snapshot = section.read();
      this.observeLineage(snapshot);
      const state = parseMaterializedState(snapshot);
      const readiness = readinessFor(snapshot, state, this.capacity);
      if (this.continuityFenceReason !== null
        || !readiness.snapshotMaterializationReady
        || this.snapshotCutCandidates.get(lease as object) !== record
        || record.hostId !== this.hostId
        || record.sourceIdentity !== this.snapshotCutSourceIdentity
        || record.materializedSourceGeneration !== this.materializedSourceGeneration
        || record.subscriptionIdentity === null
        || record.hostEpoch !== snapshot.hostEpoch
        || record.hostInstanceId !== snapshot.hostInstanceId
        || record.lastQueuedEventSeq !== snapshot.eventSeq
        || record.cut.hostEpoch !== record.hostEpoch
        || BigInt(record.cut.throughEventSeq) > BigInt(record.lastQueuedEventSeq)
        || record.cut.records.length !== record.cutRecordCount
        || Buffer.byteLength(canonicalJson(record.cut.records), "utf8")
          !== record.cutCanonicalBytes) {
        this.revokeSnapshotCutCandidate(lease as object, record);
        throw new RelayV2MaterializedStateError(
          "CAPABILITY_UNAVAILABLE",
          "materialized snapshot cut candidate lost its exact H0/W+1 authority",
        );
      }
      const result = await operation(this.inspectMaterializedStateCutCandidate(lease));
      if (this.snapshotCutCandidates.get(lease as object) !== record
        || this.readSnapshotCandidateNow() >= record.expiresAtMs) {
        this.revokeSnapshotCutCandidate(lease as object, record);
        throw new RelayV2MaterializedStateError(
          "CAPABILITY_UNAVAILABLE",
          "materialized snapshot cut candidate was withdrawn during verification",
        );
      }
      return result;
    });
  }

  private async activateMaterializedStateCutCandidate(
    lease: RelayV2MaterializedStateCutCandidateLease,
    sink: RelayV2StateEventSink<RelayV2JsonObject>,
    beforeDrain: (candidate: RelayV2MaterializedStateCutCandidate) => true,
    afterAttach: (
      candidate: RelayV2MaterializedStateCutCandidate,
      activation: RelayV2MaterializedStateCutActivationLease,
    ) => true,
  ): Promise<RelayV2MaterializedStateCutActivationLease> {
    if (typeof beforeDrain !== "function" || typeof afterAttach !== "function") {
      closeSubscriber(sink, new RelayV2MaterializedStateError(
        "INVALID_ARGUMENT",
        "materialized snapshot activation fence is invalid",
      ));
      throw new RelayV2MaterializedStateError(
        "INVALID_ARGUMENT",
        "materialized snapshot activation fence is invalid",
      );
    }
    let candidateRecord: MaterializedCutCandidateRecord | undefined;
    let activationRecord: MaterializedCutActivationRecord | undefined;
    let capturedSubscriber: Subscriber | undefined;
    let rollbackApplied = false;
    const rollback = (): void => {
      if (rollbackApplied) return;
      rollbackApplied = true;
      if (activationRecord !== undefined) {
        this.rollbackSnapshotCutActivation(activationRecord, new RelayV2MaterializedStateError(
          "CAPABILITY_UNAVAILABLE",
          "snapshot candidate activation was rolled back",
        ));
      } else if (capturedSubscriber !== undefined) {
        closeCapturedSubscriber(capturedSubscriber, new RelayV2MaterializedStateError(
          "CAPABILITY_UNAVAILABLE",
          "snapshot candidate activation was rolled back",
        ));
      } else {
        closeSubscriber(sink, new RelayV2MaterializedStateError(
          "CAPABILITY_UNAVAILABLE",
          "snapshot candidate activation was rejected",
        ));
      }
      if (candidateRecord !== undefined
        && this.snapshotCutCandidates.get(lease as object) === candidateRecord) {
        this.revokeSnapshotCutCandidate(lease as object, candidateRecord);
      }
    };
    try {
      return await this.store.serialize((section) => {
        try {
        const now = this.readSnapshotCandidateNow();
        this.pruneExpiredSnapshotCutCandidates(now);
        candidateRecord = this.materializedStateCutCandidateRecord(lease);
        const snapshot = section.read();
        this.observeLineage(snapshot);
        const state = parseMaterializedState(snapshot);
        const readiness = readinessFor(snapshot, state, this.capacity);
        if (this.continuityFenceReason !== null
          || !readiness.snapshotMaterializationReady
          || this.snapshotCutCandidates.get(lease as object) !== candidateRecord
          || candidateRecord.sourceIdentity !== this.snapshotCutSourceIdentity
          || candidateRecord.materializedSourceGeneration !== this.materializedSourceGeneration
          || candidateRecord.hostId !== this.hostId
          || candidateRecord.hostEpoch !== snapshot.hostEpoch
          || candidateRecord.hostInstanceId !== snapshot.hostInstanceId
          || candidateRecord.lastQueuedEventSeq !== snapshot.eventSeq
          || candidateRecord.cut.hostEpoch !== candidateRecord.hostEpoch
          || candidateRecord.cut.records.length !== candidateRecord.cutRecordCount
          || Buffer.byteLength(canonicalJson(candidateRecord.cut.records), "utf8")
            !== candidateRecord.cutCanonicalBytes) {
          throw new RelayV2MaterializedStateError(
            "CAPABILITY_UNAVAILABLE",
            "materialized snapshot cut candidate lost authority before activation",
          );
        }
        let expectedEventSeq = BigInt(candidateRecord.cut.throughEventSeq);
        let bufferedBytes = 0;
        for (const event of candidateRecord.events) {
          if (event.hostId !== candidateRecord.hostId
            || event.hostEpoch !== candidateRecord.hostEpoch
            || !isCanonicalCounter(event.eventSeq)
            || BigInt(event.eventSeq) !== expectedEventSeq + 1n) {
            throw new RelayV2MaterializedStateError(
              "CAPABILITY_UNAVAILABLE",
              "materialized snapshot activation buffer is discontinuous",
            );
          }
          expectedEventSeq += 1n;
          bufferedBytes += Buffer.byteLength(JSON.stringify(event), "utf8");
        }
        if (expectedEventSeq.toString() !== candidateRecord.lastQueuedEventSeq
          || candidateRecord.events.length !== candidateRecord.bufferedEventCount
          || bufferedBytes !== candidateRecord.bufferedCanonicalBytes) {
          throw new RelayV2MaterializedStateError(
            "CAPABILITY_UNAVAILABLE",
            "materialized snapshot activation buffer lost its exact queue identity",
          );
        }
        const candidate = this.inspectMaterializedStateCutCandidate(lease);
        if (!strictSynchronousTrue(beforeDrain(candidate))) {
          throw new RelayV2MaterializedStateError(
            "CAPABILITY_UNAVAILABLE",
            "snapshot owner rejected candidate activation before drain",
          );
        }
        const activation = Object.freeze(() => undefined) as unknown as
          RelayV2MaterializedStateCutActivationLease;
        capturedSubscriber = captureSubscriber(
          candidateRecord.hostEpoch,
          sink,
          activation as object,
        );
        for (const event of candidateRecord.events) {
          let accepted = false;
          try {
            accepted = strictSynchronousTrue(capturedSubscriber.enqueue(clone(event)));
          } catch {}
          if (!accepted) {
            throw new RelayV2MaterializedStateError(
              "BUSY",
              "snapshot activation sink rejected its buffered event queue",
            );
          }
        }
        activationRecord = {
          activation,
          sourceIdentity: this.snapshotCutSourceIdentity,
          sourceGeneration: this.materializedSourceGeneration,
          subscriptionIdentity: candidateRecord.subscriptionIdentity,
          subscriptionQueueGeneration: candidateRecord.subscriptionQueueGeneration,
          candidateNonce: candidateRecord.leaseNonce,
          activationNonce: randomBytes(32).toString("base64url"),
          sinkIdentity: sink as object,
          subscriber: capturedSubscriber,
        };
        this.snapshotCutActivations.set(activation as object, activationRecord);
        this.subscribers.set(candidateRecord.subscriptionIdentity, capturedSubscriber);
        if (!strictSynchronousTrue(afterAttach(candidate, activation))) {
          throw new RelayV2MaterializedStateError(
            "CAPABILITY_UNAVAILABLE",
            "snapshot owner rejected candidate activation after attach",
          );
        }
        if (this.snapshotCutCandidates.get(lease as object) !== candidateRecord
          || this.subscribers.get(candidateRecord.subscriptionIdentity) !== capturedSubscriber
          || this.snapshotCutActivations.get(activation as object) !== activationRecord) {
          throw new RelayV2MaterializedStateError(
            "CAPABILITY_UNAVAILABLE",
            "snapshot activation lost exact candidate or subscriber identity",
          );
        }
        this.revokeSnapshotCutCandidate(lease as object, candidateRecord);
        return activation;
        } catch (error) {
          rollback();
          throw error;
        }
      });
    } catch (error) {
      rollback();
      throw error;
    }
  }

  private releaseMaterializedStateCutActivation(
    activation: RelayV2MaterializedStateCutActivationLease,
  ): void {
    if ((typeof activation !== "object" && typeof activation !== "function")
      || activation === null) return;
    const record = this.snapshotCutActivations.get(activation as object);
    if (record === undefined
      || record.sourceIdentity !== this.snapshotCutSourceIdentity
      || record.sourceGeneration !== this.materializedSourceGeneration
      || record.activationNonce.length !== 43) return;
    this.rollbackSnapshotCutActivation(record, new RelayV2MaterializedStateError(
      "CAPABILITY_UNAVAILABLE",
      "snapshot activation was released",
    ));
  }

  private async withdrawSnapshotOwnerAuthority(): Promise<void> {
    await this.store.serialize(() => {
      this.invalidateSnapshotCutCandidates();
      this.invalidateSnapshotCutActivations(new RelayV2MaterializedStateError(
        "CAPABILITY_UNAVAILABLE",
        "snapshot spool owner changed",
      ));
    });
  }

  private rollbackSnapshotCutActivation(
    record: MaterializedCutActivationRecord,
    error: RelayV2MaterializedStateError,
  ): void {
    if (this.snapshotCutActivations.get(record.activation as object) !== record) return;
    this.snapshotCutActivations.delete(record.activation as object);
    if (this.subscribers.get(record.subscriptionIdentity) === record.subscriber) {
      this.subscribers.delete(record.subscriptionIdentity);
    }
    closeCapturedSubscriber(record.subscriber, error);
  }

  private invalidateSnapshotCutActivations(error: RelayV2MaterializedStateError): void {
    for (const record of [...this.snapshotCutActivations.values()]) {
      this.rollbackSnapshotCutActivation(record, error);
    }
  }

  private releaseMaterializedStateCutCandidate(
    lease: RelayV2MaterializedStateCutCandidateLease,
  ): void {
    if ((typeof lease !== "object" && typeof lease !== "function") || lease === null) return;
    const record = this.snapshotCutCandidates.get(lease as object);
    if (record !== undefined) this.revokeSnapshotCutCandidate(lease as object, record);
  }

  private materializedStateCutCandidateRecord(
    lease: RelayV2MaterializedStateCutCandidateLease,
  ): MaterializedCutCandidateRecord {
    if ((typeof lease !== "object" && typeof lease !== "function") || lease === null) {
      throw new RelayV2MaterializedStateError(
        "INVALID_ARGUMENT",
        "materialized snapshot cut candidate lease is invalid",
      );
    }
    const record = this.snapshotCutCandidates.get(lease as object);
    if (record !== undefined && this.readSnapshotCandidateNow() >= record.expiresAtMs) {
      this.revokeSnapshotCutCandidate(lease as object, record);
    }
    const current = this.snapshotCutCandidates.get(lease as object);
    if (current === undefined
      || current.sourceIdentity !== this.snapshotCutSourceIdentity
      || current.materializedSourceGeneration !== this.materializedSourceGeneration
      || current.leaseNonce.length !== 43
      || current.subscriptionQueueGeneration.length !== 43) {
      throw new RelayV2MaterializedStateError(
        "INVALID_ARGUMENT",
        "materialized snapshot cut candidate lease is invalid or withdrawn",
      );
    }
    return current;
  }

  private readSnapshotCandidateNow(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new RelayV2MaterializedStateError(
        "INTERNAL",
        "materialized snapshot candidate clock is invalid",
      );
    }
    return now;
  }

  private pruneExpiredSnapshotCutCandidates(now: number): void {
    for (const [lease, record] of this.snapshotCutCandidates) {
      if (now >= record.expiresAtMs) this.revokeSnapshotCutCandidate(lease, record);
    }
  }

  private revokeSnapshotCutCandidate(
    lease: object,
    record: MaterializedCutCandidateRecord,
  ): void {
    if (this.snapshotCutCandidates.get(lease) !== record) return;
    this.snapshotCutCandidates.delete(lease);
    this.snapshotCutCandidateRetainedBytes = Math.max(
      0,
      this.snapshotCutCandidateRetainedBytes - record.retainedBytes,
    );
    record.events.length = 0;
    record.bufferedEventCount = 0;
    record.bufferedCanonicalBytes = 0;
    record.retainedBytes = 0;
  }

  private async estimateMaterializedStateCutAdmission(
    expectedHostEpoch: string,
  ): Promise<RelayV2MaterializedStateCutAdmissionEstimate> {
    validateOpaqueInput(expectedHostEpoch, "expectedHostEpoch");
    return this.store.serialize((section) => {
      const snapshot = section.read();
      this.observeLineage(snapshot);
      assertExpectedEpoch(expectedHostEpoch, snapshot.hostEpoch);
      const state = parseMaterializedState(snapshot);
      const readiness = readinessFor(snapshot, state, this.capacity);
      if (!readiness.snapshotMaterializationReady) {
        throw new RelayV2MaterializedStateError(
          "CAPABILITY_UNAVAILABLE",
          `materialized state is not snapshot-ready: ${readiness.reason}`,
          { readinessReason: readiness.reason },
        );
      }
      return {
        hostEpoch: snapshot.hostEpoch,
        totalRecords: readiness.totalRecords,
        totalCanonicalBytes: readiness.totalCanonicalBytes,
      };
    });
  }

  async scopesSnapshot(
    requestId: string,
    expectedHostEpoch: string,
  ): Promise<RelayV2JsonObject> {
    validateOpaqueInput(requestId, "requestId");
    return this.store.serialize((section) => {
      const snapshot = section.read();
      this.observeLineage(snapshot);
      assertExpectedEpoch(expectedHostEpoch, snapshot.hostEpoch);
      const state = parseMaterializedState(snapshot);
      const frame = {
        protocolVersion: 2,
        kind: "response",
        type: "scopes.snapshot",
        requestId,
        hostId: this.hostId,
        hostEpoch: snapshot.hostEpoch,
        payload: {
          coverageComplete: state.aggregateCoverage === "complete",
          revision: revisionFor(snapshot, SCOPES_REVISION_KEY),
          throughEventSeq: null,
          items: [...state.scopes]
            .sort((left, right) => utf8Compare(left.item.scopeId, right.item.scopeId))
            .map((scope) => clone(scope.item)),
        },
      } as unknown as RelayV2JsonObject;
      ensureConvenienceFrame(frame);
      return frame;
    });
  }

  async sessionsSnapshot(
    requestId: string,
    expectedHostEpoch: string,
    scopeIds: readonly string[] | null,
  ): Promise<RelayV2JsonObject> {
    validateOpaqueInput(requestId, "requestId");
    if (scopeIds !== null) {
      if (scopeIds.length === 0 || scopeIds.length > 100 || new Set(scopeIds).size !== scopeIds.length) {
        throw new RelayV2MaterializedStateError(
          "INVALID_ARGUMENT",
          "scopeIds must contain 1..100 unique IDs",
        );
      }
      for (const scopeId of scopeIds) validateOpaqueInput(scopeId, "scopeId");
    }
    return this.store.serialize((section) => {
      const snapshot = section.read();
      this.observeLineage(snapshot);
      assertExpectedEpoch(expectedHostEpoch, snapshot.hostEpoch);
      const state = parseMaterializedState(snapshot);
      const byId = new Map(state.scopes.map((scope) => [scope.item.scopeId, scope]));
      const selected = scopeIds === null
        ? [...state.scopes]
        : scopeIds.map((scopeId) => {
            const scope = byId.get(scopeId);
            if (!scope) throw new RelayV2MaterializedStateError("SCOPE_NOT_FOUND", "scope is not materialized");
            return scope;
          });
      selected.sort((left, right) => utf8Compare(left.item.scopeId, right.item.scopeId));
      const frame = {
        protocolVersion: 2,
        kind: "response",
        type: "sessions.snapshot",
        requestId,
        hostId: this.hostId,
        hostEpoch: snapshot.hostEpoch,
        payload: {
          coverageComplete: scopeIds === null
            && state.aggregateCoverage === "complete"
            && selected.every((scope) => scope.sessionsCompleteness === "complete"),
          throughEventSeq: null,
          scopes: selected.map((scope) => ({
            scopeId: scope.item.scopeId,
            revision: revisionFor(snapshot, sessionRevisionKey(scope.item.scopeId)),
            completeness: scope.sessionsCompleteness,
            items: [...scope.sessions]
              .sort((left, right) => utf8Compare(left.item.sessionId, right.item.sessionId))
              .map((session) => clone(session.item)),
            error: clone(scope.sessionsError),
          })),
        },
      } as unknown as RelayV2JsonObject;
      ensureConvenienceFrame(frame);
      return frame;
    });
  }

  private afterCommit(
    snapshot: RelayV2HostStateSnapshot,
    events: readonly RelayV2JsonObject[],
    readiness: RelayV2MaterializedReadiness,
  ): MaterializedPublicationOutcome {
    this.observeLineage(snapshot);
    this.dropSubscribersFromOtherLineages(snapshot.hostEpoch);
    const effectiveReadiness = this.continuityFenceReason === null
      ? readiness
      : continuityFenceReadiness(snapshot, this.continuityFenceReason);
    const accepted = this.applyReadiness(effectiveReadiness)
      && effectiveReadiness.snapshotMaterializationReady;
    if (!accepted) {
      this.publishedCanonicalResolver = null;
      this.closeAllSubscribers(new RelayV2MaterializedStateError(
        "CAPABILITY_UNAVAILABLE",
        `materialized readiness withdrawn: ${effectiveReadiness.reason}`,
      ));
      return { readiness: effectiveReadiness, accepted: false };
    }
    for (const event of events) this.publishEvent(event);
    return { readiness: effectiveReadiness, accepted: true };
  }

  private fenceCommitUncertain(snapshot: RelayV2HostStateSnapshot): void {
    this.invalidateSnapshotCutCandidates();
    this.publishedCanonicalResolver = null;
    this.observedHostEpoch = snapshot.hostEpoch;
    this.continuityFenceReason = "commit_uncertain";
    this.applyReadiness(continuityFenceReadiness(snapshot, "commit_uncertain"));
    this.closeAllSubscribers(new RelayV2MaterializedStateError(
      "INTERNAL",
      "host state commit disposition is uncertain; reconnect and snapshot are required",
    ));
  }

  private withdrawReadiness(
    snapshot: RelayV2HostStateSnapshot,
    reason: "persisted_capacity_exceeded"
      | "reconcile_generation_conflict"
      | "materialized_authority_conflict",
  ): void {
    this.invalidateSnapshotCutCandidates();
    this.publishedCanonicalResolver = null;
    const readiness = withdrawnReadiness(snapshot, reason);
    this.applyReadiness(readiness);
    this.closeAllSubscribers(new RelayV2MaterializedStateError(
      "CAPABILITY_UNAVAILABLE",
      `materialized readiness withdrawn: ${reason}`,
    ));
  }

  private latchPersistentWithdrawal(
    section: RelayV2HostStateCriticalSection,
    reason: "persisted_capacity_exceeded"
      | "reconcile_generation_conflict"
      | "materialized_authority_conflict",
  ): RelayV2HostStateSnapshot {
    try {
      const commit = section.latchMaterializedReadinessFence(reason);
      this.withdrawReadiness(commit.snapshot, reason);
      return commit.snapshot;
    } catch (error) {
      if (isCommitUncertain(error)) this.fenceCommitUncertain(section.read());
      throw error;
    }
  }

  private observeLineage(snapshot: RelayV2HostStateSnapshot): void {
    if (this.observedHostEpoch === null) {
      this.observedHostEpoch = snapshot.hostEpoch;
      return;
    }
    if (this.observedHostEpoch === snapshot.hostEpoch) return;
    this.invalidateSnapshotCutCandidates();
    this.publishedCanonicalResolver = null;
    this.observedHostEpoch = snapshot.hostEpoch;
    this.continuityFenceReason = "host_epoch_changed";
    this.applyReadiness(continuityFenceReadiness(snapshot, "host_epoch_changed"));
    this.closeAllSubscribers(new RelayV2MaterializedStateError(
      "HOST_EPOCH_MISMATCH",
      "host lineage changed while H2 was active; reconnect and snapshot are required",
    ));
  }

  private applyReadiness(readiness: RelayV2MaterializedReadiness): boolean {
    let accepted = false;
    try {
      accepted = strictSynchronousTrue(this.readinessSink.apply(clone(readiness)));
    } catch {
      accepted = false;
    }
    if (!accepted || !readiness.snapshotMaterializationReady || readiness.closeV2Routes) {
      this.invalidateSnapshotCutCandidates();
      this.publishedCanonicalResolver = null;
    }
    return accepted;
  }

  private validateWelcome(
    welcome: RelayV2JsonObject,
    snapshot: RelayV2HostStateSnapshot,
    requiresSnapshot: boolean,
  ): void {
    const payload = isRecord(welcome.payload) ? welcome.payload : null;
    if (
      welcome.type !== "host.welcome"
      || welcome.hostId !== this.hostId
      || welcome.hostEpoch !== snapshot.hostEpoch
      || welcome.hostInstanceId !== snapshot.hostInstanceId
      || payload?.eventSeq !== snapshot.eventSeq
      || (requiresSnapshot && payload.resumeDisposition !== "snapshot_required")
    ) {
      throw new RelayV2MaterializedStateError(
        "INVALID_ARGUMENT",
        "host.welcome does not match the captured materialized cut",
      );
    }
    try {
      encodeRelayV2WebSocketFrame("public", welcome);
    } catch {
      throw new RelayV2MaterializedStateError("INVALID_ARGUMENT", "host.welcome violates v2 schema");
    }
  }

  private publishEvent(event: RelayV2JsonObject): void {
    for (const [subscriberId, subscriber] of this.subscribers) {
      let accepted = false;
      if (subscriber.epoch === event.hostEpoch) {
        try { accepted = strictSynchronousTrue(subscriber.enqueue(clone(event))); } catch {}
      }
      if (accepted) continue;
      this.retireSubscriber(subscriberId, subscriber, new RelayV2MaterializedStateError(
        "BUSY",
        "subscriber queue cannot preserve event continuity",
      ));
    }
    this.publishSnapshotCandidateEvent(event);
  }

  private publishSnapshotCandidateEvent(event: RelayV2JsonObject): void {
    const now = this.readSnapshotCandidateNow();
    this.pruneExpiredSnapshotCutCandidates(now);
    for (const [lease, record] of [...this.snapshotCutCandidates]) {
      let eventBytes = 0;
      let nextIsContinuous = false;
      try {
        if (!isCanonicalCounter(event.eventSeq)) throw new Error("invalid eventSeq");
        eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
        nextIsContinuous = BigInt(event.eventSeq)
          === BigInt(record.lastQueuedEventSeq) + 1n;
      } catch {
        nextIsContinuous = false;
      }
      if (event.hostId !== record.hostId
        || event.hostEpoch !== record.hostEpoch
        || !nextIsContinuous
        || record.bufferedEventCount + 1
          > this.snapshotCandidateLimits.maxBufferedEventsPerCandidate
        || record.bufferedCanonicalBytes + eventBytes
          > this.snapshotCandidateLimits.maxBufferedBytesPerCandidate
        || this.snapshotCutCandidateRetainedBytes + eventBytes
          > this.snapshotCandidateLimits.maxRetainedBytes) {
        this.revokeSnapshotCutCandidate(lease, record);
        continue;
      }
      record.events.push(clone(event));
      record.lastQueuedEventSeq = event.eventSeq as string;
      record.bufferedEventCount += 1;
      record.bufferedCanonicalBytes += eventBytes;
      record.retainedBytes += eventBytes;
      this.snapshotCutCandidateRetainedBytes += eventBytes;
    }
  }

  private dropSubscribersFromOtherLineages(hostEpoch: string): void {
    for (const [subscriberId, subscriber] of this.subscribers) {
      if (subscriber.epoch === hostEpoch) continue;
      this.retireSubscriber(subscriberId, subscriber, new RelayV2MaterializedStateError(
        "HOST_EPOCH_MISMATCH",
        "host lineage changed",
      ));
    }
  }

  private closeAllSubscribers(error: RelayV2MaterializedStateError): void {
    for (const [subscriberId, subscriber] of [...this.subscribers]) {
      this.retireSubscriber(subscriberId, subscriber, error);
    }
  }

  private retireSubscriber(
    subscriberId: string | object,
    subscriber: Subscriber,
    error: RelayV2MaterializedStateError,
  ): void {
    if (this.subscribers.get(subscriberId) === subscriber) {
      this.subscribers.delete(subscriberId);
    }
    if (subscriber.activationLease !== null) {
      const activation = this.snapshotCutActivations.get(subscriber.activationLease);
      if (activation !== undefined && activation.subscriber === subscriber) {
        this.snapshotCutActivations.delete(subscriber.activationLease);
      }
    }
    closeCapturedSubscriber(subscriber, error);
  }

  private invalidateSnapshotCutCandidates(): void {
    for (const [lease, record] of [...this.snapshotCutCandidates]) {
      this.revokeSnapshotCutCandidate(lease, record);
    }
  }
}
