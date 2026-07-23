import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type {
  TerminalControlLease,
  TerminalControlOwner,
} from "../../terminalControl/protocol.js";
import type { RelayV2JsonObject } from "./codecSchema.js";
import { issueRelayV2CanonicalBackendInstanceKey } from "./canonicalBackendIdentity.js";
import type {
  RelayV2CanonicalResolvedSessionTarget,
  RelayV2CanonicalResourceResolverToken,
} from "./resourceState.js";
import type { RelayV2HostStateTransaction } from "./hostState.js";
import type { RelayV2JsonValue } from "./strictJson.js";

export const RELAY_V2_TERMINAL_STREAM_RING_BYTES = 4 * 1024 * 1024;
export const RELAY_V2_TERMINAL_HOST_RING_BYTES = 64 * 1024 * 1024;
export const RELAY_V2_TERMINAL_MAX_UNACKED_BYTES = 512 * 1024;
export const RELAY_V2_TERMINAL_DETACHED_LEASE_MS = 120_000;
export const RELAY_V2_TERMINAL_CONTROL_RETENTION_MS = 600_000;
export const RELAY_V2_TERMINAL_MAX_FRAME_BYTES = 64 * 1024;
export const RELAY_V2_TERMINAL_INPUT_DEDUPE_ENTRIES = 512;
export const RELAY_V2_TERMINAL_RESIZE_DEDUPE_ENTRIES = 256;
export const RELAY_V2_TERMINAL_MAX_STREAMS = 256;
export const RELAY_V2_TERMINAL_MAX_CONTROL_RECORDS = 4_096;

const MAX_COUNTER = 18_446_744_073_709_551_615n;

export interface RelayV2TerminalLimits {
  streamRingBytes: number;
  hostRingBytes: number;
  maxUnackedBytes: number;
  detachedLeaseMs: number;
  controlRetentionMs: number;
  maxFrameBytes: number;
  inputDedupeEntries: number;
  resizeDedupeEntries: number;
  maxStreams: number;
  maxControlRecords: number;
}

export const RELAY_V2_TERMINAL_LIMITS: Readonly<RelayV2TerminalLimits> = Object.freeze({
  streamRingBytes: RELAY_V2_TERMINAL_STREAM_RING_BYTES,
  hostRingBytes: RELAY_V2_TERMINAL_HOST_RING_BYTES,
  maxUnackedBytes: RELAY_V2_TERMINAL_MAX_UNACKED_BYTES,
  detachedLeaseMs: RELAY_V2_TERMINAL_DETACHED_LEASE_MS,
  controlRetentionMs: RELAY_V2_TERMINAL_CONTROL_RETENTION_MS,
  maxFrameBytes: RELAY_V2_TERMINAL_MAX_FRAME_BYTES,
  inputDedupeEntries: RELAY_V2_TERMINAL_INPUT_DEDUPE_ENTRIES,
  resizeDedupeEntries: RELAY_V2_TERMINAL_RESIZE_DEDUPE_ENTRIES,
  maxStreams: RELAY_V2_TERMINAL_MAX_STREAMS,
  maxControlRecords: RELAY_V2_TERMINAL_MAX_CONTROL_RECORDS,
});

export type RelayV2TerminalErrorCode =
  | "BUSY"
  | "CAPABILITY_UNAVAILABLE"
  | "HOST_EPOCH_MISMATCH"
  | "INVALID_ARGUMENT"
  | "PERMISSION_DENIED"
  | "TERMINAL_STREAM_NOT_FOUND"
  | "TERMINAL_STREAM_CONFLICT"
  | "TERMINAL_OPEN_CONFLICT"
  | "TERMINAL_CLOSE_CONFLICT"
  | "TERMINAL_ROUTE_STALE"
  | "TERMINAL_GENERATION_STALE"
  | "TERMINAL_OFFSET_EXPIRED"
  | "TERMINAL_INVALID_ACK"
  | "TERMINAL_INPUT_GAP"
  | "TERMINAL_INPUT_CONFLICT"
  | "TERMINAL_RESIZE_GAP"
  | "TERMINAL_RESIZE_CONFLICT"
  | "INTERNAL";

const RELAY_V2_TERMINAL_MANAGER_ERROR = Symbol.for(
  "tmux-worktree.relay-v2.terminal-manager-error",
);

export class RelayV2TerminalManagerError extends Error {
  readonly [RELAY_V2_TERMINAL_MANAGER_ERROR] = true;

  constructor(
    readonly code: RelayV2TerminalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RelayV2TerminalManagerError";
  }
}

export function isRelayV2TerminalManagerError(
  error: unknown,
): error is RelayV2TerminalManagerError {
  return !!error
    && typeof error === "object"
    && (error as Record<PropertyKey, unknown>)[RELAY_V2_TERMINAL_MANAGER_ERROR] === true;
}

export interface RelayV2TerminalAuthContext {
  principalId: string;
  clientInstanceId: string;
}

/** Frozen public route lineage. This is the only route shape allowed durably. */
export interface RelayV2TerminalRoute {
  connectorId: string;
  routeId: string;
  routeFence: string;
}

declare const RELAY_V2_TERMINAL_RUNTIME_BINDING_TOKEN: unique symbol;

export type RelayV2TerminalRuntimeBindingToken = string & {
  readonly [RELAY_V2_TERMINAL_RUNTIME_BINDING_TOKEN]: true;
};

/** Process-local runtime↔H3 envelope. Never persisted or put on the wire. */
export interface RelayV2TerminalRuntimeBinding extends RelayV2TerminalRoute {
  runtimeBindingToken: RelayV2TerminalRuntimeBindingToken;
}

export function createRelayV2TerminalRuntimeBinding(
  route: RelayV2TerminalRoute,
  runtimeBindingToken: string,
): RelayV2TerminalRuntimeBinding {
  if (!isOpaqueId(route.connectorId)
    || !isOpaqueId(route.routeId)
    || !isOpaqueId(route.routeFence)
    || !isOpaqueId(runtimeBindingToken)) {
    throw new RelayV2TerminalManagerError("INVALID_ARGUMENT", "terminal runtime binding is invalid");
  }
  return Object.freeze({
    connectorId: route.connectorId,
    routeId: route.routeId,
    routeFence: route.routeFence,
    runtimeBindingToken: runtimeBindingToken as RelayV2TerminalRuntimeBindingToken,
  });
}

export interface RelayV2TerminalWireTarget {
  hostId: string;
  scopeId: string;
  sessionId: string;
}

export interface RelayV2TerminalResolvedTarget extends RelayV2TerminalWireTarget {
  pane: number;
  /** Opaque H2 lifecycle identity. It is never part of a wire fingerprint. */
  canonicalTargetId: string;
  /** Opaque terminal-control identity, supplied only by the canonical resolver. */
  controlTargetId: string;
}

export interface RelayV2TerminalExactControlIdentityV1 {
  schemaVersion: 1;
  controlTargetId: string;
  controlEpoch: string;
  /** Opaque proof for the exact tmux target incarnation, not a session name. */
  targetIncarnationProof: string;
}

/**
 * Durable, non-secret execution binding prepared before any terminal effect.
 * This is a local H0 schema, not Relay wire state or terminal-control v1.
 */
export interface RelayV2TerminalCanonicalTargetBindingV1 {
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
    /** Canonical twinc2 incarnation supplied by H2. */
    incarnation: string;
  };
  exactControlIdentity: RelayV2TerminalExactControlIdentityV1;
}

export interface RelayV2TerminalCanonicalResolution {
  target: RelayV2TerminalResolvedTarget;
  binding: RelayV2TerminalCanonicalTargetBindingV1;
  /** Volatile H2 evidence used only by the synchronous H0 admission fence. */
  admission: {
    resourceToken: RelayV2CanonicalResourceResolverToken;
    resourceTarget: RelayV2CanonicalResolvedSessionTarget;
    /** Volatile token for the independent exact-control resolver. */
    exactControlToken: string;
  };
}

const RELAY_V2_TERMINAL_EXACT_EFFECT_TARGET = Symbol.for(
  "tmux-worktree.relay-v2.terminal-exact-effect-target",
);

/**
 * Process-local, non-separable proof that H0 committed the complete binding.
 * Effect adapters must definitely verify this whole precondition before any
 * attach, observation, lease, input, resize, or backend mutation. The frozen
 * terminal-control v1 adapter cannot implement that contract and must reject
 * this shape before calling its client.
 */
export interface RelayV2TerminalExactEffectTargetV1 {
  readonly schemaVersion: 1;
  readonly resolvedTarget: RelayV2TerminalResolvedTarget;
  readonly binding: RelayV2TerminalCanonicalTargetBindingV1;
  readonly [RELAY_V2_TERMINAL_EXACT_EFFECT_TARGET]: true;
}

export interface RelayV2TerminalCanonicalResolver {
  resolve(input: {
    auth: RelayV2TerminalAuthContext;
    hostEpoch: string;
    target: RelayV2TerminalWireTarget;
    pane: number;
  }): Promise<RelayV2TerminalCanonicalResolution>;
  /** Called synchronously inside the H0 prepare transaction. */
  fenceSessionForAdmission(
    transaction: RelayV2HostStateTransaction,
    resolution: RelayV2TerminalCanonicalResolution,
  ): void;
}

export interface RelayV2TerminalRequestContext {
  auth: RelayV2TerminalAuthContext;
  route: RelayV2TerminalRuntimeBinding;
  requestId: string;
  expectedHostEpoch: string;
  target: RelayV2TerminalWireTarget;
  streamId: string;
}

export interface RelayV2TerminalResume {
  generation: string;
  /** Present only for mode=resume; mode=reset forbids this field. */
  nextOffset?: string;
  resumeToken: string;
}

export interface RelayV2TerminalOpenRequest extends RelayV2TerminalRequestContext {
  openId: string;
  pane: number;
  cols: number;
  rows: number;
  mode: "new" | "resume" | "reset";
  resume?: RelayV2TerminalResume;
}

/**
 * Process-local H3 callback evidence for an origin=open reset response. The
 * durable winner may contain a generation/offset that did not exist in the
 * original mode=new/reset request. This evidence is never wire or durable
 * state; the runtime consumes it only to arm its exact pending correlation.
 */
export interface RelayV2TerminalOpenResponseLineage {
  owner: "terminal.open";
  requestId: string;
  openId: string;
  mode: "new" | "resume" | "reset";
  generation: string | null;
  requestedOffset: string | null;
}

export interface RelayV2TerminalReplayRequest extends RelayV2TerminalRequestContext {
  generation: string;
  fromOffset: string;
}

export interface RelayV2TerminalCloseRequest extends RelayV2TerminalRequestContext {
  closeId: string;
  generation: string;
  resumeToken: string;
}

export interface RelayV2TerminalStreamContext {
  auth: RelayV2TerminalAuthContext;
  route: RelayV2TerminalRuntimeBinding;
  streamId: string;
  generation: string;
}

export interface RelayV2TerminalOutputAck extends RelayV2TerminalStreamContext {
  nextOffset: string;
}

export interface RelayV2TerminalInput extends RelayV2TerminalStreamContext {
  inputSeq: string;
  data: Uint8Array;
}

export interface RelayV2TerminalResize extends RelayV2TerminalStreamContext {
  resizeSeq: string;
  cols: number;
  rows: number;
}

export type RelayV2TerminalCloseReason =
  | "client_closed"
  | "backend_exit"
  | "backend_error";

export type RelayV2TerminalResetReason =
  | "generation_stale"
  | "offset_expired"
  | "stream_lost"
  | "slow_consumer"
  | "host_buffer_pressure";

export interface RelayV2TerminalBackendClose {
  reason: "backend_exit" | "backend_error";
  exitCode: number | null;
}

export interface RelayV2TerminalBackendObserver {
  /**
   * The backend must await every callback in source order and deliver onClosed
   * only after the final onBytes callback has completed. Each callback must be
   * no larger than maxChunkBytes passed to open; oversize is a hard backend
   * protocol failure and is rejected before the manager copies it.
   */
  onBytes(data: Uint8Array): Promise<void>;
  onClosed(result: RelayV2TerminalBackendClose): Promise<void>;
}

export interface RelayV2TerminalByteHandle {
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Attachment-local display hint only; it must never resize the shared target. */
  setDisplaySizeHint(size: { cols: number; rows: number }): Promise<void>;
  /**
   * Closes only this observation attachment; it does not mutate the canonical
   * terminal target.
   * It must not wait for an observer callback, because callbacks re-enter the
   * manager serializer after the generation has already been fenced.
   */
  close(): Promise<void>;
}

export interface RelayV2TerminalByteBackend {
  /**
   * Opens a raw-byte observation attachment. Implementations must return the
   * handle before awaiting an observer callback, so terminal.opened remains the
   * first frame for the generation.
   */
  open(
    target: RelayV2TerminalExactEffectTargetV1,
    options: {
      maxChunkBytes: number;
      displaySizeHint: { cols: number; rows: number };
    },
    observer: RelayV2TerminalBackendObserver,
  ): Promise<RelayV2TerminalByteHandle>;
}

export interface RelayV2TerminalStructuredError {
  code:
    | "PERMISSION_DENIED"
    | "BUSY"
    | "SLOW_CONSUMER"
    | "SCOPE_NOT_FOUND"
    | "SCOPE_UNREACHABLE"
    | "SESSION_NOT_FOUND"
    | "PANE_NOT_FOUND"
    | "TERMINAL_INPUT_GAP"
    | "TERMINAL_INPUT_CONFLICT"
    | "TERMINAL_RESIZE_GAP"
    | "TERMINAL_RESIZE_CONFLICT"
    | "COMMAND_IN_DOUBT"
    | "INTERNAL";
  message: string;
  retryable: boolean;
  details?: RelayV2JsonValue;
  commandDisposition?: "not_applicable" | "in_doubt";
}

export type RelayV2TerminalAuthorityResult =
  | { accepted: true }
  | {
      accepted: false;
      uncertain: boolean;
      error: RelayV2TerminalStructuredError;
    };

export type RelayV2TerminalLeaseResult =
  | { status: "accepted"; lease: RelayV2TerminalProducerLease }
  | { status: "rejected"; error: RelayV2TerminalStructuredError }
  | { status: "uncertain"; error: RelayV2TerminalStructuredError };

export interface RelayV2TerminalAuthorityInput {
  target: RelayV2TerminalExactEffectTargetV1;
  auth: RelayV2TerminalAuthContext;
  owner: TerminalControlOwner;
  lease: RelayV2TerminalProducerLease;
  operationId: string;
  data: Uint8Array;
}

export interface RelayV2TerminalAuthorityResize {
  target: RelayV2TerminalExactEffectTargetV1;
  auth: RelayV2TerminalAuthContext;
  owner: TerminalControlOwner;
  lease: RelayV2TerminalProducerLease;
  operationId: string;
  cols: number;
  rows: number;
}

export type RelayV2TerminalProducerLease = TerminalControlLease;

export interface RelayV2TerminalControlAuthority {
  acquire(input: {
    target: RelayV2TerminalExactEffectTargetV1;
    auth: RelayV2TerminalAuthContext;
    owner: TerminalControlOwner;
  }): Promise<RelayV2TerminalLeaseResult>;
  renew(input: {
    target: RelayV2TerminalExactEffectTargetV1;
    auth: RelayV2TerminalAuthContext;
    owner: TerminalControlOwner;
    lease: RelayV2TerminalProducerLease;
  }): Promise<RelayV2TerminalLeaseResult>;
  release(input: {
    target: RelayV2TerminalExactEffectTargetV1;
    auth: RelayV2TerminalAuthContext;
    owner: TerminalControlOwner;
    lease: RelayV2TerminalProducerLease;
  }): Promise<void>;
  hasContinuity(input: {
    target: RelayV2TerminalExactEffectTargetV1;
    auth: RelayV2TerminalAuthContext;
    owner: TerminalControlOwner;
    lease: RelayV2TerminalProducerLease;
  }): Promise<boolean>;
  writeInput(input: RelayV2TerminalAuthorityInput): Promise<RelayV2TerminalAuthorityResult>;
  resize(input: RelayV2TerminalAuthorityResize): Promise<RelayV2TerminalAuthorityResult>;
}

export interface RelayV2TerminalDurableOpenClaim {
  key: string;
  streamKey: string;
  fingerprint: string;
  hostInstanceId: string;
  /** Explicit non-secret binding evidence; H0 must not infer it from fingerprint. */
  target: RelayV2TerminalWireTarget;
  pane: number;
  /** Null only when the request carries no resume capability. Never plaintext. */
  resumeTokenHash: string | null;
  mode: "new" | "resume" | "reset";
  previousGeneration: string | null;
  /** Non-sensitive recovery evidence for pending resume/reset claims. */
  requestedOffset: string | null;
  expiresAtMs: number;
}

export interface RelayV2TerminalDurableStreamBinding {
  generation: string;
  target: RelayV2TerminalWireTarget;
  pane: number;
  resumeTokenHash: string;
  canonicalBinding: RelayV2TerminalCanonicalTargetBindingV1;
}

export type RelayV2TerminalDurableStreamAuthority =
  | { status: "absent" }
  | ({ status: "live" } & RelayV2TerminalDurableStreamBinding)
  | ({ status: "closed" } & RelayV2TerminalDurableStreamBinding);

export type RelayV2TerminalDurableOpenOutcome =
  | {
      kind: "opened";
      generation: string;
      /** One-way evidence only. Durable implementations must never retain the token. */
      resumeTokenHash: string;
      disposition: "new" | "resumed" | "reset";
      replayFromOffset: string;
    }
  | {
      kind: "reset";
      generation: string | null;
      reason: RelayV2TerminalResetReason;
      requestedOffset: string | null;
      bufferStartOffset: string | null;
      tailOffset: string | null;
    }
  | {
      kind: "error";
      code: "BUSY" | "CAPABILITY_UNAVAILABLE" | "TERMINAL_STREAM_CONFLICT";
      message: string;
    };

export type RelayV2TerminalDurableOpenReplayResult =
  | {
      status: "replay";
      outcome: Extract<RelayV2TerminalDurableOpenOutcome, { kind: "opened" }>;
      /** An opened replay is executable only with its durable exact proof. */
      preparedBinding: RelayV2TerminalCanonicalTargetBindingV1;
    }
  | {
      status: "replay";
      outcome: Exclude<RelayV2TerminalDurableOpenOutcome, { kind: "opened" }>;
      /** A prepared failure retains evidence but never authorizes replay effects. */
      preparedBinding: RelayV2TerminalCanonicalTargetBindingV1 | null;
    };

export type RelayV2TerminalDurableOpenClaimResult =
  | {
      status: "claimed";
      claimToken: string;
      fence: string;
      /** H0-issued for new/reset; null for resume. */
      issuedGeneration: string | null;
      streamAuthority: RelayV2TerminalDurableStreamAuthority;
    }
  | { status: "busy"; reason: "control_record_quota" }
  | RelayV2TerminalDurableOpenReplayResult
  | { status: "conflict"; reason: "open_conflict" | "stream_conflict" };

export interface RelayV2TerminalDurableOpenClaimAuthority {
  claimToken: string;
  fence: string;
  issuedGeneration: string | null;
  streamAuthority: RelayV2TerminalDurableStreamAuthority;
}

export type RelayV2TerminalOpenFailureStreamEffect =
  | { kind: "preserve" }
  | { kind: "retire_previous"; generation: string };

export type RelayV2TerminalDurableOpenCommitResult =
  | { status: "committed"; outcome: RelayV2TerminalDurableOpenOutcome }
  | RelayV2TerminalDurableOpenReplayResult;

export type RelayV2TerminalDurableOpenPrepareResult =
  | {
      status: "prepared";
      binding: RelayV2TerminalCanonicalTargetBindingV1;
    }
  | RelayV2TerminalDurableOpenReplayResult;

export type RelayV2TerminalDurableStreamReleaseResult =
  | { status: "released" }
  | { status: "already_released" }
  | { status: "conflict"; reason: "generation_mismatch" };

export type RelayV2TerminalDurableStreamClosedResult =
  | { status: "closed" }
  | { status: "already_closed" }
  | { status: "conflict"; reason: "stream_identity_mismatch" };

export interface RelayV2TerminalDurableCloseTombstone {
  key: string;
  streamKey: string;
  fingerprint: string;
  hostInstanceId: string;
  target: RelayV2TerminalWireTarget;
  streamId: string;
  closeId: string;
  requestId: string;
  requestRoute: RelayV2TerminalRoute;
  generation: string;
  finalOffset: string;
  reason: RelayV2TerminalCloseReason;
  exitCode: number | null;
  expiresAtMs: number;
}

export interface RelayV2TerminalDurableCloseIntent
  extends RelayV2TerminalDurableCloseTombstone {}

export type RelayV2TerminalDurableCloseClaimResult =
  | { status: "claimed"; intent: RelayV2TerminalDurableCloseIntent; ownerFence: string }
  | { status: "existing_intent"; intent: RelayV2TerminalDurableCloseIntent; ownerFence: string }
  | { status: "final"; tombstone: RelayV2TerminalDurableCloseTombstone }
  | { status: "not_found" }
  | { status: "close_conflict" };

/**
 * H0 owns the atomic, bounded durable implementation. The process-scoped core
 * requires this seam so a host process restart can never interpret an exact
 * mode=new retry as permission to allocate a second backend. Implementations
 * must atomically enforce the frozen retention and control-record quotas;
 * exhaustion is a hard BUSY failure, never permission to consult volatile replay
 * state. claimOpen covers every new/resume/reset logical open before local
 * capacity checks, target resolution, or backend mutation. Every claim carries
 * explicit target/pane/resume-token-hash evidence; H0 must validate and freeze
 * the absent/live/closed authority, including the exact persisted binding, in
 * the same transaction. Neither side may infer binding from the opaque request
 * fingerprint. An absent authority has no synthetic binding evidence.
 * Only the returned claimToken/fence winner may complete or fail it; both
 * transitions are compare-and-swap and a late caller receives the retained
 * outcome without replacing it. failOpen must atomically preserve the current
 * stream reservation or retire the named previous generation. A successful
 * resume completion must compare the complete frozen stream binding. A new
 * hostInstance retires the old process-scoped stream authority as lost but may
 * retain the immutable final opened proof. H3 may execute that proof only when
 * the same local generation's actual effect target matches its prepared
 * binding; otherwise H3 returns correlated stream_lost and never adopts or
 * fences a newer generation. Durable opened outcomes contain only a token hash,
 * never the plaintext resume token.
 * claimClose persists the immutable close winner and original connector route
 * before lease/backend cleanup. An exact retry of a retained pending intent
 * atomically adopts the caller's current hostInstance owner before returning;
 * a final tombstone never changes owner. finalizeClose atomically advances
 * only the current owner's intent to a final tombstone. markStreamClosed is
 * only the natural backend lifecycle transition: it atomically compares the
 * exact streamKey/generation/hostInstanceId and establishes the supplied closed
 * retention before H3 exposes process-local closed replay or an event. Explicit
 * client close remains exclusively claimClose→finalizeClose.
 * releaseStreamReservation compares the same exact stream identity before
 * deletion. None of these methods may be implemented as a racy get followed by
 * void put. Durable status, quota, fence, history and TTL policy remain owned by
 * H0; H3 only supplies the process lifecycle evidence it directly observed.
 */
export interface RelayV2TerminalDurableLineage {
  claimOpen(
    claim: RelayV2TerminalDurableOpenClaim,
  ): Promise<RelayV2TerminalDurableOpenClaimResult>;
  /**
   * H0 atomically rechecks H2 and exact-control evidence, then freezes the
   * complete binding. No observer/backend/control effect may precede success.
   */
  prepareOpen(input: {
    key: string;
    fingerprint: string;
    hostInstanceId: string;
    claimToken: string;
    fence: string;
    preparation:
      | { kind: "current"; resolution: RelayV2TerminalCanonicalResolution }
      | { kind: "retained"; binding: RelayV2TerminalCanonicalTargetBindingV1 };
  }): Promise<RelayV2TerminalDurableOpenPrepareResult>;
  completeOpen(input: {
    key: string;
    fingerprint: string;
    hostInstanceId: string;
    claimToken: string;
    fence: string;
    outcome: Extract<RelayV2TerminalDurableOpenOutcome, { kind: "opened" }>;
  }): Promise<RelayV2TerminalDurableOpenCommitResult>;
  failOpen(input: {
    key: string;
    fingerprint: string;
    hostInstanceId: string;
    claimToken: string;
    fence: string;
    outcome: Exclude<RelayV2TerminalDurableOpenOutcome, { kind: "opened" }>;
    streamEffect: RelayV2TerminalOpenFailureStreamEffect;
  }): Promise<RelayV2TerminalDurableOpenCommitResult>;
  claimClose(input: {
    key: string;
    fingerprint: string;
    hostInstanceId: string;
    intent?: RelayV2TerminalDurableCloseIntent;
  }): Promise<RelayV2TerminalDurableCloseClaimResult>;
  finalizeClose(input: {
    key: string;
    fingerprint: string;
    hostInstanceId: string;
    ownerFence: string;
  }): Promise<RelayV2TerminalDurableCloseTombstone>;
  /**
   * This implementation remains inside the H0 owner. H0 must serially
   * read-reconcile any HostState commit-uncertain result before resolving this
   * call. `closed` and `already_closed` both certify that the same definitive
   * transaction verified the exact supplied stream identity and observed or
   * established an effective closed retention expiry at least `expiresAtMs`;
   * `conflict` is likewise definitive and requires H3 to evict its stale-local
   * generation without exposing a closed event. Post-commit uncertainty must
   * not be surfaced directly as a rejection for H3 to reconcile, because H3
   * owns no durable state machine.
   */
  markStreamClosed(input: {
    streamKey: string;
    generation: string;
    hostInstanceId: string;
    expiresAtMs: number;
  }): Promise<RelayV2TerminalDurableStreamClosedResult>;
  /** A definitive generation conflict retires only H3's stale-local record. */
  releaseStreamReservation(input: {
    streamKey: string;
    generation: string;
    hostInstanceId: string;
  }): Promise<RelayV2TerminalDurableStreamReleaseResult>;
}

export interface RelayV2TerminalManagerOptions {
  hostId: string;
  hostEpoch: string;
  hostInstanceId: string;
  resolver: RelayV2TerminalCanonicalResolver;
  lineage: RelayV2TerminalDurableLineage;
  backend: RelayV2TerminalByteBackend;
  terminalControl: RelayV2TerminalControlAuthority;
  send(
    route: RelayV2TerminalRuntimeBinding,
    frame: RelayV2JsonObject,
    lineage?: RelayV2TerminalOpenResponseLineage,
  ): Promise<void>;
  now?: () => number;
  issueToken?: () => string;
  /** Stricter limits for bounded simulators; values may never exceed the contract. */
  limits?: Partial<RelayV2TerminalLimits>;
}

const RELAY_V2_TERMINAL_MANAGER_RECOVERY_CAPTURE_OWNER = Symbol.for(
  "tmux-worktree.relay-v2.terminal-manager-recovery-capture-owner",
);

export interface RelayV2TerminalManagerRecoveryBinding {
  readonly hostId: string;
  readonly hostEpoch: string;
  readonly hostInstanceId: string;
  readonly manager: RelayV2TerminalManager;
  installFatalSink(sink: (error: unknown) => void): boolean;
  clearFatalSink(sink: (error: unknown) => void): boolean;
}

const terminalManagerRecoveryBindings = new WeakMap<object, Readonly<{
  lineage: RelayV2TerminalDurableLineage;
  binding: RelayV2TerminalManagerRecoveryBinding;
}>>();

const ownedTerminalManagerRecoveryCapture = (
  value: unknown,
  expectedLineage: RelayV2TerminalDurableLineage,
): RelayV2TerminalManagerRecoveryBinding | null => {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return null;
  const registered = terminalManagerRecoveryBindings.get(value);
  return registered?.lineage === expectedLineage ? registered.binding : null;
};

function registerTerminalManagerRecoveryBinding(
  manager: RelayV2TerminalManager,
  lineage: RelayV2TerminalDurableLineage,
  binding: RelayV2TerminalManagerRecoveryBinding,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    RELAY_V2_TERMINAL_MANAGER_RECOVERY_CAPTURE_OWNER,
  );
  if (descriptor === undefined) {
    Object.defineProperty(globalThis, RELAY_V2_TERMINAL_MANAGER_RECOVERY_CAPTURE_OWNER, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: ownedTerminalManagerRecoveryCapture,
    });
  } else if (!Object.hasOwn(descriptor, "value")
    || descriptor.value !== ownedTerminalManagerRecoveryCapture) {
    throw new Error("Relay v2 terminal manager recovery capture owner is unavailable");
  }
  terminalManagerRecoveryBindings.set(manager, Object.freeze({ lineage, binding }));
}

/**
 * Captures through the first real manager module's non-replaceable lexical
 * WeakMap owner. Globally naming the capture slot grants no issue authority.
 */
export function captureRelayV2TerminalManagerRecoveryBinding(
  value: unknown,
  expectedLineage: RelayV2TerminalDurableLineage,
): RelayV2TerminalManagerRecoveryBinding | null {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      RELAY_V2_TERMINAL_MANAGER_RECOVERY_CAPTURE_OWNER,
    );
  } catch {
    return null;
  }
  if (!descriptor
    || !Object.hasOwn(descriptor, "value")
    || descriptor.configurable !== false
    || descriptor.enumerable !== false
    || descriptor.writable !== false
    || typeof descriptor.value !== "function") return null;
  try {
    return Reflect.apply(descriptor.value, undefined, [value, expectedLineage]);
  } catch {
    return null;
  }
}

export interface RelayV2TerminalManagerStats {
  liveOrDetachedStreams: number;
  retainedStreams: number;
  controlRecords: number;
  reservedCloseRecords: number;
  controlSlots: number;
  ringBytes: number;
  pausedBackends: number;
}

type StreamStatus = "live" | "detached" | "closed" | "lost";
type BindingPhase = "replay" | "live";

interface TerminalBinding {
  route: RelayV2TerminalRuntimeBinding;
  ackedOffset: bigint;
  sentThroughOffset: bigint;
  phase: BindingPhase;
  replayBoundary: bigint;
  closeNotification: "event" | null;
  closeNotified: boolean;
}

interface SequenceHashRecord {
  hash: string;
}

interface ResizeRecord {
  cols: number;
  rows: number;
}

interface PendingSequence {
  seq: bigint;
  fingerprint: string;
  state: "ready" | "in_doubt";
  error?: RelayV2TerminalStructuredError;
}

interface TerminalCondition {
  finalOffset: bigint;
  reason: RelayV2TerminalCloseReason;
  exitCode: number | null;
  closedAt: number;
  ringExpiresAt: number;
}

interface PendingCloseResponse {
  requestId: string;
  route: RelayV2TerminalRuntimeBinding;
  closeRecordKey: string;
  deduplicated: boolean;
}

type ProducerReleaseResult =
  | { status: "released" }
  | { status: "rejected"; error: RelayV2TerminalStructuredError }
  | {
      status: "uncertain";
      error: RelayV2TerminalStructuredError;
      lease: RelayV2TerminalProducerLease;
    };

interface TerminalStream {
  key: string;
  auth: RelayV2TerminalAuthContext;
  target: RelayV2TerminalWireTarget;
  resolvedTarget: RelayV2TerminalResolvedTarget;
  canonicalBinding: RelayV2TerminalCanonicalTargetBindingV1;
  effectTarget: RelayV2TerminalExactEffectTargetV1;
  streamId: string;
  generation: string;
  resumeToken: string;
  resumeTokenHash: string;
  status: StreamStatus;
  ring: ByteRing;
  ringRetained: boolean;
  backend?: RelayV2TerminalByteHandle;
  backendPaused: boolean;
  pauseFailed: boolean;
  producerOwner: TerminalControlOwner;
  producerLease?: RelayV2TerminalProducerLease;
  /** Old authority identity retained only to settle an uncertain release. */
  retiringLease?: RelayV2TerminalProducerLease;
  renewLeaseAfter?: number;
  binding?: TerminalBinding;
  detachedUntil?: number;
  retainedUntil: number;
  close?: TerminalCondition;
  pendingCloseResponses: Map<string, PendingCloseResponse>;
  closeId?: string;
  reservedCloseRecord: boolean;
  inputAcked: bigint;
  inputFloor: bigint;
  inputHashes: Map<string, SequenceHashRecord>;
  pendingInput?: PendingSequence;
  resizeAcked: bigint;
  resizeFloor: bigint;
  resizes: Map<string, ResizeRecord>;
  pendingResize?: PendingSequence;
  controlInDoubt?: RelayV2TerminalStructuredError;
  lastUsedAt: number;
}

type OpenRecordOutcome =
  | {
      kind: "opened";
      generation: string;
      disposition: "new" | "resumed" | "reset";
      replayFromOffset: bigint;
    }
  | {
      kind: "reset";
      generation: string | null;
      reason: ResetReason;
      requestedOffset: bigint | null;
      bufferStartOffset: bigint | null;
      tailOffset: bigint | null;
    }
  | {
      kind: "error";
      code: "BUSY" | "CAPABILITY_UNAVAILABLE" | "TERMINAL_STREAM_CONFLICT";
      message: string;
    };

interface OpenRecord {
  key: string;
  streamKey: string;
  fingerprint: string;
  expiresAt: number;
  outcome: OpenRecordOutcome;
  /** Volatile exact-replay material. Never passed to durable lineage. */
  resumeToken?: string;
}

type LocalStreamLineageReconciliation =
  | { status: "absent" }
  | { status: "exact"; stream: TerminalStream }
  | {
      status: "divergent";
      stream: TerminalStream;
      /** Historical opened proof cannot fence a newer local generation. */
      localFenceAuthorized: boolean;
      /** Exact durable proof for this actual adapter target, not a mutable alias. */
      effectTargetProven: boolean;
    };

type OpenCommitResult =
  | { status: "committed"; outcome: OpenRecordOutcome }
  | {
      status: "replay";
      outcome: OpenRecordOutcome;
      preparedBinding: RelayV2TerminalCanonicalTargetBindingV1 | null;
    };

type OpenCommitProposal =
  | {
      outcome: Extract<OpenRecordOutcome, { kind: "opened" }>;
      stream: TerminalStream;
    }
  | {
      outcome: Exclude<OpenRecordOutcome, { kind: "opened" }>;
      streamEffect: RelayV2TerminalOpenFailureStreamEffect;
    };

interface ProvisionalGeneration {
  key: string;
  openRecordKey: string;
  stream: TerminalStream;
}

interface QuarantinedBackend {
  key: string;
  generation: string;
  handle: RelayV2TerminalByteHandle;
  expiresAt: number;
}

interface CloseRecord {
  key: string;
  streamKey: string;
  fingerprint: string;
  hostInstanceId: string;
  target: RelayV2TerminalWireTarget;
  streamId: string;
  closeId: string;
  requestId: string;
  requestRoute: RelayV2TerminalRoute;
  generation: string;
  finalOffset: bigint;
  reason: RelayV2TerminalCloseReason;
  exitCode: number | null;
  expiresAt: number;
}

type ResetReason = RelayV2TerminalResetReason;

class ByteRing {
  private readonly chunks: Buffer[] = [];
  private byteLength = 0;
  private start = 0n;
  private tail = 0n;

  constructor(private readonly limit: number) {}

  get length(): number {
    return this.byteLength;
  }

  get startOffset(): bigint {
    return this.start;
  }

  get tailOffset(): bigint {
    return this.tail;
  }

  predictedStartAfter(byteCount: number): bigint {
    const futureTail = this.tail + BigInt(byteCount);
    return futureTail - BigInt(Math.min(this.limit, this.byteLength + byteCount));
  }

  append(input: Uint8Array): number {
    const data = Buffer.from(input);
    if (data.byteLength === 0) return 0;
    if (data.byteLength >= this.limit) {
      const previous = this.byteLength;
      const kept = Buffer.from(data.subarray(data.byteLength - this.limit));
      this.tail += BigInt(data.byteLength);
      this.start = this.tail - BigInt(kept.byteLength);
      this.chunks.splice(0, this.chunks.length, kept);
      this.byteLength = kept.byteLength;
      return previous + data.byteLength - kept.byteLength;
    }
    const last = this.chunks.at(-1);
    if (last && last.byteLength < 64 * 1024) {
      const joinedBytes = Math.min(data.byteLength, 64 * 1024 - last.byteLength);
      if (joinedBytes > 0) {
        this.chunks[this.chunks.length - 1] = Buffer.concat(
          [last, data.subarray(0, joinedBytes)],
          last.byteLength + joinedBytes,
        );
        if (joinedBytes < data.byteLength) {
          this.chunks.push(Buffer.from(data.subarray(joinedBytes)));
        }
      } else {
        this.chunks.push(data);
      }
    } else {
      this.chunks.push(data);
    }
    this.byteLength += data.byteLength;
    this.tail += BigInt(data.byteLength);
    const overflow = Math.max(0, this.byteLength - this.limit);
    if (overflow > 0) this.discardPrefixBytes(overflow);
    return overflow;
  }

  clear(): number {
    const removed = this.byteLength;
    this.chunks.length = 0;
    this.byteLength = 0;
    this.start = this.tail;
    return removed;
  }

  discardBefore(offset: bigint): number {
    if (offset <= this.start) return 0;
    const through = offset > this.tail ? this.tail : offset;
    const removed = Number(through - this.start);
    if (removed > 0) this.discardPrefixBytes(removed);
    return removed;
  }

  hasRange(from: bigint, through: bigint): boolean {
    return from >= this.start && from <= through && through <= this.tail;
  }

  read(from: bigint, maxBytes: number, through = this.tail): Buffer {
    if (!this.hasRange(from, through) || from === through || maxBytes <= 0) {
      return Buffer.alloc(0);
    }
    const wanted = Number(
      (through - from) < BigInt(maxBytes) ? through - from : BigInt(maxBytes),
    );
    let skip = Number(from - this.start);
    const parts: Buffer[] = [];
    let remaining = wanted;
    for (const chunk of this.chunks) {
      if (skip >= chunk.byteLength) {
        skip -= chunk.byteLength;
        continue;
      }
      const take = Math.min(remaining, chunk.byteLength - skip);
      parts.push(chunk.subarray(skip, skip + take));
      remaining -= take;
      skip = 0;
      if (remaining === 0) break;
    }
    return parts.length === 1 ? Buffer.from(parts[0]) : Buffer.concat(parts, wanted - remaining);
  }

  private discardPrefixBytes(byteCount: number): void {
    let remaining = byteCount;
    while (remaining > 0) {
      const first = this.chunks[0];
      if (!first) throw new Error("Relay v2 terminal ring accounting underflow");
      if (remaining >= first.byteLength) {
        remaining -= first.byteLength;
        this.chunks.shift();
      } else {
        this.chunks[0] = Buffer.from(first.subarray(remaining));
        remaining = 0;
      }
    }
    this.byteLength -= byteCount;
    this.start += BigInt(byteCount);
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Relay v2 terminal ${label} must be a positive safe integer`);
  }
  return value;
}

function resolveLimits(overrides: Partial<RelayV2TerminalLimits> = {}): RelayV2TerminalLimits {
  const limits = { ...RELAY_V2_TERMINAL_LIMITS, ...overrides };
  for (const [key, ceiling] of Object.entries(RELAY_V2_TERMINAL_LIMITS)) {
    const value = positiveInteger(limits[key as keyof RelayV2TerminalLimits], key);
    if (value > ceiling) {
      throw new Error(`Relay v2 terminal ${key} exceeds the frozen limit`);
    }
  }
  if (limits.hostRingBytes < limits.streamRingBytes) {
    throw new Error("Relay v2 terminal host ring must cover at least one stream ring");
  }
  if (limits.maxUnackedBytes > limits.streamRingBytes) {
    throw new Error("Relay v2 terminal output credit cannot exceed the stream ring");
  }
  if (limits.maxFrameBytes > limits.maxUnackedBytes) {
    throw new Error("Relay v2 terminal frame limit cannot exceed output credit");
  }
  return limits;
}

function parseCounter(value: string, label: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new RelayV2TerminalManagerError("INVALID_ARGUMENT", `${label} is not canonical`);
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new RelayV2TerminalManagerError("INVALID_ARGUMENT", `${label} is invalid`);
  }
  if (parsed > MAX_COUNTER) {
    throw new RelayV2TerminalManagerError("INVALID_ARGUMENT", `${label} exceeds the counter limit`);
  }
  return parsed;
}

function parsePositiveCounter(value: string, label: string): bigint {
  const parsed = parseCounter(value, label);
  if (parsed === 0n) {
    throw new RelayV2TerminalManagerError(
      "INVALID_ARGUMENT",
      `${label} must start at 1`,
    );
  }
  return parsed;
}

function validateSize(cols: number, rows: number): void {
  if (
    !Number.isSafeInteger(cols)
    || !Number.isSafeInteger(rows)
    || cols < 1
    || cols > 1_000
    || rows < 1
    || rows > 500
  ) {
    throw new RelayV2TerminalManagerError(
      "INVALID_ARGUMENT",
      "terminal size is outside the frozen bounds",
    );
  }
}

function fingerprint(parts: readonly (string | number | null)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const value = part === null ? "<null>" : String(part);
    hash.update(String(Buffer.byteLength(value, "utf8")), "ascii");
    hash.update(":", "ascii");
    hash.update(value, "utf8");
    hash.update(";", "ascii");
  }
  return hash.digest("hex");
}

function payloadHash(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function tokenHash(value: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > 4_096
  ) {
    throw new RelayV2TerminalManagerError("INVALID_ARGUMENT", "terminal resume token is invalid");
  }
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 128
    && !value.includes("\0")
    && value.trim() === value;
}

function hasExactOwnKeys(
  value: unknown,
  expected: readonly string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.byteLength === rightBytes.byteLength
    && timingSafeEqual(leftBytes, rightBytes);
}

function sameRuntimeBinding(
  left: RelayV2TerminalRuntimeBinding,
  right: RelayV2TerminalRuntimeBinding,
): boolean {
  return sameDurableRoute(left, right)
    && left.runtimeBindingToken === right.runtimeBindingToken;
}

function sameDurableRoute(
  left: RelayV2TerminalRoute,
  right: RelayV2TerminalRoute,
): boolean {
  return left.connectorId === right.connectorId
    && left.routeId === right.routeId
    && left.routeFence === right.routeFence;
}

function cloneRuntimeBinding(
  binding: RelayV2TerminalRuntimeBinding,
): RelayV2TerminalRuntimeBinding {
  return createRelayV2TerminalRuntimeBinding(binding, binding.runtimeBindingToken);
}

function durableRoute(route: RelayV2TerminalRoute): RelayV2TerminalRoute {
  return {
    connectorId: route.connectorId,
    routeId: route.routeId,
    routeFence: route.routeFence,
  };
}

function routeRequestKey(route: RelayV2TerminalRuntimeBinding, requestId: string): string {
  return JSON.stringify([
    route.connectorId,
    route.routeId,
    route.routeFence,
    route.runtimeBindingToken,
    requestId,
  ]);
}

function sameAuth(left: RelayV2TerminalAuthContext, right: RelayV2TerminalAuthContext): boolean {
  return left.principalId === right.principalId
    && left.clientInstanceId === right.clientInstanceId;
}

function sameTarget(
  left: RelayV2TerminalWireTarget,
  right: RelayV2TerminalWireTarget,
): boolean {
  return left.hostId === right.hostId
    && left.scopeId === right.scopeId
    && left.sessionId === right.sessionId;
}

function parseCanonicalBinding(
  value: unknown,
): RelayV2TerminalCanonicalTargetBindingV1 {
  if (!hasExactOwnKeys(value, [
    "schemaVersion", "hostId", "scopeId", "sessionId", "pane", "processTarget",
    "backendInstanceKey", "managedTarget", "exactControlIdentity",
  ])
    || value.schemaVersion !== 1
    || !isOpaqueId(value.hostId)
    || !isOpaqueId(value.scopeId)
    || !isOpaqueId(value.sessionId)
    || !Number.isSafeInteger(value.pane)
    || (value.pane as number) < 0
    || (value.pane as number) > 65_535
    || !hasExactOwnKeys(value.processTarget, ["kind", "targetId"])
    || (value.processTarget.kind !== "local" && value.processTarget.kind !== "ssh")
    || !isOpaqueId(value.processTarget.targetId)
    || !isOpaqueId(value.backendInstanceKey)
    || !hasExactOwnKeys(value.managedTarget, ["name", "kind", "incarnation"])
    || !isOpaqueId(value.managedTarget.name)
    || (value.managedTarget.kind !== "worktree" && value.managedTarget.kind !== "terminal")
    || !isOpaqueId(value.managedTarget.incarnation)
    || !/^twinc2\.[A-Za-z0-9_-]{43}$/.test(value.managedTarget.incarnation)
    || !hasExactOwnKeys(value.exactControlIdentity, [
      "schemaVersion", "controlTargetId", "controlEpoch", "targetIncarnationProof",
    ])
    || value.exactControlIdentity.schemaVersion !== 1
    || !isOpaqueId(value.exactControlIdentity.controlTargetId)
    || !isOpaqueId(value.exactControlIdentity.controlEpoch)
    || !isOpaqueId(value.exactControlIdentity.targetIncarnationProof)) {
    throw new RelayV2TerminalManagerError(
      "INTERNAL",
      "canonical terminal target binding is malformed",
    );
  }
  let recomputedBackendInstanceKey: string;
  try {
    recomputedBackendInstanceKey = issueRelayV2CanonicalBackendInstanceKey({
      processTarget: {
        kind: value.processTarget.kind,
        targetId: value.processTarget.targetId,
      },
      incarnation: value.managedTarget.incarnation,
    });
  } catch {
    throw new RelayV2TerminalManagerError(
      "INTERNAL",
      "canonical terminal backend identity cannot be recomputed",
    );
  }
  if (value.backendInstanceKey !== recomputedBackendInstanceKey) {
    throw new RelayV2TerminalManagerError(
      "INTERNAL",
      "canonical terminal backend identity disagrees with its twinc2 incarnation",
    );
  }
  return {
    schemaVersion: 1,
    hostId: value.hostId,
    scopeId: value.scopeId,
    sessionId: value.sessionId,
    pane: value.pane as number,
    processTarget: {
      kind: value.processTarget.kind,
      targetId: value.processTarget.targetId,
    },
    backendInstanceKey: value.backendInstanceKey,
    managedTarget: {
      name: value.managedTarget.name,
      kind: value.managedTarget.kind,
      incarnation: value.managedTarget.incarnation,
    },
    exactControlIdentity: {
      schemaVersion: 1,
      controlTargetId: value.exactControlIdentity.controlTargetId,
      controlEpoch: value.exactControlIdentity.controlEpoch,
      targetIncarnationProof: value.exactControlIdentity.targetIncarnationProof,
    },
  };
}

function cloneCanonicalBinding(
  value: RelayV2TerminalCanonicalTargetBindingV1,
): RelayV2TerminalCanonicalTargetBindingV1 {
  return {
    ...value,
    processTarget: { ...value.processTarget },
    managedTarget: { ...value.managedTarget },
    exactControlIdentity: { ...value.exactControlIdentity },
  };
}

function sameCanonicalBinding(
  left: RelayV2TerminalCanonicalTargetBindingV1,
  right: RelayV2TerminalCanonicalTargetBindingV1,
): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.hostId === right.hostId
    && left.scopeId === right.scopeId
    && left.sessionId === right.sessionId
    && left.pane === right.pane
    && left.processTarget.kind === right.processTarget.kind
    && left.processTarget.targetId === right.processTarget.targetId
    && left.backendInstanceKey === right.backendInstanceKey
    && left.managedTarget.name === right.managedTarget.name
    && left.managedTarget.kind === right.managedTarget.kind
    && left.managedTarget.incarnation === right.managedTarget.incarnation
    && left.exactControlIdentity.schemaVersion === right.exactControlIdentity.schemaVersion
    && left.exactControlIdentity.controlTargetId === right.exactControlIdentity.controlTargetId
    && left.exactControlIdentity.controlEpoch === right.exactControlIdentity.controlEpoch
    && left.exactControlIdentity.targetIncarnationProof
      === right.exactControlIdentity.targetIncarnationProof;
}

function sameResolvedTarget(
  left: RelayV2TerminalResolvedTarget,
  right: RelayV2TerminalResolvedTarget,
): boolean {
  return sameTarget(left, right)
    && left.pane === right.pane
    && left.canonicalTargetId === right.canonicalTargetId
    && left.controlTargetId === right.controlTargetId;
}

function resolvedTargetForBinding(
  binding: RelayV2TerminalCanonicalTargetBindingV1,
): RelayV2TerminalResolvedTarget {
  return {
    hostId: binding.hostId,
    scopeId: binding.scopeId,
    sessionId: binding.sessionId,
    pane: binding.pane,
    canonicalTargetId: binding.backendInstanceKey,
    controlTargetId: binding.exactControlIdentity.controlTargetId,
  };
}

function exactEffectTargetMatches(
  stream: TerminalStream,
  expectedBinding: RelayV2TerminalCanonicalTargetBindingV1,
): boolean {
  try {
    const effectTarget: unknown = stream.effectTarget;
    if (!effectTarget || typeof effectTarget !== "object") return false;
    const ownKeys = Reflect.ownKeys(effectTarget);
    if (ownKeys.length !== 4
      || !Object.hasOwn(effectTarget, "schemaVersion")
      || !Object.hasOwn(effectTarget, "resolvedTarget")
      || !Object.hasOwn(effectTarget, "binding")
      || !Object.hasOwn(effectTarget, RELAY_V2_TERMINAL_EXACT_EFFECT_TARGET)) {
      return false;
    }
    const candidate = effectTarget as Record<PropertyKey, unknown>;
    if (candidate.schemaVersion !== 1
      || candidate[RELAY_V2_TERMINAL_EXACT_EFFECT_TARGET] !== true
      || !hasExactOwnKeys(candidate.resolvedTarget, [
        "hostId", "scopeId", "sessionId", "pane", "canonicalTargetId", "controlTargetId",
      ])) {
      return false;
    }
    const binding = parseCanonicalBinding(candidate.binding);
    const resolved = candidate.resolvedTarget as unknown as RelayV2TerminalResolvedTarget;
    const expectedResolved = resolvedTargetForBinding(expectedBinding);
    return sameCanonicalBinding(binding, expectedBinding)
      && sameResolvedTarget(resolved, expectedResolved)
      && sameResolvedTarget(stream.resolvedTarget, resolved);
  } catch {
    return false;
  }
}

function exactEffectTarget(
  resolvedTarget: RelayV2TerminalResolvedTarget,
  binding: RelayV2TerminalCanonicalTargetBindingV1,
): RelayV2TerminalExactEffectTargetV1 {
  return Object.freeze({
    schemaVersion: 1 as const,
    resolvedTarget: Object.freeze({ ...resolvedTarget }),
    binding: Object.freeze({
      ...cloneCanonicalBinding(binding),
      processTarget: Object.freeze({ ...binding.processTarget }),
      managedTarget: Object.freeze({ ...binding.managedTarget }),
      exactControlIdentity: Object.freeze({ ...binding.exactControlIdentity }),
    }),
    [RELAY_V2_TERMINAL_EXACT_EFFECT_TARGET]: true as const,
  });
}

function sameDurableOpenOutcome(
  left: RelayV2TerminalDurableOpenOutcome,
  right: RelayV2TerminalDurableOpenOutcome,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "opened" && right.kind === "opened") {
    return left.generation === right.generation
      && left.resumeTokenHash === right.resumeTokenHash
      && left.disposition === right.disposition
      && left.replayFromOffset === right.replayFromOffset;
  }
  if (left.kind === "reset" && right.kind === "reset") {
    return left.generation === right.generation
      && left.reason === right.reason
      && left.requestedOffset === right.requestedOffset
      && left.bufferStartOffset === right.bufferStartOffset
      && left.tailOffset === right.tailOffset;
  }
  return left.kind === "error"
    && right.kind === "error"
    && left.code === right.code
    && left.message === right.message;
}

function sameDurableClose(
  left: RelayV2TerminalDurableCloseTombstone,
  right: RelayV2TerminalDurableCloseTombstone,
): boolean {
  return sameDurableCloseWithoutExpiry(left, right)
    && left.expiresAtMs === right.expiresAtMs;
}

function sameDurableCloseProposal(
  durable: RelayV2TerminalDurableCloseTombstone,
  proposed: RelayV2TerminalDurableCloseTombstone,
): boolean {
  return sameDurableCloseWithoutExpiry(durable, proposed)
    && durable.expiresAtMs >= proposed.expiresAtMs;
}

function sameDurableCloseWithoutExpiry(
  left: RelayV2TerminalDurableCloseTombstone,
  right: RelayV2TerminalDurableCloseTombstone,
): boolean {
  return left.key === right.key
    && left.streamKey === right.streamKey
    && left.fingerprint === right.fingerprint
    && left.hostInstanceId === right.hostInstanceId
    && sameTarget(left.target, right.target)
    && left.streamId === right.streamId
    && left.closeId === right.closeId
    && left.requestId === right.requestId
    && sameDurableRoute(left.requestRoute, right.requestRoute)
    && left.generation === right.generation
    && left.finalOffset === right.finalOffset
    && left.reason === right.reason
    && left.exitCode === right.exitCode;
}

function asJson(frame: Record<string, unknown>): RelayV2JsonObject {
  return frame as unknown as RelayV2JsonObject;
}

const AUTHORITY_ERROR_CODES = new Set<RelayV2TerminalStructuredError["code"]>([
  "PERMISSION_DENIED",
  "BUSY",
  "SLOW_CONSUMER",
  "SCOPE_NOT_FOUND",
  "SCOPE_UNREACHABLE",
  "SESSION_NOT_FOUND",
  "PANE_NOT_FOUND",
  "TERMINAL_INPUT_GAP",
  "TERMINAL_INPUT_CONFLICT",
  "TERMINAL_RESIZE_GAP",
  "TERMINAL_RESIZE_CONFLICT",
  "COMMAND_IN_DOUBT",
  "INTERNAL",
]);

function validateAuthorityResult(
  value: unknown,
  kind: "input" | "resize",
): RelayV2TerminalAuthorityResult {
  if (!value || typeof value !== "object") {
    throw new RelayV2TerminalManagerError("INTERNAL", "terminal-control returned an invalid result");
  }
  const result = value as Record<string, unknown>;
  if (result.accepted === true) return { accepted: true };
  if (result.accepted !== false || typeof result.uncertain !== "boolean") {
    throw new RelayV2TerminalManagerError("INTERNAL", "terminal-control returned an invalid result");
  }
  const rawError = result.error;
  if (!rawError || typeof rawError !== "object") {
    throw new RelayV2TerminalManagerError("INTERNAL", "terminal-control returned an invalid error");
  }
  const error = rawError as Record<string, unknown>;
  const domainCodes = kind === "input"
    ? new Set(["TERMINAL_INPUT_GAP", "TERMINAL_INPUT_CONFLICT"])
    : new Set(["TERMINAL_RESIZE_GAP", "TERMINAL_RESIZE_CONFLICT"]);
  const commonCodes = new Set([
    "PERMISSION_DENIED",
    "BUSY",
    "SLOW_CONSUMER",
    "SCOPE_NOT_FOUND",
    "SCOPE_UNREACHABLE",
    "SESSION_NOT_FOUND",
    "PANE_NOT_FOUND",
    "COMMAND_IN_DOUBT",
    "INTERNAL",
  ]);
  const commandDisposition = error.code === "COMMAND_IN_DOUBT"
    ? "in_doubt"
    : "not_applicable";
  if (
    typeof error.code !== "string"
    || !AUTHORITY_ERROR_CODES.has(error.code as RelayV2TerminalStructuredError["code"])
    || (!commonCodes.has(error.code) && !domainCodes.has(error.code))
    || typeof error.message !== "string"
    || error.message.length === 0
    || error.message.includes("\0")
    || Buffer.byteLength(error.message, "utf8") > 4_096
    || typeof error.retryable !== "boolean"
    || (error.code === "COMMAND_IN_DOUBT" && result.uncertain !== true)
    || (error.details !== undefined && error.details !== null)
  ) {
    throw new RelayV2TerminalManagerError("INTERNAL", "terminal-control error is outside the v2 allowlist");
  }
  return {
    accepted: false,
    uncertain: result.uncertain,
    error: result.uncertain
      ? {
          code: "COMMAND_IN_DOUBT",
          message: error.message,
          retryable: false,
          details: null,
          commandDisposition: "in_doubt",
        }
      : {
          code: error.code as RelayV2TerminalStructuredError["code"],
          message: error.message,
          retryable: error.retryable,
          details: null,
          commandDisposition,
        },
  };
}

function controlFailure(error: unknown): {
  status: "rejected" | "uncertain";
  error: RelayV2TerminalStructuredError;
} {
  const raw = error && typeof error === "object"
    ? error as Record<string, unknown>
    : undefined;
  const message = typeof raw?.message === "string"
    && raw.message.length > 0
    && !raw.message.includes("\0")
    && Buffer.byteLength(raw.message, "utf8") <= 4_096
    ? raw.message
    : "terminal-control operation could not be confirmed";
  if (raw?.code === "PERMISSION_DENIED") {
    return {
      status: "rejected",
      error: {
        code: "PERMISSION_DENIED",
        message,
        retryable: raw.retryable === true,
        details: null,
        commandDisposition: "not_applicable",
      },
    };
  }
  if (raw?.code === "HANDOFF_PENDING" || raw?.code === "RECOVERY_REQUIRED") {
    return {
      status: "rejected",
      error: {
        code: "PERMISSION_DENIED",
        message,
        retryable: true,
        details: null,
        commandDisposition: "not_applicable",
      },
    };
  }
  if (raw?.code === "RESOURCE_EXHAUSTED") {
    return {
      status: "rejected",
      error: {
        code: "BUSY",
        message,
        retryable: true,
        details: null,
        commandDisposition: "not_applicable",
      },
    };
  }
  return {
    status: "uncertain",
    error: {
      code: "COMMAND_IN_DOUBT",
      message,
      retryable: false,
      details: null,
      commandDisposition: "in_doubt",
    },
  };
}

function validateLeaseResult(
  value: unknown,
  target: RelayV2TerminalResolvedTarget,
  owner: TerminalControlOwner,
  now: number,
  current?: RelayV2TerminalProducerLease,
): RelayV2TerminalLeaseResult {
  if (!value || typeof value !== "object") {
    throw new RelayV2TerminalManagerError("INTERNAL", "terminal-control returned an invalid lease result");
  }
  const result = value as Record<string, unknown>;
  if (result.status === "accepted") {
    const lease = validateProducerLease(result.lease, target, owner, now);
    if (current && (
      lease.controlTargetId !== current.controlTargetId
      || lease.controlEpoch !== current.controlEpoch
      || lease.leaseId !== current.leaseId
      || lease.fence !== current.fence
      || lease.owner.kind !== current.owner.kind
      || lease.owner.instanceId !== current.owner.instanceId
    )) {
      return {
        status: "rejected",
        error: {
          code: "PERMISSION_DENIED",
          message: "terminal-control lease identity changed during renewal",
          retryable: false,
          details: null,
          commandDisposition: "not_applicable",
        },
      };
    }
    return { status: "accepted", lease };
  }
  if (result.status !== "rejected" && result.status !== "uncertain") {
    throw new RelayV2TerminalManagerError("INTERNAL", "terminal-control returned an invalid lease result");
  }
  const validated = validateAuthorityResult({
    accepted: false,
    uncertain: result.status === "uncertain",
    error: result.error,
  }, "input");
  if (validated.accepted) {
    throw new RelayV2TerminalManagerError("INTERNAL", "terminal-control returned an invalid lease failure");
  }
  return { status: result.status, error: validated.error };
}

function validateProducerLease(
  value: unknown,
  target: RelayV2TerminalResolvedTarget,
  expectedOwner: TerminalControlOwner,
  now: number,
): RelayV2TerminalProducerLease {
  if (!value || typeof value !== "object") {
    throw new RelayV2TerminalManagerError("INTERNAL", "terminal-control returned an invalid lease");
  }
  const lease = value as Record<string, unknown>;
  for (const field of ["controlTargetId", "controlEpoch", "leaseId", "fence", "expiresAt"] as const) {
    if (typeof lease[field] !== "string" || lease[field].length === 0 || lease[field].length > 4_096) {
      throw new RelayV2TerminalManagerError("INTERNAL", "terminal-control returned an invalid lease");
    }
  }
  const owner = lease.owner as Record<string, unknown> | undefined;
  const expiresAtMs = typeof lease.expiresAt === "string" ? Date.parse(lease.expiresAt) : Number.NaN;
  if (
    lease.controlTargetId !== target.controlTargetId
    || !owner
    || owner.kind !== expectedOwner.kind
    || owner.instanceId !== expectedOwner.instanceId
    || !Number.isSafeInteger(expiresAtMs)
    || new Date(expiresAtMs).toISOString() !== lease.expiresAt
    || expiresAtMs <= now
  ) {
    throw new RelayV2TerminalManagerError("INTERNAL", "terminal-control lease is stale or mismatched");
  }
  return {
    controlTargetId: lease.controlTargetId as string,
    controlEpoch: lease.controlEpoch as string,
    leaseId: lease.leaseId as string,
    fence: lease.fence as string,
    owner: {
      kind: owner.kind as TerminalControlOwner["kind"],
      instanceId: owner.instanceId as string,
    },
    expiresAt: lease.expiresAt as string,
  };
}

function normalizeBackendClose(value: unknown): RelayV2TerminalBackendClose {
  if (!value || typeof value !== "object") return { reason: "backend_error", exitCode: null };
  const close = value as Record<string, unknown>;
  const exitCode = close.exitCode;
  const validExitCode = Number.isInteger(exitCode)
    && (exitCode as number) >= -2_147_483_648
    && (exitCode as number) <= 2_147_483_647;
  if (close.reason === "backend_exit" && validExitCode) {
    return { reason: "backend_exit", exitCode: exitCode as number };
  }
  if (close.reason === "backend_error" && (exitCode === null || validExitCode)) {
    return { reason: "backend_error", exitCode: exitCode as number | null };
  }
  return { reason: "backend_error", exitCode: null };
}

export class RelayV2TerminalManager {
  readonly limits: Readonly<RelayV2TerminalLimits>;

  private readonly streams = new Map<string, TerminalStream>();
  private readonly quarantinedBackends = new Map<
    RelayV2TerminalByteHandle,
    QuarantinedBackend
  >();
  private readonly openRecords = new Map<string, OpenRecord>();
  private readonly closeRecords = new Map<string, CloseRecord>();
  private serialized: Promise<void> = Promise.resolve();
  private ringBytes = 0;
  private hostPressure = false;
  private stopping = false;
  private shutdownBarrier: Promise<void> | null = null;
  private fatalSink: ((error: unknown) => void) | null = null;

  private readonly hostId: string;
  private readonly hostEpoch: string;
  private readonly hostInstanceId: string;
  private readonly resolver: RelayV2TerminalCanonicalResolver;
  private readonly lineage: RelayV2TerminalDurableLineage;
  private readonly backend: RelayV2TerminalByteBackend;
  private readonly terminalControl: RelayV2TerminalControlAuthority;
  private readonly sendFrame: RelayV2TerminalManagerOptions["send"];
  private readonly now: () => number;
  private readonly issueToken: () => string;

  constructor(options: RelayV2TerminalManagerOptions) {
    this.hostId = options.hostId;
    this.hostEpoch = options.hostEpoch;
    this.hostInstanceId = options.hostInstanceId;
    this.resolver = options.resolver;
    this.lineage = options.lineage;
    this.backend = options.backend;
    this.terminalControl = options.terminalControl;
    this.sendFrame = options.send;
    this.now = options.now ?? Date.now;
    this.issueToken = options.issueToken
      ?? (() => randomBytes(32).toString("base64url"));
    this.limits = Object.freeze(resolveLimits(options.limits));

    const manager = this;
    const lineage = options.lineage;
    const recoveryBinding: RelayV2TerminalManagerRecoveryBinding = Object.freeze({
      hostId: this.hostId,
      hostEpoch: this.hostEpoch,
      hostInstanceId: this.hostInstanceId,
      manager,
      installFatalSink(sink: (error: unknown) => void): boolean {
        if (typeof sink !== "function") return false;
        if (manager.fatalSink !== null && manager.fatalSink !== sink) return false;
        manager.fatalSink = sink;
        return true;
      },
      clearFatalSink(sink: (error: unknown) => void): boolean {
        if (manager.fatalSink !== sink) return false;
        manager.fatalSink = null;
        return true;
      },
    });
    registerTerminalManagerRecoveryBinding(manager, lineage, recoveryBinding);
  }

  open(request: RelayV2TerminalOpenRequest): Promise<void> {
    return this.enqueue(() => this.openInternal(request));
  }

  requestReplay(request: RelayV2TerminalReplayRequest): Promise<void> {
    return this.enqueue(() => this.replayInternal(request));
  }

  acknowledgeOutput(ack: RelayV2TerminalOutputAck): Promise<void> {
    return this.enqueue(() => this.outputAckInternal(ack));
  }

  input(input: RelayV2TerminalInput): Promise<void> {
    if (input.data.byteLength > this.limits.maxFrameBytes) {
      return Promise.reject(new RelayV2TerminalManagerError(
        "INVALID_ARGUMENT",
        "terminal input exceeds 64 KiB",
      ));
    }
    const copy = { ...input, data: Buffer.from(input.data) };
    return this.enqueue(() => this.inputInternal(copy));
  }

  resize(resize: RelayV2TerminalResize): Promise<void> {
    return this.enqueue(() => this.resizeInternal(resize));
  }

  close(request: RelayV2TerminalCloseRequest): Promise<void> {
    return this.enqueue(() => this.closeInternal(request));
  }

  unbind(auth: RelayV2TerminalAuthContext, route: RelayV2TerminalRuntimeBinding): Promise<void> {
    return this.enqueue(async () => {
      await this.sweepInternal();
      for (const stream of this.streams.values()) {
        if (!sameAuth(stream.auth, auth) || !stream.binding) continue;
        if (!sameRuntimeBinding(stream.binding.route, route)) continue;
        stream.binding = undefined;
        if (stream.status === "live") {
          await this.endRouteControl(stream);
          stream.status = "detached";
          stream.detachedUntil = this.now() + this.limits.detachedLeaseMs;
          stream.lastUsedAt = this.now();
        }
      }
      await this.refreshBackpressure();
    });
  }

  sweep(): Promise<void> {
    return this.enqueue(() => this.sweepInternal(true));
  }

  shutdown(): Promise<void> {
    if (this.shutdownBarrier !== null) return this.shutdownBarrier;
    this.shutdownBarrier = this.enqueue(async () => {
      this.stopping = true;
      for (const stream of this.streams.values()) {
        stream.binding = undefined;
        await this.releaseProducerLease(stream);
        this.clearControlWindows(stream);
        await this.disposeBackend(stream);
      }
      for (const [handle, quarantined] of this.quarantinedBackends) {
        this.quarantinedBackends.delete(handle);
        await this.closeQuarantinedBackend(quarantined);
      }
    });
    return this.shutdownBarrier;
  }

  stats(): RelayV2TerminalManagerStats {
    let liveOrDetachedStreams = 0;
    let reservedCloseRecords = 0;
    let pausedBackends = 0;
    for (const stream of this.streams.values()) {
      if (stream.status === "live" || stream.status === "detached") {
        liveOrDetachedStreams += 1;
      }
      if (stream.reservedCloseRecord) reservedCloseRecords += 1;
      if (stream.backendPaused) pausedBackends += 1;
    }
    const controlRecords = this.openRecords.size + this.closeRecords.size;
    return {
      liveOrDetachedStreams,
      retainedStreams: this.streams.size,
      controlRecords,
      reservedCloseRecords,
      controlSlots: controlRecords + reservedCloseRecords,
      ringBytes: this.ringBytes,
      pausedBackends,
    };
  }

  private enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const run = this.serialized.then(operation, operation);
    const observed = run.catch((error: unknown) => {
      if (this.isFatalAuthorityFailure(error)) this.notifyFatal(error);
      throw error;
    });
    this.serialized = observed.then(() => undefined, () => undefined);
    return observed;
  }

  private isFatalAuthorityFailure(error: unknown): boolean {
    return !isRelayV2TerminalManagerError(error)
      || error.code === "CAPABILITY_UNAVAILABLE"
      || error.code === "INTERNAL";
  }

  private notifyFatal(error: unknown): void {
    const sink = this.fatalSink;
    if (sink === null) return;
    try {
      sink(error);
    } catch {
      // The manager remains failed closed even if the lifecycle observer fails.
    }
  }

  private streamKey(auth: RelayV2TerminalAuthContext, streamId: string): string {
    return JSON.stringify([
      auth.principalId,
      auth.clientInstanceId,
      this.hostEpoch,
      streamId,
    ]);
  }

  private openRecordKey(request: RelayV2TerminalOpenRequest): string {
    return JSON.stringify([this.streamKey(request.auth, request.streamId), request.openId]);
  }

  private closeRecordKey(request: RelayV2TerminalCloseRequest): string {
    return JSON.stringify([this.streamKey(request.auth, request.streamId), request.closeId]);
  }

  private openFingerprint(request: RelayV2TerminalOpenRequest): string {
    return fingerprint([
      request.target.hostId,
      request.target.scopeId,
      request.target.sessionId,
      request.pane,
      request.cols,
      request.rows,
      request.mode,
      request.resume?.generation ?? null,
      request.mode === "resume" ? request.resume?.nextOffset ?? null : null,
      request.resume ? tokenHash(request.resume.resumeToken) : null,
    ]);
  }

  private closeFingerprint(request: RelayV2TerminalCloseRequest): string {
    return fingerprint([
      request.target.hostId,
      request.target.scopeId,
      request.target.sessionId,
      request.generation,
      tokenHash(request.resumeToken),
    ]);
  }

  private assertHost(request: {
    expectedHostEpoch: string;
    target: RelayV2TerminalWireTarget;
  }): void {
    if (request.target.hostId !== this.hostId) {
      throw new RelayV2TerminalManagerError("PERMISSION_DENIED", "terminal host is not authorized");
    }
    if (
      !isOpaqueId(request.target.scopeId)
      || !isOpaqueId(request.target.sessionId)
    ) {
      throw new RelayV2TerminalManagerError("INVALID_ARGUMENT", "terminal target identity is invalid");
    }
    if (request.expectedHostEpoch !== this.hostEpoch) {
      throw new RelayV2TerminalManagerError(
        "HOST_EPOCH_MISMATCH",
        "terminal request targets a stale host lineage",
      );
    }
  }

  private assertRunning(): void {
    if (this.stopping) {
      throw new RelayV2TerminalManagerError("BUSY", "terminal manager is stopping");
    }
  }

  private controlSlots(): number {
    let reservations = 0;
    for (const stream of this.streams.values()) {
      if (stream.reservedCloseRecord) reservations += 1;
    }
    return this.openRecords.size + this.closeRecords.size + reservations;
  }

  private requireControlSlots(additional: number): void {
    if (this.controlSlots() + additional > this.limits.maxControlRecords) {
      throw new RelayV2TerminalManagerError(
        "BUSY",
        "Relay v2 terminal control record quota is full",
      );
    }
  }

  private cacheOpenRecord(record: OpenRecord): void {
    if (
      this.openRecords.has(record.key)
      || this.controlSlots() < this.limits.maxControlRecords
    ) {
      this.openRecords.set(record.key, record);
    }
  }

  private cacheCloseRecord(record: CloseRecord, stream?: TerminalStream): void {
    if (
      this.closeRecords.has(record.key)
      || this.controlSlots() < this.limits.maxControlRecords
      || stream?.reservedCloseRecord === true
    ) {
      this.closeRecords.set(record.key, record);
    }
  }

  private liveOrDetachedCount(): number {
    let count = 0;
    for (const stream of this.streams.values()) {
      if (stream.status === "live" || stream.status === "detached") count += 1;
    }
    return count;
  }

  private backendSlotCount(): number {
    let count = this.quarantinedBackends.size;
    for (const stream of this.streams.values()) {
      if (stream.backend) count += 1;
    }
    return count;
  }

  private async openInternal(request: RelayV2TerminalOpenRequest): Promise<void> {
    this.assertRunning();
    this.assertHost(request);
    validateSize(request.cols, request.rows);
    if (!Number.isSafeInteger(request.pane) || request.pane < 0 || request.pane > 65_535) {
      throw new RelayV2TerminalManagerError("INVALID_ARGUMENT", "terminal pane is outside the frozen bounds");
    }
    this.validateOpenMode(request);

    const key = this.streamKey(request.auth, request.streamId);
    const recordKey = this.openRecordKey(request);
    const requestFingerprint = this.openFingerprint(request);
    const requestResumeTokenHash = request.resume
      ? tokenHash(request.resume.resumeToken)
      : null;
    const claim = await this.lineage.claimOpen({
      key: recordKey,
      streamKey: key,
      fingerprint: requestFingerprint,
      hostInstanceId: this.hostInstanceId,
      target: { ...request.target },
      pane: request.pane,
      resumeTokenHash: requestResumeTokenHash,
      mode: request.mode,
      previousGeneration: request.resume?.generation ?? null,
      requestedOffset: request.mode === "resume" ? request.resume?.nextOffset ?? null : null,
      expiresAtMs: this.now() + this.limits.controlRetentionMs,
    });
    if (!claim || typeof claim !== "object" || typeof claim.status !== "string") {
      throw new RelayV2TerminalManagerError("INTERNAL", "durable lineage returned an invalid open claim");
    }
    if (claim.status === "busy") {
      if (claim.reason !== "control_record_quota") {
        throw new RelayV2TerminalManagerError("INTERNAL", "durable lineage returned an invalid busy reason");
      }
      throw new RelayV2TerminalManagerError(
        "BUSY",
        "Relay v2 terminal control record quota is full",
      );
    }
    if (claim.status === "conflict") {
      if (claim.reason === "open_conflict") {
        throw new RelayV2TerminalManagerError(
          "TERMINAL_OPEN_CONFLICT",
          "terminal openId was durably retained with a different request",
        );
      }
      if (claim.reason === "stream_conflict") {
        throw new RelayV2TerminalManagerError(
          "TERMINAL_STREAM_CONFLICT",
          "terminal streamId is already retained",
        );
      }
      throw new RelayV2TerminalManagerError("INTERNAL", "durable lineage returned an invalid conflict");
    }
    if (claim.status === "replay") {
      await this.reconcileAndReplayDurableOpen(
        request,
        key,
        recordKey,
        requestFingerprint,
        claim,
      );
      return;
    }
    if (claim.status !== "claimed") {
      throw new RelayV2TerminalManagerError("INTERNAL", "durable lineage returned an unknown open claim");
    }
    const retained = this.openRecords.get(recordKey);
    const claimAuthority = this.openClaimAuthority(claim);
    const reconciliation = this.reconcileLocalStreamLineage(key, {
      kind: "claimed",
      authority: claimAuthority.streamAuthority,
      ...(retained ? { record: retained } : {}),
    });
    if (reconciliation.status === "divergent" || retained) {
      const settled = await this.failOpenRecord(
        request,
        key,
        recordKey,
        requestFingerprint,
        {
          kind: "reset",
          generation: request.resume?.generation ?? null,
          reason: "stream_lost",
          requestedOffset: request.mode === "resume" && request.resume
            ? parseCounter(request.resume.nextOffset, "nextOffset")
            : null,
          bufferStartOffset: null,
          tailOffset: null,
        },
        claimAuthority,
        { kind: "preserve" },
        false,
      );
      if (settled.kind === "opened") {
        throw new RelayV2TerminalManagerError(
          "INTERNAL",
          "durable terminal divergence did not settle its pending claim",
        );
      }
      if (reconciliation.status === "divergent") {
        await this.fenceDivergentLocalStream(reconciliation);
      }
      this.throwOpenError(settled);
      if (settled.kind === "reset") {
        await this.sendResetResponse(request, settled, "open");
        return;
      }
      throw new RelayV2TerminalManagerError("INTERNAL", "durable terminal claim did not settle");
    }
    const existing = reconciliation.status === "exact" ? reconciliation.stream : undefined;
    if (
      request.mode === "new"
      && (claimAuthority.streamAuthority.status !== "absent" || existing)
    ) {
      const outcome = await this.failOpenRecord(request, key, recordKey, requestFingerprint, {
        kind: "error",
        code: "TERMINAL_STREAM_CONFLICT",
        message: "terminal streamId is already retained",
      }, claimAuthority, { kind: "preserve" });
      this.throwOpenError(outcome);
      return;
    }
    try {
      this.requireControlSlots(
        request.mode === "new" || (request.mode === "reset" && !existing) ? 2 : 1,
      );
      if (
        (request.mode === "new" || (request.mode === "reset" && !existing))
        && this.backendSlotCount() >= this.limits.maxStreams
      ) {
        throw new RelayV2TerminalManagerError(
          "BUSY",
          "Relay v2 terminal stream quota is full",
        );
      }
    } catch (error) {
      if (!(error instanceof RelayV2TerminalManagerError) || error.code !== "BUSY") throw error;
      const outcome = await this.failOpenRecord(
        request,
        key,
        recordKey,
        requestFingerprint,
        { kind: "error", code: "BUSY", message: error.message },
        claimAuthority,
        { kind: "preserve" },
        false,
      );
      this.throwOpenError(outcome);
      return;
    }
    if (request.mode === "new") {
      await this.createGeneration(request, key, recordKey, requestFingerprint, "new", claimAuthority);
      return;
    }

    if (request.mode === "resume") {
      if (requestResumeTokenHash === null) {
        throw new RelayV2TerminalManagerError(
          "INTERNAL",
          "terminal resume lost its token hash evidence",
        );
      }
      await this.resumeGeneration(
        request,
        existing,
        key,
        recordKey,
        requestFingerprint,
        claimAuthority,
        requestResumeTokenHash,
      );
      return;
    }

    await this.resetGeneration(
      request,
      existing,
      key,
      recordKey,
      requestFingerprint,
      claimAuthority,
      !existing || existing.status === "lost",
      requestResumeTokenHash,
    );
  }

  private openClaimAuthority(
    claim: Extract<RelayV2TerminalDurableOpenClaimResult, { status: "claimed" }>,
  ): RelayV2TerminalDurableOpenClaimAuthority {
    if (!isOpaqueId(claim.claimToken)
      || !isOpaqueId(claim.fence)
      || !(claim.issuedGeneration === null || isOpaqueId(claim.issuedGeneration))) {
      throw new RelayV2TerminalManagerError("INTERNAL", "durable lineage returned an invalid open claim authority");
    }
    const authority: unknown = claim.streamAuthority;
    let streamAuthority: RelayV2TerminalDurableStreamAuthority;
    if (hasExactOwnKeys(authority, ["status"]) && authority.status === "absent") {
      streamAuthority = Object.freeze({ status: "absent" });
    } else if (
      hasExactOwnKeys(authority, [
        "status",
        "generation",
        "target",
        "pane",
        "resumeTokenHash",
        "canonicalBinding",
      ])
      && (authority.status === "live" || authority.status === "closed")
      && isOpaqueId(authority.generation)
      && hasExactOwnKeys(authority.target, ["hostId", "scopeId", "sessionId"])
      && isOpaqueId(authority.target.hostId)
      && isOpaqueId(authority.target.scopeId)
      && isOpaqueId(authority.target.sessionId)
      && Number.isSafeInteger(authority.pane)
      && (authority.pane as number) >= 0
      && (authority.pane as number) <= 65_535
      && typeof authority.resumeTokenHash === "string"
      && /^[0-9a-f]{64}$/.test(authority.resumeTokenHash)
    ) {
      const canonicalBinding = parseCanonicalBinding(authority.canonicalBinding);
      if (!sameTarget(
        canonicalBinding,
        authority.target as unknown as RelayV2TerminalWireTarget,
      )
        || canonicalBinding.pane !== authority.pane) {
        throw new RelayV2TerminalManagerError(
          "INTERNAL",
          "durable lineage returned a mismatched canonical stream binding",
        );
      }
      streamAuthority = Object.freeze({
        status: authority.status,
        generation: authority.generation,
        target: Object.freeze({
          hostId: authority.target.hostId,
          scopeId: authority.target.scopeId,
          sessionId: authority.target.sessionId,
        }),
        pane: authority.pane as number,
        resumeTokenHash: authority.resumeTokenHash,
        canonicalBinding: cloneCanonicalBinding(canonicalBinding),
      });
    } else {
      throw new RelayV2TerminalManagerError(
        "INTERNAL",
        "durable lineage returned an invalid stream authority",
      );
    }
    return Object.freeze({
      claimToken: claim.claimToken,
      fence: claim.fence,
      issuedGeneration: claim.issuedGeneration,
      streamAuthority,
    });
  }

  private validateOpenMode(request: RelayV2TerminalOpenRequest): void {
    if (!(["new", "resume", "reset"] as const).includes(request.mode)) {
      throw new RelayV2TerminalManagerError("INVALID_ARGUMENT", "terminal open mode is invalid");
    }
    if (request.mode === "new" && request.resume !== undefined) {
      throw new RelayV2TerminalManagerError("INVALID_ARGUMENT", "mode=new forbids resume fields");
    }
    if (request.mode === "resume" && request.resume === undefined) {
      throw new RelayV2TerminalManagerError("INVALID_ARGUMENT", "mode=resume requires resume fields");
    }
    if (request.mode === "resume") {
      if (request.resume?.nextOffset === undefined) {
        throw new RelayV2TerminalManagerError(
          "INVALID_ARGUMENT",
          "mode=resume requires nextOffset",
        );
      }
      parseCounter(request.resume.nextOffset, "nextOffset");
    }
    if (request.mode === "reset"
      && request.resume !== undefined
      && Object.hasOwn(request.resume, "nextOffset")) {
      throw new RelayV2TerminalManagerError(
        "INVALID_ARGUMENT",
        "mode=reset forbids nextOffset",
      );
    }
  }

  private durableOpenOutcome(
    outcome: OpenRecordOutcome,
    stream?: TerminalStream,
  ): RelayV2TerminalDurableOpenOutcome {
    if (outcome.kind === "opened") {
      if (!stream || stream.generation !== outcome.generation) {
        throw new RelayV2TerminalManagerError("INTERNAL", "opened outcome has no matching terminal stream");
      }
      return {
        kind: "opened",
        generation: outcome.generation,
        resumeTokenHash: stream.resumeTokenHash,
        disposition: outcome.disposition,
        replayFromOffset: outcome.replayFromOffset.toString(10),
      };
    }
    if (outcome.kind === "reset") {
      return {
        kind: "reset",
        generation: outcome.generation,
        reason: outcome.reason,
        requestedOffset: outcome.requestedOffset?.toString(10) ?? null,
        bufferStartOffset: outcome.bufferStartOffset?.toString(10) ?? null,
        tailOffset: outcome.tailOffset?.toString(10) ?? null,
      };
    }
    return { ...outcome };
  }

  private localRecordMatchesDurable(
    record: OpenRecord,
    stream: TerminalStream | undefined,
    durable: RelayV2TerminalDurableOpenOutcome,
  ): boolean {
    if (record.outcome.kind === "opened") {
      if (
        !stream
        || stream.generation !== record.outcome.generation
        || !record.resumeToken
        || !this.validResumeToken(stream, record.resumeToken)
      ) {
        return false;
      }
      return sameDurableOpenOutcome(
        this.durableOpenOutcome(record.outcome, stream),
        durable,
      );
    }
    return sameDurableOpenOutcome(this.durableOpenOutcome(record.outcome), durable);
  }

  private reconcileLocalStreamLineage(
    key: string,
    expectation:
      | {
          kind: "claimed";
          authority: RelayV2TerminalDurableStreamAuthority;
          record?: OpenRecord;
        }
      | {
          kind: "opened_replay";
          outcome: Extract<RelayV2TerminalDurableOpenOutcome, { kind: "opened" }>;
          fingerprint: string;
          target: RelayV2TerminalWireTarget;
          preparedBinding: RelayV2TerminalCanonicalTargetBindingV1;
          record?: OpenRecord;
        },
  ): LocalStreamLineageReconciliation {
    const stream = this.streams.get(key);
    if (!stream) return { status: "absent" };
    const localFenceAuthorized = expectation.kind === "claimed"
      || stream.generation === expectation.outcome.generation;
    const effectTargetProven = expectation.kind === "claimed"
      ? expectation.authority.status !== "absent"
        && stream.generation === expectation.authority.generation
        && exactEffectTargetMatches(stream, expectation.authority.canonicalBinding)
      : localFenceAuthorized
        && exactEffectTargetMatches(stream, expectation.preparedBinding);
    if (stream.status === "lost" && !stream.backend) {
      return { status: "divergent", stream, localFenceAuthorized, effectTargetProven };
    }

    let exact: boolean;
    if (expectation.kind === "claimed") {
      exact = expectation.record === undefined
        && this.localStreamForAuthority(stream, expectation.authority) === stream;
    } else {
      const statusMatches = stream.status === "live"
        || stream.status === "detached"
        || (stream.status === "closed" && !!stream.close);
      exact = statusMatches
        && stream.generation === expectation.outcome.generation
        && sameTarget(stream.target, expectation.target)
        && safeHashEqual(stream.resumeTokenHash, expectation.outcome.resumeTokenHash)
        && effectTargetProven
        && (expectation.record === undefined || (
          expectation.record.fingerprint === expectation.fingerprint
          && this.localRecordMatchesDurable(expectation.record, stream, expectation.outcome)
        ));
    }
    if (exact) return { status: "exact", stream };

    return { status: "divergent", stream, localFenceAuthorized, effectTargetProven };
  }

  private async cleanupDivergentLocalStream(stream: TerminalStream): Promise<void> {
    await this.loseStream(stream, "stream_lost", false);
    stream.reservedCloseRecord = false;
    if (this.streams.get(stream.key) === stream) this.streams.delete(stream.key);
  }

  /**
   * Fences a local stream whose actual adapter target lacks matching durable
   * proof. This is deliberately local-only: unknown backend/control identities
   * are never released or closed speculatively.
   */
  private quarantineDivergentLocalStream(stream: TerminalStream): void {
    if (this.streams.get(stream.key) === stream) this.streams.delete(stream.key);
    stream.binding = undefined;
    stream.status = "lost";
    stream.detachedUntil = undefined;
    stream.retainedUntil = this.now() + this.limits.controlRetentionMs;
    stream.pendingCloseResponses.clear();
    const handle = stream.backend;
    if (handle) {
      // Admission counts this registry as backend slots. Moving ownership from
      // the stream therefore preserves the hard maxStreams bound.
      this.quarantinedBackends.set(handle, {
        key: stream.key,
        generation: stream.generation,
        handle,
        expiresAt: stream.retainedUntil,
      });
      stream.backend = undefined;
    }
    stream.producerLease = undefined;
    stream.retiringLease = undefined;
    stream.renewLeaseAfter = undefined;
    stream.reservedCloseRecord = false;
    this.clearControlWindows(stream);
    this.removeRing(stream, false);
    for (const [recordKey, record] of this.openRecords) {
      if (record.streamKey === stream.key) this.openRecords.delete(recordKey);
    }
  }

  private async fenceDivergentLocalStream(
    reconciliation: Extract<LocalStreamLineageReconciliation, { status: "divergent" }>,
  ): Promise<void> {
    if (!reconciliation.localFenceAuthorized) return;
    if (reconciliation.effectTargetProven) {
      await this.cleanupDivergentLocalStream(reconciliation.stream);
      return;
    }
    this.quarantineDivergentLocalStream(reconciliation.stream);
  }

  private durableReplayProof(value: unknown): RelayV2TerminalDurableOpenReplayResult {
    try {
      if (!hasExactOwnKeys(value, ["status", "outcome", "preparedBinding"])
        || value.status !== "replay") {
        throw new RelayV2TerminalManagerError(
          "INTERNAL",
          "durable terminal replay proof has an invalid closed shape",
        );
      }
      this.localOpenOutcome(value.outcome);
      const outcome = value.outcome as RelayV2TerminalDurableOpenOutcome;
      if (outcome.kind === "opened") {
        const preparedBinding = parseCanonicalBinding(value.preparedBinding);
        return { status: "replay", outcome, preparedBinding };
      }
      const preparedBinding = value.preparedBinding === null
        ? null
        : parseCanonicalBinding(value.preparedBinding);
      return { status: "replay", outcome, preparedBinding };
    } catch (error) {
      if (isRelayV2TerminalManagerError(error)) throw error;
      throw new RelayV2TerminalManagerError(
        "INTERNAL",
        "durable terminal replay proof is malformed",
      );
    }
  }

  private localOpenOutcome(value: unknown): OpenRecordOutcome {
    if (!value || typeof value !== "object") {
      throw new RelayV2TerminalManagerError("INTERNAL", "durable terminal open outcome is invalid");
    }
    const outcome = value as Record<string, unknown>;
    if (outcome.kind === "opened") {
      if (
        !hasExactOwnKeys(outcome, [
          "kind", "generation", "resumeTokenHash", "disposition", "replayFromOffset",
        ])
        || !isOpaqueId(outcome.generation)
        || typeof outcome.resumeTokenHash !== "string"
        || !/^[0-9a-f]{64}$/.test(outcome.resumeTokenHash)
        || !(outcome.disposition === "new" || outcome.disposition === "resumed" || outcome.disposition === "reset")
        || typeof outcome.replayFromOffset !== "string"
      ) {
        throw new RelayV2TerminalManagerError("INTERNAL", "durable terminal opened outcome is invalid");
      }
      let replayFromOffset: bigint;
      try {
        replayFromOffset = parseCounter(outcome.replayFromOffset, "durable replayFromOffset");
      } catch {
        throw new RelayV2TerminalManagerError("INTERNAL", "durable terminal opened outcome is invalid");
      }
      return {
        kind: "opened",
        generation: outcome.generation,
        disposition: outcome.disposition,
        replayFromOffset,
      };
    }
    if (outcome.kind === "reset") {
      const reason = outcome.reason;
      if (
        !hasExactOwnKeys(outcome, [
          "kind", "generation", "reason", "requestedOffset", "bufferStartOffset", "tailOffset",
        ])
        || !(outcome.generation === null || isOpaqueId(outcome.generation))
        || !(reason === "generation_stale" || reason === "offset_expired" || reason === "stream_lost"
          || reason === "slow_consumer" || reason === "host_buffer_pressure")
      ) {
        throw new RelayV2TerminalManagerError("INTERNAL", "durable terminal reset outcome is invalid");
      }
      const counterOrNull = (field: "requestedOffset" | "bufferStartOffset" | "tailOffset") => {
        const raw = outcome[field];
        if (raw === null) return null;
        if (typeof raw !== "string") {
          throw new RelayV2TerminalManagerError("INTERNAL", `durable ${field} is invalid`);
        }
        try {
          return parseCounter(raw, `durable ${field}`);
        } catch {
          throw new RelayV2TerminalManagerError("INTERNAL", `durable ${field} is invalid`);
        }
      };
      return {
        kind: "reset",
        generation: outcome.generation,
        reason,
        requestedOffset: counterOrNull("requestedOffset"),
        bufferStartOffset: counterOrNull("bufferStartOffset"),
        tailOffset: counterOrNull("tailOffset"),
      };
    }
    if (
      hasExactOwnKeys(outcome, ["kind", "code", "message"])
      && outcome.kind === "error"
      && (outcome.code === "BUSY"
        || outcome.code === "CAPABILITY_UNAVAILABLE"
        || outcome.code === "TERMINAL_STREAM_CONFLICT")
      && typeof outcome.message === "string"
      && outcome.message.length > 0
      && !outcome.message.includes("\0")
      && Buffer.byteLength(outcome.message, "utf8") <= 4_096
    ) {
      return {
        kind: "error",
        code: outcome.code,
        message: outcome.message,
      };
    }
    throw new RelayV2TerminalManagerError("INTERNAL", "durable terminal open outcome is invalid");
  }

  private streamLostFromDurableOpened(
    outcome: Extract<RelayV2TerminalDurableOpenOutcome, { kind: "opened" }>,
  ): Extract<OpenRecordOutcome, { kind: "reset" }> {
    return {
      kind: "reset",
      generation: outcome.generation,
      reason: "stream_lost",
      requestedOffset: outcome.disposition === "reset"
        ? null
        : parseCounter(outcome.replayFromOffset, "durable replayFromOffset"),
      bufferStartOffset: null,
      tailOffset: null,
    };
  }

  private async settleOpenRecord(
    request: RelayV2TerminalOpenRequest,
    key: string,
    recordKey: string,
    requestFingerprint: string,
    proposal: OpenCommitProposal,
    claimAuthority: RelayV2TerminalDurableOpenClaimAuthority,
    retainLocal = true,
  ): Promise<OpenCommitResult> {
    const stream = "stream" in proposal ? proposal.stream : undefined;
    const durableProposed = this.durableOpenOutcome(proposal.outcome, stream);
    const input = {
      key: recordKey,
      fingerprint: requestFingerprint,
      hostInstanceId: this.hostInstanceId,
      claimToken: claimAuthority.claimToken,
      fence: claimAuthority.fence,
      outcome: durableProposed,
    };
    const result = "stream" in proposal
      ? await this.lineage.completeOpen({
          ...input,
          outcome: durableProposed as Extract<RelayV2TerminalDurableOpenOutcome, { kind: "opened" }>,
        })
      : await this.lineage.failOpen({
          ...input,
          outcome: durableProposed as Exclude<RelayV2TerminalDurableOpenOutcome, { kind: "opened" }>,
          streamEffect: proposal.streamEffect,
        });
    if (!result || typeof result !== "object") {
      throw new RelayV2TerminalManagerError("INTERNAL", "durable terminal open commit result is invalid");
    }
    const durableResult = result.status === "replay"
      ? this.durableReplayProof(result)
      : hasExactOwnKeys(result, ["status", "outcome"]) && result.status === "committed"
        ? result
        : null;
    if (durableResult === null) {
      throw new RelayV2TerminalManagerError("INTERNAL", "durable terminal open commit result is invalid");
    }
    let outcome = this.localOpenOutcome(durableResult.outcome);
    if (durableResult.status === "committed"
      && !sameDurableOpenOutcome(durableResult.outcome, durableProposed)) {
      throw new RelayV2TerminalManagerError("INTERNAL", "durable terminal open commit changed the claimed winner");
    }
    if (durableResult.outcome.kind === "opened") {
      const hasVolatileToken = durableResult.status === "committed"
        && stream !== undefined
        && stream.generation === durableResult.outcome.generation
        && safeHashEqual(stream.resumeTokenHash, durableResult.outcome.resumeTokenHash);
      if (!hasVolatileToken) {
        outcome = this.streamLostFromDurableOpened(durableResult.outcome);
      }
    }
    if (retainLocal) {
      this.cacheOpenRecord({
        key: recordKey,
        streamKey: key,
        fingerprint: requestFingerprint,
        expiresAt: this.now() + this.limits.controlRetentionMs,
        outcome,
        resumeToken: outcome.kind === "opened" ? stream?.resumeToken : undefined,
      });
    }
    return durableResult.status === "replay"
      ? {
          status: "replay",
          outcome,
          preparedBinding: durableResult.preparedBinding,
        }
      : { status: "committed", outcome };
  }

  private async failOpenRecord(
    request: RelayV2TerminalOpenRequest,
    key: string,
    recordKey: string,
    requestFingerprint: string,
    proposed: Exclude<OpenRecordOutcome, { kind: "opened" }>,
    claimAuthority: RelayV2TerminalDurableOpenClaimAuthority,
    streamEffect: RelayV2TerminalOpenFailureStreamEffect,
    retainLocal = true,
  ): Promise<OpenRecordOutcome> {
    const result = await this.settleOpenRecord(
      request,
      key,
      recordKey,
      requestFingerprint,
      { outcome: proposed, streamEffect },
      claimAuthority,
      retainLocal,
    );
    return result.outcome;
  }

  private recoverOpenRecord(
    record: OpenRecord,
    proposed: Extract<OpenRecordOutcome, { kind: "reset" }>,
  ): Extract<OpenRecordOutcome, { kind: "reset" }> {
    record.outcome = proposed;
    record.resumeToken = undefined;
    record.expiresAt = this.now() + this.limits.controlRetentionMs;
    return proposed;
  }

  private async reconcileAndReplayDurableOpen(
    request: RelayV2TerminalOpenRequest,
    key: string,
    recordKey: string,
    requestFingerprint: string,
    value: unknown,
  ): Promise<void> {
    const replay = this.durableReplayProof(value);
    const retained = this.openRecords.get(recordKey);
    if (replay.outcome.kind === "opened") {
      const preparedBinding = parseCanonicalBinding(replay.preparedBinding);
      const reconciliation = this.reconcileLocalStreamLineage(key, {
        kind: "opened_replay",
        outcome: replay.outcome,
        fingerprint: requestFingerprint,
        target: request.target,
        preparedBinding,
        ...(retained ? { record: retained } : {}),
      });
      if (reconciliation.status === "divergent") {
        await this.fenceDivergentLocalStream(reconciliation);
        await this.replayDurableOpen(request, key, recordKey, requestFingerprint, replay);
        return;
      }
      if (reconciliation.status === "exact") {
        const record = retained ?? {
          key: recordKey,
          streamKey: key,
          fingerprint: requestFingerprint,
          expiresAt: this.now() + this.limits.controlRetentionMs,
          outcome: this.localOpenOutcome(replay.outcome) as Extract<OpenRecordOutcome, {
            kind: "opened";
          }>,
          resumeToken: reconciliation.stream.resumeToken,
        };
        if (!retained) this.cacheOpenRecord(record);
        await this.replayOpenRecord(request, record, preparedBinding);
        return;
      }
      await this.replayDurableOpen(request, key, recordKey, requestFingerprint, replay);
      return;
    }
    if (retained?.fingerprint !== undefined && retained.fingerprint !== requestFingerprint) {
      throw new RelayV2TerminalManagerError(
        "INTERNAL",
        "local and durable terminal open fingerprints diverged",
      );
    }
    await this.replayDurableOpen(request, key, recordKey, requestFingerprint, replay);
  }

  private async replayDurableOpen(
    request: RelayV2TerminalOpenRequest,
    key: string,
    recordKey: string,
    requestFingerprint: string,
    claim: RelayV2TerminalDurableOpenReplayResult,
  ): Promise<void> {
    const proof = this.durableReplayProof(claim);
    const durable = this.localOpenOutcome(proof.outcome);
    const recovered = proof.outcome.kind === "opened"
      ? this.streamLostFromDurableOpened(proof.outcome)
      : durable;
    this.cacheOpenRecord({
      key: recordKey,
      streamKey: key,
      fingerprint: requestFingerprint,
      expiresAt: this.now() + this.limits.controlRetentionMs,
      outcome: recovered,
    });
    if (recovered.kind === "error") {
      this.throwOpenError(recovered);
      return;
    }
    if (recovered.kind === "reset") {
      await this.sendResetResponse(request, recovered, "open");
      return;
    }
    throw new RelayV2TerminalManagerError(
      "INTERNAL",
      "durable terminal opened replay cannot recover a plaintext resume token",
    );
  }

  private throwOpenError(
    outcome: OpenRecordOutcome,
  ): asserts outcome is Exclude<OpenRecordOutcome, { kind: "error" }> {
    if (outcome.kind === "error") {
      throw new RelayV2TerminalManagerError(outcome.code, outcome.message);
    }
  }

  private async replayOpenRecord(
    request: RelayV2TerminalOpenRequest,
    record: OpenRecord,
    preparedBinding: RelayV2TerminalCanonicalTargetBindingV1,
  ): Promise<void> {
    if (record.outcome.kind === "error") {
      this.throwOpenError(record.outcome);
      return;
    }
    if (record.outcome.kind === "reset") {
      await this.sendResetResponse(request, record.outcome, "open");
      return;
    }
    const stream = this.streams.get(record.streamKey);
    if (
      !stream
      || stream.status === "lost"
      || stream.generation !== record.outcome.generation
      || !exactEffectTargetMatches(stream, preparedBinding)
      || !record.resumeToken
      || !this.validResumeToken(stream, record.resumeToken)
    ) {
      const outcome = this.recoverOpenRecord(record, {
        kind: "reset",
        generation: record.outcome.generation,
        reason: "stream_lost",
        requestedOffset: record.outcome.disposition === "reset"
          ? null
          : record.outcome.replayFromOffset,
        bufferStartOffset: null,
        tailOffset: null,
      });
      await this.sendResetResponse(request, outcome, "open");
      return;
    }
    const through = stream.close?.finalOffset ?? stream.ring.tailOffset;
    if (!this.canReplay(stream, record.outcome.replayFromOffset, through)) {
      const outcome = this.recoverOpenRecord(record, {
        kind: "reset",
        generation: stream.generation,
        reason: "stream_lost",
        requestedOffset: record.outcome.disposition === "reset"
          ? null
          : record.outcome.replayFromOffset,
        bufferStartOffset: null,
        tailOffset: null,
      });
      await this.sendResetResponse(request, outcome, "open");
      return;
    }
    if (!stream.close) {
      await this.setAttachmentDisplaySizeHint(stream, request.cols, request.rows);
    }
    await this.bindOpened(
      request,
      stream,
      record.outcome.disposition,
      record.outcome.replayFromOffset,
      true,
    );
  }

  private async createGeneration(
    request: RelayV2TerminalOpenRequest,
    key: string,
    recordKey: string,
    requestFingerprint: string,
    disposition: "new" | "reset",
    claimAuthority: RelayV2TerminalDurableOpenClaimAuthority,
    previous?: TerminalStream,
  ): Promise<void> {
    let generation: string | null = null;
    generation = claimAuthority.issuedGeneration;
    if (!isOpaqueId(generation)) {
      throw new RelayV2TerminalManagerError("INTERNAL", "durable lineage omitted its issued generation");
    }
    const resolution = await this.prepareCanonicalTarget(
      request,
      key,
      recordKey,
      requestFingerprint,
      claimAuthority,
    );
    if (resolution === null) return;
    const resumeToken = this.issueToken();
    tokenHash(resumeToken);
    if (generation === null) {
      throw new RelayV2TerminalManagerError("INTERNAL", "terminal generation was not initialized");
    }

    let failureStreamEffect: RelayV2TerminalOpenFailureStreamEffect = { kind: "preserve" };
    if (previous) {
      previous.binding = undefined;
      previous.status = "lost";
      previous.detachedUntil = undefined;
      await this.releaseProducerLease(previous);
      this.clearControlWindows(previous);
      this.removeRing(previous, false);
      await this.disposeBackend(previous);
      failureStreamEffect = {
        kind: "retire_previous",
        generation: previous.generation,
      };
    }

    const stream = this.newStream(request, resolution, key, generation, resumeToken);
    try {
      stream.backend = await this.backend.open(
        stream.effectTarget,
        {
          maxChunkBytes: this.limits.maxFrameBytes,
          displaySizeHint: { cols: request.cols, rows: request.rows },
        },
        {
          onBytes: async (data) => {
            if (
              !Number.isSafeInteger(data.byteLength)
              || data.byteLength < 0
              || data.byteLength > this.limits.maxFrameBytes
            ) {
              await this.enqueue(() => this.rejectBackendChunk(key, generation));
              return;
            }
            const copy = Buffer.from(data);
            await this.enqueue(() => this.backendOutput(key, generation, copy));
          },
          onClosed: async (result) => {
            await this.enqueue(() => this.backendClosed(
              key,
              generation,
              normalizeBackendClose(result),
            ));
          },
        },
      );
    } catch {
      await this.releaseProducerLease(stream);
      await this.disposeBackend(stream);
      const outcome: Exclude<OpenRecordOutcome, { kind: "opened" }> = {
        kind: "reset",
        generation,
        reason: "stream_lost",
        requestedOffset: null,
        bufferStartOffset: null,
        tailOffset: null,
      };
      const completed = await this.failOpenRecord(
        request,
        key,
        recordKey,
        requestFingerprint,
        outcome,
        claimAuthority,
        failureStreamEffect,
      );
      if (failureStreamEffect.kind === "retire_previous" && previous) {
        previous.reservedCloseRecord = false;
      }
      this.throwOpenError(completed);
      if (completed.kind === "reset") await this.sendResetResponse(request, completed, "open");
      return;
    }
    const provisional: ProvisionalGeneration = {
      key,
      openRecordKey: recordKey,
      stream,
    };
    const outcome: Extract<OpenRecordOutcome, { kind: "opened" }> = {
      kind: "opened",
      generation,
      disposition,
      replayFromOffset: 0n,
    };
    let completion: OpenCommitResult;
    try {
      completion = await this.settleOpenRecord(
        request,
        key,
        recordKey,
        requestFingerprint,
        { outcome, stream },
        claimAuthority,
        false,
      );
    } catch (error) {
      await this.discardProvisionalGeneration(provisional);
      throw error;
    }
    const completed = completion.outcome;
    if (completion.status === "replay") {
      await this.discardProvisionalGeneration(provisional);
      this.throwOpenError(completed);
      if (completed.kind === "reset") await this.sendResetResponse(request, completed, "open");
      return;
    }
    if (completed.kind !== "opened") {
      await this.discardProvisionalGeneration(provisional);
      this.throwOpenError(completed);
      if (completed.kind === "reset") await this.sendResetResponse(request, completed, "open");
      return;
    }
    this.streams.set(key, stream);
    this.cacheOpenRecord({
      key: recordKey,
      streamKey: key,
      fingerprint: requestFingerprint,
      expiresAt: this.now() + this.limits.controlRetentionMs,
      outcome: completed,
      resumeToken: stream.resumeToken,
    });
    await this.bindOpened(request, stream, completed.disposition, completed.replayFromOffset, false);
  }

  private async discardProvisionalGeneration(
    provisional: ProvisionalGeneration,
  ): Promise<void> {
    const { stream, key, openRecordKey } = provisional;
    stream.status = "lost";
    stream.binding = undefined;
    stream.detachedUntil = undefined;
    stream.pendingCloseResponses.clear();
    stream.reservedCloseRecord = false;
    if (this.streams.get(key) === stream) this.streams.delete(key);
    this.openRecords.delete(openRecordKey);
    this.removeRing(stream, false);
    await this.releaseProducerLease(stream);
    this.clearControlWindows(stream);
    await this.disposeBackend(stream);
  }

  private async resumeGeneration(
    request: RelayV2TerminalOpenRequest,
    stream: TerminalStream | undefined,
    key: string,
    recordKey: string,
    requestFingerprint: string,
    claimAuthority: RelayV2TerminalDurableOpenClaimAuthority,
    requestResumeTokenHash: string,
  ): Promise<void> {
    const resume = request.resume!;
    const requestedOffset = parseCounter(resume.nextOffset, "nextOffset");
    const source = claimAuthority.streamAuthority;
    const authoritativeStream = this.localStreamForAuthority(stream, source);
    let outcome: OpenRecordOutcome;
    if (source.status === "absent") {
      outcome = {
        kind: "reset",
        generation: resume.generation,
        reason: "stream_lost",
        requestedOffset,
        bufferStartOffset: null,
        tailOffset: null,
      };
    } else if (source.generation !== resume.generation) {
      outcome = {
        kind: "reset",
        generation: resume.generation,
        reason: "generation_stale",
        requestedOffset,
        bufferStartOffset: authoritativeStream?.ringRetained
          ? authoritativeStream.ring.startOffset
          : null,
        tailOffset: authoritativeStream?.close?.finalOffset
          ?? authoritativeStream?.ring.tailOffset
          ?? null,
      };
    } else if (
      !authoritativeStream
      || !sameTarget(authoritativeStream.target, request.target)
      || source.pane !== request.pane
      || !safeHashEqual(source.resumeTokenHash, requestResumeTokenHash)
    ) {
      outcome = {
        kind: "reset",
        generation: resume.generation,
        reason: "stream_lost",
        requestedOffset,
        bufferStartOffset: null,
        tailOffset: null,
      };
    } else if (!this.validResumeToken(authoritativeStream, resume.resumeToken)) {
      outcome = {
        kind: "reset",
        generation: resume.generation,
        reason: "stream_lost",
        requestedOffset,
        bufferStartOffset: null,
        tailOffset: null,
      };
    } else {
      const through = authoritativeStream.close?.finalOffset ?? authoritativeStream.ring.tailOffset;
      if (requestedOffset > through) {
        throw new RelayV2TerminalManagerError(
          "INVALID_ARGUMENT",
          "terminal resume offset is beyond the known tail",
        );
      }
      if (!this.canReplay(authoritativeStream, requestedOffset, through)) {
        outcome = {
          kind: "reset",
          generation: authoritativeStream.generation,
          reason: "offset_expired",
          requestedOffset,
          bufferStartOffset: authoritativeStream.ringRetained
            ? authoritativeStream.ring.startOffset
            : null,
          tailOffset: through,
        };
      } else {
        outcome = {
          kind: "opened",
          generation: authoritativeStream.generation,
          disposition: "resumed",
          replayFromOffset: requestedOffset,
        };
      }
    }
    if (outcome.kind === "reset") {
      const completed = await this.failOpenRecord(
        request,
        key,
        recordKey,
        requestFingerprint,
        outcome,
        claimAuthority,
        { kind: "preserve" },
      );
      this.throwOpenError(completed);
      if (completed.kind === "reset") await this.sendResetResponse(request, completed, "open");
      return;
    }
    if (source.status === "absent") {
      throw new RelayV2TerminalManagerError(
        "INTERNAL",
        "opened resume lost its durable retained authority",
      );
    }
    const retainedPrepared = await this.prepareRetainedTarget(
      request,
      key,
      recordKey,
      requestFingerprint,
      claimAuthority,
      source.canonicalBinding,
    );
    if (!retainedPrepared) return;
    if (!authoritativeStream!.close) {
      await this.setAttachmentDisplaySizeHint(authoritativeStream!, request.cols, request.rows);
    }
    const completion = await this.settleOpenRecord(
      request,
      key,
      recordKey,
      requestFingerprint,
      { outcome, stream: authoritativeStream! },
      claimAuthority,
    );
    const completed = completion.outcome;
    this.throwOpenError(completed);
    if (completed.kind === "reset") {
      await this.sendResetResponse(request, completed, "open");
      return;
    }
    await this.bindOpened(
      request,
      authoritativeStream!,
      completed.disposition,
      completed.replayFromOffset,
      false,
    );
  }

  private async resetGeneration(
    request: RelayV2TerminalOpenRequest,
    existing: TerminalStream | undefined,
    key: string,
    recordKey: string,
    requestFingerprint: string,
    claimAuthority: RelayV2TerminalDurableOpenClaimAuthority,
    localWasMissingOrLost: boolean,
    requestResumeTokenHash: string | null,
  ): Promise<void> {
    const source = claimAuthority.streamAuthority;
    const resume = request.resume;
    const sourceIsAbsent = source.status === "absent";
    const validExisting = source.status === "live"
      && !!existing
      && (existing.status === "live" || existing.status === "detached")
      && !!resume
      && source.generation === resume.generation
      && existing.generation === source.generation
      && sameTarget(existing.target, request.target)
      && sameTarget(source.target, request.target)
      && source.pane === request.pane
      && requestResumeTokenHash !== null
      && safeHashEqual(source.resumeTokenHash, requestResumeTokenHash)
      && this.validResumeToken(existing, resume.resumeToken);
    const restartLikeExactPrevious = localWasMissingOrLost
      && !existing
      && source.status === "live"
      && resume !== undefined
      && source.generation === resume.generation
      && sameTarget(source.target, request.target)
      && source.pane === request.pane
      && requestResumeTokenHash !== null
      && safeHashEqual(source.resumeTokenHash, requestResumeTokenHash);
    if (restartLikeExactPrevious) {
      const outcome: Extract<OpenRecordOutcome, { kind: "reset" }> = {
        kind: "reset",
        generation: source.generation,
        reason: "stream_lost",
        requestedOffset: null,
        bufferStartOffset: null,
        tailOffset: null,
      };
      const completed = await this.failOpenRecord(
        request,
        key,
        recordKey,
        requestFingerprint,
        outcome,
        claimAuthority,
        { kind: "retire_previous", generation: source.generation },
      );
      if (
        completed.kind !== "reset"
        || completed.generation !== outcome.generation
        || completed.reason !== outcome.reason
        || completed.requestedOffset !== null
        || completed.bufferStartOffset !== null
        || completed.tailOffset !== null
      ) {
        throw new RelayV2TerminalManagerError(
          "INTERNAL",
          "durable terminal restart retirement changed the stream_lost winner",
        );
      }
      await this.sendResetResponse(request, completed, "open");
      return;
    }
    if (!(sourceIsAbsent && !existing) && !validExisting) {
      const outcome: Exclude<OpenRecordOutcome, { kind: "opened" }> = {
        kind: "reset",
        generation: request.resume?.generation ?? null,
        reason: "stream_lost",
        requestedOffset: null,
        bufferStartOffset: null,
        tailOffset: null,
      };
      const completed = await this.failOpenRecord(
        request,
        key,
        recordKey,
        requestFingerprint,
        outcome,
        claimAuthority,
        { kind: "preserve" },
      );
      this.throwOpenError(completed);
      if (completed.kind === "reset") await this.sendResetResponse(request, completed, "open");
      return;
    }
    await this.createGeneration(
      request,
      key,
      recordKey,
      requestFingerprint,
      "reset",
      claimAuthority,
      validExisting ? existing : undefined,
    );
  }

  private newStream(
    request: RelayV2TerminalOpenRequest,
    resolution: RelayV2TerminalCanonicalResolution,
    key: string,
    generation: string,
    resumeToken: string,
  ): TerminalStream {
    return {
      key,
      auth: { ...request.auth },
      target: { ...request.target },
      resolvedTarget: { ...resolution.target },
      canonicalBinding: cloneCanonicalBinding(resolution.binding),
      effectTarget: exactEffectTarget(resolution.target, resolution.binding),
      streamId: request.streamId,
      generation,
      resumeToken,
      resumeTokenHash: tokenHash(resumeToken),
      status: "live",
      ring: new ByteRing(this.limits.streamRingBytes),
      ringRetained: true,
      backendPaused: false,
      pauseFailed: false,
      producerOwner: {
        kind: "relay-v2",
        instanceId: `relay-v2:${fingerprint([
          this.hostInstanceId,
          request.auth.principalId,
          request.auth.clientInstanceId,
          request.streamId,
          generation,
        ])}`,
      },
      retainedUntil: this.now() + this.limits.controlRetentionMs,
      pendingCloseResponses: new Map(),
      reservedCloseRecord: true,
      inputAcked: 0n,
      inputFloor: 0n,
      inputHashes: new Map(),
      resizeAcked: 0n,
      resizeFloor: 0n,
      resizes: new Map(),
      lastUsedAt: this.now(),
    };
  }

  private async resolveTarget(
    request: RelayV2TerminalOpenRequest,
  ): Promise<RelayV2TerminalCanonicalResolution> {
    const resolved = await this.resolver.resolve({
      auth: { ...request.auth },
      hostEpoch: this.hostEpoch,
      target: { ...request.target },
      pane: request.pane,
    });
    if (!hasExactOwnKeys(resolved, ["target", "binding", "admission"])
      || !hasExactOwnKeys(resolved.target, [
        "hostId", "scopeId", "sessionId", "pane", "canonicalTargetId", "controlTargetId",
      ])) {
      throw new RelayV2TerminalManagerError(
        "INTERNAL",
        "canonical terminal resolver returned a mismatched target",
      );
    }
    const target = resolved.target as unknown as RelayV2TerminalResolvedTarget;
    const binding = parseCanonicalBinding(resolved.binding);
    if (!sameTarget(target, request.target)
      || target.pane !== request.pane
      || !isOpaqueId(target.canonicalTargetId)
      || !isOpaqueId(target.controlTargetId)
      || !sameTarget(binding, request.target)
      || binding.pane !== request.pane
      || binding.backendInstanceKey !== target.canonicalTargetId
      || binding.exactControlIdentity.controlTargetId !== target.controlTargetId
      || !hasExactOwnKeys(resolved.admission, [
        "resourceToken", "resourceTarget", "exactControlToken",
      ])
      || !isOpaqueId(resolved.admission.exactControlToken)
      || !hasExactOwnKeys(resolved.admission.resourceToken, [
        "schemaVersion", "hostEpoch", "resourceMappingDigest", "discoveryGeneration",
      ])
      || resolved.admission.resourceToken.schemaVersion !== 1
      || resolved.admission.resourceToken.hostEpoch !== this.hostEpoch
      || !isOpaqueId(resolved.admission.resourceToken.resourceMappingDigest)
      || !isOpaqueId(resolved.admission.resourceToken.discoveryGeneration)) {
      throw new RelayV2TerminalManagerError(
        "INTERNAL",
        "canonical terminal resolver returned incomplete exact evidence",
      );
    }
    const resourceTarget = resolved.admission.resourceTarget;
    if (!resourceTarget
      || resourceTarget.authorization !== "evidence_only"
      || resourceTarget.hostEpoch !== this.hostEpoch
      || resourceTarget.discoveryGeneration
        !== resolved.admission.resourceToken.discoveryGeneration
      || resourceTarget.scopeId !== request.target.scopeId
      || resourceTarget.sessionId !== request.target.sessionId
      || resourceTarget.backendInstanceKey !== binding.backendInstanceKey
      || resourceTarget.processTarget.kind !== binding.processTarget.kind
      || resourceTarget.processTarget.targetId !== binding.processTarget.targetId
      || resourceTarget.managedTarget.name !== binding.managedTarget.name
      || resourceTarget.managedTarget.kind !== binding.managedTarget.kind
      || resourceTarget.managedTarget.incarnation !== binding.managedTarget.incarnation) {
      throw new RelayV2TerminalManagerError(
        "INTERNAL",
        "canonical terminal resolver evidence disagrees with its exact binding",
      );
    }
    return {
      target: { ...target },
      binding: cloneCanonicalBinding(binding),
      admission: {
        resourceToken: { ...resolved.admission.resourceToken },
        resourceTarget: {
          ...resourceTarget,
          processTarget: { ...resourceTarget.processTarget },
          capabilities: [...resourceTarget.capabilities],
          managedTarget: { ...resourceTarget.managedTarget },
        },
        exactControlToken: resolved.admission.exactControlToken,
      },
    };
  }

  private async prepareCanonicalTarget(
    request: RelayV2TerminalOpenRequest,
    key: string,
    recordKey: string,
    requestFingerprint: string,
    claimAuthority: RelayV2TerminalDurableOpenClaimAuthority,
  ): Promise<RelayV2TerminalCanonicalResolution | null> {
    let resolution: RelayV2TerminalCanonicalResolution;
    try {
      resolution = await this.resolveTarget(request);
      const prepared = await this.lineage.prepareOpen({
        key: recordKey,
        fingerprint: requestFingerprint,
        hostInstanceId: this.hostInstanceId,
        claimToken: claimAuthority.claimToken,
        fence: claimAuthority.fence,
        preparation: { kind: "current", resolution },
      });
      if (!prepared || typeof prepared !== "object") {
        throw new RelayV2TerminalManagerError(
          "CAPABILITY_UNAVAILABLE",
          "exact terminal target preparation is unavailable",
        );
      }
      if (prepared.status === "replay") {
        await this.reconcileAndReplayDurableOpen(
          request,
          key,
          recordKey,
          requestFingerprint,
          prepared,
        );
        return null;
      }
      if (!hasExactOwnKeys(prepared, ["status", "binding"])
        || prepared.status !== "prepared") {
        throw new RelayV2TerminalManagerError(
          "CAPABILITY_UNAVAILABLE",
          "exact terminal target preparation is unavailable",
        );
      }
      const durableBinding = parseCanonicalBinding(prepared.binding);
      if (!sameCanonicalBinding(durableBinding, resolution.binding)) {
        throw new RelayV2TerminalManagerError(
          "CAPABILITY_UNAVAILABLE",
          "durable terminal preparation changed the exact target binding",
        );
      }
      return resolution;
    } catch (error) {
      const message = error instanceof RelayV2TerminalManagerError
        && error.code === "CAPABILITY_UNAVAILABLE"
        ? error.message
        : "exact terminal target is unavailable";
      const completed = await this.failOpenRecord(
        request,
        key,
        recordKey,
        requestFingerprint,
        { kind: "error", code: "CAPABILITY_UNAVAILABLE", message },
        claimAuthority,
        { kind: "preserve" },
      );
      this.throwOpenError(completed);
      if (completed.kind === "reset") {
        await this.sendResetResponse(request, completed, "open");
        return null;
      }
      throw new RelayV2TerminalManagerError(
        "CAPABILITY_UNAVAILABLE",
        "exact terminal target is unavailable",
      );
    }
  }

  private async prepareRetainedTarget(
    request: RelayV2TerminalOpenRequest,
    key: string,
    recordKey: string,
    requestFingerprint: string,
    claimAuthority: RelayV2TerminalDurableOpenClaimAuthority,
    binding: RelayV2TerminalCanonicalTargetBindingV1,
  ): Promise<boolean> {
    try {
      const prepared = await this.lineage.prepareOpen({
        key: recordKey,
        fingerprint: requestFingerprint,
        hostInstanceId: this.hostInstanceId,
        claimToken: claimAuthority.claimToken,
        fence: claimAuthority.fence,
        preparation: {
          kind: "retained",
          binding: cloneCanonicalBinding(binding),
        },
      });
      if (prepared.status === "replay") {
        await this.reconcileAndReplayDurableOpen(
          request,
          key,
          recordKey,
          requestFingerprint,
          prepared,
        );
        return false;
      }
      if (!hasExactOwnKeys(prepared, ["status", "binding"])
        || prepared.status !== "prepared") {
        throw new RelayV2TerminalManagerError(
          "INTERNAL",
          "durable resume preparation returned an invalid closed shape",
        );
      }
      const durableBinding = parseCanonicalBinding(prepared.binding);
      if (!sameCanonicalBinding(durableBinding, binding)) {
        throw new RelayV2TerminalManagerError(
          "INTERNAL",
          "durable resume preparation changed the retained exact binding",
        );
      }
      return true;
    } catch {
      const reset: Extract<OpenRecordOutcome, { kind: "reset" }> = {
        kind: "reset",
        generation: request.resume?.generation ?? null,
        reason: "stream_lost",
        requestedOffset: request.mode === "resume" && request.resume
          ? parseCounter(request.resume.nextOffset, "nextOffset")
          : null,
        bufferStartOffset: null,
        tailOffset: null,
      };
      const completed = await this.failOpenRecord(
        request,
        key,
        recordKey,
        requestFingerprint,
        reset,
        claimAuthority,
        { kind: "preserve" },
      );
      this.throwOpenError(completed);
      if (completed.kind === "reset") {
        await this.sendResetResponse(request, completed, "open");
        return false;
      }
      return false;
    }
  }

  private async setAttachmentDisplaySizeHint(
    stream: TerminalStream,
    cols: number,
    rows: number,
  ): Promise<void> {
    if (!stream.backend) return;
    await stream.backend.setDisplaySizeHint({ cols, rows });
  }

  private setProducerLease(
    stream: TerminalStream,
    lease: RelayV2TerminalProducerLease,
  ): RelayV2TerminalProducerLease {
    const now = this.now();
    const expiresAtMs = Date.parse(lease.expiresAt);
    stream.producerLease = {
      ...lease,
      owner: { ...lease.owner },
    };
    stream.renewLeaseAfter = now + Math.max(1, Math.floor((expiresAtMs - now) / 2));
    return lease;
  }

  private async acquireProducerLease(stream: TerminalStream): Promise<RelayV2TerminalLeaseResult> {
    try {
      const result = validateLeaseResult(
        await this.terminalControl.acquire({
          target: stream.effectTarget,
          auth: { ...stream.auth },
          owner: { ...stream.producerOwner },
        }),
        stream.resolvedTarget,
        stream.producerOwner,
        this.now(),
      );
      if (result.status === "accepted") this.setProducerLease(stream, result.lease);
      if (result.status === "uncertain") stream.controlInDoubt = result.error;
      return result;
    } catch (error) {
      const failure = controlFailure(error);
      if (failure.status === "uncertain") stream.controlInDoubt = failure.error;
      return failure;
    }
  }

  private async ensureProducerLease(stream: TerminalStream): Promise<RelayV2TerminalLeaseResult> {
    if (!stream.producerLease) {
      return this.acquireProducerLease(stream);
    }
    const lease = stream.producerLease;
    if (Date.parse(lease.expiresAt) <= this.now()) {
      const released = await this.releaseProducerLease(stream);
      this.clearControlWindows(stream);
      if (released.status === "uncertain") {
        stream.controlInDoubt = released.error;
        return { status: "uncertain", error: released.error };
      }
      return this.acquireProducerLease(stream);
    }
    let continuous: boolean;
    try {
      continuous = await this.terminalControl.hasContinuity({
        target: stream.effectTarget,
        auth: { ...stream.auth },
        owner: { ...stream.producerOwner },
        lease: { ...lease, owner: { ...lease.owner } },
      });
    } catch (error) {
      const failure = controlFailure(error);
      if (failure.status === "uncertain") {
        this.dropProducerLease(stream);
        stream.controlInDoubt = failure.error;
      }
      return failure;
    }
    if (continuous !== true) {
      const released = await this.releaseProducerLease(stream);
      this.clearControlWindows(stream);
      if (released.status === "uncertain") {
        stream.controlInDoubt = released.error;
        return { status: "uncertain", error: released.error };
      }
      return {
        status: "rejected",
        error: {
          code: "PERMISSION_DENIED",
          message: "terminal-control producer lease continuity was lost",
          retryable: false,
          details: null,
          commandDisposition: "not_applicable",
        },
      };
    }
    if (this.now() < (stream.renewLeaseAfter ?? 0)) {
      return { status: "accepted", lease: { ...lease, owner: { ...lease.owner } } };
    }
    try {
      const renewed = validateLeaseResult(
        await this.terminalControl.renew({
          target: stream.effectTarget,
          auth: { ...stream.auth },
          owner: { ...stream.producerOwner },
          lease: { ...lease, owner: { ...lease.owner } },
        }),
        stream.resolvedTarget,
        stream.producerOwner,
        this.now(),
        lease,
      );
      if (renewed.status === "accepted") {
        this.setProducerLease(stream, renewed.lease);
        return renewed;
      }
      if (renewed.status === "uncertain") {
        this.dropProducerLease(stream);
        stream.controlInDoubt = renewed.error;
        return renewed;
      }
      const released = await this.releaseProducerLease(stream);
      this.clearControlWindows(stream);
      if (released.status === "uncertain") {
        stream.controlInDoubt = released.error;
        return { status: "uncertain", error: released.error };
      }
      return renewed;
    } catch (error) {
      const failure = controlFailure(error);
      if (failure.status === "uncertain") {
        this.dropProducerLease(stream);
        stream.controlInDoubt = failure.error;
      } else {
        const released = await this.releaseProducerLease(stream);
        this.clearControlWindows(stream);
        if (released.status === "uncertain") {
          stream.controlInDoubt = released.error;
          return { status: "uncertain", error: released.error };
        }
      }
      return failure;
    }
  }

  private dropProducerLease(stream: TerminalStream): void {
    stream.producerLease = undefined;
    stream.renewLeaseAfter = undefined;
  }

  private async releaseProducerLease(stream: TerminalStream): Promise<ProducerReleaseResult> {
    const lease = stream.producerLease;
    stream.producerLease = undefined;
    stream.renewLeaseAfter = undefined;
    if (!lease) {
      if (stream.retiringLease) {
        return {
          status: "uncertain",
          error: stream.controlInDoubt ?? {
            code: "COMMAND_IN_DOUBT",
            message: "terminal-control release has not converged",
            retryable: false,
            details: null,
            commandDisposition: "in_doubt",
          },
          lease: { ...stream.retiringLease, owner: { ...stream.retiringLease.owner } },
        };
      }
      return { status: "released" };
    }
    try {
      await this.terminalControl.release({
        target: stream.effectTarget,
        auth: { ...stream.auth },
        owner: { ...stream.producerOwner },
        lease: { ...lease, owner: { ...lease.owner } },
      });
      stream.retiringLease = undefined;
      return { status: "released" };
    } catch (error) {
      const failure = controlFailure(error);
      if (failure.status === "uncertain") {
        stream.retiringLease = { ...lease, owner: { ...lease.owner } };
        return { status: "uncertain", error: failure.error, lease };
      }
      stream.retiringLease = undefined;
      return { status: "rejected", error: failure.error };
    }
  }

  private async endRouteControl(stream: TerminalStream): Promise<void> {
    const result = await this.releaseProducerLease(stream);
    this.clearControlWindows(stream);
    if (result.status === "uncertain") {
      stream.controlInDoubt = result.error;
    }
  }

  private async reconcileRetiringLease(stream: TerminalStream): Promise<void> {
    const lease = stream.retiringLease;
    if (!lease) return;
    try {
      const continuous = await this.terminalControl.hasContinuity({
        target: stream.effectTarget,
        auth: { ...stream.auth },
        owner: { ...stream.producerOwner },
        lease: { ...lease, owner: { ...lease.owner } },
      });
      if (continuous !== true && continuous !== false) {
        throw new RelayV2TerminalManagerError(
          "INTERNAL",
          "terminal-control returned an invalid release continuity result",
        );
      }
      if (continuous === true) {
        await this.terminalControl.release({
          target: stream.effectTarget,
          auth: { ...stream.auth },
          owner: { ...stream.producerOwner },
          lease: { ...lease, owner: { ...lease.owner } },
        });
      }
      stream.retiringLease = undefined;
      stream.controlInDoubt = undefined;
    } catch (error) {
      const failure = controlFailure(error);
      if (failure.status === "rejected") {
        stream.retiringLease = undefined;
        stream.controlInDoubt = undefined;
        return;
      }
      stream.controlInDoubt = failure.error;
    }
  }

  private clearControlWindows(stream: TerminalStream): void {
    stream.inputHashes.clear();
    stream.inputFloor = stream.inputAcked;
    stream.pendingInput = undefined;
    stream.resizes.clear();
    stream.resizeFloor = stream.resizeAcked;
    stream.pendingResize = undefined;
    stream.controlInDoubt = undefined;
  }

  private validResumeToken(stream: TerminalStream, token: string): boolean {
    return safeHashEqual(
      stream.resumeTokenHash,
      tokenHash(token),
    );
  }

  private canReplay(stream: TerminalStream, from: bigint, through: bigint): boolean {
    return stream.ringRetained && stream.ring.hasRange(from, through);
  }

  private localStreamForAuthority(
    stream: TerminalStream | undefined,
    authority: RelayV2TerminalDurableStreamAuthority,
  ): TerminalStream | undefined {
    if (
      !stream
      || authority.status === "absent"
      || stream.generation !== authority.generation
      || !sameTarget(stream.target, authority.target)
      || stream.resolvedTarget.pane !== authority.pane
      || !safeHashEqual(stream.resumeTokenHash, authority.resumeTokenHash)
      || !exactEffectTargetMatches(stream, authority.canonicalBinding)
    ) {
      return undefined;
    }
    if (authority.status === "closed") {
      return stream.status === "closed" && !!stream.close ? stream : undefined;
    }
    return stream.status === "live" || stream.status === "detached" ? stream : undefined;
  }

  private prepareClosedNotification(
    stream: TerminalStream,
    route: RelayV2TerminalRuntimeBinding,
  ): "event" | null {
    if (!stream.close) return null;
    const record = [...this.closeRecords.values()].find((candidate) => (
      candidate.streamKey === stream.key
      && candidate.generation === stream.generation
      && (stream.closeId === undefined || candidate.closeId === stream.closeId)
    ));
    if (record) return null;
    if (stream.close.reason === "client_closed") {
      throw new RelayV2TerminalManagerError(
        "INTERNAL",
        "explicit terminal close is missing its correlated tombstone",
      );
    }
    return "event";
  }

  private queueCloseResponse(
    stream: TerminalStream,
    route: RelayV2TerminalRuntimeBinding,
    requestId: string,
    closeRecordKey: string,
    deduplicated: boolean,
  ): void {
    const key = routeRequestKey(route, requestId);
    if (!stream.pendingCloseResponses.has(key) && stream.pendingCloseResponses.size >= 64) {
      throw new RelayV2TerminalManagerError("BUSY", "terminal close response queue is full");
    }
    stream.pendingCloseResponses.set(key, {
      requestId,
      route: cloneRuntimeBinding(route),
      closeRecordKey,
      deduplicated,
    });
  }

  private async fenceChangedBinding(
    stream: TerminalStream,
    nextRoute: RelayV2TerminalRuntimeBinding,
  ): Promise<void> {
    if (!stream.binding || sameRuntimeBinding(stream.binding.route, nextRoute)) return;
    await this.endRouteControl(stream);
    for (const [key, pending] of stream.pendingCloseResponses) {
      if (!sameRuntimeBinding(pending.route, nextRoute)) stream.pendingCloseResponses.delete(key);
    }
  }

  private async bindOpened(
    request: RelayV2TerminalOpenRequest,
    stream: TerminalStream,
    disposition: "new" | "resumed" | "reset",
    replayFromOffset: bigint,
    deduplicated: boolean,
  ): Promise<void> {
    const through = stream.close?.finalOffset ?? stream.ring.tailOffset;
    await this.fenceChangedBinding(stream, request.route);
    stream.status = stream.close ? "closed" : "live";
    stream.detachedUntil = undefined;
    stream.binding = {
      route: cloneRuntimeBinding(request.route),
      ackedOffset: replayFromOffset,
      sentThroughOffset: replayFromOffset,
      phase: "replay",
      replayBoundary: through,
      closeNotification: this.prepareClosedNotification(stream, request.route),
      closeNotified: false,
    };
    stream.lastUsedAt = this.now();
    await this.sendFrame(request.route, asJson({
      protocolVersion: 2,
      kind: "response",
      type: "terminal.opened",
      requestId: request.requestId,
      hostId: this.hostId,
      hostEpoch: this.hostEpoch,
      scopeId: stream.target.scopeId,
      sessionId: stream.target.sessionId,
      streamId: stream.streamId,
      hostInstanceId: this.hostInstanceId,
      payload: {
        openId: request.openId,
        deduplicated,
        generation: stream.generation,
        resumeToken: stream.resumeToken,
        disposition,
        replayFromOffset: replayFromOffset.toString(10),
        bufferStartOffset: stream.ring.startOffset.toString(10),
        tailOffset: through.toString(10),
        maxUnackedBytes: this.limits.maxUnackedBytes,
        resetReason: null,
      },
    }));
    await this.pump(stream);
    await this.refreshBackpressure();
  }

  private async sendResetResponse(
    request: RelayV2TerminalRequestContext,
    outcome: Extract<OpenRecordOutcome, { kind: "reset" }>,
    origin: "open" | "replay",
  ): Promise<void> {
    let lineage: RelayV2TerminalOpenResponseLineage | undefined;
    if (origin === "open") {
      if (!("openId" in request)
        || !("mode" in request)
        || !isOpaqueId(request.openId)
        || !(request.mode === "new" || request.mode === "resume" || request.mode === "reset")) {
        throw new RelayV2TerminalManagerError(
          "INTERNAL",
          "terminal open reset lost its process-local request lineage",
        );
      }
      lineage = Object.freeze({
        owner: "terminal.open",
        requestId: request.requestId,
        openId: request.openId,
        mode: request.mode,
        generation: outcome.generation,
        requestedOffset: outcome.requestedOffset?.toString(10) ?? null,
      });
    }
    await this.sendFrame(request.route, asJson({
      protocolVersion: 2,
      kind: "response",
      type: "terminal.reset_required",
      requestId: request.requestId,
      hostId: this.hostId,
      hostEpoch: this.hostEpoch,
      scopeId: request.target.scopeId,
      sessionId: request.target.sessionId,
      streamId: request.streamId,
      payload: {
        origin,
        generation: outcome.generation,
        reason: outcome.reason,
        requestedOffset: outcome.requestedOffset?.toString(10) ?? null,
        bufferStartOffset: outcome.bufferStartOffset?.toString(10) ?? null,
        tailOffset: outcome.tailOffset?.toString(10) ?? null,
      },
    }), lineage);
  }

  private async replayInternal(request: RelayV2TerminalReplayRequest): Promise<void> {
    this.assertHost(request);
    await this.sweepInternal();
    const fromOffset = parseCounter(request.fromOffset, "fromOffset");
    const stream = this.streams.get(this.streamKey(request.auth, request.streamId));
    if (!stream || stream.status === "lost") {
      await this.sendResetResponse(request, {
        kind: "reset",
        generation: request.generation,
        reason: "stream_lost",
        requestedOffset: fromOffset,
        bufferStartOffset: null,
        tailOffset: null,
      }, "replay");
      return;
    }
    if (!stream.binding || !sameRuntimeBinding(stream.binding.route, request.route)) {
      throw new RelayV2TerminalManagerError(
        "TERMINAL_ROUTE_STALE",
        "terminal route binding is stale",
      );
    }
    if (!sameTarget(stream.target, request.target)) {
      await this.sendResetResponse(request, {
        kind: "reset",
        generation: request.generation,
        reason: "stream_lost",
        requestedOffset: fromOffset,
        bufferStartOffset: null,
        tailOffset: null,
      }, "replay");
      return;
    }
    const through = stream.close?.finalOffset ?? stream.ring.tailOffset;
    if (stream.generation !== request.generation) {
      await this.sendResetResponse(request, {
        kind: "reset",
        generation: request.generation,
        reason: "generation_stale",
        requestedOffset: fromOffset,
        bufferStartOffset: stream.ringRetained ? stream.ring.startOffset : null,
        tailOffset: through,
      }, "replay");
      return;
    }
    if (fromOffset > through) {
      throw new RelayV2TerminalManagerError(
        "INVALID_ARGUMENT",
        "terminal replay offset is beyond the known tail",
      );
    }
    if (!this.canReplay(stream, fromOffset, through)) {
      await this.sendResetResponse(request, {
        kind: "reset",
        generation: stream.generation,
        reason: "offset_expired",
        requestedOffset: fromOffset,
        bufferStartOffset: stream.ringRetained ? stream.ring.startOffset : null,
        tailOffset: through,
      }, "replay");
      return;
    }
    await this.fenceChangedBinding(stream, request.route);
    stream.binding = {
      route: cloneRuntimeBinding(request.route),
      ackedOffset: fromOffset,
      sentThroughOffset: fromOffset,
      phase: "replay",
      replayBoundary: through,
      closeNotification: this.prepareClosedNotification(stream, request.route),
      closeNotified: false,
    };
    await this.sendFrame(request.route, asJson({
      protocolVersion: 2,
      kind: "response",
      type: "terminal.replay_started",
      requestId: request.requestId,
      hostId: this.hostId,
      hostEpoch: this.hostEpoch,
      scopeId: stream.target.scopeId,
      sessionId: stream.target.sessionId,
      streamId: stream.streamId,
      payload: {
        generation: stream.generation,
        fromOffset: fromOffset.toString(10),
        tailOffsetAtStart: through.toString(10),
      },
    }));
    await this.pump(stream);
    await this.refreshBackpressure();
  }

  private requireBoundStream(context: RelayV2TerminalStreamContext): TerminalStream;
  private requireBoundStream(context: RelayV2TerminalRequestContext): TerminalStream;
  private requireBoundStream(
    context: RelayV2TerminalStreamContext | RelayV2TerminalRequestContext,
  ): TerminalStream {
    const stream = this.streams.get(this.streamKey(context.auth, context.streamId));
    if (!stream || stream.status === "lost") {
      throw new RelayV2TerminalManagerError(
        "TERMINAL_STREAM_NOT_FOUND",
        "terminal stream is not retained",
      );
    }
    if (!stream.binding || !sameRuntimeBinding(stream.binding.route, context.route)) {
      throw new RelayV2TerminalManagerError(
        "TERMINAL_ROUTE_STALE",
        "terminal route binding is stale",
      );
    }
    if ("generation" in context && context.generation !== stream.generation) {
      throw new RelayV2TerminalManagerError(
        "TERMINAL_GENERATION_STALE",
        "terminal generation is stale",
      );
    }
    if ("target" in context && !sameTarget(stream.target, context.target)) {
      throw new RelayV2TerminalManagerError(
        "TERMINAL_STREAM_CONFLICT",
        "terminal target does not match the retained stream",
      );
    }
    return stream;
  }

  private async outputAckInternal(ack: RelayV2TerminalOutputAck): Promise<void> {
    await this.sweepInternal();
    const stream = this.requireBoundStream(ack);
    const binding = stream.binding!;
    const nextOffset = parseCounter(ack.nextOffset, "nextOffset");
    if (nextOffset > binding.sentThroughOffset) {
      throw new RelayV2TerminalManagerError(
        "TERMINAL_INVALID_ACK",
        "terminal ACK exceeds bytes sent on the current binding",
      );
    }
    if (nextOffset <= binding.ackedOffset) return;
    binding.ackedOffset = nextOffset;
    this.ringBytes -= stream.ring.discardBefore(nextOffset);
    if (this.ringBytes < 0) throw new Error("Relay v2 terminal ring accounting underflow");
    stream.lastUsedAt = this.now();
    await this.pump(stream);
    await this.refreshBackpressure();
  }

  private async inputInternal(input: RelayV2TerminalInput): Promise<void> {
    await this.sweepInternal();
    const stream = this.requireBoundStream(input);
    if (stream.status === "closed") {
      throw new RelayV2TerminalManagerError(
        "TERMINAL_STREAM_NOT_FOUND",
        "terminal stream is already closed",
      );
    }
    if (input.data.byteLength > this.limits.maxFrameBytes) {
      throw new RelayV2TerminalManagerError("INVALID_ARGUMENT", "terminal input exceeds 64 KiB");
    }
    const seq = parsePositiveCounter(input.inputSeq, "inputSeq");
    const hash = payloadHash(input.data);
    if (seq <= stream.inputFloor) {
      await this.sendInputAck(stream);
      return;
    }
    if (seq <= stream.inputAcked) {
      const retained = stream.inputHashes.get(seq.toString(10));
      if (!retained || retained.hash !== hash) {
        await this.sendInputError(stream, seq, "TERMINAL_INPUT_CONFLICT", false);
        return;
      }
      await this.sendInputAck(stream);
      return;
    }
    await this.reconcileRetiringLease(stream);
    if (stream.controlInDoubt) {
      await this.sendAuthorityError(stream, "input", seq, stream.controlInDoubt);
      return;
    }
    const expected = stream.inputAcked + 1n;
    if (seq !== expected) {
      await this.sendInputError(stream, seq, "TERMINAL_INPUT_GAP", true);
      return;
    }
    if (
      stream.pendingInput
      && (stream.pendingInput.seq !== seq || stream.pendingInput.fingerprint !== hash)
    ) {
      await this.sendInputError(stream, seq, "TERMINAL_INPUT_CONFLICT", false);
      return;
    }
    if (stream.pendingInput?.state === "in_doubt") {
      await this.sendAuthorityError(stream, "input", seq, stream.pendingInput.error!);
      return;
    }
    stream.pendingInput = { seq, fingerprint: hash, state: "ready" };
    const leaseResult = await this.ensureProducerLease(stream);
    if (leaseResult.status !== "accepted") {
      if (leaseResult.status === "uncertain") {
        stream.controlInDoubt = leaseResult.error;
        stream.pendingInput = {
          seq,
          fingerprint: hash,
          state: "in_doubt",
          error: leaseResult.error,
        };
      } else if (stream.pendingInput?.seq === seq) {
        stream.pendingInput = undefined;
      }
      await this.sendAuthorityError(stream, "input", seq, leaseResult.error);
      return;
    }
    let result: RelayV2TerminalAuthorityResult;
    try {
      result = validateAuthorityResult(await this.terminalControl.writeInput({
        target: stream.effectTarget,
        auth: { ...stream.auth },
        owner: { ...stream.producerOwner },
        lease: { ...leaseResult.lease, owner: { ...leaseResult.lease.owner } },
        operationId: this.operationId(stream, "input", seq),
        data: Buffer.from(input.data),
      }), "input");
    } catch (error) {
      const failure = controlFailure(error);
      result = {
        accepted: false,
        uncertain: failure.status === "uncertain",
        error: failure.error,
      };
    }
    if (result.accepted === false) {
      if (result.uncertain) {
        this.dropProducerLease(stream);
        stream.controlInDoubt = result.error;
        stream.pendingInput = {
          seq,
          fingerprint: hash,
          state: "in_doubt",
          error: result.error,
        };
      } else {
        if (result.error.code === "PERMISSION_DENIED") {
          await this.releaseProducerLease(stream);
          this.clearControlWindows(stream);
        }
        if (stream.pendingInput?.seq === seq) stream.pendingInput = undefined;
      }
      await this.sendAuthorityError(stream, "input", seq, result.error);
      return;
    }
    stream.inputAcked = seq;
    stream.inputHashes.set(seq.toString(10), { hash });
    stream.pendingInput = undefined;
    this.trimInputWindow(stream);
    await this.sendInputAck(stream);
  }

  private async resizeInternal(resize: RelayV2TerminalResize): Promise<void> {
    await this.sweepInternal();
    const stream = this.requireBoundStream(resize);
    if (stream.status === "closed") {
      throw new RelayV2TerminalManagerError(
        "TERMINAL_STREAM_NOT_FOUND",
        "terminal stream is already closed",
      );
    }
    validateSize(resize.cols, resize.rows);
    const seq = parsePositiveCounter(resize.resizeSeq, "resizeSeq");
    const sizeFingerprint = `${resize.cols}x${resize.rows}`;
    if (seq <= stream.resizeFloor) {
      await this.sendResizeAck(stream);
      return;
    }
    if (seq <= stream.resizeAcked) {
      const retained = stream.resizes.get(seq.toString(10));
      if (!retained || retained.cols !== resize.cols || retained.rows !== resize.rows) {
        await this.sendResizeError(stream, seq, "TERMINAL_RESIZE_CONFLICT", false);
        return;
      }
      await this.sendResizeAck(stream);
      return;
    }
    await this.reconcileRetiringLease(stream);
    if (stream.controlInDoubt) {
      await this.sendAuthorityError(stream, "resize", seq, stream.controlInDoubt);
      return;
    }
    const expected = stream.resizeAcked + 1n;
    if (seq !== expected) {
      await this.sendResizeError(stream, seq, "TERMINAL_RESIZE_GAP", true);
      return;
    }
    if (
      stream.pendingResize
      && (
        stream.pendingResize.seq !== seq
        || stream.pendingResize.fingerprint !== sizeFingerprint
      )
    ) {
      await this.sendResizeError(stream, seq, "TERMINAL_RESIZE_CONFLICT", false);
      return;
    }
    if (stream.pendingResize?.state === "in_doubt") {
      await this.sendAuthorityError(stream, "resize", seq, stream.pendingResize.error!);
      return;
    }
    stream.pendingResize = { seq, fingerprint: sizeFingerprint, state: "ready" };
    const leaseResult = await this.ensureProducerLease(stream);
    if (leaseResult.status !== "accepted") {
      if (leaseResult.status === "uncertain") {
        stream.controlInDoubt = leaseResult.error;
        stream.pendingResize = {
          seq,
          fingerprint: sizeFingerprint,
          state: "in_doubt",
          error: leaseResult.error,
        };
      } else if (stream.pendingResize?.seq === seq) {
        stream.pendingResize = undefined;
      }
      await this.sendAuthorityError(stream, "resize", seq, leaseResult.error);
      return;
    }
    let result: RelayV2TerminalAuthorityResult;
    try {
      result = validateAuthorityResult(await this.terminalControl.resize({
        target: stream.effectTarget,
        auth: { ...stream.auth },
        owner: { ...stream.producerOwner },
        lease: { ...leaseResult.lease, owner: { ...leaseResult.lease.owner } },
        operationId: this.operationId(stream, "resize", seq),
        cols: resize.cols,
        rows: resize.rows,
      }), "resize");
    } catch (error) {
      const failure = controlFailure(error);
      result = {
        accepted: false,
        uncertain: failure.status === "uncertain",
        error: failure.error,
      };
    }
    if (result.accepted === false) {
      if (result.uncertain) {
        this.dropProducerLease(stream);
        stream.controlInDoubt = result.error;
        stream.pendingResize = {
          seq,
          fingerprint: sizeFingerprint,
          state: "in_doubt",
          error: result.error,
        };
      } else {
        if (result.error.code === "PERMISSION_DENIED") {
          await this.releaseProducerLease(stream);
          this.clearControlWindows(stream);
        }
        if (stream.pendingResize?.seq === seq) stream.pendingResize = undefined;
      }
      await this.sendAuthorityError(stream, "resize", seq, result.error);
      return;
    }
    stream.resizeAcked = seq;
    stream.resizes.set(seq.toString(10), { cols: resize.cols, rows: resize.rows });
    stream.pendingResize = undefined;
    this.trimResizeWindow(stream);
    await this.sendResizeAck(stream);
  }

  private operationId(
    stream: TerminalStream,
    kind: "input" | "resize",
    seq: bigint,
  ): string {
    return [
      "relay-v2",
      this.hostInstanceId,
      stream.streamId,
      stream.generation,
      kind,
      seq.toString(10),
    ].join(":");
  }

  private trimInputWindow(stream: TerminalStream): void {
    while (stream.inputHashes.size > this.limits.inputDedupeEntries) {
      const next = stream.inputFloor + 1n;
      stream.inputHashes.delete(next.toString(10));
      stream.inputFloor = next;
    }
  }

  private trimResizeWindow(stream: TerminalStream): void {
    while (stream.resizes.size > this.limits.resizeDedupeEntries) {
      const next = stream.resizeFloor + 1n;
      stream.resizes.delete(next.toString(10));
      stream.resizeFloor = next;
    }
  }

  private async sendInputAck(stream: TerminalStream): Promise<void> {
    const binding = stream.binding;
    if (!binding) return;
    await this.sendFrame(binding.route, asJson({
      protocolVersion: 2,
      kind: "event",
      type: "terminal.input_ack",
      streamId: stream.streamId,
      payload: {
        generation: stream.generation,
        ackedThroughInputSeq: stream.inputAcked.toString(10),
      },
    }));
  }

  private async sendResizeAck(stream: TerminalStream): Promise<void> {
    const binding = stream.binding;
    if (!binding) return;
    await this.sendFrame(binding.route, asJson({
      protocolVersion: 2,
      kind: "event",
      type: "terminal.resize_ack",
      streamId: stream.streamId,
      payload: {
        generation: stream.generation,
        ackedThroughResizeSeq: stream.resizeAcked.toString(10),
      },
    }));
  }

  private async sendInputError(
    stream: TerminalStream,
    seq: bigint,
    code: "TERMINAL_INPUT_GAP" | "TERMINAL_INPUT_CONFLICT",
    retryable: boolean,
  ): Promise<void> {
    const expected = stream.inputAcked + 1n;
    await this.sendAuthorityError(stream, "input", seq, {
      code,
      message: code === "TERMINAL_INPUT_GAP"
        ? `Expected inputSeq ${expected.toString(10)}`
        : "inputSeq payload conflicts with the retained hash",
      retryable,
      details: null,
    });
  }

  private async sendResizeError(
    stream: TerminalStream,
    seq: bigint,
    code: "TERMINAL_RESIZE_GAP" | "TERMINAL_RESIZE_CONFLICT",
    retryable: boolean,
  ): Promise<void> {
    const expected = stream.resizeAcked + 1n;
    await this.sendAuthorityError(stream, "resize", seq, {
      code,
      message: code === "TERMINAL_RESIZE_GAP"
        ? `Expected resizeSeq ${expected.toString(10)}`
        : "resizeSeq dimensions conflict with the retained value",
      retryable,
      details: null,
    });
  }

  private async sendAuthorityError(
    stream: TerminalStream,
    kind: "input" | "resize",
    seq: bigint,
    error: RelayV2TerminalStructuredError,
  ): Promise<void> {
    const binding = stream.binding;
    if (!binding) return;
    const sequenceField = kind === "input" ? "inputSeq" : "resizeSeq";
    const ackField = kind === "input" ? "ackedThroughInputSeq" : "ackedThroughResizeSeq";
    const ack = kind === "input" ? stream.inputAcked : stream.resizeAcked;
    await this.sendFrame(binding.route, asJson({
      protocolVersion: 2,
      kind: "event",
      type: kind === "input" ? "terminal.input_error" : "terminal.resize_error",
      streamId: stream.streamId,
      payload: {
        generation: stream.generation,
        [sequenceField]: seq.toString(10),
        [ackField]: ack.toString(10),
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          commandDisposition: error.commandDisposition
            ?? (error.code === "COMMAND_IN_DOUBT" ? "in_doubt" : "not_applicable"),
          details: error.details ?? null,
        },
      },
    }));
  }

  private async closeInternal(request: RelayV2TerminalCloseRequest): Promise<void> {
    this.assertHost(request);
    await this.sweepInternal();
    const key = this.streamKey(request.auth, request.streamId);
    const recordKey = this.closeRecordKey(request);
    const requestFingerprint = this.closeFingerprint(request);
    const retained = this.closeRecords.get(recordKey);
    if (retained) {
      if (retained.fingerprint !== requestFingerprint) {
        throw new RelayV2TerminalManagerError(
          "TERMINAL_CLOSE_CONFLICT",
          "terminal closeId was reused with a different request",
        );
      }
      const stream = this.streams.get(retained.streamKey);
      await this.deliverCloseResponse(request, retained, stream, true);
      return;
    }

    const stream = this.streams.get(key);
    let proposed: RelayV2TerminalDurableCloseIntent | undefined;
    if (stream && stream.status !== "lost" && sameTarget(stream.target, request.target)) {
      if (stream.generation !== request.generation) {
        throw new RelayV2TerminalManagerError(
          "TERMINAL_GENERATION_STALE",
          "terminal close targets a stale generation",
        );
      }
      if (!this.validResumeToken(stream, request.resumeToken)) {
        throw new RelayV2TerminalManagerError(
          "PERMISSION_DENIED",
          "terminal close capability is invalid",
        );
      }
      if (stream.closeId && stream.closeId !== request.closeId) {
        throw new RelayV2TerminalManagerError(
          "TERMINAL_CLOSE_CONFLICT",
          "terminal generation already has a different closeId",
        );
      }
      if (stream.status !== "closed"
        && (!stream.binding || !sameRuntimeBinding(stream.binding.route, request.route))) {
        throw new RelayV2TerminalManagerError(
          "TERMINAL_ROUTE_STALE",
          "only the current connector route may close a live terminal stream",
        );
      }
      if (!stream.close && !stream.reservedCloseRecord) this.requireControlSlots(1);
      const winner = stream.close ?? {
        finalOffset: stream.ring.tailOffset,
        reason: "client_closed" as const,
        exitCode: null,
      };
      proposed = {
        key: recordKey,
        streamKey: key,
        fingerprint: requestFingerprint,
        hostInstanceId: this.hostInstanceId,
        target: { ...stream.target },
        streamId: stream.streamId,
        closeId: request.closeId,
        requestId: request.requestId,
        requestRoute: durableRoute(request.route),
        generation: stream.generation,
        finalOffset: winner.finalOffset.toString(10),
        reason: winner.reason,
        exitCode: winner.exitCode,
        expiresAtMs: this.now() + this.limits.controlRetentionMs,
      };
    }

    const claim = await this.lineage.claimClose({
      key: recordKey,
      fingerprint: requestFingerprint,
      hostInstanceId: this.hostInstanceId,
      ...(proposed ? { intent: proposed } : {}),
    });
    if (!claim || typeof claim !== "object" || typeof claim.status !== "string") {
      throw new RelayV2TerminalManagerError("INTERNAL", "durable lineage returned an invalid close claim");
    }
    if (claim.status === "close_conflict") {
      throw new RelayV2TerminalManagerError(
        "TERMINAL_CLOSE_CONFLICT",
        "terminal closeId was durably retained with a different request",
      );
    }
    if (claim.status === "not_found") {
      throw new RelayV2TerminalManagerError(
        "TERMINAL_STREAM_NOT_FOUND",
        "terminal stream is not retained",
      );
    }
    if (claim.status === "final") {
      const record = this.closeRecordFromDurable(claim.tombstone, recordKey, request);
      this.cacheCloseRecord(record, stream);
      await this.deliverCloseResponse(request, record, stream, true);
      return;
    }
    if (claim.status !== "claimed" && claim.status !== "existing_intent") {
      throw new RelayV2TerminalManagerError("INTERNAL", "durable lineage returned an unknown close claim");
    }
    if (typeof claim.ownerFence !== "string"
      || !/^[1-9][0-9]*$/.test(claim.ownerFence)
      || BigInt(claim.ownerFence) > MAX_COUNTER) {
      throw new RelayV2TerminalManagerError("INTERNAL", "durable lineage returned an invalid close owner fence");
    }
    if (claim.status === "claimed" && !proposed) {
      throw new RelayV2TerminalManagerError("INTERNAL", "durable lineage claimed a close without an intent");
    }
    const intent = this.closeRecordFromDurable(claim.intent, recordKey, request);
    if (claim.status === "claimed"
      && proposed
      && !sameDurableCloseProposal(claim.intent, proposed)) {
      throw new RelayV2TerminalManagerError("INTERNAL", "durable terminal close claim changed the proposed winner");
    }
    if (
      stream
      && stream.status !== "lost"
      && stream.generation === intent.generation
      && sameTarget(stream.target, intent.target)
    ) {
      if (!stream.close) this.commitTerminalCondition(stream, intent.reason, intent.exitCode);
      if (
        !stream.close
        || stream.close.finalOffset !== intent.finalOffset
        || stream.close.reason !== intent.reason
        || stream.close.exitCode !== intent.exitCode
      ) {
        throw new RelayV2TerminalManagerError("INTERNAL", "terminal close winner diverged from its durable intent");
      }
      await this.releaseProducerLease(stream);
      this.clearControlWindows(stream);
      await this.disposeBackend(stream);
    }
    const final = await this.lineage.finalizeClose({
      key: recordKey,
      fingerprint: requestFingerprint,
      hostInstanceId: this.hostInstanceId,
      ownerFence: claim.ownerFence,
    });
    const record = this.closeRecordFromDurable(final, recordKey, request);
    if (!sameDurableClose(final, claim.intent)) {
      throw new RelayV2TerminalManagerError("INTERNAL", "durable terminal close finalization changed its winner");
    }
    this.cacheCloseRecord(record, stream);
    if (stream && stream.generation === record.generation) {
      stream.closeId = record.closeId;
      stream.reservedCloseRecord = false;
    }
    await this.deliverCloseResponse(request, record, stream, claim.status !== "claimed");
  }

  private async deliverCloseResponse(
    request: RelayV2TerminalCloseRequest,
    record: CloseRecord,
    stream: TerminalStream | undefined,
    deduplicated: boolean,
  ): Promise<void> {
    if (
      stream?.binding
      && stream.generation === record.generation
      && sameRuntimeBinding(stream.binding.route, request.route)
    ) {
      this.queueCloseResponse(
        stream,
        request.route,
        request.requestId,
        record.key,
        deduplicated,
      );
      await this.pump(stream);
      return;
    }
    await this.sendCloseResponse(request.route, request.requestId, record, stream, deduplicated);
  }

  private closeRecordToDurable(record: CloseRecord): RelayV2TerminalDurableCloseTombstone {
    return {
      key: record.key,
      streamKey: record.streamKey,
      fingerprint: record.fingerprint,
      hostInstanceId: record.hostInstanceId,
      target: { ...record.target },
      streamId: record.streamId,
      closeId: record.closeId,
      requestId: record.requestId,
      requestRoute: durableRoute(record.requestRoute),
      generation: record.generation,
      finalOffset: record.finalOffset.toString(10),
      reason: record.reason,
      exitCode: record.exitCode,
      expiresAtMs: record.expiresAt,
    };
  }

  private closeRecordFromDurable(
    rawValue: unknown,
    expectedKey: string,
    request: RelayV2TerminalCloseRequest,
  ): CloseRecord {
    if (!rawValue || typeof rawValue !== "object") {
      throw new RelayV2TerminalManagerError(
        "INTERNAL",
        "durable terminal close tombstone failed validation",
      );
    }
    const value = rawValue as RelayV2TerminalDurableCloseTombstone;
    let finalOffset: bigint;
    try {
      finalOffset = parseCounter(value.finalOffset, "durable finalOffset");
    } catch {
      throw new RelayV2TerminalManagerError(
        "INTERNAL",
        "durable terminal close tombstone failed validation",
      );
    }
    const reason = value.reason;
    const exitCode = value.exitCode;
    const valid = value.key === expectedKey
      && value.streamKey === this.streamKey(request.auth, request.streamId)
      && typeof value.fingerprint === "string"
      && /^[0-9a-f]{64}$/.test(value.fingerprint)
      && value.fingerprint === this.closeFingerprint(request)
      && isOpaqueId(value.hostInstanceId)
      && value.target?.hostId === this.hostId
      && sameTarget(value.target, request.target)
      && value.streamId === request.streamId
      && value.closeId === request.closeId
      && isOpaqueId(value.requestId)
      && isOpaqueId(value.requestRoute?.connectorId)
      && isOpaqueId(value.requestRoute?.routeId)
      && isOpaqueId(value.requestRoute?.routeFence)
      && hasExactOwnKeys(value.requestRoute, ["connectorId", "routeId", "routeFence"])
      && isOpaqueId(value.generation)
      && Number.isSafeInteger(value.expiresAtMs)
      && value.expiresAtMs > this.now()
      && (
        (reason === "client_closed" && exitCode === null)
        || (reason === "backend_exit" && Number.isInteger(exitCode))
        || (reason === "backend_error" && (exitCode === null || Number.isInteger(exitCode)))
      )
      && (
        exitCode === null
        || (exitCode >= -2_147_483_648 && exitCode <= 2_147_483_647)
      );
    if (!valid) {
      throw new RelayV2TerminalManagerError(
        "INTERNAL",
        "durable terminal close tombstone failed validation",
      );
    }
    return {
      key: value.key,
      streamKey: value.streamKey,
      fingerprint: value.fingerprint,
      hostInstanceId: value.hostInstanceId,
      target: { ...value.target },
      streamId: value.streamId,
      closeId: value.closeId,
      requestId: value.requestId,
      requestRoute: durableRoute(value.requestRoute),
      generation: value.generation,
      finalOffset,
      reason,
      exitCode,
      expiresAt: value.expiresAtMs,
    };
  }

  private commitTerminalCondition(
    stream: TerminalStream,
    reason: RelayV2TerminalCloseReason,
    exitCode: number | null,
  ): void {
    if (stream.close) return;
    const now = this.now();
    stream.close = {
      finalOffset: stream.ring.tailOffset,
      reason,
      exitCode,
      closedAt: now,
      ringExpiresAt: now + this.limits.detachedLeaseMs,
    };
    stream.status = "closed";
    stream.detachedUntil = undefined;
    stream.retainedUntil = now + this.limits.controlRetentionMs;
    for (const record of this.openRecords.values()) {
      if (record.streamKey === stream.key) {
        record.expiresAt = Math.max(record.expiresAt, stream.retainedUntil);
      }
    }
  }

  private async sendCloseResponse(
    route: RelayV2TerminalRuntimeBinding,
    requestId: string,
    record: CloseRecord,
    stream: TerminalStream | undefined,
    deduplicated: boolean,
  ): Promise<void> {
    const replayAvailable = !!stream
      && stream.generation === record.generation
      && stream.ringRetained
      && stream.ring.hasRange(stream.ring.startOffset, record.finalOffset);
    await this.sendFrame(route, asJson({
      protocolVersion: 2,
      kind: "response",
      type: "terminal.closed",
      requestId,
      hostId: this.hostId,
      hostEpoch: this.hostEpoch,
      hostInstanceId: this.hostInstanceId,
      scopeId: record.target.scopeId,
      sessionId: record.target.sessionId,
      streamId: record.streamId,
      payload: {
        closeId: record.closeId,
        generation: record.generation,
        finalOffset: record.finalOffset.toString(10),
        replayAvailable,
        bufferStartOffset: replayAvailable ? stream!.ring.startOffset.toString(10) : null,
        reason: record.reason,
        exitCode: record.exitCode,
        deduplicated,
      },
    }));
  }

  private async backendOutput(
    key: string,
    generation: string,
    data: Uint8Array,
  ): Promise<void> {
    const stream = this.streams.get(key);
    if (!stream || stream.generation !== generation || stream.status === "closed" || stream.status === "lost") {
      return;
    }
    let offset = 0;
    while (offset < data.byteLength) {
      const end = Math.min(data.byteLength, offset + this.limits.maxFrameBytes);
      const part = data.subarray(offset, end);
      const accepted = await this.appendOutput(stream, part);
      if (!accepted) return;
      offset = end;
    }
    await this.pump(stream);
    await this.refreshBackpressure();
  }

  private async rejectBackendChunk(key: string, generation: string): Promise<void> {
    const stream = this.streams.get(key);
    if (!stream || stream.generation !== generation || stream.status === "lost") return;
    await this.loseStream(stream, "stream_lost", true);
  }

  private async appendOutput(stream: TerminalStream, data: Uint8Array): Promise<boolean> {
    if (stream.ring.tailOffset + BigInt(data.byteLength) > MAX_COUNTER) {
      await this.loseStream(stream, "host_buffer_pressure", true);
      return false;
    }
    const binding = stream.binding;
    const predictedStart = stream.ring.predictedStartAfter(data.byteLength);
    if (binding && predictedStart > binding.ackedOffset) {
      await this.loseStream(stream, "slow_consumer", true);
      return false;
    }
    const additionalBytes = Math.min(
      data.byteLength,
      this.limits.streamRingBytes - stream.ring.length,
    );
    await this.reclaimHostRing(additionalBytes, stream);
    if (this.ringBytes + additionalBytes > this.limits.hostRingBytes) {
      await this.loseStream(stream, "host_buffer_pressure", true);
      return false;
    }
    const before = stream.ring.length;
    stream.ring.append(data);
    this.ringBytes += stream.ring.length - before;
    stream.ringRetained = true;
    stream.lastUsedAt = this.now();
    if (this.ringBytes > this.limits.hostRingBytes) {
      throw new Error("Relay v2 terminal host ring exceeded its hard limit");
    }
    return true;
  }

  private async reclaimHostRing(requiredBytes: number, current: TerminalStream): Promise<void> {
    if (this.ringBytes + requiredBytes <= this.limits.hostRingBytes) return;
    const candidates = [...this.streams.values()]
      .filter((stream) => stream !== current && stream.ring.length > 0)
      .sort((left, right) => {
        const rank = (stream: TerminalStream) => stream.status === "closed"
          ? 0
          : stream.status === "detached"
            ? 1
            : 2;
        return rank(left) - rank(right) || left.lastUsedAt - right.lastUsedAt;
      });
    for (const candidate of candidates) {
      if (candidate.status !== "closed" && candidate.status !== "detached") break;
      this.removeRing(candidate, candidate.status !== "closed");
      if (this.ringBytes + requiredBytes <= this.limits.hostRingBytes) break;
    }
  }

  private removeRing(stream: TerminalStream, retainEmptyTimeline: boolean): void {
    this.ringBytes -= stream.ring.clear();
    stream.ringRetained = retainEmptyTimeline;
    if (this.ringBytes < 0) throw new Error("Relay v2 terminal ring accounting underflow");
  }

  private async backendClosed(
    key: string,
    generation: string,
    result: RelayV2TerminalBackendClose,
  ): Promise<void> {
    const stream = this.streams.get(key);
    if (!stream || stream.generation !== generation || stream.close || stream.status === "lost") {
      return;
    }
    const exitCodeValid = result.exitCode === null
      || (
        Number.isInteger(result.exitCode)
        && result.exitCode >= -2_147_483_648
        && result.exitCode <= 2_147_483_647
      );
    if (!exitCodeValid || (result.reason === "backend_exit" && result.exitCode === null)) {
      result = { reason: "backend_error", exitCode: null };
    }
    try {
      const marked = await this.markDurableStreamClosed(
        stream,
        this.now() + this.limits.controlRetentionMs,
      );
      if (!marked) {
        await this.evictStaleLocalStream(stream);
        await this.refreshBackpressure();
        return;
      }
    } catch (error) {
      await this.loseStream(stream, "stream_lost", false);
      await this.refreshBackpressure();
      throw error;
    }
    stream.backend = undefined;
    stream.backendPaused = false;
    await this.releaseProducerLease(stream);
    this.clearControlWindows(stream);
    this.commitTerminalCondition(stream, result.reason, result.exitCode);
    if (stream.binding) {
      stream.binding.closeNotification = "event";
      stream.binding.closeNotified = false;
      await this.pump(stream);
    }
    await this.refreshBackpressure();
  }

  private async markDurableStreamClosed(
    stream: TerminalStream,
    expiresAtMs: number,
  ): Promise<boolean> {
    let result: RelayV2TerminalDurableStreamClosedResult;
    try {
      result = await this.lineage.markStreamClosed({
        streamKey: stream.key,
        generation: stream.generation,
        hostInstanceId: this.hostInstanceId,
        expiresAtMs,
      });
    } catch {
      throw new RelayV2TerminalManagerError(
        "INTERNAL",
        "durable terminal natural close transition failed",
      );
    }
    if (
      hasExactOwnKeys(result, ["status"])
      && (result.status === "closed" || result.status === "already_closed")
    ) {
      return true;
    }
    if (
      hasExactOwnKeys(result, ["status", "reason"])
      && result.status === "conflict"
      && result.reason === "stream_identity_mismatch"
    ) {
      return false;
    }
    throw new RelayV2TerminalManagerError(
      "INTERNAL",
      "durable terminal natural close result is invalid",
    );
  }

  private async pump(stream: TerminalStream): Promise<void> {
    let binding = stream.binding;
    while (binding && stream.binding === binding) {
      if (binding.phase === "replay" && binding.sentThroughOffset >= binding.replayBoundary) {
        binding.phase = "live";
      }
      const through = binding.phase === "replay"
        ? binding.replayBoundary
        : stream.close?.finalOffset ?? stream.ring.tailOffset;
      if (binding.sentThroughOffset >= through) break;
      if (binding.sentThroughOffset < stream.ring.startOffset || !stream.ringRetained) {
        await this.sendAsyncReset(stream, "slow_consumer");
        return;
      }
      const unacked = binding.sentThroughOffset - binding.ackedOffset;
      const credit = BigInt(this.limits.maxUnackedBytes) - unacked;
      if (credit <= 0n) break;
      const maxBytes = Number(
        credit < BigInt(this.limits.maxFrameBytes)
          ? credit
          : BigInt(this.limits.maxFrameBytes),
      );
      const data = stream.ring.read(binding.sentThroughOffset, maxBytes, through);
      if (data.byteLength === 0) {
        await this.sendAsyncReset(stream, "slow_consumer");
        return;
      }
      const offset = binding.sentThroughOffset;
      await this.sendFrame(binding.route, asJson({
        protocolVersion: 2,
        kind: "event",
        type: "terminal.output",
        streamId: stream.streamId,
        payload: {
          generation: stream.generation,
          offset: offset.toString(10),
          encoding: "base64",
          data: data.toString("base64"),
        },
      }));
      if (stream.binding !== binding) return;
      binding.sentThroughOffset += BigInt(data.byteLength);
      stream.lastUsedAt = this.now();
    }
    binding = stream.binding;
    if (
      !binding
      || stream.binding !== binding
      || !stream.close
      || binding.sentThroughOffset !== stream.close.finalOffset
    ) {
      return;
    }
    for (const [key, pending] of stream.pendingCloseResponses) {
      if (!sameRuntimeBinding(pending.route, binding.route)) continue;
      const record = this.closeRecords.get(pending.closeRecordKey);
      if (!record) continue;
      await this.sendCloseResponse(
        pending.route,
        pending.requestId,
        record,
        stream,
        pending.deduplicated,
      );
      stream.pendingCloseResponses.delete(key);
      if (stream.binding !== binding) return;
    }
    if (binding.closeNotification === "event" && !binding.closeNotified) {
      await this.sendFrame(binding.route, asJson({
        protocolVersion: 2,
        kind: "event",
        type: "terminal.closed",
        streamId: stream.streamId,
        payload: {
          generation: stream.generation,
          finalOffset: stream.close.finalOffset.toString(10),
          replayAvailable: stream.ringRetained,
          bufferStartOffset: stream.ringRetained
            ? stream.ring.startOffset.toString(10)
            : null,
          reason: stream.close.reason,
          exitCode: stream.close.exitCode,
        },
      }));
      binding.closeNotified = true;
    }
  }

  private async sendAsyncReset(stream: TerminalStream, reason: ResetReason): Promise<void> {
    const binding = stream.binding;
    if (!binding) return;
    stream.binding = undefined;
    await this.sendFrame(binding.route, asJson({
      protocolVersion: 2,
      kind: "event",
      type: "terminal.reset_required",
      streamId: stream.streamId,
      payload: {
        generation: stream.generation,
        reason,
        requestedOffset: null,
        bufferStartOffset: stream.ringRetained
          ? stream.ring.startOffset.toString(10)
          : null,
        tailOffset: stream.ring.tailOffset.toString(10),
      },
    }));
  }

  private async loseStream(
    stream: TerminalStream,
    reason: "slow_consumer" | "host_buffer_pressure" | "stream_lost",
    notify: boolean,
  ): Promise<void> {
    let sendError: unknown;
    if (notify) {
      try {
        await this.sendAsyncReset(stream, reason);
      } catch (error) {
        sendError = error;
      }
    }
    try {
      stream.status = "lost";
      stream.detachedUntil = undefined;
      stream.retainedUntil = this.now() + this.limits.controlRetentionMs;
      stream.inputHashes.clear();
      stream.resizes.clear();
      stream.pendingInput = undefined;
      stream.pendingResize = undefined;
      this.removeRing(stream, false);
      await this.releaseProducerLease(stream);
      this.clearControlWindows(stream);
      for (const record of this.openRecords.values()) {
        if (record.streamKey === stream.key) {
          record.expiresAt = Math.max(record.expiresAt, stream.retainedUntil);
        }
      }
      await this.disposeBackend(stream);
    } finally {
      if (sendError) throw sendError;
    }
  }

  private async evictStaleLocalStream(stream: TerminalStream): Promise<void> {
    await this.loseStream(stream, "stream_lost", false);
    stream.reservedCloseRecord = false;
    if (this.streams.get(stream.key) === stream) this.streams.delete(stream.key);
  }

  private async refreshBackpressure(): Promise<void> {
    const hostLowWater = Math.floor(this.limits.hostRingBytes * 3 / 4);
    if (!this.hostPressure && this.ringBytes >= this.limits.hostRingBytes) {
      this.hostPressure = true;
    } else if (this.hostPressure && this.ringBytes <= hostLowWater) {
      this.hostPressure = false;
    }
    const streamLowWater = Math.floor(this.limits.streamRingBytes * 3 / 4);
    for (const stream of this.streams.values()) {
      if (!stream.backend || stream.status === "closed" || stream.status === "lost") continue;
      const streamPressure = stream.backendPaused
        ? stream.ring.length > streamLowWater
        : stream.ring.length >= this.limits.streamRingBytes;
      const shouldPause = this.hostPressure || streamPressure;
      if (shouldPause === stream.backendPaused) continue;
      if (shouldPause) {
        try {
          await stream.backend.pause();
          stream.backendPaused = true;
        } catch {
          stream.pauseFailed = true;
        }
      } else {
        try {
          await stream.backend.resume();
          stream.backendPaused = false;
          stream.pauseFailed = false;
        } catch {
          stream.pauseFailed = true;
        }
      }
    }
  }

  private async disposeBackend(stream: TerminalStream): Promise<void> {
    const handle = stream.backend;
    if (!handle) return;
    stream.backend = undefined;
    stream.backendPaused = false;
    try {
      await handle.close();
    } catch {
      // The stream/generation is fenced before attachment cleanup. Never open
      // a fallback backend or let a late callback mutate the replacement.
    }
  }

  private async closeQuarantinedBackend(quarantined: QuarantinedBackend): Promise<void> {
    try {
      await quarantined.handle.close();
    } catch {
      // Routing was removed before quarantine. Retention/shutdown cleanup is
      // best-effort and must never reopen or infer another target identity.
    }
  }

  private async releaseDurableStreamReservation(stream: TerminalStream): Promise<void> {
    let result: RelayV2TerminalDurableStreamReleaseResult;
    try {
      result = await this.lineage.releaseStreamReservation({
        streamKey: stream.key,
        generation: stream.generation,
        hostInstanceId: this.hostInstanceId,
      });
    } catch {
      throw new RelayV2TerminalManagerError(
        "INTERNAL",
        "durable terminal stream reservation release failed",
      );
    }
    if (
      (hasExactOwnKeys(result, ["status"])
        && (result.status === "released" || result.status === "already_released"))
    ) {
      return;
    }
    if (
      hasExactOwnKeys(result, ["status", "reason"])
      && result.status === "conflict"
      && result.reason === "generation_mismatch"
    ) {
      return;
    }
    throw new RelayV2TerminalManagerError(
      "INTERNAL",
      "durable terminal stream reservation release result is invalid",
    );
  }

  private async sweepInternal(maintainProducerLeases = false): Promise<void> {
    const now = this.now();
    for (const [handle, quarantined] of this.quarantinedBackends) {
      if (quarantined.expiresAt > now) continue;
      this.quarantinedBackends.delete(handle);
      await this.closeQuarantinedBackend(quarantined);
    }
    for (const stream of this.streams.values()) {
      if (maintainProducerLeases && stream.status === "live" && stream.producerLease) {
        if (Date.parse(stream.producerLease.expiresAt) <= now) {
          await this.releaseProducerLease(stream);
          this.clearControlWindows(stream);
          continue;
        }
        try {
          await this.ensureProducerLease(stream);
        } catch {
          await this.releaseProducerLease(stream);
          this.clearControlWindows(stream);
          continue;
        }
      }
      if (
        stream.status === "detached"
        && stream.detachedUntil !== undefined
        && stream.detachedUntil <= now
      ) {
        stream.status = "lost";
        stream.retainedUntil = now + this.limits.controlRetentionMs;
        await this.releaseProducerLease(stream);
        this.clearControlWindows(stream);
        this.removeRing(stream, false);
        await this.disposeBackend(stream);
      }
      if (
        stream.status === "closed"
        && stream.close
        && stream.close.ringExpiresAt <= now
        && stream.ringRetained
      ) {
        this.removeRing(stream, false);
      }
    }

    for (const [key, record] of this.openRecords) {
      const stream = this.streams.get(record.streamKey);
      const currentLiveGeneration = record.outcome.kind === "opened"
        && stream
        && (stream.status === "live" || stream.status === "detached")
        && stream.generation === record.outcome.generation;
      if (record.expiresAt <= now && !currentLiveGeneration) this.openRecords.delete(key);
    }
    for (const [key, record] of this.closeRecords) {
      if (record.expiresAt <= now) this.closeRecords.delete(key);
    }
    for (const [key, stream] of this.streams) {
      if (
        (stream.status === "closed" || stream.status === "lost")
        && stream.retainedUntil <= now
        && ![...this.openRecords.values()].some((record) => record.streamKey === key)
        && ![...this.closeRecords.values()].some((record) => record.streamKey === key)
      ) {
        await this.releaseDurableStreamReservation(stream);
        stream.reservedCloseRecord = false;
        this.removeRing(stream, false);
        this.streams.delete(key);
      }
    }
    await this.refreshBackpressure();
  }
}
